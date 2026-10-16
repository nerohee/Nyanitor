import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { workspaceFixture, type ChatItem } from "../fixtures-workspace";
import { ApprovalCard, isPending, PermissionCard, QuestionCard } from "./cards";

type Item<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

function pendingOf<K extends ChatItem["kind"]>(state: Parameters<typeof workspaceFixture>[0], kind: K): Item<K> {
  const found = workspaceFixture(state).chat.find((item): item is Item<K> => item.kind === kind && isPending(item));
  if (!found) throw new Error(`기다리는 ${kind} 카드가 fixture(${state})에 있어야 한다`);
  return found;
}

describe("채팅 선택 카드", () => {
  it("질문 카드: 선택지는 키보드로 닿는 진짜 라디오 · 체크박스, 미리보기는 포커스한 선택지를 따라가고, 다 고르기 전에는 보낼 수 없다", () => {
    render(<QuestionCard item={pendingOf("waiting", "question")} />);

    // 하나 고르기 — 이름(legend)이 붙은 묶음. Tab 으로 들어가고 화살표로 옮기는 것은 브라우저 기본 동작
    const shape = screen.getByRole("group", { name: /사진을 어떻게 늘어놓을까요/ });
    const radios = within(shape).getAllByRole("radio");
    expect(radios).toHaveLength(4); // A · B · C · 직접 쓰기
    radios.forEach((radio) => expect(radio).not.toHaveAttribute("tabindex", "-1"));
    const grid = within(shape).getByRole("radio", { name: /바둑판/ });
    expect(within(grid.closest("label") as HTMLElement).getByText("권장")).toBeInTheDocument();

    // 미리보기 — 처음에는 첫 선택지, B 에 포커스하면 B 를 보이고, 선택지와 aria-describedby 로 이어진다
    expect(screen.getByText("A 바둑판 미리보기")).toBeInTheDocument();
    const band = within(shape).getByRole("radio", { name: /날짜 띠/ });
    fireEvent.focus(band);
    expect(screen.getByText("B 날짜 띠 미리보기")).toBeInTheDocument();
    expect(band.getAttribute("aria-describedby")).toBe(screen.getByText("B 날짜 띠 미리보기").closest("figure")?.id);

    const submit = screen.getByRole("button", { name: "답 보내기" });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/2개 중 0개 답함/)).toBeInTheDocument();

    // 직접 쓰기 → 입력칸으로 포커스, 비어 있으면 답한 것이 아니다
    fireEvent.click(within(shape).getByRole("radio", { name: /직접 쓰기/ }));
    const writeIn = screen.getByRole("textbox", { name: "직접 쓴 답" });
    expect(writeIn).toHaveFocus();
    expect(screen.getByText(/2개 중 0개 답함/)).toBeInTheDocument();
    fireEvent.change(writeIn, { target: { value: "고양이마다 한 줄" } });
    expect(screen.getByText(/2개 중 1개 답함/)).toBeInTheDocument();

    // 여러 개 고르기
    const show = screen.getByRole("group", { name: /사진 카드에 무엇을/ });
    const boxes = within(show).getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
    expect(submit).toBeEnabled();

    // 보내면 답한 카드로 접힌다 — 고른 것을 짧게
    fireEvent.click(submit);
    expect(screen.getByText("답함")).toBeInTheDocument();
    expect(screen.getByText("“고양이마다 한 줄”")).toBeInTheDocument();
    expect(screen.getByText("A 찍은 날짜 · B 고양이 이름")).toBeInTheDocument();
  });

  it("권한 카드: 명령 · 어디서를 보이고, 이번만 허용 / 이 프로젝트에서 항상 허용 / 거부 — 항상 허용이 무엇을 쓰는지 미리 알린다 (D-23)", () => {
    const item = pendingOf("permission", "permission");
    render(<PermissionCard item={item} />);
    expect(screen.getByText("npm install exifr")).toBeInTheDocument();
    expect(screen.getByText("C:\\dev\\cat-album")).toBeInTheDocument();
    const always = screen.getByRole("button", { name: "이 프로젝트에서 항상 허용" });
    expect(screen.getByRole("button", { name: "이번만 허용" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "거부" })).toBeInTheDocument();
    // 항상 허용 단추의 설명 = settings.local.json 에 더할 규칙
    const note = document.getElementById(always.getAttribute("aria-describedby") ?? "");
    expect(note).toHaveTextContent(".claude/settings.local.json");
    expect(note).toHaveTextContent("Bash(npm install:*)");

    // 다르게 하라고 말하기 → 입력칸
    fireEvent.click(screen.getByRole("button", { name: "다르게 하라고 말하기" }));
    expect(screen.getByRole("textbox", { name: "거부하는 이유 · 대신 할 것" })).toHaveFocus();

    fireEvent.click(always);
    expect(screen.getByText("이 프로젝트에서 항상 허용함")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이번만 허용" })).not.toBeInTheDocument();
  });

  it("승인 카드: 승인 게이트 4항목(무엇을 · 왜 지금 · 산출물 · 하지 않는 것), 고칠 점을 말할 수 있다", () => {
    render(<ApprovalCard item={pendingOf("approval", "approval")} />);
    for (const label of ["무엇을", "왜 지금", "산출물", "하지 않는 것"]) expect(screen.getByText(label)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "고칠 점 말하기" }));
    expect(screen.getByRole("textbox", { name: "고칠 점" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "고칠 점 보내기" }));
    expect(screen.getByText(/고칠 점을 보냈어요/)).toBeInTheDocument();
  });
});
