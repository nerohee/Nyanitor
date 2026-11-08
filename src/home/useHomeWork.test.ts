// 집의 일 상태 — 세션 없음 · 작업자 하나 · 둘이 같은 자리 · 점검 → 캣타워 · 하네스 밖 작업자 → 두부 · 기다리는 카드 → 먹물 댓돌 · 다른 프로젝트 작업자는 안 보임.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { catForAgent, type CatId } from "../components/cat/catalog";
import { REST_ALL } from "../components/house/schedule";
import { newChat, resetSessionStore, useSessionStore } from "../workspace/chat/sessionStore";
import type { WorkerEntry } from "../workspace/progress/workers";
import { homeWork, useHomeWork, workedText } from "./useHomeWork";

const cat = (role: string) => catForAgent(role) as CatId;

const worker = (name: string, startedAtMs: number, extra: Partial<WorkerEntry> = {}): WorkerEntry => ({
  toolUseId: `t-${name}-${startedAtMs}`,
  agentId: null,
  name,
  description: "일",
  background: false,
  depth: 1,
  startedAtMs,
  activity: null,
  status: "running",
  endedAtMs: null,
  ...extra,
});

describe("homeWork — 순수 부분", () => {
  it("세션이 없으면 모두 쉰다 (예전과 같은 의도)", () => {
    const work = homeWork(null, [], 0);
    expect(work.intents).toBe(REST_ALL);
    expect(work.jobs).toEqual({});
    expect(work.waiting).toBeNull();
  });

  it("작업자 하나 — 그 고양이가 캣휠, 일 정보에 프로젝트 · 작업자 이름 · 설명 · 시작 시각", () => {
    const work = homeWork(3, [worker("harness-builder-ui", 100, { description: " 사진 목록 화면 " })], 0);
    expect(work.intents[cat("ui")]).toBe("making");
    expect(work.intents[cat("main")]).toBe("rest");
    expect(work.jobs[cat("ui")]).toEqual({ cat: cat("ui"), projectId: 3, worker: "harness-builder-ui", description: "사진 목록 화면", startedAtMs: 100, intent: "making" });
    expect(Object.keys(work.jobs)).toHaveLength(1);
    expect(work.waiting).toBeNull();
  });

  it("설명이 비었으면 null", () => {
    expect(homeWork(1, [worker("harness-tester", 1, { description: "  " })], 0).jobs[cat("tester")]?.description).toBeNull();
    expect(homeWork(1, [worker("harness-tester", 1, { description: null })], 0).jobs[cat("tester")]?.description).toBeNull();
  });

  it("둘이 같은 자리를 원하면 먼저 시작한 쪽만 일하고 뒤는 쉰다 (일 정보도 앞쪽만)", () => {
    const work = homeWork(1, [worker("harness-tester", 20), worker("harness-builder-ui", 10)], 0);
    expect(work.intents[cat("ui")]).toBe("making");
    expect(work.intents[cat("tester")]).toBe("rest");
    expect(Object.keys(work.jobs)).toEqual([cat("ui")]);
  });

  it("점검(reviewer)은 캣타워 — 캣휠 작업자와 함께 있을 수 있다", () => {
    const work = homeWork(1, [worker("harness-builder-ui", 1), worker("harness-reviewer", 2)], 0);
    expect(work.intents[cat("reviewer")]).toBe("watching");
    expect(work.jobs[cat("reviewer")]?.intent).toBe("watching");
    expect(work.jobs[cat("ui")]?.intent).toBe("making");
  });

  it("하네스 밖 작업자(general-purpose)는 두부가 캣휠", () => {
    const work = homeWork(1, [worker("general-purpose", 1)], 0);
    expect(work.intents[cat("helper")]).toBe("making");
    expect(work.jobs[cat("helper")]?.worker).toBe("general-purpose");
  });

  it("끝난 작업자는 일하지 않는다", () => {
    const work = homeWork(1, [worker("harness-builder-ui", 1, { status: "done", endedAtMs: 5 })], 0);
    expect(work.intents[cat("ui")]).toBe("rest");
    expect(work.jobs).toEqual({});
  });

  it("기다리는 카드가 있으면 먹물이 댓돌 — 수도 같이", () => {
    const work = homeWork(7, [], 2);
    expect(work.intents[cat("main")]).toBe("wait");
    expect(work.waiting).toEqual({ cat: cat("main"), projectId: 7, count: 2 });
    expect(work.jobs).toEqual({});
    expect(homeWork(7, [], 0).waiting).toBeNull();
  });

  it("작업자와 기다림이 같이 있어도 따로 — 작업자는 캣휠, 먹물은 댓돌", () => {
    const work = homeWork(1, [worker("harness-builder-ui", 1)], 1);
    expect(work.intents[cat("ui")]).toBe("making");
    expect(work.intents[cat("main")]).toBe("wait");
  });
});

describe("workedText — 진행 탭과 같은 표기", () => {
  it("1분 아래는 방금, 그 뒤는 n분째", () => {
    expect(workedText(1000, 1000 + 59_000)).toBe("방금 시작했어요");
    expect(workedText(1000, 1000 + 3 * 60_000 + 5)).toBe("3분째");
  });
});

describe("useHomeWork — 세션 저장소", () => {
  afterEach(() => resetSessionStore());

  const put = (projectId: number, workers: WorkerEntry[]) =>
    act(() => useSessionStore.setState((state) => ({ chats: { ...state.chats, [projectId]: { ...(state.chats[projectId] ?? newChat()), workers } } })));
  const startSession = (projectId: number) => act(() => useSessionStore.setState({ session: { projectId, busy: false, sessionId: null } }));

  it("세션이 없으면 작업자가 남아 있어도 모두 쉰다", () => {
    put(1, [worker("harness-builder-ui", 1)]);
    const { result } = renderHook(() => useHomeWork());
    expect(result.current.intents).toBe(REST_ALL);
  });

  it("지금 세션의 프로젝트 작업자만 본다 — 다른 프로젝트 작업자는 안 보임", () => {
    put(1, [worker("harness-builder-ui", 1)]);
    put(2, [worker("harness-tester", 2)]);
    startSession(2);
    const { result } = renderHook(() => useHomeWork());
    expect(result.current.intents[cat("tester")]).toBe("making");
    expect(result.current.intents[cat("ui")]).toBe("rest");
    expect(result.current.jobs[cat("tester")]?.projectId).toBe(2);
  });

  it("작업자가 끝나면 쉬는 자리로 돌아오고, 같은 의도면 같은 값을 유지한다", () => {
    startSession(1);
    put(1, [worker("harness-builder-ui", 1)]);
    const { result } = renderHook(() => useHomeWork());
    expect(result.current.intents[cat("ui")]).toBe("making");
    const before = result.current;
    // 관계없는 상태가 바뀌어도 새로 계산하지 않는다
    act(() => useSessionStore.setState({ queueError: null, answeredTurns: 1 }));
    expect(result.current).toBe(before);
    put(1, [worker("harness-builder-ui", 1, { status: "done", endedAtMs: 9 })]);
    expect(result.current.intents[cat("ui")]).toBe("rest");
    expect(result.current.jobs).toEqual({});
  });
});
