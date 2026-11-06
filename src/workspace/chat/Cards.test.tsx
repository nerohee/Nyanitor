// 채팅 카드 — 질문(하나 · 여러 개 · 직접 쓰기 · 미리보기) · 단계 승인 · 권한(항상 허용 규칙이 없으면 단추 없음 · 다르게 말하기),
// 답 보내기(보내는 중 · 실패) · 답한 뒤 접기 · 지나감 · 취소됨은 답할 수 없다.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeResponse, PermissionRequestInfo, QuestionRequestInfo } from "../../lib/ipc-types";
import { AppError } from "../../lib/ipc-types";
import { PermissionCard, QuestionRequest, type Respond } from "./Cards";
import { ChatLog } from "./ChatLog";
import type { CardState, PermissionView } from "./model";

const PENDING: CardState = { status: "pending", answer: null };
const answered = (answer: Partial<Extract<NonNullable<CardState["answer"]>, { type: "request_answered" }>> & { kind: ClaudeResponse["kind"] }): CardState => ({
  status: "answered",
  answer: { type: "request_answered", requestId: "r1", text: null, answers: null, ...answer },
});

function responder() {
  return vi.fn<Respond>().mockResolvedValue(undefined);
}

const QUESTIONS: QuestionRequestInfo = {
  requestId: "r1",
  toolUseId: null,
  questions: [
    {
      question: "어떤 색이 좋아요?",
      header: "색",
      multiSelect: false,
      options: [
        { label: "파랑 (권장)", description: "차분한 색", preview: "┌──┐\n│파랑│\n└──┘" },
        { label: "초록", description: null, preview: "초록 미리보기" },
      ],
    },
    {
      question: "넣을 것을 모두 골라 주세요",
      header: "넣을 것",
      multiSelect: true,
      options: [
        { label: "그림", description: null, preview: null },
        { label: "표", description: null, preview: null },
      ],
    },
  ],
};

const FOUR: QuestionRequestInfo = {
  requestId: "r4",
  toolUseId: null,
  questions: [
    { question: "Q1?", header: "첫째", multiSelect: false, options: [{ label: "가", description: null, preview: null }, { label: "나", description: null, preview: null }] },
    { question: "Q2?", header: "둘째", multiSelect: true, options: [{ label: "다", description: null, preview: null }, { label: "라", description: null, preview: null }] },
    { question: "Q3?", header: "셋째", multiSelect: false, options: [{ label: "마", description: null, preview: null }, { label: "바", description: null, preview: null }] },
    { question: "Q4?", header: "넷째", multiSelect: false, options: [{ label: "사", description: null, preview: null }, { label: "아", description: null, preview: null }] },
  ],
};

describe("질문 카드", () => {
  it("권장 표시는 선택지 글 그대로 · 설명 · 미리보기 상자가 보이고, 질문이 여럿이면 하나씩 보인다", () => {
    render(<QuestionRequest info={QUESTIONS} state={PENDING} onRespond={responder()} />);
    expect(screen.getByText("파랑 (권장)")).toBeInTheDocument();
    expect(screen.getByText("차분한 색")).toBeInTheDocument();
    expect(screen.getByText(/파랑/, { selector: "pre" })).toBeInTheDocument();
    // 둘째 질문은 아직 안 보인다 · 첫 칸에는 보내기 대신 [다음]
    expect(screen.queryByText("넣을 것을 모두 골라 주세요")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "답 보내기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "이전" })).toBeDisabled();
    expect(screen.getByText("2개 중 0개 답함", { exact: false })).toBeInTheDocument();
  });

  it("하나 고르기 + 여러 개 고르기 → 요약을 거쳐 질문 문장을 열쇠로 한 answer 를 보낸다", async () => {
    const respond = responder();
    render(<QuestionRequest info={QUESTIONS} state={PENDING} onRespond={respond} />);
    const [, green] = screen.getAllByRole("radio");
    fireEvent.click(green!);
    // 하나 고르기는 고르면 다음 질문으로
    expect(await screen.findByText("넣을 것을 모두 골라 주세요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /^색/ }));
    expect(screen.getAllByRole("radio")[0]).not.toBeChecked();
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    // 여러 개 고르기는 [다음] 으로
    fireEvent.click(await screen.findByRole("checkbox", { name: /표/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /그림/ }));
    expect(screen.queryByRole("button", { name: "답 보내기" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    // 요약
    expect(await screen.findByRole("heading", { name: "이렇게 보낼까요?" })).toBeInTheDocument();
    expect(screen.getByText("파랑 (권장)")).toBeInTheDocument();
    expect(screen.getByText("그림 · 표")).toBeInTheDocument();
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith("r1", {
      kind: "answer",
      answers: { "어떤 색이 좋아요?": "파랑 (권장)", "넣을 것을 모두 골라 주세요": ["그림", "표"] },
    });
  });

  it("직접 쓰기 — 하나 고르기는 선택지를 대신하고(고르는 즉시 넘어가지 않는다), 여러 개 고르기는 선택지와 함께. 빈 글은 답이 아니다", async () => {
    const respond = responder();
    render(<QuestionRequest info={QUESTIONS} state={PENDING} onRespond={respond} />);
    fireEvent.click(screen.getByRole("radio", { name: "직접 쓰기" }));
    // 칸이 열렸지만 비어 있어 아직 답이 아니다 — 넘어가지 않고 [다음] 도 꺼져 있다
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "직접 쓴 답" }), { target: { value: "  보라색  " } });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /그림/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "직접 쓰기" }));
    fireEvent.change(screen.getByRole("textbox", { name: "직접 쓴 답" }), { target: { value: "글" } });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond).toHaveBeenCalledWith("r1", {
      kind: "answer",
      answers: { "어떤 색이 좋아요?": "보라색", "넣을 것을 모두 골라 주세요": ["그림", "글"] },
    });
  });

  it("질문 4개 — 하나씩, 탭에 답함 표시 · 앞으로 돌아가 바꾸기 · 요약에서 바꾸기, 보내는 모양은 그대로", async () => {
    const respond = responder();
    render(<QuestionRequest info={FOUR} state={PENDING} onRespond={respond} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["첫째", "둘째", "셋째", "넷째", "확인"]);
    expect(screen.getByText("1/4")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /가/ }));
    expect(await screen.findByText("Q2?")).toBeInTheDocument();
    expect(screen.getByText("2/4")).toBeInTheDocument();
    // 답한 질문은 글로도 알린다 (색만이 아니라)
    expect(screen.getByRole("tab", { name: "첫째 (답함)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "둘째" })).toHaveAttribute("aria-selected", "true");
    // 앞으로 돌아가 바꾸면 다시 다음으로
    fireEvent.click(screen.getByRole("button", { name: "이전" }));
    expect(screen.getByRole("radio", { name: /가/ })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: /나/ }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /라/ }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("radio", { name: /바/ }));
    fireEvent.click(await screen.findByRole("radio", { name: /사/ }));
    expect(await screen.findByRole("heading", { name: "이렇게 보낼까요?" })).toBeInTheDocument();
    // 요약에서 하나 바꾸기
    fireEvent.click(screen.getByRole("button", { name: "셋째 답 바꾸기" }));
    fireEvent.click(await screen.findByRole("radio", { name: /마/ }));
    fireEvent.click(await screen.findByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith("r4", { kind: "answer", answers: { "Q1?": "나", "Q2?": ["라"], "Q3?": "마", "Q4?": "사" } });
  });

  it("다 안 골랐으면 요약에서 보낼 수 없고, 안 고른 칸은 그렇게 쓴다", async () => {
    render(<QuestionRequest info={FOUR} state={PENDING} onRespond={responder()} />);
    fireEvent.click(screen.getByRole("tab", { name: "확인" }));
    expect(await screen.findByRole("button", { name: "답 보내기" })).toBeDisabled();
    expect(screen.getAllByText("아직 안 골랐어요")).toHaveLength(4);
  });

  it("방향키로 선택지를 훑을 때는 넘어가지 않는다 — Enter 로 다음", async () => {
    render(<QuestionRequest info={FOUR} state={PENDING} onRespond={responder()} />);
    const first = screen.getByRole("radio", { name: /가/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("radio", { name: /나/ })); // 브라우저가 방향키로 고를 때 보내는 click
    fireEvent.keyUp(first, { key: "ArrowDown" });
    expect(screen.getByText("Q1?")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /나/ })).toBeChecked();
    fireEvent.keyDown(screen.getByRole("radio", { name: /나/ }), { key: "Enter" });
    expect(await screen.findByText("Q2?")).toBeInTheDocument();
  });

  it("탭 줄은 ←/→ 로 옮기고 초점이 따라간다, 단추로 질문이 바뀌면 초점은 새 질문 제목으로", async () => {
    render(<QuestionRequest info={FOUR} state={PENDING} onRespond={responder()} />);
    const [t1] = screen.getAllByRole("tab");
    t1!.focus();
    fireEvent.keyDown(t1!, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "둘째" })).toHaveFocus();
    expect(screen.getByText("Q2?")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("tab", { name: "둘째" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "확인" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "확인" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "첫째" })).toHaveFocus();
    // 고르면 다음 질문 제목(질문 2/4 …)으로
    fireEvent.click(screen.getByRole("radio", { name: /가/ }));
    const group = await screen.findByRole("group", { name: /질문 2\/4/ });
    expect(within(group).getByText("Q2?").closest("legend")).toHaveFocus();
  });

  it("고른 값은 카드를 다시 그려도 남는다 (보던 칸까지)", async () => {
    const first = render(<QuestionRequest info={FOUR} state={PENDING} onRespond={responder()} />);
    fireEvent.click(screen.getByRole("radio", { name: /나/ }));
    await screen.findByText("Q2?");
    first.unmount();
    render(<QuestionRequest info={FOUR} state={PENDING} onRespond={responder()} />);
    expect(screen.getByText("Q2?")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "첫째 (답함)" })).toBeInTheDocument();
  });

  it("선택지에서 Enter 를 누르면 보낸다 (다 골랐을 때만)", async () => {
    const respond = responder();
    const single: QuestionRequestInfo = { ...QUESTIONS, questions: [QUESTIONS.questions[0]!] };
    render(<QuestionRequest info={single} state={PENDING} onRespond={respond} />);
    const [blue] = screen.getAllByRole("radio");
    fireEvent.keyDown(blue!, { key: "Enter" });
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(blue!);
    fireEvent.keyDown(blue!, { key: "Enter" });
    await waitFor(() => expect(respond).toHaveBeenCalledWith("r1", { kind: "answer", answers: { "어떤 색이 좋아요?": "파랑 (권장)" } }));
  });

  it("보내는 동안 단추를 끄고, 실패하면 한 줄 + 다시 보낼 수 있다", async () => {
    let fail: (error: unknown) => void = () => undefined;
    const respond = vi.fn<Respond>().mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
    respond.mockResolvedValue(undefined);
    const single: QuestionRequestInfo = { ...QUESTIONS, questions: [QUESTIONS.questions[0]!] };
    render(<QuestionRequest info={single} state={PENDING} onRespond={respond} />);
    fireEvent.click(screen.getAllByRole("radio")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "답 보내기" }));
    const sending = await screen.findByRole("button", { name: "보내는 중…" });
    expect(sending).toBeDisabled();
    expect(screen.getAllByRole("radio")[0]).toBeDisabled();
    fail(new AppError("request_not_found", "x"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("답을 보내지 못했어요 — 이미 지나갔거나 취소된 요청이에요.");
    // 다시 보낼 수 있다
    fireEvent.click(await screen.findByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(2));
  });

  it("답한 카드는 접혀서 고른 답이 보인다 — 선택지도 단추도 없다", () => {
    render(
      <QuestionRequest
        info={QUESTIONS}
        state={answered({ kind: "answer", answers: { "어떤 색이 좋아요?": "초록", "넣을 것을 모두 골라 주세요": ["그림", "표"] } })}
        onRespond={responder()}
      />,
    );
    expect(screen.getByText("초록")).toBeInTheDocument();
    expect(screen.getByText("그림 · 표")).toBeInTheDocument();
    expect(screen.getByText("답함")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("지나감 · 취소됨은 흐리게 한 줄 — 답할 수 없다", () => {
    const { rerender } = render(<QuestionRequest info={QUESTIONS} state={{ status: "expired", answer: null }} onRespond={responder()} />);
    expect(screen.getByText("앱을 다시 켜서 답할 수 없어요.")).toBeInTheDocument();
    expect(screen.getByText("지나감")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    rerender(<QuestionRequest info={QUESTIONS} state={{ status: "cancelled", answer: null }} onRespond={responder()} />);
    expect(screen.getByText("중단했거나 세션이 끝나서 취소됐어요.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("단계 승인 카드", () => {
  const APPROVAL = [
    "단계 승인 — P4 하네스 설치 · 업데이트",
    "- 무엇을: 앱에서 하네스를 받아 설치한다",
    "- 왜 지금: 고양이 집이 읽기 전에 필요하다",
    "- 산출물: 설치 화면",
    "- 하지 않는 것: 편집 화면",
  ].join("\n");
  const info = (question: string): QuestionRequestInfo => ({
    requestId: "r1",
    toolUseId: null,
    questions: [
      {
        question,
        header: "단계 승인",
        multiSelect: false,
        options: [
          { label: "승인 (권장)", description: null, preview: null },
          { label: "고쳐서 다시", description: null, preview: null },
        ],
      },
    ],
  });

  it("네 칸이 보이고 승인 · 고쳐서 다시 · 기타 단추가 있다", () => {
    render(<QuestionRequest info={info(APPROVAL)} state={PENDING} onRespond={responder()} />);
    expect(screen.getByRole("article", { name: "승인 요청" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "P4 하네스 설치 · 업데이트" })).toBeInTheDocument();
    const dl = document.querySelector(".wc-appr") as HTMLElement;
    expect(within(dl).getByText("무엇을").nextElementSibling).toHaveTextContent("앱에서 하네스를 받아 설치한다");
    expect(within(dl).getByText("왜 지금").nextElementSibling).toHaveTextContent("고양이 집이 읽기 전에 필요하다");
    expect(within(dl).getByText("산출물").nextElementSibling).toHaveTextContent("설치 화면");
    expect(within(dl).getByText("하지 않는 것").nextElementSibling).toHaveTextContent("편집 화면");
    expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "고쳐서 다시" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기타 — 직접 쓰기" })).toBeInTheDocument();
  });

  it("승인 · 고쳐서 다시는 질문의 선택지 이름 그대로 answer 로 보낸다", async () => {
    const respond = responder();
    const { unmount } = render(<QuestionRequest info={info(APPROVAL)} state={PENDING} onRespond={respond} />);
    fireEvent.click(screen.getByRole("button", { name: "승인" }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith("r1", { kind: "answer", answers: { [APPROVAL]: "승인 (권장)" } }));
    unmount();
    const redo = responder();
    render(<QuestionRequest info={info(APPROVAL)} state={PENDING} onRespond={redo} />);
    fireEvent.click(screen.getByRole("button", { name: "고쳐서 다시" }));
    await waitFor(() => expect(redo).toHaveBeenCalledWith("r1", { kind: "answer", answers: { [APPROVAL]: "고쳐서 다시" } }));
  });

  it("기타 — 직접 쓴 글을 답으로 (빈 글은 보낼 수 없다)", async () => {
    const respond = responder();
    render(<QuestionRequest info={info(APPROVAL)} state={PENDING} onRespond={respond} />);
    fireEvent.click(screen.getByRole("button", { name: "기타 — 직접 쓰기" }));
    const send = screen.getByRole("button", { name: "고칠 점 보내기" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "직접 쓴 답" }), { target: { value: " P4 에 이름표도 넣어 주세요 " } });
    fireEvent.click(send);
    await waitFor(() => expect(respond).toHaveBeenCalledWith("r1", { kind: "answer", answers: { [APPROVAL]: "P4 에 이름표도 넣어 주세요" } }));
  });

  it("빠진 칸은 읽을 수 없음으로 보인다", () => {
    render(<QuestionRequest info={info("단계 승인 — P4 하네스\n- 무엇을: 설치")} state={PENDING} onRespond={responder()} />);
    expect(screen.getAllByText("읽을 수 없음")).toHaveLength(3);
  });

  it("승인 모양이 아니면 보통 질문 카드, 질문이 둘 이상이어도 보통 카드", () => {
    render(<QuestionRequest info={info("이 계획으로 시작할까요?")} state={PENDING} onRespond={responder()} />);
    expect(screen.getByRole("article", { name: "질문" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "승인 요청" })).not.toBeInTheDocument();
  });

  it("답한 뒤 접혀서 결과 한 줄 — 승인함 · 고쳐서 다시 · 직접 쓴 답. 지나간 승인은 답할 수 없다", () => {
    const { rerender } = render(<QuestionRequest info={info(APPROVAL)} state={answered({ kind: "answer", answers: { [APPROVAL]: "승인 (권장)" } })} onRespond={responder()} />);
    expect(screen.getByText("승인함")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<QuestionRequest info={info(APPROVAL)} state={answered({ kind: "answer", answers: { [APPROVAL]: "범위를 줄여 주세요" } })} onRespond={responder()} />);
    expect(screen.getByText("직접 답했어요: 범위를 줄여 주세요")).toBeInTheDocument();
    rerender(<QuestionRequest info={info(APPROVAL)} state={{ status: "expired", answer: null }} onRespond={responder()} />);
    expect(screen.getByText("앱을 다시 켜서 답할 수 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("권한 카드", () => {
  const base: PermissionRequestInfo = {
    requestId: "r1",
    toolUseId: "t1",
    tool: "Bash",
    displayName: "Bash",
    description: "폴더 만들기",
    command: "mkdir demo",
    path: null,
    cwd: "C:\\dev\\app",
    input: { command: "mkdir demo" },
    alwaysRule: { rule: "Bash(mkdir demo *)", scope: "suggested", folder: null },
  };

  it("무엇을(도구 · 설명 · 명령) · 어디서가 보이고, 도구 입력은 접혀 있다 (실시간일 때만)", () => {
    const { rerender } = render(<PermissionCard info={base} state={PENDING} onRespond={responder()} />);
    expect(screen.getByText("명령 실행")).toBeInTheDocument();
    expect(screen.getByText("폴더 만들기")).toBeInTheDocument();
    expect(screen.getByText("mkdir demo", { selector: "pre code" })).toBeInTheDocument();
    expect(screen.getByText("C:\\dev\\app")).toBeInTheDocument();
    const fold = screen.getByText("도구 입력 보기").closest("details") as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    // 기록에서 온 카드에는 도구 입력이 없다 (D-48)
    const stored: PermissionView = { ...base };
    delete stored.input;
    rerender(<PermissionCard info={stored} state={PENDING} onRespond={responder()} />);
    expect(screen.queryByText("도구 입력 보기")).not.toBeInTheDocument();
  });

  it("허용 · 항상 허용(규칙 글이 보인다) · 거부가 각각 그 응답을 보낸다", async () => {
    const respond = responder();
    render(<PermissionCard info={base} state={PENDING} onRespond={respond} />);
    expect(screen.getByText("Bash(mkdir demo *)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이번만 허용" }));
    await waitFor(() => expect(respond).toHaveBeenLastCalledWith("r1", { kind: "allow" }));
    fireEvent.click(screen.getByRole("button", { name: "이 프로젝트에서 항상 허용" }));
    await waitFor(() => expect(respond).toHaveBeenLastCalledWith("r1", { kind: "always_allow" }));
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    await waitFor(() => expect(respond).toHaveBeenLastCalledWith("r1", { kind: "deny" }));
  });

  it("항상 허용의 규칙이 없으면 그 단추도 규칙 글도 없다 (D-23 · D-45)", () => {
    render(<PermissionCard info={{ ...base, alwaysRule: null }} state={PENDING} onRespond={responder()} />);
    expect(screen.queryByRole("button", { name: "이 프로젝트에서 항상 허용" })).not.toBeInTheDocument();
    expect(screen.queryByText(/settings.local.json/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이번만 허용" })).toBeInTheDocument();
  });

  it("다르게 하라고 말하기 — 글 칸이 열리고 빈 글은 보낼 수 없고, 보내면 tell", async () => {
    const respond = responder();
    render(<PermissionCard info={base} state={PENDING} onRespond={respond} />);
    fireEvent.click(screen.getByRole("button", { name: "다르게 하라고 말하기" }));
    const send = screen.getByRole("button", { name: "거부하고 보내기" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "거부하는 이유 · 대신 할 것" }), { target: { value: " 직접 읽어 주세요 " } });
    fireEvent.click(send);
    await waitFor(() => expect(respond).toHaveBeenCalledWith("r1", { kind: "tell", text: "직접 읽어 주세요" }));
  });

  it("보내는 동안 모든 단추가 꺼진다", async () => {
    let finish: () => void = () => undefined;
    const respond = vi.fn<Respond>().mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<PermissionCard info={base} state={PENDING} onRespond={respond} />);
    fireEvent.click(screen.getByRole("button", { name: "이번만 허용" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "거부" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "이번만 허용" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "거부" }));
    expect(respond).toHaveBeenCalledTimes(1);
    finish();
  });

  it("답한 뒤 접혀서 결과 한 줄 — 허용 · 항상 허용(규칙) · 거부(이유) · 다르게 말함", () => {
    const view = (state: CardState) => render(<PermissionCard info={base} state={state} onRespond={responder()} />);
    let r = view(answered({ kind: "allow" }));
    expect(screen.getByText("이번만 허용함")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    r.unmount();
    r = view(answered({ kind: "always_allow" }));
    expect(screen.getByText("이 프로젝트에서 항상 허용함")).toBeInTheDocument();
    expect(screen.getByText("Bash(mkdir demo *)", { selector: ".wc-card__result code" })).toBeInTheDocument();
    r.unmount();
    r = view(answered({ kind: "deny", text: "그 파일은 건드리지 마" }));
    expect(screen.getByText("거부함 — 그 파일은 건드리지 마")).toBeInTheDocument();
    r.unmount();
    r = view(answered({ kind: "tell", text: "푸시는 내가 할게" }));
    expect(screen.getByText("다르게 하라고 말했어요: 푸시는 내가 할게")).toBeInTheDocument();
    r.unmount();
    view({ status: "answered", answer: null });
    expect(screen.getAllByText("답함").length).toBeGreaterThan(0);
  });

  it("지나감 · 취소됨은 답할 수 없다 — 단추가 없다", () => {
    const { rerender } = render(<PermissionCard info={base} state={{ status: "expired", answer: null }} onRespond={responder()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("앱을 다시 켜서 답할 수 없어요.")).toBeInTheDocument();
    rerender(<PermissionCard info={base} state={{ status: "cancelled", answer: null }} onRespond={responder()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("취소됨")).toBeInTheDocument();
  });
});

describe("기다리는 권한 카드는 맨 앞 하나만", () => {
  const perm = (id: string, cmd: string): PermissionView => ({
    requestId: id,
    toolUseId: null,
    tool: "Bash",
    displayName: "Bash",
    description: cmd,
    command: cmd,
    path: null,
    cwd: "C:/p",
    alwaysRule: null,
  });
  const lines = [
    { key: "1", kind: "permission", info: perm("p1", "첫째 명령"), state: PENDING },
    { key: "2", kind: "question", info: QUESTIONS, state: PENDING },
    { key: "3", kind: "permission", info: perm("p2", "둘째 명령"), state: PENDING },
    { key: "4", kind: "permission", info: perm("p3", "셋째 명령"), state: PENDING },
    { key: "5", kind: "permission", info: perm("p0", "지난 명령"), state: answered({ kind: "allow" }) },
  ] as const;

  it("질문 카드와 권한 카드는 각각 맨 앞 하나씩 · 답한 카드는 기록으로 남는다 · 머리에 남은 요청 수", () => {
    render(<ChatLog lines={lines} hasMore={false} loadingOlder={false} olderFailed={false} onLoadOlder={() => undefined} onRespond={responder()} />);
    expect(screen.getAllByRole("article", { name: "권한 요청" })).toHaveLength(2);
    expect(screen.getByText("첫째 명령", { selector: "pre code" })).toBeInTheDocument();
    expect(screen.queryByText("둘째 명령", { selector: "pre code" })).not.toBeInTheDocument();
    expect(screen.getByText("지난 명령", { selector: "pre code" })).toBeInTheDocument();
    expect(screen.getByText("남은 요청 2개")).toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: "질문" })).toHaveLength(1);
  });

  it("앞의 카드가 답으로 닫히면 다음 요청이 나온다, 하나만 남으면 남은 요청 글이 없다", () => {
    const next = [{ ...lines[0], state: answered({ kind: "allow" }) }, ...lines.slice(1, 3)];
    render(<ChatLog lines={next as never} hasMore={false} loadingOlder={false} olderFailed={false} onLoadOlder={() => undefined} onRespond={responder()} />);
    expect(screen.getByText("둘째 명령", { selector: "pre code" })).toBeInTheDocument();
    expect(screen.queryByText(/남은 요청/)).not.toBeInTheDocument();
  });
});
