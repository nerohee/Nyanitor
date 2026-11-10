// 보드가 바뀔 때만 만드는 요약 로그 줄 (phase · pass) — 처음 읽은 것에서는 만들지 않는다 · 섞어 넣기.
import { describe, expect, it } from "vitest";
import { catForAgent } from "../../components/cat/catalog";
import type { HandoffTask, PlanPhase, ProgressRead } from "../../lib/ipc-types";
import { boardChanges, mergeLogs } from "./boardLog";
import type { LogItem } from "./summary";

const phase = (id: string, status: PlanPhase["status"]): PlanPhase => ({ id, summary: id, owners: [], ownersText: "", gate: "", status, statusText: "", name: null, goal: null });
const task = (id: string, status: HandoffTask["status"], owner = "ui"): HandoffTask => ({ label: `briefs/${id}-x.md`, brief: `briefs/${id}-x.md`, id, phase: id.split("-")[0] ?? null, owner, status, statusText: "", progress: null });
const read = (phases: PlanPhase[], tasks: HandoffTask[], version = "v"): ProgressRead => ({
  version,
  plan: { state: "ok", phases },
  handoff: { state: "ok", skill: null, requirements: null, phase: null, updated: null, current: { state: "ok", value: { state: "working", text: "" } }, tasks: { state: "ok", value: tasks }, waiting: { state: "ok", value: [] }, next: { state: "ok", value: [] } },
});

describe("보드 바뀜 → 로그 줄", () => {
  it("처음 읽은 것(이전이 없음)에서는 만들지 않는다", () => {
    expect(boardChanges(null, read([phase("P7", "done")], [task("P7-01", "passed")]), 1)).toEqual([]);
  });

  it("지금 단계가 끝남으로 → phase 줄 (먹물)", () => {
    const items = boardChanges(read([phase("P7", "now")], []), read([phase("P7", "done")], []), 5);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "phase", atMs: 5, text: "P7 단계가 끝났어요", cat: catForAgent("main") });
  });

  it("작업이 검수 통과로 → pass 줄 (그 작업의 담당 고양이)", () => {
    const items = boardChanges(read([phase("P7", "now")], [task("P7-01", "back", "system")]), read([phase("P7", "now")], [task("P7-01", "passed", "system")]), 7);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "pass", atMs: 7, text: "P7-01 작업이 검수를 통과했어요", cat: catForAgent("system") });
  });

  it("바뀌지 않았거나 이미 통과였거나 처음 보이는 작업이면 만들지 않는다", () => {
    const before = read([phase("P6", "done"), phase("P7", "now")], [task("P7-01", "passed")]);
    expect(boardChanges(before, read([phase("P6", "done"), phase("P7", "now")], [task("P7-01", "passed")]), 1)).toEqual([]);
    expect(boardChanges(read([phase("P7", "now")], []), read([phase("P7", "now")], [task("P7-02", "passed")]), 1)).toEqual([]);
    // 아직 → 끝남(지금을 거치지 않음)도 지금 단계가 끝난 것이 아니다
    expect(boardChanges(read([phase("P8", "todo")], []), read([phase("P8", "done")], []), 1)).toEqual([]);
  });

  it("표나 메모를 못 읽는 쪽은 건너뛴다 (나머지는 그대로)", () => {
    const prev = read([phase("P7", "now")], [task("P7-01", "back")]);
    const next: ProgressRead = { ...read([phase("P7", "done")], [task("P7-01", "passed")]), plan: { state: "unreadable", reason: "no_table" } };
    expect(boardChanges(prev, next, 1).map((item) => item.kind)).toEqual(["pass"]);
    const memoBad: ProgressRead = { ...read([phase("P7", "done")], []), handoff: { state: "unreadable", reason: "no_section" } };
    expect(boardChanges(prev, memoBad, 1).map((item) => item.kind)).toEqual(["phase"]);
  });
});

describe("로그 섞기", () => {
  const item = (key: string, atMs: number | null): LogItem => ({ key, atMs, cat: catForAgent("main") as LogItem["cat"], kind: "assign", text: key });
  it("시각순, 시각을 모르는 줄은 앞 줄을 따른다, 보드 줄이 없으면 그대로", () => {
    const chat = [item("a", 10), item("b", null), item("c", 30)];
    expect(mergeLogs(chat, [])).toBe(chat);
    expect(mergeLogs(chat, [item("x", 20), item("y", 40)]).map((entry) => entry.key)).toEqual(["a", "b", "x", "c", "y"]);
  });
});

describe("내 연결 (P9-05)", () => {
  const mine = { cats: { main: "nabi" }, labels: {} };

  it("단계가 끝난 줄과 담당을 모르는 · 직접 담당 줄은 바뀐 오케스트레이터 고양이", () => {
    const phased = boardChanges(read([phase("P7", "now")], []), read([phase("P7", "done")], []), 5, mine);
    expect(phased[0]?.cat).toBe("nabi");
    const direct = boardChanges(read([phase("P7", "now")], [task("P7-01", "back", "직접")]), read([phase("P7", "now")], [task("P7-01", "passed", "직접")]), 7, mine);
    expect(direct[0]?.cat).toBe("nabi");
    const unknown = boardChanges(read([phase("P7", "now")], [task("P7-01", "back", "누군가")]), read([phase("P7", "now")], [task("P7-01", "passed", "누군가")]), 7, mine);
    expect(unknown[0]?.cat).toBe("nabi");
  });
});
