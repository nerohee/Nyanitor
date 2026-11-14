// 창이 보이는가 (D-55) — 두 신호(앱 이벤트 · 웹뷰 `visibilitychange`) 중 하나라도 숨김이면 멈추고, 둘 다 보여야 다시 돈다.
// 이것을 쓰는 곳: 고양이 움직임(`data-hidden`) · 1분 시계 · 사용량 · 문서 · 진행 · 요구사항 주기 읽기.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useSceneMotion } from "./house/useHouse";
import { fakeClaude } from "../lib/fakeClaude";
import { ipc } from "../lib/ipc";
import { useClock } from "../home/useClock";
import { isWindowShown, subscribeWindowShown, useWindowShown } from "./useWindowShown";

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const webview = (state: "visible" | "hidden") => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
};

// 가짜 모듈을 미리 불러 둔다 (듣기가 늦게 붙지 않게)
beforeAll(async () => {
  (await ipc.onWindowVisibility(() => undefined))();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.hidden;
});

describe("창이 보이는가", () => {
  it("앱 신호가 숨김이면 숨은 것, 보임이면 다시 보인다", async () => {
    const { result, unmount } = renderHook(() => useWindowShown());
    await settle();
    expect(result.current).toBe(true);
    act(() => fakeClaude.simulateWindowVisibility(false));
    expect(result.current).toBe(false);
    expect(isWindowShown()).toBe(false);
    act(() => fakeClaude.simulateWindowVisibility(true));
    expect(result.current).toBe(true);
    unmount();
  });

  it("웹뷰 신호만 숨김이어도 숨은 것 — 앱 신호가 보임이라도 둘 다 보여야 보인다", async () => {
    const { result, unmount } = renderHook(() => useWindowShown());
    await settle();
    act(() => webview("hidden"));
    expect(result.current).toBe(false);
    act(() => fakeClaude.simulateWindowVisibility(false));
    act(() => webview("visible"));
    expect(result.current).toBe(false); // 앱 신호는 아직 숨김
    act(() => fakeClaude.simulateWindowVisibility(true));
    expect(result.current).toBe(true);
    unmount();
  });

  it("듣는 곳이 모두 떠나면 그만 듣고 보임으로 되돌린다", async () => {
    const seen: boolean[] = [];
    const stop = subscribeWindowShown((shown) => seen.push(shown));
    await settle();
    act(() => fakeClaude.simulateWindowVisibility(false));
    expect(seen).toEqual([false]);
    stop();
    act(() => fakeClaude.simulateWindowVisibility(true));
    expect(seen).toEqual([false]);
    expect(isWindowShown()).toBe(true);
  });
});

describe("창이 숨으면 멈추는 것", () => {
  it("고양이 움직임 — 앱 신호로 :root 에 data-hidden, 보이면 뗀다", async () => {
    const { result, unmount } = renderHook(() => useSceneMotion());
    await settle();
    act(() => fakeClaude.simulateWindowVisibility(false));
    expect(result.current.hidden).toBe(true);
    expect(document.documentElement.dataset.hidden).toBe("true");
    act(() => fakeClaude.simulateWindowVisibility(true));
    expect(result.current.hidden).toBe(false);
    expect(document.documentElement.dataset.hidden).toBeUndefined();
    unmount();
  });

  it("1분 시계 — 숨은 동안은 갱신하지 않고, 다시 보이면 바로 한 번 보고 1분마다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let reads = 0;
    const clock = () => {
      reads += 1;
      return new Date(2026, 10, 12, 9, reads);
    };
    const { unmount } = renderHook(() => useClock(clock));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    reads = 0;
    act(() => fakeClaude.simulateWindowVisibility(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000); });
    expect(reads).toBe(0);
    act(() => fakeClaude.simulateWindowVisibility(true));
    expect(reads).toBe(1); // 보이면 바로
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads).toBe(2); // 다시 1분마다
    unmount();
  });
});
