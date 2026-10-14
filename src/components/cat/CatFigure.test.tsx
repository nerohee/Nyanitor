import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CatFigure, CatSprite, catSeed, motionForPose } from "./CatFigure";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const layers = (container: HTMLElement) => container.querySelectorAll<HTMLElement>(".cat-layer");

describe("고양이 그림", () => {
  it("프레임이 둘인 자세(걷기)는 그림 둘을 쌓고, 하나인 자세는 하나", () => {
    const { container, rerender } = render(<CatSprite cat="nabi" pose="walk" />);
    expect(container.querySelectorAll(".cat-frame")).toHaveLength(2);
    expect(layers(container)[0]).toHaveAttribute("data-motion", "walk");

    rerender(<CatSprite cat="nabi" pose="loaf" />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(container.querySelectorAll(".cat-frame")).toHaveLength(1);
  });

  it("앉은 자세는 깜빡임 그림을 하나 더 가진다 — 다른 자세는 없다", () => {
    const { container, rerender } = render(<CatSprite cat="mulgam" pose="sit" />);
    expect(container.querySelectorAll(".cat-blink")).toHaveLength(1);
    rerender(<CatSprite cat="mulgam" pose="loaf" />);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(container.querySelectorAll(".cat-blink")).toHaveLength(0);
  });

  it("자세가 바뀌면 이전 그림이 0.2초 남아 겹쳐 흐리고, 그 뒤에 사라진다. 처음 나타날 때는 겹치지 않는다", () => {
    const { container, rerender } = render(<CatSprite cat="kkaebi" pose="sit" />);
    expect(layers(container)).toHaveLength(1);
    expect(container.querySelector(".cat-layer--entering")).toBeNull();

    rerender(<CatSprite cat="kkaebi" pose="sleep" />);
    expect(layers(container)).toHaveLength(2);
    expect(container.querySelector(".cat-layer--leaving")).toHaveAttribute("data-pose", "sit");
    expect(container.querySelector(".cat-layer--entering")).toHaveAttribute("data-pose", "sleep");

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(layers(container)).toHaveLength(1);
    expect(layers(container)[0]).toHaveAttribute("data-pose", "sleep");
  });

  it("왼쪽을 보게 하면 방향만 표시하고(뒤집기는 CSS), 움직임 없이(still) 쓸 수 있다", () => {
    const { container } = render(<CatSprite cat="dubu" pose="walk" facing="left" still />);
    expect(layers(container)[0]).toHaveAttribute("data-facing", "left");
    expect(layers(container)[0]).toHaveAttribute("data-motion", "still");
  });

  it("목록에 없는 고양이는 먹물 그림으로", () => {
    const { container } = render(<CatSprite cat="ghost" pose="sit" />);
    expect(container.querySelector(".cat-sprite")).toHaveAttribute("data-cat", "mukmul");
    expect(container.querySelector<HTMLImageElement>(".cat-frame")?.getAttribute("src")).toContain("/mukmul/sit");
  });

  it("그림에는 대체 글이 없고(장식), 이름을 주면 이미지로 읽힌다", () => {
    const { container, rerender } = render(<CatFigure cat="gureum" pose="sit" />);
    expect(container.querySelector(".cat-figure")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("img")).toHaveAttribute("alt", "");

    rerender(<CatFigure cat="gureum" pose="sit" label="구름" />);
    expect(container.querySelector(".cat-figure")).toHaveAttribute("role", "img");
    expect(container.querySelector(".cat-figure")).toHaveAttribute("aria-label", "구름");
  });

  it("얼굴 아바타는 앉은 그림의 머리 부분을 잘라 쓴다", () => {
    const { container } = render(<CatFigure cat="nabi" crop="face" />);
    expect(container.querySelector(".cat-face img")?.getAttribute("src")).toContain("/nabi/sit");
    expect(container.querySelector(".cat-sprite")).toBeNull();
  });

  it("자세마다 정해진 기본 움직임이 있고, 박자 씨앗은 마리마다 달라 한꺼번에 숨쉬지 않는다", () => {
    expect(motionForPose("sit")).toBe("breathe");
    expect(motionForPose("sleep")).toBe("sleep");
    expect(motionForPose("walk")).toBe("walk");
    expect(catSeed("nabi")).not.toBe(catSeed("mukmul"));
    expect(catSeed("nabi")).toBe(catSeed("nabi"));
  });
});
