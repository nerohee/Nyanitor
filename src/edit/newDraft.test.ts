// 새로 만들기의 순수한 쪽 시험 — 이름 · 보이는 이름 · 소개 검사, 앞머리 가르기 · 복사할 글, 만들기 순서(`createItem`)의 단계 실패.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCustom } from "../lib/fakeCustom";
import { ipc } from "../lib/ipc";
import type { CustomListEntry, CustomMark } from "../lib/ipc-types";
import { AppError } from "../lib/ipc-types";
import { EMPTY_DRAFT, copiedText, copyCandidates, createItem, descriptionReady, draftReady, hasWriting, labelProblem, nameProblem, oneLine, splitFront } from "./newDraft";

function entry(kind: "agent" | "skill", name: string, marks: CustomMark[] = []): CustomListEntry {
  return {
    state: "ok",
    id: `${kind}:${name}`,
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

const entries: CustomListEntry[] = [
  entry("agent", "harness-designer"),
  entry("agent", "translator", ["mine"]),
  entry("skill", "desktop-app"),
  { state: "unreadable", id: "agent:broken", kind: "agent", name: "broken", file: "agents/broken.md", reason: "no_frontmatter" },
];

describe("칸 검사", () => {
  it("이름 — 빈 칸은 문제가 아니다 · 모양 · 원본과 겹침 · 내가 만든 것과 겹침 · 읽을 수 없는 것과 겹침", () => {
    expect(nameProblem("agent", "", entries)).toBeNull();
    expect(nameProblem("agent", "Bad", entries)).toBe("bad");
    expect(nameProblem("agent", "1abc", entries)).toBe("bad");
    expect(nameProblem("agent", "a".repeat(65), entries)).toBe("bad");
    expect(nameProblem("agent", "a".repeat(64), entries)).toBeNull();
    expect(nameProblem("agent", "harness-designer", entries)).toBe("source");
    expect(nameProblem("agent", "translator", entries)).toBe("taken");
    expect(nameProblem("agent", "broken", entries)).toBe("exists");
    expect(nameProblem("agent", "main", entries)).toBe("source");
    expect(nameProblem("skill", "desktop-app", entries)).toBe("source");
    // 종류가 다르면 겹치지 않는다
    expect(nameProblem("skill", "translator", entries)).toBeNull();
    expect(nameProblem("agent", "desktop-app", entries)).toBeNull();
  });

  it("보이는 이름 — 비워도 되고, 앞뒤 공백을 뗀 뒤 20 글자까지 · 제어 문자 없음", () => {
    expect(labelProblem("")).toBe(false);
    expect(labelProblem("   ")).toBe(false);
    expect(labelProblem("가".repeat(20))).toBe(false);
    expect(labelProblem(`  ${"가".repeat(20)}  `)).toBe(false);
    expect(labelProblem("가".repeat(21))).toBe(true);
    expect(labelProblem("a\tb")).toBe(true);
    // 글자 수는 문자 단위 (이모지 한 글자가 둘로 세어지지 않는다)
    expect(labelProblem("😀".repeat(20))).toBe(false);
    expect(labelProblem("😀".repeat(21))).toBe(true);
  });

  it("소개 — 한 줄 · 꼭 씀 · 300 자까지", () => {
    expect(oneLine("첫 줄\r\n둘째 줄")).toBe("첫 줄 둘째 줄");
    expect(descriptionReady("")).toBe(false);
    expect(descriptionReady("   ")).toBe(false);
    expect(descriptionReady("가".repeat(300))).toBe(true);
    expect(descriptionReady("가".repeat(301))).toBe(false);
    expect([...oneLine("가".repeat(400))]).toHaveLength(300);
  });

  it("주 단추 조건 — 이름 · 소개가 맞고, 보이는 이름이 규칙을 지키고, 복사면 복사할 것이 있다", () => {
    const ok = { ...EMPTY_DRAFT, name: "new-one", description: "쓰는 때" };
    expect(draftReady(ok, entries, 0)).toBe(true);
    expect(draftReady({ ...ok, name: "" }, entries, 0)).toBe(false);
    expect(draftReady({ ...ok, name: "translator" }, entries, 0)).toBe(false);
    expect(draftReady({ ...ok, description: " " }, entries, 0)).toBe(false);
    expect(draftReady({ ...ok, label: "가".repeat(21) }, entries, 0)).toBe(false);
    expect(draftReady({ ...ok, kind: "skill", label: "가".repeat(21) }, entries, 0)).toBe(true); // 스킬은 보이는 이름이 없다
    expect(draftReady({ ...ok, start: "copy" }, entries, 0)).toBe(false);
    expect(draftReady({ ...ok, start: "copy" }, entries, 2)).toBe(true);
  });

  it("쓴 것이 있는지 · 복사할 수 있는 항목(같은 종류의 읽을 수 있는 것)", () => {
    expect(hasWriting(EMPTY_DRAFT)).toBe(false);
    expect(hasWriting({ ...EMPTY_DRAFT, label: "a" })).toBe(true);
    expect(hasWriting({ ...EMPTY_DRAFT, cat: "nabi" })).toBe(true);
    expect(copyCandidates(entries, "agent").map((item) => item.name)).toEqual(["harness-designer", "translator"]);
    expect(copyCandidates(entries, "skill").map((item) => item.name)).toEqual(["desktop-app"]);
  });
});

describe("앞머리 · 복사할 글", () => {
  it("앞머리(첫 --- ~ 둘째 ---)와 본문으로 가른다 — CRLF · BOM 은 LF 로", () => {
    expect(splitFront("---\nname: a\n---\n\n본문\n")).toEqual({ front: "---\nname: a\n---\n", body: "\n본문\n" });
    expect(splitFront("\uFEFF---\r\nname: a\r\n---\r\n본문")).toEqual({ front: "---\nname: a\n---\n", body: "본문" });
    expect(splitFront("본문만")).toBeNull();
    expect(splitFront("---\nname: a\n본문")).toBeNull();
  });

  it("새 틀의 앞머리는 두고 본문만 고른 글로 — 본문 안의 --- 줄은 본문이다", () => {
    const fresh = "---\nname: new-one\ndescription: 새 소개\n---\n\n여기에 쓴다\n";
    const source = "---\nname: old\ndescription: 옛 소개\nmodel: opus\n---\n\n너는 작업자다.\n\n---\n\n구분선 뒤\n";
    expect(copiedText(fresh, source)).toBe("---\nname: new-one\ndescription: 새 소개\n---\n\n너는 작업자다.\n\n---\n\n구분선 뒤\n");
    expect(copiedText(fresh, "앞머리 없음")).toBeNull();
    expect(copiedText("앞머리 없음", source)).toBeNull();
  });
});

describe("createItem — 만들기 순서", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fakeCustom.reset();
  });
  const draft = { ...EMPTY_DRAFT, name: "step-test", label: "단계", description: "단계 시험", cat: "nabi" };

  it("에이전트: 만들기 → 보이는 이름 → 고양이 — 모두 되면 failed 가 비어 있다", async () => {
    fakeCustom.reset("full");
    const result = await createItem(draft, null, false);
    expect(result).toEqual({ status: "created", id: "agent:step-test", failed: [], notOurs: false });
    expect((await ipc.customLabelsRead()).agents["step-test"]).toBe("단계");
    expect((await ipc.customCatsRead()).agents["step-test"]).toBe("nabi");
  });

  it("스킬은 이름 · 고양이 단계가 없다", async () => {
    fakeCustom.reset("full");
    const save = vi.spyOn(ipc, "customLabelSave");
    const cats = vi.spyOn(ipc, "customCatsSave");
    const result = await createItem({ ...draft, kind: "skill" }, null, false);
    expect(result).toMatchObject({ status: "created", id: "skill:step-test", failed: [] });
    expect(save).not.toHaveBeenCalled();
    expect(cats).not.toHaveBeenCalled();
  });

  it("customNew 가 거절하면 아무 단계도 하지 않는다", async () => {
    fakeCustom.reset("full");
    const save = vi.spyOn(ipc, "customLabelSave");
    expect(await createItem({ ...draft, name: "harness-designer" }, null, false)).toEqual({ status: "refused", reason: "name_in_source" });
    expect(save).not.toHaveBeenCalled();
  });

  it("customNew 오류는 error — 뒤 단계 실패는 항목을 남긴 채 실패한 것만, 한 단계가 실패해도 다음 단계는 해 본다", async () => {
    fakeCustom.reset("full");
    vi.spyOn(ipc, "customNew").mockRejectedValueOnce(new AppError("harness_busy", "busy"));
    expect(await createItem(draft, null, false)).toEqual({ status: "error", kind: "harness_busy" });
    vi.spyOn(ipc, "customLabelSave").mockResolvedValueOnce({ outcome: "refused", reason: "bad_label", changed: false, commit: "skipped", commitShort: null, detail: null });
    const result = await createItem(draft, null, false);
    expect(result).toEqual({ status: "created", id: "agent:step-test", failed: ["label"], notOurs: false });
    expect((await ipc.customCatsRead()).agents["step-test"]).toBe("nabi");
  });

  it("복사가 실패하면(고른 것을 읽을 수 없음) copy 만 실패로 — 나머지는 이어서", async () => {
    fakeCustom.reset("full");
    const result = await createItem(draft, "agent:없는것", false);
    expect(result).toEqual({ status: "created", id: "agent:step-test", failed: ["copy"], notOurs: false });
    expect((await ipc.customCatsRead()).agents["step-test"]).toBe("nabi");
  });

  it("보이는 이름을 비웠고 같은 이름의 옛 줄이 있으면 그 줄을 지운다", async () => {
    fakeCustom.reset("full");
    await ipc.customLabelSave("step-test", "옛 이름");
    const result = await createItem({ ...draft, label: "" }, null, true);
    expect(result).toMatchObject({ status: "created", failed: [] });
    expect((await ipc.customLabelsRead()).agents["step-test"]).toBeUndefined();
  });
});
