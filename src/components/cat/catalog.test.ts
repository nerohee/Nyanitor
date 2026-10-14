import { describe, expect, it } from "vitest";
import {
  CAT_IDS,
  catForAgent,
  catImageUrl,
  catScale,
  DEFAULT_CATALOG,
  findCat,
  POSES,
  resolvePose,
  type Catalog,
  type CatEntry,
} from "./catalog";

/** 사용자 고양이 — `sit` + `walk` 만 있다 */
const MINIMAL: CatEntry = {
  id: "tiny",
  name: "작은",
  fur: "시험용",
  poses: { sit: { frames: ["sit.webp"] }, walk: { frames: ["walk-1.webp", "walk-2.webp"] } },
};

describe("고양이 목록", () => {
  it("기본 7마리가 모두 있고, 모든 자세 그림 파일이 실제로 있다", () => {
    expect(DEFAULT_CATALOG.cats.map((cat) => cat.id)).toEqual([...CAT_IDS]);
    for (const cat of DEFAULT_CATALOG.cats) {
      for (const pose of POSES) {
        const entry = cat.poses[pose];
        expect(entry, `${cat.id} ${pose}`).toBeDefined();
        for (const file of [...(entry?.frames ?? []), ...(entry?.blink ? [entry.blink] : [])]) {
          expect(catImageUrl(cat.id, file), `${cat.id}/${file}`).toBeTruthy();
        }
      }
    }
  });

  it("두부만 0.8배로 작고, 키 보정은 bodyHeight 로 한다", () => {
    expect(catScale(findCat("dubu") as CatEntry)).toBeCloseTo((300 / 362) * 0.8);
    expect(catScale(findCat("nabi") as CatEntry)).toBeCloseTo(300 / 362);
    expect(catScale(MINIMAL)).toBe(1);
  });
});

describe("빠진 자세 대체 (cat-assets.md §A8)", () => {
  it("자세가 있으면 그대로 쓴다", () => {
    const nabi = findCat("nabi") as CatEntry;
    expect(resolvePose(nabi, "run")).toMatchObject({ pose: "run", frames: ["run-1.webp", "run-2.webp"] });
    expect(resolvePose(nabi, "sit")?.blink).toBe("sit-blink.webp");
  });

  it("sit · walk 만 있어도 모든 자세가 나온다 — loaf · back · groom · eat · play → sit, sleep → loaf → sit, run → walk", () => {
    expect(resolvePose(MINIMAL, "sit")?.pose).toBe("sit");
    expect(resolvePose(MINIMAL, "walk")?.pose).toBe("walk");
    for (const pose of ["loaf", "back", "groom", "eat", "play", "sleep"] as const) {
      expect(resolvePose(MINIMAL, pose)?.pose, pose).toBe("sit");
    }
    expect(resolvePose(MINIMAL, "run")).toMatchObject({ pose: "walk", frames: ["walk-1.webp", "walk-2.webp"] });
  });

  it("sleep 은 loaf 가 있으면 loaf 로", () => {
    const withLoaf: CatEntry = { ...MINIMAL, poses: { ...MINIMAL.poses, loaf: { frames: ["loaf.webp"] } } };
    expect(resolvePose(withLoaf, "sleep")?.pose).toBe("loaf");
  });

  it("그림이 하나도 없으면 null, 빈 frames 는 없는 것으로 본다", () => {
    expect(resolvePose({ ...MINIMAL, poses: {} }, "sit")).toBeNull();
    expect(resolvePose({ ...MINIMAL, poses: { sit: { frames: [] } } }, "sit")).toBeNull();
  });
});

describe("에이전트 연결 (cat-assets.md §A9)", () => {
  it("기본 연결 — 메인 대화는 먹물, 나비는 시스템 구현 (D-37)", () => {
    expect(catForAgent("main")).toBe("mukmul");
    expect(catForAgent("builder-system")).toBe("nabi");
    expect(catForAgent("designer")).toBe("mulgam");
    expect(catForAgent("builder-ui")).toBe("danchu");
    expect(catForAgent("tester")).toBe("kkaebi");
    expect(catForAgent("helper")).toBe("dubu");
    expect(catForAgent("reviewer")).toBe("gureum");
  });

  it("사용자 연결이 값만 덮어쓴다", () => {
    expect(catForAgent("designer", { user: { designer: "gureum" } })).toBe("gureum");
    expect(catForAgent("tester", { user: { designer: "gureum" } })).toBe("kkaebi");
  });

  it("가리킨 고양이가 목록에 없으면 기본 연결의 고양이로, 그것도 없으면 먹물로", () => {
    expect(catForAgent("designer", { user: { designer: "ghost" } })).toBe("mulgam");
    expect(catForAgent("brand-new-agent")).toBe("mukmul");
    expect(catForAgent("brand-new-agent", { user: { "brand-new-agent": "ghost" } })).toBe("mukmul");

    const links = { version: 1, agents: { helper: "ghost" } };
    expect(catForAgent("helper", { links })).toBe("mukmul");
  });

  it("목록이 바뀌면 그 목록 기준으로 찾는다", () => {
    const catalog: Catalog = { version: 1, cats: [MINIMAL] };
    expect(catForAgent("helper", { user: { helper: "tiny" }, catalog })).toBe("tiny");
    expect(catForAgent("helper", { catalog })).toBe("mukmul");
  });
});
