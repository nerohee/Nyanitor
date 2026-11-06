// 실제 작업 공간 화면 시험 (가짜 모드) — 프로젝트 목록(넓은 창 · 좁은 창) · 없음 · 폴더 없음 · DB 읽기 전용 / 못 씀 ·
// 새 프로젝트 대화상자(폴더 고르기 → 살펴본 결과 · 이름 · 스킬 → 추가 / 고를 수 없음 / 이미 있음 / 취소 / 오류 / 포커스) ·
// 프로젝트 설정(이름 · 스킬 · 빼기).
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../lib/fakeClaude";
import { fakeHistory } from "../lib/fakeHistory";
import { fakeProjects, type FakeProjectsOptions } from "../lib/fakeProjects";
import { fakeSkills } from "../lib/fakeSkills";
import { ipc } from "../lib/ipc";
import { AppError } from "../lib/ipc-types";
import { resetSessionStore, stopSession } from "./chat/sessionStore";
import Workspace from "./Workspace";

/** 앱(App)이 하듯 고른 프로젝트를 들고 있는 틀 */
function Harness({ initial = null, openNew = false, onGo }: { initial?: number | null; openNew?: boolean; onGo?: (place: string) => void }) {
  const [id, setId] = useState<number | null>(initial);
  return <Workspace projectId={id} onSelect={setId} onGo={onGo ?? (() => undefined)} openNew={openNew} />;
}

function setWide(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide && query.includes("1280"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  fakeProjects.reset();
  fakeSkills.reset();
  fakeClaude.reset();
  fakeHistory.reset();
  resetSessionStore();
  setWide(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetSessionStore();
  fakeProjects.reset();
  fakeSkills.reset();
  fakeClaude.reset();
  fakeHistory.reset();
  // @ts-expect-error jsdom 에는 matchMedia 가 없다 — 시험이 넣은 것을 지운다
  delete window.matchMedia;
});

async function mount(options?: Partial<FakeProjectsOptions>, props?: Parameters<typeof Harness>[0]) {
  fakeProjects.reset(options);
  const rendered = render(<Harness {...props} />);
  await waitFor(() => expect(screen.queryByText("프로젝트를 불러오는 중…")).not.toBeInTheDocument());
  return rendered;
}

function list() {
  return screen.getByRole("navigation", { name: "프로젝트" });
}

function names(): string[] {
  return within(list())
    .getAllByRole("button")
    .filter((b) => b.classList.contains("ws-proj__item"))
    .map((b) => b.querySelector(".ws-proj__name")?.textContent ?? "");
}

function openedDialog() {
  return screen.getByRole("dialog");
}

describe("프로젝트 목록", () => {
  it("넓은 창 — 목록 | [채팅 · 요구사항] 탭 판 자리 (처음엔 채팅), 가장 최근 프로젝트가 열려 있다 (최근에 연 때를 적는다)", async () => {
    const touch = vi.spyOn(ipc, "projectTouch");
    await mount();
    expect(names()).toEqual(["고양이 앨범", "레시피 상자", "쇼핑몰 관리자", "빵집 예약"]);
    const current = within(list()).getByRole("button", { current: "page" });
    expect(current).toHaveTextContent("고양이 앨범");
    // 이름 · 스킬 · 경로
    expect(current).toHaveTextContent("/desktop-app");
    expect(current).toHaveTextContent("C:\\dev\\cat-album");
    expect(screen.getByRole("heading", { level: 2, name: "고양이 앨범" })).toBeInTheDocument();
    // 폴더 없음 표시
    expect(within(list()).getByRole("button", { name: /쇼핑몰 관리자/ })).toHaveTextContent("폴더를 찾을 수 없어요");

    // 창이 넓어도 판 하나에 탭 [채팅] [요구사항] — 처음엔 채팅, 요구사항은 숨겨졌을 뿐 마운트돼 있다
    const [chatTab, editorTab] = within(screen.getByRole("tablist", { name: "작업 공간 보기" })).getAllByRole("tab");
    expect(chatTab).toHaveTextContent("채팅");
    expect(editorTab).toHaveTextContent("요구사항");
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tabpanel", { name: "요구사항" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tabpanel", { name: "채팅" })).toHaveTextContent("이전 대화 더 보기"));
    expect(screen.queryByRole("button", { name: "요구사항 칸 접기" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("우리 집 고양이 사진"));
    expect(touch).toHaveBeenCalledWith(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("작업 공간");
  });

  it("다른 프로젝트를 고르면 그 프로젝트가 열린다 — 쓰던 글은 저장하고 떠난다", async () => {
    const touch = vi.spyOn(ipc, "projectTouch");
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    await mount();
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) as EditorView;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "고치던 글" }, userEvent: "input.type" });

    fireEvent.click(within(list()).getByRole("button", { name: /레시피 상자/ }));
    await waitFor(() => expect(touch).toHaveBeenCalledWith(2));
    expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("레시피 상자");
    expect(screen.getByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
    await waitFor(() => expect(write).toHaveBeenCalledWith(1, "고치던 글", "fake-1"));
    // 레시피 상자의 글이 열린다 (가짜 파일은 프로젝트마다 따로)
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("고양이 앨범"));
  });

  describe("충돌 띠로 저장을 멈춘 채 떠나면 먼저 묻는다", () => {
    /** 고양이 앨범(1번)에서 쓰는 중에 바깥에서도 고쳐 충돌 띠가 뜬 상태로 */
    async function heldBack(onGo?: (place: string) => void) {
      await mount({}, { onGo });
      await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
      await act(async () => undefined);
      const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) as EditorView;
      act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "여기서 쓴 글" }, userEvent: "input.type" }));
      const version = fakeProjects.handlers.project_requirements_version({ id: 1 }) as { version: string };
      fakeProjects.handlers.project_requirements_write({ id: 1, text: "바깥에서 쓴 글", baseVersion: version.version });
      window.dispatchEvent(new Event("focus"));
      await screen.findByText("같은 파일을 두 곳에서 고쳤어요");
    }

    it("채팅 탭에 가 있어도 요구사항 탭에 \"충돌\" 표시가 붙는다 (글 · 아이콘)", async () => {
      await heldBack();
      await waitFor(() => expect(screen.getByRole("tab", { name: /^요구사항/ })).toHaveTextContent("충돌"));
      expect(screen.getByRole("tab", { name: /^채팅/ })).not.toHaveTextContent("충돌");
    });

    it("머물기 — 그대로 남고 띠도 그대로", async () => {
      await heldBack();
      fireEvent.click(within(list()).getByRole("button", { name: /레시피 상자/ }));
      const dialog = await screen.findByRole("dialog", { name: "여기서 쓴 글이 아직 저장되지 않았어요" });
      expect(within(dialog).getByRole("button", { name: "머물기" })).toHaveFocus();
      fireEvent.click(within(dialog).getByRole("button", { name: "머물기" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("고양이 앨범");
      expect(screen.getByText("같은 파일을 두 곳에서 고쳤어요")).toBeInTheDocument();
    });

    it("버리고 가기 — 쓰지 않고 다른 프로젝트로", async () => {
      await heldBack();
      const write = vi.spyOn(ipc, "projectRequirementsWrite");
      fireEvent.click(within(list()).getByRole("button", { name: /레시피 상자/ }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "버리고 가기" }));
      await waitFor(() => expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("레시피 상자"));
      expect(write).not.toHaveBeenCalled();
      expect(fakeProjects.handlers.project_requirements_read({ id: 1 })).toMatchObject({ text: "바깥에서 쓴 글" });
    });

    it("여기서 쓴 글 남기고 가기 — 바깥 version 을 base 로 쓰고 떠난다", async () => {
      await heldBack();
      const write = vi.spyOn(ipc, "projectRequirementsWrite");
      fireEvent.click(within(list()).getByRole("button", { name: /레시피 상자/ }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "여기서 쓴 글 남기고 가기" }));
      await waitFor(() => expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("레시피 상자"));
      await waitFor(() => expect(write).toHaveBeenCalledWith(1, "여기서 쓴 글", expect.any(String)));
      await waitFor(() => expect(fakeProjects.handlers.project_requirements_read({ id: 1 })).toMatchObject({ text: "여기서 쓴 글" }));
    });

    it("메뉴로 고양이 집에 갈 때도 묻는다 — 저장을 멈추지 않았으면 묻지 않는다", async () => {
      const onGo = vi.fn();
      await heldBack(onGo);
      fireEvent.click(screen.getByRole("button", { name: "집" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(onGo).not.toHaveBeenCalled();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "버리고 가기" }));
      expect(onGo).toHaveBeenCalledWith("house");
    });
  });

  it("고른 프로젝트 번호를 받으면 그 프로젝트가 열린다", async () => {
    await mount({}, { initial: 4 });
    expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("빵집 예약");
  });

  it("폴더가 없는 프로젝트는 편집기 대신 안내 + 목록에서 빼기 (파일을 읽으러 가지 않는다)", async () => {
    const read = vi.spyOn(ipc, "projectRequirementsRead");
    await mount({}, { initial: 3 });
    fireEvent.click(screen.getByRole("tab", { name: "요구사항" }));
    const alert = within(screen.getByRole("tabpanel", { name: "요구사항" })).getByRole("alert");
    expect(alert).toHaveTextContent("폴더를 찾을 수 없어요");
    expect(alert).toHaveTextContent("D:\\work\\shop-admin");
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(read).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole("button", { name: "목록에서 빼기…" }));
    expect(openedDialog()).toHaveTextContent("프로젝트 설정");
  });

  it("프로젝트가 없으면 안내 + 새 프로젝트 단추 하나", async () => {
    await mount({ projects: "none" });
    expect(screen.getByRole("heading", { name: "아직 프로젝트가 없어요" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "프로젝트" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "새 프로젝트" });
    fireEvent.click(button);
    expect(openedDialog()).toHaveTextContent("새 프로젝트");
  });

  it("DB 가 읽기 전용이면 목록 위에 한 줄, 등록 · 고치기 · 빼기를 끈다 — 요구사항은 그대로 쓸 수 있다", async () => {
    await mount({ db: "read_only" });
    expect(within(list()).getByText(/읽기만 할 수 있어요/)).toBeInTheDocument();
    expect(within(list()).getByRole("button", { name: "새 프로젝트" })).toBeDisabled();
    expect(names()).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "프로젝트 설정" }));
    const dialog = openedDialog();
    expect(within(dialog).getByLabelText("프로젝트 이름")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "목록에서 빼기…" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /web-full/ })).toBeDisabled();
  });

  it("DB 를 못 쓰면 목록 자리에 한 줄 + 다시 읽기", async () => {
    fakeProjects.reset({ db: "unavailable" });
    render(<Harness />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("프로젝트 목록을 읽지 못했어요. 이 앱의 기록(데이터베이스)을 열지 못했어요.");
    expect(screen.queryByRole("navigation", { name: "프로젝트" })).not.toBeInTheDocument();

    fakeProjects.reset({ db: "ok" });
    fireEvent.click(within(alert).getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(names()).toHaveLength(4));
  });

  it("검색 칸은 프로젝트가 여섯 개 이상일 때만, 이름 · 경로로 거른다", async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      id: i + 1,
      path: `C:\\dev\\app-${i + 1}`,
      name: i === 4 ? "별난 이름" : `앱 ${i + 1}`,
      skill: null,
      createdAt: 1,
      lastOpenedAt: 100 - i,
      folder: "ok" as const,
      finding: null,
    }));
    vi.spyOn(ipc, "projectsList").mockResolvedValue({ db: "ok", projects: many });
    await mount();
    expect(names()).toHaveLength(7);
    const search = screen.getByRole("searchbox", { name: "프로젝트 찾기" });
    fireEvent.change(search, { target: { value: "별난" } });
    expect(names()).toEqual(["별난 이름"]);
    fireEvent.change(search, { target: { value: "APP-7" } });
    expect(names()).toEqual(["앱 7"]);
    fireEvent.change(search, { target: { value: "없는 것" } });
    expect(within(list()).getByText("맞는 프로젝트가 없어요")).toBeInTheDocument();
  });
});

describe("좁은 창", () => {
  beforeEach(() => setWide(false));

  it("프로젝트 바꾸기 단추 + 탭 (←/→ · Home/End), 안 보이는 탭도 그대로 둔다", async () => {
    await mount();
    // 편집기는 요구사항을 읽은 뒤에 뜬다 — 뜨기 전에 탭을 바꾸면 아래 "그대로 있다" 가 흔들린다
    await waitFor(() => expect(document.querySelector(".cm-editor")).not.toBeNull());
    expect(screen.queryByRole("navigation", { name: "프로젝트" })).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "작업 공간 보기" });
    const [chatTab, editorTab] = within(tabs).getAllByRole("tab");
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    expect(chatTab).toHaveAttribute("tabindex", "0");
    expect(editorTab).toHaveAttribute("tabindex", "-1");

    chatTab.focus();
    fireEvent.keyDown(tabs, { key: "ArrowRight" });
    expect(editorTab).toHaveAttribute("aria-selected", "true");
    expect(editorTab).toHaveFocus();
    expect(screen.getByRole("tabpanel", { name: "요구사항" })).toBeInTheDocument();
    // 채팅 칸은 숨겨졌을 뿐 그대로 있다 (스크롤 · 입력줄 글이 끊기지 않는다)
    await waitFor(() => expect(document.querySelector(".ws-wp__panel--chat")).toHaveTextContent("이전 대화 더 보기"));
    fireEvent.keyDown(tabs, { key: "ArrowRight" });
    expect(chatTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs, { key: "End" });
    expect(editorTab).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tabs, { key: "Home" });
    expect(chatTab).toHaveAttribute("aria-selected", "true");
  });

  it("프로젝트 바꾸기 — 누르면 목록, 고르면 닫히고 단추로 포커스, Esc 로도 닫힌다", async () => {
    await mount();
    const button = screen.getByRole("button", { name: /고양이 앨범/, expanded: false });
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const pop = within(list());
    fireEvent.click(pop.getByRole("button", { name: /빵집 예약/ }));
    expect(screen.queryByRole("navigation", { name: "프로젝트" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /빵집 예약/, expanded: false })).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: "빵집 예약" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /빵집 예약/ }));
    fireEvent.keyDown(list(), { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "프로젝트" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /빵집 예약/ })).toHaveFocus();
  });

  it("바꾸기 팝오버에서 연 새 프로젝트 창을 닫으면(연 단추는 사라졌다) 포커스가 프로젝트 바꾸기 단추로 돌아온다", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: /고양이 앨범/ }));
    const opener = within(list()).getByRole("button", { name: "새 프로젝트" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(openedDialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /고양이 앨범/ })).toHaveFocus();
  });
});

describe("새 프로젝트 대화상자", () => {
  async function openDialog() {
    const opener = within(list()).getByRole("button", { name: "새 프로젝트" });
    opener.focus();
    fireEvent.click(opener);
    return { opener, dialog: openedDialog() };
  }

  it("열리면 폴더 고르기 단추로 포커스 — 고르기 전에는 추가가 꺼져 있다", async () => {
    await mount();
    const { dialog } = await openDialog();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getByRole("button", { name: "폴더 고르기…" })).toHaveFocus();
    expect(within(dialog).getByText("아직 고르지 않았어요")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeDisabled();
  });

  it("빈 폴더 — 경로 · 살펴본 결과 · 이름(기본 폴더 이름) · 스킬(기본 /desktop-app) → 추가하면 그 프로젝트가 열린다", async () => {
    await mount();
    const add = vi.spyOn(ipc, "projectAdd");
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));

    await within(dialog).findByText("C:\\dev\\cat-diary");
    expect(within(dialog).getByText("빈 폴더예요")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("프로젝트 이름")).toHaveValue("cat-diary");
    expect(within(dialog).getByRole("radio", { name: /\/desktop-app/ })).toBeChecked();
    expect(within(dialog).getByText("데스크톱 앱 만들기 (Windows · macOS · Linux)")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("프로젝트 이름"), { target: { value: "고양이 일기" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /\/web-lite/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "추가" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(add).toHaveBeenCalledWith({ name: "고양이 일기", skill: "/web-lite" });
    // 목록 맨 앞에 새 프로젝트가 있고 열려 있다
    await waitFor(() => expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("고양이 일기"));
    expect(screen.getByRole("heading", { level: 2, name: "고양이 일기" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "고양이 일기" })).toBeInTheDocument();
  });

  it("스킬 설명은 스킬 목록의 description, 없으면 기본 문구 (하네스가 없어도 고를 수 있다)", async () => {
    fakeSkills.reset("no_harness");
    await mount();
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    await within(dialog).findByText("C:\\dev\\cat-diary");
    expect(within(dialog).getByText("웹 서비스 만들기 — 서버 · DB · 로그인까지")).toBeInTheDocument();
    expect(within(dialog).getByText("나중에 고르기")).toBeInTheDocument();
  });

  it("살펴본 결과 세 가지 — requirements.md 있음 · 하네스로 진행하던 폴더(스킬은 정하지 않음)", async () => {
    await mount({ projects: "none" }, undefined);
    fakeProjects.reset({ projects: "none", pick: "requirements" });
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트" }));
    let dialog = openedDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    expect(await within(dialog).findByText("requirements.md 가 있어요")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));

    fakeProjects.reset({ projects: "none", pick: "harness" });
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트" }));
    dialog = openedDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    expect(await within(dialog).findByText("하네스로 진행하던 폴더예요")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /나중에 고르기/ })).toBeChecked();
  });

  it.each([
    ["drive_root", /드라이브 맨 위/],
    ["home", /홈 폴더 자체/],
    ["claude_dir", /\.claude/],
    ["harness_home", /하네스 설치 폴더/],
    ["app_data", /이 앱이 기록을 두는 폴더/],
  ] as const)("고를 수 없는 폴더(%s) — 이유 한 줄과 다시 고르기, 추가는 꺼져 있다", async (reason, text) => {
    await mount({ pick: reason });
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("이 폴더는 프로젝트로 쓸 수 없어요");
    expect(alert).toHaveTextContent(text);
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "다시 고르기…" })).toBeEnabled();
    expect(within(dialog).queryByLabelText("프로젝트 이름")).not.toBeInTheDocument();
  });

  it("이미 등록된 폴더 — '이미 있어요 — 열기' 로 그 프로젝트를 연다 (새로 등록하지 않는다)", async () => {
    await mount({ pick: "requirements" });
    const add = vi.spyOn(ipc, "projectAdd");
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    expect(await within(dialog).findByText("이미 있는 프로젝트예요")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("프로젝트 이름")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "이미 있어요 — 열기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("레시피 상자");
    expect(add).not.toHaveBeenCalled();
  });

  it("고르기를 취소하면 아무것도 바뀌지 않고 한 줄만 — 앞서 고른 폴더가 있으면 그대로", async () => {
    await mount({ pick: "cancel" });
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    expect(await within(dialog).findByText("폴더를 고르지 않았어요.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeDisabled();
    vi.restoreAllMocks();

    // 한 번 고른 뒤에 취소하면 고른 폴더가 그대로 남는다 (Rust 도 들고 있던 폴더를 그대로 둔다)
    vi.spyOn(ipc, "projectPickFolder")
      .mockResolvedValueOnce({ state: "ok", path: "C:\\dev\\고른-폴더", name: "고른-폴더", finding: "fresh", existingId: null })
      .mockResolvedValueOnce(null);
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    await within(dialog).findByText("C:\\dev\\고른-폴더");
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 고르기…" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "다시 고르기…" })).toBeEnabled());
    expect(within(dialog).getByText("C:\\dev\\고른-폴더")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("프로젝트 이름")).toHaveValue("고른-폴더");
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeEnabled();
  });

  it("이름이 비면 추가가 꺼지고 이유 한 줄 — 이름 글자 수 제한", async () => {
    await mount();
    const { dialog } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    const input = await within(dialog).findByLabelText("프로젝트 이름");
    expect(input).toHaveAttribute("maxlength", "80");
    fireEvent.change(input, { target: { value: "   " } });
    expect(within(dialog).getByText("이름을 적어 주세요.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeDisabled();
  });

  it("오류 — 폴더 고르기 창이 이미 열려 있음 · DB 읽기 전용 · 폴더를 먼저 고르지 않음, 화면은 죽지 않고 한 줄", async () => {
    await mount();
    const { dialog } = await openDialog();
    vi.spyOn(ipc, "projectPickFolder").mockRejectedValueOnce(new AppError("folder_dialog_open", "x"));
    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("폴더 고르기 창이 이미 열려 있어요.");

    fireEvent.click(within(dialog).getByRole("button", { name: "폴더 고르기…" }));
    await within(dialog).findByText("C:\\dev\\cat-diary");
    const add = vi.spyOn(ipc, "projectAdd").mockRejectedValueOnce(new AppError("db_read_only", "x"));
    fireEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("읽기만 할 수 있어요");
    expect(openedDialog()).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "추가" })).toBeEnabled();

    add.mockRejectedValueOnce(new AppError("no_folder_picked", "x"));
    fireEvent.click(within(dialog).getByRole("button", { name: "추가" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("폴더를 먼저 골라 주세요.");
  });

  it("Esc 로 닫으면 연 단추로 포커스가 돌아온다 · Tab 은 대화상자 안에서만 돈다", async () => {
    await mount();
    const { opener, dialog } = await openDialog();
    const close = within(dialog).getByRole("button", { name: "닫기" });
    const cancel = within(dialog).getByRole("button", { name: "취소" });
    // 마지막 조작 대상에서 Tab → 처음으로, 처음에서 Shift+Tab → 마지막으로
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled)[0]);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("고양이 집의 새 프로젝트 단추로 들어오면(openNew) 열자마자 대화상자가 떠 있다", async () => {
    await mount({}, { openNew: true });
    expect(openedDialog()).toHaveTextContent("새 프로젝트");
  });
});

describe("프로젝트 설정", () => {
  async function openSettings() {
    const opener = screen.getByRole("button", { name: "프로젝트 설정" });
    opener.focus();
    fireEvent.click(opener);
    return { opener, dialog: openedDialog() };
  }

  it("이름 · 스킬을 고치면 목록과 머리가 바뀌고 고친 것만 보낸다", async () => {
    await mount();
    const update = vi.spyOn(ipc, "projectUpdate");
    const { dialog, opener } = await openSettings();
    expect(within(dialog).getByLabelText("프로젝트 이름")).toHaveFocus();
    expect(within(dialog).getByLabelText("프로젝트 이름")).toHaveValue("고양이 앨범");
    expect(within(dialog).getByRole("radio", { name: /\/desktop-app/ })).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("프로젝트 이름"), { target: { value: "  우리 고양이 앨범  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledWith(1, { name: "우리 고양이 앨범" });
    await waitFor(() => expect(names()[0]).toBe("우리 고양이 앨범"));
    expect(screen.getByRole("heading", { level: 2, name: "우리 고양이 앨범" })).toBeInTheDocument();
    expect(opener).toHaveFocus();

    const again = await openSettings();
    fireEvent.click(within(again.dialog).getByRole("radio", { name: /나중에 고르기/ }));
    fireEvent.click(within(again.dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(1, { skill: null }));
    await waitFor(() => expect(within(list()).getByRole("button", { current: "page" })).not.toHaveTextContent("/desktop-app"));
  });

  it("포커스가 body 로 빠져도 Esc 로 닫힌다", async () => {
    await mount();
    const { dialog, opener } = await openSettings();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(dialog).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("이름을 비우면 저장이 꺼진다", async () => {
    await mount();
    const { dialog } = await openSettings();
    fireEvent.change(within(dialog).getByLabelText("프로젝트 이름"), { target: { value: "" } });
    expect(within(dialog).getByText("이름을 적어 주세요.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("저장이 거절되면 대화상자는 그대로, 이유 한 줄", async () => {
    await mount();
    vi.spyOn(ipc, "projectUpdate").mockRejectedValueOnce(new AppError("db_read_only", "x"));
    const { dialog } = await openSettings();
    fireEvent.change(within(dialog).getByLabelText("프로젝트 이름"), { target: { value: "새 이름" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("읽기만 할 수 있어요");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("목록에서 빼기 — 확인 한 번 (폴더와 파일은 그대로, 채팅 기록은 지워져요), 취소하면 그대로", async () => {
    await mount();
    const remove = vi.spyOn(ipc, "projectRemove");
    const { dialog } = await openSettings();
    expect(within(dialog).getByText("목록에서만 지워요. 폴더와 파일은 그대로 남아요.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "목록에서 빼기…" }));
    const confirm = within(dialog).getByRole("alert");
    expect(confirm).toHaveTextContent("「고양이 앨범」을(를) 목록에서 뺄까요? 폴더와 파일은 그대로, 이 앱의 채팅 기록은 지워져요.");
    // 확인 단계에서는 안전한 쪽(취소)에 포커스 — 누른 단추가 사라져도 키보드가 대화상자를 떠나지 않는다
    const section = within(within(dialog).getByRole("region", { name: "목록에서 빼기" }));
    expect(section.getByRole("button", { name: "취소" })).toHaveFocus();
    fireEvent.click(section.getByRole("button", { name: "취소" }));
    expect(remove).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "목록에서 빼기…" })).toHaveFocus();

    fireEvent.click(within(dialog).getByRole("button", { name: "목록에서 빼기…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "빼기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledWith(1);
    // 목록에서 사라지고 다음 프로젝트가 열린다
    expect(names()).toEqual(["레시피 상자", "쇼핑몰 관리자", "빵집 예약"]);
    expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("레시피 상자");
    expect(screen.getByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
  });

  it("이 프로젝트에서 세션이 도는 중이면 빼기가 꺼지고 이유가 보인다 — 세션을 끝내면 다시 빼진다", async () => {
    fakeHistory.reset("empty");
    await mount();
    const panel = () => screen.getByRole("tabpanel", { name: /^채팅/ });
    fireEvent.click(await within(panel()).findByRole("button", { name: "/desktop-app requirements.md 로 시작" }));
    await within(panel()).findByRole("article", { name: "권한 요청" });

    const { dialog } = await openSettings();
    const ask = within(dialog).getByRole("button", { name: "목록에서 빼기…" });
    expect(ask).toBeDisabled();
    expect(within(dialog).getByText("먹물이 이 프로젝트에서 일하는 중이라 뺄 수 없어요. 세션을 끝낸 뒤 다시 빼 주세요.")).toBeInTheDocument();
    expect(ask).toHaveAccessibleDescription(/세션을 끝낸 뒤/);
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));

    await act(async () => {
      await stopSession();
    });
    const again = await openSettings();
    const go = within(again.dialog).getByRole("button", { name: "목록에서 빼기…" });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    fireEvent.click(within(again.dialog).getByRole("button", { name: "빼기" }));
    await waitFor(() => expect(names()).not.toContain("고양이 앨범"));
  });

  it("Rust 가 session_running 으로 거절하면(경합) 이유와 할 일 한 줄 — 프로젝트는 그대로", async () => {
    await mount();
    vi.spyOn(ipc, "projectRemove").mockRejectedValueOnce(new AppError("session_running", "x"));
    const { dialog } = await openSettings();
    fireEvent.click(within(dialog).getByRole("button", { name: "목록에서 빼기…" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "빼기" }));
    expect(await within(dialog).findByText("먹물이 이 프로젝트에서 일하는 중이라 뺄 수 없어요. 세션을 끝낸 뒤 다시 빼 주세요.", { selector: ".ws-dlg__error" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(names()).toContain("고양이 앨범");
  });

  it("프로젝트를 모두 빼면 '아직 프로젝트가 없어요'", async () => {
    await mount();
    for (let left = 4; left > 0; left -= 1) {
      const { dialog } = await openSettings();
      fireEvent.click(within(dialog).getByRole("button", { name: "목록에서 빼기…" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "빼기" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      if (left > 1) await waitFor(() => expect(names()).toHaveLength(left - 1));
    }
    expect(await screen.findByRole("heading", { name: "아직 프로젝트가 없어요" })).toBeInTheDocument();
  });
});

describe("채팅 판", () => {
  // 탭 이름에 "기다리는 카드 n개" 가 붙을 수 있어 이름은 앞부분만 본다
  const chatPanel = () => screen.getByRole("tabpanel", { name: /^채팅/ });

  async function startChatting() {
    await mount();
    await waitFor(() => expect(chatPanel()).toHaveTextContent("이전 대화 더 보기"));
  }

  it("넓은 창 — 채팅 판에서 말을 보내면 먹물 글 · 권한 카드가 오고, 프로젝트를 바꿨다 돌아와도 카드가 그대로다 (세션은 계속 돈다)", async () => {
    fakeHistory.reset("empty");
    await mount();
    await within(chatPanel()).findByText("요구사항을 쓰고 시작해요");
    fireEvent.click(within(chatPanel()).getByRole("button", { name: "/desktop-app requirements.md 로 시작" }));
    const card = await within(chatPanel()).findByRole("article", { name: "권한 요청" });
    expect(card).toHaveAttribute("data-pending", "true");

    // 다른 프로젝트로 — 거기서는 "지금 「고양이 앨범」에서 일하는 중" 이 보이고 카드는 이 프로젝트에 남는다
    fireEvent.click(within(list()).getByRole("button", { name: /레시피 상자/ }));
    expect(await within(chatPanel()).findByText("지금 「고양이 앨범」에서 먹물이 일하는 중이에요")).toBeInTheDocument();
    // "그 프로젝트로 가기" 로 돌아오면 같은 카드
    fireEvent.click(within(chatPanel()).getByRole("button", { name: "그 프로젝트로 가기" }));
    await waitFor(() => expect(within(list()).getByRole("button", { current: "page" })).toHaveTextContent("고양이 앨범"));
    expect(await within(chatPanel()).findByRole("article", { name: "권한 요청" })).toHaveAttribute("data-pending", "true");
  });

  it("좁은 창 — 답을 기다리는 카드가 있으면 채팅 탭에 수가 붙고, 화면 읽기 프로그램에 알린다 (포커스는 그대로)", async () => {
    fakeHistory.reset("empty");
    setWide(false);
    await mount();
    const tabs = screen.getByRole("tablist", { name: "작업 공간 보기" });
    const [chatTab] = within(tabs).getAllByRole("tab");
    expect(within(chatTab!).queryByLabelText(/기다리는 카드/)).not.toBeInTheDocument();
    fireEvent.click(chatTab!);
    const panel = screen.getByRole("tabpanel", { name: "채팅" });
    fireEvent.click(await within(panel).findByRole("button", { name: "/desktop-app requirements.md 로 시작" }));
    await within(panel).findByRole("article", { name: "권한 요청" });
    // 수는 숨긴 글로 이름이 된다 (역할 없는 span 의 aria-label 은 읽히지 않는다)
    expect(within(chatTab!).getByText("기다리는 카드 1개", { selector: ".ws-sr" })).toBeInTheDocument();
    expect(chatTab!.querySelector(".ws-wp__badge [aria-label]")).toBeNull();
    expect(screen.getByText("답을 기다리는 카드가 있어요 (1)", { selector: "[role='status']" })).toBeInTheDocument();
    expect(document.activeElement?.closest("article")).toBeNull();
    // 답하면 수가 사라진다
    fireEvent.click(within(panel).getByRole("button", { name: "이번만 허용" }));
    await waitFor(() => expect(within(chatTab!).queryByText(/기다리는 카드 \d개/)).not.toBeInTheDocument());
  });

  it("턴이 끝나면 알림 자리에 \"먹물이 답했어요\" — 기록을 불러올 때는 알리지 않는다", async () => {
    fakeHistory.reset("full");
    await mount();
    await waitFor(() => expect(chatPanel()).toHaveTextContent("계획을 정리했어요"));
    expect(screen.queryByText("먹물이 답했어요")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".wc-note[role], .wc-toolerr[role]")).toHaveLength(0);

    fakeHistory.reset("empty");
    cleanup();
    resetSessionStore();
    fakeClaude.reset();
    await mount();
    fireEvent.click(await within(chatPanel()).findByRole("button", { name: "/desktop-app requirements.md 로 시작" }));
    fireEvent.click(await within(chatPanel()).findByRole("button", { name: "이번만 허용" }));
    expect(await screen.findByText("먹물이 답했어요", { selector: "[role='status']" })).toBeInTheDocument();
  });

  it("탭을 바꿔도 편집 중인 글 · 채팅 입력줄 글이 남는다 (둘 다 마운트된 채)", async () => {
    await mount();
    const panel = screen.getByRole("tabpanel", { name: "채팅" });
    const input = (await within(panel).findAllByRole("textbox"))[0] as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "쓰다 만 말" } });
    await waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
    const editor = document.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(editor) as EditorView;
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "고치던 글" }, userEvent: "input.type" }));

    fireEvent.click(screen.getByRole("tab", { name: "요구사항" }));
    expect(screen.getByRole("tabpanel", { name: "요구사항" })).toBeInTheDocument();
    expect(input.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "채팅" }));
    expect(input.value).toBe("쓰다 만 말");
    expect(EditorView.findFromDOM(editor)?.state.doc.toString()).toBe("고치던 글");
  });

  it("지난 대화(?history=full)가 보인다", async () => {
    await startChatting();
    expect(within(chatPanel()).getByText("계획을 정리했어요. 승인해 주세요.")).toBeInTheDocument();
  });
});
