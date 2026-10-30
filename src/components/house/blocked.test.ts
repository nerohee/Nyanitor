import { describe, expect, it } from "vitest";
import { blockedSpots, spotHitBox, stageToScreen } from "./blocked";
import type { Box } from "./bubble";
import { SPOT_IDS, SPOTS } from "./spots";

const scene = (w: number, h: number): Box => ({ left: 0, top: 0, right: w, bottom: h });

describe("카드에 덮인 자리", () => {
  it("배경 px 를 화면으로 — 장면을 꽉 채우고 넘치는 쪽을 자른다", () => {
    // 가로로 긴 장면(1536 × 600): u = 1, 위아래가 잘린다 (가운데 맞춤)
    const wide = stageToScreen({ left: 0, top: 512, right: 100, bottom: 612 }, scene(1536, 600));
    expect(wide).toEqual({ left: 0, top: 300, right: 100, bottom: 400 });
    // 세로로 긴 장면(768 × 1024): u = 1, 좌우가 잘린다
    const tall = stageToScreen({ left: 768, top: 0, right: 868, bottom: 100 }, scene(768, 1024));
    expect(tall).toEqual({ left: 384, top: 0, right: 484, bottom: 100 });
    // 장면이 화면 (200, 50) 에서 시작해도 더해진다
    const moved = stageToScreen({ left: 0, top: 0, right: 1536, bottom: 1024 }, { left: 200, top: 50, right: 968, bottom: 562 });
    expect(moved).toEqual({ left: 200, top: 50, right: 968, bottom: 562 });
  });

  it("누르는 상자는 발을 품고 발 위쪽으로 뻗는다", () => {
    for (const id of SPOT_IDS) {
      const hit = spotHitBox(id);
      const spot = SPOTS[id];
      expect(hit.left).toBeLessThan(spot.feet.x);
      expect(hit.right).toBeGreaterThan(spot.feet.x);
      expect(hit.top).toBeLessThan(spot.feet.y);
    }
  });

  it("카드가 없거나 장면 크기가 0 이면 막힌 자리가 없다", () => {
    expect(blockedSpots(scene(1280, 800), [])).toEqual([]);
    expect(blockedSpots(scene(0, 0), [{ left: 0, top: 0, right: 100, bottom: 100 }])).toEqual([]);
  });

  it("장면 전체를 덮는 카드는 모든 자리를 막는다", () => {
    expect(blockedSpots(scene(1280, 800), [scene(1280, 800)])).toEqual(SPOT_IDS);
  });

  it("카드에 누르는 상자가 닿는 자리만 막는다 (닿기만 하면 막지 않는다)", () => {
    const s = scene(1536, 1024); // u = 1 — 화면 좌표 = 배경 좌표
    const sun = spotHitBox("sun");
    const cx = (sun.left + sun.right) / 2;
    const cy = (sun.top + sun.bottom) / 2;
    const blocked = blockedSpots(s, [{ left: cx, top: cy, right: cx + 4, bottom: cy + 4 }]);
    expect(blocked).toContain("sun");
    expect(blocked.length).toBeLessThan(SPOT_IDS.length);
    expect(blockedSpots(s, [{ left: sun.right, top: sun.top, right: sun.right + 50, bottom: sun.bottom }])).not.toContain("sun");
  });

  it("같은 화면 크기의 카드라도 장면이 줄면 (배경이 작아져 카드가 상대적으로 커진다) 막힌 자리가 같거나 늘어난다", () => {
    const card: Box = { left: 16, top: 16, right: 16 + 330, bottom: 16 + 300 };
    const big = blockedSpots(scene(1280, 800), [card]);
    const small = blockedSpots(scene(683, 384), [card]);
    expect(small.length).toBeGreaterThanOrEqual(big.length);
    expect(small.length).toBeGreaterThan(0);
  });
});
