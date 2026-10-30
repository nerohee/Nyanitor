// 입력줄 — Enter 보내기 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter 는 보내지 않는다 · 빈 칸에서 `/` 스킬 고르기(화살표 · Enter · Esc) ·
// 중단 확인 · 일하는 중에 보낸 말("다음 차례에 전해져요") · 보내기 실패.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillInfo } from "../../lib/ipc-types";
import { AppError } from "../../lib/ipc-types";
import { Composer } from "./Composer";
import { resetSessionStore, useSessionStore } from "./sessionStore";
import type { SkillChoicesState } from "./useChatEnv";

const skill = (name: string, description: string, origin: SkillInfo["origin"] = "harness"): SkillInfo => ({ name, command: `/${name}`, description, argumentHint: null, origin, userInvocable: true });
const READY: SkillChoicesState = {
  state: "ready",
  list: "ok",
  skills: [skill("desktop-app", "데스크톱 앱 만들기"), skill("web-lite", "작은 웹 페이지"), skill("translate-docs", "문서 옮기기", "mine")],
};

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSend = vi.fn<(text: string) => Promise<"sent" | "queued">>().mockResolvedValue("sent");
  const onInterrupt = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const view = render(<Composer projectId={1} skills={READY} busy={false} waiting={false} onSend={onSend} onInterrupt={onInterrupt} {...props} />);
  const input = screen.getByRole("textbox", { name: "보낼 말" });
  return { ...view, onSend, onInterrupt, input };
}

beforeEach(() => resetSessionStore());
afterEach(() => resetSessionStore());

describe("보내기", () => {
  it("Enter 로 보낸다 — 앞뒤 공백은 뗀 글, 보낸 뒤 칸이 비고 보내기 단추는 빈 글이면 꺼져 있다", async () => {
    const { input, onSend } = setup();
    const send = screen.getByRole("button", { name: "보내기" });
    expect(send).toBeDisabled();
    fireEvent.change(input, { target: { value: "  안녕하세요  " } });
    expect(send).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("안녕하세요"));
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("Shift+Enter 는 보내지 않고 줄을 바꾼다 (기본 동작을 막지 않는다)", () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "첫 줄" } });
    const notPrevented = fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("첫 줄");
  });

  it("한글 조합 중 Enter 는 보내지 않는다 — isComposing · keyCode 229 · 조합 이벤트 어느 쪽이든", () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "안녕하세" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("안녕하세");
  });

  it("조합 중에 / 를 쳐도 스킬 고르기가 열리지 않는다", () => {
    const { input } = setup();
    fireEvent.keyDown(input, { key: "/", isComposing: true });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("보내기 단추(제출)로도 보낸다", async () => {
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "단추로" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("단추로"));
  });

  it("보내기가 실패하면 한 줄 + 쓴 글은 그대로 남는다", async () => {
    const { input, onSend } = setup();
    onSend.mockRejectedValue(new AppError("project_folder_missing", "x"));
    fireEvent.change(input, { target: { value: "보낼 말" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("보내지 못했어요 — 프로젝트 폴더를 찾을 수 없어요.");
    expect(input).toHaveValue("보낼 말");
  });

  it("보내는 중에는 또 보내지 않는다", async () => {
    const { input, onSend } = setup();
    let finish: (value: "sent") => void = () => undefined;
    onSend.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    fireEvent.change(input, { target: { value: "한 번만" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => finish("sent"));
  });
});

describe("스킬 고르기", () => {
  it("빈 칸에서 / 를 치면 고르기가 열리고, 화살표 + Enter 로 고르면 글 앞에 `/<스킬> ` 이 들어간다", async () => {
    const { input } = setup();
    const notPrevented = fireEvent.keyDown(input, { key: "/" });
    expect(notPrevented).toBe(false); // 글 칸에 / 가 들어가지 않는다
    const list = await screen.findByRole("listbox");
    await waitFor(() => expect(list).toHaveFocus());
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByText("내가 만든 것")).toBeInTheDocument();
    expect(list).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-0$/));
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(input).toHaveValue("/web-lite ");
    await waitFor(() => expect(input).toHaveFocus());
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("글이 있을 때 / 는 그냥 글자다 · 이미 앞에 스킬이 있으면 바꾼다", async () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "경로는 a/b" } });
    expect(fireEvent.keyDown(input, { key: "/" })).toBe(true);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "/web-lite 요구사항.md" } });
    fireEvent.click(screen.getByRole("button", { name: /스킬/ }));
    fireEvent.click(screen.getAllByRole("option")[0]!);
    expect(input).toHaveValue("/desktop-app 요구사항.md");
  });

  it("Esc 로 닫으면 / 로 열었을 때는 글 칸으로, Home · End 로 처음 · 끝으로", async () => {
    const { input } = setup();
    fireEvent.keyDown(input, { key: "/" });
    const list = await screen.findByRole("listbox");
    fireEvent.keyDown(list, { key: "End" });
    expect(list).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-2$/));
    fireEvent.keyDown(list, { key: "Home" });
    expect(list).toHaveAttribute("aria-activedescendant", expect.stringMatching(/-0$/));
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveValue("");
  });

  it("단추로 열고 Esc 로 닫으면 초점이 그 단추로 돌아온다", async () => {
    setup();
    const button = screen.getByRole("button", { name: /스킬/ });
    fireEvent.click(button);
    const list = await screen.findByRole("listbox");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(button).toHaveFocus();
  });

  it("스킬이 없거나 못 읽으면 이유 한 줄", async () => {
    const { rerender, onSend, onInterrupt } = setup({ skills: { state: "ready", list: "no_harness", skills: [] } });
    fireEvent.click(screen.getByRole("button", { name: /스킬/ }));
    expect(await screen.findByText("하네스가 설치되어 있지 않아서 고를 스킬이 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    rerender(<Composer projectId={1} skills={{ state: "failed" }} busy={false} waiting={false} onSend={onSend} onInterrupt={onInterrupt} />);
    expect(screen.getByText("스킬 목록을 읽지 못했어요.")).toBeInTheDocument();
  });
});

describe("중단", () => {
  it("일하는 중이 아니면 중단 단추가 없다", () => {
    setup();
    expect(screen.queryByRole("button", { name: "중단" })).not.toBeInTheDocument();
  });

  it("일하는 중 — 중단 → 확인 한 번 → 중단한다 (확인에 초점)", async () => {
    const { onInterrupt } = setup({ busy: true });
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    const dialog = screen.getByRole("alertdialog", { name: "지금 하던 일을 멈출까요?" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "멈추기" })).toHaveFocus();
    expect(onInterrupt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    await waitFor(() => expect(onInterrupt).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("계속 두기 · Esc 는 아무것도 하지 않고 닫는다 — 초점은 중단 단추로", () => {
    const { onInterrupt } = setup({ busy: true });
    const stop = screen.getByRole("button", { name: "중단" });
    fireEvent.click(stop);
    fireEvent.click(screen.getByRole("button", { name: "계속 두기" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(stop).toHaveFocus();
    fireEvent.click(stop);
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it("중단이 실패하면 한 줄", async () => {
    const { onInterrupt } = setup({ busy: true });
    onInterrupt.mockRejectedValue(new AppError("no_session", "x"));
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("돌고 있는 세션이 없어요.");
  });
});

describe("일하는 중에 보낸 말", () => {
  it("보낸 말이 기다리는 중이면 '다음 차례에 전해져요' 가 보이고, 취소하면 글 칸으로 돌아온다", async () => {
    const { input } = setup({ busy: true });
    act(() => useSessionStore.setState({ queued: { projectId: 1, text: "기다리는 말" } }));
    const status = screen.getByText(/다음 차례에 전해져요/);
    expect(status.closest("[role='status']")).toHaveTextContent("기다리는 말");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(useSessionStore.getState().queued).toBeNull();
    expect(input).toHaveValue("기다리는 말");
    expect(screen.queryByText(/다음 차례에 전해져요/)).not.toBeInTheDocument();
  });

  it("다른 프로젝트의 기다리는 말은 보이지 않는다", () => {
    setup({ busy: true });
    act(() => useSessionStore.setState({ queued: { projectId: 2, text: "남의 말" } }));
    expect(screen.queryByText(/다음 차례에 전해져요/)).not.toBeInTheDocument();
  });

  it("세션이 끝나 돌려받은 말은 빈 글 칸에 들어간다", async () => {
    const { input } = setup();
    act(() => useSessionStore.setState({ draftBack: { projectId: 1, text: "못 보낸 말" } }));
    await waitFor(() => expect(input).toHaveValue("못 보낸 말"));
    expect(useSessionStore.getState().draftBack).toBeNull();
  });

  it("안내 글이 상태를 따른다 — 일하는 중 · 답을 기다리는 중", () => {
    const { rerender, onSend, onInterrupt } = setup({ busy: true });
    expect(screen.getByRole("textbox", { name: "보낼 말" })).toHaveAttribute("placeholder", expect.stringContaining("일하는 동안에도"));
    rerender(<Composer projectId={1} skills={READY} busy waiting onSend={onSend} onInterrupt={onInterrupt} />);
    expect(screen.getByRole("textbox", { name: "보낼 말" })).toHaveAttribute("placeholder", expect.stringContaining("카드에 답해 주세요"));
  });
});
