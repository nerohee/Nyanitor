// 집의 일 상태 — 지금 세션 프로젝트의 일하는 작업자 · 기다리는 카드 → 고양이 집의 의도 + 고양이별 일 정보.
// 자리 규칙은 진행 탭 둥근 창문과 같다 (`progress/placement.ts` 의 `windowIntents`) — 여기서는 그 결과를 집에 맞게 묶기만 한다.
// 어느 프로젝트를 보나: 집은 프로젝트를 고르지 않는다 — 지금 세션의 프로젝트(`session.projectId`). 세션이 없으면 모두 쉰다 (세션이 끝나면 저장소가 작업자도 끝낸다).
import { useMemo } from "react";
import type { CatId } from "../components/cat/catalog";
import { REST_ALL, type CatIntent, type Intents } from "../components/house/schedule";
import { selectPending, selectWaitingAsker, selectWorkers, useSessionStore } from "../workspace/chat/sessionStore";
import { askerCat, windowIntents, type WaitingAsker } from "../workspace/progress/placement";
import { catForWorker, useWorkerRoles, type WorkerRoles } from "../workspace/progress/workerCat";
import { workingWorkers, type WorkerEntry } from "../workspace/progress/workers";

/** 일 자리에 선 고양이의 일 */
export interface HomeJob {
  cat: CatId;
  projectId: number;
  /** 작업자의 에이전트 이름 */
  worker: string;
  /** 맡긴 일의 짧은 설명 (없으면 null) */
  description: string | null;
  startedAtMs: number;
  intent: Extract<CatIntent, "making" | "watching">;
}

/** 댓돌에서 기다리는 고양이의 일 — 카드를 보낸 이 (먹물, 또는 권한을 물은 작업자) */
export interface HomeWaiting {
  cat: CatId;
  projectId: number;
  /** 답을 기다리는 카드 수 */
  count: number;
  /** 작업자가 보낸 카드면 그 작업자가 맡은 일의 짧은 설명 (먹물이거나 모르면 null) */
  description: string | null;
}

export interface HomeWork {
  intents: Intents;
  /** 일 자리에 선 고양이 → 그 일 (자리에서 밀려 쉬는 고양이는 없다) */
  jobs: Partial<Record<CatId, HomeJob>>;
  waiting: HomeWaiting | null;
}

const NO_WORK: HomeWork = { intents: REST_ALL, jobs: {}, waiting: null };

/** 순수 함수 — `projectId` 가 null 이면(세션 없음) 모두 쉰다. `workers` 는 그 프로젝트의 작업자 전부, `pending` 은 기다리는 카드 수, `asker` 는 맨 앞 기다리는 카드를 보낸 이 (카드가 있는데 모르면 먹물) */
export function homeWork(projectId: number | null, workers: readonly WorkerEntry[], pending: number, asker: WaitingAsker | null, roles?: WorkerRoles): HomeWork {
  if (projectId === null) return NO_WORK;
  const working = workingWorkers(workers);
  const waitingAsker = pending > 0 ? (asker ?? { worker: null }) : null;
  const { intents, working: placed } = windowIntents(working, waitingAsker, roles);
  const jobs: Partial<Record<CatId, HomeJob>> = {};
  for (const cat of placed) {
    // 한 고양이를 가리키는 작업자가 여럿이면 먼저 시작한 쪽 (windowIntents 와 같은 규칙)
    const worker = working.find((item) => catForWorker(item.name, { roles }) === cat);
    const intent = intents[cat];
    if (!worker || (intent !== "making" && intent !== "watching")) continue;
    jobs[cat] = { cat, projectId, worker: worker.name, description: worker.description?.trim() || null, startedAtMs: worker.startedAtMs, intent };
  }
  let waiting: HomeWaiting | null = null;
  if (waitingAsker) {
    const cat = askerCat(waitingAsker, roles);
    if (intents[cat] === "wait") {
      const sender = waitingAsker.worker === null ? undefined : working.find((item) => catForWorker(item.name, { roles }) === cat);
      waiting = { cat, projectId, count: pending, description: sender?.description?.trim() || null };
    }
  }
  return { intents, jobs, waiting };
}

/** 일한 지 얼마 — 진행 탭 일하는 고양이 줄과 같은 표기 ("방금 시작했어요" · "3분째" · "2시간째") */
export { workedText } from "../workspace/progress/elapsed";

export function useHomeWork(): HomeWork {
  const projectId = useSessionStore((state) => state.session?.projectId ?? null);
  const workers = useSessionStore(selectWorkers(projectId));
  const pending = useSessionStore(selectPending(projectId));
  const asker = useSessionStore(selectWaitingAsker(projectId));
  const roles = useWorkerRoles(projectId !== null);
  return useMemo(() => homeWork(projectId, workers, pending, asker, roles), [projectId, workers, pending, asker, roles]);
}
