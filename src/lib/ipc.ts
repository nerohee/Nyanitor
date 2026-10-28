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
  type AgentsList,
  type AppInfo,
  type ClaudeEvent,
  type ClaudeResponse,
  type ClaudeSessionState,
  type ClaudeStatus,
  type GitResult,
  type HarnessStatus,
  type RawLogEntry,
  type ScriptResult,
  type StartInfo,
  type StartRequest,
  type StopInfo,
  type UsageResult,
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

  // 하네스 설치 · 업데이트 (P4-02). 넘기는 값은 백업 번호 하나뿐 — 실행 파일 · 인자 · 경로 · URL 을 넘기는 길은 없다.
  /** 위치 · 원본(개발자 모드) · 받은 원본 · git · Git Bash. 읽기만 한다 */
  harnessStatus: () => call<HarnessStatus>("harness_status"),
  /** 하네스 원본 받기 (`repo` 가 없을 때만) */
  harnessClone: () => call<GitResult>("harness_clone"),
  /** 업데이트 확인 — 받을 커밋 · 바뀔 파일 미리보기. 본 커밋을 앱(Rust)이 기억한다 */
  harnessUpdateCheck: () => call<GitResult>("harness_update_check"),
  /** 업데이트 받기 — 확인 때 본 커밋까지만 빨리 감기로 (확인이 없으면 `refused` · `check_first`) */
  harnessUpdatePull: () => call<GitResult>("harness_update_pull"),
  /** 설치 미리보기 — 아무것도 쓰지 않는다. 돌린 원본을 앱(Rust)이 기억한다 */
  harnessInstallPlan: () => call<ScriptResult>("harness_install_plan"),
  /** 설치 (미리보기를 본 그 원본으로만 — 아니면 `refused` · `plan_first` · `source_changed`) */
  harnessInstall: () => call<ScriptResult>("harness_install"),
  /** 백업 목록 */
  harnessBackups: () => call<ScriptResult>("harness_backups"),
  /** 되돌리기 미리보기 — 아무것도 쓰지 않는다 */
  harnessRestorePlan: (backupId: string) => call<ScriptResult>("harness_restore_plan", { backupId }),
  /** 되돌리기 (같은 번호의 되돌리기 미리보기를 본 뒤에만) */
  harnessRestore: (backupId: string) => call<ScriptResult>("harness_restore", { backupId }),

  // 고양이 집 (P5-01). 넘기는 값이 없다 — 경로 · 파일 이름 · 실행 파일 · 인자를 넘기는 길은 없다.
  /** 설치된 에이전트 목록 — 오케스트레이터 + `<설정 폴더>/agents/*.md` 앞머리. 깨진 파일 · 설정 · 하네스 없음은 오류가 아니라 결과의 상태다 */
  agentsList: () => call<AgentsList>("agents_list"),
  /** 구독 사용량 한도 (5시간 · 7일 · 초기화 시각) — 짧은 별도 세션으로 읽고 잠깐 기억한다. 못 받아도 오류가 아니라 `unavailable` 과 이유 */
  usageRead: () => call<UsageResult>("usage_read"),
};
