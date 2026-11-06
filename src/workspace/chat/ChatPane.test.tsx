// 채팅 판 (가짜 세션) — 빈 상태 → 시작 단추 → 먹물 글 · 질문 · 단계 승인 · 권한 카드에 답하기(키보드), 답한 카드는 접힘, 중단 · 세션 끝내기,
// 다른 프로젝트에서 도는 중, 이어 하기 · 새 대화, 준비 안 됨, 기록(`?history=full`) · 이전 쪽 · 지나간 카드, 세션 츄르, 화면을 다시 그릴 때.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../../lib/fakeClaude";
import { fakeHistory, type FakeHistoryMode } from "../../lib/fakeHistory";
import { fakeProjects } from "../../lib/fakeProjects";
import { fakeSkills } from "../../lib/fakeSkills";
import { ipc } from "../../lib/ipc";
import { AppError, type ClaudeEvent, type ClaudeStatus, type ProjectEntry } from "../../lib/ipc-types";
import { ChatPane } from "./ChatPane";
import { resetSessionStore, startSessionStore, useSessionStore } from "./sessionStore";

function projectsList(): ProjectEntry[] {
  return (fakeProjects.handlers.projects_list({}) as { projects: ProjectEntry[] }).projects;
}
const project = (id: number): ProjectEntry => {
  const found = projectsList().find((entry) => entry.id === id);
  if (!found) throw new Error(`no fake project ${id}`);
  return found;
};

function reset(history: FakeHistoryMode = "empty") {
  resetSessionStore();
  fakeClaude.reset();
  fakeProjects.reset();
  fakeHistory.reset(history);
  fakeSkills.reset();
}

beforeEach(() => reset());
afterEach(() => {
  vi.restoreAllMocks();
  reset();
});

async function mount(id = 1, options: { onGoProject?: (id: number) => void } = {}) {
  await startSessionStore();
  const onGoProject = options.onGoProject ?? vi.fn();
  const view = render(<ChatPane key={id} project={project(id)} projects={projectsList()} onGoProject={onGoProject} />);
  return { ...view, onGoProject };
}

const input = () => screen.getByRole("textbox", { name: "보낼 말" });

async function say(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: "Enter" });
}

describe("시작", () => {
  it("대화가 없으면 빈 상태 — 프로젝트 스킬로 시작 단추 → 세션이 시작되고 먹물 글 · 권한 카드가 온다", async () => {
    await mount(1);
    expect(await screen.findByText("요구사항을 쓰고 시작해요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "/desktop-app requirements.md 로 시작" }));
    // 보낸 말 · 먹물 글 · 권한 카드(가짜 대본: 그 밖의 말은 명령 권한)
    expect(await screen.findByText("/desktop-app requirements.md")).toBeInTheDocument();
    expect(await screen.findByText("가짜 Claude 예요. 정해진 대본대로만 움직여요.")).toBeInTheDocument();
    const card = await screen.findByRole("article", { name: "권한 요청" });
    expect(card).toHaveAttribute("data-pending", "true");
    expect(screen.getByText("답을 기다리는 중", { selector: ".wc-head__pill" })).toBeInTheDocument();
    // 머리: 모델 · 수준(돌려받은 값) · 세션 츄르 · 세션 끝내기
    expect(screen.getByText("opus · high")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/츄르 약/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "세션 끝내기" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "기다리는 카드로 (1)" })).toBeInTheDocument();
  });

  it("프로젝트에 스킬이 없으면 스킬 고르기부터 — 단추가 스킬 고르기를 연다", async () => {
    fakeProjects.handlers.project_update({ id: 1, patch: { skill: null } });
    await mount(1);
    fireEvent.click(await screen.findByRole("button", { name: "스킬 고르기" }));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(input()).toHaveValue("/desktop-app ");
  });

  it("시작이 실패하면(폴더 없음) 한 줄 — 입력은 막지 않는다", async () => {
    vi.spyOn(ipc, "claudeSessionStart").mockRejectedValue(new AppError("project_folder_missing", "x"));
    await mount(1);
    fireEvent.click(await screen.findByRole("button", { name: "/desktop-app requirements.md 로 시작" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("프로젝트 폴더를 찾을 수 없어요.");
    expect(screen.getByRole("textbox", { name: "보낼 말" })).toBeInTheDocument();
  });

  it("폴더가 없어진 프로젝트는 입력줄 대신 한 줄 — 시작 단추도 막힌다", async () => {
    await mount(3);
    expect(await screen.findByText("프로젝트 폴더를 찾을 수 없어서 대화를 시작할 수 없어요.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "보낼 말" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /로 시작/ })).toBeDisabled();
  });
});

describe("카드에 답하기 (키보드)", () => {
  it("질문 → 고르고 Enter → 접혀서 고른 답이 보이고, 턴이 끝나면 쉬는 중", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("질문 하나 해 줘");
    const card = await screen.findByRole("article", { name: "질문" });
    expect(within(card).getByText("어떤 색이 좋아요?")).toBeInTheDocument();
    const radio = within(card).getByRole("radio", { name: /초록/ });
    radio.focus();
    fireEvent.click(radio);
    fireEvent.click(within(card).getByRole("checkbox", { name: /그림/ }));
    fireEvent.keyDown(radio, { key: "Enter" });
    // 접힘: 단추 · 선택지 없음, 고른 답
    await waitFor(() => expect(within(screen.getByRole("article", { name: "질문" })).getByText("초록")).toBeInTheDocument());
    const done = screen.getByRole("article", { name: "질문" });
    expect(within(done).queryByRole("radio")).not.toBeInTheDocument();
    expect(done).toHaveAttribute("data-status", "answered");
    expect(within(done).getByText("그림")).toBeInTheDocument();
    expect(await screen.findByText("답을 받았어요.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("쉬는 중", { selector: ".wc-head__pill" })).toBeInTheDocument());
  });

  it("단계 승인 — 네 칸 카드에서 승인", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("계획을 보여 주고 승인 받아 줘");
    const card = await screen.findByRole("article", { name: "승인 요청" });
    expect(within(card).getByText("앱에서 하네스를 받아 설치하고 원본 업데이트를 미리 본다")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "승인" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "승인 요청" })).toHaveAttribute("data-status", "answered"));
    expect(screen.getByText("승인함")).toBeInTheDocument();
  });

  it("권한 — 이번만 허용 → 접힌 결과 한 줄", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("폴더를 만들어 줘");
    const card = await screen.findByRole("article", { name: "권한 요청" });
    expect(within(card).getByText("mkdir demo", { selector: "pre code" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "이번만 허용" }));
    await waitFor(() => expect(screen.getByText("이번만 허용함")).toBeInTheDocument());
    expect(await screen.findByText("끝났어요.")).toBeInTheDocument();
  });

  it("권한 — 항상 허용 · 다르게 하라고 말하기(중단 줄 + 말이 새 메시지로)", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("쓰기 해 줘");
    let card = await screen.findByRole("article", { name: "권한 요청" });
    fireEvent.click(within(card).getByRole("button", { name: "이 프로젝트에서 항상 허용" }));
    await waitFor(() => expect(screen.getByText("이 프로젝트에서 항상 허용함")).toBeInTheDocument());
    await screen.findByText("끝났어요.");
    await say("명령 하나 돌려 줘");
    await waitFor(() => expect(screen.getAllByRole("article", { name: "권한 요청" }).some((el) => el.getAttribute("data-pending") === "true")).toBe(true));
    card = screen.getAllByRole("article", { name: "권한 요청" }).find((el) => el.getAttribute("data-pending") === "true") as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "다르게 하라고 말하기" }));
    fireEvent.change(within(card).getByRole("textbox", { name: "거부하는 이유 · 대신 할 것" }), { target: { value: "라이브러리 없이 해 줘" } });
    fireEvent.click(within(card).getByRole("button", { name: "거부하고 보내기" }));
    expect(await screen.findByText("다르게 하라고 말했어요: 라이브러리 없이 해 줘")).toBeInTheDocument();
    // 중단된 턴(중단 줄) 뒤에 그 말이 새 사용자 말로 간다
    expect(await screen.findByText("중단했어요")).toBeInTheDocument();
    expect(await screen.findByText("중단한 뒤 전해졌어요")).toBeInTheDocument();
  });

  it("새 카드가 와도 입력줄의 초점을 빼앗지 않는다", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    input().focus();
    fireEvent.change(input(), { target: { value: "질문 해 줘" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await screen.findByRole("article", { name: "질문" });
    expect(document.activeElement?.closest("article")).toBeNull();
  });
});

describe("중단 · 끝내기", () => {
  it("중단 → 확인 → 기다리던 카드가 취소됨으로, 중단 줄이 생긴다", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("폴더를 만들어 줘");
    const card = await screen.findByRole("article", { name: "권한 요청" });
    fireEvent.click(screen.getByRole("button", { name: "중단" }));
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    await waitFor(() => expect(card).toHaveAttribute("data-status", "cancelled"));
    expect(within(card).getByText("중단했거나 세션이 끝나서 취소됐어요.")).toBeInTheDocument();
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    expect(await screen.findByText("중단했어요")).toBeInTheDocument();
  });

  it("세션 끝내기 → 확인 한 번 → 세션이 끝난다 (머리의 끝내기 · 모델 · 츄르가 사라진다)", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("안녕");
    await screen.findByRole("article", { name: "권한 요청" });
    fireEvent.click(screen.getByRole("button", { name: "세션 끝내기" }));
    const dialog = screen.getByRole("alertdialog", { name: "이 세션을 끝낼까요?" });
    expect(within(dialog).getByRole("button", { name: "세션 끝내기" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "세션 끝내기" }));
    await waitFor(() => expect(useSessionStore.getState().session).toBeNull());
    await waitFor(() => expect(screen.queryByRole("button", { name: "세션 끝내기" })).not.toBeInTheDocument());
    expect(screen.queryByText("opus · high")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "권한 요청" })).toHaveAttribute("data-status", "cancelled");
  });

  it("끝내기 확인에서 Esc · 계속 두기는 세션을 그대로 둔다", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("안녕");
    await screen.findByRole("article", { name: "권한 요청" });
    fireEvent.click(screen.getByRole("button", { name: "세션 끝내기" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(useSessionStore.getState().session).not.toBeNull();
  });
});

describe("다른 프로젝트에서 도는 중", () => {
  async function runningElsewhere() {
    await startSessionStore();
    await ipc.claudeSessionStart({ projectId: 2 });
    await waitFor(() => expect(useSessionStore.getState().session?.projectId).toBe(2));
  }

  it("입력줄 대신 이유 + 그 프로젝트로 가기 · 그 세션 끝내고 여기서 시작", async () => {
    await runningElsewhere();
    const { onGoProject } = await mount(1);
    expect(await screen.findByText("지금 「레시피 상자」에서 먹물이 일하는 중이에요")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "보낼 말" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "세션 끝내기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "/desktop-app requirements.md 로 시작" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "그 프로젝트로 가기" }));
    expect(onGoProject).toHaveBeenCalledWith(2);
  });

  it("그 세션 끝내고 여기서 시작 — 확인 한 번 뒤에 끝내고 이 프로젝트에서 시작한다", async () => {
    await runningElsewhere();
    await mount(1);
    fireEvent.click(await screen.findByRole("button", { name: "그 세션 끝내고 여기서 시작" }));
    const dialog = screen.getByRole("alertdialog", { name: "그 세션을 끝내고 여기서 시작할까요?" });
    expect(useSessionStore.getState().session?.projectId).toBe(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "끝내고 여기서 시작" }));
    await waitFor(() => expect(useSessionStore.getState().session?.projectId).toBe(1));
    expect(await screen.findByRole("textbox", { name: "보낼 말" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "세션 끝내기" })).toBeInTheDocument();
  });

  it("확인에서 그대로 두면 아무것도 끝나지 않는다", async () => {
    await runningElsewhere();
    await mount(1);
    fireEvent.click(await screen.findByRole("button", { name: "그 세션 끝내고 여기서 시작" }));
    fireEvent.click(screen.getByRole("button", { name: "그대로 두기" }));
    expect(useSessionStore.getState().session?.projectId).toBe(2);
    expect(screen.getByRole("button", { name: "그 프로젝트로 가기" })).toBeInTheDocument();
  });

  it("그 프로젝트 채팅은 입력줄이 열려 있고 먹물 상태가 '쉬는 중' 이 아니라 세션 정보가 보인다", async () => {
    await runningElsewhere();
    await mount(2);
    expect(await screen.findByRole("textbox", { name: "보낼 말" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "세션 끝내기" })).toBeInTheDocument();
  });
});

describe("이어 하기", () => {
  it("끝난 대화가 있으면 머리에 '새 대화로 시작' — 그냥 보내면 이어 하기(resume)로 시작한다", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("안녕");
    await screen.findByRole("article", { name: "권한 요청" });
    await act(async () => {
      await ipc.claudeSessionStop();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "새 대화로 시작" })).toBeInTheDocument());
    const start = vi.spyOn(ipc, "claudeSessionStart");
    await say("이어서 해 줘");
    await waitFor(() => expect(start).toHaveBeenCalledWith({ projectId: 1, resume: true }));
  });

  it("새 대화로 시작은 이어 하지 않고(resume: false) 세션만 시작한다", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("안녕");
    await screen.findByRole("article", { name: "권한 요청" });
    await act(async () => {
      await ipc.claudeSessionStop();
    });
    const start = vi.spyOn(ipc, "claudeSessionStart");
    fireEvent.click(await screen.findByRole("button", { name: "새 대화로 시작" }));
    await waitFor(() => expect(start).toHaveBeenCalledWith({ projectId: 1, resume: false }));
    await waitFor(() => expect(useSessionStore.getState().session?.projectId).toBe(1));
  });
});

describe("준비 안 됨", () => {
  const status = (patch: Partial<ClaudeStatus>): ClaudeStatus => ({
    found: true,
    path: "C:\\claude.exe",
    version: "2.1.296",
    knownVersion: "2.1.296",
    versionMatches: true,
    loggedIn: true,
    authMethod: null,
    subscriptionType: null,
    apiKeyPresent: false,
    otherBilling: [],
    problem: null,
    ...patch,
  });

  it("Claude 가 없으면 입력줄 대신 한 줄 + 다시 확인", async () => {
    const discover = vi.spyOn(ipc, "claudeDiscover").mockResolvedValue(status({ found: false, path: null }));
    await mount(1);
    expect(await screen.findByText("Claude Code 를 찾을 수 없어요. 설치한 뒤 다시 확인해 주세요.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "보낼 말" })).not.toBeInTheDocument();
    discover.mockResolvedValue(status({}));
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    expect(await screen.findByRole("textbox", { name: "보낼 말" })).toBeInTheDocument();
  });

  it("로그인 안 됨이면 한 줄 + 로그인 단추(claudeOpenLogin)", async () => {
    vi.spyOn(ipc, "claudeDiscover").mockResolvedValue(status({ loggedIn: false }));
    const login = vi.spyOn(ipc, "claudeOpenLogin").mockResolvedValue(undefined);
    await mount(1);
    expect(await screen.findByText("Claude Code 에 로그인되어 있지 않아요.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "보낼 말" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("확인 자체를 못 했거나 로그인 여부를 모르면 막지 않는다", async () => {
    vi.spyOn(ipc, "claudeDiscover").mockResolvedValue(status({ loggedIn: null }));
    await mount(1);
    expect(await screen.findByRole("textbox", { name: "보낼 말" })).toBeInTheDocument();
  });
});

describe("기록", () => {
  it("?history=full — 지난 대화가 보이고 이전 대화 더 보기로 앞쪽을 읽는다", async () => {
    reset("full");
    await mount(1);
    expect(await screen.findByText("계획을 정리했어요. 승인해 주세요.")).toBeInTheDocument();
    expect(screen.queryByText(/옛 대화 1 —/)).not.toBeInTheDocument();
    const older = screen.getByRole("button", { name: "이전 대화 더 보기" });
    fireEvent.click(older);
    await waitFor(() => expect(screen.getByText(/옛 대화 1 — 목록 간격/)).toBeInTheDocument());
    // 다 읽으면 단추가 사라진다
    await waitFor(() => expect(screen.queryByRole("button", { name: "이전 대화 더 보기" })).not.toBeInTheDocument());
  });

  it("기록의 카드 — 답한 것은 접혀 있고, 지나간 · 취소된 카드는 답할 수 없다", async () => {
    reset("full");
    await mount(1);
    await screen.findByText("계획을 정리했어요. 승인해 주세요.");
    const articles = screen.getAllByRole("article");
    const expired = articles.filter((el) => el.getAttribute("data-status") === "expired");
    const cancelled = articles.filter((el) => el.getAttribute("data-status") === "cancelled");
    const answered = articles.filter((el) => el.getAttribute("data-status") === "answered");
    expect(expired).toHaveLength(2);
    expect(cancelled).toHaveLength(1);
    expect(answered.length).toBeGreaterThanOrEqual(5);
    for (const card of [...expired, ...cancelled]) {
      expect(within(card).queryByRole("button")).not.toBeInTheDocument();
      expect(within(card).queryByRole("radio")).not.toBeInTheDocument();
    }
    expect(screen.getAllByText("앱을 다시 켜서 답할 수 없어요.").length).toBe(2);
    // 답한 권한 카드: 도구 입력은 기록에 없다 (D-48)
    expect(screen.queryByText("도구 입력 보기")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이번만 허용" })).not.toBeInTheDocument();
    // 지난 세션이 갑자기 멈췄으니 먹물 상태는 멈춤
    expect(screen.getByText("멈춤", { selector: ".wc-head__pill" })).toBeInTheDocument();
  });

  it("기록의 알림 줄 — 이어 할 대화 없음 · 한도 · 먹물이 갑자기 멈춤 · 실패한 도구 · 중단", async () => {
    reset("full");
    await mount(1);
    await screen.findByText("계획을 정리했어요. 승인해 주세요.");
    expect(screen.getByText("이어 할 대화를 찾지 못했어요")).toBeInTheDocument();
    expect(screen.getByText(/5시간 사용 한도가 가까워요 \(86%\)/)).toBeInTheDocument();
    expect(screen.getAllByText("먹물이 갑자기 멈췄어요").length).toBeGreaterThan(0);
    // 실패한 도구 결과는 기록에 글 없이 저장된다 (D-48) — 줄은 남고 글만 비어 있다
    const failed = screen.getByText(/도구가 실패했어요/);
    expect(failed).toBeInTheDocument();
    // 글이 비었으니 끝 대시 없이 "도구가 실패했어요" 만
    expect(failed.textContent).toBe("도구가 실패했어요");
    // 지난 일을 지금 일처럼 읽지 않는다 — 기록에서 그린 줄에는 alert · status 역할이 없다
    expect(failed.closest(".wc-toolerr")).not.toHaveAttribute("role");
    expect(document.querySelectorAll(".wc-note[role], .wc-toolerr[role]")).toHaveLength(0);
    expect(screen.getAllByText("중단했어요").length).toBeGreaterThan(0);
    expect(screen.getByText("사용 한도에 닿아 멈췄어요")).toBeInTheDocument();
  });

  it("기록을 읽지 못하면 한 줄 + 다시 시도", async () => {
    const read = vi.spyOn(ipc, "projectChatHistory").mockRejectedValueOnce(new AppError("db_unavailable", "x")).mockResolvedValue({ entries: [], hasMore: false });
    await mount(1);
    expect(await screen.findByText("대화 기록을 읽지 못했어요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    expect(await screen.findByText("요구사항을 쓰고 시작해요")).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("세션 츄르", () => {
  const chip = () => document.querySelector(".wc-head__chip:not(.wc-head__chip--mono)")?.textContent ?? "";

  it("턴이 끝날 때마다 바뀐다 — 구독이면 참고용 표시가 붙는다", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("폴더를 만들어 줘");
    const card = await screen.findByRole("article", { name: "권한 요청" });
    await waitFor(() => expect(chip()).toContain("츄르 약 0"));
    fireEvent.click(within(card).getByRole("button", { name: "이번만 허용" }));
    // 가짜 턴 하나 = 토큰 1245
    await waitFor(() => expect(chip()).toContain("츄르 약 1,245"));
    expect(chip()).toContain("참고용");
    // 한 턴 더 → 또 바뀐다
    await screen.findByText("끝났어요.");
    await say("명령 하나 더");
    const next = await waitFor(() => {
      const el = document.querySelector('[data-pending="true"]');
      if (!el) throw new Error("no pending card");
      return el as HTMLElement;
    });
    fireEvent.click(within(next).getByRole("button", { name: "이번만 허용" }));
    await waitFor(() => expect(chip()).toContain("츄르 약 2,490"));
  });

  it("?history=apikey — 키로 과금된 턴이면 참고용 표시가 없다", async () => {
    reset("apikey");
    await mount(1);
    await screen.findByText("계획을 정리했어요. 승인해 주세요.");
    await say("안녕");
    const next = await waitFor(() => {
      const el = document.querySelector('[data-pending="true"]');
      if (!el) throw new Error("no pending card");
      return el as HTMLElement;
    });
    fireEvent.click(within(next).getByRole("button", { name: "이번만 허용" }));
    await waitFor(() => expect(chip()).toContain("츄르 약 1,245"));
    expect(document.querySelector(".wc-head__ref")).toBeNull();
  });
});

describe("화면을 다시 그릴 때", () => {
  it("다른 프로젝트를 갔다 와도(판을 다시 그려도) 대화 · 기다리는 카드가 그대로다 — 세션은 계속 돈다", async () => {
    const { unmount } = await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("질문 해 줘");
    await screen.findByRole("article", { name: "질문" });
    unmount();
    // 고양이 집에 갔다 온 것처럼 새로 그린다 (저장소는 앱 전체에 하나)
    render(<ChatPane project={project(1)} projects={projectsList()} onGoProject={() => undefined} />);
    const card = await screen.findByRole("article", { name: "질문" });
    expect(card).toHaveAttribute("data-pending", "true");
    expect(screen.getByText("질문 해 줘")).toBeInTheDocument();
    expect(useSessionStore.getState().session?.projectId).toBe(1);
    expect(screen.getByText("답을 기다리는 중", { selector: ".wc-head__pill" })).toBeInTheDocument();
  });

  it("앱이 다시 그려져 저장소를 처음부터 시작해도 지금 세션 · 기다리는 카드를 되살린다 (claudeSessionState)", async () => {
    const first = await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("질문 해 줘");
    await screen.findByRole("article", { name: "질문" });
    first.unmount();
    resetSessionStore();
    // 가짜 세션은 그대로 돌고 있다
    await mount(1);
    const card = await screen.findByRole("article", { name: "질문" });
    expect(card).toHaveAttribute("data-pending", "true");
    expect(screen.getByText("답을 기다리는 중", { selector: ".wc-head__pill" })).toBeInTheDocument();
    // 되살린 카드에도 답할 수 있다
    fireEvent.click(within(card).getAllByRole("radio")[0]!);
    fireEvent.click(within(card).getAllByRole("checkbox")[0]!);
    fireEvent.click(within(card).getByRole("button", { name: "답 보내기" }));
    await waitFor(() => expect(screen.getByRole("article", { name: "질문" })).toHaveAttribute("data-status", "answered"));
  });
});

describe("목록", () => {
  it("새 글이 오면 맨 아래에 붙는다 — 위를 보고 있으면 끌어내리지 않고 '새 글 n' 단추", async () => {
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    await say("안녕");
    await screen.findByRole("article", { name: "권한 요청" });
    const log = screen.getByTestId("chat-log");
    let top = 0;
    Object.defineProperty(log, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(log, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(log, "scrollTop", { configurable: true, get: () => top, set: (value: number) => (top = value) });
    // 위로 올려 본다
    top = 0;
    fireEvent.scroll(log);
    act(() => {
      useSessionStore.setState((state) => state);
    });
    fireEvent.click(screen.getByRole("button", { name: "이번만 허용" }));
    await screen.findByText("끝났어요.");
    const button = await screen.findByRole("button", { name: /새 글 \d/ });
    expect(top).toBe(0);
    fireEvent.click(button);
    expect(top).toBe(1000);
    expect(screen.queryByRole("button", { name: /새 글 \d/ })).not.toBeInTheDocument();
  });

  it("실시간 줄 — 실패한 도구는 글이 있으면 그대로 · 없으면 대시 없이, 알림 역할을 단다", async () => {
    let emit: (event: ClaudeEvent) => void = () => undefined;
    vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    });
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    act(() => {
      emit({ type: "session_started", projectId: 1, projectDir: "C:\\dev\\cat-album", pid: 1, resumed: false, resumeSessionId: null, cliVersion: null, model: null, effort: null });
      emit({ type: "tool_result", toolUseId: "a", isError: true, summary: "권한이 없어요" });
      emit({ type: "tool_result", toolUseId: "b", isError: true, summary: "" });
    });
    const withText = await screen.findByText("도구가 실패했어요 — 권한이 없어요");
    expect(withText.closest(".wc-toolerr")).toHaveAttribute("role", "status");
    const bare = screen.getByText("도구가 실패했어요");
    expect(bare.closest(".wc-toolerr")).toHaveAttribute("role", "status");
  });

  it("도구 사용이 이어지면 접는다 — 펼쳐서 볼 수 있다", async () => {
    // 가짜 세션은 정해진 대본만 돌리므로 이 시험은 이벤트를 직접 흘린다
    let emit: (event: ClaudeEvent) => void = () => undefined;
    vi.spyOn(ipc, "onClaudeEvent").mockImplementation((handler) => {
      emit = handler;
      return Promise.resolve(() => undefined);
    });
    await mount(1);
    await screen.findByText("요구사항을 쓰고 시작해요");
    act(() => {
      emit({ type: "session_started", projectId: 1, projectDir: "C:\\dev\\cat-album", pid: 1, resumed: false, resumeSessionId: null, cliVersion: null, model: null, effort: null });
      for (const n of [1, 2, 3, 4]) emit({ type: "tool_use", toolUseId: `t${n}`, tool: "Read", summary: `file${n}.md` });
    });
    const toggle = await screen.findByRole("button", { name: "도구 4개 사용" });
    expect(screen.queryByText("file1.md")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText("file1.md")).toBeInTheDocument();
    expect(screen.getByText("file4.md")).toBeInTheDocument();
    // 모델 · 수준을 못 받았으면(null) "기본"
    expect(screen.getByText("기본", { selector: ".wc-head__chip--mono" })).toBeInTheDocument();
  });
});
