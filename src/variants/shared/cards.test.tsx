import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { workspaceFixture, type ChatItem } from "../fixtures-workspace";
import { PermissionCard, QuestionCard } from "./cards";

describe("채팅 선택 카드", () => {
  it("질문 카드: 선택지가 키보드로 닿는 진짜 라디오 · 체크박스이고, 고르면 바뀌며, 직접 쓰기를 고르면 입력칸으로 포커스가 간다. 권한 카드 단추 3개는 이름으로 찾아진다", () => {
    const pending = workspaceFixture("waiting").chat.find(
      (item): item is Extract<ChatItem, { kind: "question" }> => item.kind === "question" && !item.done,
    );
    if (!pending) throw new Error("기다리는 질문 카드가 fixture 에 있어야 한다");
    render(<QuestionCard item={pending} />);

    // 한 개 고르기 — 이름(legend)이 붙은 묶음 안의 라디오. Tab 으로 묶음에 들어가고 화살표로 옮기는 것은 브라우저 기본 동작
    const order = screen.getByRole("group", { name: /사진을 어떤 순서로/ });
    const radios = within(order).getAllByRole("radio");
    expect(radios).toHaveLength(4); // A · B · C · 직접 쓰기
    radios.forEach((radio) => expect(radio).not.toHaveAttribute("tabindex", "-1"));

    const recent = within(order).getByRole("radio", { name: /최근 사진부터/ });
    expect(within(recent.closest("label") as HTMLElement).getByText("권장")).toBeInTheDocument();
    recent.focus();
    expect(recent).toHaveFocus();
    // Space 가 라디오에 하는 일(click)을 보낸다 — jsdom 은 키 입력으로 라디오를 고르지 않는다
    fireEvent.click(recent);
    expect(recent).toBeChecked();

    // 직접 쓰기 → 입력칸이 나타나고 포커스
    fireEvent.click(within(order).getByRole("radio", { name: /직접 쓰기/ }));
    expect(screen.getByRole("textbox", { name: "직접 쓴 답" })).toHaveFocus();
    expect(recent).not.toBeChecked();

    // 여러 개 고르기
    const show = screen.getByRole("group", { name: /사진 카드에 무엇을/ });
    const boxes = within(show).getAllByRole("checkbox");
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).toBeChecked();
    expect(screen.getByRole("button", { name: "답 보내기" })).toBeEnabled();

    // 권한 카드 (기다리는 상태)
    render(
      <PermissionCard
        item={{
          kind: "permission",
          id: "perm",
          time: "10:00",
          tool: "Bash",
          command: "npm run dev",
          whyKey: "variant.fixture.chat.p1.why",
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "허용" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "거부" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이 프로젝트에서 항상 허용" })).toBeInTheDocument();
  });
});
