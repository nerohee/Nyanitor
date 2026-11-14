import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "./fakeClaude";
import { fakeProjects } from "./fakeProjects";
import {
  AppError,
  CLAUDE_SESSION_EVENT,
  WINDOW_SHOWN_EVENT,
  WINDOW_VISIBILITY_EVENT,
  ipc,
  type ClaudeEvent,
  type WindowShownEvent,
  type WindowVisibilityEvent,
} from "./ipc";

afterEach(() => {
  clearMocks();
});

describe("ipc — Claude 연결 명령 (Tauri 안)", () => {
  it("시작 요청은 { request } 로 묶어 보낸다 (실행 파일 · 인자 칸이 없다)", async () => {
    const handler = vi.fn(() => ({
      projectId: 1,
      projectDir: "C:\\p",
      pid: 1,
      resumed: false,
      resumeSessionId: null,
      cliVersion: "2.1.296",
      model: "opus",
      effort: "high",
    }));
    mockIPC(handler);

    const info = await ipc.claudeSessionStart({ projectId: 1, resume: false, useApiKey: false });
    expect(handler).toHaveBeenCalledWith("claude_session_start", {
      request: { projectId: 1, resume: false, useApiKey: false },
    });
    // 실제로 쓴 모델 · 수준은 돌려받는다 (보내는 칸은 없다)
    expect(info).toMatchObject({ projectId: 1, model: "opus", effort: "high" });
  });

  it("답 · 보내기 · 중단 · 끝내기 · 상태 · 마지막 세션 · 원본 로그가 Rust 명령 이름과 인자 이름에 맞는다", async () => {
    const handler = vi.fn((): unknown => null);
    mockIPC(handler);

    await ipc.claudeSessionSend("hello");
    await ipc.claudeSessionRespond("req-1", { kind: "always_allow" });
    await ipc.claudeSessionRespond("req-2", { kind: "answer", answers: { Q: ["A", "B"] } });
    await ipc.claudeSessionInterrupt();
    await ipc.claudeSessionStop();
    await ipc.claudeSessionState();
    await ipc.claudeLastSession(1);
    await ipc.claudeRawLog();
    await ipc.claudeDiscover();
    await ipc.claudeOpenLogin();

    expect(handler.mock.calls).toEqual([
      ["claude_session_send", { text: "hello" }],
      ["claude_session_respond", { requestId: "req-1", response: { kind: "always_allow" } }],
      ["claude_session_respond", { requestId: "req-2", response: { kind: "answer", answers: { Q: ["A", "B"] } } }],
      ["claude_session_interrupt", {}],
      ["claude_session_stop", {}],
      ["claude_session_state", {}],
      ["claude_last_session", { projectId: 1 }],
      ["claude_raw_log", {}],
      ["claude_discover", {}],
      ["claude_open_login", {}],
    ]);
  });

  it("새 오류 종류도 AppError 로 받는다", async () => {
    mockIPC(() => {
      throw { kind: "session_running", message: "a session is already running" };
    });

    const error = await ipc.claudeSessionStart({ projectId: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: "session_running" });
  });

  it("모르는 오류 종류는 internal 로 바꾼다", async () => {
    mockIPC(() => {
      throw { kind: "something_new", message: "x" };
    });

    const error = await ipc.claudeSessionStop().catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "internal" });
  });

  it("세션 이벤트를 듣고, 그만 들으면 더 받지 않는다", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: ClaudeEvent[] = [];
    const stop = await ipc.onClaudeEvent((event) => seen.push(event));

    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const emit = (payload: ClaudeEvent) => internals.invoke("plugin:event|emit", { event: CLAUDE_SESSION_EVENT, payload });

    await emit({ type: "request_cancelled", requestId: "r1" });
    expect(seen).toEqual([{ type: "request_cancelled", requestId: "r1" }]);

    stop();
    await emit({ type: "request_cancelled", requestId: "r2" });
    expect(seen).toHaveLength(1);
  });
});

describe("ipc — 숨어 있던 창이 열림 (D-50)", () => {
  afterEach(() => {
    fakeClaude.reset();
  });

  it("Tauri 안에서는 Rust 이벤트를 듣고, 그만 들으면 더 받지 않는다", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: WindowShownEvent[] = [];
    const stop = await ipc.onWindowShown((event) => seen.push(event));

    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const emit = (payload: WindowShownEvent) => internals.invoke("plugin:event|emit", { event: WINDOW_SHOWN_EVENT, payload });

    await emit({ reason: "tray" });
    await emit({ reason: "second_instance" });
    expect(seen).toEqual([{ reason: "tray" }, { reason: "second_instance" }]);

    stop();
    await emit({ reason: "tray_menu" });
    expect(seen).toHaveLength(2);
  });

  it("창 이벤트는 세션 이벤트와 따로 온다 (서로의 구독에 섞이지 않는다)", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const sessions: ClaudeEvent[] = [];
    const shown: WindowShownEvent[] = [];
    await ipc.onClaudeEvent((event) => sessions.push(event));
    await ipc.onWindowShown((event) => shown.push(event));

    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|emit", { event: WINDOW_SHOWN_EVENT, payload: { reason: "tray" } });
    expect(shown).toEqual([{ reason: "tray" }]);
    expect(sessions).toEqual([]);
  });

  it("브라우저 가짜 모드는 흉내 낸 이벤트를 듣는 쪽마다 한 번씩 준다", async () => {
    const first: WindowShownEvent[] = [];
    const second: WindowShownEvent[] = [];
    const stopFirst = await ipc.onWindowShown((event) => first.push(event));
    await ipc.onWindowShown((event) => second.push(event));

    fakeClaude.simulateWindowShown();
    fakeClaude.simulateWindowShown("tray_menu");
    expect(first).toEqual([{ reason: "tray" }, { reason: "tray_menu" }]);
    expect(second).toEqual(first);

    stopFirst();
    fakeClaude.simulateWindowShown("second_instance");
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);
  });

  it("한 듣는 쪽이 오류를 던져도 다른 쪽은 받는다", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: WindowShownEvent[] = [];
    await ipc.onWindowShown(() => {
      throw new Error("boom");
    });
    await ipc.onWindowShown((event) => seen.push(event));
    fakeClaude.simulateWindowShown();
    expect(seen).toEqual([{ reason: "tray" }]);
    expect(quiet).toHaveBeenCalledTimes(1);
    quiet.mockRestore();
  });

  it("출시 빌드의 Tauri 밖에서는 가짜로 돌지 않고 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.onWindowShown(() => undefined)).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.onWindowVisibility(() => undefined)).rejects.toMatchObject({ kind: "internal" });
    vi.unstubAllEnvs();
  });

  it("창 보임 바뀜: Tauri 안에서는 Rust 이벤트를 듣고, 창 열림 · 세션 이벤트와 섞이지 않고, 그만 들으면 더 받지 않는다", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: WindowVisibilityEvent[] = [];
    const shown: WindowShownEvent[] = [];
    const stop = await ipc.onWindowVisibility((event) => seen.push(event));
    await ipc.onWindowShown((event) => shown.push(event));

    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const emit = (payload: WindowVisibilityEvent) => internals.invoke("plugin:event|emit", { event: WINDOW_VISIBILITY_EVENT, payload });

    await emit({ visible: false });
    await emit({ visible: true });
    expect(seen).toEqual([{ visible: false }, { visible: true }]);
    expect(shown).toEqual([]);

    stop();
    await emit({ visible: false });
    expect(seen).toHaveLength(2);
  });

  it("창 보임 바뀜: 브라우저 가짜 모드는 흉내 낸 이벤트를 듣는 쪽마다 주고, 한쪽의 오류가 다른 쪽을 막지 않는다", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first: WindowVisibilityEvent[] = [];
    const second: WindowVisibilityEvent[] = [];
    await ipc.onWindowVisibility(() => {
      throw new Error("boom");
    });
    const stopFirst = await ipc.onWindowVisibility((event) => first.push(event));
    await ipc.onWindowVisibility((event) => second.push(event));

    fakeClaude.simulateWindowVisibility(false);
    fakeClaude.simulateWindowVisibility(true);
    expect(first).toEqual([{ visible: false }, { visible: true }]);
    expect(second).toEqual(first);
    expect(quiet).toHaveBeenCalledTimes(2);

    stopFirst();
    fakeClaude.simulateWindowVisibility(false);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(3);

    fakeClaude.reset();
    fakeClaude.simulateWindowVisibility(true);
    expect(second).toHaveLength(3);
    quiet.mockRestore();
  });
});

async function collectEvents() {
  const events: ClaudeEvent[] = [];
  await ipc.onClaudeEvent((event) => events.push(event));
  return events;
}

describe("ipc — Claude 연결 (브라우저 가짜 모드)", () => {
  beforeEach(() => {
    fakeClaude.reset();
    fakeProjects.reset();
  });

  it("찾기는 가짜 결과를 돌려준다", async () => {
    const status = await ipc.claudeDiscover();
    expect(status).toMatchObject({ found: true, loggedIn: true, versionMatches: true, apiKeyPresent: false });
  });

  it("번호가 아닌 값으로 시작하면 invalid_input, 돌아가는 중에 또 시작하면 session_running", async () => {
    await expect(ipc.claudeSessionStart({ projectId: "1" as unknown as number })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.claudeSessionStart({ projectId: Number.NaN })).rejects.toMatchObject({ kind: "invalid_input" });
    await ipc.claudeSessionStart({ projectId: 1 });
    await expect(ipc.claudeSessionStart({ projectId: 1 })).rejects.toMatchObject({ kind: "session_running" });
  });

  it("세션이 없으면 보내기 · 중단 · 답하기가 no_session", async () => {
    await expect(ipc.claudeSessionSend("x")).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionInterrupt()).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionRespond("r", { kind: "allow" })).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionStop()).resolves.toEqual({ wasRunning: false, forced: false });
  });

  it("보낸 말에 따라 권한 요청이 오고, 답하면 턴이 끝난다", async () => {
    const events = await collectEvents();
    await ipc.claudeSessionStart({ projectId: 1 });
    await ipc.claudeSessionSend("파일 쓰기 해 줘");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));

    const request = events.find((e) => e.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("no request");
    expect(request.tool).toBe("Write");
    expect(request.alwaysRule).toEqual({ rule: "Edit(/src/**)", scope: "folder", folder: "src" });

    // 턴이 도는 중에는 또 보낼 수 없다
    await expect(ipc.claudeSessionSend("again")).rejects.toMatchObject({ kind: "turn_in_progress" });
    expect((await ipc.claudeSessionState()).pending).toHaveLength(1);

    await ipc.claudeSessionRespond(request.requestId, { kind: "allow" });
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_ended")).toBe(true));
    // 한 번 답한 요청에 또 답하면 request_not_found
    await expect(ipc.claudeSessionRespond(request.requestId, { kind: "allow" })).rejects.toMatchObject({
      kind: "request_not_found",
    });
  });

  it("다르게 말하기는 중단된 턴이 끝난 뒤 그 말을 새 메시지로 보낸다", async () => {
    const events = await collectEvents();
    await ipc.claudeSessionStart({ projectId: 1 });
    await ipc.claudeSessionSend("hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    const request = events.find((e) => e.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("no request");

    await ipc.claudeSessionRespond(request.requestId, { kind: "tell", text: "다르게 해 주세요" });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "user_message" && e.deferred && e.text === "다르게 해 주세요")).toBe(true),
    );
    const ended = events.filter((e) => e.type === "turn_ended");
    expect(ended[0]).toMatchObject({ outcome: "interrupted" });
  });

  it("질문 카드에는 맞는 답만 받는다", async () => {
    const events = await collectEvents();
    await ipc.claudeSessionStart({ projectId: 1 });
    await ipc.claudeSessionSend("질문 해 줘");
    await vi.waitFor(() => expect(events.some((e) => e.type === "question_request")).toBe(true));
    const request = events.find((e) => e.type === "question_request");
    if (request?.type !== "question_request") throw new Error("no question");

    await expect(ipc.claudeSessionRespond(request.requestId, { kind: "allow" })).rejects.toMatchObject({ kind: "invalid_input" });
    await ipc.claudeSessionRespond(request.requestId, { kind: "answer", answers: { a: "b" } });
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_ended")).toBe(true));
  });

  it("끝내면 session_ended 가 오고 마지막 세션이 남아 이어 하기가 된다", async () => {
    const events = await collectEvents();
    await expect(ipc.claudeSessionStart({ projectId: 1, resume: true })).rejects.toMatchObject({ kind: "no_saved_session" });
    await ipc.claudeSessionStart({ projectId: 1 });
    await ipc.claudeSessionSend("hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    await ipc.claudeSessionStop();
    expect(events[events.length - 1]).toMatchObject({ type: "session_ended", ended: "normal" });
    expect(events.some((e) => e.type === "request_cancelled")).toBe(true);

    const saved = await ipc.claudeLastSession(1);
    expect(saved).not.toBeNull();
    const info = await ipc.claudeSessionStart({ projectId: 1, resume: true });
    expect(info).toMatchObject({ resumed: true, resumeSessionId: saved });
  });

  it("중단하면 기다리던 카드가 취소되고 턴이 중단됨으로 끝난다", async () => {
    const events = await collectEvents();
    await ipc.claudeSessionStart({ projectId: 1 });
    await ipc.claudeSessionSend("hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    await ipc.claudeSessionInterrupt();
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_ended")).toBe(true));
    expect(events.some((e) => e.type === "request_cancelled")).toBe(true);
    expect(events.find((e) => e.type === "turn_ended")).toMatchObject({ outcome: "interrupted" });
    expect((await ipc.claudeSessionState()).pending).toEqual([]);
  });
});
