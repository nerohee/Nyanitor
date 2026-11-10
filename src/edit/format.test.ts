// 「내 수정」 화면의 순수 계산 시험 — 항목 이름 · 고양이 · 적용 요약(바뀐 파일 모양 → 한 줄) · 기록 시각 · 거절 이유 / 설치 문제 문구.
import { describe, expect, it } from "vitest";
import type { AgentsList, CustomFileDiff, CustomListEntry, CustomMark, ScriptResult } from "../lib/ipc-types";
import { buildSummary, describeInstallFailure, formatWhen, itemCat, itemLabel, parseCustomPath, problemLine, refuseText, rolesOf, unreadableText } from "./format";

const agents = {
  state: "ok",
  config: "local",
  missingRoles: [],
  agents: [
    { state: "ok", role: "main", file: null, name: "main", description: null, model: null, effort: null, color: null, readOnly: false },
    { state: "ok", role: "ui", file: "harness-builder-ui.md", name: "harness-builder-ui", description: null, model: null, effort: null, color: null, readOnly: false },
    { state: "ok", role: "tester", file: "harness-tester.md", name: "harness-tester", description: null, model: null, effort: null, color: null, readOnly: false },
    { state: "ok", role: null, file: "translator.md", name: "translator", description: null, model: null, effort: null, color: null, readOnly: false },
    { state: "unreadable", role: "designer", file: "harness-designer.md", reason: "no_frontmatter" },
  ],
} as unknown as AgentsList;

const roles = rolesOf(agents);

function entry(id: string, kind: "main" | "agent" | "skill", name: string, marks: CustomMark[] = []): CustomListEntry {
  return {
    state: "ok",
    id,
    kind,
    name,
    description: null,
    file: "x",
    model: null,
    effort: null,
    myModel: null,
    myEffort: null,
    currentModel: null,
    currentEffort: null,
    marks,
    originChanged: null,
  };
}

function diff(path: string, ...plus: string[]): CustomFileDiff {
  return { path, status: "changed", binary: false, truncated: false, added: plus.length, removed: 0, lines: [{ sign: "@", text: "@@" }, ...plus.map((text, index) => ({ sign: "+" as const, text, new: index + 1 }))] };
}

describe("항목 이름 · 고양이", () => {
  it("역할이 있는 에이전트는 화면들이 쓰는 한국어 이름, 그 밖은 파일의 name, 오케스트레이터는 오케스트레이터", () => {
    expect(itemLabel("main", "main", roles)).toBe("오케스트레이터");
    expect(itemLabel("agent", "harness-builder-ui", roles)).toBe("화면 구현");
    expect(itemLabel("agent", "harness-designer", roles)).toBe("디자이너"); // 읽을 수 없는 파일도 역할은 안다
    expect(itemLabel("agent", "translator", roles)).toBe("translator");
    expect(itemLabel("skill", "desktop-app", roles)).toBe("desktop-app");
  });

  it("보이는 이름이 있으면 그것이 먼저 — 보이는 이름 → 역할 이름 → 파일 name. 스킬 · 오케스트레이터는 받지 않는다", () => {
    const labels = { translator: "번역", "harness-builder-ui": "내 화면 담당", "desktop-app": "스킬 이름", main: "먹물" };
    expect(itemLabel("agent", "translator", roles, labels)).toBe("번역");
    expect(itemLabel("agent", "harness-builder-ui", roles, labels)).toBe("내 화면 담당");
    expect(itemLabel("agent", "harness-tester", roles, labels)).toBe("시험");
    expect(itemLabel("agent", "other", roles, labels)).toBe("other");
    expect(itemLabel("skill", "desktop-app", roles, labels)).toBe("desktop-app");
    expect(itemLabel("main", "main", roles, labels)).toBe("오케스트레이터");
    expect(itemLabel("agent", "translator", roles, { translator: "" })).toBe("translator");
  });

  it("하네스를 설치하기 전(설치된 목록 없음)에도 설정의 대응으로 한국어 이름 · 기본 고양이 — 적용 기록 줄이 파일 이름으로 남지 않는다", () => {
    const before = rolesOf(null, { "harness-designer": "designer", "harness-builder-ui": "ui" });
    expect(itemLabel("agent", "harness-designer", before)).toBe("디자이너");
    expect(itemCat("agent", "harness-builder-ui", before, {})).toBe("danchu");
    expect(buildSummary({ files: [{ path: "agents/harness-designer.append.md", status: "added" }], items: [], roles: before })).toMatch(/^디자이너 — /);
    // 설치된 목록이 있으면 그 역할이 이긴다
    const both = rolesOf(agents, { "harness-builder-ui": "system" });
    expect(both.get("harness-builder-ui")).toBe("ui");
    expect(both.get("harness-tester")).toBe("tester");
  });

  it("고양이: 내 연결 → 기본 연결(역할) → 없음 — 스킬은 고양이가 없다, 모르는 고양이 id 는 건너뛴다", () => {
    expect(itemCat("main", "main", roles, {})).toBe("mukmul");
    expect(itemCat("agent", "harness-builder-ui", roles, {})).toBe("danchu");
    expect(itemCat("agent", "harness-builder-ui", roles, { "harness-builder-ui": "dubu" })).toBe("dubu");
    expect(itemCat("agent", "harness-builder-ui", roles, { "harness-builder-ui": "없는고양이" })).toBe("danchu");
    expect(itemCat("agent", "translator", roles, {})).toBeNull();
    expect(itemCat("agent", "translator", roles, { translator: "nabi" })).toBe("nabi");
    expect(itemCat("main", "main", roles, { main: "gureum" })).toBe("gureum");
    expect(itemCat("skill", "desktop-app", roles, {})).toBeNull();
  });
});

describe("parseCustomPath", () => {
  it("내 수정 폴더의 파일 모양 → 어느 항목의 무엇", () => {
    expect(parseCustomPath("agents/a.values.yml")).toEqual({ kind: "agent", name: "a", part: "values" });
    expect(parseCustomPath("agents/a.append.md")).toEqual({ kind: "agent", name: "a", part: "append" });
    expect(parseCustomPath("agents/a.md")).toEqual({ kind: "agent", name: "a", part: "whole" });
    expect(parseCustomPath("agents/a.md.origin")).toEqual({ kind: "agent", name: "a", part: "origin" });
    expect(parseCustomPath("skills/web-full/SKILL.append.md")).toEqual({ kind: "skill", name: "web-full", part: "append" });
    expect(parseCustomPath("skills/web-full/SKILL.md")).toEqual({ kind: "skill", name: "web-full", part: "whole" });
    expect(parseCustomPath("config.local.json")).toEqual({ kind: "main", name: "main", part: "values" });
    expect(parseCustomPath("agent-cats.json")?.part).toBe("cats");
    expect(parseCustomPath("agent-labels.json")).toEqual({ kind: "labels", name: "labels", part: "labels" });
    expect(parseCustomPath(".gitignore")).toBeNull();
    expect(parseCustomPath("agents/../x.md")).toBeNull();
  });
});

describe("buildSummary — 적용 요약 한 줄", () => {
  const items = [
    entry("agent:harness-builder-ui", "agent", "harness-builder-ui", ["values"]),
    entry("agent:harness-tester", "agent", "harness-tester", ["append"]),
    entry("agent:harness-designer", "agent", "harness-designer", ["replace"]),
    entry("agent:translator", "agent", "translator", ["mine"]),
    entry("main", "main", "main", ["values"]),
  ];
  const build = (files: Array<[string, "added" | "changed" | "removed"]>, diffs: CustomFileDiff[] = []) => buildSummary({ files: files.map(([path, status]) => ({ path, status })), diffs, items, roles });

  it("바뀐 항목이 하나면 「<이름> — <무엇>」 — 값은 바뀐 줄에서 구체적으로", () => {
    expect(build([["agents/harness-builder-ui.values.yml", "changed"]], [diff("agents/harness-builder-ui.values.yml", "effort: high")])).toBe("화면 구현 — 수준을 높음으로");
    expect(build([["agents/harness-builder-ui.values.yml", "added"]], [diff("agents/harness-builder-ui.values.yml", "model: opus")])).toBe("화면 구현 — 모델을 Opus로");
    expect(build([["agents/harness-builder-ui.values.yml", "changed"]], [diff("agents/harness-builder-ui.values.yml", "effort: low")])).toBe("화면 구현 — 수준을 낮음으로");
    expect(build([["agents/harness-builder-ui.values.yml", "changed"]], [diff("agents/harness-builder-ui.values.yml", "model: haiku", "effort: medium")])).toBe("화면 구현 — 모델 · 수준을 바꿈");
    expect(build([["agents/harness-builder-ui.values.yml", "changed"]])).toBe("화면 구현 — 모델 · 수준을 바꿈");
    expect(build([["agents/harness-builder-ui.values.yml", "removed"]])).toBe("화면 구현 — 값을 원본으로");
    expect(build([["config.local.json", "changed"]], [diff("config.local.json", '    "model": "sonnet",')])).toBe("오케스트레이터 — 모델을 Sonnet로");
  });

  it("덧붙임 · 통째 · 새 파일 · 지움", () => {
    expect(build([["agents/harness-tester.append.md", "added"]])).toBe("시험 — 지시 덧붙임");
    expect(build([["agents/harness-tester.append.md", "removed"]])).toBe("시험 — 덧붙임을 지움");
    expect(build([["agents/harness-designer.md", "changed"]])).toBe("디자이너 — 파일을 통째로 바꿈");
    // 통째 시작은 파일 + .origin — 한 말로 합친다
    expect(build([["agents/harness-designer.md", "added"], ["agents/harness-designer.md.origin", "added"]])).toBe("디자이너 — 파일을 통째로 바꿈");
    expect(build([["agents/translator.md", "added"]])).toBe("translator — 새로 만듦");
    expect(buildSummary({ files: [{ path: "agents/translator.md", status: "added" }], items, roles, labels: { translator: "번역" } })).toBe("번역 — 새로 만듦");
    expect(build([["agents/translator.md", "changed"]])).toBe("translator — 파일을 고침");
    expect(build([["agents/harness-designer.md", "removed"], ["agents/harness-designer.md.origin", "removed"]])).toBe("디자이너 — 통째 바꾼 것을 원본으로");
    expect(build([["agents/gone.md", "removed"]])).toBe("gone — 파일을 지움");
    expect(build([["agents/harness-designer.md.origin", "changed"]])).toBe("디자이너 — 원본 바뀜에서 고름");
  });

  it("보이는 이름 파일은 바로 커밋돼 적용 안 한 것에 나올 일이 드물지만 나오면 「보이는 이름을 바꿈」", () => {
    expect(build([["agent-labels.json", "changed"]])).toBe("이름 — 보이는 이름을 바꿈");
    expect(build([["agent-labels.json", "added"], ["agent-cats.json", "added"]])).toBe("이름 외 1개");
  });

  it("한 항목에 여러 가지면 「 · 」로 잇는다", () => {
    expect(build([["agents/harness-tester.append.md", "added"], ["agents/harness-tester.values.yml", "added"]], [diff("agents/harness-tester.values.yml", "effort: high")])).toBe("시험 — 지시 덧붙임 · 수준을 높음으로");
  });

  it("여러 항목이면 「<첫 이름> 외 n개」 — 같은 항목의 파일 여럿은 하나로 센다", () => {
    expect(build([["agents/harness-tester.append.md", "added"], ["agents/harness-builder-ui.values.yml", "changed"], ["agents/harness-tester.values.yml", "added"]])).toBe("시험 외 1개");
    expect(build([["agents/harness-tester.append.md", "added"], ["agents/harness-builder-ui.values.yml", "changed"], ["agents/translator.md", "added"]])).toBe("시험 외 2개");
  });

  it("모르는 파일만 있거나 아무것도 없으면 null (Rust 가 기본 메시지를 쓴다)", () => {
    expect(build([])).toBeNull();
    expect(build([[".gitignore", "changed"]])).toBeNull();
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 10, 9, 12, 0, 0);
  it("오늘은 시각, 어제는 어제, 그 전은 M월 D일 — 읽을 수 없는 시각은 그대로", () => {
    expect(formatWhen(new Date(2026, 10, 9, 9, 5).toISOString(), now)).toBe("오늘 09:05");
    expect(formatWhen(new Date(2026, 10, 8, 23, 59).toISOString(), now)).toBe("어제");
    expect(formatWhen(new Date(2026, 9, 12, 10, 0).toISOString(), now)).toBe("10월 12일");
    expect(formatWhen("어제쯤", now)).toBe("어제쯤");
  });
});

describe("거절 이유 · 설치 문제 문구", () => {
  it("알려진 이유는 쉬운 말, 모르는 이유는 코드 그대로", () => {
    expect(refuseText("too_large")).toBe("글이 너무 커요 (256KB 까지).");
    expect(refuseText("invalid_agent")).toContain("name: 이름");
    expect(refuseText("brand_new_reason")).toBe("brand_new_reason");
    expect(refuseText(null)).toBe("저장할 수 없었어요");
    expect(unreadableText("bad_values")).toBe("값 파일 모양이 올바르지 않아요.");
    expect(unreadableText("something")).toBe("something");
  });

  it("막는 문제 한 줄 — 알려진 코드는 쉬운 말 + 파일, 모르는 코드는 그대로", () => {
    expect(problemLine({ path: "agents/x.values.yml", reason: "badValues", detail: null })).toBe("값 파일 모양이 올바르지 않아요 — agents/x.values.yml");
    expect(problemLine({ path: null, reason: "newCode", detail: null })).toBe("newCode");
  });

  it("설치 실패 — 문제 목록 · 오류 코드 · 스크립트를 돌리지 못한 이유 · 상세를 모두 줄로, 아무것도 없으면 이유 모름", () => {
    const report = {
      problems: [{ path: "agents/a.md", reason: "invalidAgent", detail: null }],
      error: { code: "applyFailed", detail: "쓰다 멈춤" },
    } as unknown as ScriptResult["report"];
    const script = { outcome: "ran", report, reason: null } as unknown as ScriptResult;
    expect(describeInstallFailure(script, "git 이 느려요")).toEqual(["에이전트 파일 모양이 올바르지 않아요 (name · hooks) — agents/a.md", "설치를 마치지 못했어요 — 쓰다 멈춤", "git 이 느려요"]);
    expect(describeInstallFailure({ outcome: "timed_out", report: null, reason: null } as unknown as ScriptResult, null)).toEqual(["설치가 너무 오래 걸려 멈췄어요"]);
    expect(describeInstallFailure({ outcome: "ran", report: { problems: [], error: { code: "mystery", detail: null } } } as unknown as ScriptResult, null)).toEqual(["mystery"]);
    expect(describeInstallFailure(null, null)).toEqual(["이유를 알 수 없어요. 잠시 뒤 다시 해 보세요."]);
  });
});
