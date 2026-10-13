import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { USAGE_OK } from "../fixtures";
import { House } from "./House";

describe("시안 a 고양이 집 — 키보드", () => {
  it("Tab 으로 고양이를 왼쪽부터 차례로 고르고, Enter 로 정보 패널을 열고, Esc 로 닫으면 그 고양이로 포커스가 돌아온다", () => {
    render(<House time="day" usage={USAGE_OK} work="running" />);

    // 고양이 7마리가 모두 Tab 으로 닿는 단추이고, 순서는 화면 왼쪽 → 오른쪽
    const scene = screen.getByRole("region", { name: "고양이들" });
    const cats = within(scene).getAllByRole("button");
    expect(cats.map((button) => button.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "먹물",
      "깨비",
      "나비",
      "두부",
      "물감",
      "단추",
      "구름",
    ]);
    cats.forEach((button) => expect(button).not.toHaveAttribute("tabindex", "-1"));

    // Tab 으로 나비에 도착 → Enter. jsdom 은 키를 눌러도 단추를 누르지 않으므로,
    // 브라우저가 Enter 에 하는 일(네이티브 <button> 의 click)을 그대로 보낸다.
    const nabi = screen.getByRole("button", { name: /^나비,/ });
    nabi.focus();
    expect(nabi).toHaveFocus();
    fireEvent.click(nabi);

    const panel = screen.getByRole("region", { name: "나비" });
    expect(nabi).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText("Opus")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /고치기/ })).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "나비" })).toHaveFocus();

    // Esc → 닫히고 나비 단추로 돌아감
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "나비" })).not.toBeInTheDocument();
    expect(nabi).toHaveAttribute("aria-expanded", "false");
    expect(nabi).toHaveFocus();
  });
});
