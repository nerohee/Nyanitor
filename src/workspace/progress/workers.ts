// 작업자(서브에이전트) 목록 — 프로젝트마다 하나. 세션 상태 · 실시간 이벤트 · 채팅 기록 세 곳에서 오는 같은 작업자를 `toolUseId` 로 하나로 합친다 (순수 함수, 화면 없음).
// 세션 저장소(`chat/sessionStore.ts`)가 쥐고, 진행 탭(P7-04)이 `workingWorkers` · `recentWorkers` 로 고른다.
import type { ChatEntry, ChatWorkerState, ChatWorkerStatus, ClaudeEvent, WorkerOutcome } from "../../lib/ipc-types";

/** 작업자가 지금 하는 일 (`worker_activity` — 실시간만, 기록에는 없다) */
export interface WorkerActivity {
  tool: string | null;
  summary: string | null;
  toolUses: number | null;
}

export interface WorkerEntry {
  /** 작업자를 부른 도구 호출의 ID — 같은 작업자인지 가르는 열쇠 */
  toolUseId: string;
  agentId: string | null;
  /** 에이전트 이름 (`harness-builder-ui` 등) — 고양이는 `catForWorker` 로 */
  name: string;
  description: string | null;
  background: boolean;
  depth: number;
  startedAtMs: number;
  activity: WorkerActivity | null;
  status: ChatWorkerStatus;
  endedAtMs: number | null;
}

/** 한 프로젝트가 쥘 작업자 수 — 넘으면 끝난 것 가운데 오래된 것부터 버린다 (Rust 의 한꺼번에 200 개 상한보다 넉넉히) */
export const WORKERS_MAX = 300;

type Started = Extract<ClaudeEvent, { type: "worker_started" }>;

function entryOf(event: Started, state: ChatWorkerState | null | undefined): WorkerEntry {
  return {
    toolUseId: event.toolUseId,
    agentId: event.agentId,
    name: event.name,
    description: event.description,
    background: event.background,
    depth: event.depth,
    startedAtMs: event.atMs,
    activity: null,
    status: state?.status ?? "running",
    endedAtMs: state?.endedAtMs ?? null,
  };
}

/** 같은 작업자가 두 곳에서 오면 하나로 — 설명은 새것, 상태는 더 나아간 쪽(끝남이 일하는 중을 이긴다), 하는 일은 있던 것 */
function merge(old: WorkerEntry, next: WorkerEntry): WorkerEntry {
  const keep = old.status !== "running";
  const status = keep ? old.status : next.status;
  return { ...next, activity: status === "running" ? (old.activity ?? next.activity) : null, status, endedAtMs: keep ? old.endedAtMs : next.endedAtMs };
}

function upsert(list: readonly WorkerEntry[], next: WorkerEntry): WorkerEntry[] {
  const index = list.findIndex((item) => item.toolUseId === next.toolUseId);
  const result = index < 0 ? [...list, next] : list.map((item, i) => (i === index ? merge(item, next) : item));
  return trim(result);
}

function trim(list: WorkerEntry[]): WorkerEntry[] {
  if (list.length <= WORKERS_MAX) return list;
  let extra = list.length - WORKERS_MAX;
  return list.filter((item) => {
    if (extra > 0 && item.status !== "running") {
      extra -= 1;
      return false;
    }
    return true;
  });
}

function change(list: readonly WorkerEntry[], toolUseId: string, fn: (item: WorkerEntry) => WorkerEntry): WorkerEntry[] {
  const index = list.findIndex((item) => item.toolUseId === toolUseId);
  if (index < 0) return list as WorkerEntry[];
  const next = fn(list[index] as WorkerEntry);
  return next === list[index] ? (list as WorkerEntry[]) : list.map((item, i) => (i === index ? next : item));
}

/** 실시간 · 세션 상태의 이벤트 하나를 목록에 넣는다 (작업자와 상관없는 이벤트는 그대로) */
export function applyWorkerEvent(list: readonly WorkerEntry[], event: ClaudeEvent): WorkerEntry[] {
  switch (event.type) {
    case "worker_started":
      return upsert(list, entryOf(event, null));
    case "worker_activity":
      return change(list, event.toolUseId, (item) => (item.status === "running" ? { ...item, activity: { tool: event.tool, summary: event.summary, toolUses: event.toolUses } } : item));
    case "worker_ended":
      return change(list, event.toolUseId, (item) => (item.status === "running" ? endedOf(item, event.outcome, event.atMs) : item));
    default:
      return list as WorkerEntry[];
  }
}

function endedOf(item: WorkerEntry, outcome: WorkerOutcome, atMs: number | null): WorkerEntry {
  return { ...item, status: outcome, endedAtMs: atMs, activity: null };
}

/** 일하는 중인 것을 모두 `stopped` 로 — 세션이 끝났거나 새로 시작했을 때. `atMs` 를 모르면 null */
export function stopAllWorkers(list: readonly WorkerEntry[], atMs: number | null = null): WorkerEntry[] {
  if (!list.some((item) => item.status === "running")) return list as WorkerEntry[];
  return list.map((item) => (item.status === "running" ? endedOf(item, "stopped", atMs) : item));
}

/**
 * 채팅 기록 쪽(`ChatEntry`)의 작업자 시작 항목들을 목록에 합친다. `live` = 이 프로젝트에 지금 세션이 돈다 —
 * 아니면 기록이 "일하는 중" 이라 해도 끝 알림을 못 받은 것이니 `stopped` 로 본다.
 */
export function mergeHistoryWorkers(list: readonly WorkerEntry[], entries: readonly ChatEntry[], live: boolean): WorkerEntry[] {
  let result = [...list];
  for (const entry of entries) {
    if (entry.event.type !== "worker_started") continue;
    const state = entry.worker ?? null;
    const settled: ChatWorkerState | null = state && state.status === "running" && !live ? { status: "stopped", endedAtMs: null } : state;
    result = upsert(result, entryOf(entry.event, settled));
  }
  return result;
}

/** 지금 일하는 작업자 — 시작 순 (먼저 시작한 것이 앞) */
export function workingWorkers(list: readonly WorkerEntry[]): WorkerEntry[] {
  return list.filter((item) => item.status === "running").sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** 최근에 끝난 작업자 — 끝난 때가 가까운 것이 앞, 최대 `limit` 명. 끝난 때를 모르면(멈춤) 시작한 때로 */
export function recentWorkers(list: readonly WorkerEntry[], limit = 5): WorkerEntry[] {
  const at = (item: WorkerEntry) => item.endedAtMs ?? item.startedAtMs;
  return list
    .filter((item) => item.status !== "running")
    .sort((a, b) => at(b) - at(a))
    .slice(0, limit);
}
