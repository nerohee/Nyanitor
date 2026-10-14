// 작업 공간 시안 가짜 데이터 (P2-03). fixtures.ts 와 함께 시안을 고른 뒤 지운다.
// 상태 3가지 — running(진행 중) · waiting(기다리는 카드가 있음, D-25) · empty(빈 프로젝트)
import type { CatId } from "../components/cat/catalog";
import type { TextKey } from "../i18n/ko";
import { PROJECTS, type Activity, type ProjectFixture } from "./fixtures";

export const WORK_STATES = ["running", "waiting", "empty"] as const;
export type WorkState = (typeof WORK_STATES)[number];

export interface QuestionOption {
  id: string;
  labelKey: TextKey;
  recommended?: boolean;
}

export interface Question {
  id: string;
  promptKey: TextKey;
  multi: boolean;
  options: QuestionOption[];
  writeIn: boolean;
  /** 이미 답한 카드면 고른 선택지 id */
  answer?: string[];
}

export type ChatItem =
  | { kind: "user"; id: string; textKey: TextKey; skill?: string; time: string }
  | { kind: "orch"; id: string; textKey: TextKey; time: string }
  | { kind: "question"; id: string; questions: Question[]; done: boolean; time: string }
  | {
      kind: "permission";
      id: string;
      tool: string;
      command: string;
      whyKey: TextKey;
      result?: "allow" | "deny" | "always";
      time: string;
    }
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
  | { kind: "runcheck"; id: string; command: string; lookKeys: TextKey[]; done: boolean; time: string };

export type PhaseStatus = "done" | "running" | "waiting" | "todo";

export interface Phase {
  id: string;
  labelKey: TextKey;
  owners: CatId[];
  status: PhaseStatus;
}

export interface LogItem {
  time: string;
  cat: CatId;
  textKey: TextKey;
}

export interface WorkingCat {
  cat: CatId;
  activity: Activity;
}

export interface WorkspaceFixture {
  state: WorkState;
  projects: readonly ProjectFixture[];
  selectedId: string;
  /** null = 요구사항이 비었음 */
  requirementsKey: TextKey | null;
  requirementsPath: string;
  chat: ChatItem[];
  phases: Phase[];
  working: WorkingCat[];
  log: LogItem[];
  raw: string[];
  orchestrator: "thinking" | "waiting" | "idle";
  pending: number;
}

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
    whyKey: "variant.fixture.chat.p1.why",
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
  { kind: "orch", id: "m3", textKey: "variant.fixture.chat.o2", time: "09:40" },
];

const WAITING_TAIL: ChatItem[] = [
  { kind: "orch", id: "m4", textKey: "variant.fixture.chat.o3", time: "09:58" },
  {
    kind: "question",
    id: "q2",
    done: false,
    time: "09:58",
    questions: [
      {
        id: "q2a",
        promptKey: "variant.fixture.chat.q2a",
        multi: false,
        writeIn: true,
        options: [
          { id: "A", labelKey: "variant.fixture.chat.q2a.A", recommended: true },
          { id: "B", labelKey: "variant.fixture.chat.q2a.B" },
          { id: "C", labelKey: "variant.fixture.chat.q2a.C" },
        ],
      },
      {
        id: "q2b",
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

const PHASE_BASE: Omit<Phase, "status">[] = [
  { id: "P0", labelKey: "variant.fixture.phase.p0", owners: ["mukmul"] },
  { id: "P1", labelKey: "variant.fixture.phase.p1", owners: ["nabi"] },
  { id: "P2", labelKey: "variant.fixture.phase.p2", owners: ["mulgam"] },
  { id: "P3", labelKey: "variant.fixture.phase.p3", owners: ["danchu", "gureum"] },
  { id: "P4", labelKey: "variant.fixture.phase.p4", owners: ["nabi"] },
  { id: "P5", labelKey: "variant.fixture.phase.p5", owners: ["gureum", "kkaebi"] },
  { id: "P6", labelKey: "variant.fixture.phase.p6", owners: ["nabi"] },
];

function phases(current: PhaseStatus | null): Phase[] {
  return PHASE_BASE.map((phase, index) => ({
    ...phase,
    status: current === null ? "todo" : index < 3 ? "done" : index === 3 ? current : "todo",
  }));
}

const LOG: LogItem[] = [
  { time: "09:40", cat: "mukmul", textKey: "variant.fixture.log.1" },
  { time: "09:41", cat: "danchu", textKey: "variant.fixture.log.2" },
  { time: "09:52", cat: "danchu", textKey: "variant.fixture.log.3" },
  { time: "09:53", cat: "gureum", textKey: "variant.fixture.log.4" },
];

const RAW = [
  '{"type":"system","subtype":"init","cwd":"C:\\\\dev\\\\cat-album"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task","input":{"subagent_type":"harness-builder-ui"}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"src/AlbumGrid.tsx written"}]}}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Task","input":{"subagent_type":"harness-reviewer"}}]}}',
  '{"type":"rate_limit_event","five_hour":{"used_percent":42}}',
];

const NEW_PROJECT: ProjectFixture = {
  id: "p0",
  nameKey: "variant.fixture.p0.name",
  path: "C:\\dev\\cat-diary",
  phaseKey: "variant.fixture.p0.phase",
  openedKey: "variant.fixture.p0.opened",
  running: false,
};

export function workspaceFixture(state: WorkState): WorkspaceFixture {
  if (state === "empty") {
    return {
      state,
      projects: [NEW_PROJECT, ...PROJECTS],
      selectedId: "p0",
      requirementsKey: null,
      requirementsPath: "C:\\dev\\cat-diary\\requirements.md",
      chat: [],
      phases: phases(null),
      working: [],
      log: [],
      raw: [],
      orchestrator: "idle",
      pending: 0,
    };
  }
  const waiting = state === "waiting";
  return {
    state,
    projects: PROJECTS,
    selectedId: "p1",
    requirementsKey: "variant.fixture.req",
    requirementsPath: "C:\\dev\\cat-album\\requirements.md",
    chat: waiting ? [...HISTORY, ...WAITING_TAIL] : HISTORY,
    phases: phases(waiting ? "waiting" : "running"),
    working: waiting
      ? [
          { cat: "mukmul", activity: "stone" },
          { cat: "gureum", activity: "tower" },
        ]
      : [
          { cat: "danchu", activity: "wheel" },
          { cat: "gureum", activity: "tower" },
        ],
    log: waiting ? [...LOG, { time: "09:58", cat: "mukmul", textKey: "variant.fixture.log.5" }] : LOG,
    raw: RAW,
    orchestrator: waiting ? "waiting" : "thinking",
    pending: waiting ? 1 : 0,
  };
}
