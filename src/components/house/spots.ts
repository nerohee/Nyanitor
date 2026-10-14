// 고양이 집 장면의 배치 데이터 — 자리 · 물건 · 깊이 (docs/01-planning/cat-art-guide.md §2).
// 좌표는 모두 **배경 그림 `bg-day.webp` 의 원본 픽셀**(1536 × 1024) 이다. 그림을 바꾸면 이 파일의 숫자만 다시 잰다.
import type { CatMotion, PoseName } from "../cat/CatFigure";

export const STAGE = { width: 1536, height: 1024 } as const;

/** 고양이 · 물건 판(앉은 고양이 키 300px 인 세계) → 배경 배율 (cat-assets.md §A5) */
export const WORLD_SCALE = 0.37;

export type SpotId =
  | "sun"
  | "cushion"
  | "box"
  | "bowl"
  | "room"
  | "stone"
  | "ball"
  | "wheel"
  | "towerTop"
  | "towerMid"
  | "shade";

/** 쉬는 자리 · 사용자를 기다리는 자리 · 일하는 자리 (캣휠 = 만드는 일, 캣타워 = 보는 일) */
export type SpotKind = "rest" | "wait" | "work";

export interface Point {
  x: number;
  y: number;
}

export interface Spot {
  id: SpotId;
  kind: SpotKind;
  /** 고양이 발 기준점 */
  feet: Point;
  /** 이 자리 동작 — 첫째가 기본, 나머지는 가끔 바꿔 본다 */
  poses: readonly PoseName[];
  /** 자세 위 움직임을 이 자리 식으로 바꿀 때 (캣타워의 sit = look …) */
  motion?: Partial<Record<PoseName, CatMotion>>;
  /** 깊이 — 없으면 발 y. 물건 위에 앉는 고양이는 그 물건보다 1 위 */
  z?: number;
  /** 상자: 이 다각형(발 기준 배경 px) 안만 보인다 — 앞 테두리 V 아래를 잘라 "들어가 있는" 모습 */
  clip?: readonly Point[];
  /** 상자: 고양이가 쏙 들어갔다 나오는 움직임 */
  peek?: boolean;
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
  /** 놓는 점 (발 · 가운데 · 매다는 곳) — 판 안의 좌표 */
  ax: number;
  ay: number;
}

export const ART = {
  cushion: { file: "cushion", w: 512, h: 320, ax: 256, ay: 301 },
  box: { file: "box", w: 448, h: 384, ax: 224, ay: 361 },
  bowl: { file: "bowl", w: 192, h: 128, ax: 96, ay: 120 },
  "cat-tower": { file: "cat-tower", w: 512, h: 1024, ax: 256, ay: 963 },
  "wheel-ring": { file: "wheel-ring", w: 768, h: 768, ax: 384, ay: 384 },
  "wheel-stand": { file: "wheel-stand", w: 768, h: 512, ax: 384, ay: 481 },
  ball: { file: "ball", w: 96, h: 96, ax: 48, ay: 90 },
  "wind-chime": { file: "wind-chime", w: 160, h: 320, ax: 80, ay: 13 },
  "bush-front": { file: "bush-front", w: 768, h: 512, ax: 384, ay: 481 },
} as const satisfies Record<string, Art>;

export type ArtName = keyof typeof ART;

export interface Prop {
  id: string;
  art: ArtName;
  /** 놓는 점이 닿을 배경 좌표 */
  at: Point;
  z: number;
  /** 그림을 이 배율로 더 줄인다 (기본 1) */
  scale?: number;
  /** 캣휠 판 안에 놓는다 (장면 각도로 기울임) */
  plane?: boolean;
}

// 물건 놓는 곳
const CUSHION = { x: 880, y: 392 };
// 상자와 몸 단장 자리는 맞바꿨다 (Q58 ④) — 상자는 툇마루 왼쪽 끝, 몸 단장은 가운데
const BOX = { x: 730, y: 360 };
// 캣타워는 툇마루 위가 아니라 바로 앞 마당 평지 (Q58 ③)
const TOWER = { x: 1290, y: 800 };
const WHEEL = { x: 440, y: 740 };

/** 캣휠: 받침 그림의 축(받침 판 y 118)에 바퀴가 달리고, 바퀴 아래는 받침 널빤지 위(판 y 400)에 닿는다 */
export const WHEEL_RING_SCALE = 0.8;
const WHEEL_AXLE = { x: WHEEL.x, y: WHEEL.y - (481 - 118) * WORLD_SCALE };
/** 캣휠 판 — 바퀴와 받침을 함께 감싸는 상자 (배경 px). 이 상자를 skewY 로 기울인다 */
const WHEEL_HALF_W = (768 * WORLD_SCALE) / 2;
const WHEEL_TOP = WHEEL_AXLE.y - (768 * WORLD_SCALE * WHEEL_RING_SCALE) / 2;
export const WHEEL_PLANE = { x: WHEEL.x - WHEEL_HALF_W, y: WHEEL_TOP, w: WHEEL_HALF_W * 2, h: WHEEL.y - WHEEL_TOP };

export const PROPS: readonly Prop[] = [
  { id: "cushion", art: "cushion", at: CUSHION, z: depth(CUSHION.y) },
  { id: "box", art: "box", at: BOX, z: depth(BOX.y) },
  { id: "bowl", art: "bowl", at: { x: 1227, y: 552 }, z: depth(552) },
  { id: "tower", art: "cat-tower", at: TOWER, z: depth(TOWER.y) },
  { id: "wheel-ring", art: "wheel-ring", at: WHEEL_AXLE, z: depth(WHEEL.y, -1), scale: WHEEL_RING_SCALE, plane: true },
  { id: "wheel-stand", art: "wheel-stand", at: WHEEL, z: depth(WHEEL.y, 2), plane: true },
  { id: "ball", art: "ball", at: { x: 800, y: 766 }, z: depth(766) },
  { id: "bush-front", art: "bush-front", at: { x: 1470, y: 830 }, z: 99500 },
];

/** 풍경 — 처마에 매달려 살랑. `at` 은 줄이 매이는 곳 */
export const CHIME: Prop = { id: "wind-chime", art: "wind-chime", at: { x: 1075, y: 55 }, z: 99000 };

/** 판 안의 점 하나를 배경 좌표로 (물건 `at` 기준) */
function offset(base: Point, art: Art, canvas: Point): Point {
  return { x: base.x + (canvas.x - art.ax) * WORLD_SCALE, y: base.y + (canvas.y - art.ay) * WORLD_SCALE };
}

// 판 윗면 마름모의 가운데를 발 자리로 (새 그림에서 잰 값, 판 좌표)
const TOWER_TOP = offset(TOWER, ART["cat-tower"], { x: 253, y: 130 });
const TOWER_MID = offset(TOWER, ART["cat-tower"], { x: 253, y: 477 });
const CUSHION_TOP = offset(CUSHION, ART.cushion, { x: 253, y: 165 });
/** 상자 안: 고양이는 상자 바닥(판 y 260)에 앉은 듯 */
const BOX_SEAT = offset(BOX, ART.box, { x: 224, y: 260 });
/** 앞 테두리는 V 모양 — 왼쪽 모서리 (73,161) · 아래 꼭짓점 (220,232) · 오른쪽 모서리 (375,161) (판 좌표). 그 위만 보인다 */
const BOX_CLIP: readonly Point[] = [
  [-200, -500],
  [700, -500],
  [700, 161],
  [375, 161],
  [220, 232],
  [73, 161],
  [-200, 161],
].map(([cx, cy]) => ({ x: (cx - 224) * WORLD_SCALE, y: (cy - 260) * WORLD_SCALE }));
const WHEEL_FEET = offset(WHEEL, ART["wheel-stand"], { x: 384, y: 392 });

export const SPOTS: Record<SpotId, Spot> = {
  sun: { id: "sun", kind: "rest", feet: { x: 1000, y: 448 }, poses: ["groom", "loaf"], bubble: ["left", "below"] },
  cushion: {
    id: "cushion",
    kind: "rest",
    feet: CUSHION_TOP,
    poses: ["sleep", "loaf"],
    z: depth(CUSHION.y, 1),
    bubble: ["below", "left"],
  },
  box: {
    id: "box",
    kind: "rest",
    feet: BOX_SEAT,
    poses: ["sit"],
    z: depth(BOX.y, 1),
    clip: BOX_CLIP,
    peek: true,
    bubble: ["below", "right"],
  },
  bowl: {
    id: "bowl",
    kind: "rest",
    feet: { x: 1180, y: 540 },
    poses: ["eat"],
    z: depth(552, 1), // 밥 먹는 고양이는 그릇보다 위 층 (Q57)
    bubble: ["left", "below"],
  },
  room: { id: "room", kind: "rest", feet: { x: 1085, y: 335 }, poses: ["back", "loaf"], bubble: ["below", "left"] },
  stone: {
    id: "stone",
    kind: "wait",
    feet: { x: 1000, y: 615 },
    poses: ["sit"],
    motion: { sit: "wait" },
    bubble: ["left", "above"],
  },
  ball: { id: "ball", kind: "rest", feet: { x: 720, y: 758 }, poses: ["play"], bubble: ["above", "right"] },
  wheel: {
    id: "wheel",
    kind: "work",
    feet: WHEEL_FEET,
    poses: ["walk"], // 캣휠은 걷기 그림 (Q55) — run 은 목록에만 남긴다
    motion: { walk: "walk" },
    z: depth(WHEEL.y, 1),
    bubble: ["right", "above"],
  },
  towerTop: {
    id: "towerTop",
    kind: "work",
    feet: TOWER_TOP,
    poses: ["sit", "loaf"],
    motion: { sit: "look", loaf: "look" },
    z: depth(TOWER.y, 1),
    bubble: ["left", "below"],
  },
  towerMid: {
    id: "towerMid",
    kind: "work",
    feet: TOWER_MID,
    poses: ["loaf"],
    motion: { loaf: "look" },
    z: depth(TOWER.y, 2),
    bubble: ["left", "above"],
  },
  shade: { id: "shade", kind: "rest", feet: { x: 200, y: 665 }, poses: ["sleep", "loaf"], bubble: ["right", "above"] },
};

export const SPOT_IDS = Object.keys(SPOTS) as SpotId[];

/** 고양이가 자리에 있을 때의 깊이 */
export function spotDepth(spot: Spot): number {
  return spot.z ?? depth(spot.feet.y);
}

/** 위치 · 하는 일을 나타내는 이름 — `cat.activity.<이름>` 문구 (ko.ts) */
export type Activity = SpotId | "walk";

export function isWorkSpot(activity: Activity): boolean {
  return activity !== "walk" && SPOTS[activity].kind === "work";
}

/** 문구 이름 — 캣타워 위 · 가운데는 한 문구를 같이 쓴다 */
export type ActivityKey = Exclude<Activity, "towerTop" | "towerMid"> | "tower";

export function activityTextKey(activity: Activity): ActivityKey {
  return activity === "towerTop" || activity === "towerMid" ? "tower" : activity;
}

