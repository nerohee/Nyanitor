// 단계 보드의 순수 규칙 — 담당 낱말 → 고양이, 단계 · 작업의 화면 상태, 지시서 이름 (화면 없음).
import { catForAgent, type CatId } from "../../components/cat/catalog";
import type { HandoffRead, HandoffTask, PlanPhase, ProgressRead } from "../../lib/ipc-types";

/** 담당 칸의 낱말 → 고양이 (`agent-cats.json` 의 역할 + `직접` = 먹물). 모르는 말은 null (글로 보인다) */
const OWNER_ROLES: Readonly<Record<string, string>> = {
  main: "main",
  직접: "main",
  designer: "designer",
  ui: "ui",
  system: "system",
  tester: "tester",
  helper: "helper",
  reviewer: "reviewer",
};

export function ownerCat(word: string): CatId | null {
  const role = OWNER_ROLES[word.trim()];
  return role ? (catForAgent(role) as CatId) : null;
}

export type PhaseView = "done" | "now" | "waiting" | "todo" | "unknown";

/** 단계의 화면 상태 — 지금 단계 + 메모가 "사용자 답 기다림 · 실행 확인 기다림" 이면 `waiting` */
export function phaseView(phase: PlanPhase, handoff: HandoffRead): PhaseView {
  if (phase.status === "now") {
    const current = handoff.state === "ok" && handoff.current.state === "ok" ? handoff.current.value.state : null;
    return current === "waiting_answer" || current === "waiting_run" ? "waiting" : "now";
  }
  return phase.status;
}

/** 그 단계의 작업(지시서) — 메모를 읽을 수 있을 때만 */
export function tasksOfPhase(phase: PlanPhase, handoff: HandoffRead): HandoffTask[] {
  if (handoff.state !== "ok" || handoff.tasks.state !== "ok") return [];
  return handoff.tasks.value.filter((task) => task.phase === phase.id);
}

/** 작업 이름 — `briefs/P7-01-project-docs.md` → `project-docs` (아니면 칸의 글 그대로) */
export function taskName(task: HandoffTask): string {
  if (!task.brief) return task.label;
  const base = task.brief.replace(/^briefs\//, "").replace(/\.md$/i, "");
  if (!task.id || !base.startsWith(task.id)) return base;
  return base.slice(task.id.length).replace(/^[-_ ]+/, "") || base;
}

/** 메모가 "사용자에게 기다리는 것" 으로 알리는 글들 (읽을 수 없거나 없으면 빈 목록) */
export function waitingItems(handoff: HandoffRead): string[] {
  return handoff.state === "ok" && handoff.waiting.state === "ok" ? handoff.waiting.value : [];
}

export function boardCounts(read: ProgressRead): { done: number; total: number } | null {
  if (read.plan.state !== "ok") return null;
  return { done: read.plan.phases.filter((phase) => phase.status === "done").length, total: read.plan.phases.length };
}
