// 집의 일 상태 — 지금 세션 프로젝트의 일하는 작업자 · 기다리는 카드 → 고양이 집의 의도 + 고양이별 일 정보.
// 자리 규칙은 진행 탭 둥근 창문과 같다 (`progress/placement.ts` 의 `windowIntents`) — 여기서는 그 결과를 집에 맞게 묶기만 한다.
// 어느 프로젝트를 보나: 집은 프로젝트를 고르지 않는다 — 지금 세션의 프로젝트(`session.projectId`). 세션이 없으면 모두 쉰다 (세션이 끝나면 저장소가 작업자도 끝낸다).
import { useMemo } from "react";
import type { CatId } from "../components/cat/catalog";
import { REST_ALL, type CatIntent, type Intents } from "../components/house/schedule";
import { t, tf } from "../i18n/ko";
import { selectPending, selectWorkers, useSessionStore } from "../workspace/chat/sessionStore";
import { ORCHESTRATOR, windowIntents } from "../workspace/progress/placement";
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

/** 먹물이 댓돌에서 기다리는 일 */
export interface HomeWaiting {
  cat: CatId;
  projectId: number;
  /** 답을 기다리는 카드 수 */
  count: number;
}

export interface HomeWork {
  intents: Intents;
  /** 일 자리에 선 고양이 → 그 일 (자리에서 밀려 쉬는 고양이는 없다) */
  jobs: Partial<Record<CatId, HomeJob>>;
  waiting: HomeWaiting | null;
}

const NO_WORK: HomeWork = { intents: REST_ALL, jobs: {}, waiting: null };

/** 순수 함수 — `projectId` 가 null 이면(세션 없음) 모두 쉰다. `workers` 는 그 프로젝트의 작업자 전부, `pending` 은 기다리는 카드 수 */
export function homeWork(projectId: number | null, workers: readonly WorkerEntry[], pending: number, roles?: WorkerRoles): HomeWork {
  if (projectId === null) return NO_WORK;
  const working = workingWorkers(workers);
  const { intents, working: placed } = windowIntents(working, pending > 0, roles);
  const jobs: Partial<Record<CatId, HomeJob>> = {};
  for (const cat of placed) {
    // 한 고양이를 가리키는 작업자가 여럿이면 먼저 시작한 쪽 (windowIntents 와 같은 규칙)
    const worker = working.find((item) => catForWorker(item.name, { roles }) === cat);
    const intent = intents[cat];
    if (!worker || (intent !== "making" && intent !== "watching")) continue;
    jobs[cat] = { cat, projectId, worker: worker.name, description: worker.description?.trim() || null, startedAtMs: worker.startedAtMs, intent };
  }
  const waiting = intents[ORCHESTRATOR] === "wait" ? { cat: ORCHESTRATOR, projectId, count: pending } : null;
  return { intents, jobs, waiting };
}

/** 일한 지 얼마 — 진행 탭 일하는 고양이 줄과 같은 표기 ("3분째" · "방금 시작했어요") */
export function workedText(startedAtMs: number, nowMs: number): string {
  const n = Math.floor((nowMs - startedAtMs) / 60_000);
  return n >= 1 ? tf("ws.progress.minutes", { n }) : t("ws.progress.justNow");
}

export function useHomeWork(): HomeWork {
  const projectId = useSessionStore((state) => state.session?.projectId ?? null);
  const workers = useSessionStore(selectWorkers(projectId));
  const pending = useSessionStore(selectPending(projectId));
  const roles = useWorkerRoles(projectId !== null);
  return useMemo(() => homeWork(projectId, workers, pending, roles), [projectId, workers, pending, roles]);
}
