// 고양이 집 일정 — 누가 어느 자리에 있나. 화면 코드와 섞이지 않는 순수 함수들 (시험 가능).
// P5 에서는 에이전트의 실제 상태를 `CatIntent` 로 바꿔 `assignSpots` 에 넣으면 된다.
import { CAT_IDS, type CatId } from "../cat/catalog";
import { SPOT_IDS, SPOTS, STAGE, type ScenePose, type SpotId } from "./spots";

/** 고양이가 하고 싶은 것 — 실제 에이전트 상태가 이 넷 중 하나로 옮겨진다 (P5) */
export type CatIntent =
  /** 쉬는 중 — 쉬는 자리 중 한 곳 */
  | "rest"
  /** 사용자를 기다림 — 신발 돌 */
  | "wait"
  /** 만드는 일 중 — 캣휠 */
  | "making"
  /** 보는 일 중 — 캣타워 */
  | "watching";

export type Intents = Readonly<Record<CatId, CatIntent>>;
export type Assignment = Readonly<Record<CatId, SpotId>>;
export type Rng = () => number;

/** 장면에 놓인 고양이 한 마리 — 자리 · 자세 · 걷는 중인지 */
export interface CatPlacement {
  cat: CatId;
  spot: SpotId;
  /** 기본 자세, 또는 물건 자리의 합친 그림(`with`) */
  pose: ScenePose;
  facing: "right" | "left";
  /** 걸어서 자리로 가는 중 (왼쪽 · 위치가 CSS 로 미끄러진다) */
  walking: boolean;
  /** 걷는 데 걸리는 시간 */
  walkMs: number;
  /** 사라졌다 나타나는 중 — 자리를 바꾸기 직전(out) · 직후(in) */
  fade: "out" | "in" | null;
  /** 위치를 미끄러지지 않고 바로 옮긴다 */
  instant: boolean;
}

export type Placements = Readonly<Record<CatId, CatPlacement>>;

/** 모두 제자리에 선 처음 모습 */
export function initialPlacements(assignment: Assignment): Placements {
  const entries = CAT_IDS.map((cat): [CatId, CatPlacement] => {
    const spot = assignment[cat];
    return [
      cat,
      { cat, spot, pose: SPOTS[spot].poses[0], facing: "right", walking: false, walkMs: 0, fade: null, instant: true },
    ];
  });
  return Object.fromEntries(entries) as Placements;
}

/** 움직이지 않는 장면용 — 의도대로 자리를 정하고 Tab 순서로 늘어놓는다 (작업 공간의 창문) */
export function staticPlacements(intents: Intents): CatPlacement[] {
  const placements = initialPlacements(assignSpots(intents));
  return TAB_ORDER.map((cat) => placements[cat]);
}

/** 프로필의 "좋아하는 자리" 에서 (cat-assets.md §A10). 쉴 때 먼저 찾아간다 */
export const FAVORITE_SPOT: Readonly<Record<CatId, SpotId>> = {
  mukmul: "bowlRoom",
  nabi: "box",
  mulgam: "cushion",
  danchu: "sun",
  kkaebi: "ball",
  dubu: "bowlPorch",
  gureum: "yard",
};

const REST_SPOTS = SPOT_IDS.filter((id) => SPOTS[id].kind === "rest");

/** 고양이 목록 순서로 한 마리씩 자리를 정한다. 일 자리가 차면 쉬는 자리로 넘어간다. */
export function assignSpots(
  intents: Intents,
  current: Partial<Record<CatId, SpotId>> = {},
  rng: Rng = Math.random,
): Assignment {
  const taken = new Set<SpotId>();
  const result: Partial<Record<CatId, SpotId>> = {};

  const claim = (cat: CatId, candidates: readonly SpotId[]): boolean => {
    const free = candidates.find((id) => !taken.has(id));
    if (!free) return false;
    taken.add(free);
    result[cat] = free;
    return true;
  };

  // 1) 일 · 기다림 자리 (차지하면 그 자리는 그 고양이 것)
  for (const cat of CAT_IDS) {
    const intent = intents[cat];
    if (intent === "making") claim(cat, ["wheel"]);
    else if (intent === "watching") claim(cat, ["tower"]);
    else if (intent === "wait") claim(cat, ["stone"]);
  }

  // 2) 나머지는 쉬는 자리 — 있던 자리를 지키고, 없으면 좋아하는 자리, 그래도 없으면 빈 자리 아무 곳
  for (const cat of CAT_IDS) {
    if (result[cat]) continue;
    const here = current[cat];
    const keep = here && SPOTS[here].kind === "rest" ? [here] : [];
    if (claim(cat, [...keep, FAVORITE_SPOT[cat]])) continue;
    const free = REST_SPOTS.filter((id) => !taken.has(id));
    const pick = free[Math.floor(rng() * free.length)];
    if (pick) {
      taken.add(pick);
      result[cat] = pick;
    }
  }
  return result as Assignment;
}

/** 쉬는 고양이가 이 자리에서 다음에 할 동작 (지금과 다른 것). 하나뿐이면 그대로 */
export function pickPose(spot: SpotId, current: ScenePose, rng: Rng = Math.random): ScenePose {
  const options = SPOTS[spot].poses.filter((pose) => pose !== current);
  if (options.length === 0) return SPOTS[spot].poses[0];
  return options[Math.floor(rng() * options.length)];
}

/** 가끔 일어나는 일 하나 — 쉬는 고양이가 다른 빈 쉬는 자리로 가거나, 제 자리에서 동작을 바꾼다 */
export type Roam =
  | { kind: "move"; cat: CatId; to: SpotId }
  | { kind: "pose"; cat: CatId; pose: ScenePose }
  | null;

export function pickRoam(
  intents: Intents,
  spots: Assignment,
  poses: Readonly<Record<CatId, ScenePose>>,
  rng: Rng = Math.random,
  /** 정보 패널이 열려 있는 고양이 — 그 자리에 둔다 */
  pinned: CatId | null = null,
): Roam {
  const resting = CAT_IDS.filter(
    (cat) => cat !== pinned && intents[cat] === "rest" && SPOTS[spots[cat]].kind === "rest",
  );
  if (resting.length === 0) return null;
  const cat = resting[Math.floor(rng() * resting.length)];
  const occupied = new Set(Object.values(spots));
  const free = REST_SPOTS.filter((id) => !occupied.has(id));
  const canMove = free.length > 0;
  const canPose = SPOTS[spots[cat]].poses.length > 1;
  // 동작 바꾸기가 가능하면 절반은 그것 (자리 바꾸기는 "가끔")
  if (canPose && (!canMove || rng() < 0.5)) return { kind: "pose", cat, pose: pickPose(spots[cat], poses[cat], rng) };
  if (!canMove) return null;
  return { kind: "move", cat, to: free[Math.floor(rng() * free.length)] };
}

/** 일정이 바뀔 때 고양이마다 옮기기 시작하는 시간 (ms) — 0.5~4초 사이로 엇갈린다 */
export const STAGGER_MIN_MS = 500;
export const STAGGER_SPAN_MS = 3500;
/** 자리를 비워 주고 나서 다음 고양이가 들어오기까지 */
const STAGGER_HANDOVER_MS = 600;

/**
 * 옮겨야 하는 고양이마다 기다릴 시간. 가려는 자리에 아직 다른 고양이가 있으면(그 고양이도 옮겨 가는 중)
 * 그 고양이가 떠난 뒤에 들어간다 — 두 마리가 한 자리에 겹치지 않게.
 */
export function staggerDelays(
  moves: readonly { cat: CatId; from: SpotId; to: SpotId }[],
  rng: Rng = Math.random,
): Partial<Record<CatId, number>> {
  const delays: Partial<Record<CatId, number>> = {};
  for (const move of moves) delays[move.cat] = Math.round(STAGGER_MIN_MS + rng() * STAGGER_SPAN_MS);
  // 앞사람이 떠나야 들어갈 수 있는 순서를 따라 뒤로 민다 (최대 고양이 수만큼 되풀이하면 모두 풀린다)
  for (let round = 0; round < moves.length; round++) {
    for (const move of moves) {
      const leaver = moves.find((other) => other.from === move.to && other.cat !== move.cat);
      if (leaver) {
        const earliest = (delays[leaver.cat] ?? 0) + STAGGER_HANDOVER_MS;
        if ((delays[move.cat] ?? 0) < earliest) delays[move.cat] = earliest;
      }
    }
  }
  return delays;
}

export type Travel = { mode: "walk"; ms: number; facing: "right" | "left" } | { mode: "jump" };

/** 한 번에 걷는 거리 — 무대 폭의 25% (cat-art-guide.md §3) */
export const WALK_MAX = STAGE.width * 0.25;
/** 걸을 수 있는 세로 이동의 한계 (배경 px) */
const VERTICAL_MAX = 100;
/** 걷는 빠르기 (배경 px / 초) — 몸길이의 절반쯤 / 초, 느긋하게 (P2-07 디자인 검수) */
const WALK_SPEED = 90;

/** 자리에서 자리로 — 가까우면 걷고, 멀거나 캣휠 · 캣타워에 오르내리면 사라졌다 나타난다 */
export function travel(from: SpotId, to: SpotId): Travel {
  const a = SPOTS[from];
  const b = SPOTS[to];
  const dx = b.feet.x - a.feet.x;
  const dy = b.feet.y - a.feet.y;
  const distance = Math.hypot(dx, dy);
  // 세로로 크게 오르내리는 길(마루 ↔ 마당 · 방)은 걷지 않고 사라졌다 나타난다
  const steep = Math.abs(dy) > VERTICAL_MAX || Math.abs(dy) > Math.abs(dx);
  if (a.kind === "work" || b.kind === "work" || distance > WALK_MAX || steep) return { mode: "jump" };
  const ms = Math.min(4000, Math.max(900, (distance / WALK_SPEED) * 1000));
  return { mode: "walk", ms, facing: dx < 0 ? "left" : "right" };
}

// ── 가짜 일정 (시안 · P5 전까지) ──

const REST_ALL: Intents = {
  mukmul: "rest",
  nabi: "rest",
  mulgam: "rest",
  danchu: "rest",
  kkaebi: "rest",
  dubu: "rest",
  gureum: "rest",
};

/** 시간이 지나며 돌아가는 가짜 일정 — 일하는 고양이 1~2마리, 나머지는 쉼. 첫째가 처음 모습 */
export const FAKE_PLANS: readonly Intents[] = [
  { ...REST_ALL, mukmul: "wait", danchu: "making", gureum: "watching" },
  { ...REST_ALL, mukmul: "wait", nabi: "making", mulgam: "watching" },
  { ...REST_ALL, mukmul: "watching", gureum: "watching", kkaebi: "making", dubu: "making" },
  { ...REST_ALL, mukmul: "wait" },
  REST_ALL,
];

/** 장면의 Tab 순서 — 처음 모습의 왼쪽 → 오른쪽. 고양이가 옮겨 다녀도 바뀌지 않는다 */
export const TAB_ORDER: readonly CatId[] = ["danchu", "kkaebi", "nabi", "mulgam", "mukmul", "dubu", "gureum"];
