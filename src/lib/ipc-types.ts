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
  | "turn_in_progress"
  | "harness_busy"
  | "db_unavailable"
  | "db_read_only"
  | "project_not_found"
  | "no_folder_picked"
  | "folder_dialog_open"
  | "file_write_failed"
  | "project_folder_missing"
  | "project_folder_forbidden";

const APP_ERROR_KINDS: readonly AppErrorKind[] = [
  "invalid_input",
  "internal",
  "claude_not_found",
  "session_running",
  "no_session",
  "no_saved_session",
  "request_not_found",
  "turn_in_progress",
  "harness_busy",
  "db_unavailable",
  "db_read_only",
  "project_not_found",
  "no_folder_picked",
  "folder_dialog_open",
  "file_write_failed",
  "project_folder_missing",
  "project_folder_forbidden",
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
  /** 구독이 아닌 곳으로 인증 · 과금할 수 있는 다른 환경 변수의 **이름** (`ANTHROPIC_AUTH_TOKEN`, Bedrock · Vertex 등을 켜는 변수).
   *  값은 읽지 않고 설정은 그대로 CLI 에 넘긴다 — 알리기만 한다 (D-45) */
  otherBilling: string[];
  /** 확인 중 막힌 곳 (진단용): `version_failed` · `auth_failed` */
  problem: string | null;
}

/**
 * 시작 요청 (P6-02). **등록된 프로젝트 번호뿐이다** (D-47) — 폴더 경로 · 모델 · 수준 · 실행 파일 · 인자를 고르는 칸은 없다.
 * 폴더는 Rust 가 번호로 찾고(없어졌거나 고를 수 없는 폴더면 `project_folder_missing` · `project_folder_forbidden`),
 * 모델 · 수준은 Rust 가 하네스 `planner` 설정에서 읽는다.
 */
export interface StartRequest {
  projectId: number;
  /** 이 프로젝트의 마지막 세션을 이어 한다 */
  resume?: boolean;
  /** `ANTHROPIC_API_KEY` 를 CLI 에 넘긴다 (기본 안 넘김 — D-19) */
  useApiKey?: boolean;
}

export interface StartInfo {
  projectId: number;
  /** 보이기용 폴더 글자 */
  projectDir: string;
  pid: number;
  resumed: boolean;
  resumeSessionId: string | null;
  cliVersion: string | null;
  /** 실제로 `--model` 로 넘긴 값 (하네스 `planner` 설정). 넘기지 않았으면 null = CLI 기본 */
  model: string | null;
  /** 실제로 `--effort` 로 넘긴 값. 넘기지 않았으면 null = CLI 기본 */
  effort: string | null;
}

export interface StopInfo {
  wasRunning: boolean;
  forced: boolean;
}

/** `suggested` CLI 가 제안한 규칙 · `folder` 그 파일이 든 폴더 아래 전부 · `file` 프로젝트 맨 위 파일 하나. 프로젝트 전체를 여는 규칙은 없다 (D-45) */
export type AlwaysScope = "suggested" | "folder" | "file";

/** "이 프로젝트에서 항상 허용" 때 CLI 가 settings.local.json 에 쓰게 될 규칙 (D-23) */
export interface AlwaysRule {
  /** 카드에 보일 규칙 글 (예: `Bash(mkdir probe-dir *)`, `Edit(/src/**)`) */
  rule: string;
  scope: AlwaysScope;
  /** `folder` 범위일 때 프로젝트 기준 폴더 */
  folder: string | null;
}

/** 권한 · 질문 요청이 작업자(서브에이전트) 안에서 온 것일 때 어느 작업자인지 (P7-02). 없으면(`null`) 오케스트레이터(메인) 쪽 요청 */
export interface WorkerRef {
  /** CLI 가 준 작업자 ID (`worker_started.agentId` 와 같다) */
  agentId: string;
  /** 그 작업자를 부른 도구 호출의 ID — `worker_started.toolUseId` 와 같다. 시작 알림보다 요청이 먼저 왔으면 null */
  toolUseId: string | null;
  /** 작업자 이름 (`subagent_type`). 시작 알림보다 요청이 먼저 왔으면 null */
  name: string | null;
}

export interface PermissionRequestInfo {
  requestId: string;
  toolUseId: string | null;
  /** 작업자 안의 요청이면 그 작업자. Rust 는 항상 보낸다 (메인 쪽이면 null) — 옛 시험 자료를 위해 칸을 빼도 된다 */
  worker?: WorkerRef | null;
  tool: string;
  displayName: string | null;
  description: string | null;
  /** 실행할 명령 (Bash) 또는 주소 (WebFetch) */
  command: string | null;
  /** 고칠 · 만들 파일 (Write · Edit …) */
  path: string | null;
  /** 어디에서 (프로젝트 폴더) */
  cwd: string;
  /** 도구 입력 — **표시용 복사본** (긴 글 · 긴 목록은 잘려 있다). 허용하면 CLI 에는 Rust 가 쥔 원본이 돌아간다 */
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
  /** 작업자 안의 질문이면 그 작업자. Rust 는 항상 보낸다 (메인 쪽이면 null) */
  worker?: WorkerRef | null;
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

/** 작업자(서브에이전트) 하나가 어떻게 끝났나: `done` 마침 · `failed` 실패 · `stopped` 멈춤 (중단 · 세션이 끝나거나 죽음 · 끝 알림 없이 앱이 다시 켜짐) */
export type WorkerOutcome = "done" | "failed" | "stopped";

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
  | {
      type: "session_started";
      projectId: number;
      projectDir: string;
      pid: number;
      resumed: boolean;
      resumeSessionId: string | null;
      cliVersion: string | null;
      model: string | null;
      effort: string | null;
    }
  /** 막지 않고 알리기만 — `cli_version_mismatch` · `session_store_failed` · `write_failed` · `control_error` · `unknown_control_request` · `question_unreadable` · `duplicate_request` · `line_too_long` · `api_key_in_use`
   *  · `planner_config_missing` · `planner_config_unreadable` · `planner_model_unusable` · `planner_effort_unusable` (하네스 `planner` 설정을 못 읽거나 값이 이상해 그 값만 CLI 기본으로 띄움) · `project_touch_failed`
   *  · `history_write_failed` (채팅 기록 · 츄르를 앱 DB 에 못 씀 — 세션은 계속된다. `detail` 은 오류 종류. 쓰기가 계속 실패하는 동안은 한 번만)
   *  · `worker_limit` (작업자 200 개를 넘게 한꺼번에 일한다고 와서 새 시작은 무시함 — 한 세션에 한 번만) */
  | { type: "warning"; code: string; detail: string | null }
  | { type: "user_message"; text: string; deferred: boolean }
  | { type: "turn_started"; sessionId: string; model: string | null; cliVersion: string | null; permissionMode: string | null; apiKeySource: string | null }
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; tool: string; summary: string }
  /** 도구 결과. 실시간 이벤트는 결과 글(`summary`)을 가진다. **기록으로 저장된 실패한 결과는 `summary` 가 빈 글이다** (D-48 — 비밀값이 들어 있을 수 있어 글은 저장하지 않는다. "실패함" 표시와 `toolUseId` 만 남는다) */
  | { type: "tool_result"; toolUseId: string; isError: boolean; summary: string }
  /** 작업자(서브에이전트)가 일을 시작했다 (P7-02, D-49). 작업자 안쪽의 글 · 도구 줄은 `text` · `tool_use` · `tool_result` 로 오지 않는다. 지시 글(`prompt`)은 싣지 않는다 (D-48) */
  | {
      type: "worker_started";
      /** 작업자를 부른 도구 호출의 ID — 하는 일 · 끝 · 권한 요청의 `worker` 가 이 값으로 가리킨다 */
      toolUseId: string;
      /** CLI 가 준 작업자 ID */
      agentId: string | null;
      /** 작업자 이름 (`subagent_type` 그대로 — 이름 → 고양이 연결은 화면이 한다. 이름이 안 왔으면 `general-purpose`) */
      name: string;
      description: string | null;
      /** 백그라운드로 돈다. **부른 턴이 끝난 뒤에도 일할 수 있다** — 끝은 `worker_ended` 로만 안다 */
      background: boolean;
      /** 작업자 속 작업자의 깊이 (메인이 부르면 1) */
      depth: number;
      /** 앱이 받은 때 (유닉스 밀리초) */
      atMs: number;
    }
  /** 작업자가 지금 하는 일 — 마지막 도구와 한 줄 설명. 바뀔 때만 온다. 기록에는 저장하지 않는다 (실시간만) */
  | { type: "worker_activity"; toolUseId: string; tool: string | null; summary: string | null; toolUses: number | null }
  /** 작업자가 끝났다. 세션이 끝나거나 · 죽거나 · 중단되면 안 끝난 작업자마다 `stopped` 로 온다. 기록 목록에는 따로 나오지 않고 `worker_started` 항목의 `worker` 로 합쳐진다 */
  | { type: "worker_ended"; toolUseId: string; outcome: WorkerOutcome; atMs: number }
  | ({ type: "permission_request" } & PermissionRequestInfo)
  | ({ type: "question_request" } & QuestionRequestInfo)
  /** 사용자의 답이 CLI 로 전해졌다 — 실시간 화면과 채팅 기록이 같이 받는다. `text` 는 `deny` 의 이유 · `tell` 의 말, `answers` 는 `answer` 의 질문 문장 → 고른 것 · 쓴 글(다듬은 값) */
  | { type: "request_answered"; requestId: string; kind: ClaudeResponse["kind"]; text: string | null; answers: Record<string, AnswerValue> | null }
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
  projectId: number | null;
  projectDir: string | null;
  pid: number | null;
  sessionId: string | null;
  /** 턴이 도는 중 */
  busy: boolean;
  /** 답을 기다리는 요청들 (`permission_request` · `question_request` 이벤트 모양) */
  pending: ClaudeEvent[];
  /** 지금 일하는 작업자들 (`worker_started` 이벤트 모양 — 화면을 다시 열었을 때 일하는 고양이를 되살린다). Rust 는 항상 보낸다 — 옛 시험 자료를 위해 칸을 빼도 된다 */
  workers?: ClaudeEvent[];
}

// ───────────────────────── 채팅 기록 · 세션 츄르 (P6-03) — `src-tauri/src/history/` 와 같이 맞춘다 ─────────────────────────
// 기록은 앱이 받은 이벤트에서만 만든다 — 저장한 것은 화면으로 간 이벤트 그대로라서(긴 글만 잘림) 실시간 이벤트와 같은 모양으로 읽는다.
// 화면이 보내는 것은 프로젝트 번호와 쪽 나누기 값뿐이다 (경로 글자 없음 — D-47).

/** 채팅 기록 목록에 나오는 이벤트 종류. 답(`request_answered`) · 취소(`request_cancelled`)는 목록에 따로 나오지 않고 그 카드의 `request` 로 합쳐진다.
 *  저장하지 않는 것: `turn_started` · `warning` · `raw_log` · 성공한 `tool_result` · `allowed` 인 `rate_limit` */
export type ChatListEventType =
  | "session_started"
  | "user_message"
  | "text"
  | "tool_use"
  | "tool_result"
  | "permission_request"
  | "question_request"
  | "turn_ended"
  | "rate_limit"
  | "resume_not_found"
  | "worker_started"
  | "session_ended";

/** 기록의 권한 카드에는 도구 입력(`input` — 쓸 파일 내용 · 바꾸는 글)이 없다. 비밀값이 들어 있을 수 있어 저장하지 않는다 (2026-10-29 고객) */
export type StoredPermissionRequest = Omit<Extract<ClaudeEvent, { type: "permission_request" }>, "input">;

export type ChatListEvent =
  | Exclude<Extract<ClaudeEvent, { type: ChatListEventType }>, { type: "permission_request" }>
  | StoredPermissionRequest;

/** 요청 카드의 지금 상태: `answered` 답함(`answer` 에 답) · `cancelled` 취소됨(중단 · 세션 끝) · `pending` 지금 살아 있는 세션이 기다리는 중(답할 수 있다) · `expired` 답 없이 지나감(앱을 다시 켠 뒤라 답할 수 없다) */
export type ChatRequestStatus = "answered" | "cancelled" | "pending" | "expired";

/** 권한 · 질문 카드(`permission_request` · `question_request`)에 붙는 상태 */
export interface ChatRequestState {
  status: ChatRequestStatus;
  /** `answered` 일 때 사용자의 답 — `request_answered` 이벤트 모양 그대로 */
  answer: Extract<ClaudeEvent, { type: "request_answered" }> | null;
}

/** 작업자 상태: `running` 지금 살아 있는 세션이 일하는 중 · `done` · `failed` · `stopped` 멈춤 (중단 · 세션 끝 · 끝 알림 없이 앱이 다시 켜짐) */
export type ChatWorkerStatus = "running" | "done" | "failed" | "stopped";

/** 작업자 시작 항목(`worker_started`)에 붙는 상태 — 끝(`worker_ended`)은 여기로 합쳐진다 */
export interface ChatWorkerState {
  status: ChatWorkerStatus;
  /** 끝난 때(유닉스 밀리초) — 끝 알림이 온 것만. 일하는 중이거나 끝 알림이 없으면 null */
  endedAtMs: number | null;
}

/** 기록의 항목 하나 */
export interface ChatEntry {
  /** 순서 번호 — 클수록 나중. 다음 쪽을 읽을 때 `before` 로 쓴다 */
  id: number;
  /** 유닉스 시각(초) */
  at: number;
  /** CLI 세션 ID (모르면 null) */
  sessionId: string | null;
  /** 긴 글이 잘렸다 (글 끝에 `…`) */
  truncated: boolean;
  event: ChatListEvent;
  /** 권한 · 질문 카드에만, 나머지는 null */
  request: ChatRequestState | null;
  /** 작업자 시작 항목(`worker_started`)에만, 나머지는 null. Rust 는 항상 보낸다 — 옛 시험 자료를 위해 칸을 빼도 된다 */
  worker?: ChatWorkerState | null;
}

/** `project_chat_history` 의 결과 — 오래된 것이 앞 (이미 가진 것 위에 이어 붙인다) */
export interface ChatPage {
  entries: ChatEntry[];
  /** 이 쪽보다 오래된 항목이 더 있다 */
  hasMore: boolean;
}

/** 턴들의 합 (앱이 돌린 세션의 `result` 만 — CLI 기록 파일은 읽지 않는다, D-24) */
export interface UsageSum {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** 토큰 4종의 합 (화면의 "츄르 약 n") */
  totalTokens: number;
  /** 턴 비용의 합 (USD) */
  costUsd: number;
  /** 구독으로 돌린 턴 수 (`turn_started` 의 `apiKeySource` 가 `none`) */
  subscriptionTurns: number;
  /** 키로 과금된 턴 수 */
  apiKeyTurns: number;
  /** 비용을 "참고용 추정" 으로 보여야 한다 — 키로 과금된 것이 아닌 턴(구독 · 모름)이 하나라도 있다 */
  referenceOnly: boolean;
}

export interface ProjectUsage {
  projectId: number;
  /** 오늘(이 PC 의 자정부터) 이 프로젝트에서 쓴 합 */
  today: UsageSum;
  /** 지금까지 쓴 합 */
  total: UsageSum;
}

/** 지금 돌고 있는 세션 */
export interface SessionUsage {
  projectId: number;
  /** CLI 세션 ID (첫 턴이 시작되기 전에는 null) */
  sessionId: string | null;
  /** 이번 실행의 합 (이어 하기로 띄웠다면 앞 실행의 것은 빼고) */
  usage: UsageSum;
}

/** `app_usage_summary` 의 결과 */
export interface UsageSummary {
  /** "오늘" 의 시작 — 유닉스 시각(초), 이 PC 의 자정 */
  since: number;
  /** 오늘 앱이 쓴 합 (모든 프로젝트) */
  today: UsageSum;
  /** 쓴 적이 있는 프로젝트마다 (번호 순) */
  projects: ProjectUsage[];
  /** 지금 돌고 있는 세션 (없으면 null) */
  session: SessionUsage | null;
}

/** `project_chat_history` 가 한 번에 주는 항목 수의 상한 (더 크게 부르면 Rust 가 줄여 준다) */
export const CHAT_PAGE_MAX = 200;

// ───────────────────────── 하네스 설치 · 업데이트 (P4-02) — `src-tauri/src/harness/` 와 같이 맞춘다 ─────────────────────────
// 화면이 Rust 에 넘기는 값은 백업 번호 하나뿐이다 (실행 파일 · 인자 · 경로 · URL 을 넘기는 길은 없다).
// 코드 이름(`reason` · `problem` · `outcome`)은 진단용 짧은 이름이고, 화면이 문구를 고른다. 모르는 값은 글 그대로 보인다.

/** `~/.claude/harness` 가 가리키는 곳의 종류 (`locate.rs` 의 `OriginKind`) */
export type HarnessOriginKind = "none" | "repo" | "developer" | "unreadable";

export interface HarnessOrigin {
  kind: HarnessOriginKind;
  /** 가리키는 원본 폴더 (알 수 없으면 null) */
  path: string | null;
  /** `link` (링크 · 정션) · `copy` (복사 + 표시 파일) */
  marker: "link" | "copy" | null;
  /** `unreadable` 일 때: `link_broken` · `mark_broken` · `foreign` · `source_missing` · `script_missing` · `read_failed` */
  reason: string | null;
}

export interface GitInfo {
  found: boolean;
  path: string | null;
  version: string | null;
  /** `version_failed` */
  problem: string | null;
}

export interface GitBashInfo {
  /** 이 OS 에서 필요한가 (Windows 만) */
  required: boolean;
  found: boolean;
  path: string | null;
  /** `env` (`CLAUDE_CODE_GIT_BASH_PATH`) · `git` (git 설치 폴더) */
  source: "env" | "git" | null;
  /** `env_path_missing` */
  problem: string | null;
}

export interface HarnessRepoStatus {
  present: boolean;
  /** git 으로 확인한 결과: 우리 원본이다 (git 이 없거나 `repo` 가 없으면 null) */
  usable: boolean | null;
  /** `not_git_repo` · `remote_mismatch` · `check_failed` */
  problem: string | null;
  remote: string | null;
  head: string | null;
}

/** 상태 (`harness_status`) — 읽기만 한다 */
export interface HarnessStatus {
  /** 지금 쓰는 `~/.claude` (위치를 정하지 못했으면 null) */
  claudeDir: string | null;
  /** 지금 쓰는 하네스 폴더 */
  harnessHome: string | null;
  /** 환경 변수(`CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME`)로 정한 위치인가 — 아니면 기본 위치 = 실제 폴더 */
  claudeDirFromEnv: boolean;
  harnessHomeFromEnv: boolean;
  /** 이 PC 의 기본 위치(`~/.claude` · `~/.claude-harness`)와 같은 폴더인가 — 환경 변수로 정했어도 기본 위치를 가리키면 true (실제 폴더) */
  claudeDirIsDefault: boolean;
  harnessHomeIsDefault: boolean;
  /** 위치를 정하지 못한 이유: `no_home` · `config_dir_not_absolute` · `harness_home_not_absolute` */
  problem: string | null;
  repoDir: string | null;
  repo: HarnessRepoStatus | null;
  origin: HarnessOrigin;
  /** 개발자 모드 — 다른 원본을 쓰는 중이라 받기 · 업데이트를 하지 않는다 */
  developerMode: boolean;
  /** 스크립트를 돌릴 원본 폴더 (개발자 원본 또는 `repo`) */
  sourceDir: string | null;
  /** 돌릴 설치 스크립트 (파일이 있을 때만) */
  scriptPath: string | null;
  /** 원본이 네트워크 공유(UNC `\\서버\공유`)에 있다 — WSL(`\\wsl.localhost\…`)은 아니다. 막지는 않고 알린다 */
  sourceIsNetwork: boolean;
  git: GitInfo;
  gitBash: GitBashInfo;
  /** 백업을 몇 개 남기는가 */
  keepBackups: number;
}

/** 받기 · 업데이트 확인 · 업데이트 받기의 결과 종류 (`git.rs` 의 `GitOutcome`) */
export type GitOutcome =
  | "cloned"
  | "already_present"
  | "checked"
  | "updated"
  | "up_to_date"
  | "refused"
  | "developer_mode"
  | "git_missing"
  | "repo_missing"
  | "repo_unusable"
  | "failed"
  | "timed_out";

export type UpdateState = "up_to_date" | "behind" | "ahead" | "diverged" | "detached" | "no_upstream";

export interface HarnessCommit {
  hash: string;
  date: string;
  subject: string;
}

export interface HarnessFileChange {
  /** git 의 한 글자 상태: `A` 새로 · `M` 바뀜 · `D` 지워짐 · `T` 종류 바뀜 */
  status: string;
  path: string;
}

export interface UpdatePreview {
  branch: string | null;
  upstream: string | null;
  /** 확인한 그때 따라가는 원격 브랜치의 전체 해시 — 받기는 이 커밋까지만 받는다 (확인 뒤 원본에 생긴 새 커밋은 받지 않는다) */
  upstreamHash: string | null;
  state: UpdateState;
  ahead: number;
  behind: number;
  /** 로컬 변경(추적하는 파일)이 있다 */
  dirty: boolean;
  commits: HarnessCommit[];
  commitsTotal: number;
  files: HarnessFileChange[];
  filesTotal: number;
  /** 받기 단추를 켤 수 있다 (받을 커밋이 있고 로컬 변경이 없다) */
  canPull: boolean;
}

export interface GitResult {
  outcome: GitOutcome;
  /** 거절 · 쓸 수 없음의 이유: `check_first` · `dirty` · `diverged` · `ahead` · `detached_head` · `no_upstream` · `not_fast_forward` · `not_git_repo` · `remote_mismatch` */
  reason: string | null;
  /** git 의 끝부분 몇 줄 · 다른 원격 주소 (주소의 계정 정보는 지웠다) */
  detail: string | null;
  /** 지금 `repo` 의 짧은 해시 */
  head: string | null;
  /** 받기 전의 짧은 해시 (업데이트 받기) */
  before: string | null;
  /** 업데이트 확인의 목록 */
  update: UpdatePreview | null;
  /** 업데이트 받기가 실제로 받은 커밋 (받기 전 HEAD..새 HEAD, 최신이 먼저, 상한 있음) */
  pulled: HarnessCommit[];
  /** 실제로 받은 커밋의 전체 수 (`pulled` 는 상한까지만) */
  pulledTotal: number;
}

// 설치 스크립트 JSON (약속 문서 `shared/app-contract.md` 버전 1, 2-3절) — 모르는 코드는 글 그대로 온다

export interface HarnessChange {
  path: string;
  /** `add` · `change` · `remove` · `skip` */
  action: string;
  /** `file` · `link` */
  type: string;
  reason: string | null;
}

export interface HarnessCounts {
  add: number;
  change: number;
  remove: number;
  skip: number;
  same: number;
}

export interface HarnessCustomItem {
  path: string;
  /** `values` · `append` · `replace` · `new` · `config` */
  kind: string;
  originChanged: boolean | null;
}

export interface HarnessOriginChanged {
  path: string;
  recorded: string | null;
  current: string | null;
}

export interface HarnessProblem {
  path: string | null;
  reason: string;
  detail: string | null;
}

export interface HarnessBackupRef {
  id: string;
  dir: string | null;
  files: number;
}

export interface HarnessBackupInfo {
  id: string;
  createdAt: string | null;
  command: string | null;
  added: number;
  changed: number;
  removed: number;
  files: number;
  bytes: number;
  readable: boolean;
}

export interface HarnessErrorInfo {
  code: string;
  detail: string | null;
}

export interface HarnessReport {
  contract: number;
  /** `install` · `backups` · `restore` */
  command: string;
  ok: boolean;
  exitCode: number;
  dryRun: boolean;
  claudeDir: string | null;
  harnessHome: string | null;
  repo: string | null;
  /** `link` · `copy` */
  mode: string | null;
  developerMode: boolean;
  existingSource: string | null;
  restartNeeded: boolean;
  custom: { dir: string | null; items: HarnessCustomItem[] } | null;
  changes: HarnessChange[];
  counts: HarnessCounts;
  same: boolean;
  originChanged: HarnessOriginChanged[];
  problems: HarnessProblem[];
  warnings: HarnessProblem[];
  backup: HarnessBackupRef | null;
  backups: HarnessBackupInfo[];
  originHash: unknown;
  rolledBack: boolean | null;
  error: HarnessErrorInfo | null;
}

/** 스크립트를 돌린 결과 종류 (`script.rs` 의 `ScriptOutcome`) */
export type ScriptOutcome = "ran" | "unreadable" | "no_script" | "refused" | "timed_out" | "spawn_failed";

/** 읽을 수 없는 이유 (`script.rs` 의 `UnreadableReason`) */
export type UnreadableReason = "no_json" | "bad_json" | "unknown_contract" | "bad_shape" | "unexpected_command";

export interface HarnessUnreadable {
  reason: UnreadableReason;
  /** JSON 의 `contract` 값 (있으면, 글로) */
  contract: string | null;
  /** 표준 출력 앞부분 */
  head: string;
  /** 표준 오류 앞부분 */
  stderrHead: string;
}

/** 설치 뒤 백업 정리 결과 */
export interface HarnessPrune {
  removed: number;
  kept: number;
  removedIds: string[];
  /** 번호 모양이지만 링크 · 정션이거나 폴더가 아니라서 건너뛴 이름 */
  skippedEntries: string[];
  /** 지우려다 실패한 번호 */
  failed: string[];
  /** 정리를 아예 하지 않은 이유: `backups_is_link` · `read_failed` · `locked` (설치 스크립트의 잠금이 남아 있다) */
  skipped: string | null;
}

export interface ScriptResult {
  outcome: ScriptOutcome;
  /** 프로세스 종료 코드 */
  exitCode: number | null;
  report: HarnessReport | null;
  /** 읽은 JSON 한 줄 (원문 보기용) */
  raw: string | null;
  unreadable: HarnessUnreadable | null;
  /** 쓰는 중 실패(종료 코드 3) · 시간 초과 · 결과를 알 수 없음(설치 · 되돌리기) — 백업에서 되돌리기를 권한다 */
  restoreAdvised: boolean;
  /** 돌린 스크립트 */
  script: string | null;
  /** 설치 뒤 백업 정리 결과 (설치만) */
  prune: HarnessPrune | null;
  detail: string | null;
  /** `refused` 의 이유: `plan_first` (미리보기를 본 적 없음) · `source_changed` (미리보기 뒤 원본이 바뀜) */
  reason: string | null;
}

// ───────────────────────── 에이전트 · 사용량 (P5-01) — `src-tauri/src/agents/` · `src-tauri/src/usage/` 와 같이 맞춘다 ─────────────────────────

/** 역할 (`agents/mod.rs` 의 `AgentRole`). 고양이 ↔ 역할 대응은 `src/assets/cats/agent-cats.json` (키가 이 역할 이름) */
export type AgentRole = "main" | "designer" | "ui" | "system" | "tester" | "helper" | "reviewer";

/** 읽은 에이전트 한 명 */
export interface AgentInfo {
  /** 하네스 역할 (하네스 작업자가 아니면 null) */
  role: AgentRole | null;
  /** 파일 이름 (경로 아님). 오케스트레이터는 파일이 없어 null */
  file: string | null;
  name: string;
  description: string | null;
  model: string | null;
  effort: string | null;
  color: string | null;
  /** `disallowedTools` 로 `Write` · `Edit` 를 모두 못 쓰게 했다 (감사관) */
  readOnly: boolean;
}

/** 읽을 수 없는 이유 (`agents/mod.rs` 의 `UnreadableReason`) */
export type AgentUnreadableReason =
  | "too_large"
  | "read_failed"
  | "not_utf8"
  | "no_frontmatter"
  | "unclosed_frontmatter"
  | "missing_name"
  | "name_mismatch"
  | "missing_description";

/** 읽을 수 없는 에이전트 파일 — 그 항목만, 나머지는 그대로 */
export interface AgentUnreadable {
  /** 설정이 이 파일을 작업자로 가리키면 그 역할 */
  role: AgentRole | null;
  file: string;
  reason: AgentUnreadableReason;
}

export type AgentEntry = ({ state: "ok" } & AgentInfo) | ({ state: "unreadable" } & AgentUnreadable);

/** 목록 전체의 상태: `no_harness` 는 하네스가 설치되지 않음 (빈 목록), `location_unusable` 은 설정 폴더 위치를 정할 수 없음 */
export type AgentsState = "ok" | "no_harness" | "location_unusable";

/** 어느 설정을 읽었나 — `unreadable` 이면 오케스트레이터의 모델 · 수준과 작업자 역할을 알 수 없다 */
export type AgentsConfigState = "local" | "example" | "none" | "unreadable";

/** `agents_list` 의 결과 — 오류가 아니라 상태다 (깨진 파일 · 설정 · 하네스 없음도 결과로 온다) */
export interface AgentsList {
  state: AgentsState;
  config: AgentsConfigState;
  /** 오케스트레이터(`role: "main"`)가 맨 앞, 그 뒤는 파일 이름 순 */
  agents: AgentEntry[];
  /** 설정이 작업자로 정했는데 파일이 없는 역할 */
  missingRoles: AgentRole[];
}

// ───────────────────────── 스킬 목록 (P6-02) — `src-tauri/src/skills/` 와 같이 맞춘다 ─────────────────────────
// 채팅 입력줄이 고를 스킬. 스킬은 채팅의 첫 메시지로 보낸다 (`command` 글 + 인자, 예: `/desktop-app requirements.md`).

/** 누가 설치한 스킬인가: `harness` 하네스가 설치한 것 · `mine` 내가 만든 것 */
export type SkillOrigin = "harness" | "mine";

/** 읽은 스킬 하나 */
export interface SkillInfo {
  /** 폴더 이름 = 이름 */
  name: string;
  /** 채팅 첫 메시지에 쓰는 글 (`/<name>`) */
  command: string;
  description: string | null;
  /** 인자 안내 (예: `[요구사항.md 경로]`) */
  argumentHint: string | null;
  origin: SkillOrigin;
  /** 사용자가 부를 수 있는가 (`user-invocable: false` 면 false — 입력줄 목록에서는 뺀다) */
  userInvocable: boolean;
}

/** 읽을 수 없는 이유 (`skills/mod.rs` 의 `UnreadableReason`) */
export type SkillUnreadableReason =
  | "too_large"
  | "read_failed"
  | "not_utf8"
  | "no_frontmatter"
  | "unclosed_frontmatter"
  | "name_mismatch"
  | "invalid_name";

/** 읽을 수 없는 스킬 폴더 — 그 항목만, 나머지는 그대로 */
export interface SkillUnreadable {
  /** 폴더 이름 (경로 아님) */
  folder: string;
  origin: SkillOrigin;
  reason: SkillUnreadableReason;
}

export type SkillEntry = ({ state: "ok" } & SkillInfo) | ({ state: "unreadable" } & SkillUnreadable);

/** 목록 전체의 상태: `no_harness` 는 하네스가 설치되지 않음 (빈 목록), `location_unusable` 은 설정 폴더 위치를 정할 수 없음 */
export type SkillsState = "ok" | "no_harness" | "location_unusable";

/** `skills_list` 의 결과 — 오류가 아니라 상태다 (깨진 파일 · 하네스 없음도 결과로 온다) */
export interface SkillsList {
  state: SkillsState;
  /** 폴더 이름 순 */
  skills: SkillEntry[];
}

/** 한 한도 창 (5시간 · 7일) — 돌아가는 세션의 `rate_limit` 이벤트와 같은 뜻 · 단위 */
export interface UsageWindow {
  /** 사용률 0~1 (100% 를 넘기면 1 보다 클 수 있다) */
  utilization: number;
  /** 초기화 시각 (유닉스 초). 모르면 null */
  resetsAt: number | null;
  /** 서버가 매긴 정도 (`normal` · `warning` · `critical` …, 글 그대로) */
  severity: string | null;
}

/** 모델 · 표면별 주간 한도 */
export interface UsageScopedWindow {
  /** 서버가 준 이름 (예: 모델 이름) */
  label: string;
  utilization: number;
  resetsAt: number | null;
  severity: string | null;
}

/** 못 받는 이유 (`usage/mod.rs` 의 `UnavailableReason`) */
export type UsageUnavailableReason = "not_subscription" | "not_logged_in" | "no_claude" | "not_supported" | "timeout" | "failed";

/** `usage_read` 의 결과 — 못 받아도 오류가 아니라 `unavailable` 과 이유 */
export type UsageResult =
  | {
      state: "ok";
      fiveHour: UsageWindow | null;
      sevenDay: UsageWindow | null;
      scoped: UsageScopedWindow[];
      /** 추가 사용(초과 요금)을 켰는가 (금액은 읽지 않는다) */
      extraUsageEnabled: boolean | null;
      /** 읽은 때 (유닉스 초). Rust 가 기억한 값이면 처음 읽은 때 */
      readAt: number;
    }
  | { state: "unavailable"; reason: UsageUnavailableReason };

// ───────────────────────── 프로젝트 (P6-01) — `src-tauri/src/projects/` 와 같이 맞춘다 ─────────────────────────
// 화면은 **경로 글자를 보내지 않는다** (D-47): 폴더는 Rust 가 대화상자로 받아 들고 있고, 나머지 명령은 등록된 프로젝트 번호(`id`)로만 부른다.

/** 프로젝트에 붙이는 하네스 스킬 (없음 = `null`). `src-tauri/src/projects/mod.rs` 의 `Skill` */
export type ProjectSkill = "/desktop-app" | "/web-full" | "/web-lite";

/** 폴더가 지금 있는가 — `ok` 있음 · `missing` 없음(옮겼거나 지움) · `unknown` 제때 알 수 없음(느린 네트워크 드라이브 · 권한) */
export type ProjectFolderState = "ok" | "missing" | "unknown";

/** 폴더를 살펴본 결과 (파일 내용은 읽지 않는다): `hasHarness` 하네스 문서가 있음 · `hasRequirements` 루트에 requirements.md 가 있음 · `fresh` 아무것도 없음 */
export type ProjectFolderFinding = "fresh" | "hasRequirements" | "hasHarness";

/** 목록의 한 항목 (`projects_list` · `project_add` · `project_update`) */
export interface ProjectEntry {
  id: number;
  /** 사람에게 보이는 폴더 경로 */
  path: string;
  name: string;
  skill: ProjectSkill | null;
  /** 유닉스 시각(초) */
  createdAt: number;
  lastOpenedAt: number;
  folder: ProjectFolderState;
  /** 폴더가 `ok` 일 때만 */
  finding: ProjectFolderFinding | null;
}

/** `ok` 읽고 쓴다 · `read_only` 이 앱보다 새 버전의 DB 라 읽기만 한다 (고치기 · 등록 · 빼기는 `db_read_only` 로 거절) */
export type ProjectDbMode = "ok" | "read_only";

/** `projects_list` 의 결과 — 최근에 연 순서 */
export interface ProjectList {
  db: ProjectDbMode;
  projects: ProjectEntry[];
}

/** 프로젝트로 고를 수 없는 이유 — 드라이브 뿌리 · 홈 폴더 자체 · `~/.claude` · `~/.claude-harness` · 앱 데이터 폴더(와 그 안) */
export type ProjectForbiddenReason = "drive_root" | "home" | "claude_dir" | "harness_home" | "app_data";

export interface ProjectPickedOk {
  path: string;
  /** 기본 프로젝트 이름 (폴더 이름) */
  name: string;
  /** 제때 못 봤으면 null */
  finding: ProjectFolderFinding | null;
  /** 이미 등록된 폴더면 그 프로젝트 번호 */
  existingId: number | null;
}

export interface ProjectPickedForbidden {
  path: string;
  reason: ProjectForbiddenReason;
}

/** `project_pick_folder` 의 결과 (취소는 `null`). `ok` 인 폴더는 Rust 가 들고 있다가 `project_add` 때 그것만 등록한다 */
export type ProjectPickedFolder = ({ state: "ok" } & ProjectPickedOk) | ({ state: "forbidden" } & ProjectPickedForbidden);

/** `project_add` 의 입력 — 폴더 경로는 없다. 이름을 안 주면 폴더 이름 */
export interface ProjectAddRequest {
  name?: string;
  skill?: ProjectSkill | null;
}

/** `project_update` 의 입력 — 고칠 것만. `skill: null` 은 "스킬 없음으로", 아예 빼면 그대로 */
export interface ProjectPatch {
  name?: string;
  skill?: ProjectSkill | null;
}

/** 프로젝트 이름 길이 제한 (글자 수) — Rust 의 `NAME_MAX_CHARS` */
export const PROJECT_NAME_MAX_CHARS = 80;

/** `requirements.md` 를 읽을 수 없는(쓸 수 없는) 이유 */
export type RequirementsProblem = "not_utf8" | "too_large" | "outside_folder" | "link" | "folder_missing" | "not_a_file" | "read_failed";

export interface RequirementsText {
  /** BOM 을 뗀 글 (줄바꿈은 그대로) */
  text: string;
  /** 내용이 같으면 같은 값. 쓸 때 `baseVersion` 으로 돌려준다 */
  version: string;
  /** 파일 앞에 BOM 이 있었다 (쓸 때 Rust 가 되살린다) */
  hasBom: boolean;
}

/** `project_requirements_read` */
export type RequirementsRead = ({ state: "ok" } & RequirementsText) | { state: "absent" } | { state: "unreadable"; reason: RequirementsProblem };

/** `project_requirements_version` — 창 포커스 · 몇 초마다 물어 바깥(터미널) 변경을 안다 */
export type RequirementsVersion = { state: "ok"; version: string } | { state: "absent" } | { state: "unreadable"; reason: RequirementsProblem };

/** `project_requirements_write` — 그 사이 파일이 바뀌었으면 쓰지 않고 `conflict` (파일이 없어졌으면 `version: null`). 못 쓰는 파일이면 `refused`. 디스크 · 권한 문제는 `file_write_failed` 오류 */
export type RequirementsWrite =
  | { state: "ok"; version: string }
  | { state: "conflict"; version: string | null }
  | { state: "refused"; reason: RequirementsProblem };

// ── 프로젝트 문서 읽기 (P7-01, D-49) — 모두 읽기 전용. 하네스 문서는 약속(`app-contract.md` §6)대로 읽고, 형식이 깨져도 오류가 아니라 결과의 `unreadable`(이유 포함)이다 ──

/** 하네스 문서(단계 표 · 이어 하기 메모)를 읽을 수 없는 이유. 앞 일곱은 `RequirementsProblem` 과 같다 — 뒤 넷은 글 모양: `no_section` 찾는 `## 절` 제목이 없음 · `no_table` 절에 표가 없음 · `header_mismatch` 표 머리 줄이 약속과 다름 · `no_item` 절에서 읽을 글이 없음 */
export type ProgressReason = RequirementsProblem | "no_section" | "no_table" | "header_mismatch" | "no_item";

/** 단계 상태: 빈 칸 `todo` · `완료` 로 시작 `done` · `진행 중` 으로 시작 `now` · 그 밖 `unknown` (글은 `statusText`) */
export type PlanPhaseStatus = "done" | "now" | "todo" | "unknown";

export interface PlanPhase {
  /** `P0`, `P1` … */
  id: string;
  /** 내용 칸 */
  summary: string;
  /** 담당 칸: `→` 로 차례, `·` 로 함께 (`system → tester` = `[["system"],["tester"]]`). 낱말은 `designer` · `ui` · `system` · `tester` · `helper` · `reviewer` · `직접`, 모르는 말은 글 그대로 */
  owners: string[][];
  /** 담당 칸의 원래 글 */
  ownersText: string;
  /** 승인 게이트 칸 */
  gate: string;
  status: PlanPhaseStatus;
  /** 상태 칸의 원래 글 (`**` 뗌) */
  statusText: string;
  /** `## P<n>. 이름` 절의 이름 (절이 없으면 null) */
  name: string | null;
  /** 그 절의 `- 목표:` 한 줄 (없으면 null) */
  goal: string | null;
}

export interface PlanInfo {
  phases: PlanPhase[];
}

/** `## 지금 상태` 의 값: 약속 낱말(`작업자 일하는 중` · `검수 중` · `사용자 답 기다림` · `실행 확인 기다림` · `단계 사이`)로 시작하면 그 상태, 아니면 `unknown` */
export type HandoffNowState = "working" | "reviewing" | "waiting_answer" | "waiting_run" | "between" | "unknown";

export interface HandoffNow {
  state: HandoffNowState;
  /** 그 줄의 글 (`**` 뗌) */
  text: string;
}

/** 작업(지시서) 상태: `맡김` → `돌아옴` → `검수 통과` / `다시 맡김`. 앞의 `<n>차 ` 는 떼고 읽는다. 그 밖은 `unknown` (글은 `statusText`) */
export type HandoffTaskStatus = "assigned" | "back" | "passed" | "redo" | "unknown";

export interface HandoffTaskProgress {
  done: number;
  total: number;
}

export interface HandoffTask {
  /** 지시서 칸의 글 (경로가 아니어도 그대로 — `(P2-01 ~ P2-03 검수 통과 — 지시서 끝)`) */
  label: string;
  /** `briefs/<이름>.md` 모양일 때만 (아니면 null) */
  brief: string | null;
  /** 파일 이름 앞부분 (`P7-01`) */
  id: string | null;
  /** 그 앞부분의 단계 (`P7`) */
  phase: string | null;
  /** 담당 칸의 글 (`system` …) */
  owner: string;
  status: HandoffTaskStatus;
  /** 상태 칸의 원래 글 (`**` 뗌) */
  statusText: string;
  /** 지시서의 `- [x]` 수 / 전체. 지시서가 없거나 못 읽었거나 끝난 작업(`검수 통과` — 읽지 않는다)이면 null */
  progress: HandoffTaskProgress | null;
}

/** 이어 하기 메모의 한 절 — 읽었으면 `value`, 못 읽었으면 `reason` (다른 절은 그대로 읽힌다) */
export type ProgressSection<T> = { state: "ok"; value: T } | { state: "unreadable"; reason: ProgressReason };

export interface HandoffInfo {
  /** 머리 목록 `- 스킬:` · `- 요구사항:` · `- 지금 단계:` · `- 마지막 갱신:` 의 값 (첫 줄만, 없으면 null) */
  skill: string | null;
  requirements: string | null;
  phase: string | null;
  updated: string | null;
  /** `## 지금 상태` */
  current: ProgressSection<HandoffNow>;
  /** `## 진행 중인 작업` */
  tasks: ProgressSection<HandoffTask[]>;
  /** `## 사용자에게 기다리는 것` (`없음` 이면 빈 목록) */
  waiting: ProgressSection<string[]>;
  /** `## 다음 할 일` */
  next: ProgressSection<string[]>;
}

/** `plan` — 파일이 없으면 `absent` (아직 하네스 전) */
export type PlanRead = ({ state: "ok" } & PlanInfo) | { state: "absent" } | { state: "unreadable"; reason: ProgressReason };

/** `handoff` */
export type HandoffRead = ({ state: "ok" } & HandoffInfo) | { state: "absent" } | { state: "unreadable"; reason: ProgressReason };

/** `project_progress_read` — `version` 은 읽기 전에 만든 값 (`project_progress_version` 과 같은 식) */
export interface ProgressRead {
  version: string;
  plan: PlanRead;
  handoff: HandoffRead;
}

export interface DocFile {
  /** `docsDir` 안 상대 경로 (`/` 구분) — `project_doc_read` 에 그대로 보낸다 */
  path: string;
  size: number;
  /** 수정 시각 (유닉스 초). 모르면 null */
  modified: number | null;
}

export interface DocsListing {
  /** 하네스 설정의 `docsDir` (기본 `docs`) */
  docsDir: string;
  /** 경로 순 (대소문자 가리지 않음) */
  files: DocFile[];
  /** 목록이 다 담기지 않았다 (파일 2000개 · 폴더 8단 · 살펴본 항목 20000개 상한, 읽을 수 없던 폴더) */
  truncated: boolean;
}

/** `project_docs_list` — `absent` 는 docs 폴더가 없음 */
export type DocsList = ({ state: "ok" } & DocsListing) | { state: "absent" } | { state: "unreadable"; reason: RequirementsProblem };

export interface DocText {
  /** BOM 을 뗀 글 (줄바꿈 그대로) */
  text: string;
  version: string;
}

/** `project_doc_read` — 경로 모양이 틀리면 결과가 아니라 `invalid_input` 오류. 실제 경로가 `docsDir` 밖이면 `unreadable` + `outside_folder` */
export type DocRead = ({ state: "ok" } & DocText) | { state: "absent" } | { state: "unreadable"; reason: RequirementsProblem };

/** `src-tauri/src/claude/commands.rs` 의 `SESSION_EVENT` */
export const CLAUDE_SESSION_EVENT = "claude:session";

/** `src-tauri/src/tray.rs` 의 `WINDOW_SHOWN_EVENT` — 숨어 있던(또는 최소화였던) 창이 열렸다 (D-50 · D-25). 앱이 처음 뜰 때는 오지 않는다 */
export const WINDOW_SHOWN_EVENT = "app:window-shown";

/** 창을 연 까닭 — `tray`: 트레이 아이콘을 눌렀다 · `tray_menu`: 트레이 메뉴의 열기 · `second_instance`: 앱을 한 번 더 실행했다 */
export const WINDOW_SHOWN_REASONS = ["tray", "tray_menu", "second_instance"] as const;
export type WindowShownReason = (typeof WINDOW_SHOWN_REASONS)[number];

/** `WINDOW_SHOWN_EVENT` 의 내용 (`src-tauri/src/tray.rs` 의 `WindowShown`) */
export interface WindowShownEvent {
  reason: WindowShownReason;
}

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

// ───────────────────────── 내 수정 (P9-01, D-51) — `src-tauri/src/custom/model.rs` 와 같이 맞춘다 ─────────────────────────
// 화면이 보내는 것은 항목 id · 값 · 글 · 새 항목 요청 · 커밋 번호 · 에이전트 이름 · 고양이 id 뿐이다 — 경로 · 파일 이름을 보내는 길은 없다.
// 화면으로 오는 파일 이름(`file` · `path`)은 표시용 상대 경로(`agents/x.md`)이고 다시 보내지 않는다.
// 상태 때문에 안 되는 일은 오류(`AppError`)가 아니라 결과의 `outcome` · `reason` 이다. 오류는 보낸 값의 모양이 틀렸을 때(`invalid_input`) · 파일을 쓰지 못했을 때(`file_write_failed`) ·
// 다른 하네스 일이 도는 중일 때(`harness_busy`) 등이다.

/** `main` 오케스트레이터 (하네스 설정 `planner`) · `agent` 에이전트 · `skill` 스킬 */
export type CustomItemKind = "main" | "agent" | "skill";

/** 이 파일에 내가 한 것 — 값 바꿈 · 덧붙임 · 통째 · 내가 만든 것 (값과 덧붙임은 함께일 수 있다) */
export type CustomMark = "values" | "append" | "replace" | "mine";

/** 항목을 읽을 수 없는 이유 (D-22 — 그 항목만 "읽을 수 없음") */
export type CustomUnreadableReason =
  | "too_large"
  | "read_failed"
  | "not_utf8"
  | "no_frontmatter"
  | "unclosed_frontmatter"
  | "name_mismatch"
  | "bad_values"
  | "bad_origin"
  | "link_in_custom"
  | "target_gone"
  | "bad_config";

/** 고를 수 있는 모델 · 수준 (`src-tauri/src/custom/values.rs` 의 `MODELS` · `EFFORTS` 와 같다 — 나중에 늘릴 수 있다) */
export const CUSTOM_MODELS = ["opus", "sonnet", "haiku"] as const;
export const CUSTOM_EFFORTS = ["low", "medium", "high"] as const;
/** 글 파일 하나의 최대 크기 (`fsx::TEXT_MAX_BYTES`) — 넘으면 `too_large` */
export const CUSTOM_TEXT_MAX_BYTES = 256 * 1024;
/** 새로 만들 때 소개 글의 최대 글자 수 (`write::DESCRIPTION_MAX_CHARS`) */
export const CUSTOM_DESCRIPTION_MAX_CHARS = 300;
/** 적용 메시지(한 줄 요약)의 최대 글자 수 (`history::MESSAGE_MAX_CHARS`) — 넘으면 Rust 가 자른다 */
export const CUSTOM_MESSAGE_MAX_CHARS = 200;
/** 이름 · 고양이 id 모양 (`id.rs`) — 틀리면 `invalid_input` */
export const CUSTOM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const CUSTOM_CAT_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** 보이는 이름의 최대 글자 수 — 앞뒤 공백을 뗀 뒤 문자 수 (`labels::LABEL_MAX_CHARS`). 넘으면 `bad_label` */
export const CUSTOM_LABEL_MAX_CHARS = 20;
/** 고양이 여러 줄 한 번에 쓰기의 줄 수 상한 (`cats::CHANGES_MAX`) — 넘으면 `invalid_input` */
export const CUSTOM_CATS_CHANGES_MAX = 64;

/** 목록의 항목 하나 (읽을 수 있는 것) */
export interface CustomItemInfo {
  /** `main` · `agent:<이름>` · `skill:<이름>` — 화면이 다시 보내는 것은 이것뿐이다 */
  id: string;
  kind: CustomItemKind;
  name: string;
  description: string | null;
  /** 표시용 상대 파일 이름 (오케스트레이터는 `config.local.json`) — 다시 보내지 않는다 */
  file: string;
  /** 원본 값 (없으면 null). 내가 만든 것은 그 파일 자신의 앞머리 값 */
  model: string | null;
  effort: string | null;
  /** 내 값 (`values.yml` 의 것 · 오케스트레이터는 설정의 `planner` 중 원본과 다른 것) */
  myModel: string | null;
  myEffort: string | null;
  /** 지금 쓰이는 값 (내 값 → 원본 값) */
  currentModel: string | null;
  currentEffort: string | null;
  marks: CustomMark[];
  /** 통째 바꾼(`.origin` 이 있는) 것만: true (원본 해시가 다름 · 원본에서 사라짐) · false · null (`.origin` 없음) */
  originChanged: boolean | null;
}

/** 목록의 읽을 수 없는 항목 */
export interface CustomItemUnreadable {
  id: string;
  kind: CustomItemKind;
  name: string;
  file: string;
  reason: CustomUnreadableReason;
}

export type CustomListEntry = ({ state: "ok" } & CustomItemInfo) | ({ state: "unreadable" } & CustomItemUnreadable);

/** 기록(로컬 git)의 상태 — `no_git`: 이 PC 에 git 이 없다 (저장 · 적용은 되고 기록만 없다) · `not_started`: 아직 시작 전 (처음 저장할 때 시작) · `failed`: git 을 부르지 못했다 */
export type CustomHistoryState = "ok" | "no_git" | "not_started" | "failed";

export interface CustomHistoryInfo {
  state: CustomHistoryState;
  detail: string | null;
}

export type CustomFileStatus = "added" | "changed" | "removed";

export interface CustomUnappliedFile {
  /** 내 수정 폴더 기준 상대 경로 (표시용) */
  path: string;
  status: CustomFileStatus;
}

/** 적용 안 한 것 = 커밋 안 된 변경 (새 파일 포함). `known: false` 는 git 이 없거나 못 불러서 모른다 (적용은 늘 설치만 한다) */
export interface CustomUnapplied {
  known: boolean;
  count: number;
  /** 앞 200개까지 */
  files: CustomUnappliedFile[];
}

export interface CustomList {
  /** 원본 폴더가 있는가 — 없으면 false + `reason: "no_source"` (오류 아님, 목록은 비었다) */
  available: boolean;
  reason: string | null;
  developerMode: boolean;
  history: CustomHistoryInfo;
  unapplied: CustomUnapplied;
  /** 오케스트레이터가 맨 앞, 그 뒤는 에이전트 · 스킬 (이름 순) */
  items: CustomListEntry[];
  /** 하네스 작업자 이름 → 역할 — 설치 스크립트와 같은 순서로 찾은 설정의 `agents` (하네스를 설치하기 전에도 있다) */
  roles: Record<string, AgentRole>;
}

/** 글 한 덩이 (원본 글 · 덧붙임 글 · 통째 글) */
export type CustomTextPart =
  | { state: "absent" }
  | { state: "text"; text: string }
  | { state: "too_large" }
  | { state: "unreadable"; reason: CustomUnreadableReason };

/** 항목 하나 읽기 — 비교(원본 글 ↔ 내 통째 글)는 화면이 두 글로 한다 */
export interface CustomItemDetail {
  info: CustomItemInfo;
  /** 원본 글 (읽기 전용). 오케스트레이터 · 내가 만든 것은 없다 */
  originText: CustomTextPart;
  /** 덧붙임 글 */
  appendText: CustomTextPart;
  /** 통째 글 — 원본을 통째로 바꿨으면 그 글, 내가 만든 것이면 그 파일의 글 */
  replaceText: CustomTextPart;
  /** 원본에서 파일이 사라졌다 (`.origin` 만 남음) */
  originGone: boolean;
  /** 원본과 내 글이 둘 다 있는데 원본과 견줘 본 기록(`.origin`)이 없다 — 내가 만든 이름이 원본 업데이트로 새로 생겼다 (원본 바뀜 탭이 문구를 바꾼다) */
  originUnrecorded: boolean;
}

export type CustomItemRead = ({ state: "ok" } & CustomItemDetail) | ({ state: "unreadable" } & CustomItemUnreadable) | { state: "not_found" };

/** 값 바꾸기 요청 — 바라는 값 **전체** (null = 원본 값으로 = 그 키를 지운다). 목록 밖 값은 `invalid_input` (이미 파일에 든 값을 그대로 돌려보내는 것은 받는다) */
export interface CustomValues {
  model: string | null;
  effort: string | null;
}

/** 새 에이전트 · 스킬 만들기 요청 — 종류 · 이름 · 소개(한 줄) · 모델 · 수준(선택) */
export interface CustomNewItem {
  kind: "agent" | "skill";
  name: string;
  description: string;
  model?: string | null;
  effort?: string | null;
}

export type CustomWriteOutcome = "saved" | "refused";

/**
 * 저장 · 지움 · 새로 만들기 · 원본 바뀜 고르기의 결과. `refused` 의 `reason`:
 * `no_source` (원본이 없다) · `not_found` · `link_in_path` · `too_large` · `not_utf8` · `unreadable` · `bad_values` (값 파일이 설치가 받아들이는 모양이 아니다) · `bad_config` ·
 * `bad_frontmatter` · `invalid_agent` (둘째 줄 `name` 이 다름 · `hooks:` 가 있음 · 스킬 `name` 이 폴더 이름과 다름) · `name_in_source` (원본에 같은 이름) · `name_taken` (내 수정에 이미 있음) ·
 * `not_mine` · `not_replaced` · `already_replaced` · `not_supported` (오케스트레이터 · 내가 만든 것의 덧붙임 …) · `no_origin` (원본에서 사라져 "원본으로" 가 없다)
 */
export interface CustomWriteResult {
  outcome: CustomWriteOutcome;
  reason: string | null;
  detail: string | null;
  /** 실제로 파일이 바뀌었는가 */
  changed: boolean;
  /** 새로 만들기: `~/.claude` 에 사용자 자신의 같은 이름 파일이 이미 있다 (설치가 건너뛴다) */
  notOurs: boolean;
}

/** 줄 하나의 차이 — `" "` 그대로 · `"+"` 더함 · `"-"` 뺌 · `"@"` 위치 표시 */
export interface CustomDiffLine {
  sign: " " | "+" | "-" | "@";
  text: string;
  /** 옛 파일 · 새 파일 줄 번호 */
  old?: number;
  new?: number;
}

export interface CustomFileDiff {
  path: string;
  status: CustomFileStatus;
  /** 글이 아니라서 · 너무 커서 줄 차이를 못 준다 */
  binary: boolean;
  lines: CustomDiffLine[];
  /** 줄 수 상한 때문에 뒤를 잘랐다 */
  truncated: boolean;
  /** 더한 줄 · 뺀 줄 수 (잘리기 전의 전체) */
  added: number;
  removed: number;
}

/** 적용하면 바뀌는 것 (적용 안 한 것의 줄 단위 차이) */
export interface CustomChanges {
  state: CustomHistoryState;
  detail: string | null;
  files: CustomFileDiff[];
  /** 파일 수 상한 때문에 뒤를 빼면 `files.length` 보다 크다 */
  filesTotal: number;
}

/** 커밋 종류 — 커밋 메시지 끝 표시 줄로 알아본다. `new`: 새 에이전트 · 스킬이 든 적용 · `cats`: 고양이 연결 · `labels`: 보이는 이름 · `other`: 앱이 만들지 않은 커밋 */
export type CustomCommitKind = "apply" | "new" | "restore" | "origin_update" | "cats" | "labels" | "start" | "other";

export interface CustomCommit {
  /** 전체 번호 (40글자) — 화면은 이것이나 `short` 를 다시 보낸다 */
  hash: string;
  /** 짧은 번호 (7글자) */
  short: string;
  /** 커밋한 때 (ISO 8601, 시간대 포함) */
  date: string;
  /** 메시지 첫 줄 */
  message: string;
  kind: CustomCommitKind;
  /** 바뀐 파일 (앞 50개까지) */
  files: string[];
  filesTotal: number;
}

/** 기록 목록 — 최신이 먼저, 최근 200개까지 (`truncated`: 더 있다) */
export interface CustomHistory {
  state: CustomHistoryState;
  detail: string | null;
  commits: CustomCommit[];
  truncated: boolean;
}

export type CustomCommitDiff =
  | { state: "ok"; commit: CustomCommit; files: CustomFileDiff[]; filesTotal: number }
  | { state: "unknown_commit" }
  | { state: "no_git" }
  | { state: "not_started" }
  | { state: "failed"; detail: string };

export type CustomDiscardOutcome = "discarded" | "nothing" | "no_git" | "not_started";

export interface CustomDiscardResult {
  outcome: CustomDiscardOutcome;
  /** 버린 파일 수 */
  files: number;
}

/** 적용(또는 되돌리기)의 기록(커밋) 쪽 결과 — `committed` 커밋을 만들었다 · `no_git` git 이 없어 기록하지 않았다 (설치는 됐다) · `failed` 설치는 됐는데 커밋하지 못했다 (적용 안 한 것으로 남는다) · `skipped` 설치하지 않아서 커밋도 없다 */
export type CustomCommitOutcome = "committed" | "no_git" | "failed" | "skipped";

export type CustomApplyOutcome = "applied" | "nothing" | "failed";

/** 적용 결과 — `failed` 면 `script`(설치 결과 그대로)로 이유를 보이고, 커밋하지 않았다 (적용 안 한 것으로 남는다) */
export interface CustomApplyResult {
  outcome: CustomApplyOutcome;
  /** 설치를 돌렸으면 그 결과 (`ipc.harnessInstall` 과 같은 모양) */
  script: ScriptResult | null;
  commit: CustomCommitOutcome;
  /** 만든 커밋의 짧은 번호 */
  commitShort: string | null;
  /** 적용한(하려던) 파일 수 */
  files: number;
  detail: string | null;
}

/** 어느 때로 되돌리기 결과 — `has_unapplied`: 적용 안 한 것이 있어 하지 않았다 (먼저 적용하거나 버린다) · `same_as_now`: 그 모습이 지금과 같다 · `rollback_failed`: 설치가 실패했는데 되돌려 놓지도 못했다 */
export type CustomRestoreOutcome = "restored" | "has_unapplied" | "unknown_commit" | "same_as_now" | "no_git" | "not_started" | "failed" | "rollback_failed";

export interface CustomRestoreResult {
  outcome: CustomRestoreOutcome;
  script: ScriptResult | null;
  commit: CustomCommitOutcome;
  commitShort: string | null;
  detail: string | null;
}

/** `absent`: `custom/agent-cats.json` 이 아직 없다 (화면 기본 연결을 쓴다) · `unreadable`: 있는데 읽을 수 없다 */
export type CustomCatsState = "ok" | "absent" | "unreadable";

/** 고양이 연결 — 키 = 에이전트 이름(또는 `main`), 값 = 고양이 id. 파일에 적힌 것만 (기본 연결은 화면이 안다) */
export interface CustomCats {
  state: CustomCatsState;
  agents: Record<string, string>;
}

/** 고양이 쓰기 결과 — 그 파일만 바로 커밋한다 (다른 적용 안 한 것은 그대로). `refused` 의 `reason`: `unreadable` · `too_large` · `link_in_path` · `bad_label` (보이는 이름 쓰기만) */
export interface CustomCatsWriteResult {
  outcome: CustomWriteOutcome;
  reason: string | null;
  changed: boolean;
  commit: CustomCommitOutcome;
  commitShort: string | null;
  detail: string | null;
}

/** 고양이 여러 줄 쓰기의 한 줄 — `cat` 은 꼭 적는다 (`null` = 지움). 한 번에 1~64 줄, 같은 `agent` 는 한 번만 */
export interface CustomCatChange {
  agent: string;
  cat: string | null;
}

/** 보이는 이름 — 직접 만든 에이전트의 화면 이름 (`custom/agent-labels.json`). 키 = 에이전트 이름, 값 = 보이는 이름 (앞뒤 공백 없음 · 1~20 글자). `state` 는 고양이 연결과 같다 */
export interface CustomLabels {
  state: CustomCatsState;
  agents: Record<string, string>;
}

/** 보이는 이름 쓰기 결과 — 고양이 쓰기 결과와 같은 모양. 이름이 규칙(앞뒤 공백을 뗀 뒤 1~20 글자, 줄바꿈 · 탭 · 제어 문자 없음)에 어긋나면 `refused` + `bad_label` */
export type CustomLabelWriteResult = CustomCatsWriteResult;
