import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "./fakeClaude";
import { AppError, CLAUDE_SESSION_EVENT, ipc, type ClaudeEvent } from "./ipc";

afterEach(() => {
  clearMocks();
});

describe("ipc — Claude 연결 명령 (Tauri 안)", () => {
  it("시작 요청은 { request } 로 묶어 보낸다 (실행 파일 · 인자 칸이 없다)", async () => {
    const handler = vi.fn(() => ({ projectDir: "C:\\p", pid: 1, resumed: false, resumeSessionId: null, cliVersion: "2.1.296" }));
    mockIPC(handler);

    await ipc.claudeSessionStart({ projectDir: "C:\\p", model: "haiku", resume: false, useApiKey: false });
    expect(handler).toHaveBeenCalledWith("claude_session_start", {
      request: { projectDir: "C:\\p", model: "haiku", resume: false, useApiKey: false },
    });
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
    await ipc.claudeLastSession("C:\\p");
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
      ["claude_last_session", { projectDir: "C:\\p" }],
      ["claude_raw_log", {}],
      ["claude_discover", {}],
      ["claude_open_login", {}],
    ]);
  });

  it("새 오류 종류도 AppError 로 받는다", async () => {
    mockIPC(() => {
      throw { kind: "session_running", message: "a session is already running" };
    });

    const error = await ipc.claudeSessionStart({ projectDir: "C:\\p" }).catch((e: unknown) => e);
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

async function collectEvents() {
  const events: ClaudeEvent[] = [];
  await ipc.onClaudeEvent((event) => events.push(event));
  return events;
}

describe("ipc — Claude 연결 (브라우저 가짜 모드)", () => {
  beforeEach(() => {
    fakeClaude.reset();
  });

  it("찾기는 가짜 결과를 돌려준다", async () => {
    const status = await ipc.claudeDiscover();
    expect(status).toMatchObject({ found: true, loggedIn: true, versionMatches: true, apiKeyPresent: false });
  });

  it("폴더 없이 시작하면 invalid_input, 돌아가는 중에 또 시작하면 session_running", async () => {
    await expect(ipc.claudeSessionStart({ projectDir: "  " })).rejects.toMatchObject({ kind: "invalid_input" });
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await expect(ipc.claudeSessionStart({ projectDir: "C:\\p" })).rejects.toMatchObject({ kind: "session_running" });
  });

  it("세션이 없으면 보내기 · 중단 · 답하기가 no_session", async () => {
    await expect(ipc.claudeSessionSend("x")).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionInterrupt()).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionRespond("r", { kind: "allow" })).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionStop()).resolves.toEqual({ wasRunning: false, forced: false });
  });

  it("보낸 말에 따라 권한 요청이 오고, 답하면 턴이 끝난다", async () => {
    const events = await collectEvents();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
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
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
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
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
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
    await expect(ipc.claudeSessionStart({ projectDir: "C:\\p", resume: true })).rejects.toMatchObject({ kind: "no_saved_session" });
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    await ipc.claudeSessionStop();
    expect(events[events.length - 1]).toMatchObject({ type: "session_ended", ended: "normal" });
    expect(events.some((e) => e.type === "request_cancelled")).toBe(true);

    const saved = await ipc.claudeLastSession("C:\\p");
    expect(saved).not.toBeNull();
    const info = await ipc.claudeSessionStart({ projectDir: "C:\\p", resume: true });
    expect(info).toMatchObject({ resumed: true, resumeSessionId: saved });
  });

  it("중단하면 기다리던 카드가 취소되고 턴이 중단됨으로 끝난다", async () => {
    const events = await collectEvents();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    await ipc.claudeSessionInterrupt();
    await vi.waitFor(() => expect(events.some((e) => e.type === "turn_ended")).toBe(true));
    expect(events.some((e) => e.type === "request_cancelled")).toBe(true);
    expect(events.find((e) => e.type === "turn_ended")).toMatchObject({ outcome: "interrupted" });
    expect((await ipc.claudeSessionState()).pending).toEqual([]);
  });
});
