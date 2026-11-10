// 둥근 창문의 고양이 자리 규칙 — 작업자(리뷰어는 캣타워, 나머지는 캣휠) · 먹물(기다리면 댓돌) · 자리가 모자랄 때(먼저 시작한 작업자가 차지).
import { describe, expect, it } from "vitest";
import { catForAgent, type CatId } from "../../components/cat/catalog";
import { intentOfWorker, windowIntents, windowScene } from "./placement";
import type { WorkerEntry } from "./workers";

/** 내 연결이 없을 때의 오케스트레이터 */
const ORCHESTRATOR = catForAgent("main") as CatId;

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
    const scene = windowScene([worker("harness-builder-ui", 1), worker("harness-reviewer", 2)], { worker: null });
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(spotOf(scene.placements, cat("reviewer"))).toBe("tower");
    expect(spotOf(scene.placements, ORCHESTRATOR)).toBe("stone");
    expect(scene.working).toEqual([cat("ui"), cat("reviewer")]);
  });

  it("먹물이 기다리지 않으면 쉰다 (댓돌이 아님)", () => {
    const { intents } = windowIntents([worker("harness-tester", 1)], null);
    expect(intents[ORCHESTRATOR]).toBe("rest");
    expect(intents[cat("tester")]).toBe("making");
    expect(Object.values(intents).filter((intent) => intent === "making")).toHaveLength(1);
  });

  it("아무도 일하지 않고 기다리지도 않으면 모두 쉬고, 가운데는 먹물", () => {
    const scene = windowScene([], null);
    expect(windowIntents([], null).intents[ORCHESTRATOR]).toBe("rest");
    expect(scene.focus).toBe(ORCHESTRATOR);
    expect(scene.working).toEqual([]);
    expect(scene.placements.every((p) => p.spot !== "wheel" && p.spot !== "tower" && p.spot !== "stone")).toBe(true);
  });

  it("먹물만 기다리면 댓돌 — 창문 가운데도 댓돌 쪽", () => {
    const waiting = windowScene([], { worker: null });
    const resting = windowScene([], null);
    expect(spotOf(waiting.placements, ORCHESTRATOR)).toBe("stone");
    expect(waiting.crop.x).not.toBe(resting.crop.x);
  });
});

describe("기다리는 카드를 보낸 이", () => {
  it("먹물의 카드(질문 · 승인)면 먹물이 댓돌, 창문 가운데도 먹물 — 일하는 작업자는 그대로", () => {
    const scene = windowScene([worker("harness-builder-ui", 1)], { worker: null });
    expect(spotOf(scene.placements, ORCHESTRATOR)).toBe("stone");
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(scene.focus).toBe(ORCHESTRATOR);
    expect(scene.working).toEqual([cat("ui")]);
  });

  it("작업자의 권한 카드면 그 작업자 고양이가 캣휠 대신 댓돌 — 먹물은 쉬고, 창문 가운데가 그 고양이", () => {
    const scene = windowScene([worker("harness-reviewer", 1), worker("harness-builder-ui", 2)], { worker: "harness-builder-ui" });
    expect(spotOf(scene.placements, cat("ui"))).toBe("stone");
    expect(spotOf(scene.placements, ORCHESTRATOR)).not.toBe("stone");
    expect(spotOf(scene.placements, cat("reviewer"))).toBe("tower");
    expect(scene.focus).toBe(cat("ui"));
    expect(scene.working).toEqual([cat("reviewer")]);
    // 창문 이름표에는 여전히 일하는 고양이다
    expect(scene.all).toEqual([cat("reviewer"), cat("ui")]);
    expect(scene.crop).not.toEqual(windowScene([worker("harness-reviewer", 1), worker("harness-builder-ui", 2)], null).crop);
  });

  it("기다리는 작업자가 캣휠을 비우면 뒤에 시작한 다른 작업자가 캣휠을 얻는다", () => {
    const { intents, working } = windowIntents([worker("harness-builder-ui", 1), worker("harness-builder-system", 2)], { worker: "harness-builder-ui" });
    expect(intents[cat("ui")]).toBe("wait");
    expect(intents[cat("system")]).toBe("making");
    expect(working).toEqual([cat("system")]);
  });

  it("기다리는 작업자가 이미 끝났어도(목록에 없어도) 그 고양이가 댓돌", () => {
    const scene = windowScene([], { worker: "harness-tester" });
    expect(spotOf(scene.placements, cat("tester"))).toBe("stone");
    expect(scene.focus).toBe(cat("tester"));
  });

  it("카드가 없으면 지금과 같다 — 첫 일하는 고양이가 가운데", () => {
    const scene = windowScene([worker("harness-tester", 1)], null);
    expect(scene.focus).toBe(cat("tester"));
    expect(scene.placements.some((p) => p.spot === "stone")).toBe(false);
  });
});

describe("자리가 모자랄 때", () => {
  it("캣휠을 둘이 원하면 먼저 시작한 작업자가 차지하고 뒤 작업자는 쉬는 자리로 밀린다", () => {
    const late = worker("harness-builder-system", 20);
    const early = worker("harness-builder-ui", 10);
    // `workingWorkers` 가 시작 순으로 넘겨 준다
    const scene = windowScene([early, late], null);
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(spotOf(scene.placements, cat("system"))).not.toBe("wheel");
    expect(spotOf(scene.placements, cat("system"))).not.toBe("tower");
    expect(scene.working).toEqual([cat("ui")]);
    // 밀려도 일하는 고양이다 — 창문 이름표 · 작은 창문의 수에는 들어간다
    expect(scene.all).toEqual([cat("ui"), cat("system")]);
    expect(scene.focus).toBe(cat("ui"));
  });

  it("같은 고양이를 가리키는 작업자가 둘이어도 한 마리 — 먼저 시작한 쪽만", () => {
    const scene = windowScene([worker("harness-builder-ui", 1), worker("harness-ui", 2)], null);
    expect(scene.working).toEqual([cat("ui")]);
    expect(scene.placements.filter((p) => p.cat === cat("ui"))).toHaveLength(1);
  });

  it("먹물과 같은 고양이를 가리키는 작업자가 있으면 먹물은 댓돌로 가지 않는다 (고양이는 한 마리)", () => {
    const { intents } = windowIntents([worker("harness-main", 1)], { worker: null });
    expect(intents[ORCHESTRATOR]).toBe("making");
  });

  it("일하는 둘이 일 자리가 달라도(휠 · 타워) 서로 밀리지 않는다", () => {
    const scene = windowScene([worker("harness-reviewer", 1), worker("harness-builder-ui", 2)], null);
    expect(spotOf(scene.placements, cat("reviewer"))).toBe("tower");
    expect(spotOf(scene.placements, cat("ui"))).toBe("wheel");
    expect(scene.focus).toBe(cat("reviewer"));
  });
});

describe("내 연결 (P9-05) — 오케스트레이터 · 작업자 고양이", () => {
  const MINE = { cats: { main: "nabi", "harness-builder-ui": "gureum" }, labels: {} };

  it("main 을 바꾸면 기다리는 카드를 보낸 오케스트레이터는 바뀐 고양이가 댓돌에 서고, 먹물은 서지 않는다", () => {
    const scene = windowScene([], { worker: null }, undefined, MINE);
    expect(spotOf(scene.placements, "nabi")).toBe("stone");
    expect(spotOf(scene.placements, ORCHESTRATOR)).not.toBe("stone");
    expect(scene.focus).toBe("nabi");
    expect(windowScene([], null, undefined, MINE).focus).toBe("nabi");
  });

  it("내 연결로 바꾼 ui 작업자는 바뀐 고양이가 캣휠에 선다", () => {
    const scene = windowScene([worker("harness-builder-ui", 1)], null, undefined, MINE);
    expect(spotOf(scene.placements, "gureum")).toBe("wheel");
    expect(scene.working).toEqual(["gureum"]);
    expect(scene.all).toEqual(["gureum"]);
    expect(spotOf(scene.placements, cat("ui"))).not.toBe("wheel");
  });

  it("내 연결이 없으면(mine 을 안 주면) 예전과 똑같다", () => {
    expect(windowIntents([worker("harness-builder-ui", 1)], null).intents[cat("ui")]).toBe("making");
  });
});
