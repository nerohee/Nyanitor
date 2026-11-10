// 둥근 창문 속 고양이 자리 — 순수 함수 (화면 없음). 규칙 (D-49 · P7-04):
//  · 작업자: `reviewer` 역할은 `watching`(캣타워), 나머지 역할은 `making`(캣휠). 먹물: 기다리는 카드가 있으면 `wait`(댓돌), 아니면 `rest`.
//  · 기다리는 카드를 보낸 이(`WaitingAsker`)가 댓돌에 선다 — 작업자의 권한 카드면 그 작업자의 고양이(캣휠 · 캣타워 대신), 아니면 먹물. 창문 가운데도 그 고양이 (P7-07, 고객 고름).
//    댓돌에 선 작업자는 일 자리를 비우므로, 그 자리는 다른 작업자가 얻는다.
//  · 같은 자리를 둘이 원하면 먼저 시작한 작업자가 차지하고, 뒤에 시작한 작업자는 쉬는 자리로 밀린다 (`assignSpots` 가 쉬는 자리를 좋아하는 자리부터 준다).
//    같은 고양이를 가리키는 작업자가 둘이면 먼저 시작한 쪽만 일한다 (고양이는 한 마리).
import { CAT_IDS, type CatId } from "../../components/cat/catalog";
import type { Crop } from "../../components/house/HouseScene";
import { staticPlacements, type CatIntent, type CatPlacement, type Intents } from "../../components/house/schedule";
import { SPOTS, STAGE } from "../../components/house/spots";
import { orchCat, type Mine } from "../../lib/mine";
import { catForWorker, roleOfWorker, type WorkerRoles } from "./workerCat";
import type { WorkerEntry } from "./workers";

/** 창문에 보이는 배경 영역의 크기 (4 : 3 — 창문 모양과 같다) */
export const WINDOW_VIEW = { w: 620, h: 465 } as const;

/** 답을 기다리는 카드를 보낸 이 — `worker` 가 작업자 이름이면 그 작업자, `null` 이면 먹물(질문 · 승인 · 먹물 쪽 권한). 기다리는 카드가 없으면 이 값 자체가 `null` */
export interface WaitingAsker {
  worker: string | null;
}

/** 기다리는 이의 고양이 */
export function askerCat(asker: WaitingAsker, roles?: WorkerRoles, mine?: Mine): CatId {
  return asker.worker === null ? orchCat(mine) : catForWorker(asker.worker, { roles, mine });
}

/** 작업자 한 명의 의도 */
export function intentOfWorker(name: string, roles?: WorkerRoles): "making" | "watching" {
  return roleOfWorker(name, roles) === "reviewer" ? "watching" : "making";
}

export interface WindowScene {
  placements: CatPlacement[];
  crop: Crop;
  /** 창문 가운데에 오는 고양이 — 기다리는 고양이, 없으면 먼저 시작한 일하는 고양이, 그것도 없으면 먹물 */
  focus: CatId;
  /** 지금 일 자리에 선 고양이들 (먼저 시작한 순 — 댓돌에서 기다리는 고양이는 빠진다) */
  working: CatId[];
  /** 일하는 작업자가 가리키는 고양이 전부 (자리에서 밀린 고양이도, 같은 고양이는 한 번) — 창문 이름표 · 작은 창문의 수 */
  all: CatId[];
}

/** `working` 은 시작 순(`workingWorkers`). `waiting` = 답을 기다리는 카드를 보낸 이 (없으면 `null`) */
export function windowIntents(working: readonly WorkerEntry[], waiting: WaitingAsker | null, roles?: WorkerRoles, mine?: Mine): { intents: Intents; working: CatId[] } {
  const intents = Object.fromEntries(CAT_IDS.map((cat): [CatId, CatIntent] => [cat, "rest"])) as Record<CatId, CatIntent>;
  const spotTaken = new Set<CatIntent>();
  const placed: CatId[] = [];
  // 작업자가 보낸 카드가 기다리면 그 고양이는 일 자리 대신 댓돌 (먹물이 보낸 카드면 먹물 — 같은 고양이를 가리키는 작업자가 일하고 있으면 그 일이 먼저)
  const waitCat = waiting && waiting.worker !== null ? askerCat(waiting, roles, mine) : null;
  const orchestrator = orchCat(mine);
  for (const worker of working) {
    const cat = catForWorker(worker.name, { roles, mine });
    if (cat === waitCat) continue;
    const intent = intentOfWorker(worker.name, roles);
    if (placed.includes(cat) || spotTaken.has(intent)) continue;
    spotTaken.add(intent);
    intents[cat] = intent;
    placed.push(cat);
  }
  if (waitCat !== null) intents[waitCat] = "wait";
  else if (waiting && !placed.includes(orchestrator)) intents[orchestrator] = "wait";
  return { intents, working: placed };
}

export function windowScene(working: readonly WorkerEntry[], waiting: WaitingAsker | null, roles?: WorkerRoles, mine?: Mine): WindowScene {
  const { intents, working: placed } = windowIntents(working, waiting, roles, mine);
  const placements = staticPlacements(intents);
  const first = working[0] ? catForWorker(working[0].name, { roles, mine }) : null;
  const focus = waiting ? askerCat(waiting, roles, mine) : (first ?? orchCat(mine));
  const at = placements.find((p) => p.cat === focus);
  // 아무도 일하지 않고 기다리는 카드도 없으면 방석 쪽 (먹물이 쉬는 자리가 어디든 창문은 같게)
  const spot = first !== null || waiting ? (at?.spot ?? "cushion") : "cushion";
  const feet = SPOTS[spot].feet;
  const x = Math.min(Math.max(feet.x - WINDOW_VIEW.w / 2, 0), STAGE.width - WINDOW_VIEW.w);
  const y = Math.min(Math.max(feet.y - WINDOW_VIEW.h * 0.62, 0), STAGE.height - WINDOW_VIEW.h);
  const all = [...new Set(working.map((item) => catForWorker(item.name, { roles, mine })))];
  return { placements, crop: { x, y, ...WINDOW_VIEW }, focus, working: placed, all };
}
