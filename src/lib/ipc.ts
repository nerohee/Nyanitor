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
  WINDOW_SHOWN_EVENT,
  toAppError,
  type AgentsList,
  type AppInfo,
  type ChatPage,
  type ClaudeEvent,
  type ClaudeResponse,
  type ClaudeSessionState,
  type ClaudeStatus,
  type CustomApplyResult,
  type CustomCatChange,
  type CustomCats,
  type CustomCatsWriteResult,
  type CustomChanges,
  type CustomCommitDiff,
  type CustomDiscardResult,
  type CustomHistory,
  type CustomItemRead,
  type CustomLabels,
  type CustomLabelWriteResult,
  type CustomList,
  type CustomNewItem,
  type CustomRestoreResult,
  type CustomValues,
  type CustomWriteResult,
  type DocRead,
  type DocsList,
  type GitResult,
  type HarnessStatus,
  type ProjectAddRequest,
  type ProjectEntry,
  type ProjectList,
  type ProjectPatch,
  type ProgressRead,
  type ProjectPickedFolder,
  type RawLogEntry,
  type RequirementsRead,
  type RequirementsVersion,
  type RequirementsWrite,
  type ScriptResult,
  type SkillsList,
  type StartInfo,
  type StartRequest,
  type StopInfo,
  type UsageResult,
  type UsageSummary,
  type WindowShownEvent,
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

/**
 * 숨어 있던(또는 최소화였던) 창이 열렸을 때를 듣는다 (D-50 · D-25 — 트레이 · 다시 실행). 앱이 처음 뜰 때는 오지 않는다.
 * 돌려주는 함수를 부르면 그만 듣는다. 브라우저에서는 가짜 모드가 흉내 낸다 (`fakeClaude.simulateWindowShown`).
 */
async function onWindowShown(handler: (event: WindowShownEvent) => void): Promise<() => void> {
  if (!inTauri()) {
    const { fakeClaude } = await loadFake().catch((raw: unknown) => {
      throw toAppError(raw);
    });
    return fakeClaude.subscribeWindowShown(handler);
  }
  const unlisten: UnlistenFn = await listen<WindowShownEvent>(WINDOW_SHOWN_EVENT, (event) => handler(event.payload));
  return unlisten;
}

export const ipc = {
  appInfo: () => call<AppInfo>("app_info"),

  /** claude 찾기 · 버전 · 로그인 상태 · API 키 있음 */
  claudeDiscover: () => call<ClaudeStatus>("claude_discover"),
  /** `claude auth login` 을 새 터미널 창으로 띄운다 (로그인은 Anthropic 의 흐름 — 앱은 로그인 화면을 만들지 않는다) */
  claudeOpenLogin: () => call<void>("claude_open_login"),
  /** 세션 시작 — **등록된 프로젝트 번호로만** (D-47). 폴더는 Rust 가 번호로 찾고, 모델 · 수준은 Rust 가 하네스 `planner` 설정에서 읽는다. 돌려주는 `model` · `effort` 가 실제로 쓴 값 */
  claudeSessionStart: (request: StartRequest) => call<StartInfo>("claude_session_start", { request }),
  claudeSessionSend: (text: string) => call<void>("claude_session_send", { text }),
  claudeSessionRespond: (requestId: string, response: ClaudeResponse) =>
    call<void>("claude_session_respond", { requestId, response }),
  claudeSessionInterrupt: () => call<void>("claude_session_interrupt"),
  claudeSessionStop: () => call<StopInfo>("claude_session_stop"),
  claudeSessionState: () => call<ClaudeSessionState>("claude_session_state"),
  /** 이 프로젝트(등록된 프로젝트 번호)의 마지막 세션 ID (이어 하기 가능한지) */
  claudeLastSession: (projectId: number) => call<string | null>("claude_last_session", { projectId }),
  claudeRawLog: () => call<RawLogEntry[]>("claude_raw_log"),
  onClaudeEvent,
  onWindowShown,

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

  // 내 수정 (P9-01, D-51). **넘기는 값은 항목 id · 값 · 글 · 새 항목 요청 · 커밋 번호 · 에이전트 이름 · 고양이 id 뿐이다** — 경로 · 파일 이름 · 실행 파일 · 인자를 넘기는 길은 없다 (Rust 가 모양을 다시 확인한다).
  // 항목 id: `main` (오케스트레이터) · `agent:<이름>` · `skill:<이름>` (이름은 `^[a-z][a-z0-9-]{0,63}$`). 상태 때문에 안 되는 일은 오류가 아니라 결과의 `outcome` · `reason` 이다.
  /** 목록 — 오케스트레이터 · 에이전트 · 스킬 (원본 + 내 수정에만 있는 것), 기록 상태, 적용 안 한 것 개수 · 파일. 하네스가 없으면 `available: false`. 잠그지 않는다 */
  customList: () => call<CustomList>("custom_list"),
  /** 항목 하나 읽기 — 원본 글(읽기 전용) · 덧붙임 글 · 통째 글 · 값. 비교(원본 ↔ 내 통째 글)는 두 글로 화면이 한다. 파일 하나 256KB 까지 (넘으면 그 부분 `too_large`) */
  customItemRead: (itemId: string) => call<CustomItemRead>("custom_item_read", { itemId }),
  /** 값 바꾸기 — 바라는 값 전체 (`null` = 원본 값으로 = 그 키를 지운다, 남은 키가 없으면 값 파일을 지운다). 에이전트 · 스킬 · `main`(하네스 설정 `planner`) 모두. 목록 밖 값은 `invalid_input` */
  customValuesSave: (itemId: string, values: CustomValues) => call<CustomWriteResult>("custom_values_save", { itemId, values }),
  /** 덧붙임 글 저장 — 원본 끝에 덧붙는다. 빈 글(공백뿐 포함) = 지움. 원본이 있는 에이전트 · 스킬만 (`main` · 내가 만든 것은 `not_supported`) */
  customAppendSave: (itemId: string, text: string) => call<CustomWriteResult>("custom_append_save", { itemId, text }),
  /** 통째 시작 — 지금 원본 글을 내 수정으로 복사하고 그때 원본 해시를 남긴다 (원본에 있는 것만) */
  customReplaceStart: (itemId: string) => call<CustomWriteResult>("custom_replace_start", { itemId }),
  /** 통째 글 저장 — 통째로 바꾼 것 · 내가 만든 것의 글. 에이전트는 둘째 줄 `name: <이름>` · `hooks:` 없음을 지켜야 한다 (아니면 `refused` · `invalid_agent`) */
  customTextSave: (itemId: string, text: string) => call<CustomWriteResult>("custom_text_save", { itemId, text }),
  /** 통째 그만 = **원본으로** (원본 바뀜의 "원본으로" 도 이것) — 통째 글과 원본 해시를 지운다. 값 · 덧붙임은 그대로. 원본에서 사라진 것은 `no_origin` */
  customReplaceStop: (itemId: string) => call<CustomWriteResult>("custom_replace_stop", { itemId }),
  /** 원본 바뀜 — **내 것 유지** (원본 해시를 지금 것으로 다시 쓴다. 원본에서 사라졌으면 `.origin` 만 지운다). 고른 뒤는 적용 안 한 것이 된다 */
  customOriginKeep: (itemId: string) => call<CustomWriteResult>("custom_origin_keep", { itemId }),
  /** 새 에이전트 · 스킬 만들기 — 틀 파일 하나. 거절: 원본에 같은 이름(`name_in_source`) · 내 수정에 이미 있음(`name_taken`). `~/.claude` 에 사용자 자신의 같은 이름 파일이 있으면 만들되 `notOurs: true` */
  customNew: (request: CustomNewItem) => call<CustomWriteResult>("custom_new", { request }),
  /** 내가 만든 것 지우기 (스킬은 폴더째). 원본에 있는 것은 `not_mine` (그만두려면 `customReplaceStop`) */
  customMineDelete: (itemId: string) => call<CustomWriteResult>("custom_mine_delete", { itemId }),
  /** 적용하면 바뀌는 것 — 적용 안 한 것의 파일별 줄 단위 차이 (상한 있음). 잠그지 않는다 */
  customChanges: () => call<CustomChanges>("custom_changes"),
  /** 적용 안 한 것 버리기 — 작업 트리를 마지막 적용 모습으로 (새 파일도 지운다) */
  customDiscard: () => call<CustomDiscardResult>("custom_discard"),
  /** 적용 — 적용 안 한 것이 있을 때만: 설치(`install --json`) → 성공하면 커밋. `summary` 는 한 줄 요약 (200자 · 한 줄로 Rust 가 다듬는다, `null` 이면 기본 문구). 실패하면 커밋하지 않고 `script` 로 이유를 보인다 */
  customApply: (summary: string | null = null) => call<CustomApplyResult>("custom_apply", { summary }),
  /** 기록 목록 — 최근 200개, 커밋마다 짧은 번호 · 때 · 메시지 · 종류 · 바뀐 파일. 잠그지 않는다 */
  customHistory: () => call<CustomHistory>("custom_history"),
  /** 커밋 하나의 차이 (`commit` = 기록 목록의 `hash` 또는 `short`, 7~40글자 16진수 소문자 — 모양이 틀리면 `invalid_input`) */
  customCommitDiff: (commit: string) => call<CustomCommitDiff>("custom_commit_diff", { commit }),
  /** 어느 때로 되돌리기 — 적용 안 한 것이 있으면 `has_unapplied`. 아니면 그때 모습 + 설치 + **새 커밋** (이력은 지우지 않는다). 설치가 실패하면 처음 모습으로 되돌려 놓는다 */
  customRestore: (commit: string) => call<CustomRestoreResult>("custom_restore", { commit }),
  /** 고양이 연결 읽기 — 파일에 적힌 것만 (기본 연결은 화면 쪽 `agent-cats.json`) */
  customCatsRead: () => call<CustomCats>("custom_cats_read"),
  /** 한 에이전트의 고양이 쓰기 (`agent` = 에이전트 이름 또는 `main`, `cat` = 고양이 id, `null` = 지움) — 그 파일만 바로 커밋한다 */
  customCatSave: (agent: string, cat: string | null) => call<CustomCatsWriteResult>("custom_cat_save", { agent, cat }),
  /** 여러 에이전트의 고양이를 한 번에 쓰기 (고양이 맞바꿈 · 모두 기본값으로) — 파일을 한 번 쓰고 커밋 하나. 1~64 줄, 같은 `agent` 가 두 번이면 `invalid_input`, 하나라도 모양이 틀리면 아무것도 쓰지 않는다. 바뀐 것이 없으면 `changed: false` · 커밋 없음 */
  customCatsSave: (changes: CustomCatChange[]) => call<CustomCatsWriteResult>("custom_cats_save", { changes }),
  /** 보이는 이름 읽기 — 직접 만든 에이전트의 화면 이름 (`custom/agent-labels.json`에 적힌 것만). 규칙에 어긋난 줄은 빼고 준다 */
  customLabelsRead: () => call<CustomLabels>("custom_labels_read"),
  /** 보이는 이름 쓰기 (`agent` = 에이전트 이름 — `main` · 모양이 틀린 이름은 `invalid_input`, `label` = 앞뒤 공백을 뗀 뒤 1~20 글자 · 줄바꿈 / 탭 / 제어 문자 없음, `null` 또는 빈 글 = 지움) — 그 파일만 바로 커밋한다. 이름이 규칙에 어긋나면 `refused` + `bad_label` */
  customLabelSave: (agent: string, label: string | null) => call<CustomLabelWriteResult>("custom_label_save", { agent, label }),

  // 고양이 집 (P5-01). 넘기는 값이 없다 — 경로 · 파일 이름 · 실행 파일 · 인자를 넘기는 길은 없다.
  /** 설치된 에이전트 목록 — 오케스트레이터 + `<설정 폴더>/agents/*.md` 앞머리. 깨진 파일 · 설정 · 하네스 없음은 오류가 아니라 결과의 상태다 */
  agentsList: () => call<AgentsList>("agents_list"),
  /** 설치된 스킬 목록 (P6-02) — `<설정 폴더>/skills/<이름>/SKILL.md` 앞머리. 채팅 입력줄이 고른다. 깨진 파일 · 하네스 없음은 오류가 아니라 결과의 상태다. 넘기는 값이 없다 */
  skillsList: () => call<SkillsList>("skills_list"),
  /** 구독 사용량 한도 (5시간 · 7일 · 초기화 시각) — 짧은 별도 세션으로 읽고 잠깐 기억한다. 못 받아도 오류가 아니라 `unavailable` 과 이유 */
  usageRead: () => call<UsageResult>("usage_read"),

  // 프로젝트 등록 · 요구사항 (P6-01). **경로 글자를 보내는 명령은 없다** (D-47) — 폴더는 Rust 가 대화상자로 받아 들고 있고, 나머지는 등록된 프로젝트 번호(`id`)로만 부른다.
  /** 등록된 프로젝트 — 최근에 연 순서. 폴더 상태(`ok` · `missing` · `unknown`)와 살펴본 결과 포함. DB 가 읽기 전용이면 `db: "read_only"` */
  projectsList: () => call<ProjectList>("projects_list"),
  /** 폴더 고르기 대화상자를 메인 창 위에 띄운다 (Rust). 취소면 `null`. 쓸 수 있는 폴더는 Rust 가 들고 있다가 `projectAdd` 때 그것만 등록한다 */
  projectPickFolder: () => call<ProjectPickedFolder | null>("project_pick_folder"),
  /** 고른 폴더를 등록한다 (고른 것이 없으면 `no_folder_picked`, 이미 등록됐으면 그 프로젝트를 돌려준다). 경로는 보내지 않는다 */
  projectAdd: (request: ProjectAddRequest = {}) => call<ProjectEntry>("project_add", { request }),
  /** 이름 · 스킬 고치기 (`skill: null` = 스킬 없음). 이름은 비면 거절 · 최대 `PROJECT_NAME_MAX_CHARS` 글자 */
  projectUpdate: (id: number, patch: ProjectPatch) => call<ProjectEntry>("project_update", { id, patch }),
  /** 목록에서 빼기 — 등록만 지운다 (폴더 · 파일은 그대로). 그 프로젝트의 세션이 시작 중이거나 돌고 있으면 `session_running` (끝낸 뒤에 뺀다 — 아무것도 지워지지 않는다) */
  projectRemove: (id: number) => call<void>("project_remove", { id }),
  /** 마지막으로 연 때를 지금으로 */
  projectTouch: (id: number) => call<void>("project_touch", { id }),
  // 채팅 기록 · 세션 츄르 (P6-03). 넘기는 값은 프로젝트 번호와 쪽 나누기 값뿐이다 — 경로 글자를 넘기는 길은 없다 (D-47).
  /** 프로젝트의 채팅 기록 한 쪽 — 최근 것부터, 쪽 안은 오래된 것이 앞. `before` 는 이미 가진 가장 오래된 항목의 `id`(없으면 `null` = 가장 최근부터), `limit` 은 1 이상(최대 `CHAT_PAGE_MAX`).
   *  답 없이 지나간 권한 · 질문 카드는 `request.status: "expired"`, 지금 세션이 기다리는 카드만 `"pending"`. 등록된 프로젝트가 아니면 `project_not_found` */
  projectChatHistory: (id: number, before: number | null, limit: number) => call<ChatPage>("project_chat_history", { id, before, limit }),
  /** 앱이 쓴 츄르 — 오늘(이 PC 의 자정부터) 합 · 프로젝트별 합 · 지금 돌고 있는 세션의 이번 실행 합. 구독이면 비용은 "참고용 추정"(`referenceOnly`). 넘기는 값이 없다 */
  appUsageSummary: () => call<UsageSummary>("app_usage_summary"),
  /** 그 프로젝트 폴더의 `requirements.md` 읽기 — BOM 은 떼서 준다 (`hasBom`), 줄바꿈은 그대로 */
  projectRequirementsRead: (id: number) => call<RequirementsRead>("project_requirements_read", { id }),
  /** 지금 파일의 `version` (싸다 — 창 포커스 · 몇 초마다 불러 바깥 변경을 안다) */
  projectRequirementsVersion: (id: number) => call<RequirementsVersion>("project_requirements_version", { id }),
  /** 쓰기 — 지금 파일이 `baseVersion` 과 다르면 쓰지 않고 `conflict`. 없던 파일을 새로 쓸 때는 `baseVersion: null` */
  projectRequirementsWrite: (id: number, text: string, baseVersion: string | null) =>
    call<RequirementsWrite>("project_requirements_write", { id, text, baseVersion }),

  // 프로젝트 문서 읽기 (P7-01, D-49) — 모두 읽기 전용이고 쓰는 명령은 없다. 프로젝트 번호로만 부른다 (`projectDocRead` 만 `docsDir` 안 상대 경로를 더한다 — Rust 가 다시 확인한다).
  /** 하네스 문서 — 단계 표(`dev-plan.md`) · 이어 하기 메모(`handoff.md`) · 작업의 지시서 진행률. 문서가 없으면 `absent`, 형식이 깨졌으면 `unreadable`(이유 포함) — 오류가 아니다 */
  projectProgressRead: (id: number) => call<ProgressRead>("project_progress_read", { id }),
  /** 하네스 문서가 바뀌었는지 싸게 묻는 값 (내용을 읽지 않는다 — 화면이 몇 초마다 부르고, 달라졌을 때만 `projectProgressRead`) */
  projectProgressVersion: (id: number) => call<string>("project_progress_version", { id }),
  /** 그 프로젝트 `docsDir` 아래 `.md` 목록 (숨은 폴더 · 폴더 밖 링크 제외, 상한을 넘으면 `truncated`) */
  projectDocsList: (id: number) => call<DocsList>("project_docs_list", { id }),
  /** 문서 하나 읽기. `path` 는 `projectDocsList` 가 준 경로 — 모양이 틀리면(`..` · 절대 경로 · `.md` 아님 …) `invalid_input` */
  projectDocRead: (id: number, path: string) => call<DocRead>("project_doc_read", { id, path }),
};
