// 채팅 카드 — 질문(하나 · 여러 개 · 직접 쓰기 · 미리보기) · 단계 승인 · 권한(항상 허용 규칙이 없으면 단추 없음 · 다르게 말하기),
// 답 보내기(보내는 중 · 실패) · 답한 뒤 접기 · 지나감 · 취소됨은 답할 수 없다.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeResponse, PermissionRequestInfo, QuestionRequestInfo } from "../../lib/ipc-types";
import { AppError } from "../../lib/ipc-types";
import { PermissionCard, QuestionRequest, type Respond } from "./Cards";
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

describe("질문 카드", () => {
  it("권장 표시는 선택지 글 그대로 · 설명 · 미리보기 상자가 보이고, 다 고르기 전에는 보낼 수 없다", () => {
    render(<QuestionRequest info={QUESTIONS} state={PENDING} onRespond={responder()} />);
    expect(screen.getByText("파랑 (권장)")).toBeInTheDocument();
    expect(screen.getByText("차분한 색")).toBeInTheDocument();
    expect(screen.getByText(/파랑/, { selector: "pre" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "답 보내기" })).toBeDisabled();
    expect(screen.getByText("2개 중 0개 답함", { exact: false })).toBeInTheDocument();
  });

  it("하나 고르기 + 여러 개 고르기 → 질문 문장을 열쇠로 한 answer 를 보낸다", async () => {
    const respond = responder();
    render(<QuestionRequest info={QUESTIONS} state={PENDING} onRespond={respond} />);
    const [blue, green] = screen.getAllByRole("radio");
    fireEvent.click(green!);
    fireEvent.click(blue!);
    expect(blue).toBeChecked();
    expect(green).not.toBeChecked();
    // 미리보기는 고른 것을 따라간다
    fireEvent.click(screen.getByRole("checkbox", { name: /표/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /그림/ }));
    expect(screen.getByRole("button", { name: "답 보내기" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    expect(respond).toHaveBeenCalledWith("r1", {
      kind: "answer",
      answers: { "어떤 색이 좋아요?": "파랑 (권장)", "넣을 것을 모두 골라 주세요": ["그림", "표"] },
    });
  });

  it("직접 쓰기 — 하나 고르기는 선택지를 대신하고, 여러 개 고르기는 선택지와 함께. 빈 글은 답이 아니다", async () => {
    const respond = responder();
    render(<QuestionRequest info={QUESTIONS} state={PENDING} onRespond={respond} />);
    const [singleWrite] = screen.getAllByRole("radio").slice(-1);
    const [, , multiWriteBox] = screen.getAllByRole("checkbox").slice(-3);
    fireEvent.click(singleWrite!);
    // 칸이 열렸지만 비어 있어 아직 답이 아니다
    expect(screen.getByRole("button", { name: "답 보내기" })).toBeDisabled();
    const [firstText] = screen.getAllByRole("textbox", { name: "직접 쓴 답" });
    fireEvent.change(firstText!, { target: { value: "  보라색  " } });
    fireEvent.click(screen.getByRole("checkbox", { name: /그림/ }));
    fireEvent.click(multiWriteBox!);
    const texts = screen.getAllByRole("textbox", { name: "직접 쓴 답" });
    fireEvent.change(texts[1]!, { target: { value: "글" } });
    fireEvent.click(screen.getByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond).toHaveBeenCalledWith("r1", {
      kind: "answer",
      answers: { "어떤 색이 좋아요?": "보라색", "넣을 것을 모두 골라 주세요": ["그림", "글"] },
    });
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
