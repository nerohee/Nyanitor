// 채팅 모델의 작업자 줄 — 시작 때 한 줄, 끝나면 같은 줄에서 상태가 바뀜 · `Agent`/`Task` 도구 줄 숨김 · 기록에서 읽은 작업자 줄 · 세션 시작 표시 · 기록 + 실시간 잇기.
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatListEvent, ClaudeEvent } from "../../lib/ipc-types";
import { emptyChat, foldEvent, fromEntries, mergeLive, prependEntries, settleWorkers, type ChatData } from "./model";

const wStart = (id: string, atMs = 1000, name = "harness-builder-ui"): Extract<ClaudeEvent, { type: "worker_started" }> => ({
  type: "worker_started",
  toolUseId: id,
  agentId: `a-${id}`,
  name,
  description: "사진 목록 화면 만들기",
  background: false,
  depth: 1,
  atMs,
});
const wEnd = (id: string, outcome: "done" | "failed" | "stopped" = "done", atMs = 9000): ClaudeEvent => ({ type: "worker_ended", toolUseId: id, outcome, atMs });
const wActivity = (id: string): ClaudeEvent => ({ type: "worker_activity", toolUseId: id, tool: "Edit", summary: "x", toolUses: 1 });
const agentCall = (id: string, tool = "Agent"): ClaudeEvent => ({ type: "tool_use", toolUseId: id, tool, summary: "사진 목록 화면 만들기" });
const started: ClaudeEvent = { type: "session_started", projectId: 1, projectDir: "C:\\p", pid: 7, resumed: false, resumeSessionId: null, cliVersion: null, model: null, effort: null };

function fold(events: ClaudeEvent[], from: ChatData = emptyChat()): ChatData {
  return events.reduce((data, event) => foldEvent(data, event), from);
}
const workerLines = (data: ChatData) => data.lines.filter((line) => line.kind === "worker");
const asList = (event: ClaudeEvent): ChatListEvent => event as ChatListEvent;

function entries(items: { event: ClaudeEvent; worker?: ChatEntry["worker"]; at?: number }[], firstId = 1): ChatEntry[] {
  return items.map((item, index) => ({ id: firstId + index, at: item.at ?? 1_800_000_000 + index, sessionId: "s", truncated: false, event: asList(item.event), request: null, worker: item.worker ?? null }));
}

describe("작업자 줄", () => {
  it("시작 때 한 줄이 생기고, 끝나면 같은 줄(같은 key)의 상태가 일하는 중 → 돌아옴 · 못 끝냄 · 멈춤 으로 바뀐다", () => {
    for (const outcome of ["done", "failed", "stopped"] as const) {
      const running = fold([wStart("t1")]);
      expect(workerLines(running)).toHaveLength(1);
      expect(workerLines(running)[0]).toMatchObject({ kind: "worker", toolUseId: "t1", name: "harness-builder-ui", description: "사진 목록 화면 만들기", status: "running", endedAtMs: null });
      const done = foldEvent(running, wEnd("t1", outcome, 5000));
      expect(workerLines(done)).toHaveLength(1);
      expect(workerLines(done)[0]?.key).toBe(workerLines(running)[0]?.key);
      expect(workerLines(done)[0]).toMatchObject({ status: outcome, endedAtMs: 5000 });
    }
  });

  it("끝난 줄은 다시 일하는 중이 되지 않는다 — 끝 알림이 두 번 와도 · 시작이 또 와도", () => {
    const data = fold([wStart("t1"), wEnd("t1", "failed", 5000), wEnd("t1", "done", 6000), wStart("t1")]);
    expect(workerLines(data)).toHaveLength(1);
    expect(workerLines(data)[0]).toMatchObject({ status: "failed", endedAtMs: 5000 });
  });

  it("하는 일(worker_activity) · 모르는 번호의 끝은 목록을 바꾸지 않는다", () => {
    const data = fold([wStart("t1")]);
    expect(foldEvent(data, wActivity("t1"))).toBe(data);
    expect(foldEvent(data, wEnd("nope"))).toBe(data);
  });

  it("둘이 동시에 — 줄이 둘, 하나가 끝나도 다른 줄은 그대로", () => {
    const data = fold([wStart("a", 1000, "harness-builder-ui"), wStart("b", 1100, "harness-builder-system"), wEnd("a")]);
    expect(workerLines(data).map((line) => [line.kind === "worker" && line.toolUseId, line.kind === "worker" && line.status])).toEqual([
      ["a", "done"],
      ["b", "running"],
    ]);
  });

  it("세션이 끝나면 일하는 중으로 남은 줄은 멈춤 (끝 알림을 못 받아도)", () => {
    const data = fold([wStart("t1"), wStart("t2"), wEnd("t2"), { type: "session_ended", ended: "normal", exitCode: 0, forced: false, midTurn: false, stderrTail: [] }]);
    expect(workerLines(data).map((line) => line.kind === "worker" && line.status)).toEqual(["stopped", "done"]);
  });

  it("settleWorkers — 일하는 중인 줄만 멈춤으로, 없으면 같은 객체", () => {
    const running = fold([wStart("t1"), wStart("t2"), wEnd("t2", "failed")]);
    expect(workerLines(settleWorkers(running)).map((line) => line.kind === "worker" && line.status)).toEqual(["stopped", "failed"]);
    const none = fold([wStart("t1"), wEnd("t1")]);
    expect(settleWorkers(none)).toBe(none);
  });
});

describe("Agent · Task 도구 줄 숨기기", () => {
  it("작업자를 부른 도구 줄(Agent · 옛 이름 Task)은 채팅 줄이 되지 않는다 — 작업자 시작이 없는 것도", () => {
    const data = fold([agentCall("t1"), wStart("t1"), agentCall("t2", "Task"), agentCall("t3"), { type: "tool_use", toolUseId: "r", tool: "Read", summary: "a.md" }]);
    expect(data.lines.map((line) => line.kind)).toEqual(["worker", "tool"]);
    expect(data.agentCalls).toEqual(["t1", "t2", "t3"]);
  });

  it("그 호출의 실패한 결과는 작업자 줄이 있으면 숨기고(못 끝냄이 말한다), 작업자가 안 시작했으면 그대로 보인다", () => {
    const hidden = fold([agentCall("t1"), wStart("t1"), { type: "tool_result", toolUseId: "t1", isError: true, summary: "" }]);
    expect(hidden.lines.map((line) => line.kind)).toEqual(["worker"]);
    const shown = fold([agentCall("t9"), { type: "tool_result", toolUseId: "t9", isError: true, summary: "알 수 없는 에이전트" }]);
    expect(shown.lines.map((line) => line.kind)).toEqual(["toolError"]);
    // 다른 도구의 실패는 그대로
    const other = fold([wStart("t1"), { type: "tool_result", toolUseId: "x", isError: true, summary: "EACCES" }]);
    expect(other.lines.map((line) => line.kind)).toEqual(["worker", "toolError"]);
  });

  it("성공한 결과 글(앞에서 기다린 작업자의 결과 앞 300자)은 줄이 되지 않는다", () => {
    const data = fold([agentCall("t1"), wStart("t1"), { type: "tool_result", toolUseId: "t1", isError: false, summary: "결과 글 앞부분" }, wEnd("t1")]);
    expect(data.lines.map((line) => line.kind)).toEqual(["worker"]);
  });
});

describe("기록에서 읽은 작업자 줄", () => {
  it("시작 항목에 합쳐 온 상태(마침 · 실패 · 멈춤 · 일하는 중)로 한 줄이 된다 — Agent 줄은 숨김", () => {
    const data = fromEntries(
      entries([
        { event: agentCall("t1") },
        { event: wStart("t1", 1000), worker: { status: "done", endedAtMs: 4000 } },
        { event: agentCall("t2") },
        { event: wStart("t2", 2000, "harness-tester"), worker: { status: "failed", endedAtMs: 5000 } },
        { event: wStart("t3", 3000), worker: { status: "stopped", endedAtMs: null } },
        { event: wStart("t4", 4000), worker: { status: "running", endedAtMs: null } },
      ]),
    );
    expect(data.lines.map((line) => line.kind)).toEqual(["worker", "worker", "worker", "worker"]);
    expect(workerLines(data).map((line) => line.kind === "worker" && [line.status, line.endedAtMs])).toEqual([
      ["done", 4000],
      ["failed", 5000],
      ["stopped", null],
      ["running", null],
    ]);
    expect(data.lines[0]?.key).toBe("h-2");
  });

  it("옛 자료처럼 `worker` 칸이 없으면 일하는 중으로 본다", () => {
    const data = fromEntries([{ id: 1, at: 1, sessionId: null, truncated: false, event: asList(wStart("t1")), request: null }]);
    expect(workerLines(data)[0]).toMatchObject({ status: "running" });
  });

  it("기록 + 실시간 — 같은 작업자는 하나 · 읽는 동안 온 끝 알림은 그 줄에 반영된다 (겹침 없음)", () => {
    const history = entries([{ event: agentCall("t1") }, { event: wStart("t1"), worker: { status: "running", endedAtMs: null } }]);
    const base = fromEntries(history);
    // 모아 둔 이벤트: 같은 시작(기록과 겹침) + 끝 알림
    const merged = mergeLive(base, history, [wStart("t1"), wEnd("t1", "done", 7000)]);
    expect(workerLines(merged)).toHaveLength(1);
    expect(workerLines(merged)[0]).toMatchObject({ status: "done", endedAtMs: 7000 });
    // 기록이 읽기 전에 끝난 상태였다면 끝 알림이 또 와도 그대로
    const doneHistory = entries([{ event: wStart("t1"), worker: { status: "done", endedAtMs: 4000 } }]);
    const again = mergeLive(fromEntries(doneHistory), doneHistory, [wEnd("t1", "failed", 8000)]);
    expect(workerLines(again)[0]).toMatchObject({ status: "done", endedAtMs: 4000 });
  });

  it("기록 끝에 없는 작업자가 모은 이벤트에서 시작하면 새 줄로 이어 붙는다", () => {
    const history = entries([{ event: wStart("t1"), worker: { status: "done", endedAtMs: 4000 } }]);
    const merged = mergeLive(fromEntries(history), history, [wStart("t2", 5000)]);
    expect(workerLines(merged).map((line) => line.kind === "worker" && line.toolUseId)).toEqual(["t1", "t2"]);
  });

  it("이전 쪽을 앞에 붙여도 작업자 줄 · 숨긴 Agent 번호가 이어진다", () => {
    const newer = fromEntries(entries([{ event: wStart("t2"), worker: { status: "done", endedAtMs: 9 } }], 10));
    const merged = prependEntries(newer, entries([{ event: agentCall("t1") }, { event: wStart("t1"), worker: { status: "done", endedAtMs: 4 } }], 1));
    expect(workerLines(merged).map((line) => line.kind === "worker" && line.toolUseId)).toEqual(["t1", "t2"]);
    expect(merged.agentCalls).toEqual(["t1"]);
  });
});

describe("세션 시작 표시 (요약 로그가 쓴다 — 채팅 줄은 아니다)", () => {
  it("시작이 줄이 되지 않고, 어느 줄 뒤인지(afterKey)를 기억한다", () => {
    const data = fold([started, { type: "user_message", text: "안녕", deferred: false }, { ...started, resumed: true }]);
    expect(data.lines).toHaveLength(1);
    expect(data.starts.map((start) => [start.afterKey, start.resumed])).toEqual([
      [null, false],
      [data.lines[0]?.key, true],
    ]);
  });

  it("이전 쪽을 붙이면 지금 목록 맨 앞의 시작은 이전 쪽 마지막 줄 뒤로 옮겨진다", () => {
    const newer = fromEntries(entries([{ event: started }, { event: { type: "user_message", text: "둘째", deferred: false } }], 10));
    expect(newer.starts[0]?.afterKey).toBeNull();
    const merged = prependEntries(newer, entries([{ event: started }, { event: { type: "user_message", text: "첫째", deferred: false } }], 1));
    expect(merged.starts.map((start) => start.afterKey)).toEqual([null, "h-2"]);
    expect(merged.lines.map((line) => line.key)).toEqual(["h-2", "h-11"]);
  });

  it("기록에서 읽은 줄은 항목 시각(초)을, 실시간 이벤트는 받은 때를 `atMs` 로 가진다", () => {
    const fromHistory = fromEntries(entries([{ event: { type: "text", text: "답" }, at: 1_800_000_123 }]));
    expect(fromHistory.lines[0]?.atMs).toBe(1_800_000_123_000);
    const live = foldEvent(emptyChat(), { type: "text", text: "답" }, { atMs: 42 });
    expect(live.lines[0]?.atMs).toBe(42);
    const buffered = mergeLive(emptyChat(), [], [{ type: "text", text: "답" }], [77]);
    expect(buffered.lines[0]?.atMs).toBe(77);
  });
});
