// 세션 저장소 — 이벤트 듣기는 한 번 · 이벤트 순서 · 다른 프로젝트에서 도는 중 · 다시 그릴 때 상태 · 기록 잇기 · 세션 츄르 · 일하는 중에 보낸 말.
// 이벤트는 `ipc.onClaudeEvent` 를 가로채 손으로 흘려 넣는다 (순서를 정해 두고 시험하려고). 가짜 세션 통합은 ChatPane.test.tsx 에서.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeHistory } from "../../lib/fakeHistory";
import { fakeProjects } from "../../lib/fakeProjects";
import { ipc } from "../../lib/ipc";
import type { ChatEntry, ChatPage, ClaudeEvent, ClaudeSessionState, UsageSummary } from "../../lib/ipc-types";
import { AppError } from "../../lib/ipc-types";
import { pendingCount } from "./model";
import { loadChat, loadOlder, resetSessionStore, selectPending, selectWaitingAsker, sendMessage, startSessionStore, useSessionStore } from "./sessionStore";

let emit: (event: ClaudeEvent) => void = () => undefined;
const IDLE: ClaudeSessionState = { running: false, projectId: null, projectDir: null, pid: null, sessionId: null, busy: false, pending: [] };

const USAGE = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
const started = (projectId: number): ClaudeEvent => ({ type: "session_started", projectId, projectDir: `C:\\p${projectId}`, pid: 1, resumed: false, resumeSessionId: null, cliVersion: null, model: "opus", effort: "high" });
const text = (value: string): ClaudeEvent => ({ type: "text", text: value });
const user = (value: string): ClaudeEvent => ({ type: "user_message", text: value, deferred: false });
const turnStarted: ClaudeEvent = { type: "turn_started", sessionId: "sess-1", model: null, cliVersion: null, permissionMode: null, apiKeySource: null };
const turnEnded = (outcome: "success" | "error" = "success", total = 1): ClaudeEvent => ({
  type: "turn_ended",
  outcome,
  subtype: null,
  isError: outcome !== "success",
  terminalReason: null,
  result: null,
  errors: [],
  apiErrorStatus: null,
  durationMs: 1,
  numTurns: 1,
  usage: USAGE,
  costUsd: 0.1,
  totalCostUsd: total,
});
const question = (requestId: string): ClaudeEvent => ({ type: "question_request", requestId, toolUseId: null, questions: [{ question: "q?", header: null, multiSelect: false, options: [] }] });
const ended: ClaudeEvent = { type: "session_ended", ended: "normal", exitCode: 0, forced: false, midTurn: false, stderrTail: [] };

function summary(projectId: number | null, totalTokens: number): UsageSummary {
  const sum = { turns: 1, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens, costUsd: 0.1, subscriptionTurns: 1, apiKeyTurns: 0, referenceOnly: true };
  return { since: 0, today: sum, projects: [], session: projectId === null ? null : { projectId, sessionId: "sess-1", usage: sum } };
}

/** 한 틀: 이벤트 듣기를 가로채고 처음 상태를 정해 시작한다 */
async function boot(state: ClaudeSessionState = IDLE) {
  const listen = vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
    emit = handler;
    return Promise.resolve(() => undefined);
  });
  vi.spyOn(ipc, "claudeSessionState").mockResolvedValue(state);
  await startSessionStore();
  return listen;
}

const chatOf = (projectId: number) => useSessionStore.getState().chats[projectId];
const lineKinds = (projectId: number) => chatOf(projectId)?.data.lines.map((line) => line.kind);

beforeEach(() => {
  resetSessionStore();
  fakeProjects.reset();
  fakeHistory.reset("empty");
  vi.spyOn(ipc, "appUsageSummary").mockResolvedValue(summary(null, 0));
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionStore();
  fakeProjects.reset();
  fakeHistory.reset();
});

describe("시작", () => {
  it("이벤트 듣기는 앱이 켜질 때 한 번 — 여러 번 불러도 한 번, 처음 상태를 읽는다", async () => {
    const listen = await boot();
    await startSessionStore();
    await startSessionStore();
    expect(listen).toHaveBeenCalledTimes(1);
    expect(ipc.claudeSessionState).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState()).toMatchObject({ restored: true, session: null });
  });

  it("처음 상태 읽기가 실패해도 세션 없음으로 시작한다", async () => {
    vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    });
    vi.spyOn(ipc, "claudeSessionState").mockRejectedValue(new AppError("internal", "boom"));
    await startSessionStore();
    expect(useSessionStore.getState()).toMatchObject({ restored: true, session: null });
  });

  it("처음 상태를 읽는 동안 온 이벤트는 모아 두었다가 그 뒤에 처리한다", async () => {
    let finish: (state: ClaudeSessionState) => void = () => undefined;
    vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    });
    vi.spyOn(ipc, "claudeSessionState").mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const booting = startSessionStore();
    await vi.waitFor(() => expect(ipc.claudeSessionState).toHaveBeenCalled());
    emit(started(1));
    expect(useSessionStore.getState().session).toBeNull();
    finish(IDLE);
    await booting;
    expect(useSessionStore.getState().session).toMatchObject({ projectId: 1 });
  });
});

describe("이벤트 순서", () => {
  it("세션 시작 → 말 → 먹물 글 → 질문 카드 → 답 → 턴 끝 — 목록 · 일하는 중 · 기다리는 카드가 그대로 따라온다", async () => {
    await boot();
    await loadChat(1);
    emit(started(1));
    expect(useSessionStore.getState().session).toMatchObject({ projectId: 1, busy: false });
    emit(user("시작해 줘"));
    emit(turnStarted);
    expect(useSessionStore.getState().session).toMatchObject({ busy: true, sessionId: "sess-1" });
    emit(text("읽었어요"));
    emit(question("q1"));
    expect(lineKinds(1)).toEqual(["user", "orch", "question"]);
    expect(selectPending(1)(useSessionStore.getState())).toBe(1);
    emit({ type: "request_answered", requestId: "q1", kind: "answer", text: null, answers: { "q?": "A" } });
    expect(pendingCount(chatOf(1)?.data.lines ?? [])).toBe(0);
    emit(turnEnded());
    expect(useSessionStore.getState().session).toMatchObject({ busy: false });
    expect(chatOf(1)?.data.lastStart).toEqual({ model: "opus", effort: "high" });
  });

  it("세션이 끝나면 세션 없음 · 기다리던 카드는 취소됨 · 츄르는 지워진다", async () => {
    await boot();
    await loadChat(1);
    emit(started(1));
    emit(question("q1"));
    emit(ended);
    const state = useSessionStore.getState();
    expect(state.session).toBeNull();
    expect(state.churros).toBeNull();
    expect(pendingCount(chatOf(1)?.data.lines ?? [])).toBe(0);
    expect(chatOf(1)?.resumable).toBe(true);
  });

  it("어느 세션인지 모르는 이벤트(세션 시작 없이 온 것)는 둘 곳이 없어 버린다 · raw_log 는 채팅에 안 간다", async () => {
    await boot();
    await loadChat(1);
    emit(text("떠돌이"));
    emit({ type: "raw_log", seq: 1, dir: "recv", text: "x", truncated: false, originalLen: 1, atMs: 0 });
    expect(chatOf(1)?.data.lines).toEqual([]);
  });
});

describe("다른 프로젝트", () => {
  it("돌고 있는 세션의 이벤트는 그 프로젝트 대화로만 가고, 다른 프로젝트에는 아무것도 가지 않는다", async () => {
    await boot();
    await loadChat(1);
    await loadChat(2);
    emit(started(1));
    emit(user("1번에서"));
    expect(lineKinds(1)).toEqual(["user"]);
    expect(lineKinds(2)).toEqual([]);
  });

  it("다른 프로젝트에서 세션이 도는 중에 보내면 거절 (세션은 한 번에 하나)", async () => {
    await boot();
    emit(started(1));
    const start = vi.spyOn(ipc, "claudeSessionStart");
    await expect(sendMessage(2, "안녕")).rejects.toMatchObject({ kind: "session_running" });
    expect(start).not.toHaveBeenCalled();
  });

  it("읽지 않은 프로젝트의 이벤트도 모아 두었다가, 읽은 뒤 잇는다 (고양이 집에 갔다 와도 그대로)", async () => {
    await boot();
    emit(started(1));
    emit(user("안 보는 동안"));
    emit(question("q1"));
    expect(chatOf(1)?.load).toBe("idle");
    expect(selectPending(1)(useSessionStore.getState())).toBe(1);
    await loadChat(1);
    expect(lineKinds(1)).toEqual(["user", "question"]);
    expect(chatOf(1)?.buffer).toEqual([]);
  });
});

describe("다시 그릴 때 상태", () => {
  it("세션이 돌고 있으면 처음 상태에서 세션 · 일하는 중 · 기다리는 카드를 되살린다", async () => {
    const pendingCard = question("q9") as Extract<ClaudeEvent, { type: "question_request" }>;
    await boot({ running: true, projectId: 1, projectDir: "C:\\p1", pid: 1, sessionId: "sess-9", busy: true, pending: [pendingCard] });
    expect(useSessionStore.getState().session).toEqual({ projectId: 1, busy: true, sessionId: "sess-9" });
    await loadChat(1);
    expect(lineKinds(1)).toEqual(["question"]);
    expect(pendingCount(chatOf(1)?.data.lines ?? [])).toBe(1);
  });

  it("기록에도 pending 으로 있는 같은 카드는 한 장이다", async () => {
    const card = question("q9") as Extract<ClaudeEvent, { type: "question_request" }>;
    await boot({ running: true, projectId: 1, projectDir: "C:\\p1", pid: 1, sessionId: "s", busy: true, pending: [card] });
    const entry: ChatEntry = { id: 7, at: 1, sessionId: "s", truncated: false, event: card as ChatEntry["event"], request: { status: "pending", answer: null } };
    vi.spyOn(ipc, "projectChatHistory").mockResolvedValue({ entries: [entry], hasMore: false });
    await loadChat(1);
    expect(chatOf(1)?.data.lines).toHaveLength(1);
  });
});

describe("기록 + 실시간 잇기", () => {
  function page(entries: ChatEntry[], hasMore = false): ChatPage {
    return { entries, hasMore };
  }
  const entry = (id: number, event: ChatEntry["event"]): ChatEntry => ({ id, at: id, sessionId: "s", truncated: false, event, request: null });

  it("읽는 동안 들어온 이벤트 — 이미 기록에 있는 것은 빼고 새것만 뒤에 붙는다", async () => {
    await boot({ running: true, projectId: 1, projectDir: "C:\\p1", pid: 1, sessionId: "s", busy: true, pending: [] });
    const done = [entry(1, user("a") as ChatEntry["event"]), entry(2, text("b") as ChatEntry["event"]), entry(3, user("c") as ChatEntry["event"])];
    vi.spyOn(ipc, "projectChatHistory").mockImplementation(async () => {
      // 읽는 중에: 이미 기록에 들어간 c(겹침) 와 아직 안 들어간 d(새것)
      emit(user("c"));
      emit(text("d"));
      return page(done);
    });
    await loadChat(1);
    expect(chatOf(1)?.data.lines.map((line) => (line.kind === "user" || line.kind === "orch" ? line.text : line.kind))).toEqual(["a", "b", "c", "d"]);
    expect(chatOf(1)?.load).toBe("ready");
  });

  it("읽기 전부터 모은 이벤트도 겹침 없이 잇는다 (기록이 그것까지 담았을 때)", async () => {
    await boot();
    emit(started(1));
    emit(user("a"));
    emit(text("b"));
    const done = [entry(1, user("a") as ChatEntry["event"]), entry(2, text("b") as ChatEntry["event"])];
    vi.spyOn(ipc, "projectChatHistory").mockResolvedValue(page(done));
    await loadChat(1);
    expect(chatOf(1)?.data.lines).toHaveLength(2);
    // 읽은 뒤에 오는 이벤트는 바로 붙는다
    emit(text("c"));
    expect(chatOf(1)?.data.lines).toHaveLength(3);
  });

  it("읽기가 실패하면 failed — 다시 부르면 다시 읽고, 모아 둔 이벤트는 그대로", async () => {
    await boot();
    emit(started(1));
    emit(user("a"));
    const read = vi.spyOn(ipc, "projectChatHistory").mockRejectedValueOnce(new AppError("db_unavailable", "x")).mockResolvedValue(page([]));
    await loadChat(1);
    expect(chatOf(1)).toMatchObject({ load: "failed", loadError: "db_unavailable" });
    await loadChat(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(lineKinds(1)).toEqual(["user"]);
  });

  it("이미 읽었거나 읽는 중이면 다시 읽지 않는다", async () => {
    await boot();
    const read = vi.spyOn(ipc, "projectChatHistory").mockResolvedValue(page([]));
    await Promise.all([loadChat(1), loadChat(1)]);
    await loadChat(1);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("이전 쪽 — 가진 가장 오래된 번호를 before 로, 앞에 붙이고, 다 읽으면 hasMore 가 꺼진다", async () => {
    await boot();
    const newest = [entry(5, user("e") as ChatEntry["event"]), entry(6, text("f") as ChatEntry["event"])];
    const oldest = [entry(3, user("c") as ChatEntry["event"]), entry(4, text("d") as ChatEntry["event"])];
    const read = vi.spyOn(ipc, "projectChatHistory").mockResolvedValueOnce(page(newest, true)).mockResolvedValueOnce(page(oldest, false));
    await loadChat(1);
    expect(chatOf(1)).toMatchObject({ hasMore: true, oldestId: 5 });
    await loadOlder(1);
    expect(read).toHaveBeenLastCalledWith(1, 5, 50);
    expect(chatOf(1)?.data.lines.map((line) => line.key)).toEqual(["h-3", "h-4", "h-5", "h-6"]);
    expect(chatOf(1)).toMatchObject({ hasMore: false, oldestId: 3, loadingOlder: false });
    await loadOlder(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("이전 쪽 읽기 실패는 한 줄(olderFailed) — 목록은 그대로", async () => {
    await boot();
    vi.spyOn(ipc, "projectChatHistory")
      .mockResolvedValueOnce(page([entry(5, user("e") as ChatEntry["event"])], true))
      .mockRejectedValueOnce(new AppError("internal", "x"));
    await loadChat(1);
    await loadOlder(1);
    expect(chatOf(1)).toMatchObject({ olderFailed: true, loadingOlder: false, hasMore: true });
    expect(chatOf(1)?.data.lines).toHaveLength(1);
  });
});

describe("세션 츄르", () => {
  it("턴이 끝날 때마다 다시 읽는다 — 시작 때 0, 끝날 때마다 새 값", async () => {
    await boot();
    const read = vi.spyOn(ipc, "appUsageSummary").mockResolvedValueOnce(summary(1, 0)).mockResolvedValueOnce(summary(1, 1200)).mockResolvedValue(summary(1, 2400));
    emit(started(1));
    await vi.waitFor(() => expect(useSessionStore.getState().churros).toEqual({ projectId: 1, totalTokens: 0, referenceOnly: true }));
    emit(turnEnded("success", 1));
    await vi.waitFor(() => expect(useSessionStore.getState().churros?.totalTokens).toBe(1200));
    emit(turnEnded("success", 2));
    await vi.waitFor(() => expect(useSessionStore.getState().churros?.totalTokens).toBe(2400));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("못 읽으면 지난 숫자를 그대로 두고 stale 표시만", async () => {
    await boot();
    vi.spyOn(ipc, "appUsageSummary").mockResolvedValueOnce(summary(1, 500)).mockRejectedValue(new AppError("db_unavailable", "x"));
    emit(started(1));
    await vi.waitFor(() => expect(useSessionStore.getState().churros?.totalTokens).toBe(500));
    emit(turnEnded());
    await vi.waitFor(() => expect(useSessionStore.getState().churrosStale).toBe(true));
    expect(useSessionStore.getState().churros?.totalTokens).toBe(500);
  });
});

describe("일하는 중에 보낸 말", () => {
  it("턴이 도는 중에 보내면 보내지 않고 두었다가, 턴이 끝나면 보낸다 (Rust 는 도는 중의 보내기를 받지 않는다)", async () => {
    await boot();
    emit(started(1));
    emit(user("첫 말"));
    emit(turnStarted);
    const send = vi.spyOn(ipc, "claudeSessionSend").mockResolvedValue(undefined);
    await expect(sendMessage(1, "이어서 이것도")).resolves.toBe("queued");
    expect(send).not.toHaveBeenCalled();
    expect(useSessionStore.getState().queued).toEqual({ projectId: 1, text: "이어서 이것도" });
    // 또 보내면 한 덩어리로
    await sendMessage(1, "그리고 저것도");
    expect(useSessionStore.getState().queued?.text).toBe("이어서 이것도\n\n그리고 저것도");
    emit(turnEnded());
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith("이어서 이것도\n\n그리고 저것도"));
    expect(useSessionStore.getState().queued).toBeNull();
  });

  it("보내 보니 turn_in_progress 면 그 말은 두고 다음 턴 끝에 다시 보낸다", async () => {
    await boot();
    emit(started(1));
    vi.spyOn(ipc, "claudeSessionSend").mockRejectedValue(new AppError("turn_in_progress", "x"));
    await expect(sendMessage(1, "급해요")).resolves.toBe("queued");
    expect(useSessionStore.getState().queued?.text).toBe("급해요");
  });

  it("세션이 끝나면 못 보낸 말은 입력줄이 되돌려 받는다", async () => {
    await boot();
    emit(started(1));
    emit(turnStarted);
    await sendMessage(1, "못 보낸 말");
    emit(ended);
    expect(useSessionStore.getState()).toMatchObject({ queued: null, draftBack: { projectId: 1, text: "못 보낸 말" } });
  });

  it("세션이 없으면 시작하고 보낸다 — 이어 할 대화가 있으면 이어 하기, 없으면 새로", async () => {
    await boot();
    vi.spyOn(ipc, "claudeLastSession").mockResolvedValue("old-session");
    const start = vi.spyOn(ipc, "claudeSessionStart").mockResolvedValue({ projectId: 1, projectDir: "C:\\p1", pid: 1, resumed: true, resumeSessionId: "old-session", cliVersion: null, model: null, effort: null });
    const send = vi.spyOn(ipc, "claudeSessionSend").mockResolvedValue(undefined);
    await expect(sendMessage(1, "안녕")).resolves.toBe("sent");
    expect(start).toHaveBeenCalledWith({ projectId: 1, resume: true });
    expect(send).toHaveBeenCalledWith("안녕");
  });

  it("이어 하기가 no_saved_session 으로 거절되면 새 대화로 한 번 더", async () => {
    await boot();
    vi.spyOn(ipc, "claudeLastSession").mockResolvedValue("old");
    const start = vi
      .spyOn(ipc, "claudeSessionStart")
      .mockRejectedValueOnce(new AppError("no_saved_session", "x"))
      .mockResolvedValue({ projectId: 1, projectDir: "C:\\p1", pid: 1, resumed: false, resumeSessionId: null, cliVersion: null, model: null, effort: null });
    vi.spyOn(ipc, "claudeSessionSend").mockResolvedValue(undefined);
    await sendMessage(1, "안녕");
    expect(start).toHaveBeenNthCalledWith(1, { projectId: 1, resume: true });
    expect(start).toHaveBeenNthCalledWith(2, { projectId: 1, resume: false });
  });

  it("시작이 실패하면(폴더 없음 등) 그대로 던진다 — 말은 보내지 않는다", async () => {
    await boot();
    vi.spyOn(ipc, "claudeLastSession").mockResolvedValue(null);
    vi.spyOn(ipc, "claudeSessionStart").mockRejectedValue(new AppError("project_folder_missing", "x"));
    const send = vi.spyOn(ipc, "claudeSessionSend");
    await expect(sendMessage(1, "안녕")).rejects.toMatchObject({ kind: "project_folder_missing" });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("기다리는 카드를 보낸 이", () => {
  const workerStarted = (toolUseId: string, name: string): ClaudeEvent => ({ type: "worker_started", toolUseId, agentId: null, name, description: null, background: false, depth: 1, atMs: 1 });
  const permission = (requestId: string, worker: { toolUseId: string | null; name: string | null } | null): ClaudeEvent => ({
    type: "permission_request",
    requestId,
    toolUseId: null,
    worker: worker ? { agentId: "a1", ...worker } : null,
    tool: "Bash",
    displayName: null,
    description: null,
    command: "npm install",
    path: null,
    cwd: "C:/p1",
    input: null,
    alwaysRule: null,
  });
  const asker = (projectId: number) => selectWaitingAsker(projectId)(useSessionStore.getState());

  it("카드가 없으면 null — 질문 카드는 먹물(worker null) · 카드가 생긴 때", async () => {
    await boot();
    await loadChat(1);
    emit(started(1));
    expect(asker(1)).toBeNull();
    emit(question("q1"));
    expect(asker(1)).toMatchObject({ worker: null });
    expect(asker(1)?.sinceMs).toEqual(expect.any(Number));
    emit({ type: "request_answered", requestId: "q1", kind: "answer", text: null, answers: { "q?": "A" } });
    expect(asker(1)).toBeNull();
  });

  it("작업자의 권한 카드는 작업자 이름(작업자 목록에서) — 맨 앞(먼저 온) 카드의 보낸 이", async () => {
    await boot();
    await loadChat(1);
    emit(started(1));
    emit(workerStarted("tu-1", "harness-builder-ui"));
    emit(permission("p1", { toolUseId: "tu-1", name: null }));
    emit(question("q2"));
    expect(asker(1)?.worker).toBe("harness-builder-ui");
    emit({ type: "request_answered", requestId: "p1", kind: "allow", text: null, answers: null });
    expect(asker(1)?.worker).toBeNull();
  });

  it("작업자 목록에 없으면 요청의 이름, 이름도 없으면 먹물 쪽", async () => {
    await boot();
    await loadChat(1);
    emit(started(1));
    emit(permission("p1", { toolUseId: "tu-x", name: "harness-tester" }));
    expect(asker(1)?.worker).toBe("harness-tester");
    emit({ type: "request_cancelled", requestId: "p1" });
    emit(permission("p2", { toolUseId: null, name: null }));
    expect(asker(1)?.worker).toBeNull();
  });

  it("아직 읽지 않은 대화의 모아 둔 이벤트도 센다 · 값이 같으면 같은 객체 · 다른 프로젝트는 따로", async () => {
    await boot();
    emit(started(1));
    emit(workerStarted("tu-1", "harness-reviewer"));
    emit(permission("p1", { toolUseId: "tu-1", name: null }));
    expect(chatOf(1)?.load).not.toBe("ready");
    const first = asker(1);
    expect(first?.worker).toBe("harness-reviewer");
    expect(asker(1)).toBe(first);
    expect(asker(2)).toBeNull();
    expect(selectWaitingAsker(null)(useSessionStore.getState())).toBeNull();
  });
});
