import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { homeScale, useHomeScale } from "./useHomeScale";

describe("homeScale", () => {
  it("is 1 at the base window and never grows past 1 in bigger windows", () => {
    expect(homeScale(1280, 800)).toBe(1);
    expect(homeScale(1470, 900)).toBe(1);
    expect(homeScale(2560, 1600)).toBe(1);
  });

  it("follows whichever side shrank more", () => {
    expect(homeScale(640, 800)).toBe(0.5);
    expect(homeScale(1280, 400)).toBe(0.5);
    expect(homeScale(1018, 510)).toBe(0.6375);
  });

  it("stays positive for the window sizes that went negative on macOS", () => {
    // P11-08 — WebKit 의 tan(atan2()) 가 음수를 낸 크기들 (고객 캡처)
    for (const [w, h] of [[1213, 697], [1470, 920], [1440, 870]]) {
      const s = homeScale(w, h);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("does not shrink when the size is unknown", () => {
    expect(homeScale(0, 800)).toBe(1);
    expect(homeScale(1280, -1)).toBe(1);
    expect(homeScale(Number.NaN, 800)).toBe(1);
  });
});

describe("useHomeScale", () => {
  const original = { w: window.innerWidth, h: window.innerHeight };
  const resize = (w: number, h: number) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: h });
    window.dispatchEvent(new Event("resize"));
  };
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: original.w });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: original.h });
  });

  it("updates when the window is resized", () => {
    resize(1280, 800);
    const { result } = renderHook(() => useHomeScale());
    expect(result.current).toBe(1);
    act(() => resize(960, 800));
    expect(result.current).toBe(0.75);
    act(() => resize(1920, 1200));
    expect(result.current).toBe(1);
  });
});
