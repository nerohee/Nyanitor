import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import VariantFrame from "./VariantFrame";

// 2026-10-13 09:30 — PC 시각만 보면 "아침"
const morningClock = () => new Date(2026, 9, 13, 9, 30);

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe("시안 틀", () => {
  it("쿼리로 고른 시안 · 화면 · 시간대 · 테마를 PC 시각과 상관없이 그대로 고정한다", () => {
    render(<VariantFrame search="?variant=a&screen=cats&time=night&theme=dark" clock={morningClock} />);

    const frame = screen.getByTestId("variant-frame");
    expect(frame).toHaveAttribute("data-variant", "a");
    expect(frame).toHaveAttribute("data-screen", "cats");
    expect(frame).toHaveAttribute("data-time", "night");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("heading", { level: 1, name: "고양이 목록 확인" })).toBeInTheDocument();
    // 시안 막대에서 지금 고른 것이 표시된다 (시안은 a 하나라 시안 고르기는 없다)
    expect(screen.queryByRole("link", { name: "a" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "밤" })).toHaveAttribute("aria-current", "true");
  });

  it("테마 시안(skin)은 1 · 2 · 3 만 받고, 없거나 모르는 값이면 1판 테마(data-skin 없음)", () => {
    const { unmount } = render(<VariantFrame search="?variant=a&skin=2" clock={morningClock} />);
    expect(screen.getByTestId("variant-frame")).toHaveAttribute("data-skin", "2");
    expect(screen.getByRole("link", { name: "② 찹쌀떡" })).toHaveAttribute("aria-current", "true");
    unmount();

    render(<VariantFrame search="?variant=a&skin=9" clock={morningClock} />);
    expect(screen.getByTestId("variant-frame")).not.toHaveAttribute("data-skin");
    expect(screen.getByRole("link", { name: "1판" })).toHaveAttribute("aria-current", "true");
  });

  it("시간대 쿼리가 없으면 PC 시각을 따르고, 모르는 시안(지운 b · c 포함) · 화면은 기본값(a · 집)으로", () => {
    render(<VariantFrame search="?variant=b&screen=nope" clock={() => new Date(2026, 9, 13, 18, 30)} />);

    const frame = screen.getByTestId("variant-frame");
    expect(frame).toHaveAttribute("data-variant", "a");
    expect(frame).toHaveAttribute("data-screen", "house");
    expect(frame).toHaveAttribute("data-time", "evening");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    // 시안 a 의 집 화면 (P2-02)
    expect(screen.getByRole("region", { name: "고양이들" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /새 프로젝트 시작/ })).toBeInTheDocument();
  });
});
