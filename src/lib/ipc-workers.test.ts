// 작업자(서브에이전트) 가짜 모드 (P7-02) — 주소 쿼리 `?workers=` 로 고르는 시나리오가 진짜 세션 관리자와 같은 순서로 이벤트를 내는지,
// 중단 · 끝내기에서 일하는 작업자가 남지 않는지, 권한 요청에 작업자가 붙는지, 채팅 기록에 작업자 항목이 (끝과 합쳐져) 나오는지.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "./fakeClaude";
import { fakeHistory } from "./fakeHistory";
import { parseFakeWorkersQuery, type FakeWorkersMode } from "./fakeWorkers";
import { fakeProjects } from "./fakeProjects";
import { ipc, type ChatEntry, type ClaudeEvent } from "./ipc";

const PACE = 5;

function resetFakes(workers?: FakeWorkersMode) {
  fakeClaude.reset({ workers, pace: PACE });
  fakeHistory.reset();
  fakeProjects.reset();
}

beforeEach(() => {
  resetFakes();
});

afterEach(async () => {
  // 가짜 세션의 타이머는 `reset` 해도 남는다 — 세션을 끝내고 남은 타이머가 지나가기를 기다려 다음 시험에 새지 않게 한다
  await ipc.claudeSessionStop();
  await new Promise((resolve) => setTimeout(resolve, PACE * 20));
  window.history.replaceState({}, "", "/");
  resetFakes();
});

type Recorder = { events: ClaudeEvent[]; until: (match: (event: ClaudeEvent) => boolean) => Promise<void> };

/** 이벤트를 모으면서, 어떤 이벤트가 **오는 순간** 이어서 움직일 수 있게 한다 (타이머 틈이 끼지 않아 "일하는 동안" 을 정확히 겨눈다) */
async function record(): Promise<Recorder> {
  const events: ClaudeEvent[] = [];
  const waiters: { match: (event: ClaudeEvent) => boolean; done: () => void }[] = [];
  await ipc.onClaudeEvent((event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.match(event)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.done();
      }
    }
  });
  return {
    events,
    until: (match) => (events.some(match) ? Promise.resolve() : new Promise<void>((done) => waiters.push({ match, done }))),
  };
}

const types = (events: ClaudeEvent[]) => events.map((event) => event.type);
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 3000 });
const isType = (type: ClaudeEvent["type"]) => (event: ClaudeEvent) => event.type === type;

async function run(workers: FakeWorkersMode, message = "작업자에게 맡겨 줘"): Promise<Recorder> {
  resetFakes(workers);
  const recorder = await record();
  await ipc.claudeSessionStart({ projectId: 1 });
  await ipc.claudeSessionSend(message);
  return recorder;
}

describe("가짜 작업자 설정", () => {
  it("주소 쿼리의 모르는 값 · 없는 값은 작업자 없음", () => {
    expect(parseFakeWorkersQuery("")).toBe("none");
    expect(parseFakeWorkersQuery("?workers=two")).toBe("two");
    expect(parseFakeWorkersQuery("?workers=background&x=1")).toBe("background");
    expect(parseFakeWorkersQuery("?workers=many")).toBe("none");
    expect(parseFakeWorkersQuery("?workers=")).toBe("none");
  });

  it("고르지 않으면 작업자 이벤트가 없고 권한 요청에 작업자 칸이 없다 (옛 흐름 그대로)", async () => {
    const { events } = await run("none", "hello");
    await waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    expect(types(events).some((type) => type.startsWith("worker_"))).toBe(false);
    const request = events.find((e) => e.type === "permission_request");
    expect(request).not.toHaveProperty("worker");
    expect((await ipc.claudeSessionState()).workers).toEqual([]);
  });
});

describe("가짜 작업자 시나리오", () => {
  it("one: 앞에서 기다리는 작업자 하나 — 시작 → 하는 일 → 끝 → 도구 결과 → 턴 끝", async () => {
    const { events, until } = await run("one");
    await until(isType("worker_started"));
    // 일하는 동안 상태에 보인다 (화면을 다시 열어도 일하는 고양이가 되살아난다)
    const state = await ipc.claudeSessionState();
    expect(state.workers).toHaveLength(1);
    expect(state.workers?.[0]).toMatchObject({ type: "worker_started", name: "harness-tester", background: false, depth: 1 });
    await until(isType("turn_ended"));
    const story = types(events).filter((type) => ["tool_use", "worker_started", "worker_activity", "worker_ended", "tool_result", "turn_ended"].includes(type));
    expect(story).toEqual(["tool_use", "worker_started", "worker_activity", "worker_activity", "worker_ended", "tool_result", "turn_ended"]);
    const started = events.find((e) => e.type === "worker_started");
    const ended = events.find((e) => e.type === "worker_ended");
    if (started?.type !== "worker_started" || ended?.type !== "worker_ended") throw new Error("no worker events");
    expect(ended).toMatchObject({ toolUseId: started.toolUseId, outcome: "done" });
    expect(events.find((e) => e.type === "tool_use" && e.tool === "Agent")).toMatchObject({ toolUseId: started.toolUseId });
    expect((await ipc.claudeSessionState()).workers).toEqual([]);
  });

  it("two: 둘이 한꺼번에 — 서로 다른 호출 ID, 모두 끝난 뒤에야 턴이 끝난다", async () => {
    const { events, until } = await run("two");
    await until(isType("turn_ended"));
    const started = events.filter((e) => e.type === "worker_started");
    const ended = events.filter((e) => e.type === "worker_ended");
    expect(started).toHaveLength(2);
    expect(ended).toHaveLength(2);
    expect(new Set(started.map((e) => e.toolUseId)).size).toBe(2);
    const lastEnd = events.lastIndexOf(ended[1] as ClaudeEvent);
    const turnEnd = events.findIndex((e) => e.type === "turn_ended");
    expect(lastEnd).toBeLessThan(turnEnd);
    // 둘이 겹쳐 일했다: 첫 끝보다 앞에 둘째 시작이 있다
    expect(events.indexOf(started[1] as ClaudeEvent)).toBeLessThan(events.indexOf(ended[0] as ClaudeEvent));
  });

  it("background: 부른 턴이 먼저 끝나고 작업자는 그 뒤에 끝난다 — 끝 알림 뒤 둘째 턴이 스스로 열린다", async () => {
    const { events } = await run("background");
    await waitFor(() => expect(events.filter((e) => e.type === "turn_ended")).toHaveLength(2));
    const started = events.find((e) => e.type === "worker_started");
    expect(started).toMatchObject({ background: true });
    const firstTurnEnd = events.findIndex((e) => e.type === "turn_ended");
    const workerEnd = events.findIndex((e) => e.type === "worker_ended");
    const secondTurnStart = events.findIndex((e, index) => e.type === "turn_started" && index > workerEnd);
    expect(firstTurnEnd).toBeLessThan(workerEnd);
    expect(workerEnd).toBeLessThan(secondTurnStart);
    expect(events.filter((e) => e.type === "worker_ended")).toHaveLength(1);
  });

  it("background: 턴이 끝난 뒤에도 일하는 중이고, 끝내기는 일하는 작업자를 멈춤으로 끝낸다 (끝 알림 앞에서)", async () => {
    const { events, until } = await run("background");
    await until(isType("turn_ended"));
    expect((await ipc.claudeSessionState()).workers).toHaveLength(1);
    await ipc.claudeSessionStop();
    const ends = events.filter((e) => e.type === "worker_ended");
    expect(ends).toEqual([expect.objectContaining({ outcome: "stopped" })]);
    expect(events.findIndex((e) => e.type === "worker_ended")).toBeLessThan(events.findIndex((e) => e.type === "session_ended"));
    expect((await ipc.claudeSessionState()).workers).toEqual([]);
    // 남은 타이머가 끝난 작업자를 또 끝내지 않는다
    await new Promise((resolve) => setTimeout(resolve, PACE * 12));
    expect(events.filter((e) => e.type === "worker_ended")).toHaveLength(1);
  });

  it("background: 중단하면 턴이 끝나 있어도 일하는 작업자가 멈춘다", async () => {
    const { events, until } = await run("background");
    await until(isType("turn_ended"));
    await ipc.claudeSessionInterrupt();
    expect(events.filter((e) => e.type === "worker_ended")).toEqual([expect.objectContaining({ outcome: "stopped" })]);
    expect((await ipc.claudeSessionState()).workers).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, PACE * 12));
    // 끝 알림이 없으니 둘째 턴도 열리지 않는다
    expect(events.filter((e) => e.type === "turn_ended")).toHaveLength(1);
  });

  it("permission: 권한 요청에 어느 작업자인지 붙고, 답하면 작업자가 끝난 뒤 턴이 끝난다", async () => {
    const { events, until } = await run("permission");
    await until(isType("permission_request"));
    const started = events.find((e) => e.type === "worker_started");
    const request = events.find((e) => e.type === "permission_request");
    if (started?.type !== "worker_started" || request?.type !== "permission_request") throw new Error("missing events");
    expect(request.worker).toEqual({ agentId: started.agentId, toolUseId: started.toolUseId, name: "harness-tester" });
    expect((await ipc.claudeSessionState()).workers).toHaveLength(1);

    await ipc.claudeSessionRespond(request.requestId, { kind: "allow" });
    await until(isType("turn_ended"));
    expect(events.find((e) => e.type === "worker_ended")).toMatchObject({ toolUseId: started.toolUseId, outcome: "done" });
    expect(events.findIndex((e) => e.type === "worker_ended")).toBeLessThan(events.findIndex((e) => e.type === "turn_ended"));
  });

  it("permission: 거부하면 실패, 다르게 말하기면 멈춤으로 끝난다", async () => {
    for (const [response, outcome] of [
      [{ kind: "deny" }, "failed"],
      [{ kind: "tell", text: "다르게" }, "stopped"],
    ] as const) {
      const { events, until } = await run("permission");
      await until(isType("permission_request"));
      const request = events.find((e) => e.type === "permission_request");
      if (request?.type !== "permission_request") throw new Error("no request");
      await ipc.claudeSessionRespond(request.requestId, response);
      await until(isType("worker_ended"));
      expect(events.find((e) => e.type === "worker_ended")).toMatchObject({ outcome });
    }
  });

  it("중단하면 일하는 작업자가 멈춤으로 끝나고 턴은 중단으로 끝난다 — 한 번만", async () => {
    const { events, until } = await run("one");
    await until(isType("worker_started"));
    await ipc.claudeSessionInterrupt();
    await until(isType("turn_ended"));
    expect(events.find((e) => e.type === "worker_ended")).toMatchObject({ outcome: "stopped" });
    expect(events.find((e) => e.type === "turn_ended")).toMatchObject({ outcome: "interrupted" });
    expect(events.findIndex((e) => e.type === "worker_ended")).toBeLessThan(events.findIndex((e) => e.type === "turn_ended"));
    await new Promise((resolve) => setTimeout(resolve, PACE * 12));
    expect(events.filter((e) => e.type === "worker_ended")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_ended")).toHaveLength(1);
    // 중단 뒤에도 세션은 산다 — 다음 말을 받는다
    await ipc.claudeSessionSend("다시");
  });

  it("끝내기: 일하던 작업자가 끝 알림 앞에서 멈춘다", async () => {
    const { events, until } = await run("two");
    await until(() => events.filter((e) => e.type === "worker_started").length === 2);
    await ipc.claudeSessionStop();
    const ends = events.filter((e) => e.type === "worker_ended");
    expect(ends).toHaveLength(2);
    expect(ends.every((e) => e.type === "worker_ended" && e.outcome === "stopped")).toBe(true);
    const sessionEnd = events.findIndex((e) => e.type === "session_ended");
    expect(events.lastIndexOf(ends[1] as ClaudeEvent)).toBeLessThan(sessionEnd);
  });
});

describe("가짜 채팅 기록의 작업자", () => {
  async function readAll(): Promise<ChatEntry[]> {
    const all: ChatEntry[] = [];
    let before: number | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await ipc.projectChatHistory(1, before, 50);
      all.unshift(...page.entries);
      before = page.entries[0]?.id ?? before;
      if (!page.hasMore) return all;
    }
    throw new Error("the history never ended");
  }

  it("기본에는 작업자 항목이 없다 (옛 기록 모양 그대로)", async () => {
    const entries = await readAll();
    expect(entries.some((e) => e.event.type === "worker_started")).toBe(false);
    expect(entries.every((e) => e.worker === undefined)).toBe(true);
  });

  it("`?workers=` 가 있으면 마침 · 실패 · 멈춤 항목이 나온다 — 끝은 시작 항목에 합쳐지고 따로 나오지 않는다", async () => {
    fakeHistory.reset(undefined, { workers: true });
    const entries = await readAll();
    const workers = entries.filter((e) => e.event.type === "worker_started");
    expect(workers.map((e) => e.worker?.status)).toEqual(["done", "failed", "stopped"]);
    expect(workers[0]?.worker?.endedAtMs).toBeTypeOf("number");
    // 끝 알림이 없던 것(앱이 꺼졌다)은 끝 시각을 지어내지 않는다
    expect(workers[2]?.worker).toEqual({ status: "stopped", endedAtMs: null });
    expect(entries.some((e) => (e.event as { type: string }).type === "worker_ended")).toBe(false);
    // 작업자가 아닌 항목에는 `worker` 가 없다
    expect(entries.filter((e) => e.event.type !== "worker_started").every((e) => e.worker === undefined)).toBe(true);
    // 메인의 `Agent` 호출 줄이 앞에 붙는다 — 작업자 안쪽 도구는 없다
    const agentCalls = entries.filter((e) => e.event.type === "tool_use" && e.event.tool === "Agent");
    expect(agentCalls).toHaveLength(3);
  });

  it("주소 쿼리로도 고른다", async () => {
    window.history.replaceState({}, "", "/?workers=one");
    const entries = await readAll();
    expect(entries.some((e) => e.event.type === "worker_started")).toBe(true);
  });
});
