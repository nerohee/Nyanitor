// 둥근 창문의 고양이 자리 규칙 — 작업자(리뷰어는 캣타워, 나머지는 캣휠) · 먹물(기다리면 댓돌) · 자리가 모자랄 때(먼저 시작한 작업자가 차지).
import { describe, expect, it } from "vitest";
import { catForAgent, type CatId } from "../../components/cat/catalog";
import { intentOfWorker, ORCHESTRATOR, windowIntents, windowScene } from "./placement";
import type { WorkerEntry } from "./workers";

const worker = (name: string, startedAtMs: number): WorkerEntry => ({
  toolUseId: `t-${name}-${startedAtMs}`,
  agentId: null,
  name,
  description: null,
  background: false,
  depth: 1,
  startedAtMs,
  activity: null,
  status: "running",
  endedAtMs: null,
});

const cat = (role: string) => catForAgent(role) as CatId;
const spotOf = (placements: { cat: CatId; spot: string }[], who: CatId) => placements.find((p) => p.cat === who)?.spot;

describe("작업자의 의도", () => {
  it("리뷰어는 watching, 나머지 역할은 making, 모르는 이름도 making", () => {
    expect(intentOfWorker("harness-reviewer")).toBe("watching");
    expect(intentOfWorker("harness-builder-ui")).toBe("making");
    expect(intentOfWorker("harness-tester")).toBe("making");
    expect(intentOfWorker("general-purpose")).toBe("making");
    // 에이전트 목록의 역할이 이름 모양보다 먼저
    expect(intentOfWorker("my-checker", new Map([["my-checker", "reviewer" as const]]))).toBe("watching");
  });
});

describe("창문 의도 — 작업자 · 먹물", () => {
  it("일하는 작업자는 캣휠 · 캣타워, 먹물은 기다리는 카드가 있어야 댓돌", () => {
    const scene = windowScene([worker("harness-builder-ui", 1), worker("harness-reviewer", 2)], true);
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(spotOf(scene.placements, cat("reviewer"))).toBe("tower");
    expect(spotOf(scene.placements, ORCHESTRATOR)).toBe("stone");
    expect(scene.working).toEqual([cat("ui"), cat("reviewer")]);
  });

  it("먹물이 기다리지 않으면 쉰다 (댓돌이 아님)", () => {
    const { intents } = windowIntents([worker("harness-tester", 1)], false);
    expect(intents[ORCHESTRATOR]).toBe("rest");
    expect(intents[cat("tester")]).toBe("making");
    expect(Object.values(intents).filter((intent) => intent === "making")).toHaveLength(1);
  });

  it("아무도 일하지 않고 기다리지도 않으면 모두 쉬고, 가운데는 먹물", () => {
    const scene = windowScene([], false);
    expect(windowIntents([], false).intents[ORCHESTRATOR]).toBe("rest");
    expect(scene.focus).toBe(ORCHESTRATOR);
    expect(scene.working).toEqual([]);
    expect(scene.placements.every((p) => p.spot !== "wheel" && p.spot !== "tower" && p.spot !== "stone")).toBe(true);
  });

  it("먹물만 기다리면 댓돌 — 창문 가운데도 댓돌 쪽", () => {
    const waiting = windowScene([], true);
    const resting = windowScene([], false);
    expect(spotOf(waiting.placements, ORCHESTRATOR)).toBe("stone");
    expect(waiting.crop.x).not.toBe(resting.crop.x);
  });
});

describe("자리가 모자랄 때", () => {
  it("캣휠을 둘이 원하면 먼저 시작한 작업자가 차지하고 뒤 작업자는 쉬는 자리로 밀린다", () => {
    const late = worker("harness-builder-system", 20);
    const early = worker("harness-builder-ui", 10);
    // `workingWorkers` 가 시작 순으로 넘겨 준다
    const scene = windowScene([early, late], false);
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(spotOf(scene.placements, cat("system"))).not.toBe("wheel");
    expect(spotOf(scene.placements, cat("system"))).not.toBe("tower");
    expect(scene.working).toEqual([cat("ui")]);
    // 밀려도 일하는 고양이다 — 창문 이름표 · 작은 창문의 수에는 들어간다
    expect(scene.all).toEqual([cat("ui"), cat("system")]);
    expect(scene.focus).toBe(cat("ui"));
  });

  it("같은 고양이를 가리키는 작업자가 둘이어도 한 마리 — 먼저 시작한 쪽만", () => {
    const scene = windowScene([worker("harness-builder-ui", 1), worker("harness-ui", 2)], false);
    expect(scene.working).toEqual([cat("ui")]);
    expect(scene.placements.filter((p) => p.cat === cat("ui"))).toHaveLength(1);
  });

  it("먹물과 같은 고양이를 가리키는 작업자가 있으면 먹물은 댓돌로 가지 않는다 (고양이는 한 마리)", () => {
    const { intents } = windowIntents([worker("harness-main", 1)], true);
    expect(intents[ORCHESTRATOR]).toBe("making");
  });

  it("일하는 둘이 일 자리가 달라도(휠 · 타워) 서로 밀리지 않는다", () => {
    const scene = windowScene([worker("harness-reviewer", 1), worker("harness-builder-ui", 2)], false);
    expect(spotOf(scene.placements, cat("reviewer"))).toBe("tower");
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(scene.focus).toBe(cat("reviewer"));
  });
});
