// 고양이 집 장면의 배치 데이터 — 자리 · 물건 · 깊이 (docs/01-planning/cat-art-guide.md §4).
// 좌표는 모두 **배경 그림 `bg-day.webp` 의 원본 픽셀**(1536 × 1024) 이다. 그림을 바꾸면 이 파일의 숫자만 다시 잰다.
import type { CatMotion, PoseName } from "../cat/CatFigure";

export const STAGE = { width: 1536, height: 1024 } as const;

/** 고양이 · 물건 판(앉은 고양이 키 300px 인 세계) → 배경 배율 (cat-assets.md §A5). 앉은 고양이 키 ≈ 300 × 0.28 = 84px = 배경 높이의 1/12 */
export const WORLD_SCALE = 0.28;

/** 맞춘 기본 자세 `sit` 그림의 높이(px) — 모든 고양이가 같다 (`fit.py --same-scale`) */
const SIT_HEIGHT = 337;
/** 기본 자세 판 1px 가 배경에서 몇 px 인가 (두부 0.85 곱하기 전) */
export const BASE_K = (WORLD_SCALE * 300) / SIT_HEIGHT;

/**
 * 합친 그림 속 고양이가 기본 자세 고양이와 같은 크기로 보이게 하는 물건 종류별 배율 (기본 자세 배율 대비).
 * 합친 그림은 종류마다 그려진 고양이 크기가 달라서(밥 · 공은 크게, 캣휠은 작게) 머리 폭을 맞춰 잰 값이다.
 * 빈 물건도 같은 배율 — 바꿔 끼워도 물건은 제자리 · 제 크기.
 */
export const PROP_SCALE = {
  bowl: 0.67,
  cushion: 0.8,
  box: 0.86,
  ball: 0.8,
  wheel: 1.34,
  tower: 0.9,
} as const;

/** 풍경은 고양이와 상관없는 장식 — 배경 대비 크기만 (style-scene 풍경 약 52px) */
const CHIME_K = 0.19;

export type WithKey = keyof typeof PROP_SCALE;

export type SpotId =
  | "cushion"
  | "box"
  | "bowlRoom"
  | "bowlPorch"
  | "ball"
  | "tower"
  | "wheel"
  | "yard"
  | "stone"
  | "sun"
  | "lawn"
  | "path";

/** 쉬는 자리 · 사용자를 기다리는 자리 · 일하는 자리 (캣휠 = 만드는 일, 캣타워 = 보는 일) */
export type SpotKind = "rest" | "wait" | "work";

export interface Point {
  x: number;
  y: number;
}

/** 판 안의 상자 (판 px) */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 자리에서 고양이가 하는 동작 — 바닥 자리는 기본 자세, 물건 자리는 합친 그림(`with`) */
export type ScenePose = PoseName | "with";

export interface Spot {
  id: SpotId;
  kind: SpotKind;
  /** 고양이 발 기준점 (물건 자리는 합친 그림 속 고양이의 발) */
  feet: Point;
  /** 이 자리 동작 — 첫째가 기본, 나머지는 가끔 바꿔 본다 */
  poses: readonly ScenePose[];
  /** 자세 위 움직임을 이 자리 식으로 바꿀 때 (신발 돌의 sit = wait …) */
  motion?: Partial<Record<PoseName, CatMotion>>;
  /** 깊이 — 없으면 발 y */
  z?: number;
  /** 물건 자리: 빈 물건 ↔ 합친 그림 */
  prop?: PropSpec;
  /** 말풍선(정보 패널)을 펼칠 쪽 순서 — 먼저 되는 쪽 */
  bubble: readonly ("above" | "below" | "left" | "right")[];
}

/** 깊이(z-index) — 발 y × 10, 한 자리 안의 앞뒤 층은 끝자리로 */
export function depth(y: number, layer = 0): number {
  return Math.round(y) * 10 + layer;
}

// ── 물건 그림 (판 크기와 기준점 — cat-assets.md §A5) ──
export interface Art {
  file: string;
  /** 판 크기 */
  w: number;
  h: number;
  /** 놓는 점 (물건 바닥 기준점 · 매다는 곳) — 판 안의 좌표 */
  ax: number;
  ay: number;
}

/** 빈 물건 그림 — 기준점은 그림 내용 상자의 아래 가운데 (알파로 잰 값) */
export const ART = {
  cushion: { file: "cushion", w: 1024, h: 1024, ax: 512, ay: 774 },
  box: { file: "box", w: 1024, h: 1024, ax: 512, ay: 811 },
  bowl: { file: "bowl", w: 1024, h: 1024, ax: 448, ay: 791 },
  "cat-tower": { file: "cat-tower", w: 1024, h: 1536, ax: 537, ay: 1296 },
  wheel: { file: "wheel", w: 1024, h: 1024, ax: 525, ay: 913 },
  ball: { file: "ball", w: 1024, h: 1024, ax: 720, ay: 811 },
  "wind-chime": { file: "wind-chime", w: 160, h: 320, ax: 80, ay: 13 },
} as const satisfies Record<string, Art>;

export type ArtName = keyof typeof ART;

export interface Prop {
  id: string;
  art: ArtName;
  /** 기준점이 닿을 배경 좌표 */
  at: Point;
  z: number;
  /** 판 1px 가 배경에서 몇 px 인가 */
  k: number;
}

export interface PropSpec {
  art: Exclude<ArtName, "wind-chime">;
  /** 합친 그림 이름 (`with.<kind>`) */
  kind: WithKey;
  /** 물건 바닥 기준점이 닿을 배경 좌표 */
  at: Point;
  /** 합친 그림 속 고양이의 발 — 판 좌표 */
  seat: Point;
  /** 합친 그림에서 고양이가 있는 곳 (누르는 자리) — 판 좌표 */
  hit: Rect;
}

function propK(kind: WithKey): number {
  return BASE_K * PROP_SCALE[kind];
}

/** 판 안의 점 하나를 배경 좌표로 */
function toStage(spec: Pick<PropSpec, "art" | "kind" | "at">, point: Point): Point {
  const art = ART[spec.art];
  const k = propK(spec.kind);
  return { x: spec.at.x + (point.x - art.ax) * k, y: spec.at.y + (point.y - art.ay) * k };
}

function propSpot(
  id: SpotId,
  spec: PropSpec,
  rest: Omit<Spot, "id" | "feet" | "prop" | "poses"> & { poses?: readonly ScenePose[] },
): Spot {
  return { id, feet: toStage(spec, spec.seat), poses: ["with"], ...rest, prop: spec };
}

// 방 안 자리는 늘 툇마루 · 마당 고양이보다 뒤 — 방 바닥(배경 y 330~440) 뒤쪽 깊이
const ROOM_Z = depth(380);

export const SPOTS: Record<SpotId, Spot> = {
  // 툇마루 (왼쪽 → 오른쪽): 방석 · 상자 · 볕 · 끝 밥그릇. 물건 바닥 · 고양이 발은 툇마루 앞 모서리(약 y = 425 + 0.37 × (x − 800))에서
// 안쪽(오른쪽 위 대각)으로 20px 이상 들어오게 (P2-10 2차)
  cushion: propSpot(
    "cushion",
    {
      art: "cushion",
      kind: "cushion",
      at: { x: 800, y: 400 },
      seat: { x: 466, y: 600 },
      hit: { x: 250, y: 320, w: 450, h: 300 },
    },
    { kind: "rest", bubble: ["below", "left"] },
  ),
  box: propSpot(
    "box",
    {
      art: "box",
      kind: "box",
      at: { x: 990, y: 472 },
      seat: { x: 445, y: 525 },
      hit: { x: 300, y: 250, w: 360, h: 290 },
    },
    { kind: "rest", bubble: ["below", "right"] },
  ),
  sun: { id: "sun", kind: "rest", feet: { x: 1150, y: 525 }, poses: ["groom", "loaf"], bubble: ["left", "below"] },
  bowlPorch: propSpot(
    "bowlPorch",
    {
      art: "bowl",
      kind: "bowl",
      at: { x: 1270, y: 570 },
      seat: { x: 740, y: 700 },
      hit: { x: 320, y: 210, w: 540, h: 600 },
    },
    { kind: "rest", bubble: ["left", "below"] },
  ),
  // 방 안 (유리문 너머 장판)
  bowlRoom: propSpot(
    "bowlRoom",
    {
      art: "bowl",
      kind: "bowl",
      at: { x: 1200, y: 425 },
      seat: { x: 740, y: 700 },
      hit: { x: 320, y: 210, w: 540, h: 600 },
    },
    { kind: "rest", z: ROOM_Z, bubble: ["below", "left"] },
  ),
  // 댓돌 (신발 돌) — 사용자를 기다리는 자리
  stone: {
    id: "stone",
    kind: "wait",
    feet: { x: 1050, y: 645 },
    poses: ["sit"],
    motion: { sit: "wait" },
    bubble: ["left", "above"],
  },
  // 마당
  ball: propSpot(
    "ball",
    {
      art: "ball",
      kind: "ball",
      at: { x: 700, y: 640 },
      seat: { x: 330, y: 750 },
      hit: { x: 120, y: 330, w: 520, h: 440 },
    },
    { kind: "rest", bubble: ["above", "right"] },
  ),
  lawn: { id: "lawn", kind: "rest", feet: { x: 800, y: 590 }, poses: ["sit", "loaf", "groom"], bubble: ["above", "left"] },
  path: { id: "path", kind: "rest", feet: { x: 650, y: 742 }, poses: ["loaf", "sleep"], bubble: ["above", "right"] },
  yard: { id: "yard", kind: "rest", feet: { x: 340, y: 682 }, poses: ["loaf", "sleep"], bubble: ["right", "above"] },
  // 일하는 자리 — 캣휠(만드는 일) · 캣타워(보는 일)
  wheel: propSpot(
    "wheel",
    {
      art: "wheel",
      kind: "wheel",
      at: { x: 540, y: 565 },
      seat: { x: 560, y: 655 },
      hit: { x: 400, y: 360, w: 320, h: 310 },
    },
    { kind: "work", bubble: ["right", "above"] },
  ),
  tower: propSpot(
    "tower",
    {
      art: "cat-tower",
      kind: "tower",
      at: { x: 1110, y: 810 },
      seat: { x: 440, y: 750 },
      hit: { x: 240, y: 360, w: 370, h: 410 },
    },
    { kind: "work", bubble: ["left", "below"] },
  ),
};

export const SPOT_IDS = Object.keys(SPOTS) as SpotId[];

/** 빈 물건 — 자리마다 하나 (그릇은 두 곳) */
export const PROPS: readonly Prop[] = SPOT_IDS.flatMap((id) => {
  const spot = SPOTS[id];
  if (!spot.prop) return [];
  return [{ id, art: spot.prop.art, at: spot.prop.at, z: propDepth(spot), k: propK(spot.prop.kind) }];
});

/** 풍경 — 처마 보 밑에 매달려 살랑. `at` 은 줄이 매이는 곳 */
export const CHIME: Prop = { id: "wind-chime", art: "wind-chime", at: { x: 1010, y: 72 }, z: 99000, k: CHIME_K };

/** 물건 자리의 판 → 배경 배율 */
export function spotPropK(spot: Spot): number {
  return spot.prop ? propK(spot.prop.kind) : 0;
}

/** 물건 · 합친 그림의 깊이 — 물건 바닥 기준점 y */
function propDepth(spot: Spot): number {
  return spot.z ?? depth(spot.prop ? spot.prop.at.y : spot.feet.y);
}

/** 고양이가 자리에 있을 때의 깊이 — 바닥 자리는 발 y, 물건 자리는 그 물건보다 한 층 위 (누르는 자리 · 이름표) */
export function spotDepth(spot: Spot): number {
  return propDepth(spot) + (spot.prop ? 1 : 0);
}

/** 위치 · 하는 일을 나타내는 이름 — `cat.activity.<이름>` 문구 (ko.ts) */
export type Activity = SpotId | "walk";

export function isWorkSpot(activity: Activity): boolean {
  return activity !== "walk" && SPOTS[activity].kind === "work";
}

/** 문구 이름 (자리 이름 그대로) */
export type ActivityKey = Activity;

export function activityTextKey(activity: Activity): ActivityKey {
  return activity;
}
