// 정보 패널이 놓일 자리를 고르는 순수 계산 (HouseScene 의 `placeBubble` 이 상자들을 재서 넣는다).
// 모든 후보는 고양이를 가리지 않는다. 고르는 순서:
//   ① 장면 안 + 피할 상자(카드)와 안 겹침 — 자리마다 정한 쪽(`spot.bubble`) → 나머지 쪽 · 어긋나게 붙인 후보 → 장면 안으로 밀어 붙인 후보 → 격자로 훑어 고양이에 가장 가까운 곳
//   ② 장면 안 (카드와 겹쳐도) — 정한 쪽 순서 그대로 (예전 동작), 없으면 격자로 훑어 카드를 가장 덜 덮는 곳
//   ③ 첫 후보를 장면 안으로 밀어 넣기 (고양이를 가려도 — 패널이 층보다 큰 아주 좁은 창)

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Side = "above" | "below" | "left" | "right";

export interface BubbleInput {
  /** 자리마다 정한 쪽 순서 */
  sides: readonly Side[];
  /** 고르는 고양이 (누르는 상자) */
  cat: Box;
  /** 패널 크기 */
  size: { w: number; h: number };
  /** 패널이 들어갈 층 */
  area: Box;
  /** 고양이와 이름표를 합친 상자 — 밀어 붙인 후보가 이름표를 덮지 않게 (없으면 `cat`) */
  keepClear?: Box;
  /** 되도록 덮지 않을 상자 (위 카드 · 아래 판 카드) */
  avoid?: readonly Box[];
  gap?: number;
  margin?: number;
  /** 발 아래 이름표 자리 */
  tagRoom?: number;
}

export interface Point {
  left: number;
  top: number;
}

const ALL_SIDES: readonly Side[] = ["above", "below", "left", "right"];

export function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** 패널의 왼쪽 위 → 상자 */
function boxAt(point: Point, size: { w: number; h: number }): Box {
  return { left: point.left, top: point.top, right: point.left + size.w, bottom: point.top + size.h };
}

/** 한 쪽에 붙인 후보 — 가운데 맞춤(`center`) 말고, 위 · 아래는 가로로, 왼쪽 · 오른쪽은 세로로 어긋나게 붙인 것도 */
function candidatesFor(side: Side, input: BubbleInput, shifted: boolean): Point[] {
  const { cat, size, gap = 10, tagRoom = 30 } = input;
  const centerX = (cat.left + cat.right) / 2;
  const centerY = (cat.top + cat.bottom) / 2;
  const { w, h } = size;
  if (side === "above" || side === "below") {
    const top = side === "above" ? cat.top - gap - h : cat.bottom + tagRoom;
    const points = [{ left: centerX - w / 2, top }];
    if (shifted) points.push({ left: cat.right - w, top }, { left: cat.left, top });
    return points;
  }
  const left = side === "left" ? cat.left - gap - w : cat.right + gap;
  const points = [{ left, top: centerY - h / 2 }];
  if (shifted) points.push({ left, top: cat.bottom - h }, { left, top: cat.top });
  return points;
}

function areaOf(a: Box, b: Box): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/** 고양이 상자를 이만큼 부풀려 그 안에는 패널을 놓지 않는다 (밀어 붙인 후보가 고양이에 닿지 않게) */
const CAT_AIR = 2;
/** 격자로 훑는 간격 */
const GRID_STEP = 8;

/**
 * 패널의 왼쪽 위 (층 기준이 아니라 입력 상자와 같은 좌표).
 * 이름표까지 피해서 카드와도 안 겹치는 곳을 먼저 찾고, 없으면 이름표는 덮어도(패널에 같은 이름이 있다) 카드와 안 겹치는 곳을 고른다.
 */
export function chooseBubble(input: BubbleInput): Point & { choice: "clear" | "inside" | "pushed" } {
  const strict = chooseWith(input);
  if (strict.choice === "clear" || !input.keepClear) return strict;
  const loose = chooseWith({ ...input, keepClear: undefined });
  const rank = { clear: 0, inside: 1, pushed: 2 } as const;
  return rank[loose.choice] < rank[strict.choice] ? loose : strict;
}

function chooseWith(input: BubbleInput): Point & { choice: "clear" | "inside" | "pushed" } {
  const { area, size, cat, avoid = [], margin = 8 } = input;
  const range = {
    minLeft: area.left + margin,
    maxLeft: area.right - margin - size.w,
    minTop: area.top + margin,
    maxTop: area.bottom - margin - size.h,
  };
  const inside = (point: Point) => point.left >= range.minLeft && point.left <= range.maxLeft && point.top >= range.minTop && point.top <= range.maxTop;
  const coverage = (point: Point) => avoid.reduce((sum, other) => sum + areaOf(boxAt(point, size), other), 0);
  const keep = input.keepClear ?? cat;
  const clearOfCat = (point: Point) =>
    !overlaps(boxAt(point, size), { left: keep.left - CAT_AIR, top: keep.top - CAT_AIR, right: keep.right + CAT_AIR, bottom: keep.bottom + CAT_AIR });
  const centerX = (cat.left + cat.right) / 2;
  const centerY = (cat.top + cat.bottom) / 2;
  const distance = (point: Point) => Math.hypot(point.left + size.w / 2 - centerX, point.top + size.h / 2 - centerY);
  const clampPoint = (point: Point): Point => ({
    left: Math.min(Math.max(point.left, range.minLeft), Math.max(range.minLeft, range.maxLeft)),
    top: Math.min(Math.max(point.top, range.minTop), Math.max(range.minTop, range.maxTop)),
  });

  const base = input.sides.flatMap((side) => candidatesFor(side, input, false));
  const extended = [
    ...input.sides.flatMap((side) => candidatesFor(side, input, true)),
    ...ALL_SIDES.filter((side) => !input.sides.includes(side)).flatMap((side) => candidatesFor(side, input, true)),
  ];
  const all = base.concat(extended);
  /** 격자의 모든 자리 (장면 안) */
  const grid = (): Point[] => {
    const points: Point[] = [];
    if (range.maxLeft < range.minLeft || range.maxTop < range.minTop) return points;
    for (let left = range.minLeft; left <= range.maxLeft + 0.5; left += GRID_STEP) {
      for (let top = range.minTop; top <= range.maxTop + 0.5; top += GRID_STEP) points.push({ left, top });
    }
    return points;
  };
  const nearest = (points: Point[], cost: (p: Point) => number): Point | undefined =>
    points.reduce<Point | undefined>((best, p) => (best === undefined || cost(p) < cost(best) ? p : best), undefined);

  // ① 카드와 안 겹침
  const plain = all.find((point) => inside(point) && coverage(point) === 0);
  if (plain) return { ...plain, choice: "clear" };
  const slid = all.map(clampPoint).find((point) => clearOfCat(point) && coverage(point) === 0);
  if (slid) return { ...slid, choice: "clear" };
  const gridded = grid().filter((point) => clearOfCat(point) && coverage(point) === 0);
  const nearClear = nearest(gridded, distance);
  if (nearClear) return { ...nearClear, choice: "clear" };

  // ② 카드와 겹쳐도 장면 안 — 정한 쪽 순서 그대로, 없으면 카드를 가장 덜 덮는 곳
  const second = base.find(inside);
  if (second) return { ...second, choice: "inside" };
  const leastCovered = nearest(grid().filter(clearOfCat), (point) => coverage(point) * 1000 + distance(point));
  if (leastCovered) return { ...leastCovered, choice: "inside" };

  // ③ 첫 후보를 장면 안으로 밀어 넣는다
  return { ...clampPoint(base[0] ?? { left: range.minLeft, top: range.minTop }), choice: "pushed" };
}
