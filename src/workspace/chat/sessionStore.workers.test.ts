// 세션 저장소의 작업자 · 원본 줄 — 세 곳(세션 상태 · 실시간 · 기록)에서 온 같은 작업자 하나로 · 백그라운드(턴이 먼저 끝남) · 둘 동시 · 세션 끝에 남은 것 멈춤 · 원본 줄 상한.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeHistory } from "../../lib/fakeHistory";
import { fakeProjects } from "../../lib/fakeProjects";
import { ipc } from "../../lib/ipc";
import type { ChatEntry, ClaudeEvent, ClaudeSessionState, WorkerOutcome } from "../../lib/ipc-types";
import { recentWorkers, workingWorkers } from "../progress/workers";
import { loadChat, RAW_LINES_MAX, resetSessionStore, selectRawLines, selectWorkers, startSessionStore, useSessionStore } from "./sessionStore";

let emit: (event: ClaudeEvent) => void = () => undefined;
const IDLE: ClaudeSessionState = { running: false, projectId: null, projectDir: null, pid: null, sessionId: null, busy: false, pending: [] };

const started = (projectId: number): ClaudeEvent => ({ type: "session_started", projectId, projectDir: `C:\\p${projectId}`, pid: 1, resumed: false, resumeSessionId: null, cliVersion: null, model: null, effort: null });
const turnStarted: ClaudeEvent = { type: "turn_started", sessionId: "sess-1", model: null, cliVersion: null, permissionMode: null, apiKeySource: null };
const turnEnded: ClaudeEvent = {
  type: "turn_ended",
  outcome: "success",
  subtype: null,
  isError: false,
  terminalReason: null,
  result: null,
  errors: [],
  apiErrorStatus: null,
  durationMs: 1,
  numTurns: 1,
  usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  costUsd: 0.1,
  totalCostUsd: 1,
};
const ended: ClaudeEvent = { type: "session_ended", ended: "normal", exitCode: 0, forced: false, midTurn: false, stderrTail: [] };
const wStart = (id: string, name = "harness-builder-ui", atMs = 1000, background = false): Extract<ClaudeEvent, { type: "worker_started" }> => ({
  type: "worker_started",
  toolUseId: id,
  agentId: `agent-${id}`,
  name,
  description: `${id} 일`,
  background,
  depth: 1,
  atMs,
});
const wEnd = (id: string, outcome: WorkerOutcome = "done", atMs = 5000): ClaudeEvent => ({ type: "worker_ended", toolUseId: id, outcome, atMs });
const wActivity = (id: string): ClaudeEvent => ({ type: "worker_activity", toolUseId: id, tool: "Edit", summary: "Gallery.tsx 고치는 중", toolUses: 2 });
const raw = (seq: number): ClaudeEvent => ({ type: "raw_log", seq, dir: "recv", text: `줄 ${seq}`, truncated: false, originalLen: 3, atMs: seq });

async function boot(state: ClaudeSessionState = IDLE) {
  vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
    emit = handler;
    return Promise.resolve(() => undefined);
  });
  vi.spyOn(ipc, "claudeSessionState").mockResolvedValue(state);
  vi.spyOn(ipc, "appUsageSummary").mockResolvedValue({ since: 0, today: { turns: 0, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0, costUsd: 0, subscriptionTurns: 0, apiKeyTurns: 0, referenceOnly: true }, projects: [], session: null });
  await startSessionStore();
}

const workersOf = (projectId: number) => selectWorkers(projectId)(useSessionStore.getState());
const lineOf = (projectId: number, toolUseId: string) => useSessionStore.getState().chats[projectId]?.data.lines.find((line) => line.kind === "worker" && line.toolUseId === toolUseId);

function historyPage(entries: ChatEntry[]) {
  vi.spyOn(ipc, "projectChatHistory").mockResolvedValue({ entries, hasMore: false });
}
/** 대화를 (빈 기록으로) 읽어 둔다 — 그 뒤의 이벤트가 채팅 줄로 바로 접힌다 */
async function loaded(projectId = 1) {
  historyPage([]);
  await loadChat(projectId);
}
const entryOf = (id: number, event: ChatEntry["event"], worker: ChatEntry["worker"] = null): ChatEntry => ({ id, at: 1_800_000_000 + id, sessionId: "s", truncated: false, event, request: null, worker });

beforeEach(() => {
  resetSessionStore();
  fakeProjects.reset();
  fakeHistory.reset("empty");
});
afterEach(() => {
  vi.restoreAllMocks();
  resetSessionStore();
  fakeProjects.reset();
  fakeHistory.reset();
});

describe("작업자 목록", () => {
  it("세션 상태 · 실시간 · 기록 세 곳에서 온 같은 작업자는 하나 — 끝남이 일하는 중을 이긴다", async () => {
    await boot({ ...IDLE, running: true, projectId: 1, projectDir: "C:\\p1", sessionId: "s", workers: [wStart("t1")] });
    expect(workersOf(1)).toHaveLength(1);
    expect(workersOf(1)[0]).toMatchObject({ toolUseId: "t1", name: "harness-builder-ui", status: "running", background: false });
    // 실시간으로 또 (다시 그릴 때) — 그래도 하나, 하는 일은 붙는다
    emit(wStart("t1"));
    emit(wActivity("t1"));
    expect(workersOf(1)).toHaveLength(1);
    expect(workersOf(1)[0]?.activity).toEqual({ tool: "Edit", summary: "Gallery.tsx 고치는 중", toolUses: 2 });
    // 기록 — 읽는 사이 끝났다
    historyPage([entryOf(1, wStart("t1"), { status: "done", endedAtMs: 4000 })]);
    await loadChat(1);
    expect(workersOf(1)).toHaveLength(1);
    expect(workersOf(1)[0]).toMatchObject({ status: "done", endedAtMs: 4000, activity: null });
    // 채팅 줄도 하나, 같은 줄에서 끝남으로
    const lines = useSessionStore.getState().chats[1]?.data.lines.filter((line) => line.kind === "worker");
    expect(lines).toHaveLength(1);
    expect(lineOf(1, "t1")).toMatchObject({ status: "done" });
  });

  it("끝난 것을 일하는 중이라 하는 쪽이 이기지 않는다 — 끝 알림 뒤에 시작 이벤트가 또 와도 그대로", async () => {
    await boot();
    await loaded();
    emit(started(1));
    emit(wStart("t1"));
    emit(wEnd("t1", "failed", 3000));
    emit(wStart("t1"));
    expect(workersOf(1)[0]).toMatchObject({ status: "failed", endedAtMs: 3000 });
    expect(lineOf(1, "t1")).toMatchObject({ status: "failed" });
  });

  it("백그라운드 — 턴이 먼저 끝나도 작업자는 일하고, 끝 알림 뒤 새 턴이 열린다 (그동안 busy)", async () => {
    await boot();
    await loaded();
    emit(started(1));
    emit(turnStarted);
    emit(wStart("t1", "harness-tester", 1000, true));
    emit(turnEnded);
    expect(useSessionStore.getState().session?.busy).toBe(false);
    expect(workingWorkers(workersOf(1)).map((worker) => worker.toolUseId)).toEqual(["t1"]);
    expect(lineOf(1, "t1")).toMatchObject({ status: "running", background: true });
    // 끝 알림 → CLI 가 스스로 새 턴을 연다
    emit(wEnd("t1", "done", 9000));
    emit(turnStarted);
    expect(useSessionStore.getState().session?.busy).toBe(true);
    expect(workingWorkers(workersOf(1))).toHaveLength(0);
    expect(recentWorkers(workersOf(1)).map((worker) => [worker.toolUseId, worker.status])).toEqual([["t1", "done"]]);
    expect(lineOf(1, "t1")).toMatchObject({ status: "done", endedAtMs: 9000 });
  });

  it("둘 동시 — 시작 순으로 고르고, 하나가 끝나도 다른 하나는 계속", async () => {
    await boot();
    await loaded();
    emit(started(1));
    emit(wStart("late", "harness-builder-system", 3000));
    emit(wStart("early", "harness-builder-ui", 2000));
    expect(workingWorkers(workersOf(1)).map((worker) => worker.toolUseId)).toEqual(["early", "late"]);
    emit(wEnd("early"));
    expect(workingWorkers(workersOf(1)).map((worker) => worker.toolUseId)).toEqual(["late"]);
    expect(lineOf(1, "late")).toMatchObject({ status: "running" });
  });

  it("세션이 끝나면 남은 작업자는 멈춤 (Rust 가 끝 알림을 못 보냈어도)", async () => {
    await boot();
    await loaded();
    emit(started(1));
    emit(wStart("t1"));
    emit(wStart("t2"));
    emit(wEnd("t2", "done"));
    emit(ended);
    expect(workersOf(1).map((worker) => [worker.toolUseId, worker.status])).toEqual([["t1", "stopped"], ["t2", "done"]]);
    expect(lineOf(1, "t1")).toMatchObject({ status: "stopped" });
    expect(lineOf(1, "t2")).toMatchObject({ status: "done" });
    expect(workingWorkers(workersOf(1))).toHaveLength(0);
  });

  it("새 세션이 시작하면 옛 세션에서 남은 작업자는 멈춤", async () => {
    await boot();
    await loaded();
    emit(started(1));
    emit(wStart("old"));
    emit(started(1));
    expect(workersOf(1)[0]).toMatchObject({ toolUseId: "old", status: "stopped" });
  });

  it("지금 세션이 없는데 기록이 '일하는 중' 이라 하면 멈춤으로 본다 (끝 알림을 못 받음)", async () => {
    await boot();
    historyPage([entryOf(1, wStart("t1"), { status: "running", endedAtMs: null })]);
    await loadChat(1);
    expect(workersOf(1)[0]).toMatchObject({ status: "stopped" });
    expect(lineOf(1, "t1")).toMatchObject({ status: "stopped" });
  });

  it("프로젝트마다 따로 — 다른 프로젝트의 작업자는 섞이지 않는다", async () => {
    await boot();
    emit(started(1));
    emit(wStart("t1"));
    expect(workersOf(2)).toHaveLength(0);
    expect(selectWorkers(null)(useSessionStore.getState())).toHaveLength(0);
  });
});

describe("원본 출력 줄", () => {
  it("지금 세션 것만 최근 상한까지 — 넘으면 오래된 것부터 버리고, 새 세션이 시작하면 비운다", async () => {
    await boot();
    emit(started(1));
    for (let seq = 1; seq <= RAW_LINES_MAX + 25; seq += 1) emit(raw(seq));
    const lines = selectRawLines(1)(useSessionStore.getState());
    expect(lines).toHaveLength(RAW_LINES_MAX);
    expect(lines[0]?.seq).toBe(26);
    expect(lines[lines.length - 1]?.seq).toBe(RAW_LINES_MAX + 25);
    // 이벤트 껍데기(`type`)는 빠지고 줄만 남는다
    expect(lines[0]).not.toHaveProperty("type");
    // 다른 프로젝트에서는 보이지 않는다
    expect(selectRawLines(2)(useSessionStore.getState())).toHaveLength(0);
    // 새 세션 → 비움
    emit(started(1));
    expect(selectRawLines(1)(useSessionStore.getState())).toHaveLength(0);
  });

  it("세션이 없을 때 온 줄은 둘 곳이 없다 · 세션이 끝난 뒤에도 마지막 세션의 줄은 남는다", async () => {
    await boot();
    emit(raw(1));
    expect(selectRawLines(1)(useSessionStore.getState())).toHaveLength(0);
    emit(started(1));
    emit(raw(2));
    emit(ended);
    expect(selectRawLines(1)(useSessionStore.getState()).map((line) => line.seq)).toEqual([2]);
  });

  it("원본 줄은 채팅 목록에 들어가지 않는다", async () => {
    await boot();
    emit(started(1));
    emit(raw(1));
    expect(useSessionStore.getState().chats[1]?.data.lines).toHaveLength(0);
    expect(useSessionStore.getState().chats[1]?.buffer.some((event) => event.type === "raw_log")).toBe(false);
  });
});
