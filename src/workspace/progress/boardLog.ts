// 앱이 켜져 있는 동안 보드가 바뀌면 요약 로그에 넣을 줄 (D-49) — 순수 함수. 처음 읽은 것에서는 만들지 않는다 (`prev` 가 없으면 빈 목록).
//  · 지금(`now`) 단계가 끝남(`done`)으로 → `phase` "P7 단계가 끝났어요" (먹물)
//  · 작업이 `검수 통과`(`passed`)로 → `pass` "P7-01 작업이 검수를 통과했어요" (그 작업의 담당 고양이, 모르면 먹물)
import type { CatId } from "../../components/cat/catalog";
import { tf } from "../../i18n/ko";
import type { ProgressRead } from "../../lib/ipc-types";
import { ownerCat } from "./board";
import { ORCHESTRATOR } from "./placement";
import type { LogItem } from "./summary";

export function boardChanges(prev: ProgressRead | null, next: ProgressRead, atMs: number): LogItem[] {
  if (!prev) return [];
  const items: LogItem[] = [];
  if (prev.plan.state === "ok" && next.plan.state === "ok") {
    const before = new Map(prev.plan.phases.map((phase) => [phase.id, phase.status]));
    for (const phase of next.plan.phases) {
      if (before.get(phase.id) === "now" && phase.status === "done") {
        items.push({ key: `b-phase-${phase.id}-${atMs}`, atMs, cat: ORCHESTRATOR, kind: "phase", text: tf("ws.progress.log.phase", { phase: phase.id }) });
      }
    }
  }
  if (prev.handoff.state === "ok" && next.handoff.state === "ok" && prev.handoff.tasks.state === "ok" && next.handoff.tasks.state === "ok") {
    const before = new Map(prev.handoff.tasks.value.map((task) => [task.id ?? task.label, task.status]));
    for (const task of next.handoff.tasks.value) {
      const id = task.id ?? task.label;
      const was = before.get(id);
      if (was !== undefined && was !== "passed" && task.status === "passed") {
        const cat: CatId = ownerCat(task.owner) ?? ORCHESTRATOR;
        items.push({ key: `b-pass-${id}-${atMs}`, atMs, cat, kind: "pass", text: tf("ws.progress.log.pass", { task: task.id ?? task.label }) });
      }
    }
  }
  return items;
}

/** 채팅에서 만든 로그와 보드 줄을 시각순으로 합친다 (시각을 모르는 줄은 바로 앞 줄의 시각을 따른다, 같으면 앞 목록이 먼저) */
export function mergeLogs(chat: readonly LogItem[], board: readonly LogItem[]): LogItem[] {
  if (board.length === 0) return chat as LogItem[];
  let last = 0;
  const sorted = [...chat, ...board].map((item, seq) => {
    last = item.atMs ?? last;
    return { item, at: last, seq };
  });
  sorted.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return sorted.map((entry) => entry.item);
}
