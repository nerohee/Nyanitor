// 작업자 목록 — 같은 작업자 합치기 · 고르는 함수(지금 일하는 · 최근) · 상한.
import { describe, expect, it } from "vitest";
import type { ChatEntry, ClaudeEvent } from "../../lib/ipc-types";
import { applyWorkerEvent, mergeHistoryWorkers, recentWorkers, stopAllWorkers, workingWorkers, WORKERS_MAX, type WorkerEntry } from "./workers";

const start = (id: string, atMs = 1000, name = "harness-tester"): Extract<ClaudeEvent, { type: "worker_started" }> => ({ type: "worker_started", toolUseId: id, agentId: `a-${id}`, name, description: "일", background: false, depth: 1, atMs });
const end = (id: string, outcome: "done" | "failed" | "stopped", atMs: number): ClaudeEvent => ({ type: "worker_ended", toolUseId: id, outcome, atMs });
const entry = (id: number, event: ClaudeEvent, worker: ChatEntry["worker"]): ChatEntry => ({ id, at: 1, sessionId: null, truncated: false, event: event as ChatEntry["event"], request: null, worker });

const apply = (events: ClaudeEvent[], from: WorkerEntry[] = []) => events.reduce((list, event) => applyWorkerEvent(list, event), from);

describe("합치기", () => {
  it("시작 → 하는 일 → 끝", () => {
    let list = apply([start("t1")]);
    expect(list[0]).toMatchObject({ toolUseId: "t1", agentId: "a-t1", name: "harness-tester", status: "running", activity: null, endedAtMs: null });
    list = apply([{ type: "worker_activity", toolUseId: "t1", tool: "Read", summary: "a.ts 읽는 중", toolUses: 1 }], list);
    expect(list[0]?.activity).toEqual({ tool: "Read", summary: "a.ts 읽는 중", toolUses: 1 });
    list = apply([end("t1", "done", 3000)], list);
    expect(list[0]).toMatchObject({ status: "done", endedAtMs: 3000, activity: null });
  });

  it("끝난 뒤의 하는 일 · 두 번째 끝은 무시 — 목록이 같은 객체", () => {
    const list = apply([start("t1"), end("t1", "failed", 3000)]);
    expect(applyWorkerEvent(list, { type: "worker_activity", toolUseId: "t1", tool: "Edit", summary: "x", toolUses: 2 })).toBe(list);
    expect(applyWorkerEvent(list, end("t1", "done", 4000))).toBe(list);
    expect(applyWorkerEvent(list, end("nope", "done", 4000))).toBe(list);
    expect(applyWorkerEvent(list, { type: "text", text: "x" })).toBe(list);
  });

  it("같은 작업자가 또 시작해 오면 하나 — 하는 일은 지키고, 끝난 것은 되살아나지 않는다", () => {
    let list = apply([start("t1"), { type: "worker_activity", toolUseId: "t1", tool: "Edit", summary: "x", toolUses: 2 }, start("t1")]);
    expect(list).toHaveLength(1);
    expect(list[0]?.activity?.tool).toBe("Edit");
    list = apply([end("t1", "stopped", 5000), start("t1")], list);
    expect(list[0]).toMatchObject({ status: "stopped", endedAtMs: 5000 });
  });

  it("기록에서 — 같은 번호는 하나로 합치고 상태는 더 나아간 쪽", () => {
    const live = apply([start("t1"), start("t2", 2000)]);
    const merged = mergeHistoryWorkers(live, [entry(1, start("t1"), { status: "done", endedAtMs: 4000 }), entry(2, start("t0", 500), { status: "failed", endedAtMs: 800 }), entry(3, { type: "text", text: "x" }, null)], true);
    expect(merged.map((item) => [item.toolUseId, item.status])).toEqual([
      ["t1", "done"],
      ["t2", "running"],
      ["t0", "failed"],
    ]);
  });

  it("지금 세션이 없는데 기록이 '일하는 중' 이면 멈춤", () => {
    const merged = mergeHistoryWorkers([], [entry(1, start("t1"), { status: "running", endedAtMs: null })], false);
    expect(merged[0]).toMatchObject({ status: "stopped", endedAtMs: null });
    expect(mergeHistoryWorkers([], [entry(1, start("t1"), { status: "running", endedAtMs: null })], true)[0]?.status).toBe("running");
  });

  it("stopAllWorkers — 일하는 중인 것만 멈춤, 없으면 같은 객체", () => {
    const list = apply([start("a"), start("b"), end("b", "done", 2000)]);
    const stopped = stopAllWorkers(list, 9000);
    expect(stopped.map((item) => [item.status, item.endedAtMs])).toEqual([["stopped", 9000], ["done", 2000]]);
    expect(stopAllWorkers(stopped)).toBe(stopped);
  });

  it("상한을 넘으면 끝난 것 가운데 오래된 것부터 버린다 (일하는 것은 남는다)", () => {
    let list: WorkerEntry[] = [];
    list = apply([start("running", 1)], list);
    for (let n = 0; n < WORKERS_MAX + 5; n += 1) list = apply([start(`d${n}`, 10 + n), end(`d${n}`, "done", 10 + n)], list);
    expect(list).toHaveLength(WORKERS_MAX);
    expect(list.some((item) => item.toolUseId === "running")).toBe(true);
    expect(list.some((item) => item.toolUseId === "d0")).toBe(false);
    expect(list.some((item) => item.toolUseId === `d${WORKERS_MAX + 4}`)).toBe(true);
  });
});

describe("고르기", () => {
  const list = apply([start("late", 3000), start("early", 1000), start("mid", 2000), end("mid", "done", 4000), start("older", 500), end("older", "failed", 6000), start("gone", 100), end("gone", "stopped", 5000)]);

  it("지금 일하는 작업자 — 시작 순", () => {
    expect(workingWorkers(list).map((item) => item.toolUseId)).toEqual(["early", "late"]);
  });

  it("최근 작업자 — 끝난 때가 가까운 것이 앞, 개수 제한", () => {
    expect(recentWorkers(list).map((item) => item.toolUseId)).toEqual(["older", "gone", "mid"]);
    expect(recentWorkers(list, 2).map((item) => item.toolUseId)).toEqual(["older", "gone"]);
    expect(recentWorkers([])).toEqual([]);
  });

  it("끝난 때를 모르는 멈춤은 시작한 때로", () => {
    const stopped = mergeHistoryWorkers([], [entry(1, start("x", 7000), { status: "stopped", endedAtMs: null }), entry(2, start("y", 1000), { status: "done", endedAtMs: 2000 })], true);
    expect(recentWorkers(stopped).map((item) => item.toolUseId)).toEqual(["x", "y"]);
  });
});
