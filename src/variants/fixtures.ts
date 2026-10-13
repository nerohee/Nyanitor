// 시안 공통 가짜 데이터 (P2). 실제 데이터 · IPC 와 연결하지 않는다. 시안을 고른 뒤 같이 지운다.
// 에이전트 값은 ~/.claude/agents/harness-*.md 앞머리(model · effort)를 옮겨 왔다. 문구는 ko.ts 에.
import type { CatId } from "../components/cat/looks";
import type { TextKey } from "../i18n/ko";

/** 고양이가 지금 있는 자리 = 하는 일 (cat-assets.md §4). 캣휠 · 캣타워 = 일하는 중 */
export type Activity = "wheel" | "tower" | "window" | "sleep" | "eat" | "box" | "walk" | "idle";

export interface AgentFixture {
  cat: CatId;
  /** agents 폴더의 파일 이름. 오케스트레이터는 파일이 아니라 메인 대화 */
  agentFile: string | null;
  model: "Opus" | "Sonnet" | "Haiku";
  effort: "low" | "medium" | "high";
  activity: Activity;
}

export const AGENTS: readonly AgentFixture[] = [
  { cat: "nabi", agentFile: null, model: "Opus", effort: "high", activity: "window" },
  { cat: "mulgam", agentFile: "harness-designer.md", model: "Opus", effort: "high", activity: "sleep" },
  { cat: "danchu", agentFile: "harness-builder-ui.md", model: "Sonnet", effort: "medium", activity: "wheel" },
  { cat: "mukmul", agentFile: "harness-builder-system.md", model: "Sonnet", effort: "high", activity: "box" },
  { cat: "kkaebi", agentFile: "harness-tester.md", model: "Sonnet", effort: "medium", activity: "walk" },
  { cat: "dubu", agentFile: "harness-helper.md", model: "Haiku", effort: "low", activity: "eat" },
  { cat: "gureum", agentFile: "harness-reviewer.md", model: "Opus", effort: "high", activity: "tower" },
];

export function isWorking(activity: Activity): boolean {
  return activity === "wheel" || activity === "tower";
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

/** 사용량 (D-24). 한도 정보는 못 받을 수 있다 — 그래도 앱 세션 토큰 추정은 있다 */
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
