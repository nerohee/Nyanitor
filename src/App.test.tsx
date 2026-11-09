import { EditorView } from "@codemirror/view";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { fakeProjects } from "./lib/fakeProjects";
import { fakeClaude } from "./lib/fakeClaude";
import { ipc } from "./lib/ipc";
import type { ClaudeEvent } from "./lib/ipc-types";
import { newChat, resetSessionStore, useSessionStore } from "./workspace/chat/sessionStore";
import type { WorkerEntry } from "./workspace/progress/workers";

// 작업 공간은 따로 불러온다(lazy) — 전체 시험으로 바쁠 때 처음 불러오기(CodeMirror 포함)가 기다림 1초를 넘길 수 있어 미리 한 번 불러 둔다
beforeAll(async () => {
  await import("./workspace/Workspace");
}, 30_000);

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

describe("집의 일하는 고양이 → 작업 공간 탭 (P7-05)", () => {
  const worker: WorkerEntry = {
    toolUseId: "t1",
    agentId: null,
    name: "harness-builder-ui",
    description: "사진 목록 화면 만들기",
    background: false,
    depth: 1,
    startedAtMs: 0,
    activity: null,
    status: "running",
    endedAtMs: null,
  };
  const tab = (name: string) => within(screen.getByRole("tablist", { name: "작업 공간 보기" })).getByRole("tab", { name: new RegExp(`^${name}`) });

  async function openPanel(name: RegExp) {
    document.documentElement.dataset.motion = "reduced";
    render(<App />);
    await screen.findByTestId("home");
    await screen.findByRole("meter", { name: "5시간 츄르" });
    await waitFor(() => expect(useSessionStore.getState().restored).toBe(true));
    return name;
  }

  afterEach(() => {
    delete document.documentElement.dataset.motion;
  });

  it("'진행 보기' 는 그 프로젝트(레시피 상자)의 작업 공간을 진행 탭으로 연다", async () => {
    const name = await openPanel(/^단추,/);
    act(() =>
      useSessionStore.setState((state) => ({
        session: { projectId: 2, busy: true, sessionId: null },
        chats: { ...state.chats, 2: { ...newChat(), workers: [worker] } },
      })),
    );
    await waitFor(() => expect(document.querySelector('.hs-cat[data-cat="danchu"]')).toHaveAttribute("data-spot", "wheel"));
    fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.click(await screen.findByRole("button", { name: "진행 보기" }));

    expect(await screen.findByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
    expect(tab("진행")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "진행" })).toBeInTheDocument();
  });

  it("집으로 갔다가 작업 공간 메뉴로 들어가면 처음처럼 채팅 탭", async () => {
    const name = await openPanel(/^단추,/);
    act(() =>
      useSessionStore.setState((state) => ({
        session: { projectId: 2, busy: true, sessionId: null },
        chats: { ...state.chats, 2: { ...newChat(), workers: [worker] } },
      })),
    );
    await waitFor(() => expect(document.querySelector('.hs-cat[data-cat="danchu"]')).toHaveAttribute("data-spot", "wheel"));
    fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.click(await screen.findByRole("button", { name: "진행 보기" }));
    await screen.findByRole("heading", { level: 2, name: "레시피 상자" });

    fireEvent.click(screen.getByRole("button", { name: "집" }));
    await screen.findByTestId("home");
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await screen.findByRole("heading", { level: 2, name: "레시피 상자" });
    expect(tab("채팅")).toHaveAttribute("aria-selected", "true");
  });

  it("먹물이 댓돌에서 기다릴 때의 단추는 채팅 탭을 연다", async () => {
    await openPanel(/^먹물,/);
    act(() =>
      useSessionStore.setState((state) => ({
        session: { projectId: 2, busy: true, sessionId: null },
        chats: { ...state.chats, 2: { ...newChat(), buffer: [{ type: "permission_request", requestId: "r1" } as never] } },
      })),
    );
    await waitFor(() => expect(document.querySelector('.hs-cat[data-cat="mukmul"]')).toHaveAttribute("data-spot", "stone"));
    fireEvent.click(screen.getByRole("button", { name: /^먹물,/ }));
    fireEvent.click(await screen.findByRole("button", { name: "채팅에서 보기" }));

    expect(await screen.findByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
    expect(tab("채팅")).toHaveAttribute("aria-selected", "true");
  });
});

describe("숨었던 창이 다시 열리면 기다리는 카드로 (P8-02, D-25)", () => {
  const perm = (projectId: number, n = 1): ClaudeEvent =>
    ({
      type: "permission_request",
      requestId: `p${n}`,
      toolUseId: `tp${n}`,
      worker: null,
      tool: "Bash",
      displayName: "Bash",
      description: `ping ${n}`,
      command: `ping ${n}`,
      path: null,
      cwd: "C:/dev/x",
      input: { command: `ping ${n}` },
      alwaysRule: null,
      projectId,
    }) as unknown as ClaudeEvent;
  const tab = (name: string) => within(screen.getByRole("tablist", { name: "작업 공간 보기" })).getByRole("tab", { name: new RegExp(`^${name}`) });
  const scroll = vi.fn();

  beforeEach(() => {
    document.documentElement.dataset.motion = "reduced";
    Element.prototype.scrollIntoView = scroll;
  });
  afterEach(() => {
    scroll.mockReset();
    delete document.documentElement.dataset.motion;
    // @ts-expect-error jsdom 에는 없다 — 시험이 넣은 것을 지운다
    delete Element.prototype.scrollIntoView;
  });

  /** 레시피 상자(2번)에서 세션이 돌고 권한 카드가 기다린다 */
  function waitOn(projectId = 2) {
    act(() =>
      useSessionStore.setState((state) => ({
        session: { projectId, busy: true, sessionId: null },
        chats: { ...state.chats, [projectId]: { ...newChat(), buffer: [perm(projectId)] } },
      })),
    );
  }
  async function start() {
    render(<App />);
    await screen.findByTestId("home");
    await waitFor(() => expect(useSessionStore.getState().restored).toBe(true));
  }
  const shown = () => act(() => fakeClaude.simulateWindowShown("tray"));
  const focusedCard = () => document.activeElement?.getAttribute("data-pending-card") === "true";

  it("고양이 집에서 → 그 프로젝트의 작업 공간 · 채팅 탭, 기다리는 카드에 초점", async () => {
    await start();
    waitOn();
    shown();
    expect(await screen.findByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
    expect(tab("채팅")).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(focusedCard()).toBe(true));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("다른 프로젝트의 작업 공간에 있어도 그 프로젝트로 바뀐다", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await screen.findByRole("heading", { level: 2, name: "고양이 앨범" });
    waitOn();
    shown();
    expect(await screen.findByRole("heading", { level: 2, name: "레시피 상자" })).toBeInTheDocument();
    await waitFor(() => expect(focusedCard()).toBe(true));
  });

  it.each(["진행", "문서", "요구사항"])("%s 탭에 있어도 채팅 탭으로 와서 카드에 초점", async (name) => {
    await start();
    waitOn();
    fireEvent.click(await screen.findByRole("button", { name: /레시피 상자/ }));
    await screen.findByRole("heading", { level: 2, name: "레시피 상자" });
    await waitFor(() => expect(document.querySelector('[data-pending-card="true"]')).not.toBeNull());
    fireEvent.click(tab(name));
    expect(tab(name)).toHaveAttribute("aria-selected", "true");
    scroll.mockClear();
    shown();
    await waitFor(() => expect(tab("채팅")).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(focusedCard()).toBe(true));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("카드가 없으면 그대로 — 집에서도 작업 공간에서도", async () => {
    await start();
    act(() => useSessionStore.setState({ session: { projectId: 2, busy: true, sessionId: null } }));
    shown();
    await act(async () => undefined);
    expect(screen.getByTestId("home")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await screen.findByRole("heading", { level: 2, name: "고양이 앨범" });
    fireEvent.click(tab("문서"));
    shown();
    await act(async () => undefined);
    expect(screen.getByRole("heading", { level: 2, name: "고양이 앨범" })).toBeInTheDocument();
    expect(tab("문서")).toHaveAttribute("aria-selected", "true");
  });

  it("세션이 없으면 그대로", async () => {
    await start();
    shown();
    await act(async () => undefined);
    expect(screen.getByTestId("home")).toBeInTheDocument();
  });

  it("편집 충돌 중에 다른 프로젝트로 가야 하면 묻고, 머물기면 그대로", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    await waitFor(() => expect(document.querySelector(".cm-content")?.textContent).toContain("고양이 앨범"));
    await act(async () => undefined);
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement) as EditorView;
    act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "여기서 쓴 글" }, userEvent: "input.type" }));
    const version = fakeProjects.handlers.project_requirements_version({ id: 1 }) as { version: string };
    fakeProjects.handlers.project_requirements_write({ id: 1, text: "바깥에서 쓴 글", baseVersion: version.version });
    window.dispatchEvent(new Event("focus"));
    await screen.findByText("같은 파일을 두 곳에서 고쳤어요");

    waitOn();
    shown();
    const dialog = await screen.findByRole("dialog", { name: "여기서 쓴 글이 아직 저장되지 않았어요" });
    fireEvent.click(within(dialog).getByRole("button", { name: "머물기" }));
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "고양이 앨범" })).toBeInTheDocument();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("옮긴 뒤 다른 프로젝트에 갔다 돌아와도 옛 요청으로 다시 끌려가지 않는다", async () => {
    await start();
    waitOn();
    shown();
    await screen.findByRole("heading", { level: 2, name: "레시피 상자" });
    await waitFor(() => expect(focusedCard()).toBe(true));
    expect(scroll).toHaveBeenCalledTimes(1);
    // 좁은 창 — 프로젝트 바꾸기 단추로 목록을 열고 고른다
    const item = (name: RegExp) => {
      fireEvent.click(document.querySelector(".ws-switch__btn") as HTMLElement);
      return screen.getAllByRole("button", { name }).find((button) => button.classList.contains("ws-proj__item")) as HTMLElement;
    };
    fireEvent.click(item(/고양이 앨범/));
    await screen.findByRole("heading", { level: 2, name: "고양이 앨범" });
    await act(async () => undefined);
    fireEvent.click(item(/레시피 상자/));
    await screen.findByRole("heading", { level: 2, name: "레시피 상자" });
    await waitFor(() => expect(document.querySelector('[data-pending-card="true"]')).not.toBeNull());
    await act(async () => undefined);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("두 번 빨리 와도 한 번 옮긴 것과 같다", async () => {
    await start();
    waitOn();
    act(() => {
      fakeClaude.simulateWindowShown("tray");
      fakeClaude.simulateWindowShown("second_instance");
    });
    await screen.findByRole("heading", { level: 2, name: "레시피 상자" });
    await waitFor(() => expect(focusedCard()).toBe(true));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("앱이 꺼지면 듣기를 풀어 더는 반응하지 않는다 · StrictMode 에서도 한 번만 붙는다", async () => {
    const off = vi.fn();
    const listen = vi.spyOn(ipc, "onWindowShown").mockResolvedValue(off);
    const { unmount } = render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await screen.findByTestId("home");
    await waitFor(() => expect(listen).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(off).toHaveBeenCalledTimes(1));
    unmount();
    expect(off).toHaveBeenCalledTimes(2);

    vi.restoreAllMocks();
    const again = render(<App />);
    await screen.findByTestId("home");
    waitOn();
    again.unmount();
    shown();
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument();
  });

  it("시안 틀 · 시험 화면에서는 듣지 않는다", async () => {
    const listen = vi.spyOn(ipc, "onWindowShown");
    window.history.replaceState({}, "", "/?variant=a&screen=cats");
    render(<App />);
    await screen.findByTestId("variant-frame");
    expect(listen).not.toHaveBeenCalled();
  });
});
