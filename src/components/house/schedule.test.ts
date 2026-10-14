import { describe, expect, it } from "vitest";
import { CAT_IDS } from "../cat/catalog";
import {
  assignSpots,
  FAKE_PLANS,
  pickPose,
  pickRoam,
  staggerDelays,
  STAGGER_MIN_MS,
  STAGGER_SPAN_MS,
  staticPlacements,
  TAB_ORDER,
  travel,
  WALK_MAX,
  type Intents,
} from "./schedule";
import { depth, SPOT_IDS, SPOTS, spotDepth, STAGE } from "./spots";

const REST: Intents = {
  mukmul: "rest",
  nabi: "rest",
  mulgam: "rest",
  danchu: "rest",
  kkaebi: "rest",
  dubu: "rest",
  gureum: "rest",
};

/** 항상 같은 값을 돌려주는 가짜 난수 */
const fixed = (value: number) => () => value;

describe("자리 배정", () => {
  it("처음 가짜 일정: 먹물은 댓돌에서 기다리고, 단추는 캣휠, 구름은 캣타워, 나머지는 좋아하는 자리에서 쉰다", () => {
    expect(assignSpots(FAKE_PLANS[0])).toEqual({
      mukmul: "stone",
      danchu: "wheel",
      gureum: "towerTop",
      nabi: "box",
      mulgam: "cushion",
      kkaebi: "ball",
      dubu: "bowl",
    });
  });

  it("어떤 일정에서도 한 자리에 한 마리뿐이고, 모두 자리가 있다", () => {
    for (const plan of [...FAKE_PLANS, REST]) {
      const spots = Object.values(assignSpots(plan));
      expect(spots).toHaveLength(CAT_IDS.length);
      expect(new Set(spots).size).toBe(spots.length);
    }
  });

  it("캣휠은 한 마리 — 만드는 일이 둘이면 넘친 고양이는 쉬는 자리로 간다", () => {
    const result = assignSpots({ ...REST, kkaebi: "making", dubu: "making" });
    expect(result.kkaebi).toBe("wheel");
    expect(SPOTS[result.dubu].kind).toBe("rest");
  });

  it("캣타워는 위 · 가운데 두 자리 — 보는 일이 셋이면 셋째는 쉰다", () => {
    const result = assignSpots({ ...REST, mukmul: "watching", mulgam: "watching", gureum: "watching" });
    const onTower = [result.mukmul, result.mulgam, result.gureum].filter((s) => s === "towerTop" || s === "towerMid");
    expect(onTower).toHaveLength(2);
    expect(SPOTS[result.gureum].kind).toBe("rest");
  });

  it("쉬는 고양이는 있던 쉬는 자리를 지키고, 일하던 자리에서는 내려온다", () => {
    const stay = assignSpots(REST, { nabi: "sun", kkaebi: "wheel" });
    expect(stay.nabi).toBe("sun");
    expect(SPOTS[stay.kkaebi].kind).toBe("rest");
  });

  it("좋아하는 자리가 이미 차 있으면 빈 쉬는 자리 아무 곳으로", () => {
    // 먹물(첫째)이 두부의 자리 밥그릇에 있다고 하면 두부는 다른 쉬는 자리로
    const result = assignSpots(REST, { mukmul: "bowl" });
    expect(result.mukmul).toBe("bowl");
    expect(result.dubu).not.toBe("bowl");
    expect(SPOTS[result.dubu].kind).toBe("rest");
  });

  it("Tab 순서에 7마리가 한 번씩", () => {
    expect([...TAB_ORDER].sort()).toEqual([...CAT_IDS].sort());
    expect(staticPlacements(FAKE_PLANS[0]).map((p) => p.cat)).toEqual([...TAB_ORDER]);
  });
});

describe("가끔 일어나는 일", () => {
  const spots = assignSpots(FAKE_PLANS[0]);
  const poses = Object.fromEntries(CAT_IDS.map((cat) => [cat, SPOTS[spots[cat]].poses[0]])) as Parameters<
    typeof pickRoam
  >[2];

  it("움직이는 것은 쉬는 고양이뿐 — 일하는 · 기다리는 고양이는 그대로", () => {
    for (let i = 0; i < 40; i++) {
      const roam = pickRoam(FAKE_PLANS[0], spots, poses, () => (i + 0.5) / 40);
      if (roam) expect(["nabi", "mulgam", "kkaebi", "dubu"]).toContain(roam.cat);
    }
  });

  it("가는 곳은 비어 있는 쉬는 자리", () => {
    const roam = pickRoam(FAKE_PLANS[0], spots, poses, fixed(0.99));
    if (roam?.kind === "move") {
      expect(SPOTS[roam.to].kind).toBe("rest");
      expect(Object.values(spots)).not.toContain(roam.to);
    }
  });

  it("정보 패널이 열린 고양이는 건드리지 않는다", () => {
    for (let i = 0; i < 40; i++) {
      const roam = pickRoam(FAKE_PLANS[0], spots, poses, () => (i + 0.5) / 40, "nabi");
      expect(roam?.cat).not.toBe("nabi");
    }
  });

  it("쉬는 고양이가 없으면 아무 일도 없다", () => {
    const busy: Intents = {
      mukmul: "wait",
      nabi: "making",
      mulgam: "watching",
      danchu: "watching",
      kkaebi: "wait",
      dubu: "wait",
      gureum: "wait",
    };
    expect(pickRoam(busy, assignSpots(busy), poses)).toBeNull();
  });

  it("동작은 이 자리의 다른 동작으로, 하나뿐인 자리는 그대로", () => {
    expect(pickPose("sun", "groom", fixed(0))).toBe("loaf");
    expect(pickPose("sun", "loaf", fixed(0))).toBe("groom");
    expect(pickPose("bowl", "eat")).toBe("eat");
  });
});

describe("자리 옮기기", () => {
  it("가까운 쉬는 자리끼리는 걷고, 왼쪽으로 가면 왼쪽을 본다", () => {
    const toRight = travel("box", "cushion");
    expect(toRight).toMatchObject({ mode: "walk", facing: "right" });
    expect(travel("cushion", "box")).toMatchObject({ mode: "walk", facing: "left" });
    if (toRight.mode === "walk") expect(toRight.ms).toBeLessThanOrEqual(4000);
  });

  it("캣휠 · 캣타워에 오르내리거나 무대 폭 25% 를 넘으면 사라졌다 나타난다", () => {
    expect(travel("ball", "wheel").mode).toBe("jump");
    expect(travel("towerTop", "stone").mode).toBe("jump");
    expect(travel("shade", "bowl").mode).toBe("jump");
    expect(WALK_MAX).toBe(STAGE.width * 0.25);
  });
});

describe("일정이 바뀔 때 엇갈려 옮기기", () => {
  it("고양이마다 0.5~4초 사이로 시작한다", () => {
    const moves = [
      { cat: "danchu" as const, from: "wheel" as const, to: "sun" as const },
      { cat: "gureum" as const, from: "towerTop" as const, to: "shade" as const },
    ];
    expect(staggerDelays(moves, fixed(0))).toEqual({ danchu: STAGGER_MIN_MS, gureum: STAGGER_MIN_MS });
    const late = staggerDelays(moves, fixed(0.999));
    expect(late.danchu).toBeLessThanOrEqual(STAGGER_MIN_MS + STAGGER_SPAN_MS);
    const mixed = staggerDelays(moves, (() => { let i = 0; return () => [0.1, 0.9][i++ % 2]; })());
    expect(mixed.danchu).not.toBe(mixed.gureum);
  });

  it("가려는 자리에 아직 있는 고양이가 떠난 뒤에 들어간다", () => {
    const delays = staggerDelays(
      [
        { cat: "nabi", from: "box", to: "wheel" },
        { cat: "danchu", from: "wheel", to: "box" },
      ],
      fixed(0),
    );
    // 서로 자리를 바꾸는 경우도 끝난다 (무한히 밀리지 않는다)
    expect(Object.keys(delays)).toHaveLength(2);
    const chain = staggerDelays(
      [
        { cat: "nabi", from: "cushion", to: "sun" },
        { cat: "mulgam", from: "sun", to: "shade" },
      ],
      fixed(0),
    );
    expect(chain.nabi).toBeGreaterThan(chain.mulgam ?? 0);
  });
});

describe("자리 옮기기 — 세로", () => {
  it("세로로 크게 오르내리는 길은 걷지 않는다 (상자 ↔ 방 안, 마루 ↔ 마당)", () => {
    expect(travel("sun", "room").mode).toBe("jump");
    expect(travel("cushion", "sun").mode).toBe("jump");
    expect(travel("box", "cushion").mode).toBe("walk");
  });
});

describe("자리 · 깊이 데이터", () => {
  it("오른쪽 위가 몰리지 않는다 — 방 안 · 캣타워 두 자리가 동시에 차도 150px 이상 떨어져 있다", () => {
    const near = (a: keyof typeof SPOTS, b: keyof typeof SPOTS) =>
      Math.hypot(SPOTS[a].feet.x - SPOTS[b].feet.x, SPOTS[a].feet.y - SPOTS[b].feet.y);
    expect(near("room", "towerTop")).toBeGreaterThan(150);
    expect(near("room", "towerMid")).toBeGreaterThan(150);
    expect(near("towerTop", "towerMid")).toBeGreaterThan(100);
    expect(SPOTS.room.feet.x).toBeLessThan(1120);
    expect(SPOTS.wheel.poses).toEqual(["walk"]);
  });

  it("모든 자리가 안전 영역(x · y 0.09~0.91) 안에 있고, 아래 카드 띠(y 0.80~)에는 닿지 않는다", () => {
    for (const id of SPOT_IDS) {
      const { x, y } = SPOTS[id].feet;
      expect(x / STAGE.width, `${id} x`).toBeGreaterThanOrEqual(0.09);
      expect(x / STAGE.width, `${id} x`).toBeLessThanOrEqual(0.91);
      expect(y / STAGE.height, `${id} y`).toBeGreaterThanOrEqual(0.09);
      expect(y / STAGE.height, `${id} y`).toBeLessThanOrEqual(0.77);
    }
  });

  it("깊이는 발 y 순서 — 앞(아래)에 있는 고양이가 위에 그려진다", () => {
    expect(spotDepth(SPOTS.ball)).toBeGreaterThan(spotDepth(SPOTS.stone));
    expect(spotDepth(SPOTS.stone)).toBeGreaterThan(spotDepth(SPOTS.bowl));
    expect(spotDepth(SPOTS.box)).toBeLessThan(spotDepth(SPOTS.sun));
    expect(spotDepth(SPOTS.room)).toBeLessThan(spotDepth(SPOTS.box));
  });

  it("물건 위에 앉는 고양이는 그 물건보다 위, 캣타워 위 두 자리도 타워보다 위", () => {
    expect(spotDepth(SPOTS.towerTop)).toBeGreaterThan(depth(668));
    expect(spotDepth(SPOTS.towerMid)).toBeGreaterThan(depth(668));
    expect(spotDepth(SPOTS.cushion)).toBeGreaterThan(depth(385));
    expect(SPOTS.box.clip?.length).toBeGreaterThan(3);
    // 밥 먹는 고양이는 그릇보다 위 층, 그릇에 붙어 있다 (Q57)
    expect(spotDepth(SPOTS.bowl)).toBeGreaterThan(depth(552));
    expect(Math.abs(SPOTS.bowl.feet.x - 1227)).toBeLessThan(60);
  });
});
