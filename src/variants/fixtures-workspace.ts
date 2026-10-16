// 작업 공간 가짜 데이터 (P2-03 → P2-14 화면 설계 묶음 2). 실제 데이터 · IPC 와 연결하지 않는다.
// 기능 단계에서 같은 모양으로 바꾼다 — 세션 이벤트(P3) · 프로젝트 · 편집기(P6) · 단계 보드 · 기록(P7). 데이터 모양은 지시서 P2-14 보고.
// 본보기: 하네스가 실제로 쓰는 문서 — dev-plan.md 단계 표, handoff.md 진행 중인 작업, 지시서 이름, 승인 게이트 4항목, 질문은 선택지(권장 첫 번째).
// 문구는 ko.ts 에. 명령 · 경로 · 원본 출력은 번역하지 않는 값.
import type { CatId } from "../components/cat/catalog";
import type { TextKey } from "../i18n/ko";
import { PROJECTS, type Activity, type ProjectFixture } from "./fixtures";

/**
 * 첫 번째가 기본. 오케스트레이터 상태 4가지(일하는 중 · 나를 기다림 · 쉬는 중 · 오류)를 카드 종류 · 오류 종류로 더 나눴다.
 * running 일하는 중 / waiting 질문 / approval 단계 승인 / permission 권한 / idle 쉬는 중 / error 오류 / limit 한도 /
 * offline 연결 끊김 / unreadable 보드 읽을 수 없음 / empty 새 프로젝트(빈 요구사항) / none 프로젝트 없음 / new 새 프로젝트 만들기 / many 여러 개
 */
export const WORK_STATES = [
  "running",
  "waiting",
  "approval",
  "permission",
  "idle",
  "error",
  "limit",
  "offline",
  "unreadable",
  "empty",
  "none",
  "new",
  "many",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** 오케스트레이터 상태 — 채팅 머리 · 프로젝트 줄 · 트레이가 같은 말을 쓴다 */
export type OrchStatus = "working" | "waiting" | "idle" | "error";

// ── 채팅 ──

export interface QuestionOption {
  id: string;
  labelKey: TextKey;
  /** 선택지 아래 한 줄 설명 (AskUserQuestion 의 description) */
  descKey?: TextKey;
  /** 고르기 전에 볼 수 있는 미리보기 (고정폭 글 — 화면 모양 · 코드) */
  previewKey?: TextKey;
  recommended?: boolean;
}

export interface Question {
  id: string;
  /** 짧은 머리표 (AskUserQuestion 의 header, 12자 안팎) */
  headerKey: TextKey;
  promptKey: TextKey;
  multi: boolean;
  options: QuestionOption[];
  writeIn: boolean;
  /** 이미 답한 카드면 고른 선택지 id ("write" = 직접 씀) */
  answer?: string[];
  /** 직접 쓴 답 */
  writeInKey?: TextKey;
}

export type PermissionTool = "Bash" | "Write" | "Edit" | "WebFetch";

export interface PermissionRequest {
  tool: PermissionTool;
  /** 실행할 명령 (Bash) 또는 주소 (WebFetch) */
  command?: string;
  /** 고칠 · 만들 파일 (Write · Edit) — 프로젝트 폴더 기준 */
  path?: string;
  /** 바뀌는 줄 수 (Write · Edit) */
  lines?: { add: number; del: number };
  /** 어디에서 (작업 폴더) */
  cwd: string;
  /** 누가 · 왜 */
  whyKey: TextKey;
  /** "항상 허용" 이면 settings.local.json 의 permissions.allow 에 더할 규칙 (D-23) */
  rule: string;
}

export type NoticeTone = "stopped" | "error" | "limit" | "offline" | "phase";

export type ChatItem =
  | { kind: "user"; id: string; textKey: TextKey; skill?: string; time: string }
  | { kind: "orch"; id: string; textKey: TextKey; time: string }
  | { kind: "question"; id: string; questions: Question[]; done: boolean; time: string }
  | ({ kind: "permission"; id: string; result?: "allow" | "deny" | "always"; time: string } & PermissionRequest)
  | {
      kind: "approval";
      id: string;
      titleKey: TextKey;
      whatKey: TextKey;
      whyKey: TextKey;
      outputKeys: TextKey[];
      notKeys: TextKey[];
      done: boolean;
      time: string;
    }
  | { kind: "runcheck"; id: string; command: string; lookKeys: TextKey[]; done: boolean; time: string }
  /** 앱이 끼워 넣는 알림 줄 — 중단 · 오류 · 한도 · 연결 끊김 · 단계 끝 */
  | { kind: "notice"; id: string; tone: NoticeTone; titleKey: TextKey; bodyKey?: TextKey; time: string };

// ── 진행 보기 ──

/** done 끝남 · now 지금 · waiting 나를 기다림 · todo 아직 */
export type PhaseStatus = "done" | "now" | "waiting" | "todo";

/** 단계 안의 작업 = 지시서 한 장 (handoff.md "진행 중인 작업" 표) */
export type TaskStatus = "assigned" | "back" | "passed" | "redo";

export interface PhaseTask {
  id: string;
  labelKey: TextKey;
  cat: CatId;
  status: TaskStatus;
}

export interface Phase {
  id: string;
  labelKey: TextKey;
  owners: CatId[];
  status: PhaseStatus;
  /** 지금 · 기다림 단계만 펼쳐 보인다 */
  tasks?: PhaseTask[];
}

export type LogKind = "start" | "assign" | "back" | "pass" | "ask" | "error" | "stop" | "phase";

export interface LogItem {
  time: string;
  cat: CatId;
  kind: LogKind;
  textKey: TextKey;
}

export interface WorkingCat {
  cat: CatId;
  activity: Activity;
  /** 무엇을 (지시서 이름 · 기다리는 것) */
  taskKey: TextKey;
  /** 얼마나 됐나 (분) */
  minutes: number;
}

// ── 프로젝트 ──

export interface ProjectRow extends ProjectFixture {
  status: OrchStatus;
  /** 폴더를 옮기거나 지워 찾을 수 없음 */
  missing?: boolean;
}

export interface EditorFixture {
  /** null = 비었음 */
  textKey: TextKey | null;
  path: string;
  /** saved 저장됨 · external 다른 곳(터미널)에서 바뀜 */
  status: "saved" | "external";
}

/** 채팅 입력줄 자리를 대신하는 띠 — 이때는 보낼 수 없다 */
export type RunBar = "error" | "limit" | "offline";

export interface WorkspaceFixture {
  state: WorkState;
  status: OrchStatus;
  /** 상태 옆 덧말 (예: 한도 — 15:20 에 다시) */
  statusNoteKey?: TextKey;
  projects: readonly ProjectRow[];
  selectedId: string | null;
  editor: EditorFixture;
  chat: ChatItem[];
  /** null = 아직 계획 없음, "unreadable" = dev-plan.md 를 읽을 수 없음 (D-22) */
  phases: Phase[] | null | "unreadable";
  working: WorkingCat[];
  log: LogItem[];
  raw: string[];
  pending: number;
  runBar?: RunBar;
  /** 새 프로젝트 창을 열어 둔 채로 */
  dialog?: "new";
}

// ── 대화 ──

const HISTORY: ChatItem[] = [
  { kind: "user", id: "m1", textKey: "variant.fixture.chat.u1", skill: "/desktop-app", time: "09:12" },
  { kind: "orch", id: "m2", textKey: "variant.fixture.chat.o1", time: "09:12" },
  {
    kind: "question",
    id: "q1",
    done: true,
    time: "09:13",
    questions: [
      {
        id: "q1a",
        headerKey: "variant.fixture.chat.q1a.h",
        promptKey: "variant.fixture.chat.q1a",
        multi: false,
        writeIn: true,
        answer: ["A"],
        options: [
          { id: "A", labelKey: "variant.fixture.chat.q1a.A", recommended: true },
          { id: "B", labelKey: "variant.fixture.chat.q1a.B" },
          { id: "C", labelKey: "variant.fixture.chat.q1a.C" },
        ],
      },
      {
        id: "q1b",
        headerKey: "variant.fixture.chat.q1b.h",
        promptKey: "variant.fixture.chat.q1b",
        multi: true,
        writeIn: false,
        answer: ["A", "B"],
        options: [
          { id: "A", labelKey: "variant.fixture.chat.q1b.A", recommended: true },
          { id: "B", labelKey: "variant.fixture.chat.q1b.B" },
          { id: "C", labelKey: "variant.fixture.chat.q1b.C" },
        ],
      },
    ],
  },
  {
    kind: "approval",
    id: "a1",
    done: true,
    time: "09:20",
    titleKey: "variant.fixture.chat.a1.title",
    whatKey: "variant.fixture.chat.a1.what",
    whyKey: "variant.fixture.chat.a1.why",
    outputKeys: ["variant.fixture.chat.a1.out1", "variant.fixture.chat.a1.out2"],
    notKeys: ["variant.fixture.chat.a1.not1", "variant.fixture.chat.a1.not2"],
  },
  {
    kind: "permission",
    id: "p1",
    time: "09:24",
    tool: "Bash",
    command: "npm create tauri-app@latest cat-album",
    cwd: "C:\\dev",
    whyKey: "variant.fixture.chat.p1.why",
    rule: "Bash(npm create:*)",
    result: "always",
  },
  {
    kind: "runcheck",
    id: "r1",
    done: true,
    time: "09:31",
    command: "npm run tauri dev",
    lookKeys: ["variant.fixture.chat.r1.look1", "variant.fixture.chat.r1.look2"],
  },
  {
    kind: "permission",
    id: "p2",
    time: "09:44",
    tool: "Write",
    path: "src\\album\\AlbumGrid.tsx",
    lines: { add: 64, del: 0 },
    cwd: "C:\\dev\\cat-album",
    whyKey: "variant.fixture.chat.p2.why",
    rule: "Write(src/**)",
    result: "allow",
  },
  { kind: "orch", id: "m3", textKey: "variant.fixture.chat.o2", time: "09:40" },
];

const QUESTION_PENDING: ChatItem[] = [
  { kind: "orch", id: "m4", textKey: "variant.fixture.chat.o3", time: "09:58" },
  {
    kind: "question",
    id: "q2",
    done: false,
    time: "09:58",
    questions: [
      {
        id: "q2a",
        headerKey: "variant.fixture.chat.q2a.h",
        promptKey: "variant.fixture.chat.q2a",
        multi: false,
        writeIn: true,
        options: [
          {
            id: "A",
            labelKey: "variant.fixture.chat.q2a.A",
            descKey: "variant.fixture.chat.q2a.A.desc",
            previewKey: "variant.fixture.chat.q2a.A.preview",
            recommended: true,
          },
          {
            id: "B",
            labelKey: "variant.fixture.chat.q2a.B",
            descKey: "variant.fixture.chat.q2a.B.desc",
            previewKey: "variant.fixture.chat.q2a.B.preview",
          },
          {
            id: "C",
            labelKey: "variant.fixture.chat.q2a.C",
            descKey: "variant.fixture.chat.q2a.C.desc",
            previewKey: "variant.fixture.chat.q2a.C.preview",
          },
        ],
      },
      {
        id: "q2b",
        headerKey: "variant.fixture.chat.q2b.h",
        promptKey: "variant.fixture.chat.q2b",
        multi: true,
        writeIn: false,
        options: [
          { id: "A", labelKey: "variant.fixture.chat.q2b.A", recommended: true },
          { id: "B", labelKey: "variant.fixture.chat.q2b.B" },
          { id: "C", labelKey: "variant.fixture.chat.q2b.C" },
        ],
      },
    ],
  },
];

const APPROVAL_PENDING: ChatItem[] = [
  { kind: "notice", id: "n-phase", tone: "phase", titleKey: "variant.fixture.notice.phase", time: "10:41" },
  { kind: "orch", id: "m5", textKey: "variant.fixture.chat.o4", time: "10:41" },
  {
    kind: "approval",
    id: "a2",
    done: false,
    time: "10:41",
    titleKey: "variant.fixture.chat.a2.title",
    whatKey: "variant.fixture.chat.a2.what",
    whyKey: "variant.fixture.chat.a2.why",
    outputKeys: ["variant.fixture.chat.a2.out1", "variant.fixture.chat.a2.out2", "variant.fixture.chat.a2.out3"],
    notKeys: ["variant.fixture.chat.a2.not1", "variant.fixture.chat.a2.not2"],
  },
];

const PERMISSION_PENDING: ChatItem[] = [
  { kind: "orch", id: "m6", textKey: "variant.fixture.chat.o5", time: "10:02" },
  {
    kind: "permission",
    id: "p3",
    time: "10:03",
    tool: "Bash",
    command: "npm install exifr",
    cwd: "C:\\dev\\cat-album",
    whyKey: "variant.fixture.chat.p3.why",
    rule: "Bash(npm install:*)",
  },
];

const IDLE_TAIL: ChatItem[] = [
  { kind: "notice", id: "n-phase", tone: "phase", titleKey: "variant.fixture.notice.phase", time: "10:41" },
  { kind: "orch", id: "m7", textKey: "variant.fixture.chat.o6", time: "10:42" },
];

const ERROR_TAIL: ChatItem[] = [
  {
    kind: "notice",
    id: "n-err",
    tone: "error",
    titleKey: "variant.fixture.notice.error",
    bodyKey: "variant.fixture.notice.errorBody",
    time: "10:07",
  },
];

const LIMIT_TAIL: ChatItem[] = [
  {
    kind: "notice",
    id: "n-limit",
    tone: "limit",
    titleKey: "variant.fixture.notice.limit",
    bodyKey: "variant.fixture.notice.limitBody",
    time: "10:12",
  },
];

const OFFLINE_TAIL: ChatItem[] = [
  {
    kind: "notice",
    id: "n-off",
    tone: "offline",
    titleKey: "variant.fixture.notice.offline",
    bodyKey: "variant.fixture.notice.offlineBody",
    time: "10:09",
  },
];

// ── 단계 보드 (dev-plan.md 단계 표 + handoff.md 진행 중인 작업) ──

const PHASE_BASE: Omit<Phase, "status">[] = [
  { id: "P0", labelKey: "variant.fixture.phase.p0", owners: ["mukmul"] },
  { id: "P1", labelKey: "variant.fixture.phase.p1", owners: ["nabi"] },
  { id: "P2", labelKey: "variant.fixture.phase.p2", owners: ["mulgam"] },
  { id: "P3", labelKey: "variant.fixture.phase.p3", owners: ["danchu", "nabi", "gureum"] },
  { id: "P4", labelKey: "variant.fixture.phase.p4", owners: ["nabi", "danchu"] },
  { id: "P5", labelKey: "variant.fixture.phase.p5", owners: ["gureum", "kkaebi"] },
  { id: "P6", labelKey: "variant.fixture.phase.p6", owners: ["nabi"] },
];

const P3_TASKS_RUNNING: PhaseTask[] = [
  { id: "P3-01", labelKey: "variant.fixture.task.p301", cat: "nabi", status: "passed" },
  { id: "P3-02", labelKey: "variant.fixture.task.p302", cat: "danchu", status: "assigned" },
  { id: "P3-03", labelKey: "variant.fixture.task.p303", cat: "gureum", status: "assigned" },
];

const P4_TASKS_PLAN: PhaseTask[] = [
  { id: "P4-01", labelKey: "variant.fixture.task.p401", cat: "nabi", status: "assigned" },
  { id: "P4-02", labelKey: "variant.fixture.task.p402", cat: "danchu", status: "assigned" },
];

/** current 단계(0부터) 앞은 끝남, 뒤는 아직 */
function phases(current: number, status: PhaseStatus, tasks?: PhaseTask[]): Phase[] {
  return PHASE_BASE.map((phase, index) => ({
    ...phase,
    status: index < current ? "done" : index === current ? status : "todo",
    tasks: index === current ? tasks : undefined,
  }));
}

// ── 요약 기록 ──

const LOG: LogItem[] = [
  { time: "09:40", cat: "mukmul", kind: "start", textKey: "variant.fixture.log.1" },
  { time: "09:41", cat: "nabi", kind: "assign", textKey: "variant.fixture.log.2" },
  { time: "09:52", cat: "nabi", kind: "back", textKey: "variant.fixture.log.3" },
  { time: "09:53", cat: "mukmul", kind: "pass", textKey: "variant.fixture.log.4" },
  { time: "09:54", cat: "danchu", kind: "assign", textKey: "variant.fixture.log.5" },
  { time: "09:55", cat: "gureum", kind: "assign", textKey: "variant.fixture.log.6" },
];

const RAW = [
  '{"type":"system","subtype":"init","cwd":"C:\\\\dev\\\\cat-album","model":"claude-opus","permissionMode":"default"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task","input":{"subagent_type":"harness-builder-system","description":"P3-01 사진 불러오기"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"src-tauri/src/photos.rs written, 6 tests passed"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task","input":{"subagent_type":"harness-builder-ui","description":"P3-02 앨범 바둑판 화면"}}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task","input":{"subagent_type":"harness-reviewer","description":"P3-03 키보드 점검"}}]}}',
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","utilization":0.42}}',
];

const RAW_ERROR = [
  ...RAW,
  "[stderr] API Error: 529 Overloaded",
  '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":1532204}',
  "process exited with code 1",
];

const RAW_LIMIT = [
  ...RAW,
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1792131600}}',
];

const RAW_OFFLINE = [...RAW, "[stderr] Connection error. Retrying in 8s… (attempt 2/5)"];

// ── 프로젝트 ──

const BASE_ROWS: ProjectRow[] = PROJECTS.map((project) => ({ ...project, status: project.running ? "working" : "idle" }));

/** 상태마다 고른 프로젝트(p1)의 상태를 바꿔 넣는다 */
function rows(status: OrchStatus): ProjectRow[] {
  return BASE_ROWS.map((row) => (row.id === "p1" ? { ...row, status, running: status !== "idle" } : row));
}

const NEW_PROJECT: ProjectRow = {
  id: "p0",
  nameKey: "variant.fixture.p0.name",
  path: "C:\\dev\\cat-diary",
  phaseKey: "variant.fixture.p0.phase",
  openedKey: "variant.fixture.p0.opened",
  running: false,
  status: "idle",
};

/** 프로젝트가 많을 때 — 돌아가는 것 · 최근 · 그 밖. 폴더를 찾을 수 없는 것 하나 */
const MANY_ROWS: ProjectRow[] = [
  ...rows("working"),
  {
    id: "p4",
    nameKey: "variant.fixture.p4.name",
    path: "C:\\dev\\recipe-box",
    phaseKey: "variant.fixture.p4.phase",
    openedKey: "variant.fixture.p4.opened",
    running: false,
    status: "idle",
  },
  {
    id: "p5",
    nameKey: "variant.fixture.p5.name",
    path: "D:\\work\\shop-admin",
    phaseKey: "variant.fixture.p5.phase",
    openedKey: "variant.fixture.p5.opened",
    running: false,
    status: "idle",
  },
  {
    id: "p6",
    nameKey: "variant.fixture.p6.name",
    path: "C:\\Users\\me\\Desktop\\study-timer",
    phaseKey: "variant.fixture.p6.phase",
    openedKey: "variant.fixture.p6.opened",
    running: false,
    status: "idle",
    missing: true,
  },
  {
    id: "p7",
    nameKey: "variant.fixture.p7.name",
    path: "C:\\dev\\plant-diary",
    phaseKey: "variant.fixture.p7.phase",
    openedKey: "variant.fixture.p7.opened",
    running: false,
    status: "idle",
  },
  {
    id: "p8",
    nameKey: "variant.fixture.p8.name",
    path: "C:\\dev\\team-lunch",
    phaseKey: "variant.fixture.p8.phase",
    openedKey: "variant.fixture.p8.opened",
    running: false,
    status: "idle",
  },
];

const EDITOR: EditorFixture = { textKey: "variant.fixture.req", path: "C:\\dev\\cat-album\\requirements.md", status: "saved" };

const RUNNING_CATS: WorkingCat[] = [
  { cat: "danchu", activity: "wheel", taskKey: "variant.fixture.task.p302", minutes: 12 },
  { cat: "gureum", activity: "tower", taskKey: "variant.fixture.task.p303", minutes: 3 },
];

export function workspaceFixture(state: WorkState): WorkspaceFixture {
  const base: WorkspaceFixture = {
    state,
    status: "working",
    projects: rows("working"),
    selectedId: "p1",
    editor: EDITOR,
    chat: HISTORY,
    phases: phases(3, "now", P3_TASKS_RUNNING),
    working: RUNNING_CATS,
    log: LOG,
    raw: RAW,
    pending: 0,
  };

  switch (state) {
    case "running":
    case "unreadable":
    case "many":
    case "new":
      return {
        ...base,
        phases: state === "unreadable" ? "unreadable" : base.phases,
        projects: state === "many" ? MANY_ROWS : base.projects,
        dialog: state === "new" ? "new" : undefined,
      };
    case "waiting":
      return {
        ...base,
        status: "waiting",
        projects: rows("waiting"),
        chat: [...HISTORY, ...QUESTION_PENDING],
        phases: phases(3, "waiting", P3_TASKS_RUNNING),
        working: [
          { cat: "mukmul", activity: "stone", taskKey: "variant.fixture.wait.question", minutes: 2 },
          { cat: "gureum", activity: "tower", taskKey: "variant.fixture.task.p303", minutes: 6 },
        ],
        log: [...LOG, { time: "09:58", cat: "mukmul", kind: "ask", textKey: "variant.fixture.log.ask" }],
        pending: 1,
      };
    case "approval":
      return {
        ...base,
        status: "waiting",
        projects: rows("waiting"),
        chat: [...HISTORY, ...APPROVAL_PENDING],
        phases: phases(4, "waiting", P4_TASKS_PLAN),
        working: [{ cat: "mukmul", activity: "stone", taskKey: "variant.fixture.wait.approval", minutes: 1 }],
        log: [
          ...LOG,
          { time: "10:38", cat: "gureum", kind: "back", textKey: "variant.fixture.log.7" },
          { time: "10:41", cat: "mukmul", kind: "phase", textKey: "variant.fixture.log.phase" },
          { time: "10:41", cat: "mukmul", kind: "ask", textKey: "variant.fixture.log.askApproval" },
        ],
        pending: 1,
      };
    case "permission":
      return {
        ...base,
        status: "waiting",
        projects: rows("waiting"),
        chat: [...HISTORY, ...PERMISSION_PENDING],
        phases: phases(3, "waiting", P3_TASKS_RUNNING),
        working: [
          { cat: "nabi", activity: "stone", taskKey: "variant.fixture.wait.permission", minutes: 1 },
          { cat: "danchu", activity: "wheel", taskKey: "variant.fixture.task.p302", minutes: 9 },
        ],
        log: [...LOG, { time: "10:03", cat: "nabi", kind: "ask", textKey: "variant.fixture.log.askPermission" }],
        pending: 1,
      };
    case "idle":
      return {
        ...base,
        status: "idle",
        projects: rows("idle"),
        editor: { ...EDITOR, status: "external" },
        chat: [...HISTORY, ...IDLE_TAIL],
        phases: phases(4, "todo"),
        working: [],
        log: [
          ...LOG,
          { time: "10:38", cat: "gureum", kind: "back", textKey: "variant.fixture.log.7" },
          { time: "10:41", cat: "mukmul", kind: "phase", textKey: "variant.fixture.log.phase" },
        ],
      };
    case "error":
      return {
        ...base,
        status: "error",
        projects: rows("error"),
        chat: [...HISTORY, ...ERROR_TAIL],
        working: [],
        log: [...LOG, { time: "10:07", cat: "mukmul", kind: "error", textKey: "variant.fixture.log.error" }],
        raw: RAW_ERROR,
        runBar: "error",
      };
    case "limit":
      return {
        ...base,
        status: "idle",
        statusNoteKey: "variant.ws.status.limitNote",
        projects: rows("idle"),
        chat: [...HISTORY, ...LIMIT_TAIL],
        working: [],
        log: [...LOG, { time: "10:12", cat: "mukmul", kind: "stop", textKey: "variant.fixture.log.limit" }],
        raw: RAW_LIMIT,
        runBar: "limit",
      };
    case "offline":
      return {
        ...base,
        status: "error",
        statusNoteKey: "variant.ws.status.offlineNote",
        projects: rows("error"),
        chat: [...HISTORY, ...OFFLINE_TAIL],
        raw: RAW_OFFLINE,
        runBar: "offline",
      };
    case "empty":
      return {
        ...base,
        status: "idle",
        projects: [NEW_PROJECT, ...rows("working")],
        selectedId: "p0",
        editor: { textKey: null, path: "C:\\dev\\cat-diary\\requirements.md", status: "saved" },
        chat: [],
        phases: null,
        working: [],
        log: [],
        raw: [],
      };
    case "none":
      return {
        ...base,
        status: "idle",
        projects: [],
        selectedId: null,
        editor: { textKey: null, path: "", status: "saved" },
        chat: [],
        phases: null,
        working: [],
        log: [],
        raw: [],
      };
  }
}

// ── 스킬 고르기 (채팅 입력줄) ──

export interface SkillChoice {
  id: string;
  descKey: TextKey;
  /** 하네스 원본 / 내가 만든 것 */
  mine?: boolean;
}

export const SKILLS: SkillChoice[] = [
  { id: "/desktop-app", descKey: "variant.fixture.skill.desktop" },
  { id: "/web-full", descKey: "variant.fixture.skill.webFull" },
  { id: "/web-lite", descKey: "variant.fixture.skill.webLite" },
  { id: "/harness-resume", descKey: "variant.fixture.skill.resume" },
  { id: "/harness-setup", descKey: "variant.fixture.skill.setup" },
  { id: "/translate-docs", descKey: "variant.fixture.skill.translate", mine: true },
];

// ── 새 프로젝트 창 ──

/** 고른 폴더를 살펴본 결과 (P6 — 폴더 안 requirements.md · handoff.md 를 찾는다) */
export type FolderFinding = "fresh" | "hasRequirements" | "hasHarness";

export const NEW_PROJECT_FOLDERS: Array<{ path: string; finding: FolderFinding }> = [
  { path: "C:\\dev\\cat-diary", finding: "fresh" },
  { path: "C:\\dev\\recipe-box", finding: "hasRequirements" },
  { path: "C:\\dev\\bakery-booking", finding: "hasHarness" },
];

export const PROJECT_SKILLS = ["/desktop-app", "/web-full", "/web-lite"] as const;
