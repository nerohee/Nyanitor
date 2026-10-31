// 카드에 덮인 고양이 자리 — 위 카드 · 아래 판 카드가 장면 그림의 일부를 덮는다. 창이 좁을수록 더 많이 덮어,
// 그 밑 자리의 고양이는 보이지도 눌리지도 않는다. 고양이 누르는 상자(자리 · 자세마다 다름)가 한 카드에 절반 이상 덮이면 그 자리는 막는다.
// 화면 코드와 섞이지 않는 순수 함수 (시험 가능) — Home 이 상자들을 재서 넣고, 일정(`assignSpots`)이 막힌 자리를 피한다.
import { CAT_IDS, catScale, findCat, type CatEntry } from "../cat/catalog";
import { overlaps, type Box } from "./bubble";
import { POSE_BOX, SINK, SPOT_IDS, SPOTS, STAGE, WORLD_SCALE, spotPropK, type SpotId } from "./spots";

/** 가장 큰 고양이 배율 — 누르는 상자는 7마리 중 가장 큰 고양이 기준 */
const MAX_CAT_SCALE = Math.max(1, ...CAT_IDS.map((id) => catScale(findCat(id) as CatEntry)));

/** 한 자리에서 고양이를 누르는 상자 (배경 px) — 그 자리의 모든 동작 · 합친 그림의 상자를 합친 것 */
export function spotHitBox(id: SpotId): Box {
  const spot = SPOTS[id];
  const k = WORLD_SCALE * MAX_CAT_SCALE;
  const boxes: Box[] = spot.poses.map((pose) => {
    const base = pose === "with" ? "sit" : pose;
    const box = POSE_BOX[base];
    const top = spot.feet.y - (box.h - (SINK[base] ?? 0)) * k;
    return { left: spot.feet.x - (box.w / 2) * k, top, right: spot.feet.x + (box.w / 2) * k, bottom: top + box.h * k };
  });
  if (spot.prop) {
    const pk = spotPropK(spot);
    const { hit, seat } = spot.prop;
    const left = spot.feet.x + (hit.x - seat.x) * pk;
    const top = spot.feet.y + (hit.y - seat.y) * pk;
    boxes.push({ left, top, right: left + hit.w * pk, bottom: top + hit.h * pk });
  }
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

/** 장면 상자(화면 좌표)가 배경 그림을 꽉 채울 때 — 배경 px 상자를 화면 좌표로 (house.css `.hs-stage` 와 같은 식) */
export function stageToScreen(box: Box, scene: Box): Box {
  const width = scene.right - scene.left;
  const height = scene.bottom - scene.top;
  const u = Math.max(width / STAGE.width, height / STAGE.height);
  const x = (n: number) => scene.left + width / 2 + (n - STAGE.width / 2) * u;
  const y = (n: number) => scene.top + height / 2 + (n - STAGE.height / 2) * u;
  return { left: x(box.left), top: y(box.top), right: x(box.right), bottom: y(box.bottom) };
}

/**
 * 누르는 상자가 이만큼 이상 한 카드에 덮이면 막는다 (P6-07 고객).
 * 누르는 상자는 모든 자세 · 가장 큰 고양이를 합친 것이라 넉넉하다 — 절반이 덮여도 실제 고양이는 그보다 덜 가려진다.
 */
export const BLOCK_COVER = 0.5;

function coverOf(hit: Box, card: Box): number {
  if (!overlaps(hit, card)) return 0;
  const w = Math.min(hit.right, card.right) - Math.max(hit.left, card.left);
  const h = Math.min(hit.bottom, card.bottom) - Math.max(hit.top, card.top);
  return (w * h) / ((hit.right - hit.left) * (hit.bottom - hit.top));
}

/** 카드(화면 좌표)에 누르는 상자가 절반 이상 덮인 자리들 */
export function blockedSpots(scene: Box, cards: readonly Box[]): SpotId[] {
  if (scene.right - scene.left <= 0 || scene.bottom - scene.top <= 0) return [];
  return SPOT_IDS.filter((id) => {
    const hit = stageToScreen(spotHitBox(id), scene);
    return cards.some((card) => coverOf(hit, card) >= BLOCK_COVER);
  });
}
