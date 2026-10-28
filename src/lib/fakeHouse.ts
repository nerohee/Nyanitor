// 브라우저(`npm run dev`)에서 고양이 집 화면이 돌도록 하는 가짜 에이전트 목록 · 사용량. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/agents/` · `src-tauri/src/usage/`)와 같은 명령 · 결과 모양을 흉내 낸다. 실제 폴더 · CLI 는 건드리지 않는다.
// 고르는 법은 기존 가짜 화면(`variants/query.ts`)처럼 주소 쿼리:
//   ?usage=ok (기본) · ?usage=unavailable (= not_supported) · ?usage=<이유> (not_subscription · not_logged_in · no_claude · not_supported · timeout · failed)
//   ?agents=full (기본, 시제품 a 의 고양이 7마리가 다 나옴) · ?agents=no_harness (하네스 없음 = 빈 목록) · ?agents=broken (작업자 하나가 읽을 수 없음 + 설정이 깨짐)
// 시험은 `reset({...})` 로 쿼리 대신 값을 정한다.
import type { AgentEntry, AgentInfo, AgentRole, AgentsList, UsageResult, UsageUnavailableReason } from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

export type FakeUsageMode = "ok" | UsageUnavailableReason;
export type FakeAgentsMode = "full" | "no_harness" | "broken";

export interface FakeHouseOptions {
  usage: FakeUsageMode;
  agents: FakeAgentsMode;
}

const DEFAULTS: FakeHouseOptions = { usage: "ok", agents: "full" };

const USAGE_REASONS: readonly UsageUnavailableReason[] = ["not_subscription", "not_logged_in", "no_claude", "not_supported", "timeout", "failed"];
const AGENTS_MODES: readonly FakeAgentsMode[] = ["full", "no_harness", "broken"];

/** 주소 쿼리 → 가짜 설정. 모르는 값은 기본값 (`variants/query.ts` 의 `usage=unavailable` 과 같은 쪽으로 읽는다). */
export function parseFakeHouseQuery(search: string): FakeHouseOptions {
  const params = new URLSearchParams(search);
  const usage = params.get("usage");
  const agents = params.get("agents");
  return {
    usage: usage === "unavailable" ? "not_supported" : (USAGE_REASONS.find((reason) => reason === usage) ?? "ok"),
    agents: AGENTS_MODES.find((mode) => mode === agents) ?? "full",
  };
}

function worker(role: Exclude<AgentRole, "main">, name: string, description: string, model: string, effort: string, color: string, readOnly = false): AgentEntry {
  const info: AgentInfo = { role, file: `${name}.md`, name, description, model, effort, color, readOnly };
  return { state: "ok", ...info };
}

/** 이 PC 의 실제 설치와 같은 모양: 작업자 6 + 오케스트레이터 (파일 이름 순) */
function fullAgents(): AgentEntry[] {
  const main: AgentEntry = { state: "ok", role: "main", file: null, name: "main", description: null, model: "opus", effort: "high", color: null, readOnly: false };
  return [
    main,
    worker("system", "harness-builder-system", "시스템 엔지니어. 틀리면 비용이 큰 구현을 지시서대로 한다.", "sonnet", "high", "purple"),
    worker("ui", "harness-builder-ui", "화면 구현자. 고른 시안 · 디자인 토큰대로 화면을 만든다.", "sonnet", "medium", "blue"),
    worker("designer", "harness-designer", "디자이너(아트 디렉터). 방향 · 시안을 만들고 디자인 검수를 한다.", "opus", "high", "pink"),
    worker("helper", "harness-helper", "정리 담당. 판단이 필요 없는 일을 빠르고 정확하게 한다.", "haiku", "low", "green"),
    worker("reviewer", "harness-reviewer", "감사관(읽기 전용). 고치지 않고 찾기만 한다.", "opus", "high", "red", true),
    worker("tester", "harness-tester", "시험 작성자. 경계 · 실패 상황부터 시험을 쓴다.", "sonnet", "medium", "orange"),
  ];
}

function agentsFor(mode: FakeAgentsMode): AgentsList {
  if (mode === "no_harness") return { state: "no_harness", config: "none", agents: [], missingRoles: [] };
  if (mode === "broken") {
    // 설정이 깨지면 역할을 알 수 없다 — 파일 하나는 앞머리도 깨졌다
    const agents = fullAgents().map((entry): AgentEntry => {
      if (entry.state !== "ok") return entry;
      if (entry.role === "main") return { ...entry, model: null, effort: null };
      if (entry.file === "harness-tester.md") return { state: "unreadable", role: null, file: entry.file, reason: "no_frontmatter" };
      return { ...entry, role: null };
    });
    return { state: "ok", config: "unreadable", agents, missingRoles: [] };
  }
  return { state: "ok", config: "local", agents: fullAgents(), missingRoles: [] };
}

function usageFor(mode: FakeUsageMode, nowSeconds: number): UsageResult {
  if (mode !== "ok") return { state: "unavailable", reason: mode };
  return {
    state: "ok",
    fiveHour: { utilization: 0.42, resetsAt: nowSeconds + 2 * 3600, severity: "normal" },
    sevenDay: { utilization: 0.18, resetsAt: nowSeconds + 3 * 86400, severity: "normal" },
    scoped: [],
    extraUsageEnabled: false,
    readAt: nowSeconds,
  };
}

export function createFakeHouse() {
  /** 시험이 정한 값. 없으면 부를 때마다 주소 쿼리를 읽는다 (화면에서 쿼리를 바꿔 다시 열면 바뀐 값). */
  let override: FakeHouseOptions | null = null;
  const options = (): FakeHouseOptions => override ?? parseFakeHouseQuery(typeof window === "undefined" ? "" : window.location.search);

  const handlers: Record<string, Handler> = {
    agents_list: (): AgentsList => agentsFor(options().agents),
    usage_read: (): UsageResult => usageFor(options().usage, Math.floor(Date.now() / 1000)),
  };

  return {
    handlers,
    /** 시험용: 쿼리 대신 값을 정한다 (인자 없이 부르면 다시 쿼리를 읽는다) */
    reset(next?: Partial<FakeHouseOptions>) {
      override = next ? { ...DEFAULTS, ...next } : null;
    },
  };
}

export const fakeHouse = createFakeHouse();
