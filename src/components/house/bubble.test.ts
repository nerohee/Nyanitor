import { describe, expect, it } from "vitest";
import { chooseBubble, overlaps, type Box } from "./bubble";

const AREA: Box = { left: 0, top: 0, right: 1000, bottom: 600 };
const SIZE = { w: 296, h: 200 };
const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h });
const at = (point: { left: number; top: number }): Box => box(point.left, point.top, SIZE.w, SIZE.h);

describe("정보 패널 자리 고르기", () => {
  const cat = box(450, 300, 100, 100);

  it("피할 상자가 없으면 정한 쪽 순서대로 첫 곳 (예전 동작)", () => {
    const chosen = chooseBubble({ sides: ["above", "right"], cat, size: SIZE, area: AREA });
    expect(chosen.choice).toBe("clear");
    // 위: 고양이 가운데 맞춤, 고양이 위 10px
    expect(chosen).toMatchObject({ left: 500 - 148, top: 300 - 10 - 200 });
  });

  it("① 정한 첫 쪽이 카드와 겹치면 안 겹치는 다음 쪽으로", () => {
    const card = box(300, 0, 400, 100); // 위쪽을 덮는 카드
    const chosen = chooseBubble({ sides: ["above", "right"], cat, size: SIZE, area: AREA, avoid: [card] });
    expect(chosen.choice).toBe("clear");
    expect(overlaps(at(chosen), card)).toBe(false);
    expect(chosen.left).toBe(550 + 10); // 오른쪽
  });

  it("① 정한 쪽이 모두 겹치면 어긋나게 붙인 후보나 다른 쪽에서 안 겹치는 곳을 찾고, 고양이는 가리지 않는다", () => {
    const above = box(0, 0, 1000, 150);
    const right = box(560, 0, 440, 600);
    const chosen = chooseBubble({ sides: ["above", "right"], cat, size: SIZE, area: AREA, avoid: [above, right] });
    expect(chosen.choice).toBe("clear");
    expect(overlaps(at(chosen), above)).toBe(false);
    expect(overlaps(at(chosen), right)).toBe(false);
    expect(overlaps(at(chosen), cat)).toBe(false);
  });

  it("② 안 겹치는 곳이 없으면 카드와 겹쳐도 장면 안의 첫 정한 쪽 (지금 동작)", () => {
    const wall = box(0, 0, 1000, 600);
    const chosen = chooseBubble({ sides: ["above", "right"], cat, size: SIZE, area: AREA, avoid: [wall] });
    expect(chosen.choice).toBe("inside");
    expect(chosen).toMatchObject({ left: 500 - 148, top: 300 - 10 - 200 });
  });

  it("③ 장면 안에 들어갈 곳이 없으면 첫 후보를 장면 안으로 밀어 넣는다", () => {
    const tiny: Box = { left: 0, top: 0, right: 320, bottom: 220 };
    const chosen = chooseBubble({ sides: ["left"], cat: box(100, 100, 100, 100), size: SIZE, area: tiny });
    expect(chosen.choice).toBe("pushed");
    expect(chosen.left).toBeGreaterThanOrEqual(8);
    expect(chosen.left + SIZE.w).toBeLessThanOrEqual(320 - 8);
    expect(chosen.top).toBeGreaterThanOrEqual(8);
  });

  it("장면 밖으로 나가는 후보는 고르지 않는다", () => {
    const edge = box(10, 300, 100, 100);
    const chosen = chooseBubble({ sides: ["left", "right"], cat: edge, size: SIZE, area: AREA });
    expect(chosen.choice).toBe("clear");
    expect(chosen.left).toBeGreaterThanOrEqual(8);
  });

  it("① 오른쪽이 장면 밖으로 몇 px 넘으면 안으로 밀어 붙인 곳 (고양이는 안 가린다)", () => {
    // 1024 × 640 창의 나비 — 아래는 판 카드가 덮고, 오른쪽은 7px 넘친다
    const area = box(92, 0, 932, 640);
    const nabiCat = box(668, 220, 49, 39);
    const cards = [box(106, 14, 288, 327), box(111, 540, 210, 68), box(336, 521, 668, 107)];
    const chosen = chooseBubble({ sides: ["below", "right"], cat: nabiCat, size: { w: 296, h: 296 }, area, avoid: cards });
    expect(chosen).toMatchObject({ choice: "clear" });
    expect(cards.some((c) => overlaps(box(chosen.left, chosen.top, 296, 296), c))).toBe(false);
    expect(overlaps(box(chosen.left, chosen.top, 296, 296), nabiCat)).toBe(false);
  });

  it("① 정한 쪽 · 밀어 붙인 곳 모두 카드와 겹치면 격자로 훑어 고양이에 가장 가까운 빈 곳", () => {
    const area = box(92, 0, 932, 640);
    const gureum = box(254, 382, 73, 45);
    const cards = [box(106, 14, 288, 327), box(111, 540, 210, 68), box(336, 521, 668, 107)];
    const chosen = chooseBubble({ sides: ["right", "above"], cat: gureum, size: { w: 296, h: 296 }, area, avoid: cards });
    expect(chosen.choice).toBe("clear");
    const bubble = box(chosen.left, chosen.top, 296, 296);
    expect(cards.some((c) => overlaps(bubble, c))).toBe(false);
    expect(overlaps(bubble, gureum)).toBe(false);
    expect(bubble.left).toBeGreaterThanOrEqual(100);
    expect(bubble.right).toBeLessThanOrEqual(1016);
  });

  it("② 카드를 피할 곳이 없는 좁은 창에서도 고양이는 가리지 않는다 (카드를 가장 덜 덮는 곳)", () => {
    const area = box(0, 0, 591, 363);
    const wall = box(0, 0, 400, 363);
    const kitty = box(50, 200, 40, 40);
    const chosen = chooseBubble({ sides: ["above"], cat: kitty, size: { w: 296, h: 300 }, area, avoid: [wall] });
    expect(chosen.choice).toBe("inside");
    expect(overlaps(box(chosen.left, chosen.top, 296, 300), kitty)).toBe(false);
  });

  it("이름표까지 피한 곳을 먼저 찾고, 그러면 카드를 덮게 될 때만 이름표는 덮는다", () => {
    const area = box(92, 0, 932, 640);
    const catBox = box(668, 220, 49, 39);
    const tag = box(640, 262, 130, 24);
    const keepClear = { left: 640, top: 220, right: 770, bottom: 286 };
    const cards = [box(106, 14, 288, 327), box(336, 521, 668, 107)];
    // 이름표를 피해서는 카드도 못 피한다 → 카드를 피하는 쪽 (이름표는 덮는다)
    const chosen = chooseBubble({ sides: ["below", "right"], cat: catBox, keepClear, size: { w: 296, h: 296 }, area, avoid: cards });
    expect(chosen.choice).toBe("clear");
    expect(overlaps(box(chosen.left, chosen.top, 296, 296), catBox)).toBe(false);
    expect(overlaps(box(chosen.left, chosen.top, 296, 296), tag)).toBe(true);
    // 카드가 없으면 이름표도 안 덮는다
    const free = chooseBubble({ sides: ["above", "left"], cat: box(500, 300, 100, 100), keepClear: { left: 480, top: 300, right: 620, bottom: 430 }, size: { w: 296, h: 200 }, area });
    expect(overlaps(box(free.left, free.top, 296, 200), box(480, 300, 140, 130))).toBe(false);
  });
});

