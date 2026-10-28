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
  | "harness_busy";

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
  /** 막지 않고 알리기만 — `cli_version_mismatch` · `session_store_failed` · `write_failed` · `control_error` · `unknown_control_request` · `question_unreadable` · `duplicate_request` · `line_too_long` · `api_key_in_use` */
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
