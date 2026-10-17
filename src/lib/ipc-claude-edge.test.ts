// ipc · 가짜 Claude 세션 — 구독 해제 · 두 번 요청 · 세션 없음 같은 경계 (P3-03)
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "./fakeClaude";
import { CLAUDE_SESSION_EVENT, ipc, type ClaudeEvent } from "./ipc";

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fakeClaude.reset();
});

async function collect() {
  const events: ClaudeEvent[] = [];
  const stop = await ipc.onClaudeEvent((e) => events.push(e));
  return { events, stop };
}

const waitFor = (events: ClaudeEvent[], type: ClaudeEvent["type"]) => vi.waitFor(() => expect(events.some((e) => e.type === type)).toBe(true));

describe("ipc — 이벤트 구독 (Tauri 안)", () => {
  function emitter() {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    return (payload: unknown) => internals.invoke("plugin:event|emit", { event: CLAUDE_SESSION_EVENT, payload });
  }

  it("그만 듣기를 두 번 불러도 오류가 없고, 다른 구독은 계속 받는다", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const a: ClaudeEvent[] = [];
    const b: ClaudeEvent[] = [];
    const stopA = await ipc.onClaudeEvent((e) => a.push(e));
    await ipc.onClaudeEvent((e) => b.push(e));
    const emit = emitter();

    await emit({ type: "text", text: "1" });
    stopA();
    expect(() => stopA()).not.toThrow();
    await emit({ type: "text", text: "2" });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("알 수 없는 종류의 이벤트도 그대로 전달하고 구독이 끊기지 않는다", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: unknown[] = [];
    await ipc.onClaudeEvent((e) => seen.push(e));
    const emit = emitter();

    await emit({ type: "future_thing", x: 1 });
    await emit({ type: "text", text: "after" });
    expect(seen).toEqual([{ type: "future_thing", x: 1 }, { type: "text", text: "after" }]);
  });

  it("다른 이름의 이벤트는 받지 않는다", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: unknown[] = [];
    await ipc.onClaudeEvent((e) => seen.push(e));
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    await internals.invoke("plugin:event|emit", { event: "something:else", payload: { type: "text", text: "x" } });
    expect(seen).toEqual([]);
  });
});

describe("가짜 Claude 세션 — 구독 · 순서", () => {
  it("구독을 끊으면 이후 이벤트를 받지 않고, 두 번 끊어도 괜찮다", async () => {
    const { events, stop } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    expect(events.map((e) => e.type)).toEqual(["session_started"]);
    stop();
    stop();
    await ipc.claudeSessionStop();
    expect(events.map((e) => e.type)).toEqual(["session_started"]);
  });

  it("구독이 둘이면 둘 다 같은 이벤트를 받는다", async () => {
    const a = await collect();
    const b = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    expect(a.events).toEqual(b.events);
    expect(a.events.length).toBeGreaterThan(0);
  });

  // (P3-03 버그였던 것 — P3-05 에서 고침) 한 구독자의 오류가 뒤 구독자를 막지 않는다.
  it("한 구독자가 오류를 던져도 다른 구독자는 이벤트를 받는다", async () => {
    await ipc.onClaudeEvent(() => {
      throw new Error("listener bug");
    });
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" }).catch(() => undefined);
    expect(events.some((e) => e.type === "session_started")).toBe(true);
  });

  it("이벤트를 받는 도중 스스로 구독을 끊어도 다음 구독자가 받는다", async () => {
    let stopFirst: () => void = () => undefined;
    stopFirst = await ipc.onClaudeEvent(() => stopFirst());
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    expect(events).toHaveLength(1);
  });
});

describe("가짜 Claude 세션 — 상태 기계 경계", () => {
  it("끝낸 뒤에는 보내기 · 답하기 · 중단이 no_session, 끝내기를 또 해도 오류 없이 wasRunning false", async () => {
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await expect(ipc.claudeSessionStop()).resolves.toEqual({ wasRunning: true, forced: false });
    await expect(ipc.claudeSessionStop()).resolves.toEqual({ wasRunning: false, forced: false });
    await expect(ipc.claudeSessionSend("hi")).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionInterrupt()).rejects.toMatchObject({ kind: "no_session" });
    await expect(ipc.claudeSessionRespond("x", { kind: "allow" })).rejects.toMatchObject({ kind: "no_session" });
    expect(await ipc.claudeSessionState()).toMatchObject({ running: false, busy: false, pending: [] });
  });

  it("빈 말 · 공백만 있는 말은 invalid_input 이고 턴이 시작되지 않는다", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    for (const text of ["", "   ", "\n\t"]) {
      await expect(ipc.claudeSessionSend(text)).rejects.toMatchObject({ kind: "invalid_input" });
    }
    expect((await ipc.claudeSessionState()).busy).toBe(false);
    expect(events.some((e) => e.type === "user_message")).toBe(false);
  });

  it("아주 긴 말도 보낼 수 있고, 같은 턴 중에 또 보내면 turn_in_progress", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("가".repeat(200_000));
    await expect(ipc.claudeSessionSend("again")).rejects.toMatchObject({ kind: "turn_in_progress" });
    await waitFor(events, "permission_request");
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
  });

  it("중단을 두 번 해도 오류가 없고 카드 취소는 한 번씩만 온다", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    await ipc.claudeSessionInterrupt();
    await ipc.claudeSessionInterrupt();
    await waitFor(events, "turn_ended");
    expect(events.filter((e) => e.type === "request_cancelled")).toHaveLength(1);
    expect(events.filter((e) => e.type === "turn_ended")).toHaveLength(1);
    expect((await ipc.claudeSessionState()).busy).toBe(false);
  });

  it("카드 대기 중 끝내면 카드 취소 뒤에 세션 끝이 오고, 끝난 뒤에는 이벤트가 더 안 온다", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    await ipc.claudeSessionStop();
    const types = events.map((e) => e.type);
    expect(types.indexOf("request_cancelled")).toBeGreaterThan(types.indexOf("permission_request"));
    expect(types.indexOf("session_ended")).toBeGreaterThan(types.indexOf("request_cancelled"));
    const count = events.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toHaveLength(count);
  });

  it("다르게 말하기 직후 곧바로 끝내도 끝난 세션에서 새 턴이 시작되지 않는다", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    const request = events.find((e) => e.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("no request");
    await ipc.claudeSessionRespond(request.requestId, { kind: "tell", text: "다르게" });
    await ipc.claudeSessionStop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const last = events[events.length - 1];
    expect(last?.type).toBe("session_ended");
    expect((await ipc.claudeSessionState()).running).toBe(false);
  });

  it("권한 카드에 답이 안 맞으면 요청이 남고, 규칙이 없는 요청에 always_allow 는 거절된다", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    const request = events.find((e) => e.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("no request");
    await expect(ipc.claudeSessionRespond(request.requestId, { kind: "answer", answers: {} })).rejects.toMatchObject({
      kind: "invalid_input",
    });
    expect((await ipc.claudeSessionState()).pending).toHaveLength(1);
    await expect(ipc.claudeSessionRespond("fake-perm-999", { kind: "allow" })).rejects.toMatchObject({ kind: "request_not_found" });
    await expect(ipc.claudeSessionRespond("", { kind: "allow" })).rejects.toMatchObject({ kind: "request_not_found" });
  });

  it("시작 폴더가 공백뿐이거나 이어 하기 기록이 없으면 세션이 열리지 않는다", async () => {
    await expect(ipc.claudeSessionStart({ projectDir: "" })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.claudeSessionStart({ projectDir: "C:\\p", resume: true })).rejects.toMatchObject({ kind: "no_saved_session" });
    expect((await ipc.claudeSessionState()).running).toBe(false);
  });

  // (P3-03 버그였던 것 — P3-05 에서 고침) 가짜 세션의 이어 하기 키도 Rust project_key 처럼 모은다.
  it("같은 폴더를 다른 표기(대소문자 · 끝 \\)로 시작하면 이어 하기 기록이 이어진다", async () => {
    // Rust 저장소(project_key)는 같은 폴더의 다른 표기를 한 키로 모은다 — 가짜 세션도 같아야 화면 시험이 실제와 어긋나지 않는다.
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\Dev\\App" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    await ipc.claudeSessionStop();
    expect(await ipc.claudeLastSession("c:\\dev\\app\\")).not.toBeNull();
  });

  it("원본 로그는 새 세션을 시작하면 비워진다", async () => {
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    expect((await ipc.claudeRawLog()).length).toBeGreaterThan(0);
    await ipc.claudeSessionStop();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    expect(await ipc.claudeRawLog()).toEqual([]);
  });
});

describe("가짜 세션 — 이어 하기 키 · 구독자 오류 (P3-05)", () => {
  it("fakeProjectKey 는 Rust project_key(Windows) 처럼 같은 폴더의 다른 표기를 한 키로 모은다", async () => {
    const { fakeProjectKey } = await import("./fakeClaude");
    const key = fakeProjectKey("C:\\Users\\Me\\Proj");
    for (const same of [
      "c:\\users\\me\\proj\\",
      "C:/Users/Me/Proj",
      "c:/users/me/proj//",
      "\\\\?\\C:\\Users\\Me\\Proj",
      "C:\\Users\\.\\Me\\\\Proj",
    ]) {
      expect(fakeProjectKey(same), same).toBe(key);
    }
    expect(fakeProjectKey("C:\\Users\\Me\\Proj2")).not.toBe(key);
    expect(fakeProjectKey("D:\\Users\\Me\\Proj")).not.toBe(key);
    expect(fakeProjectKey("C:")).toBe(fakeProjectKey("C:\\"));
    expect(fakeProjectKey("\\\\?\\UNC\\Srv\\Share\\P")).toBe(fakeProjectKey("\\\\srv\\share\\p\\"));
    expect(fakeProjectKey("")).toBe("");
  });

  it("오류를 던지는 구독자가 앞에 있어도 뒤 구독자는 모든 이벤트를 받는다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await ipc.onClaudeEvent(() => {
      throw new Error("listener bug");
    });
    const { events } = await collect();
    await ipc.claudeSessionStart({ projectDir: "C:\\p" });
    await ipc.claudeSessionSend("hello");
    await waitFor(events, "permission_request");
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["session_started", "user_message", "turn_started", "permission_request"]));
  });
});
