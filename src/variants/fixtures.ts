// 시안 공통 가짜 데이터 (P2). 실제 데이터 · IPC 와 연결하지 않는다. 시안을 고른 뒤 같이 지운다.
// 에이전트 값은 ~/.claude/agents/harness-*.md 앞머리(model · effort)를 옮겨 왔다. 문구는 ko.ts 에.
import { catForAgent, type CatId } from "../components/cat/catalog";
import { isWorkSpot, type Activity } from "../components/house/spots";
import type { TextKey } from "../i18n/ko";

export type { Activity };

export interface AgentFixture {
  /** 이 에이전트를 가리키는 고양이 (기본 연결 — agent-cats.json) */
  cat: CatId;
  /** 에이전트 이름 (메인 대화는 main) */
  agent: string;
  /** agents 폴더의 파일 이름. 오케스트레이터는 파일이 아니라 메인 대화 */
  agentFile: string | null;
  model: "Opus" | "Sonnet" | "Haiku";
  effort: "low" | "medium" | "high";
}

type AgentRow = Omit<AgentFixture, "cat">;

const AGENT_ROWS: readonly AgentRow[] = [
  { agent: "main", agentFile: null, model: "Opus", effort: "high" },
  { agent: "designer", agentFile: "harness-designer.md", model: "Opus", effort: "high" },
  { agent: "builder-ui", agentFile: "harness-builder-ui.md", model: "Sonnet", effort: "medium" },
  { agent: "builder-system", agentFile: "harness-builder-system.md", model: "Sonnet", effort: "high" },
  { agent: "tester", agentFile: "harness-tester.md", model: "Sonnet", effort: "medium" },
  { agent: "helper", agentFile: "harness-helper.md", model: "Haiku", effort: "low" },
  { agent: "reviewer", agentFile: "harness-reviewer.md", model: "Opus", effort: "high" },
];

export const AGENTS: readonly AgentFixture[] = AGENT_ROWS.map((row) => ({
  ...row,
  // 기본 연결은 모두 기본 7마리를 가리킨다
  cat: catForAgent(row.agent) as CatId,
}));

/** 오케스트레이터(메인 대화)를 가리키는 고양이 — 기본은 먹물 (D-37) */
export const ORCHESTRATOR: CatId = AGENTS[0].cat;

export function isWorking(activity: Activity): boolean {
  return isWorkSpot(activity);
}

export function agentOf(cat: CatId): AgentFixture {
  const found = AGENTS.find((agent) => agent.cat === cat);
  if (!found) throw new Error(`unknown cat: ${cat}`);
  return found;
}

export interface UsageWindow {
  percent: number;
  resetKey: TextKey;
}

/** 사용량 (D-24). 한도 정보는 못 받을 수 있다 — 그래도 앱 세션 츄르(토큰) 추정은 있다 — 화면에서는 "츄르" 라고 부른다 (D-43) */
export type UsageFixture =
  | { status: "ok"; fiveHour: UsageWindow; weekly: UsageWindow; sessionTokens: number }
  | { status: "unavailable"; sessionTokens: number };

export const USAGE_OK: UsageFixture = {
  status: "ok",
  fiveHour: { percent: 42, resetKey: "variant.fixture.resetFiveHour" },
  weekly: { percent: 18, resetKey: "variant.fixture.resetWeekly" },
  sessionTokens: 18400,
};

export const USAGE_UNAVAILABLE: UsageFixture = { status: "unavailable", sessionTokens: 18400 };

export interface ProjectFixture {
  id: string;
  nameKey: TextKey;
  path: string;
  phaseKey: TextKey;
  openedKey: TextKey;
  running: boolean;
}

export const PROJECTS: readonly ProjectFixture[] = [
  {
    id: "p1",
    nameKey: "variant.fixture.p1.name",
    path: "C:\\dev\\cat-album",
    phaseKey: "variant.fixture.p1.phase",
    openedKey: "variant.fixture.p1.opened",
    running: true,
  },
  {
    id: "p2",
    nameKey: "variant.fixture.p2.name",
    path: "C:\\dev\\bakery-booking",
    phaseKey: "variant.fixture.p2.phase",
    openedKey: "variant.fixture.p2.opened",
    running: false,
  },
  {
    id: "p3",
    nameKey: "variant.fixture.p3.name",
    path: "C:\\dev\\ledger",
    phaseKey: "variant.fixture.p3.phase",
    openedKey: "variant.fixture.p3.opened",
    running: false,
  },
];

/** 준비 상태 (plan §2) — 시안에서는 다 된 상태. 빠진 것 안내 화면은 P3 · P4 */
export const READINESS = { ready: 4, total: 4 } as const;

export function formatTokens(n: number): string {
  return n.toLocaleString("ko-KR");
}
