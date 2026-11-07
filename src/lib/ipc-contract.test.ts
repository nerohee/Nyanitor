// Rust 와 화면이 같은 목록을 쓰는지 지키는 시험 (P3-03) — 한쪽만 늘면 여기서 실패한다.
// Rust 쪽 목록은 소스 파일 글을 읽어(`?raw`) 뽑는다. 읽는 모양이 바뀌면 이 시험이 먼저 "못 찾음" 으로 실패한다.
import agentsConfigRs from "../../src-tauri/src/agents/config.rs?raw";
import agentsRs from "../../src-tauri/src/agents/mod.rs?raw";
import errorRs from "../../src-tauri/src/error.rs?raw";
import eventsRs from "../../src-tauri/src/claude/events.rs?raw";
import harnessBackupsRs from "../../src-tauri/src/harness/backups.rs?raw";
import harnessFlowRs from "../../src-tauri/src/harness/flow.rs?raw";
import harnessGitRs from "../../src-tauri/src/harness/git.rs?raw";
import harnessLocateRs from "../../src-tauri/src/harness/locate.rs?raw";
import harnessScriptRs from "../../src-tauri/src/harness/script.rs?raw";
import harnessStatusRs from "../../src-tauri/src/harness/status.rs?raw";
import historyChatRs from "../../src-tauri/src/history/chat.rs?raw";
import historyModRs from "../../src-tauri/src/history/mod.rs?raw";
import historyRecordRs from "../../src-tauri/src/history/record.rs?raw";
import historyUsageRs from "../../src-tauri/src/history/usage.rs?raw";
import historyWriterRs from "../../src-tauri/src/history/writer.rs?raw";
import projectsDocsRs from "../../src-tauri/src/projects/docs.rs?raw";
import projectsFolderRs from "../../src-tauri/src/projects/folder.rs?raw";
import projectsRs from "../../src-tauri/src/projects/mod.rs?raw";
import projectsProgressRs from "../../src-tauri/src/projects/progress.rs?raw";
import projectsRequirementsRs from "../../src-tauri/src/projects/requirements.rs?raw";
import skillsRs from "../../src-tauri/src/skills/mod.rs?raw";
import usageRs from "../../src-tauri/src/usage/mod.rs?raw";
import { describe, expect, it } from "vitest";
import { isTextKey } from "../i18n/ko";
import {
  AppError,
  toAppError,
  type AgentInfo,
  type AgentRole,
  type AgentUnreadable,
  type AgentUnreadableReason,
  type AgentsConfigState,
  type AgentsList,
  type AgentsState,
  type AlwaysScope,
  type AppErrorKind,
  type ChatEntry,
  type ChatListEventType,
  type ChatPage,
  type ChatRequestState,
  type ChatRequestStatus,
  type ChatWorkerState,
  type ChatWorkerStatus,
  type ClaudeEventType,
  type ClaudeResponse,
  type ClaudeSessionState,
  type GitBashInfo,
  type GitInfo,
  type GitOutcome,
  type GitResult,
  type HarnessBackupInfo,
  type HarnessBackupRef,
  type HarnessChange,
  type HarnessCommit,
  type HarnessCounts,
  type HarnessCustomItem,
  type HarnessErrorInfo,
  type HarnessFileChange,
  type HarnessOrigin,
  type HarnessOriginChanged,
  type HarnessOriginKind,
  type HarnessProblem,
  type HarnessPrune,
  type HarnessReport,
  type HarnessRepoStatus,
  type HarnessStatus,
  type HarnessUnreadable,
  type ProjectAddRequest,
  type ProjectDbMode,
  type ProjectEntry,
  type ProjectFolderFinding,
  type ProjectFolderState,
  type ProjectForbiddenReason,
  type ProjectList,
  type ProjectPatch,
  type ProjectPickedForbidden,
  type ProjectPickedFolder,
  type ProjectPickedOk,
  type ProjectSkill,
  type ProjectUsage,
  type RequirementsProblem,
  type RequirementsRead,
  type RequirementsText,
  type RequirementsVersion,
  type RequirementsWrite,
  type ScriptResult,
  type SessionUsage,
  type SkillInfo,
  type SkillOrigin,
  type SkillUnreadable,
  type SkillUnreadableReason,
  type SkillsList,
  type SkillsState,
  type StartInfo,
  type StartRequest,
  type UpdatePreview,
  type ScriptOutcome,
  type TurnOutcome,
  type WorkerOutcome,
  type WorkerRef,
  type DocFile,
  type DocRead,
  type DocsList,
  type DocsListing,
  type DocText,
  type HandoffInfo,
  type HandoffNow,
  type HandoffNowState,
  type HandoffRead,
  type HandoffTask,
  type HandoffTaskProgress,
  type HandoffTaskStatus,
  type PlanInfo,
  type PlanPhase,
  type PlanPhaseStatus,
  type PlanRead,
  type ProgressRead,
  type ProgressReason,
  type ProgressSection,
  type UnreadableReason,
  type UpdateState,
  type UsageResult,
  type UsageScopedWindow,
  type UsageSum,
  type UsageSummary,
  type UsageUnavailableReason,
  type UsageWindow,
} from "./ipc";

// 아래 `Record<…, true>` 는 TS 쪽에서 종류가 하나 늘면 컴파일(`tsc`)이 실패하게 하는 장치다.
const TS_ERROR_KINDS: Record<AppErrorKind, true> = {
  invalid_input: true,
  internal: true,
  claude_not_found: true,
  session_running: true,
  no_session: true,
  no_saved_session: true,
  request_not_found: true,
  turn_in_progress: true,
  harness_busy: true,
  db_unavailable: true,
  db_read_only: true,
  project_not_found: true,
  no_folder_picked: true,
  folder_dialog_open: true,
  file_write_failed: true,
  project_folder_missing: true,
  project_folder_forbidden: true,
};

const TS_EVENT_TYPES: Record<ClaudeEventType, true> = {
  session_started: true,
  warning: true,
  user_message: true,
  turn_started: true,
  text: true,
  tool_use: true,
  tool_result: true,
  worker_started: true,
  worker_activity: true,
  worker_ended: true,
  permission_request: true,
  question_request: true,
  request_answered: true,
  request_cancelled: true,
  turn_ended: true,
  rate_limit: true,
  resume_not_found: true,
  session_ended: true,
  raw_log: true,
};

const TS_RESPONSE_KINDS: Record<ClaudeResponse["kind"], true> = {
  allow: true,
  always_allow: true,
  deny: true,
  tell: true,
  answer: true,
};

const TS_OUTCOMES: Record<TurnOutcome, true> = { success: true, interrupted: true, error: true, limit: true };
const TS_SCOPES: Record<AlwaysScope, true> = { suggested: true, folder: true, file: true };

// 하네스 (P4-02) — 화면 쪽에서 종류가 하나 늘면 컴파일이 실패하고, Rust 쪽에서 늘면 아래 시험이 실패한다.
const TS_GIT_OUTCOMES: Record<GitOutcome, true> = {
  cloned: true,
  already_present: true,
  checked: true,
  updated: true,
  up_to_date: true,
  refused: true,
  developer_mode: true,
  git_missing: true,
  repo_missing: true,
  repo_unusable: true,
  failed: true,
  timed_out: true,
};
const TS_UPDATE_STATES: Record<UpdateState, true> = {
  up_to_date: true,
  behind: true,
  ahead: true,
  diverged: true,
  detached: true,
  no_upstream: true,
};
const TS_ORIGIN_KINDS: Record<HarnessOriginKind, true> = { none: true, repo: true, developer: true, unreadable: true };
const TS_SCRIPT_OUTCOMES: Record<ScriptOutcome, true> = {
  ran: true,
  unreadable: true,
  no_script: true,
  refused: true,
  timed_out: true,
  spawn_failed: true,
};
const TS_UNREADABLE: Record<UnreadableReason, true> = {
  no_json: true,
  bad_json: true,
  unknown_contract: true,
  bad_shape: true,
  unexpected_command: true,
};

// 하네스 결과의 필드 이름 — 화면 타입과 Rust 구조체(serde camelCase)가 같은 키를 쓰는지. 한쪽만 늘면 컴파일 또는 아래 시험이 실패한다.
const TS_FIELDS = {
  HarnessStatus: { claudeDir: 1, harnessHome: 1, claudeDirFromEnv: 1, harnessHomeFromEnv: 1, claudeDirIsDefault: 1, harnessHomeIsDefault: 1, problem: 1, repoDir: 1, repo: 1, origin: 1, developerMode: 1, sourceDir: 1, scriptPath: 1, sourceIsNetwork: 1, git: 1, gitBash: 1, keepBackups: 1 } satisfies Record<keyof HarnessStatus, 1>,
  RepoStatus: { present: 1, usable: 1, problem: 1, remote: 1, head: 1 } satisfies Record<keyof HarnessRepoStatus, 1>,
  Origin: { kind: 1, path: 1, marker: 1, reason: 1 } satisfies Record<keyof HarnessOrigin, 1>,
  GitInfo: { found: 1, path: 1, version: 1, problem: 1 } satisfies Record<keyof GitInfo, 1>,
  GitBashInfo: { required: 1, found: 1, path: 1, source: 1, problem: 1 } satisfies Record<keyof GitBashInfo, 1>,
  GitResult: { outcome: 1, reason: 1, detail: 1, head: 1, before: 1, update: 1, pulled: 1, pulledTotal: 1 } satisfies Record<keyof GitResult, 1>,
  UpdatePreview: { branch: 1, upstream: 1, upstreamHash: 1, state: 1, ahead: 1, behind: 1, dirty: 1, commits: 1, commitsTotal: 1, files: 1, filesTotal: 1, canPull: 1 } satisfies Record<keyof UpdatePreview, 1>,
  CommitInfo: { hash: 1, date: 1, subject: 1 } satisfies Record<keyof HarnessCommit, 1>,
  FileChange: { status: 1, path: 1 } satisfies Record<keyof HarnessFileChange, 1>,
  ScriptResult: { outcome: 1, exitCode: 1, report: 1, raw: 1, unreadable: 1, restoreAdvised: 1, script: 1, prune: 1, detail: 1, reason: 1 } satisfies Record<keyof ScriptResult, 1>,
  Report: { contract: 1, command: 1, ok: 1, exitCode: 1, dryRun: 1, claudeDir: 1, harnessHome: 1, repo: 1, mode: 1, developerMode: 1, existingSource: 1, restartNeeded: 1, custom: 1, changes: 1, counts: 1, same: 1, originChanged: 1, problems: 1, warnings: 1, backup: 1, backups: 1, originHash: 1, rolledBack: 1, error: 1 } satisfies Record<keyof HarnessReport, 1>,
  CustomItem: { path: 1, kind: 1, originChanged: 1 } satisfies Record<keyof HarnessCustomItem, 1>,
  Change: { path: 1, action: 1, type: 1, reason: 1 } satisfies Record<keyof HarnessChange, 1>,
  Counts: { add: 1, change: 1, remove: 1, skip: 1, same: 1 } satisfies Record<keyof HarnessCounts, 1>,
  OriginChanged: { path: 1, recorded: 1, current: 1 } satisfies Record<keyof HarnessOriginChanged, 1>,
  Problem: { path: 1, reason: 1, detail: 1 } satisfies Record<keyof HarnessProblem, 1>,
  BackupRef: { id: 1, dir: 1, files: 1 } satisfies Record<keyof HarnessBackupRef, 1>,
  BackupInfo: { id: 1, createdAt: 1, command: 1, added: 1, changed: 1, removed: 1, files: 1, bytes: 1, readable: 1 } satisfies Record<keyof HarnessBackupInfo, 1>,
  ErrorInfo: { code: 1, detail: 1 } satisfies Record<keyof HarnessErrorInfo, 1>,
  Unreadable: { reason: 1, contract: 1, head: 1, stderrHead: 1 } satisfies Record<keyof HarnessUnreadable, 1>,
  PruneResult: { removed: 1, kept: 1, removedIds: 1, skippedEntries: 1, failed: 1, skipped: 1 } satisfies Record<keyof HarnessPrune, 1>,
};

// 에이전트 · 사용량 (P5-01) — 화면 쪽에서 종류가 하나 늘면 컴파일이 실패하고, Rust 쪽에서 늘면 아래 시험이 실패한다.
const TS_AGENT_ROLES: Record<AgentRole, true> = { main: true, designer: true, ui: true, system: true, tester: true, helper: true, reviewer: true };
const TS_AGENT_UNREADABLE: Record<AgentUnreadableReason, true> = {
  too_large: true,
  read_failed: true,
  not_utf8: true,
  no_frontmatter: true,
  unclosed_frontmatter: true,
  missing_name: true,
  name_mismatch: true,
  missing_description: true,
};
const TS_AGENTS_STATES: Record<AgentsState, true> = { ok: true, no_harness: true, location_unusable: true };
const TS_AGENTS_CONFIG_STATES: Record<AgentsConfigState, true> = { local: true, example: true, none: true, unreadable: true };
const TS_USAGE_REASONS: Record<UsageUnavailableReason, true> = {
  not_subscription: true,
  not_logged_in: true,
  no_claude: true,
  not_supported: true,
  timeout: true,
  failed: true,
};
const TS_USAGE_STATES: Record<UsageResult["state"], true> = { ok: true, unavailable: true };
type UsageOk = Extract<UsageResult, { state: "ok" }>;

const TS_HOUSE_FIELDS = {
  AgentInfo: { role: 1, file: 1, name: 1, description: 1, model: 1, effort: 1, color: 1, readOnly: 1 } satisfies Record<keyof AgentInfo, 1>,
  AgentUnreadable: { role: 1, file: 1, reason: 1 } satisfies Record<keyof AgentUnreadable, 1>,
  AgentsList: { state: 1, config: 1, agents: 1, missingRoles: 1 } satisfies Record<keyof AgentsList, 1>,
  UsageWindow: { utilization: 1, resetsAt: 1, severity: 1 } satisfies Record<keyof UsageWindow, 1>,
  ScopedWindow: { label: 1, utilization: 1, resetsAt: 1, severity: 1 } satisfies Record<keyof UsageScopedWindow, 1>,
  // 태그(`state`)는 serde 가 붙이므로 구조체 필드가 아니다
  UsageReading: { fiveHour: 1, sevenDay: 1, scoped: 1, extraUsageEnabled: 1, readAt: 1 } satisfies Record<Exclude<keyof UsageOk, "state">, 1>,
};

// 프로젝트 등록 · requirements.md (P6-01) — 화면 쪽에서 종류가 하나 늘면 컴파일이 실패하고, Rust 쪽에서 늘면 아래 시험이 실패한다.
const TS_PROJECT_SKILLS: Record<ProjectSkill, true> = { "/desktop-app": true, "/web-full": true, "/web-lite": true };
const TS_FOLDER_STATES: Record<ProjectFolderState, true> = { ok: true, missing: true, unknown: true };
const TS_FOLDER_FINDINGS: Record<ProjectFolderFinding, true> = { fresh: true, hasRequirements: true, hasHarness: true };
const TS_FORBIDDEN_REASONS: Record<ProjectForbiddenReason, true> = { drive_root: true, home: true, claude_dir: true, harness_home: true, app_data: true };
const TS_DB_MODES: Record<ProjectDbMode, true> = { ok: true, read_only: true };
const TS_REQUIREMENTS_PROBLEMS: Record<RequirementsProblem, true> = {
  not_utf8: true,
  too_large: true,
  outside_folder: true,
  link: true,
  folder_missing: true,
  not_a_file: true,
  read_failed: true,
};
const TS_PICKED_STATES: Record<ProjectPickedFolder["state"], true> = { ok: true, forbidden: true };
const TS_READ_STATES: Record<RequirementsRead["state"], true> = { ok: true, absent: true, unreadable: true };
const TS_VERSION_STATES: Record<RequirementsVersion["state"], true> = { ok: true, absent: true, unreadable: true };
const TS_WRITE_STATES: Record<RequirementsWrite["state"], true> = { ok: true, conflict: true, refused: true };

// 태그(`state`)는 serde 가 붙이므로 구조체 필드가 아니다
const TS_PROJECT_FIELDS = {
  ProjectEntry: { id: 1, path: 1, name: 1, skill: 1, createdAt: 1, lastOpenedAt: 1, folder: 1, finding: 1 } satisfies Record<keyof ProjectEntry, 1>,
  ProjectList: { db: 1, projects: 1 } satisfies Record<keyof ProjectList, 1>,
  PickedOk: { path: 1, name: 1, finding: 1, existingId: 1 } satisfies Record<keyof ProjectPickedOk, 1>,
  PickedForbidden: { path: 1, reason: 1 } satisfies Record<keyof ProjectPickedForbidden, 1>,
  AddRequest: { name: 1, skill: 1 } satisfies Record<keyof ProjectAddRequest, 1>,
  ProjectPatch: { name: 1, skill: 1 } satisfies Record<keyof ProjectPatch, 1>,
  TextRead: { text: 1, version: 1, hasBom: 1 } satisfies Record<keyof RequirementsText, 1>,
  ProblemInfo: { reason: 1 } satisfies Record<Exclude<keyof Extract<RequirementsRead, { state: "unreadable" }>, "state">, 1>,
  VersionInfo: { version: 1 } satisfies Record<Exclude<keyof Extract<RequirementsVersion, { state: "ok" }>, "state">, 1>,
  ConflictInfo: { version: 1 } satisfies Record<Exclude<keyof Extract<RequirementsWrite, { state: "conflict" }>, "state">, 1>,
};

// 프로젝트 문서 읽기 (P7-01) — 화면 쪽에서 종류가 하나 늘면 컴파일이 실패하고, Rust 쪽에서 늘면 아래 시험이 실패한다.
const TS_PROGRESS_REASONS: Record<ProgressReason, true> = {
  not_utf8: true,
  too_large: true,
  outside_folder: true,
  link: true,
  folder_missing: true,
  not_a_file: true,
  read_failed: true,
  no_section: true,
  no_table: true,
  header_mismatch: true,
  no_item: true,
};
const TS_PHASE_STATUSES: Record<PlanPhaseStatus, true> = { done: true, now: true, todo: true, unknown: true };
const TS_NOW_STATES: Record<HandoffNowState, true> = { working: true, reviewing: true, waiting_answer: true, waiting_run: true, between: true, unknown: true };
const TS_TASK_STATUSES: Record<HandoffTaskStatus, true> = { assigned: true, back: true, passed: true, redo: true, unknown: true };
const TS_SECTION_STATES: Record<ProgressSection<unknown>["state"], true> = { ok: true, unreadable: true };
const TS_PLAN_STATES: Record<PlanRead["state"], true> = { ok: true, absent: true, unreadable: true };
const TS_HANDOFF_STATES: Record<HandoffRead["state"], true> = { ok: true, absent: true, unreadable: true };
const TS_DOCS_LIST_STATES: Record<DocsList["state"], true> = { ok: true, absent: true, unreadable: true };
const TS_DOC_READ_STATES: Record<DocRead["state"], true> = { ok: true, absent: true, unreadable: true };
const TS_PROGRESS_FIELDS = {
  PhaseInfo: { id: 1, summary: 1, owners: 1, ownersText: 1, gate: 1, status: 1, statusText: 1, name: 1, goal: 1 } satisfies Record<keyof PlanPhase, 1>,
  PlanInfo: { phases: 1 } satisfies Record<keyof PlanInfo, 1>,
  NowInfo: { state: 1, text: 1 } satisfies Record<keyof HandoffNow, 1>,
  TaskProgress: { done: 1, total: 1 } satisfies Record<keyof HandoffTaskProgress, 1>,
  TaskInfo: { label: 1, brief: 1, id: 1, phase: 1, owner: 1, status: 1, statusText: 1, progress: 1 } satisfies Record<keyof HandoffTask, 1>,
  HandoffInfo: { skill: 1, requirements: 1, phase: 1, updated: 1, current: 1, tasks: 1, waiting: 1, next: 1 } satisfies Record<keyof HandoffInfo, 1>,
  ProgressResult: { version: 1, plan: 1, handoff: 1 } satisfies Record<keyof ProgressRead, 1>,
  ReasonInfo: { reason: 1 } satisfies Record<Exclude<keyof Extract<PlanRead, { state: "unreadable" }>, "state">, 1>,
  DocFile: { path: 1, size: 1, modified: 1 } satisfies Record<keyof DocFile, 1>,
  DocsListing: { docsDir: 1, files: 1, truncated: 1 } satisfies Record<keyof DocsListing, 1>,
  DocText: { text: 1, version: 1 } satisfies Record<keyof DocText, 1>,
};

// 세션 시작 · 스킬 목록 (P6-02) — 화면 쪽에서 종류가 하나 늘면 컴파일이 실패하고, Rust 쪽에서 늘면 아래 시험이 실패한다.
const TS_SKILL_ORIGINS: Record<SkillOrigin, true> = { harness: true, mine: true };
const TS_SKILL_UNREADABLE: Record<SkillUnreadableReason, true> = {
  too_large: true,
  read_failed: true,
  not_utf8: true,
  no_frontmatter: true,
  unclosed_frontmatter: true,
  name_mismatch: true,
  invalid_name: true,
};
const TS_SKILLS_STATES: Record<SkillsState, true> = { ok: true, no_harness: true, location_unusable: true };
const TS_SESSION_FIELDS = {
  StartRequest: { projectId: 1, resume: 1, useApiKey: 1 } satisfies Record<keyof StartRequest, 1>,
  StartInfo: { projectId: 1, projectDir: 1, pid: 1, resumed: 1, resumeSessionId: 1, cliVersion: 1, model: 1, effort: 1 } satisfies Record<keyof StartInfo, 1>,
  SessionState: { running: 1, projectId: 1, projectDir: 1, pid: 1, sessionId: 1, busy: 1, pending: 1, workers: 1 } satisfies Record<keyof ClaudeSessionState, 1>,
  WorkerRef: { agentId: 1, toolUseId: 1, name: 1 } satisfies Record<keyof WorkerRef, 1>,
  SkillInfo: { name: 1, command: 1, description: 1, argumentHint: 1, origin: 1, userInvocable: 1 } satisfies Record<keyof SkillInfo, 1>,
  SkillUnreadable: { folder: 1, origin: 1, reason: 1 } satisfies Record<keyof SkillUnreadable, 1>,
  SkillsList: { state: 1, skills: 1 } satisfies Record<keyof SkillsList, 1>,
};

// 채팅 기록 · 세션 츄르 (P6-03) — 화면 쪽에서 종류가 하나 늘면 컴파일이 실패하고, Rust 쪽에서 늘면 아래 시험이 실패한다.
const TS_CHAT_LIST_EVENT_TYPES: Record<ChatListEventType, true> = {
  session_started: true,
  user_message: true,
  text: true,
  tool_use: true,
  tool_result: true,
  permission_request: true,
  question_request: true,
  turn_ended: true,
  rate_limit: true,
  resume_not_found: true,
  worker_started: true,
  session_ended: true,
};
/** 기록에 저장하지 않는 이벤트 (`record.rs` 의 표) — 답 · 취소 · 작업자 끝은 저장하지만 목록에 따로 나오지 않고 카드(작업자 시작 항목)의 상태로 합쳐진다.
 *  `worker_activity`(작업자가 지금 하는 일)는 너무 자주 바뀌어 저장하지 않는다. */
const NOT_LISTED_EVENTS = ["warning", "turn_started", "raw_log", "request_answered", "request_cancelled", "worker_activity", "worker_ended"];
const TS_WORKER_OUTCOMES: Record<WorkerOutcome, true> = { done: true, failed: true, stopped: true };
const TS_CHAT_WORKER_STATUSES: Record<ChatWorkerStatus, true> = { running: true, done: true, failed: true, stopped: true };
const TS_CHAT_REQUEST_STATUSES: Record<ChatRequestStatus, true> = { answered: true, cancelled: true, pending: true, expired: true };
const TS_HISTORY_FIELDS = {
  ChatEntry: { id: 1, at: 1, sessionId: 1, truncated: 1, event: 1, request: 1, worker: 1 } satisfies Record<keyof ChatEntry, 1>,
  WorkerState: { status: 1, endedAtMs: 1 } satisfies Record<keyof ChatWorkerState, 1>,
  ChatPage: { entries: 1, hasMore: 1 } satisfies Record<keyof ChatPage, 1>,
  RequestState: { status: 1, answer: 1 } satisfies Record<keyof ChatRequestState, 1>,
  UsageSum: { turns: 1, inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 1, cacheReadInputTokens: 1, totalTokens: 1, costUsd: 1, subscriptionTurns: 1, apiKeyTurns: 1, referenceOnly: 1 } satisfies Record<keyof UsageSum, 1>,
  ProjectUsage: { projectId: 1, today: 1, total: 1 } satisfies Record<keyof ProjectUsage, 1>,
  SessionUsage: { projectId: 1, sessionId: 1, usage: 1 } satisfies Record<keyof SessionUsage, 1>,
  UsageSummary: { since: 1, today: 1, projects: 1, session: 1 } satisfies Record<keyof UsageSummary, 1>,
};

const camel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `pub struct <name> {` 의 바로 아래(들여쓰기 4칸) `pub` 필드를 serde camelCase 이름으로 (`#[serde(rename = "type")]` 인 `kind` 는 `type`) */
function rustFields(source: string, structName: string): string[] {
  const start = source.indexOf(`pub struct ${structName} {`);
  if (start < 0) throw new Error(`struct ${structName} not found`);
  const rest = source.slice(start);
  const body = rest.slice(0, rest.indexOf("\n}"));
  const names: string[] = [];
  let renamedToType = false;
  for (const line of body.split("\n")) {
    if (/^ {4}#\[serde\(rename = "type"\)\]/.test(line)) renamedToType = true;
    const field = /^ {4}pub ([a-z_0-9]+):/.exec(line);
    if (field) {
      names.push(renamedToType ? "type" : camel(field[1] as string));
      renamedToType = false;
    }
  }
  if (names.length === 0) throw new Error(`no fields in ${structName}`);
  return names;
}

const sorted = (values: Iterable<string>) => [...values].sort();

/** `history/mod.rs` 의 `Limits::default()` 에 적힌 값 (글 그대로) */
function readFileLimit(field: string): string {
  const match = new RegExp(`${field}: ([0-9_]+),`).exec(historyModRs.slice(historyModRs.indexOf("impl Default for Limits")));
  if (!match) throw new Error(`limit ${field} not found`);
  return match[1] as string;
}

/** serde `rename_all = "snake_case"` 와 같다: 첫 글자가 아닌 대문자 앞마다 `_` (`NotAFile` → `not_a_file`) */
function snake(name: string): string {
  return name.replace(/(?!^)([A-Z])/g, "_$1").toLowerCase();
}

/** `pub enum <name> {` 의 바로 아래(들여쓰기 4칸) 변형 이름들 */
function rustVariants(source: string, enumName: string): string[] {
  const start = source.indexOf(`pub enum ${enumName} {`);
  if (start < 0) throw new Error(`enum ${enumName} not found`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  const body = rest.slice(0, end);
  const names = [...body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)/gm)].map((m) => m[1] as string);
  if (names.length === 0) throw new Error(`no variants in ${enumName}`);
  return names;
}

describe("Rust ↔ 화면 목록이 같다", () => {
  it("오류 종류: error.rs 의 kind() 와 ipc-types 의 AppErrorKind", () => {
    const body = errorRs.slice(errorRs.indexOf("pub fn kind(&self)"));
    const rustKinds = [...body.slice(0, body.indexOf("\n    }\n")).matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(rustKinds.length).toBeGreaterThan(5);
    expect(sorted(Object.keys(TS_ERROR_KINDS))).toEqual(sorted(rustKinds));
  });

  it("Rust 오류 종류마다 화면은 같은 종류의 AppError 로 받고(internal 로 뭉개지 않고) 문구가 있다", () => {
    const body = errorRs.slice(errorRs.indexOf("pub fn kind(&self)"));
    const rustKinds = [...body.slice(0, body.indexOf("\n    }\n")).matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1] as string);
    for (const kind of rustKinds) {
      const error = toAppError({ kind, message: "m" });
      expect(error).toBeInstanceOf(AppError);
      expect(error.kind, kind).toBe(kind);
      expect(isTextKey(`error.${kind}`), `ko.ts 에 error.${kind} 문구가 없음`).toBe(true);
    }
  });

  it("이벤트 종류: events.rs 의 SessionEvent 와 ipc-types 의 ClaudeEvent", () => {
    const rustTypes = rustVariants(eventsRs, "SessionEvent").map(snake);
    expect(sorted(Object.keys(TS_EVENT_TYPES))).toEqual(sorted(rustTypes));
  });

  it("작업자 이벤트 (P7-02): 결과 종류가 Rust 와 같고, 이벤트는 지시 글 · 작업자 결과 글 칸을 갖지 않는다 (D-48)", () => {
    expect(sorted(Object.keys(TS_WORKER_OUTCOMES))).toEqual(sorted(rustVariants(eventsRs, "WorkerOutcome").map(snake)));
    const variantBody = (name: string) => {
      const start = eventsRs.indexOf(`    ${name} {`);
      return eventsRs.slice(start, eventsRs.indexOf("\n    },", start));
    };
    for (const name of ["WorkerStarted", "WorkerActivity", "WorkerEnded"]) {
      expect(variantBody(name), name).not.toMatch(/prompt|summary_text|result_text|hand_back/);
    }
    // 기록: 작업자 시작 · 끝은 저장하고 하는 일은 저장하지 않는다
    const wants = historyRecordRs.slice(historyRecordRs.indexOf("pub fn wants("));
    const wantsBody = wants.slice(0, wants.indexOf("\n}\n"));
    expect(wantsBody).toContain("SessionEvent::WorkerStarted { .. }");
    expect(wantsBody).toContain("SessionEvent::WorkerEnded { .. }");
    expect(wantsBody).toContain("SessionEvent::WorkerActivity { .. }");
    expect(wantsBody).toMatch(/SessionEvent::WorkerActivity \{ \.\. \}\s*\|\s*SessionEvent::RawLog\(_\) => false/);
  });

  it("답 종류: events.rs 의 Response 와 ClaudeResponse", () => {
    expect(sorted(Object.keys(TS_RESPONSE_KINDS))).toEqual(sorted(rustVariants(eventsRs, "Response").map(snake)));
  });

  it("턴 결과 · 항상 허용 범위: Rust enum 과 같다", () => {
    expect(sorted(Object.keys(TS_OUTCOMES))).toEqual(sorted(rustVariants(eventsRs, "TurnOutcome").map(snake)));
    expect(sorted(Object.keys(TS_SCOPES))).toEqual(sorted(rustVariants(eventsRs, "AlwaysScope").map(snake)));
  });

  it("하네스 종류: git.rs · locate.rs · script.rs 의 enum 과 ipc-types 의 글 종류", () => {
    expect(sorted(Object.keys(TS_GIT_OUTCOMES))).toEqual(sorted(rustVariants(harnessGitRs, "GitOutcome").map(snake)));
    expect(sorted(Object.keys(TS_UPDATE_STATES))).toEqual(sorted(rustVariants(harnessGitRs, "UpdateState").map(snake)));
    expect(sorted(Object.keys(TS_ORIGIN_KINDS))).toEqual(sorted(rustVariants(harnessLocateRs, "OriginKind").map(snake)));
    expect(sorted(Object.keys(TS_SCRIPT_OUTCOMES))).toEqual(sorted(rustVariants(harnessScriptRs, "ScriptOutcome").map(snake)));
    expect(sorted(Object.keys(TS_UNREADABLE))).toEqual(sorted(rustVariants(harnessScriptRs, "UnreadableReason").map(snake)));
  });

  it("하네스 결과의 필드: Rust 구조체와 ipc-types 인터페이스가 같은 키를 쓴다", () => {
    const sources: Record<string, [string, string]> = {
      HarnessStatus: [harnessStatusRs, "HarnessStatus"],
      RepoStatus: [harnessStatusRs, "RepoStatus"],
      Origin: [harnessLocateRs, "Origin"],
      GitInfo: [harnessGitRs, "GitInfo"],
      GitBashInfo: [harnessGitRs, "GitBashInfo"],
      GitResult: [harnessGitRs, "GitResult"],
      UpdatePreview: [harnessGitRs, "UpdatePreview"],
      CommitInfo: [harnessGitRs, "CommitInfo"],
      FileChange: [harnessGitRs, "FileChange"],
      ScriptResult: [harnessScriptRs, "ScriptResult"],
      Report: [harnessScriptRs, "Report"],
      CustomItem: [harnessScriptRs, "CustomItem"],
      Change: [harnessScriptRs, "Change"],
      Counts: [harnessScriptRs, "Counts"],
      OriginChanged: [harnessScriptRs, "OriginChanged"],
      Problem: [harnessScriptRs, "Problem"],
      BackupRef: [harnessScriptRs, "BackupRef"],
      BackupInfo: [harnessScriptRs, "BackupInfo"],
      ErrorInfo: [harnessScriptRs, "ErrorInfo"],
      Unreadable: [harnessScriptRs, "Unreadable"],
      PruneResult: [harnessBackupsRs, "PruneResult"],
    };
    expect(Object.keys(sources).sort()).toEqual(Object.keys(TS_FIELDS).sort());
    for (const [name, [source, struct]] of Object.entries(sources)) {
      const ts = TS_FIELDS[name as keyof typeof TS_FIELDS];
      expect(sorted(Object.keys(ts)), name).toEqual(sorted(rustFields(source, struct)));
    }
  });

  it("하네스 종류마다 시험 화면 문구가 있다 (코드를 글 그대로 보이는 일이 없게)", () => {
    for (const outcome of Object.keys(TS_GIT_OUTCOMES)) expect(isTextKey(`lab.harness.git.${outcome}`), outcome).toBe(true);
    for (const state of Object.keys(TS_UPDATE_STATES)) expect(isTextKey(`lab.harness.update.state.${state}`), state).toBe(true);
    for (const kind of Object.keys(TS_ORIGIN_KINDS)) expect(isTextKey(`lab.harness.origin.${kind}`), kind).toBe(true);
    for (const outcome of Object.keys(TS_SCRIPT_OUTCOMES)) expect(isTextKey(`lab.harness.script.${outcome}`), outcome).toBe(true);
    for (const reason of Object.keys(TS_UNREADABLE)) expect(isTextKey(`lab.harness.unreadable.${reason}`), reason).toBe(true);
  });

  it("Rust 가 거절하며 보내는 이유마다 시험 화면 문구가 있다 (받기 거절 · 설치 · 되돌리기 거절)", () => {
    const gitReasons = [...harnessGitRs.matchAll(/refuse\("([a-z_]+)"\)/g)].map((m) => m[1] as string);
    expect(gitReasons).toEqual(expect.arrayContaining(["check_first", "dirty", "diverged", "ahead", "detached_head", "no_upstream", "not_fast_forward"]));
    for (const reason of gitReasons) expect(isTextKey(`lab.harness.reason.${reason}`), `git 거절 이유 ${reason}`).toBe(true);
    const scriptReasons = [...harnessFlowRs.matchAll(/refused\("([a-z_]+)"\)/g)].map((m) => m[1] as string);
    expect(sorted(new Set(scriptReasons))).toEqual(["plan_first", "source_changed"]);
    for (const reason of scriptReasons) expect(isTextKey(`lab.harness.refused.${reason}`), `설치 거절 이유 ${reason}`).toBe(true);
    // 설치 뒤 백업 정리를 건너뛴 이유 (backups.rs)
    for (const reason of [...harnessBackupsRs.matchAll(/skipped = Some\("([a-z_]+)"\.into\(\)\)/g)].map((m) => m[1] as string)) {
      expect(isTextKey(`lab.harness.pruneSkipped.${reason}`), `정리 건너뜀 이유 ${reason}`).toBe(true);
    }
    expect(isTextKey("lab.harness.pruneSkipped.locked")).toBe(true); // script.rs 가 잠금을 보고 건너뛴다
  });

  it("에이전트 · 사용량 종류: Rust enum 과 ipc-types 의 글 종류", () => {
    expect(sorted(Object.keys(TS_AGENT_ROLES))).toEqual(sorted(rustVariants(agentsRs, "AgentRole").map(snake)));
    expect(sorted(Object.keys(TS_AGENT_UNREADABLE))).toEqual(sorted(rustVariants(agentsRs, "UnreadableReason").map(snake)));
    expect(sorted(Object.keys(TS_AGENTS_STATES))).toEqual(sorted(rustVariants(agentsRs, "AgentsState").map(snake)));
    expect(sorted(Object.keys(TS_AGENTS_CONFIG_STATES))).toEqual(sorted(rustVariants(agentsConfigRs, "ConfigState").map(snake)));
    expect(sorted(Object.keys(TS_USAGE_REASONS))).toEqual(sorted(rustVariants(usageRs, "UnavailableReason").map(snake)));
    // 태그가 붙는 enum: 변형 이름이 곧 `state` 값 (`Ok` → `ok`)
    expect(sorted(Object.keys(TS_USAGE_STATES))).toEqual(sorted(rustVariants(usageRs, "UsageResult").map(snake)));
    expect(sorted(["ok", "unreadable"])).toEqual(sorted(rustVariants(agentsRs, "AgentEntry").map(snake)));
  });

  it("에이전트 · 사용량 결과의 필드: Rust 구조체와 ipc-types 인터페이스가 같은 키를 쓴다", () => {
    const sources: Record<string, [string, string]> = {
      AgentInfo: [agentsRs, "AgentInfo"],
      AgentUnreadable: [agentsRs, "AgentUnreadable"],
      AgentsList: [agentsRs, "AgentsList"],
      UsageWindow: [usageRs, "UsageWindow"],
      ScopedWindow: [usageRs, "ScopedWindow"],
      UsageReading: [usageRs, "UsageReading"],
    };
    expect(Object.keys(sources).sort()).toEqual(Object.keys(TS_HOUSE_FIELDS).sort());
    for (const [name, [source, struct]] of Object.entries(sources)) {
      const ts = TS_HOUSE_FIELDS[name as keyof typeof TS_HOUSE_FIELDS];
      expect(sorted(Object.keys(ts)), name).toEqual(sorted(rustFields(source, struct)));
    }
    // 태그 이름은 `state` 하나 — serde `tag = "state"` 가 두 enum 에 있다
    expect(agentsRs).toContain('#[serde(tag = "state", rename_all = "snake_case")]\npub enum AgentEntry');
    expect(usageRs).toContain('#[serde(tag = "state", rename_all = "snake_case")]\npub enum UsageResult');
  });

  it("프로젝트 종류: Rust enum 과 ipc-types 의 글 종류", () => {
    // 스킬 이름은 `as_str` 의 글자 그대로
    const asStr = projectsRs.slice(projectsRs.indexOf("pub fn as_str(self)"));
    const rustSkills = [...asStr.slice(0, asStr.indexOf("\n    }\n")).matchAll(/=> "(\/[a-z-]+)"/g)].map((m) => m[1] as string);
    expect(rustSkills.length).toBe(3);
    expect(sorted(Object.keys(TS_PROJECT_SKILLS))).toEqual(sorted(rustSkills));
    expect(sorted(Object.keys(TS_FOLDER_STATES))).toEqual(sorted(rustVariants(projectsFolderRs, "FolderState").map(snake)));
    // 살펴본 결과는 serde camelCase (`HasRequirements` → `hasRequirements`)
    expect(sorted(Object.keys(TS_FOLDER_FINDINGS))).toEqual(sorted(rustVariants(projectsFolderRs, "FolderFinding").map((name) => name.charAt(0).toLowerCase() + name.slice(1))));
    expect(sorted(Object.keys(TS_FORBIDDEN_REASONS))).toEqual(sorted(rustVariants(projectsFolderRs, "ForbiddenReason").map(snake)));
    expect(sorted(Object.keys(TS_DB_MODES))).toEqual(sorted(rustVariants(projectsRs, "DbMode").map(snake)));
    expect(sorted(Object.keys(TS_REQUIREMENTS_PROBLEMS))).toEqual(sorted(rustVariants(projectsRequirementsRs, "Problem").map(snake)));
    // 태그가 붙는 enum: 변형 이름이 곧 `state` 값
    expect(sorted(Object.keys(TS_PICKED_STATES))).toEqual(sorted(rustVariants(projectsRs, "PickedFolder").map(snake)));
    expect(sorted(Object.keys(TS_READ_STATES))).toEqual(sorted(rustVariants(projectsRequirementsRs, "ReadResult").map(snake)));
    expect(sorted(Object.keys(TS_VERSION_STATES))).toEqual(sorted(rustVariants(projectsRequirementsRs, "VersionResult").map(snake)));
    expect(sorted(Object.keys(TS_WRITE_STATES))).toEqual(sorted(rustVariants(projectsRequirementsRs, "WriteResult").map(snake)));
    for (const [source, name] of [
      [projectsRs, "PickedFolder"],
      [projectsRequirementsRs, "ReadResult"],
      [projectsRequirementsRs, "VersionResult"],
      [projectsRequirementsRs, "WriteResult"],
    ] as const) {
      expect(source, name).toContain(`#[serde(tag = "state", rename_all = "snake_case")]\npub enum ${name}`);
    }
  });

  it("프로젝트 결과 · 입력의 필드: Rust 구조체와 ipc-types 인터페이스가 같은 키를 쓴다", () => {
    const sources: Record<string, [string, string]> = {
      ProjectEntry: [projectsRs, "ProjectEntry"],
      ProjectList: [projectsRs, "ProjectList"],
      PickedOk: [projectsRs, "PickedOk"],
      PickedForbidden: [projectsRs, "PickedForbidden"],
      AddRequest: [projectsRs, "AddRequest"],
      ProjectPatch: [projectsRs, "ProjectPatch"],
      TextRead: [projectsRequirementsRs, "TextRead"],
      ProblemInfo: [projectsRequirementsRs, "ProblemInfo"],
      VersionInfo: [projectsRequirementsRs, "VersionInfo"],
      ConflictInfo: [projectsRequirementsRs, "ConflictInfo"],
    };
    expect(Object.keys(sources).sort()).toEqual(Object.keys(TS_PROJECT_FIELDS).sort());
    for (const [name, [source, struct]] of Object.entries(sources)) {
      const ts = TS_PROJECT_FIELDS[name as keyof typeof TS_PROJECT_FIELDS];
      expect(sorted(Object.keys(ts)), name).toEqual(sorted(rustFields(source, struct)));
    }
    // 화면이 보내는 두 입력은 모르는 필드를 받지 않는다 (경로 같은 것을 슬쩍 끼워 보내도 거절)
    for (const name of ["AddRequest", "ProjectPatch"]) {
      expect(projectsRs, name).toContain(`#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct ${name} {`);
    }
  });

  it("프로젝트 명령은 화면에서 경로 글자를 받지 않는다 — 프로젝트 번호 · 이름 · 스킬 · 글 · 버전만 (D-47)", async () => {
    const commandsRs = (await import("../../src-tauri/src/projects/commands.rs?raw")).default;
    const signatures = [...commandsRs.matchAll(/#\[tauri::command\]\s+pub async fn ([a-z_]+)\(([^)]*)\)/g)];
    const expected: Record<string, string[]> = {
      projects_list: ["db", "state"],
      project_pick_folder: ["app", "db", "state"],
      project_add: ["db", "state", "request"],
      project_update: ["db", "state", "id", "patch"],
      project_remove: ["db", "state", "sessions", "id"],
      project_touch: ["db", "id"],
      project_requirements_read: ["db", "state", "id"],
      project_requirements_version: ["db", "state", "id"],
      project_requirements_write: ["db", "state", "id", "text", "base_version"],
      // 문서 읽기 (P7-01) — 읽기 전용. `project_doc_read` 만 `docsDir` 안 상대 경로를 받고 Rust 가 다시 확인한다 (아래 시험)
      project_progress_read: ["db", "state", "id"],
      project_progress_version: ["db", "state", "id"],
      project_docs_list: ["db", "state", "id"],
      project_doc_read: ["db", "state", "id", "path"],
    };
    expect(signatures.map((m) => m[1]).sort()).toEqual(Object.keys(expected).sort());
    // 화면이 보내는 값(앱이 채우는 app · db · state · sessions 를 뺀 것)의 이름 · 모양
    const fromScreen: Record<string, string> = { id: "i64", request: "AddRequest", patch: "ProjectPatch", text: "String", base_version: "Option<String>", path: "String" };
    for (const [, name, params] of signatures) {
      const list = (params as string)
        .replace(/State<[^>]*>/g, "State") // `State<'_, AppDb>` 안의 쉼표는 매개변수 구분이 아니다
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      expect(
        list.map((p) => p.split(":")[0]?.trim()),
        `${name} 의 매개변수`,
      ).toEqual(expected[name as string]);
      for (const param of list) {
        const [paramName, paramType] = param.split(":").map((part) => part.trim()) as [string, string];
        if (["app", "db", "state", "sessions"].includes(paramName)) continue;
        expect(paramType, `${name} 의 ${paramName}`).toBe(fromScreen[paramName]);
      }
    }
    expect(commandsRs).not.toContain("PathBuf");
    // 화면 쪽 호출도 같다: 폴더 경로를 넘기는 인자가 없다
    const ipcTs = (await import("./ipc.ts?raw")).default;
    // (`project_chat_history` 는 history 모듈의 명령이다 — 아래 "채팅 기록 · 츄르 명령" 시험이 따로 본다)
    const projectCalls = [...ipcTs.matchAll(/(project[A-Za-z]*): \(([^)]*)\) =>\s*call<[^>]*>\("(projects?_[a-z_]+)"(, \{[^}]*\})?/g)].filter((m) => m[3] !== "project_chat_history");
    expect(projectCalls.map((m) => m[3]).sort()).toEqual(Object.keys(expected).sort());
    for (const [, , params, command, args] of projectCalls) {
      // 문서 하나 읽기만 `docsDir` 안 상대 경로(`path`)를 보낸다 — 폴더 경로가 아니다
      if (command === "project_doc_read") {
        expect(params, command).toBe("id: number, path: string");
        expect(args, command).toBe(", { id, path }");
        continue;
      }
      expect(`${params as string}${args ?? ""}`, command).not.toMatch(/path|dir|folder/i);
    }
    // 문서 읽기의 `path` 는 Rust 가 다시 확인한다: 경로 모양 확인 · 읽을 때 실제 경로가 `docsDir` 안인지 확인
    expect(projectsDocsRs).toContain("pub fn parse_path(path: &str)");
    expect(projectsDocsRs).toContain("let parts = parse_path(path)?;");
    expect(projectsDocsRs).toContain("if !canon.starts_with(canon_docs)");
    expect(commandsRs).toContain("docs::read(&db, &state.env(), id, &path)");
  });

  it("프로젝트 파일 명령은 requirements.md 하나만 다룬다 (파일 이름이 코드에 고정돼 있고, 폴더 만들기 · 지우기 · 다른 파일 쓰기가 없다)", () => {
    expect(projectsRequirementsRs).toContain('pub const FILE_NAME: &str = "requirements.md";');
    for (const [name, source] of [
      ["mod.rs", projectsRs],
      ["folder.rs", projectsFolderRs],
    ] as const) {
      const production = source.slice(0, source.indexOf("#[cfg(test)]"));
      expect(production, `projects/${name}`).not.toMatch(/fs::(write|remove_|create_dir|rename|copy|File::create|OpenOptions)/);
    }
    const requirementsProduction = projectsRequirementsRs.slice(0, projectsRequirementsRs.indexOf("#[cfg(test)]"));
    expect(requirementsProduction).not.toMatch(/fs::(create_dir|remove_dir|copy)/);
  });

  it("문서 읽기의 종류: Rust enum 과 ipc-types 의 글 종류 (P7-01)", () => {
    expect(sorted(Object.keys(TS_PROGRESS_REASONS))).toEqual(sorted(rustVariants(projectsProgressRs, "Reason").map(snake)));
    // 앞 일곱은 `requirements.md` 를 못 읽는 이유와 같은 이름이다 (`From<Problem>`)
    expect(sorted(Object.keys(TS_PROGRESS_REASONS)).filter((name) => Object.keys(TS_REQUIREMENTS_PROBLEMS).includes(name))).toEqual(sorted(Object.keys(TS_REQUIREMENTS_PROBLEMS)));
    expect(sorted(Object.keys(TS_PHASE_STATUSES))).toEqual(sorted(rustVariants(projectsProgressRs, "PhaseStatus").map(snake)));
    expect(sorted(Object.keys(TS_NOW_STATES))).toEqual(sorted(rustVariants(projectsProgressRs, "NowState").map(snake)));
    expect(sorted(Object.keys(TS_TASK_STATUSES))).toEqual(sorted(rustVariants(projectsProgressRs, "TaskStatus").map(snake)));
    // 태그가 붙는 enum: 변형 이름이 곧 `state` 값. `Section<T>` 는 제네릭이라 이름에 `<T>` 가 붙는다
    expect(sorted(Object.keys(TS_SECTION_STATES))).toEqual(sorted(rustVariants(projectsProgressRs, "Section<T>").map(snake)));
    expect(sorted(Object.keys(TS_PLAN_STATES))).toEqual(sorted(rustVariants(projectsProgressRs, "PlanResult").map(snake)));
    expect(sorted(Object.keys(TS_HANDOFF_STATES))).toEqual(sorted(rustVariants(projectsProgressRs, "HandoffResult").map(snake)));
    expect(sorted(Object.keys(TS_DOCS_LIST_STATES))).toEqual(sorted(rustVariants(projectsDocsRs, "ListResult").map(snake)));
    expect(sorted(Object.keys(TS_DOC_READ_STATES))).toEqual(sorted(rustVariants(projectsDocsRs, "DocReadResult").map(snake)));
    for (const [source, name] of [
      [projectsProgressRs, "Section<T>"],
      [projectsProgressRs, "PlanResult"],
      [projectsProgressRs, "HandoffResult"],
      [projectsDocsRs, "ListResult"],
      [projectsDocsRs, "DocReadResult"],
    ] as const) {
      expect(source, name).toContain(`#[serde(tag = "state", rename_all = "snake_case")]\npub enum ${name}`);
    }
    // 읽을 수 없는 문서 목록 · 읽기의 이유는 `requirements.md` 와 같은 일곱 가지다
    expect(projectsDocsRs).toContain("Unreadable(ProblemInfo)");
  });

  it("문서 읽기 결과의 필드: Rust 구조체와 ipc-types 인터페이스가 같은 키를 쓴다 (P7-01)", () => {
    const sources: Record<string, [string, string]> = {
      PhaseInfo: [projectsProgressRs, "PhaseInfo"],
      PlanInfo: [projectsProgressRs, "PlanInfo"],
      NowInfo: [projectsProgressRs, "NowInfo"],
      TaskProgress: [projectsProgressRs, "TaskProgress"],
      TaskInfo: [projectsProgressRs, "TaskInfo"],
      HandoffInfo: [projectsProgressRs, "HandoffInfo"],
      ProgressResult: [projectsProgressRs, "ProgressResult"],
      ReasonInfo: [projectsProgressRs, "ReasonInfo"],
      DocFile: [projectsDocsRs, "DocFile"],
      DocsListing: [projectsDocsRs, "DocsListing"],
      DocText: [projectsDocsRs, "DocText"],
    };
    expect(Object.keys(sources).sort()).toEqual(Object.keys(TS_PROGRESS_FIELDS).sort());
    for (const [name, [source, struct]] of Object.entries(sources)) {
      const ts = TS_PROGRESS_FIELDS[name as keyof typeof TS_PROGRESS_FIELDS];
      expect(sorted(Object.keys(ts)), name).toEqual(sorted(rustFields(source, struct)));
    }
    // 여러 낱말 필드(`status_text` → `statusText`)는 camelCase 로 나간다
    for (const [source, struct] of [
      [projectsProgressRs, "PhaseInfo"],
      [projectsProgressRs, "TaskInfo"],
      [projectsDocsRs, "DocFile"],
      [projectsDocsRs, "DocsListing"],
    ] as const) {
      expect(source, struct).toContain(`#[serde(rename_all = "camelCase")]\npub struct ${struct} {`);
    }
  });

  it("문서 읽기는 읽기만 한다 — 쓰기 · 만들기 · 지우기 · 이름 바꾸기가 없고, 파일 감시(notify)를 쓰지 않는다 (D-49)", () => {
    for (const [name, source] of [
      ["docs.rs", projectsDocsRs],
      ["progress.rs", projectsProgressRs],
    ] as const) {
      const production = source.slice(0, source.indexOf("#[cfg(test)]"));
      expect(production, `projects/${name}`).not.toMatch(/fs::(write|remove_|create_dir|rename|copy|File::create|OpenOptions|set_permissions)/);
      expect(production, `projects/${name}`).not.toMatch(/notify|\.write_all|set_modified/);
    }
    // 읽는 문서 이름은 코드에 고정돼 있다 (하네스 문서 둘 + 지시서 폴더)
    expect(projectsProgressRs).toContain('const PLAN_FILE: &str = "dev-plan.md";');
    expect(projectsProgressRs).toContain('const HANDOFF_FILE: &str = "handoff.md";');
    expect(projectsProgressRs).toContain('const BRIEFS_DIR: &str = "briefs";');
  });

  it("세션 시작 · 스킬 목록의 필드와 종류: Rust 와 ipc-types 가 같다", () => {
    const sources: Record<string, [string, string]> = {
      StartRequest: [eventsRs, "StartRequest"],
      StartInfo: [eventsRs, "StartInfo"],
      SessionState: [eventsRs, "SessionState"],
      WorkerRef: [eventsRs, "WorkerRef"],
      SkillInfo: [skillsRs, "SkillInfo"],
      SkillUnreadable: [skillsRs, "SkillUnreadable"],
      SkillsList: [skillsRs, "SkillsList"],
    };
    expect(Object.keys(sources).sort()).toEqual(Object.keys(TS_SESSION_FIELDS).sort());
    for (const [name, [source, struct]] of Object.entries(sources)) {
      const ts = TS_SESSION_FIELDS[name as keyof typeof TS_SESSION_FIELDS];
      expect(sorted(Object.keys(ts)), name).toEqual(sorted(rustFields(source, struct)));
    }
    expect(sorted(Object.keys(TS_SKILL_ORIGINS))).toEqual(sorted(rustVariants(skillsRs, "SkillOrigin").map(snake)));
    expect(sorted(Object.keys(TS_SKILL_UNREADABLE))).toEqual(sorted(rustVariants(skillsRs, "UnreadableReason").map(snake)));
    expect(sorted(Object.keys(TS_SKILLS_STATES))).toEqual(sorted(rustVariants(skillsRs, "SkillsState").map(snake)));
    expect(sorted(["ok", "unreadable"])).toEqual(sorted(rustVariants(skillsRs, "SkillEntry").map(snake)));
    expect(skillsRs).toContain('#[serde(tag = "state", rename_all = "snake_case")]\npub enum SkillEntry');
    // 시작 알림은 프로젝트 번호 · 모델 · 수준을 싣는다 (Rust 의 `SessionStarted` 와 ClaudeEvent 의 같은 이름)
    const started = eventsRs.slice(eventsRs.indexOf("    SessionStarted {"));
    const startedBody = started.slice(0, started.indexOf("\n    },"));
    for (const field of ["project_id", "project_dir", "model", "effort"]) expect(startedBody, field).toContain(`${field}:`);
  });

  it("채팅 기록 · 츄르의 필드와 종류: Rust 와 ipc-types 가 같다", () => {
    const sources: Record<string, [string, string]> = {
      ChatEntry: [historyChatRs, "ChatEntry"],
      ChatPage: [historyChatRs, "ChatPage"],
      RequestState: [historyChatRs, "RequestState"],
      WorkerState: [historyChatRs, "WorkerState"],
      UsageSum: [historyUsageRs, "UsageSum"],
      ProjectUsage: [historyUsageRs, "ProjectUsage"],
      SessionUsage: [historyUsageRs, "SessionUsage"],
      UsageSummary: [historyUsageRs, "UsageSummary"],
    };
    expect(Object.keys(sources).sort()).toEqual(Object.keys(TS_HISTORY_FIELDS).sort());
    for (const [name, [source, struct]] of Object.entries(sources)) {
      const ts = TS_HISTORY_FIELDS[name as keyof typeof TS_HISTORY_FIELDS];
      expect(sorted(Object.keys(ts)), name).toEqual(sorted(rustFields(source, struct)));
    }
    expect(sorted(Object.keys(TS_CHAT_REQUEST_STATUSES))).toEqual(sorted(rustVariants(historyChatRs, "RequestStatus").map(snake)));
    expect(sorted(Object.keys(TS_CHAT_WORKER_STATUSES))).toEqual(sorted(rustVariants(historyChatRs, "WorkerStatus").map(snake)));
    // 답 종류 이름은 사용자의 답(`Response`)의 `kind` 와 같다
    expect(sorted(Object.keys(TS_RESPONSE_KINDS))).toEqual(sorted(rustVariants(eventsRs, "AnswerKind").map(snake)));
    // 목록에 나오는 이벤트 종류 = 모든 이벤트 − 저장하지 않는 것 − 카드에 합쳐지는 것
    const listed = rustVariants(eventsRs, "SessionEvent")
      .map(snake)
      .filter((type) => !NOT_LISTED_EVENTS.includes(type));
    expect(sorted(Object.keys(TS_CHAT_LIST_EVENT_TYPES))).toEqual(sorted(listed));
    // 저장하는 종류 이름은 이벤트의 `type` 과 같다 (`record.rs` 의 `kind_of` 가 이벤트마다 같은 이름을 준다)
    const kindOf = historyRecordRs.slice(historyRecordRs.indexOf("fn kind_of("));
    const kinds = [...kindOf.slice(0, kindOf.indexOf("\n}\n")).matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(sorted(kinds)).toEqual(sorted(rustVariants(eventsRs, "SessionEvent").map(snake)));
    // 기록에 쓰는 한도 값이 있다 (보고에 적은 값과 같이 바꾼다)
    expect(readFileLimit("max_items_per_project")).toBe("10_000");
    expect(readFileLimit("max_text_chars")).toBe("8_000");
    expect(readFileLimit("max_queued")).toBe("5_000");
  });

  it("채팅 기록 · 츄르 명령은 프로젝트 번호와 쪽 나누기 값만 받는다 — 경로 글자를 받는 길이 없다 (D-47)", async () => {
    const commandsRs = (await import("../../src-tauri/src/history/commands.rs?raw")).default;
    const signature = (name: string) => {
      const match = new RegExp(String.raw`#\[tauri::command\]\s+pub async fn ${name}\(([^)]*)\)`).exec(commandsRs);
      if (!match) throw new Error(`${name} not found`);
      return (match[1] as string)
        .replace(/State<[^>]*>/g, "State")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
    };
    expect(signature("project_chat_history")).toEqual(["db: State", "manager: State", "id: i64", "before: Option<i64>", "limit: u32"]);
    expect(signature("app_usage_summary")).toEqual(["db: State", "manager: State"]);
    expect([...commandsRs.matchAll(/#\[tauri::command\]/g)].length).toBe(2);
    expect(commandsRs).not.toContain("PathBuf");
    const ipcTs = (await import("./ipc.ts?raw")).default;
    expect(ipcTs).toContain('projectChatHistory: (id: number, before: number | null, limit: number) => call<ChatPage>("project_chat_history", { id, before, limit }),');
    expect(ipcTs).toContain('appUsageSummary: () => call<UsageSummary>("app_usage_summary"),');
  });

  it("기록은 앱이 받은 이벤트에서만 만든다 — CLI 기록 파일(~/.claude/projects)을 읽지 않고, 원본 출력 · 도구 결과 원문을 저장하지 않는다 (D-24)", () => {
    for (const [name, source] of [
      ["chat.rs", historyChatRs],
      ["record.rs", historyRecordRs],
      ["usage.rs", historyUsageRs],
      ["writer.rs", historyWriterRs],
    ] as const) {
      const production = source.slice(0, source.indexOf("#[cfg(test)]"));
      expect(production, `history/${name}`).not.toMatch(/\.claude|claude_dir|read_dir|fs::|std::fs|File::open|projects_dir/);
    }
    // 저장하지 않는 이벤트는 `wants` 가 거른다
    const wants = historyRecordRs.slice(historyRecordRs.indexOf("pub fn wants("));
    const wantsBody = wants.slice(0, wants.indexOf("\n}\n"));
    expect(wantsBody).toContain("SessionEvent::RawLog(_)");
    expect(wantsBody).toContain("SessionEvent::TurnStarted { .. }");
    expect(wantsBody).toContain("SessionEvent::Warning { .. }");
    expect(wantsBody).toContain("SessionEvent::ToolResult { is_error, .. } => *is_error");
  });

  it("세션은 등록된 프로젝트 번호로만 시작한다 — 화면이 경로 · 모델 · 수준 · 실행 인자를 보내는 길이 없다 (D-47)", async () => {
    // 1) Rust: 입력은 번호 · 이어 하기 · API 키 허용뿐이고 모르는 필드는 거절한다
    expect(rustFields(eventsRs, "StartRequest")).toEqual(["projectId", "resume", "useApiKey"]);
    expect(eventsRs).toContain('#[serde(rename_all = "camelCase", deny_unknown_fields)]\npub struct StartRequest {');
    const requestBody = eventsRs.slice(eventsRs.indexOf("pub struct StartRequest {"));
    expect(requestBody.slice(0, requestBody.indexOf("\n}"))).toContain("pub project_id: i64,");
    // 2) Rust 명령: 시작은 앱이 채우는 것(manager · db · projects)과 `request` 하나, 마지막 세션은 `project_id: i64` 하나
    const commandsRs = (await import("../../src-tauri/src/claude/commands.rs?raw")).default;
    const signature = (name: string) => {
      const match = new RegExp(String.raw`#\[tauri::command\]\s+pub async fn ${name}\(([^)]*)\)`).exec(commandsRs);
      if (!match) throw new Error(`${name} not found`);
      return (match[1] as string)
        .replace(/State<[^>]*>/g, "State")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
    };
    expect(signature("claude_session_start")).toEqual(["manager: State", "db: State", "projects: State", "request: StartRequest"]);
    expect(signature("claude_last_session")).toEqual(["manager: State", "db: State", "project_id: i64"]);
    expect(commandsRs).not.toContain("PathBuf");
    // 3) 모델 · 수준은 Rust 가 하네스 설정에서 읽는다 (시작 계획 `StartPlan` 은 화면에서 받을 수 없다 — Deserialize 가 없다)
    const launchRs = (await import("../../src-tauri/src/claude/launch.rs?raw")).default;
    const planHead = launchRs.slice(launchRs.indexOf("pub struct StartPlan {") - 120, launchRs.indexOf("pub struct StartPlan {"));
    expect(planHead).not.toContain("Deserialize");
    expect(launchRs).toContain("planner_here()");
    // 4) 화면 쪽: 호출은 `{ request }` 와 `{ projectId }` 뿐, 타입에 경로 · 모델 · 수준 칸이 없다
    const ipcTs = (await import("./ipc.ts?raw")).default;
    expect(ipcTs).toContain('claudeSessionStart: (request: StartRequest) => call<StartInfo>("claude_session_start", { request }),');
    expect(ipcTs).toContain('claudeLastSession: (projectId: number) => call<string | null>("claude_last_session", { projectId }),');
    expect(sorted(Object.keys(TS_SESSION_FIELDS.StartRequest))).toEqual(["projectId", "resume", "useApiKey"]);
  });

  it("스킬 목록 명령은 화면에서 아무 값도 받지 않는다 (경로 · 폴더 이름을 받는 길이 없다)", async () => {
    const skillsCommands = (await import("../../src-tauri/src/skills/commands.rs?raw")).default;
    const signatures = [...skillsCommands.matchAll(/#\[tauri::command\]\s+pub async fn (skills_[a-z_]+)\(([^)]*)\)/g)];
    expect(signatures.map((m) => m[1])).toEqual(["skills_list"]);
    expect((signatures[0]?.[2] as string).trim()).toBe("");
    const ipcTs = (await import("./ipc.ts?raw")).default;
    expect(ipcTs).toContain('skillsList: () => call<SkillsList>("skills_list"),');
    // 읽기만 한다 — 스킬 파일을 쓰거나 지우는 코드가 없다
    const production = skillsRs.slice(0, skillsRs.indexOf("#[cfg(test)]"));
    expect(production).not.toMatch(/fs::(write|remove_|create_dir|rename|copy|File::create|OpenOptions)/);
  });

  it("화면이 듣는 이벤트 이름은 commands.rs 와 같다", async () => {
    const commandsRs = (await import("../../src-tauri/src/claude/commands.rs?raw")).default;
    const { CLAUDE_SESSION_EVENT } = await import("./ipc");
    expect(commandsRs).toContain(`pub const SESSION_EVENT: &str = "${CLAUDE_SESSION_EVENT}";`);
  });

  it("화면이 부르는 명령 이름은 모두 Rust 에 등록돼 있다 (lib.rs 목록)", async () => {
    const libRs = (await import("../../src-tauri/src/lib.rs?raw")).default;
    const ipcTs = (await import("./ipc.ts?raw")).default;
    const called = [...ipcTs.matchAll(/call<[^>]*>\("([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(called.length).toBeGreaterThan(8);
    for (const command of called) {
      if (command === "app_info") continue;
      const module = command.startsWith("harness_")
        ? "harness"
        : command.startsWith("agents_")
          ? "agents"
          : command.startsWith("usage_")
            ? "usage"
            : command.startsWith("skills_")
              ? "skills"
              : command === "project_chat_history" || command === "app_usage_summary"
                ? "history"
                : command.startsWith("project")
                  ? "projects"
                  : "claude";
      expect(libRs, `${command} 이 lib.rs 에 없음`).toContain(`${module}::commands::${command}`);
    }
    // 반대로, Rust 에 등록된 Claude · 하네스 명령은 화면이 모두 부른다 (안 쓰는 명령을 열어 두지 않는다)
    const registered = [
      ...libRs.matchAll(/claude::commands::(claude_[a-z_]+)/g),
      ...libRs.matchAll(/harness::commands::(harness_[a-z_]+)/g),
      ...libRs.matchAll(/agents::commands::(agents_[a-z_]+)/g),
      ...libRs.matchAll(/usage::commands::(usage_[a-z_]+)/g),
      ...libRs.matchAll(/skills::commands::(skills_[a-z_]+)/g),
      ...libRs.matchAll(/projects::commands::(projects?_[a-z_]+)/g),
      ...libRs.matchAll(/history::commands::([a-z_]+)/g),
    ].map((m) => m[1] as string);
    expect(sorted(registered)).toEqual(sorted(called.filter((c) => c !== "app_info")));
  });

  it("하네스 명령이 화면에서 받는 값은 백업 번호 하나뿐이다 (실행 파일 · 인자 · 경로 · URL 을 받는 길이 없다)", async () => {
    const commandsRs = (await import("../../src-tauri/src/harness/commands.rs?raw")).default;
    const signatures = [...commandsRs.matchAll(/#\[tauri::command\]\s+pub async fn (harness_[a-z_]+)\(([^)]*)\)/g)];
    expect(signatures.length).toBe(9);
    for (const [, name, params] of signatures) {
      const names = (params as string)
        .replace(/<[^>]*>/g, "") // `State<'_, HarnessState>` 안의 쉼표는 매개변수 구분이 아니다
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "")
        .map((p) => p.split(":")[0]?.trim());
      const allowed = name === "harness_status" ? [] : name === "harness_restore" || name === "harness_restore_plan" ? ["state", "backup_id"] : ["state"];
      expect(names, `${name} 의 매개변수`).toEqual(allowed);
    }
    // 화면 쪽 호출도 같다: 백업 번호 말고는 인자를 넘기지 않는다
    const ipcTs = (await import("./ipc.ts?raw")).default;
    const harnessCalls = [...ipcTs.matchAll(/harness[A-Za-z]+: \(([^)]*)\) => call<[^>]*>\("(harness_[a-z_]+)"(, \{[^}]*\})?/g)];
    expect(harnessCalls.length).toBe(9);
    for (const [, params, command, args] of harnessCalls) {
      const takesId = command === "harness_restore" || command === "harness_restore_plan";
      expect(params, command).toBe(takesId ? "backupId: string" : "");
      expect(args ?? "", command).toBe(takesId ? ", { backupId }" : "");
    }
  });

  it("에이전트 · 사용량 명령은 화면에서 아무 값도 받지 않는다 (경로 · 파일 이름 · 실행 파일 · 인자를 받는 길이 없다)", async () => {
    const agentsCommands = (await import("../../src-tauri/src/agents/commands.rs?raw")).default;
    const usageCommands = (await import("../../src-tauri/src/usage/commands.rs?raw")).default;
    const signatures = [
      ...agentsCommands.matchAll(/#\[tauri::command\]\s+pub async fn (agents_[a-z_]+)\(([^)]*)\)/g),
      ...usageCommands.matchAll(/#\[tauri::command\]\s+pub async fn (usage_[a-z_]+)\(([^)]*)\)/g),
    ];
    expect(signatures.map((m) => m[1]).sort()).toEqual(["agents_list", "usage_read"]);
    for (const [, name, params] of signatures) {
      const names = (params as string)
        .replace(/<[^>]*>/g, "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "")
        .map((p) => p.split(":")[0]?.trim());
      // `usage_read` 는 앱이 들고 있는 기억(State)만 받는다
      expect(names, `${name} 의 매개변수`).toEqual(name === "usage_read" ? ["state"] : []);
    }
    const ipcTs = (await import("./ipc.ts?raw")).default;
    expect(ipcTs).toContain('agentsList: () => call<AgentsList>("agents_list"),');
    expect(ipcTs).toContain('usageRead: () => call<UsageResult>("usage_read"),');
  });

  it("사용량을 읽는 코드는 인자를 고정 목록으로 만들고, 받은 줄을 로그에 남기지 않는다", async () => {
    const fetchRs = (await import("../../src-tauri/src/usage/fetch.rs?raw")).default;
    expect(fetchRs).toContain("cmd.command(build_args())");
    const logCalls = [...fetchRs.matchAll(/log::(?:info|warn|error|debug)!\(([^;]*)\);/g)];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call[1], "로그에 받은 줄이 들어감").not.toMatch(/\b(line|value|report|buf)\b/);
    }
  });

  it("쓰는 하네스 명령은 모두 flow 를 거친다 — 한 번에 하나 잠금과 본 것만 한다 규칙을 건너뛰는 명령이 없다", async () => {
    const commandsRs = (await import("../../src-tauri/src/harness/commands.rs?raw")).default;
    const flowRs = (await import("../../src-tauri/src/harness/flow.rs?raw")).default;
    const bodies = [...commandsRs.matchAll(/#\[tauri::command\]\s+pub async fn (harness_[a-z_]+)\([^)]*\)[^{]*\{([\s\S]*?)\n\}/g)];
    expect(bodies.length).toBe(9);
    const expected: Record<string, string> = {
      harness_clone: "clone_origin",
      harness_update_check: "update_check",
      harness_update_pull: "update_pull",
      harness_install_plan: "install_plan",
      harness_install: "install",
      harness_backups: "backups_list",
      harness_restore_plan: "restore_plan",
      harness_restore: "restore",
    };
    for (const [, name, body] of bodies) {
      if (name === "harness_status") continue; // 읽기만 한다 — 잠그지 않는다
      expect(body, `${name} 은 flow::${expected[name as string]} 를 불러야 한다`).toMatch(new RegExp(`flow::${expected[name as string]}\\b`));
      // git · 스크립트를 직접 부르지 않는다 (잠금 · 기억을 건너뛰게 된다)
      expect(body, `${name} 이 git/script 를 직접 부름`).not.toMatch(/\b(git|script)::/);
    }
    // flow 의 함수는 모두 맨 앞에서 잠금(begin)을 잡는다
    const fns = [...flowRs.matchAll(/pub fn ([a-z_]+)\([^)]*\)[^{]*\{\n([\s\S]*?)\n\}/g)];
    expect(fns.map((m) => m[1]).sort()).toEqual(Object.values(expected).sort());
    for (const [, name, body] of fns) {
      expect((body as string).trimStart(), `flow::${name} 은 맨 앞에서 잠금을 잡아야 한다`).toMatch(/^let (_guard|guard) = state\.begin\(\)\?;/);
    }
  });

  it("창 권한(capabilities)은 하네스 때문에 넓어지지 않았다 — 앱 명령만 더했다", async () => {
    const capability = JSON.parse((await import("../../src-tauri/capabilities/default.json?raw")).default) as {
      permissions: string[];
    };
    expect(capability.permissions).toEqual(["core:default"]);
  });

  it("폴더 고르기(dialog)는 Rust 에서만 쓴다 — 화면 권한에 dialog · fs 가 없고, fs 플러그인은 등록하지 않는다 (D-47)", async () => {
    const capabilityText = (await import("../../src-tauri/capabilities/default.json?raw")).default;
    expect(capabilityText).not.toMatch(/dialog|fs:/);
    const libRs = (await import("../../src-tauri/src/lib.rs?raw")).default;
    expect(libRs).toContain(".plugin(tauri_plugin_dialog::init())");
    expect(libRs).not.toContain("tauri_plugin_fs");
    // 화면 쪽 코드에서 dialog · fs 플러그인 API 를 가져오지 않는다
    const ipcTs = (await import("./ipc.ts?raw")).default;
    expect(ipcTs).not.toMatch(/plugin-dialog|plugin-fs/);
  });

  it("오류 · 이벤트가 아닌 모양(null · 숫자 · 종류만 있고 문구가 없는 객체)도 internal AppError 가 된다", () => {
    for (const raw of [null, undefined, 42, {}, { kind: "internal" }, { kind: "session_running" }, { message: "m" }]) {
      const error = toAppError(raw);
      expect(error).toBeInstanceOf(AppError);
      expect(error.kind).toBe("internal");
    }
    const same = new AppError("no_session", "x");
    expect(toAppError(same)).toBe(same);
    expect(toAppError(new Error("boom"))).toMatchObject({ kind: "internal", message: "boom" });
  });
});
