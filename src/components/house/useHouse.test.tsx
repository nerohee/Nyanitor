import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_PLANS } from "./schedule";
import { useFakeIntents, useHouseSchedule, useSceneMotion, type SceneMotion } from "./useHouse";

const CALM: SceneMotion = { reduced: false, hidden: false };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.hidden;
  delete document.documentElement.dataset.motion;
});

describe("고양이 집 일정 훅", () => {
  it("처음에는 의도대로 자리에 서 있다", () => {
    const { result } = renderHook(() => useHouseSchedule(FAKE_PLANS[0], CALM));
    const byCat = Object.fromEntries(result.current.map((p) => [p.cat, p]));
    expect(byCat.danchu).toMatchObject({ spot: "wheel", pose: "with", walking: false });
    expect(byCat.mukmul).toMatchObject({ spot: "stone", pose: "sit" });
  });

  it("의도가 바뀌면 — 캣휠 · 캣타워에서는 사라졌다가 다른 자리에 나타나 내려온다", () => {
    const { result, rerender } = renderHook(({ intents }) => useHouseSchedule(intents, CALM), {
      initialProps: { intents: FAKE_PLANS[0] },
    });
    // 계획 3: 모두 쉼 + 먹물 기다림 → 단추(캣휠)는 쉬러 내려온다
    vi.spyOn(Math, "random").mockReturnValue(0);
    rerender({ intents: FAKE_PLANS[3] });
    // 한꺼번에 옮기지 않는다 — 고양이마다 0.5~4초 뒤에 시작
    expect(result.current.find((p) => p.cat === "danchu")).toMatchObject({ fade: null, spot: "wheel" });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.find((p) => p.cat === "danchu")).toMatchObject({ fade: "out", spot: "wheel" });

    act(() => {
      vi.advanceTimersByTime(225);
    });
    const arrived = result.current.find((p) => p.cat === "danchu");
    expect(arrived?.spot).toBe("sun");
    expect(arrived?.fade).toBe("in");
    expect(arrived?.instant).toBe(true);

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current.find((p) => p.cat === "danchu")).toMatchObject({
      fade: null,
      instant: false,
      walking: false,
    });
  });

  it("움직임 줄이기: 자리를 바로 바꾸고 걷지도 사라지지도 않는다", () => {
    const reduced: SceneMotion = { reduced: true, hidden: false };
    const { result, rerender } = renderHook(({ intents }) => useHouseSchedule(intents, reduced), {
      initialProps: { intents: FAKE_PLANS[0] },
    });
    rerender({ intents: FAKE_PLANS[3] });
    expect(result.current.find((p) => p.cat === "danchu")).toMatchObject({
      spot: "sun",
      walking: false,
      fade: null,
      instant: true,
    });
  });

  it("가끔 자리나 동작을 바꾼다 — 창이 숨으면 멈춘다", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const snapshot = (placements: ReturnType<typeof useHouseSchedule>) =>
      placements.map((p) => `${p.cat}:${p.spot}:${p.pose}`).join("|");

    const hidden = renderHook(() => useHouseSchedule(FAKE_PLANS[0], { reduced: false, hidden: true }));
    const before = snapshot(hidden.result.current);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(snapshot(hidden.result.current)).toBe(before);

    const awake = renderHook(() => useHouseSchedule(FAKE_PLANS[0], CALM));
    const start = snapshot(awake.result.current);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(snapshot(awake.result.current)).not.toBe(start);
  });

  it("정보 패널이 열린 고양이는 가만히 있는다", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const { result } = renderHook(() => useHouseSchedule(FAKE_PLANS[0], CALM, "nabi"));
    const before = result.current.find((p) => p.cat === "nabi");
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(result.current.find((p) => p.cat === "nabi")).toMatchObject({ spot: before?.spot, pose: before?.pose });
  });
});

describe("가짜 일정", () => {
  it("40초마다 다음 일정으로 돌고, 움직임 줄이기에서는 그대로", () => {
    const { result } = renderHook(() => useFakeIntents(CALM));
    expect(result.current).toBe(FAKE_PLANS[0]);
    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(result.current).toBe(FAKE_PLANS[1]);

    const still = renderHook(() => useFakeIntents({ reduced: true, hidden: false }));
    act(() => {
      vi.advanceTimersByTime(200_000);
    });
    expect(still.result.current).toBe(FAKE_PLANS[0]);
  });

  it("시작 일정을 고를 수 있고, 범위 밖이면 처음 것", () => {
    expect(renderHook(() => useFakeIntents(CALM, 2)).result.current).toBe(FAKE_PLANS[2]);
    expect(renderHook(() => useFakeIntents(CALM, 99)).result.current).toBe(FAKE_PLANS[0]);
  });
});

describe("움직임 끔 · 창 숨김 감시", () => {
  it("앱 설정의 움직임 줄이기(data-motion)를 따른다", () => {
    document.documentElement.dataset.motion = "reduced";
    const { result } = renderHook(() => useSceneMotion());
    expect(result.current.reduced).toBe(true);
  });

  it("창이 숨으면 :root 에 data-hidden 을 달아 CSS 도 멈추고, 다시 보이면 뗀다", () => {
    const { result } = renderHook(() => useSceneMotion());
    expect(result.current.hidden).toBe(false);

    const state = vi.spyOn(document, "visibilityState", "get");
    state.mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.hidden).toBe(true);
    expect(document.documentElement.dataset.hidden).toBe("true");

    state.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.hidden).toBe(false);
    expect(document.documentElement.dataset.hidden).toBeUndefined();
  });
});
