// 고양이 고르기 키보드 시험 (P10-04, D-55) — 화살표는 칸 사이를 옮겨 다니기만, 고르기(저장)는 Space · Enter · 클릭.
// jsdom 은 Space · Enter 가 단추를 누르는 것(click)으로 바뀌는 것을 흉내 내지 않아서 그 둘은 `click` 으로 시험한다 (실제 키는 P10 E2E).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCustom } from "../lib/fakeCustom";
import { fakeHouse } from "../lib/fakeHouse";
import { ipc } from "../lib/ipc";
import EditScreen from "./EditScreen";

const NOW = new Date("2026-11-12T12:00:00+09:00");
const WAIT = { timeout: 4000 };

beforeEach(() => {
  fakeHouse.reset();
  fakeCustom.reset();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 40));
  vi.restoreAllMocks();
  fakeHouse.reset();
  fakeCustom.reset();
});

const card = (cat: string) => screen.getByRole("radio", { name: new RegExp(`^${cat}`) });

async function openPick(agent = "translator") {
  fakeCustom.reset("full");
  render(<EditScreen onGo={vi.fn()} clock={() => NOW} startPick={agent} />);
  await screen.findByRole("heading", { level: 1, name: "에이전트 고양이 고르기" });
  await screen.findByRole("radiogroup", { name: /고양이 7마리/ });
}

describe("고양이 고르기 — 키보드", () => {
  it("라디오 그룹은 Tab 한 번에 들어오고 — 고른 칸만 탭 순서에 있다", async () => {
    await openPick();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(7);
    const stops = radios.filter((r) => r.tabIndex === 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(card("두부"));
    expect(card("두부")).toHaveAttribute("aria-checked", "true");
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("화살표 · Home · End 는 포커스만 옮기고 저장하지 않는다 — 고른 칸은 그대로", async () => {
    await openPick();
    const saves = vi.spyOn(ipc, "customCatsSave");
    card("두부").focus();
    fireEvent.keyDown(card("두부"), { key: "ArrowRight" });
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(card("두부"));
    expect(second).toHaveAttribute("role", "radio");
    expect(second.tabIndex).toBe(0);
    expect(card("두부").tabIndex).toBe(-1);
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card("두부"));
    fireEvent.keyDown(card("두부"), { key: "End" });
    const all = screen.getAllByRole("radio");
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(all[0]);
    expect(saves).not.toHaveBeenCalled();
    expect(card("두부")).toHaveAttribute("aria-checked", "true");
    expect((await ipc.customCatsRead()).agents.translator).toBe("dubu");
  });

  it("Space · Enter · 클릭(단추 누름)으로 고르면 저장하고, 저장 뒤에도 포커스가 그 칸에 남는다", async () => {
    await openPick();
    const saves = vi.spyOn(ipc, "customCatsSave");
    const target = card("구름");
    target.focus();
    expect(document.activeElement).toBe(target);
    fireEvent.click(target);
    expect(saves).toHaveBeenCalledTimes(1);
    // 저장 중에도 꺼지지 않는다 (aria-disabled 만) — 포커스가 BODY 로 빠지지 않는다
    expect(target).not.toBeDisabled();
    expect(target).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(target);
    await waitFor(() => expect(card("구름")).toHaveAttribute("aria-checked", "true"), WAIT);
    await waitFor(() => expect(card("구름")).not.toHaveAttribute("aria-disabled"), WAIT);
    expect(document.activeElement).toBe(card("구름"));
    expect(card("구름").tabIndex).toBe(0);
    expect((await ipc.customCatsRead()).agents.translator).toBe("gureum");
  });

  it("저장 중에 화살표로 옮겨도 되고, 저장 중 다시 눌러도 한 번만 저장한다", async () => {
    await openPick();
    const saves = vi.spyOn(ipc, "customCatsSave");
    card("구름").focus();
    fireEvent.click(card("구름"));
    fireEvent.click(card("나비"));
    fireEvent.keyDown(card("구름"), { key: "ArrowRight" });
    expect(document.activeElement).not.toBe(document.body);
    await waitFor(() => expect(card("구름")).not.toHaveAttribute("aria-disabled"), WAIT);
    expect(saves).toHaveBeenCalledTimes(1);
  });
});

describe("고양이 고르기 — 새로 만들기 초안", () => {
  it("초안에서도 화살표는 옮기기만, 고르면 저장 대신 초안에 적는다", async () => {
    fakeCustom.reset("full");
    render(<EditScreen onGo={vi.fn()} clock={() => NOW} />);
    await screen.findByText("화면 구현");
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
    fireEvent.change(screen.getByLabelText("에이전트 이름 (영문)"), { target: { value: "scout" } });
    fireEvent.change(screen.getByLabelText("언제 쓰나"), { target: { value: "정찰해요" } });
    fireEvent.click(screen.getByRole("button", { name: /다음: 고양이 고르기/ }));
    await screen.findByRole("heading", { level: 1, name: "에이전트 고양이 고르기" });
    const saves = vi.spyOn(ipc, "customCatsSave");
    const first = screen.getAllByRole("radio")[0]!;
    expect(first.tabIndex).toBe(0);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const next = document.activeElement as HTMLElement;
    expect(next).not.toBe(first);
    expect(screen.getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "완료" })).toBeDisabled();
    act(() => fireEvent.click(next));
    expect(next).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(next);
    expect(screen.getByRole("button", { name: "완료" })).toBeEnabled();
    expect(saves).not.toHaveBeenCalled();
  });
});
