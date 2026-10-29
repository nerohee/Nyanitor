import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { fakeClaude } from "../lib/fakeClaude";
import { fakeProjects } from "../lib/fakeProjects";
import { AppError, ipc, type ClaudeEvent } from "../lib/ipc";
import { buildAnswers, ruleNote } from "./LabCards";
import SessionLab from "./SessionLab";

/** 사용자가 하는 일 둘만 — 글 넣기와 누르기 (새 의존성 없이 testing-library 의 fireEvent 로) */
function setup() {
  return {
    type: (element: HTMLElement, text: string) => {
      fireEvent.change(element, { target: { value: text } });
      return Promise.resolve();
    },
    click: (element: HTMLElement) => {
      fireEvent.click(element);
      return Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  fakeClaude.reset();
  fakeProjects.reset();
  window.history.pushState({}, "", "/");
});

const PROJECT_LABEL = "프로젝트 (등록된 것 중에서)";

/** 등록된 프로젝트 목록이 뜬 뒤 하나를 고른다 (경로를 글자로 넣는 칸은 없다) */
async function pickProject(user: ReturnType<typeof setup>, name = "고양이 앨범") {
  const option = await screen.findByRole("option", { name });
  await user.type(screen.getByLabelText(PROJECT_LABEL), (option as HTMLOptionElement).value);
}

describe("buildAnswers", () => {
  const single = { question: "색?", header: null, multiSelect: false, options: [] };
  const multi = { question: "넣을 것?", header: null, multiSelect: true, options: [] };

  it("하나 고르기는 글 하나, 여러 개는 글 배열", () => {
    expect(
      buildAnswers([single, multi], [
        { picked: ["파랑"], writing: false, written: "" },
        { picked: ["그림", "표"], writing: false, written: "" },
      ]),
    ).toEqual({ "색?": "파랑", "넣을 것?": ["그림", "표"] });
  });

  it("직접 쓰기는 쓴 글 그대로 (하나 고르기에서는 고른 것을 대신한다)", () => {
    expect(
      buildAnswers([single, multi], [
        { picked: ["파랑"], writing: true, written: "  보라 " },
        { picked: ["그림"], writing: true, written: "내 생각" },
      ]),
    ).toEqual({ "색?": "보라", "넣을 것?": ["그림", "내 생각"] });
  });

  it("다 고르지 않았거나 직접 쓰기를 비워 두면 보낼 수 없다", () => {
    expect(buildAnswers([single], [{ picked: [], writing: false, written: "" }])).toBeNull();
    expect(buildAnswers([single], [{ picked: [], writing: true, written: "  " }])).toBeNull();
    expect(buildAnswers([multi], [{ picked: [], writing: false, written: "" }])).toBeNull();
    expect(buildAnswers([single, multi], [{ picked: ["a"], writing: false, written: "" }])).toBeNull();
  });
});

describe("ruleNote", () => {
  it("범위마다 무엇을 허용하는지 분명히 쓴다", () => {
    expect(ruleNote({ rule: "Edit(/README.md)", scope: "file", folder: null })).toContain("파일 하나");
    expect(ruleNote({ rule: "Edit(/README.md)", scope: "file", folder: null })).not.toContain("모든 파일");
    expect(ruleNote({ rule: "Edit(/src/**)", scope: "folder", folder: "src" })).toContain("src 폴더");
    expect(ruleNote({ rule: "Bash(ls *)", scope: "suggested", folder: null })).toContain("제안한 규칙");
  });
});

describe("SessionLab (브라우저 가짜 모드)", () => {
  async function startSession(user: ReturnType<typeof setup>) {
    await pickProject(user);
    await user.click(screen.getByRole("button", { name: "시작" }));
    await screen.findByText(/세션 시작/);
  }

  it("찾기 결과를 보인다", async () => {
    render(<SessionLab />);
    expect(await screen.findByText("C:\\fake\\claude.exe")).toBeInTheDocument();
    expect(screen.getByText(/확인된 버전과 같아요/)).toBeInTheDocument();
    expect(screen.getByText("claude.ai")).toBeInTheDocument();
    expect(screen.getByText("없어요")).toBeInTheDocument();
  });

  it("프로젝트를 고르고 시작하면 돌아가는 중이 되고, 고르기 전에는 시작 단추가 꺼져 있다", async () => {
    const user = setup();
    render(<SessionLab />);
    expect(await screen.findByRole("button", { name: "시작" })).toBeDisabled();
    await startSession(user);
    expect(screen.getByText(/돌아가는 중/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "끝내기" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "시작" })).toBeDisabled();
  });

  it("권한 카드: 항상 허용은 쓰일 규칙을 미리 보이고, 눌러 답하면 카드가 닫히고 턴이 끝난다", async () => {
    const user = setup();
    render(<SessionLab />);
    await startSession(user);
    await user.type(screen.getByLabelText("보낼 말"), "파일 쓰기 해 줘");
    await user.click(screen.getByRole("button", { name: "보내기" }));

    const card = await screen.findByRole("article", { name: "권한 요청" });
    expect(within(card).getByText("Edit(/src/**)")).toBeInTheDocument();
    expect(within(card).getByText(/src 폴더 안의 파일 쓰기를 허용해요/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "이 프로젝트에서 항상 허용" }));

    await screen.findByText(/턴 끝 — 성공/);
    expect(screen.queryByRole("article", { name: "권한 요청" })).not.toBeInTheDocument();
    expect(screen.getByText("답을 기다리는 카드가 없어요.")).toBeInTheDocument();
  });

  it("다르게 하라고 말하기: 글을 쓰기 전에는 보낼 수 없고, 보내면 중단됨 뒤 그 말이 새 메시지로 보인다", async () => {
    const user = setup();
    render(<SessionLab />);
    await startSession(user);
    await user.type(screen.getByLabelText("보낼 말"), "hello");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    const card = await screen.findByRole("article", { name: "권한 요청" });
    await user.click(within(card).getByRole("button", { name: "다르게 하라고 말하기" }));
    expect(within(card).getByRole("button", { name: "거부하고 보내기" })).toBeDisabled();
    await user.type(within(card).getByLabelText("대신 할 것"), "다른 방법으로");
    await user.click(within(card).getByRole("button", { name: "거부하고 보내기" }));

    await screen.findByText(/나 \(다르게 말하기\): 다른 방법으로/);
    expect(screen.getByText(/턴 끝 — 중단됨/)).toBeInTheDocument();
  });

  it("질문 카드: 다 고르기 전에는 답 보내기가 꺼져 있고, 하나 · 여러 개 · 직접 쓰기로 답하면 닫힌다", async () => {
    const user = setup();
    render(<SessionLab />);
    await startSession(user);
    await user.type(screen.getByLabelText("보낼 말"), "질문해 줘");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    const card = await screen.findByRole("article", { name: "질문" });
    const submit = within(card).getByRole("button", { name: "답 보내기" });
    expect(submit).toBeDisabled();

    await user.click(within(card).getByRole("radio", { name: /파랑/ }));
    expect(submit).toBeDisabled(); // 두 번째 질문이 남았다
    await user.click(within(card).getByRole("checkbox", { name: "그림" }));
    await user.click(within(card).getByRole("checkbox", { name: "표" }));
    expect(submit).toBeEnabled();

    // 직접 쓰기 — 글이 비면 다시 꺼진다
    const writeIns = within(card).getAllByRole("radio", { name: "직접 쓰기" });
    await user.click(writeIns[0]);
    expect(submit).toBeDisabled();
    await user.type(within(card).getByLabelText("직접 쓴 답"), "보라");
    expect(submit).toBeEnabled();
    await user.click(submit);

    await screen.findByText(/턴 끝 — 성공/);
    expect(screen.queryByRole("article", { name: "질문" })).not.toBeInTheDocument();
  });

  it("중단하면 기다리던 카드가 닫힌다", async () => {
    const user = setup();
    render(<SessionLab />);
    await startSession(user);
    await user.type(screen.getByLabelText("보낼 말"), "hello");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByRole("article", { name: "권한 요청" });
    await user.click(screen.getByRole("button", { name: "중단" }));
    await screen.findByText(/요청 취소됨/);
    expect(screen.queryByRole("article", { name: "권한 요청" })).not.toBeInTheDocument();
  });

  it("끝내기 뒤 같은 폴더에서 이어 하기를 할 수 있다", async () => {
    const user = setup();
    render(<SessionLab />);
    await startSession(user);
    expect(screen.getByRole("button", { name: "이어 하기" })).toBeDisabled(); // 아직 저장된 세션이 없다
    await user.type(screen.getByLabelText("보낼 말"), "hello");
    await user.click(screen.getByRole("button", { name: "보내기" }));
    await screen.findByRole("article", { name: "권한 요청" });
    await user.click(screen.getByRole("button", { name: "끝내기" }));
    await screen.findByText(/세션 끝 — 정상/);

    const resume = screen.getByRole("button", { name: "이어 하기" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350)); // 폴더의 마지막 세션을 다시 확인하는 시간
    });
    expect(resume).toBeEnabled();
    await user.click(resume);
    await screen.findByText(/이어 하기/, { selector: "li" });
  });

  it("명령이 실패하면 오류 종류에 맞는 문구를 알림으로 보인다", async () => {
    const user = setup();
    vi.spyOn(ipc, "claudeSessionStart").mockRejectedValueOnce(new AppError("claude_not_found", "claudes executable not found"));
    render(<SessionLab />);
    await pickProject(user);
    await user.click(screen.getByRole("button", { name: "시작" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("claude 를 찾지 못했어요");
  });

  it("이어 할 세션이 없다는 알림이 오면 새 세션으로 시작할지 묻고, 누르면 이어 하기 없이 시작한다", async () => {
    const user = setup();
    let emit: (event: ClaudeEvent) => void = () => {};
    vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => {});
    });
    const start = vi.spyOn(ipc, "claudeSessionStart");
    render(<SessionLab />);
    await pickProject(user);
    await screen.findByText("C:\\fake\\claude.exe");
    act(() => emit({ type: "resume_not_found", sessionId: "old-session" }));

    expect(await screen.findByText(/이어 할 세션이 claude 에 없어요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "새 세션으로 시작" }));
    // 보내는 것은 프로젝트 번호뿐이다 — 경로 · 모델 · 수준은 없다
    expect(start).toHaveBeenCalledWith({ projectId: 1, resume: false, useApiKey: false });
    await waitFor(() => expect(screen.queryByText(/이어 할 세션이 claude 에 없어요/)).not.toBeInTheDocument());
  });

  it("시작하면 하네스 planner 설정으로 쓴 모델 · 수준을 보인다 (opus · high)", async () => {
    const user = setup();
    render(<SessionLab />);
    expect(screen.getByText("모델 · 수준 (하네스 planner 설정)").nextElementSibling).toHaveTextContent("—");
    await startSession(user);
    expect(screen.getByText("모델 · 수준 (하네스 planner 설정)").nextElementSibling).toHaveTextContent("opus · high");
    expect(screen.getByText(/세션 시작 — 프로젝트 1 · 폴더 C:\\dev\\cat-album .* · 모델 opus · 수준 high/)).toBeInTheDocument();
  });

  it("planner 설정을 못 읽으면 CLI 기본으로 시작하고 알림 줄이 남는다", async () => {
    const user = setup();
    fakeClaude.reset({ planner: "missing" });
    render(<SessionLab />);
    await startSession(user);
    expect(screen.getByText("모델 · 수준 (하네스 planner 설정)").nextElementSibling).toHaveTextContent("CLI 기본 · CLI 기본");
    expect(await screen.findByText(/경고 planner_config_missing/)).toBeInTheDocument();
  });

  it("시작할 때 보내는 것은 프로젝트 번호 · 이어 하기 · API 키 여부뿐이다 (경로 · 모델 · 수준은 없다)", async () => {
    const user = setup();
    const start = vi.spyOn(ipc, "claudeSessionStart");
    render(<SessionLab />);
    await pickProject(user, "레시피 상자");
    await user.click(screen.getByRole("button", { name: "시작" }));
    await screen.findByText(/세션 시작/);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ projectId: 2, resume: false, useApiKey: false });
    expect(Object.keys(start.mock.calls[0]?.[0] ?? {}).sort()).toEqual(["projectId", "resume", "useApiKey"]);
    // 경로를 글자로 넣는 입력 칸도 없다
    expect(screen.queryByLabelText(/전체 경로/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^모델/)).not.toBeInTheDocument();
  });

  it("폴더가 없어진 프로젝트는 목록에 그렇게 보이고, 시작하면 폴더를 찾을 수 없다는 알림이 난다", async () => {
    const user = setup();
    render(<SessionLab />);
    await pickProject(user, "쇼핑몰 관리자 (폴더를 찾을 수 없음)");
    await user.click(screen.getByRole("button", { name: "시작" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("폴더를 찾을 수 없어요");
    expect(screen.getByRole("button", { name: "끝내기" })).toBeDisabled(); // 세션이 뜨지 않았다
  });

  it("등록된 프로젝트가 없으면 먼저 등록하라는 한 줄이 보이고, 폴더를 골라 등록하면 그 프로젝트가 골라진다", async () => {
    const user = setup();
    fakeProjects.reset({ projects: "none" });
    render(<SessionLab />);
    expect(await screen.findByText("먼저 프로젝트를 등록해 주세요.")).toBeInTheDocument();
    expect(screen.getByLabelText(PROJECT_LABEL)).toBeDisabled();
    expect(screen.getByRole("button", { name: "시작" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "폴더를 골라 프로젝트로 등록" }));
    await waitFor(() => expect(screen.queryByText("먼저 프로젝트를 등록해 주세요.")).not.toBeInTheDocument());
    // 가짜 폴더 고르기는 `C:\dev\cat-diary` — 폴더 이름이 프로젝트 이름이 된다
    expect(await screen.findByRole("option", { name: "cat-diary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "시작" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "시작" }));
    await screen.findByText(/세션 시작 — 프로젝트 5/);
  });

  it("폴더 고르기를 취소하면 아무것도 바뀌지 않고, 고를 수 없는 폴더면 이유를 알리고 등록하지 않는다", async () => {
    const user = setup();
    fakeProjects.reset({ projects: "none", pick: "cancel" });
    render(<SessionLab />);
    await user.click(await screen.findByRole("button", { name: "폴더를 골라 프로젝트로 등록" }));
    // 창이 닫히길(취소 결과가 처리되길) 기다린다 — 그동안 단추는 꺼져 있다
    await waitFor(() => expect(screen.getByRole("button", { name: "폴더를 골라 프로젝트로 등록" })).toBeEnabled());
    expect(screen.getByText("먼저 프로젝트를 등록해 주세요.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fakeProjects.reset({ projects: "none", pick: "home" });
    await user.click(screen.getByRole("button", { name: "폴더를 골라 프로젝트로 등록" }));
    expect(await screen.findByText(/그 폴더는 프로젝트로 쓸 수 없어요 \(home\)/)).toBeInTheDocument();
    expect(screen.getByText("먼저 프로젝트를 등록해 주세요.")).toBeInTheDocument();
  });

  it("앱 데이터베이스를 못 쓰면 프로젝트를 못 불렀다는 알림을 보이고 시작할 수 없다", async () => {
    fakeProjects.reset({ db: "unavailable" });
    render(<SessionLab />);
    expect(await screen.findByRole("alert")).toHaveTextContent("앱 데이터베이스를 쓸 수 없어요");
    expect(screen.getByRole("button", { name: "시작" })).toBeDisabled();
  });

  it("개발 빌드에서 ?lab=session 이면 App 이 시험 화면을 보인다", async () => {
    window.history.pushState({}, "", "/?lab=session");
    render(<App />);
    expect(await screen.findByTestId("session-lab")).toBeInTheDocument();
  });

  it("쿼리가 없으면 시험 화면이 아니라 기본 화면이고, 개발 빌드에는 시험 화면으로 가는 링크가 있다", async () => {
    render(<App />);
    expect(await screen.findByText("Nyanitor")).toBeInTheDocument();
    expect(screen.queryByTestId("session-lab")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /시험 화면 열기/ })).toHaveAttribute("href", "?lab=session");
  });
});
