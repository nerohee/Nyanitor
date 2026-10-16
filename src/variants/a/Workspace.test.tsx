import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE_OK } from "../fixtures";
import type { WorkState } from "../fixtures-workspace";
import { Workspace } from "./Workspace";

// jsdom 에는 matchMedia 가 없다 → useWide 는 false (좁은 창 · 탭). 넓은 창은 matchMedia 를 흉내 내 연다.
function renderWs(work: WorkState) {
  return render(<Workspace time="day" usage={USAGE_OK} work={work} />);
}

function withWide(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("작업 공간 — 좁은 창(탭)", () => {
  it("탭은 ←/→ 로 옮기고, 채팅 탭에 기다리는 카드 수, 진행 탭에 지금 단계가 붙는다. 프로젝트 목록은 '프로젝트 바꾸기' 단추 안에", () => {
    renderWs("waiting");
    const chat = screen.getByRole("tab", { name: /채팅/ });
    expect(chat).toHaveAttribute("aria-selected", "true");
    expect(within(chat).getByLabelText("기다리는 카드 1개")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /진행/ })).toHaveTextContent("P3");

    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    const progress = screen.getByRole("tab", { name: /진행/ });
    expect(progress).toHaveFocus();
    expect(progress).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("list", { name: "단계" })).toBeInTheDocument();
    // 지금 단계(나를 기다림)는 지시서 작업까지 펼친다
    expect(screen.getByRole("list", { name: "P3 작업" })).toBeInTheDocument();

    // 프로젝트 바꾸기 — 열고 Esc 로 닫으면 단추로 포커스가 돌아온다
    const switcher = screen.getByRole("button", { name: /고양이 사진첩/ });
    fireEvent.click(switcher);
    expect(switcher).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("navigation", { name: "프로젝트" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("navigation", { name: "프로젝트" }), { key: "Escape" });
    expect(switcher).toHaveAttribute("aria-expanded", "false");
    expect(switcher).toHaveFocus();
  });

  it("일하는 중에는 중단 단추 — 한 번 더 묻고, 멈추면 쉬는 중 + 알림 줄", () => {
    renderWs("running");
    expect(screen.getByRole("status")).toHaveTextContent("일하는 중");
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    const confirm = screen.getByRole("alertdialog", { name: "지금 하던 일을 멈출까요?" });
    expect(within(confirm).getByRole("button", { name: "멈추기" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "멈추기" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("중단했어요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "중단" })).not.toBeInTheDocument();
  });

  it("스킬 고르기는 listbox — ↓ 로 옮기고 Enter 로 정하면 단추에 보이고 포커스가 돌아온다. 빈 입력칸에서 / 를 눌러도 열린다", () => {
    renderWs("idle");
    const button = screen.getByRole("button", { name: /스킬/ });
    fireEvent.click(button);
    const list = screen.getByRole("listbox", { name: "스킬 고르기" });
    expect(list).toHaveFocus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(list.getAttribute("aria-activedescendant")).toBe(within(list).getAllByRole("option")[1].id);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(button).toHaveTextContent("/web-full");
    expect(button).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("textbox", { name: "보낼 말" }), { key: "/" });
    expect(screen.getByRole("listbox", { name: "스킬 고르기" })).toBeInTheDocument();
  });

  it("오류 · 한도 · 연결 끊김은 입력줄 자리에 띠 — 오류는 경고로 읽히고, 다시 시도하면 같은 대화로 이어 한다", () => {
    const { unmount } = renderWs("error");
    expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("Claude Code 가 멈췄어요"))).toBe(true);
    expect(screen.queryByRole("textbox", { name: "보낼 말" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "원본 출력 보기" }));
    expect(screen.getByRole("tab", { name: /진행/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("원본 출력").closest("details")).toHaveAttribute("open");
    fireEvent.click(screen.getByRole("tab", { name: /채팅/ }));
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(screen.getByText("같은 대화로 다시 이어서 시작했어요")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "보낼 말" })).toBeInTheDocument();
    unmount();

    const limit = renderWs("limit");
    expect(screen.getByRole("meter", { name: "5시간 한도 사용량" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("switch", { name: "열리면 이어서 하기" })).toHaveAttribute("aria-checked", "true");
    limit.unmount();

    renderWs("offline");
    expect(screen.getByRole("button", { name: "지금 다시" })).toBeInTheDocument();
  });

  it("단계 표를 읽을 수 없으면 보드만 '읽을 수 없음' — 일하는 고양이 · 기록은 그대로 (D-22)", () => {
    renderWs("unreadable");
    fireEvent.click(screen.getByRole("tab", { name: /진행/ }));
    expect(screen.getByText("단계 표를 읽을 수 없어요")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "단계" })).not.toBeInTheDocument();
    expect(screen.getByText("앨범 바둑판 화면", { selector: ".wcats__task" })).toBeInTheDocument();
  });
});

describe("작업 공간 — 프로젝트 · 편집기", () => {
  it("프로젝트가 없으면 새 프로젝트 단추 하나 → 폴더 → 스킬 창. Esc 로 닫으면 여는 단추로 돌아간다", () => {
    renderWs("none");
    const open = screen.getByRole("button", { name: /새 프로젝트/ });
    open.focus();
    fireEvent.click(open);
    const dialog = screen.getByRole("dialog", { name: "새 프로젝트" });
    expect(within(dialog).getByRole("radio", { name: /새 폴더 만들기/ })).toHaveFocus();

    // 있는 폴더 → 고를 때마다 살펴본 결과가 바뀐다 (하네스로 하던 것이면 이어 하기)
    fireEvent.click(within(dialog).getByRole("radio", { name: /있는 폴더 쓰기/ }));
    const pick = within(dialog).getByRole("button", { name: /폴더 고르기/ });
    fireEvent.click(pick);
    expect(within(dialog).getByText("requirements.md 가 있어요")).toBeInTheDocument();
    fireEvent.click(pick);
    expect(within(dialog).getByText("하네스로 진행하던 프로젝트예요")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /다음: 스킬/ }));
    expect(within(dialog).getByRole("radio", { name: /harness-resume/ })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "열고 이어 하기" })).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("프로젝트가 많으면 찾기 칸 · 지금 / 최근 / 그 밖으로 나누고, 폴더를 찾을 수 없는 것을 알린다", () => {
    withWide(true);
    renderWs("many");
    const nav = screen.getByRole("navigation", { name: "프로젝트" });
    expect(within(nav).getByRole("region", { name: "지금" })).toHaveTextContent("고양이 사진첩");
    expect(within(nav).getByText("폴더를 찾을 수 없어요")).toBeInTheDocument();
    fireEvent.change(within(nav).getByPlaceholderText("프로젝트 찾기"), { target: { value: "요리" } });
    expect(within(nav).getAllByRole("button", { name: /요리 수첩/ })).toHaveLength(1);
    expect(within(nav).queryByRole("button", { name: /가계부 정리/ })).not.toBeInTheDocument();
  });

  it("넓은 창: 진행 중인 프로젝트는 요구사항 칸을 띠로 접어 두고, 띠를 누르면 펼친다. 바깥에서 바뀐 요구사항은 띠에 점으로 알린다", () => {
    withWide(true);
    renderWs("idle");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    const strip = screen.getByRole("button", { name: /요구사항 펼치기 — 다른 곳/ });
    fireEvent.click(strip);
    expect(screen.getByText(/requirements.md 가 바뀌었어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "요구사항 칸 접기" }));
    expect(screen.getByRole("button", { name: /요구사항 펼치기/ })).toBeInTheDocument();
  });

  it("빈 요구사항은 예시로 시작 → 쓰면 '저장 안 됨', 1초 쉬면 자동 저장, Ctrl+S 는 바로 저장", () => {
    vi.useFakeTimers();
    renderWs("empty");
    fireEvent.click(screen.getByRole("button", { name: "예시로 시작하기" }));
    const text = screen.getByRole("textbox", { name: "요구사항 (마크다운)" });
    expect((text as HTMLTextAreaElement).value).toContain("# 고양이 일기");
    expect(screen.getByText("저장 안 됨")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("저장 중…")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByText(/^저장됨 /)).toBeInTheDocument();

    fireEvent.change(text, { target: { value: "# 고양이 일기\n- 하루 한 줄" } });
    expect(screen.getByText("저장 안 됨")).toBeInTheDocument();
    fireEvent.keyDown(text, { key: "s", ctrlKey: true });
    expect(screen.getByText(/^저장됨 /)).toBeInTheDocument();

    // 미리보기 — 제목 · 목록
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(screen.getByRole("heading", { name: "고양이 일기" })).toBeInTheDocument();
    expect(screen.getByText("하루 한 줄")).toBeInTheDocument();
  });
});
