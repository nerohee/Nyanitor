// 내 고양이 연결(`custom/agent-cats.json`) · 보이는 이름(`custom/agent-labels.json`)을 앱 전체가 함께 쓰는 곳 (D-52).
// 읽기: 앱이 켜진 뒤 처음 쓰일 때 둘을 같이 읽어 들고 있는다. 못 읽거나 `state` 가 `ok` 가 아니면 빈 것 — 기본 연결 · 역할 이름으로 그린다 (오류 띠 없음).
// 다시 읽는 때: 「내 수정」 화면이 저장 · 되돌리기 · 만들기 · 기록 되돌리기 · 버리기 뒤 목록을 다시 읽을 때 읽은 것을 `setMine` 으로 알린다 (`edit/useCustom.ts`).
// 구독: `useMine()` — 바뀌면 그린 화면이 다시 그려진다. 순수 함수(`mineCat` · `mineLabel` · `orchCat`)는 상태 없이 부를 수 있다.
// 키: 에이전트 이름 (`harness-builder-ui` · `translator`), 오케스트레이터는 `main`.
import { useEffect, useSyncExternalStore } from "react";
import { catForAgent, findCat, type CatId } from "../components/cat/catalog";
import { t } from "../i18n/ko";
import type { AgentRole } from "./ipc-types";
import { ipc } from "./ipc";

export interface Mine {
  /** 내 고양이 연결 — 에이전트 이름(오케스트레이터는 `main`) → 고양이 id */
  cats: Readonly<Record<string, string>>;
  /** 보이는 이름 — 에이전트 이름 → 보이는 이름 */
  labels: Readonly<Record<string, string>>;
}

/** 아무것도 정하지 않았다 (읽기 전 · 못 읽음) — 기본 연결 · 역할 이름 그대로 */
export const NO_MINE: Mine = { cats: {}, labels: {} };

// ── 순수 함수 ──

/**
 * 고양이 — 내 연결(에이전트 이름 / `main`) → 기본 연결(역할). 카탈로그에 없는 내 고양이는 건너뛴다.
 * 오케스트레이터(`main`)는 기본 연결도 없으면 먹물, 역할도 없는 다른 에이전트는 `null` (집에 나오지 않음 · 기본 아이콘).
 */
export function mineCat(agentName: string, role: AgentRole | null, mine: Mine): CatId | null {
  const chosen = mine.cats[agentName];
  if (chosen !== undefined && findCat(chosen)) return chosen as CatId;
  if (agentName === "main") return catForAgent("main") as CatId;
  return role ? (catForAgent(role) as CatId) : null;
}

/** 이름 — 보이는 이름 → 역할 이름 → 에이전트 이름. 오케스트레이터는 보이는 이름이 없다 (역할 이름) */
export function mineLabel(agentName: string, role: AgentRole | null, mine: Mine): string {
  if (agentName !== "main") {
    const chosen = mine.labels[agentName];
    if (chosen !== undefined && chosen !== "") return chosen;
  }
  return role ? t(`home.info.role.${role}`) : agentName;
}

/** 오케스트레이터의 고양이 — 내 연결의 `main` → 먹물 */
export function orchCat(mine: Mine = getMine()): CatId {
  return mineCat("main", "main", mine) as CatId;
}

// ── 들고 있는 것 ──

let current: Mine | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** 지금 들고 있는 것 (아직 못 읽었으면 `NO_MINE`) */
export function getMine(): Mine {
  return current ?? NO_MINE;
}

/** 읽은 것을 알린다 — 구독한 화면이 다시 그린다. 같은 내용이면 알리지 않는다 */
export function setMine(next: Mine): void {
  const same = current !== null && sameRecord(current.cats, next.cats) && sameRecord(current.labels, next.labels);
  current = same ? current : { cats: { ...next.cats }, labels: { ...next.labels } };
  if (same) return;
  for (const listener of [...listeners]) listener();
}

function sameRecord(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** 두 파일을 같이 읽는다 — 못 읽거나 `ok` 가 아닌 쪽은 빈 것. 둘 다 명령이 실패하면 `null` (다음에 다시 읽는다) */
async function read(): Promise<Mine | null> {
  const [cats, labels] = await Promise.allSettled([Promise.resolve().then(() => ipc.customCatsRead()), Promise.resolve().then(() => ipc.customLabelsRead())]);
  if (cats.status === "rejected" && labels.status === "rejected") return null;
  return {
    cats: cats.status === "fulfilled" && cats.value.state === "ok" ? cats.value.agents : {},
    labels: labels.status === "fulfilled" && labels.value.state === "ok" ? labels.value.agents : {},
  };
}

/** 한 번도 안 읽었으면 읽는다 (돌고 있으면 그것을 기다린다) */
export function ensureMine(): Promise<void> {
  if (current !== null) return Promise.resolve();
  loading ??= read().then(
    (mine) => {
      loading = null;
      // 읽는 사이 「내 수정」이 먼저 알렸으면 그것이 더 새것
      if (mine && current === null) setMine(mine);
    },
    () => {
      loading = null;
    },
  );
  return loading;
}

/** 다시 읽는다 — 읽지 못하면 들고 있던 것을 그대로 둔다 */
export async function reloadMine(): Promise<void> {
  const mine = await read();
  if (mine) setMine(mine);
}

/** 시험용 — 들고 있는 것을 버린다 */
export function resetMine(): void {
  current = null;
  loading = null;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 내 연결 · 보이는 이름 — 처음 쓰일 때 읽고, 「내 수정」에서 바뀌면 다시 그린다 */
export function useMine(): Mine {
  const mine = useSyncExternalStore(subscribe, getMine, getMine);
  useEffect(() => {
    void ensureMine();
  }, []);
  return mine;
}
