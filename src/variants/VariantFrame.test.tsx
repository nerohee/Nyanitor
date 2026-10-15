import { render, screen, within } from "@testing-library/react";
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

  it("UI 판(skin)은 없거나 모르는 값이면 ① 나무 쟁반(D-40), 0 은 보관한 1판(data-skin 없음), 2 · 3 은 보관한 시안", () => {
    const { unmount } = render(<VariantFrame search="?variant=a" clock={morningClock} />);
    expect(screen.getByTestId("variant-frame")).toHaveAttribute("data-skin", "1");
    expect(screen.getByRole("link", { name: "① 나무 쟁반" })).toHaveAttribute("aria-current", "true");
    // ① 은 기본이라 주소에 skin 을 붙이지 않는다
    expect(screen.getByRole("link", { name: "① 나무 쟁반" }).getAttribute("href")).not.toContain("skin=");
    unmount();

    const old = render(<VariantFrame search="?variant=a&skin=0" clock={morningClock} />);
    expect(screen.getByTestId("variant-frame")).not.toHaveAttribute("data-skin");
    expect(screen.getByRole("link", { name: "1판" })).toHaveAttribute("aria-current", "true");
    old.unmount();

    const kept = render(<VariantFrame search="?variant=a&skin=2" clock={morningClock} />);
    expect(screen.getByTestId("variant-frame")).toHaveAttribute("data-skin", "2");
    kept.unmount();

    render(<VariantFrame search="?variant=a&skin=9" clock={morningClock} />);
    expect(screen.getByTestId("variant-frame")).toHaveAttribute("data-skin", "1");
  });

  it("새 화면(첫 실행 · 설정 · 하네스 · 고양이 고르기)이 주소로 열리고, 시안 막대에 그 화면의 상태 줄이 나온다", () => {
    const { unmount } = render(<VariantFrame search="?screen=setup&state=failed" clock={morningClock} />);
    expect(screen.getByRole("heading", { level: 1, name: "집 문을 열기 전에" })).toBeInTheDocument();
    const states = screen.getByRole("group", { name: "상태" });
    expect(within(states).getByRole("link", { name: "확인 실패" })).toHaveAttribute("aria-current", "true");
    // 화면을 바꾸는 링크는 그 화면의 상태를 떼고 간다
    const toSettings = within(screen.getByRole("group", { name: "화면" })).getByRole("link", { name: "설정" });
    expect(toSettings.getAttribute("href")).toContain("screen=settings");
    expect(toSettings.getAttribute("href")).not.toContain("state=");
    unmount();

    for (const [search, title] of [
      ["?screen=settings", "설정"],
      ["?screen=harness&state=update", "하네스"],
      ["?screen=pick", "에이전트 고양이 고르기"],
    ] as const) {
      const view = render(<VariantFrame search={search} clock={morningClock} />);
      expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
      view.unmount();
    }

    // 상태가 없는 화면(집)에는 상태 줄이 없다
    render(<VariantFrame search="?screen=house" clock={morningClock} />);
    expect(screen.queryByRole("group", { name: "상태" })).not.toBeInTheDocument();
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
