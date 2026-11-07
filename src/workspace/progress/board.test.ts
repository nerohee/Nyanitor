// 단계 보드의 순수 규칙 — 담당 낱말 → 고양이, 단계의 화면 상태(기다림), 그 단계의 작업, 지시서 이름.
import { describe, expect, it } from "vitest";
import { catForAgent } from "../../components/cat/catalog";
import type { HandoffInfo, HandoffRead, HandoffTask, PlanPhase } from "../../lib/ipc-types";
import { boardCounts, ownerCat, phaseView, taskName, tasksOfPhase, waitingItems } from "./board";

const phase = (id: string, status: PlanPhase["status"]): PlanPhase => ({ id, summary: id, owners: [["ui"]], ownersText: "ui", gate: "", status, statusText: "", name: null, goal: null });
const task = (brief: string | null, id: string | null, p: string | null, label = brief ?? "(메모)"): HandoffTask => ({ label, brief, id, phase: p, owner: "ui", status: "assigned", statusText: "맡김", progress: null });
const memo = (state: "working" | "waiting_answer" | "waiting_run" | "between" | "unknown", tasks: HandoffTask[] = [], waiting: string[] = []): Extract<HandoffRead, { state: "ok" }> => {
  const info: HandoffInfo = {
    skill: null,
    requirements: null,
    phase: null,
    updated: null,
    current: { state: "ok", value: { state, text: "" } },
    tasks: { state: "ok", value: tasks },
    waiting: { state: "ok", value: waiting },
    next: { state: "ok", value: [] },
  };
  return { state: "ok", ...info };
};

describe("담당 낱말 → 고양이", () => {
  it("역할 낱말과 직접(먹물)은 고양이, 모르는 말은 null", () => {
    expect(ownerCat("ui")).toBe(catForAgent("ui"));
    expect(ownerCat("직접")).toBe(catForAgent("main"));
    expect(ownerCat(" reviewer ")).toBe(catForAgent("reviewer"));
    expect(ownerCat("고침은 담당별")).toBeNull();
  });
});

describe("단계의 화면 상태", () => {
  it("지금 단계 + 메모가 답 · 실행 확인 기다림이면 waiting, 일하는 중이면 now", () => {
    expect(phaseView(phase("P7", "now"), memo("working"))).toBe("now");
    expect(phaseView(phase("P7", "now"), memo("waiting_answer"))).toBe("waiting");
    expect(phaseView(phase("P7", "now"), memo("waiting_run"))).toBe("waiting");
    expect(phaseView(phase("P7", "now"), memo("between"))).toBe("now");
  });
  it("메모가 없거나 읽을 수 없으면 now 그대로, 다른 상태는 그대로", () => {
    expect(phaseView(phase("P7", "now"), { state: "absent" })).toBe("now");
    expect(phaseView(phase("P7", "now"), { state: "unreadable", reason: "no_section" })).toBe("now");
    expect(phaseView(phase("P6", "done"), memo("waiting_answer"))).toBe("done");
    expect(phaseView(phase("P8", "todo"), memo("waiting_answer"))).toBe("todo");
    expect(phaseView(phase("P9", "unknown"), memo("working"))).toBe("unknown");
  });
});

describe("그 단계의 작업", () => {
  it("phase 가 같은 작업만, 메모를 못 읽으면 빈 목록", () => {
    const a = task("briefs/P7-01-x.md", "P7-01", "P7");
    const b = task("briefs/P6-01-y.md", "P6-01", "P6");
    expect(tasksOfPhase(phase("P7", "now"), memo("working", [a, b]))).toEqual([a]);
    expect(tasksOfPhase(phase("P7", "now"), { state: "absent" })).toEqual([]);
    const broken: HandoffRead = { ...memo("working"), tasks: { state: "unreadable", reason: "no_table" } };
    expect(tasksOfPhase(phase("P7", "now"), broken)).toEqual([]);
  });
  it("지시서 이름 — 앞의 번호와 briefs/ · .md 를 뗀다, 지시서가 아니면 글 그대로", () => {
    expect(taskName(task("briefs/P7-01-project-docs.md", "P7-01", "P7"))).toBe("project-docs");
    expect(taskName(task("briefs/P7-01.md", "P7-01", "P7"))).toBe("P7-01");
    expect(taskName(task("briefs/other.md", null, null))).toBe("other");
    expect(taskName(task(null, null, null, "(P2-01 ~ P2-03 검수 통과)"))).toBe("(P2-01 ~ P2-03 검수 통과)");
  });
});

describe("기다리는 것 · 단계 수", () => {
  it("메모의 기다리는 것 (없거나 못 읽으면 빈 목록)", () => {
    expect(waitingItems(memo("waiting_answer", [], ["a", "b"]))).toEqual(["a", "b"]);
    expect(waitingItems({ state: "absent" })).toEqual([]);
  });
  it("끝난 단계 수 / 전체 (표를 못 읽으면 null)", () => {
    const ok = { version: "v", plan: { state: "ok" as const, phases: [phase("P0", "done"), phase("P1", "now")] }, handoff: { state: "absent" as const } };
    expect(boardCounts(ok)).toEqual({ done: 1, total: 2 });
    expect(boardCounts({ ...ok, plan: { state: "absent" } })).toBeNull();
  });
});
