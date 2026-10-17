// IPC 가 주고받는 값의 모양과 오류 — Rust 쪽 (`src-tauri/src/error.rs`, `src-tauri/src/claude/events.rs`) 과 같이 맞춘다.
// 화면 코드는 `ipc.ts` 에서 가져온다 (거기서 다시 내보낸다). 이 파일은 `ipc.ts` 와 가짜 세션(`fakeClaude.ts`)이 함께 쓰려고 나눴다.

/** `src-tauri/src/error.rs` 의 `AppError::kind()` 와 같이 맞춘다. */
export type AppErrorKind =
  | "invalid_input"
  | "internal"
  | "claude_not_found"
  | "session_running"
  | "no_session"
  | "no_saved_session"
  | "request_not_found"
  | "turn_in_progress";

const APP_ERROR_KINDS: readonly AppErrorKind[] = [
  "invalid_input",
  "internal",
  "claude_not_found",
  "session_running",
  "no_session",
  "no_saved_session",
  "request_not_found",
  "turn_in_progress",
];

export class AppError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
  }
}

export interface AppInfo {
  name: string;
  version: string;
}

// ───────────────────────── Claude 연결 (P3) — `src-tauri/src/claude/events.rs` 와 같이 맞춘다 ─────────────────────────

/** 찾기 결과 (`claude_discover`) */
export interface ClaudeStatus {
  found: boolean;
  path: string | null;
  version: string | null;
  knownVersion: string;
  /** 확인된 CLI 버전과 같은가 (못 읽으면 null) */
  versionMatches: boolean | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  subscriptionType: string | null;
  apiKeyPresent: boolean;
  /** 확인 중 막힌 곳 (진단용): `version_failed` · `auth_failed` */
  problem: string | null;
}

/** 시작 요청. 실행 파일 · 인자를 고르는 칸은 없다 (Rust 가 찾은 claude 만, 인자는 Rust 가 만든다). */
export interface StartRequest {
  projectDir: string;
  /** `--model` (없으면 CLI 기본) */
  model?: string | null;
  /** 이 프로젝트의 마지막 세션을 이어 한다 */
  resume?: boolean;
  /** `ANTHROPIC_API_KEY` 를 CLI 에 넘긴다 (기본 안 넘김 — D-19) */
  useApiKey?: boolean;
}

export interface StartInfo {
  projectDir: string;
  pid: number;
  resumed: boolean;
  resumeSessionId: string | null;
  cliVersion: string | null;
}

export interface StopInfo {
  wasRunning: boolean;
  forced: boolean;
}

export type AlwaysScope = "suggested" | "folder" | "project";

/** "이 프로젝트에서 항상 허용" 때 CLI 가 settings.local.json 에 쓰게 될 규칙 (D-23) */
export interface AlwaysRule {
  /** 카드에 보일 규칙 글 (예: `Bash(mkdir probe-dir *)`, `Edit(/src/**)`) */
  rule: string;
  scope: AlwaysScope;
  /** `folder` 범위일 때 프로젝트 기준 폴더 */
  folder: string | null;
}

export interface PermissionRequestInfo {
  requestId: string;
  toolUseId: string | null;
  tool: string;
  displayName: string | null;
  description: string | null;
  /** 실행할 명령 (Bash) 또는 주소 (WebFetch) */
  command: string | null;
  /** 고칠 · 만들 파일 (Write · Edit …) */
  path: string | null;
  /** 어디에서 (프로젝트 폴더) */
  cwd: string;
  input: unknown;
  /** null 이면 "항상 허용" 을 보이지 않는다 */
  alwaysRule: AlwaysRule | null;
}

export interface QuestionOption {
  label: string;
  description: string | null;
  preview: string | null;
}

export interface QuestionInfo {
  /** 질문 문장 — 답의 열쇠가 된다 */
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface QuestionRequestInfo {
  requestId: string;
  toolUseId: string | null;
  questions: QuestionInfo[];
}

export type TurnOutcome = "success" | "interrupted" | "error" | "limit";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** 턴 끝. 사용량 · 비용은 이번 턴 몫 (D-24) */
export interface TurnSummary {
  outcome: TurnOutcome;
  subtype: string | null;
  isError: boolean;
  terminalReason: string | null;
  result: string | null;
  errors: string[];
  apiErrorStatus: number | null;
  durationMs: number | null;
  numTurns: number | null;
  usage: TokenUsage;
  /** 이번 턴 비용 */
  costUsd: number;
  /** 이 프로세스가 시작한 뒤 누적 */
  totalCostUsd: number;
}

export interface RawLogEntry {
  seq: number;
  /** send(앱→CLI) · recv(CLI→앱) · stderr · note */
  dir: "send" | "recv" | "stderr" | "note";
  text: string;
  truncated: boolean;
  originalLen: number;
  atMs: number;
}

/** 세션 관리자가 내보내는 이벤트 (`claude:session`). 필드는 `events.rs` 의 `SessionEvent`. */
export type ClaudeEvent =
  | { type: "session_started"; projectDir: string; pid: number; resumed: boolean; resumeSessionId: string | null; cliVersion: string | null }
  /** 막지 않고 알리기만 — `cli_version_mismatch` · `session_store_failed` · `write_failed` · `control_error` · `unknown_control_request` · `line_too_long` · `api_key_in_use` */
  | { type: "warning"; code: string; detail: string | null }
  | { type: "user_message"; text: string; deferred: boolean }
  | { type: "turn_started"; sessionId: string; model: string | null; cliVersion: string | null; permissionMode: string | null; apiKeySource: string | null }
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; tool: string; summary: string }
  | { type: "tool_result"; toolUseId: string; isError: boolean; summary: string }
  | ({ type: "permission_request" } & PermissionRequestInfo)
  | ({ type: "question_request" } & QuestionRequestInfo)
  | { type: "request_cancelled"; requestId: string }
  | ({ type: "turn_ended" } & TurnSummary)
  | {
      type: "rate_limit";
      status: string | null;
      rateLimitType: string | null;
      resetsAt: number | null;
      fiveHourUtilization: number | null;
      sevenDayUtilization: number | null;
    }
  | { type: "resume_not_found"; sessionId: string }
  | { type: "session_ended"; ended: "normal" | "died"; exitCode: number | null; forced: boolean; midTurn: boolean; stderrTail: string[] }
  | ({ type: "raw_log" } & RawLogEntry);

export type ClaudeEventType = ClaudeEvent["type"];

/** 질문 하나의 답: 고른 라벨 하나 · 여러 개 · 직접 쓴 글 */
export type AnswerValue = string | string[];

/** 기다리는 요청에 대한 사용자의 답 */
export type ClaudeResponse =
  | { kind: "allow" }
  /** 규칙은 요청의 `alwaysRule` — 화면이 정하지 않는다 */
  | { kind: "always_allow" }
  | { kind: "deny"; message?: string }
  /** 다르게 하라고 말하기 = 거부 + 그 턴 중단, 그 말을 새 사용자 메시지로 (D-44) */
  | { kind: "tell"; text: string }
  | { kind: "answer"; answers: Record<string, AnswerValue> };

export interface ClaudeSessionState {
  running: boolean;
  projectDir: string | null;
  pid: number | null;
  sessionId: string | null;
  /** 턴이 도는 중 */
  busy: boolean;
  /** 답을 기다리는 요청들 (`permission_request` · `question_request` 이벤트 모양) */
  pending: ClaudeEvent[];
}

/** `src-tauri/src/claude/commands.rs` 의 `SESSION_EVENT` */
export const CLAUDE_SESSION_EVENT = "claude:session";

function isAppErrorKind(value: unknown): value is AppErrorKind {
  return APP_ERROR_KINDS.some((kind) => kind === value);
}

/** invoke 가 거절한 값(`{ kind, message }`, 문자열, 그 밖)을 항상 `AppError` 로 바꾼다. */
export function toAppError(raw: unknown): AppError {
  if (raw instanceof AppError) {
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const { kind, message } = raw as { kind?: unknown; message?: unknown };
    if (isAppErrorKind(kind) && typeof message === "string") {
      return new AppError(kind, message);
    }
  }
  const message = raw instanceof Error ? raw.message : String(raw);
  return new AppError("internal", message);
}
