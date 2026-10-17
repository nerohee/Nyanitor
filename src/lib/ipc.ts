// 화면이 Rust 명령을 부르고 Rust 이벤트를 듣는 유일한 입구. 화면 코드는 `@tauri-apps/api/core` · `/event` 를 직접 가져오지 않는다
// (eslint `no-restricted-imports` 로 막혀 있고 이 파일만 예외).
// Tauri 밖(브라우저, `npm run dev`)에서는 개발 빌드에 한해 가짜 데이터를 돌려줘서 화면을 보고 시험할 수 있다.
// 가짜 세션(`fakeClaude.ts`)은 개발 빌드에서만 동적으로 불러온다 — 출시 빌드에서는 그 분기가 지워져 번들에 들어가지 않고,
// Tauri 밖에서 출시 빌드가 돌면 가짜로 돌지 않고 오류를 낸다.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AppError,
  CLAUDE_SESSION_EVENT,
  toAppError,
  type AppInfo,
  type ClaudeEvent,
  type ClaudeResponse,
  type ClaudeSessionState,
  type ClaudeStatus,
  type RawLogEntry,
  type StartInfo,
  type StartRequest,
  type StopInfo,
} from "./ipc-types";

export * from "./ipc-types";

// Tauri 가 창에 넣는 `__TAURI_INTERNALS__.invoke` 가 있으면 앱 안이다 (`mockIPC` 도 같은 자리에 넣는다).
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

type FakeModule = typeof import("./fakeClaude");

let fakeLoading: Promise<FakeModule> | null = null;

/** 가짜 세션 모듈. 개발 빌드에서만 불러온다 (`import.meta.env.DEV` 가 출시 빌드에서 `false` 로 바뀌어 이 분기가 지워진다). */
function loadFake(): Promise<FakeModule> {
  if (import.meta.env.DEV) {
    fakeLoading ??= import("./fakeClaude");
    return fakeLoading;
  }
  return Promise.reject(new AppError("internal", "the Tauri runtime is missing — this build has no browser fake"));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri()) {
    try {
      const { fakeCall } = await loadFake();
      return (await fakeCall(command, args ?? {})) as T;
    } catch (raw) {
      throw toAppError(raw);
    }
  }
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toAppError(raw);
  }
}

/** Claude 세션 이벤트를 듣는다. 돌려주는 함수를 부르면 그만 듣는다. 브라우저에서는 가짜 세션의 이벤트를 듣는다. */
async function onClaudeEvent(handler: (event: ClaudeEvent) => void): Promise<() => void> {
  if (!inTauri()) {
    const { fakeClaude } = await loadFake().catch((raw: unknown) => {
      throw toAppError(raw);
    });
    return fakeClaude.subscribe(handler);
  }
  const unlisten: UnlistenFn = await listen<ClaudeEvent>(CLAUDE_SESSION_EVENT, (event) => handler(event.payload));
  return unlisten;
}

export const ipc = {
  appInfo: () => call<AppInfo>("app_info"),

  /** claude 찾기 · 버전 · 로그인 상태 · API 키 있음 */
  claudeDiscover: () => call<ClaudeStatus>("claude_discover"),
  /** `claude auth login` 을 새 터미널 창으로 띄운다 (로그인은 Anthropic 의 흐름 — 앱은 로그인 화면을 만들지 않는다) */
  claudeOpenLogin: () => call<void>("claude_open_login"),
  claudeSessionStart: (request: StartRequest) => call<StartInfo>("claude_session_start", { request }),
  claudeSessionSend: (text: string) => call<void>("claude_session_send", { text }),
  claudeSessionRespond: (requestId: string, response: ClaudeResponse) =>
    call<void>("claude_session_respond", { requestId, response }),
  claudeSessionInterrupt: () => call<void>("claude_session_interrupt"),
  claudeSessionStop: () => call<StopInfo>("claude_session_stop"),
  claudeSessionState: () => call<ClaudeSessionState>("claude_session_state"),
  /** 이 프로젝트의 마지막 세션 ID (이어 하기 가능한지) */
  claudeLastSession: (projectDir: string) => call<string | null>("claude_last_session", { projectDir }),
  claudeRawLog: () => call<RawLogEntry[]>("claude_raw_log"),
  onClaudeEvent,
};
