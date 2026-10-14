import { describe, expect, it } from "vitest";
import {
  CAT_IDS,
  catForAgent,
  catImageUrl,
  catScale,
  DEFAULT_CATALOG,
  findCat,
  POSES,
  readCatalog,
  resolvePose,
  resolveWith,
  WITH_KEYS,
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
  it("기본 7마리가 모두 있고, 모든 자세 · 합친 그림 파일이 실제로 있다 (version 2)", () => {
    expect(DEFAULT_CATALOG.version).toBe(2);
    expect(DEFAULT_CATALOG.cats.map((cat) => cat.id)).toEqual([...CAT_IDS]);
    for (const cat of DEFAULT_CATALOG.cats) {
      for (const pose of POSES) {
        const entry = cat.poses[pose];
        expect(entry, `${cat.id} ${pose}`).toBeDefined();
        for (const file of [...(entry?.frames ?? []), ...(entry?.blink ? [entry.blink] : [])]) {
          expect(catImageUrl(cat.id, file), `${cat.id}/${file}`).toBeTruthy();
        }
      }
      for (const key of WITH_KEYS) {
        const entry = resolveWith(cat, key);
        expect(entry, `${cat.id} with.${key}`).not.toBeNull();
        for (const file of entry?.frames ?? []) expect(catImageUrl(cat.id, file), `${cat.id}/${file}`).toBeTruthy();
      }
    }
  });

  it("공 · 캣휠은 프레임 둘, 나머지 합친 그림은 하나", () => {
    const nabi = findCat("nabi") as CatEntry;
    expect(nabi.with?.ball?.frames).toEqual(["with-ball-1.webp", "with-ball-2.webp"]);
    expect(nabi.with?.wheel?.frames).toEqual(["with-wheel-1.webp", "with-wheel-2.webp"]);
    for (const key of ["bowl", "cushion", "box", "tower"] as const) expect(nabi.with?.[key]?.frames).toHaveLength(1);
  });

  it("1판 전용 자세(eat · back · play · run)는 목록에 없다", () => {
    expect([...POSES]).toEqual(["sit", "loaf", "sleep", "walk", "groom"]);
    for (const cat of DEFAULT_CATALOG.cats) expect(Object.keys(cat.poses).sort()).toEqual([...POSES].sort());
  });

  it("두부만 0.85배로 작고, 키 보정은 bodyHeight 로 한다 (합친 그림에는 쓰지 않는다)", () => {
    expect(catScale(findCat("dubu") as CatEntry)).toBeCloseTo((300 / 337) * 0.85);
    expect(catScale(findCat("nabi") as CatEntry)).toBeCloseTo(300 / 337);
    expect(catScale(MINIMAL)).toBe(1);
  });
});

describe("빠진 자세 대체 (cat-assets.md §A8)", () => {
  it("자세가 있으면 그대로 쓴다", () => {
    const nabi = findCat("nabi") as CatEntry;
    expect(resolvePose(nabi, "walk")).toMatchObject({ pose: "walk", frames: ["walk-1.webp", "walk-2.webp"] });
    expect(resolvePose(nabi, "sit")?.blink).toBe("sit-blink.webp");
  });

  it("sit · walk 만 있어도 모든 자세가 나온다 — loaf · groom → sit, sleep → loaf → sit", () => {
    expect(resolvePose(MINIMAL, "sit")?.pose).toBe("sit");
    expect(resolvePose(MINIMAL, "walk")?.pose).toBe("walk");
    for (const pose of ["loaf", "groom", "sleep"] as const) {
      expect(resolvePose(MINIMAL, pose)?.pose, pose).toBe("sit");
    }
  });

  it("합친 그림이 없는 고양이는 물건 자리 그림이 없다 (그 자리에 가지 않는다)", () => {
    expect(resolveWith(MINIMAL, "bowl")).toBeNull();
    expect(resolveWith({ ...MINIMAL, with: { bowl: { frames: [] } } }, "bowl")).toBeNull();
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

describe("목록 읽기 (cat-assets.md §A8)", () => {
  const raw = {
    version: 2,
    cats: [
      {
        id: "mine",
        name: "내 고양이",
        fur: "사용자",
        poses: { sit: { frames: ["sit.webp"] }, walk: { frames: ["walk-1.webp"] }, eat: { frames: ["eat.webp"] } },
        with: { bowl: { frames: ["with-bowl.webp"] }, kite: { frames: ["x.webp"] } },
      },
      { name: "id 없음" },
      { id: "broken", name: "깨짐", poses: { sit: { frames: "sit.webp" } } },
    ],
  };

  it("모르는 자세 · 물건 이름은 무시하고, 깨진 고양이는 그 고양이만 건너뛴다", () => {
    const catalog = readCatalog(raw);
    expect(catalog.cats.map((cat) => cat.id)).toEqual(["mine", "broken"]);
    expect(Object.keys(catalog.cats[0].poses).sort()).toEqual(["sit", "walk"]);
    expect(Object.keys(catalog.cats[0].with ?? {})).toEqual(["bowl"]);
    expect(catalog.cats[1].poses.sit).toBeUndefined();
  });

  it("version 1 목록은 with 없이 기본 자세 5가지만 읽는다 (사용자 고양이를 깨뜨리지 않음)", () => {
    const old = readCatalog({ ...raw, version: 1 });
    expect(old.cats[0].with).toBeUndefined();
    expect(old.cats[0].poses.sit?.frames).toEqual(["sit.webp"]);
    expect(readCatalog(null).cats).toEqual([]);
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
