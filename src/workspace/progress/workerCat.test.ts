// 작업자 이름 → 고양이 — 에이전트 목록에서 · 이름 모양으로 짐작 · 모르면 정리 담당(두부) · 사용자가 고친 연결이 먼저.
import { describe, expect, it } from "vitest";
import { resetMine, setMine } from "../../lib/mine";
import { FALLBACK_CAT } from "../../components/cat/catalog";
import type { AgentEntry, AgentRole, AgentsList } from "../../lib/ipc-types";
import { catForWorker, catName, rolesOfAgents, roleOfWorker, UNKNOWN_WORKER_ROLE } from "./workerCat";

const ok = (name: string, role: AgentRole | null): AgentEntry => ({ state: "ok", role, file: `${name}.md`, name, description: null, model: null, effort: null, color: null, readOnly: false });
const list = (agents: AgentEntry[]): AgentsList => ({ state: "ok", config: "local", agents, missingRoles: [] });

describe("이름 → 역할", () => {
  it("에이전트 목록에서 — 하네스 이름이 아닌 것도 목록이 역할을 주면 그 역할", () => {
    const roles = rolesOfAgents(list([ok("orchestrator", "main"), ok("front-end-cat", "ui"), ok("note-taker", null)]));
    expect(roleOfWorker("front-end-cat", roles)).toBe("ui");
    expect(roleOfWorker("orchestrator", roles)).toBe("main");
    // 역할이 없는 에이전트(하네스 밖)는 목록에 올리지 않는다
    expect(roles.has("note-taker")).toBe(false);
  });

  it("읽을 수 없는 파일은 파일 이름(.md 뺀 것)으로 — 설정이 가리킨 역할이 있을 때만", () => {
    const roles = rolesOfAgents(list([{ state: "unreadable", role: "tester", file: "harness-tester.md", reason: "no_frontmatter" }, { state: "unreadable", role: null, file: "x.md", reason: "not_utf8" }]));
    expect(roleOfWorker("harness-tester", roles)).toBe("tester");
    expect(roles.size).toBe(1);
  });

  it("목록이 없으면 harness-<역할> · harness-builder-<역할> 모양으로 짐작한다", () => {
    expect(roleOfWorker("harness-builder-ui")).toBe("ui");
    expect(roleOfWorker("harness-builder-system")).toBe("system");
    expect(roleOfWorker("harness-designer")).toBe("designer");
    expect(roleOfWorker("harness-tester")).toBe("tester");
    expect(roleOfWorker("harness-helper")).toBe("helper");
    expect(roleOfWorker("harness-reviewer")).toBe("reviewer");
  });

  it("목록에 없는 이름은 짐작보다 목록이 먼저 — 그리고 짐작도 못 하면 null", () => {
    const roles = rolesOfAgents(list([ok("harness-builder-ui", "designer")]));
    expect(roleOfWorker("harness-builder-ui", roles)).toBe("designer");
    expect(roleOfWorker("general-purpose")).toBeNull();
    expect(roleOfWorker("Explore")).toBeNull();
    expect(roleOfWorker("harness-builder-")).toBeNull();
    expect(roleOfWorker("harness-builder-frontend")).toBeNull();
  });
});

describe("이름 → 고양이", () => {
  it("목록에서 · 짐작으로 · 역할이 가리키는 고양이", () => {
    const roles = rolesOfAgents(list([ok("front-end-cat", "ui")]));
    expect(catForWorker("front-end-cat", { roles })).toBe("danchu");
    expect(catForWorker("harness-builder-system")).toBe("nabi");
    expect(catForWorker("harness-tester")).toBe("kkaebi");
    expect(catForWorker("harness-designer")).toBe("mulgam");
    expect(catForWorker("harness-reviewer")).toBe("gureum");
  });

  it("모르면(general-purpose · Explore) 정리 담당 고양이(두부) — 먹물이 아니다", () => {
    expect(UNKNOWN_WORKER_ROLE).toBe("helper");
    expect(catForWorker("general-purpose")).toBe("dubu");
    expect(catForWorker("Explore")).toBe("dubu");
    expect(catForWorker("general-purpose")).not.toBe(FALLBACK_CAT);
  });

  it("사용자가 고친 연결(D-31)이 있으면 그것이 먼저", () => {
    expect(catForWorker("harness-builder-ui", { user: { ui: "gureum" } })).toBe("gureum");
    // 목록에 없는 고양이를 가리키면 기본 연결로
    expect(catForWorker("harness-builder-ui", { user: { ui: "nope" } })).toBe("danchu");
  });

  it("고양이 이름", () => {
    expect(catName("danchu")).toBe("단추");
    expect(catName("mukmul")).toBe("먹물");
  });
});

describe("내 연결 (P9-05)", () => {
  it("내 연결(에이전트 이름)이 기본 연결(역할)보다 먼저", () => {
    expect(catForWorker("harness-builder-ui", { mine: { cats: { "harness-builder-ui": "gureum" }, labels: {} } })).toBe("gureum");
    // 직접 만든 에이전트 — 역할을 몰라 정리 담당으로 가던 것이 내 연결로
    expect(catForWorker("translator", { mine: { cats: { translator: "nabi" }, labels: {} } })).toBe("nabi");
    expect(catForWorker("translator")).toBe("dubu");
  });

  it("키는 에이전트 이름이다 — 역할 이름으로 적은 것은 보지 않고, 카탈로그에 없는 고양이는 건너뛴다", () => {
    expect(catForWorker("harness-builder-ui", { mine: { cats: { ui: "gureum" }, labels: {} } })).toBe("danchu");
    expect(catForWorker("harness-builder-ui", { mine: { cats: { "harness-builder-ui": "nope" }, labels: {} } })).toBe("danchu");
  });

  it("mine 을 안 주면 지금 들고 있는 것을 쓴다 (없으면 예전과 같다)", () => {
    setMine({ cats: { "harness-tester": "mulgam" }, labels: {} });
    try {
      expect(catForWorker("harness-tester")).toBe("mulgam");
    } finally {
      resetMine();
    }
    expect(catForWorker("harness-tester")).toBe("kkaebi");
  });
});
