import { EditorView } from "@codemirror/view";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { fakeProjects } from "./lib/fakeProjects";
import { fakeClaude } from "./lib/fakeClaude";
import { ipc } from "./lib/ipc";
import { resetSessionStore } from "./workspace/chat/sessionStore";

beforeEach(() => {
  fakeProjects.reset();
  fakeClaude.reset();
  resetSessionStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionStore();
  fakeClaude.reset();
  fakeProjects.reset();
  window.history.replaceState({}, "", "/");
});

describe("App (브라우저 가짜 모드)", () => {
  it("첫 화면은 고양이 집이다 — 에이전트 7마리가 고양이로 있고 사용량이 보인다", async () => {
    render(<App />);

    expect(await screen.findByTestId("home")).toBeInTheDocument();
    const scene = screen.getByRole("region", { name: "고양이들" });
    await screen.findByRole("meter", { name: "5시간 츄르" });
    expect(await within(scene).findAllByRole("button")).toHaveLength(7);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("화면 전환 (주소가 아니라 앱 상태)", () => {
  it("세션 이벤트는 앱이 켜질 때 한 번만 듣는다 — 고양이 집 ↔ 작업 공간을 오가도 다시 듣지 않는다", async () => {
    const listen = vi.spyOn(ipc, "onClaudeEvent");
    render(<App />);
    await screen.findByTestId("home");
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await screen.findByTestId("workspace");
    fireEvent.click(within(screen.getByRole("navigation", { name: "탐색" })).getByRole("button", { name: "집" }));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await screen.findByTestId("workspace");
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it("왼쪽 메뉴로 고양이 집 ↔ 작업 공간 — 메뉴는 두 곳뿐이고 지금 있는 곳이 표시된다", async () => {
    render(<App />);
    await screen.findByTestId("home");
    const nav = screen.getByRole("navigation", { name: "탐색" });
    expect(within(nav).getAllByRole("button")).toHaveLength(2);
    expect(within(nav).getByRole("button", { name: "집" })).toHaveAttribute("aria-current", "page");

    fireEvent.click(within(nav).getByRole("button", { name: "작업 공간" }));
    expect(await screen.findByTestId("workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("home")).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "탐색" })).getByRole("button", { name: "작업 공간" })).toHaveAttribute("aria-current", "page");
    expect(window.location.search).toBe("");

    fireEvent.click(within(screen.getByRole("navigation", { name: "탐색" })).getByRole("button", { name: "집" }));
    expect(await screen.findByTestId("home")).toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  });

  it("작업 공간을 처음 열면 가장 최근 프로젝트가 열려 있다", async () => {
    render(<App />);
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    expect(await screen.findByRole("heading", { level: 2, name: "고양이 앨범" })).toBeInTheDocument();
  });

  it("고양이 집 판에서 프로젝트를 누르면 작업 공간에 그 프로젝트가 열리고 '최근에 연' 때를 적는다", async () => {
    const touch = vi.spyOn(ipc, "projectTouch");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /레시피 상자/ }));

    expect(await screen.findByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
    await waitFor(() => expect(touch).toHaveBeenCalledWith(2));
    // 집으로 돌아갔다 와도 고른 프로젝트가 그대로
    fireEvent.click(screen.getByRole("button", { name: "집" }));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    expect(await screen.findByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
  });

  it("집의 새 프로젝트 → 폴더 고르기 → 추가하면 작업 공간에 그 프로젝트가 열리고, requirements.md 를 쓰면 자동 저장된다", async () => {
    fakeProjects.reset({ pick: "fresh", requirements: "absent" });
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "새 프로젝트 시작" }));

    // 작업 공간으로 가서 새 프로젝트 창이 바로 열린다
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    await within(dialog).findByText("C:\\dev\\cat-diary");
    fireEvent.click(within(dialog).getByRole("button", { name: "추가" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { level: 2, name: "cat-diary" })).toBeInTheDocument();
    await screen.findByText("requirements.md 가 아직 없어요 — 쓰면 만들어져요");

    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) as EditorView;
    view.dispatch({ changes: { from: 0, insert: "# 고양이 일기" }, userEvent: "input.type" });
    await waitFor(() => expect(write).toHaveBeenCalledWith(5, "# 고양이 일기", null), { timeout: 3000 });
    expect(await screen.findByText(/저장됨 \d\d:\d\d/)).toBeInTheDocument();
  });

  it("작업 공간을 떠나면(집으로) 저장하지 않은 글을 저장한다", async () => {
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    render(<App />);
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("우리 집"));

    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) as EditorView;
    view.dispatch({ changes: { from: 0, insert: "떠나기 전에 " }, userEvent: "input.type" });
    fireEvent.click(screen.getByRole("button", { name: "집" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0][1]).toMatch(/^떠나기 전에 # 고양이 앨범/);
    expect(write.mock.calls[0][0]).toBe(1);
  });

  it("시안(?variant=)은 그대로 동작한다 — 실제 화면의 메뉴 대신 시안 틀이 뜬다", async () => {
    window.history.replaceState({}, "", "/?variant=a&screen=cats");
    render(<App />);
    expect(await screen.findByTestId("variant-frame")).toBeInTheDocument();
    expect(screen.queryByTestId("home")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  });

  it("시험 화면(?lab=)은 그대로 동작한다", async () => {
    window.history.replaceState({}, "", "/?lab=harness");
    render(<App />);
    await waitFor(() => expect(screen.queryByTestId("home")).not.toBeInTheDocument());
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
  });
});
