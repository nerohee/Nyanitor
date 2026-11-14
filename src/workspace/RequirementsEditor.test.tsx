// 요구사항 편집기 시험 (가짜 모드) — 읽기 · 자동 저장 · Ctrl+S · 떠날 때 저장 · 바깥 변경(조용히 새로 읽기 / 충돌 띠 두 선택) ·
// 없음(첫 저장은 baseVersion null) · 읽을 수 없음 · 저장 실패 · 미리보기 안전 · 한글 조합 중에는 글을 바꾸지 않음.
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProjects, type FakeRequirementsMode } from "../lib/fakeProjects";
import { ipc } from "../lib/ipc";
import { AppError } from "../lib/ipc-types";
import { RequirementsEditor } from "./RequirementsEditor";

const SAMPLE = "# 고양이 앨범\n\n우리 집 고양이 사진을 모아 보는 앱.\n\n## 꼭 필요한 것\n- 사진 올리기\n- 날짜별로 보기\n";

beforeEach(() => {
  fakeProjects.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fakeProjects.reset();
});

function view(): EditorView {
  const found = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  if (!found) throw new Error("편집기가 없다");
  return found;
}

/** 사람이 쓴 것처럼 글을 통째로 바꾼다 */
function type(text: string) {
  const v = view();
  act(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: "input.type" }));
}

function docText(): string {
  return view().state.doc.toString();
}

async function mount(mode: FakeRequirementsMode = "saved") {
  fakeProjects.reset({ requirements: mode });
  const rendered = render(<RequirementsEditor projectId={1} />);
  await waitFor(() => expect(screen.queryByText(/읽는 중/)).not.toBeInTheDocument());
  // 읽기가 끝난 뒤에 붙는 창 포커스 · 타이머 듣기까지 끝나게 (부하가 큰 때 바로 이벤트를 보내면 놓칠 수 있다)
  await act(async () => undefined);
  return rendered;
}

/** 바깥(터미널)에서 파일이 바뀐 것처럼 */
function outsideWrite(text: string): string {
  const version = fakeProjects.handlers.project_requirements_version({ id: 1 }) as { version: string };
  const result = fakeProjects.handlers.project_requirements_write({ id: 1, text, baseVersion: version.version }) as { version: string };
  return result.version;
}

const AUTOSAVE_WAIT = { timeout: 3000 };

describe("읽기", () => {
  it("파일 글을 편집기에 보이고 '저장됨' — 쓰기 · 미리보기 단추와 단축키 안내", async () => {
    await mount();
    expect(docText()).toBe(SAMPLE);
    expect(screen.getByText("저장됨")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "요구사항 (마크다운)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "쓰기" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "미리보기" })).toHaveAttribute("title", "미리보기 (Ctrl+Shift+E)");
    expect(screen.getAllByText("Ctrl").length).toBeGreaterThanOrEqual(2);
  });

  it("읽는 중에는 안내 한 줄 — 단추는 아직 꺼져 있다", async () => {
    fakeProjects.reset();
    vi.spyOn(ipc, "projectRequirementsRead").mockReturnValue(new Promise(() => undefined));
    render(<RequirementsEditor projectId={1} />);
    expect(screen.getByText("requirements.md 를 읽는 중…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled();
    expect(document.querySelector(".cm-editor")).toBeNull();
  });

  it("읽는 명령이 실패하면 이유 한 줄과 다시 읽기 — 다시 읽으면 열린다", async () => {
    fakeProjects.reset();
    vi.spyOn(ipc, "projectRequirementsRead").mockRejectedValueOnce(new AppError("db_unavailable", "x"));
    render(<RequirementsEditor projectId={1} />);
    expect(await screen.findByText(/requirements\.md 를 읽지 못했어요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(docText()).toBe(SAMPLE));
  });

  it("없음 — 빈 편집기 + 안내, 첫 저장은 baseVersion null 이고 그다음부터는 받은 version", async () => {
    await mount("absent");
    expect(screen.getByText("requirements.md 가 아직 없어요 — 쓰면 만들어져요")).toBeInTheDocument();
    expect(docText()).toBe("");
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    const version = vi.spyOn(ipc, "projectRequirementsVersion");

    type("# 새 앱");
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1), AUTOSAVE_WAIT);
    expect(write).toHaveBeenNthCalledWith(1, 1, "# 새 앱", null);
    await waitFor(() => expect(screen.queryByText("requirements.md 가 아직 없어요 — 쓰면 만들어져요")).not.toBeInTheDocument());
    expect(screen.getByText(/저장됨 \d\d:\d\d/)).toBeInTheDocument();

    type("# 새 앱\n\n- 하나");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenNthCalledWith(2, 1, "# 새 앱\n\n- 하나", "fake-1");
    void version;
  });

  it("읽을 수 없음 (UTF-8 아님 · 너무 큼) — 이유 한 줄 + 다른 편집기 안내, 편집기 없음 · 저장 안 함", async () => {
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    const first = await mount("unreadable");
    expect(screen.getByText("requirements.md 를 열 수 없어요")).toBeInTheDocument();
    expect(screen.getByText("글자 형식(UTF-8)이 아니에요.")).toBeInTheDocument();
    expect(screen.getByText("터미널이나 다른 편집기에서 열어 주세요.")).toBeInTheDocument();
    expect(document.querySelector(".cm-editor")).toBeNull();
    expect(screen.getByRole("button", { name: "미리보기" })).toBeDisabled();
    first.unmount();

    await mount("too_large");
    expect(screen.getByText("파일이 너무 커요 (1MB 넘음).")).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("저장", () => {
  it("저장 표시는 읽어 주지 않는다 (role=status 없음) — 실패만 role=alert", async () => {
    await mount();
    expect(screen.getByText("저장됨").closest(".ws-ed__saved")).not.toHaveAttribute("role");
    type("쓰는 중");
    expect(screen.getByText("저장 안 됨").closest(".ws-ed__saved")).not.toHaveAttribute("role");
  });

  it("쓰다가 1초 멈추면 자동 저장 — '저장 안 됨' → '저장됨 시각'", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type(`${SAMPLE}- 한 줄 더\n`);
    expect(screen.getByText("저장 안 됨")).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1), AUTOSAVE_WAIT);
    expect(write).toHaveBeenCalledWith(1, `${SAMPLE}- 한 줄 더\n`, "fake-1");
    expect(await screen.findByText(/저장됨 \d\d:\d\d/)).toBeInTheDocument();
  });

  it("계속 쓰면 저장을 미룬다 (멈춘 뒤 한 번만)", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    type("a");
    await act(() => vi.advanceTimersByTimeAsync(700));
    type("ab");
    await act(() => vi.advanceTimersByTimeAsync(700));
    expect(write).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(400));
    vi.useRealTimers();
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledWith(1, "ab", "fake-1");
  });

  it("Ctrl+S 는 기다리지 않고 바로 저장 — 고친 것이 없으면 쓰지 않는다", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    const root = document.querySelector(".ws-ed") as HTMLElement;
    fireEvent.keyDown(root, { key: "s", ctrlKey: true });
    await act(async () => undefined);
    expect(write).not.toHaveBeenCalled();

    type("바로 저장");
    fireEvent.keyDown(root, { key: "s", ctrlKey: true });
    await waitFor(() => expect(write).toHaveBeenCalledWith(1, "바로 저장", "fake-1"));
  });

  it("떠날 때(언마운트) 저장하지 않은 글을 저장한다", async () => {
    const { unmount } = await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type("떠나기 전에 쓴 글");
    unmount();
    await waitFor(() => expect(write).toHaveBeenCalledWith(1, "떠나기 전에 쓴 글", "fake-1"));
  });

  it("저장하는 동안 더 쓴 글은 끝난 뒤 이어서 (한 번에 하나만)", async () => {
    await mount();
    let release: () => void = () => undefined;
    const real = ipc.projectRequirementsWrite.bind(ipc);
    let calls = 0;
    const write = vi.spyOn(ipc, "projectRequirementsWrite").mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      return real(...args);
    });
    type("첫 글");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(screen.getByText("저장 중…")).toBeInTheDocument();

    type("첫 글, 이어서");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    await act(async () => undefined);
    expect(write).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write).toHaveBeenNthCalledWith(2, 1, "첫 글, 이어서", "fake-2");
    await waitFor(() => expect(screen.queryByText("저장 중…")).not.toBeInTheDocument());
  });

  it("등록한 폴더가 금지 폴더로 바뀌었으면 — 읽기 · 저장 실패 모두 이유 한 줄로 보인다", async () => {
    vi.spyOn(ipc, "projectRequirementsRead").mockRejectedValueOnce(new AppError("project_folder_forbidden", "x"));
    const view = render(<RequirementsEditor projectId={1} />);
    expect(await screen.findByText(/requirements\.md 를 읽지 못했어요.*프로젝트로 고를 수 없는 폴더예요/)).toBeInTheDocument();
    view.unmount();

    await mount();
    vi.spyOn(ipc, "projectRequirementsWrite").mockRejectedValueOnce(new AppError("project_folder_forbidden", "x"));
    type("금지 폴더 시험");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("저장하지 못했어요. 프로젝트로 고를 수 없는 폴더예요");
  });

  it("저장 실패 — 이유 한 줄과 다시 저장, 눌러 다시 하면 저장된다", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite").mockRejectedValueOnce(new AppError("file_write_failed", "x"));
    type("쓰기 실패 시험");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("저장하지 못했어요. 파일에 쓰지 못했어요");
    expect(docText()).toBe("쓰기 실패 시험");

    fireEvent.click(within(alert).getByRole("button", { name: "다시 저장" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/저장됨 \d\d:\d\d/)).toBeInTheDocument();
  });

  it("쓸 수 없는 파일이라 거절(refused)되면 이유를 알리고 글은 그대로 둔다", async () => {
    await mount();
    vi.spyOn(ipc, "projectRequirementsWrite").mockResolvedValue({ state: "refused", reason: "too_large" });
    type("큰 글");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("파일이 너무 커요");
    expect(docText()).toBe("큰 글");
  });
});

describe("바깥 변경", () => {
  it("내가 안 고쳤으면 창 포커스 때 조용히 새로 읽고 한 줄 알림 — 저장은 하지 않는다", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    outsideWrite("# 터미널에서 고친 글\n");
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(docText()).toBe("# 터미널에서 고친 글\n"));
    expect(screen.getByText("다른 곳에서 바뀐 requirements.md 를 새로 읽었어요.")).toBeInTheDocument();
    expect(screen.getByText("저장됨")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // 이 뒤에 고치면 새 version 으로 저장된다
    type("# 터미널에서 고친 글\n- 이어서");
    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "s", ctrlKey: true });
    await waitFor(() => expect(write).toHaveBeenCalledWith(1, "# 터미널에서 고친 글\n- 이어서", "fake-2"));
  });

  it("고친 것이 있으면 저장하지 않고 충돌 띠 — 내 글도 그대로", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type("내가 쓰는 중");
    outsideWrite("바깥에서 쓴 글");
    window.dispatchEvent(new Event("focus"));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("같은 파일을 두 곳에서 고쳤어요");
    expect(within(banner).getByRole("button", { name: "여기서 쓴 글 남기기" })).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "바깥에서 고친 글로 바꾸기 (여기서 쓴 글은 사라져요)" })).toBeInTheDocument();
    expect(docText()).toBe("내가 쓰는 중");
    expect(screen.getByText("저장 멈춤")).toBeInTheDocument();
    // 기다려도 자동 저장하지 않는다
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(write).not.toHaveBeenCalled();
  });

  it("충돌 띠 — '여기서 쓴 글 남기기' 는 바깥 version 을 base 로 내 글을 쓴다", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type("내가 쓰는 중");
    const outside = outsideWrite("바깥에서 쓴 글");
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await screen.findByRole("button", { name: "여기서 쓴 글 남기기" }));

    await waitFor(() => expect(write).toHaveBeenCalledWith(1, "내가 쓰는 중", outside));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(docText()).toBe("내가 쓰는 중");
    expect(fakeProjects.handlers.project_requirements_read({ id: 1 })).toMatchObject({ text: "내가 쓰는 중" });
  });

  it("충돌 띠 — '바깥에서 고친 글로 바꾸기' 는 내 글을 버리고 바깥 글로 바꾼다", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type("내가 쓰는 중");
    outsideWrite("바깥에서 쓴 글");
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await screen.findByRole("button", { name: "바깥에서 고친 글로 바꾸기 (여기서 쓴 글은 사라져요)" }));

    await waitFor(() => expect(docText()).toBe("바깥에서 쓴 글"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("저장됨")).toBeInTheDocument();
    expect(write).not.toHaveBeenCalled();
  });

  it("저장하려는 때 이미 바뀌었으면(conflict) 같은 띠 — 자동 저장 때도 말없이 덮지 않는다", async () => {
    await mount("conflict"); // 읽은 직후 바깥에서 한 번 바뀐다
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type("내 글");
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1), AUTOSAVE_WAIT);
    expect(write).toHaveBeenCalledWith(1, "내 글", "fake-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("같은 파일을 두 곳에서 고쳤어요");
    expect(fakeProjects.handlers.project_requirements_read({ id: 1 })).toMatchObject({ text: "# 고양이 앨범\n\n터미널에서 고친 글.\n" });
  });

  it("파일이 바깥에서 지워졌고 내가 고쳤으면 '지워졌어요' 띠 — '다시 만들기' 는 baseVersion null 로 새로 만든다", async () => {
    await mount();
    const write = vi.spyOn(ipc, "projectRequirementsWrite");
    type("내 글");
    vi.spyOn(ipc, "projectRequirementsVersion").mockResolvedValue({ state: "absent" });
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("alert")).toHaveTextContent("다른 프로그램에서 requirements.md 를 지웠어요");

    vi.spyOn(ipc, "projectRequirementsWrite").mockResolvedValue({ state: "ok", version: "fake-9" });
    fireEvent.click(screen.getByRole("button", { name: "여기서 쓴 글로 다시 만들기" }));
    await waitFor(() => expect(ipc.projectRequirementsWrite).toHaveBeenCalledWith(1, "내 글", null));
    void write;
  });

  it("몇 초마다(창이 보이는 동안만) version 을 본다 — 숨겨진 동안은 보지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await mount();
    const version = vi.spyOn(ipc, "projectRequirementsVersion");
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);

    vi.advanceTimersByTime(5000);
    await waitFor(() => expect(version).toHaveBeenCalledTimes(1));
    visibility = "hidden";
    vi.advanceTimersByTime(10000);
    await act(async () => undefined);
    expect(version).toHaveBeenCalledTimes(1);
  });

  it("한글을 조합하는 중에는 글을 바꾸지 않는다 — 조합이 끝난 뒤 다시 보면 새로 읽는다", async () => {
    await mount();
    const v = view();
    let composing = true;
    Object.defineProperty(v, "composing", { get: () => composing, configurable: true });
    const read = vi.spyOn(ipc, "projectRequirementsRead");
    outsideWrite("바깥에서 쓴 글");
    window.dispatchEvent(new Event("focus"));
    await act(async () => undefined);
    expect(read).not.toHaveBeenCalled();
    expect(docText()).toBe(SAMPLE);

    composing = false;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(docText()).toBe("바깥에서 쓴 글"));
  });
});

describe("쓰기 ↔ 미리보기", () => {
  it("단추와 Ctrl+Shift+E 로 오가고, 돌아오면 편집기에 포커스", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "쓰기" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    expect(screen.getByRole("heading", { level: 1, name: "고양이 앨범" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미리보기" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelector(".ws-ed__area")).toHaveAttribute("hidden");

    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "E", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("heading", { level: 1, name: "고양이 앨범" })).not.toBeInTheDocument();
    expect(document.querySelector(".ws-ed__area")).not.toHaveAttribute("hidden");
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".cm-content")));

    fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "E", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("heading", { level: 1, name: "고양이 앨범" })).toBeInTheDocument();
  });

  it("편집기에서 Ctrl+Shift+E 로 미리보기에 가면 미리보기 칸에 포커스 — 거기서 다시 누르면 쓰기로 돌아온다", async () => {
    await mount();
    const content = document.querySelector(".cm-content") as HTMLElement;
    content.focus();
    // 실제처럼 지금 포커스가 있는 곳에서 키를 누른다 (편집기 칸에 직접 보내면 포커스가 빠지는 것을 못 잡는다)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "E", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("heading", { level: 1, name: "고양이 앨범" })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("region", { name: "미리보기" })));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "E", ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole("heading", { level: 1, name: "고양이 앨범" })).not.toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector(".cm-content")));
  });

  it("Ctrl+Shift+V (서식 없이 붙여넣기) 는 가로채지 않는다", async () => {
    await mount();
    const down = fireEvent.keyDown(document.querySelector(".ws-ed") as HTMLElement, { key: "V", ctrlKey: true, shiftKey: true });
    expect(down).toBe(true);
    expect(screen.getByRole("button", { name: "쓰기" })).toHaveAttribute("aria-pressed", "true");
  });

  it("미리보기는 마크다운 안의 HTML · 이미지 · 링크를 그리지 않는다 (글자로 보이고, 눌러도 아무 일 없다)", async () => {
    await mount();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    type(
      [
        "# 제목",
        "",
        "<script>window.__pwned = 1</script>",
        "",
        '<img src="http://evil.example/x.png" onerror="window.__pwned = 2">',
        "",
        "![고양이 그림](http://evil.example/cat.png)",
        "",
        "[원격 링크](https://evil.example/login) 와 [나쁜 링크](javascript:window.__pwned=3)",
        "",
        "<a href=\"https://evil.example\">HTML 링크</a>",
      ].join("\n"),
    );
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));

    const preview = document.querySelector(".ws-md") as HTMLElement;
    expect(within(preview).getByRole("heading", { level: 1, name: "제목" })).toBeInTheDocument();
    // HTML 은 글자 그대로
    expect(preview.textContent).toContain("<script>window.__pwned = 1</script>");
    expect(preview.textContent).toContain('<img src="http://evil.example/x.png"');
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.querySelector("img")).toBeNull();
    // 이미지는 설명 글자만, 링크는 주소 없는 글자
    expect(within(preview).getByText("[그림: 고양이 그림]")).toBeInTheDocument();
    expect(preview.querySelector("a")).toBeNull();
    expect(preview.querySelector("[href], [src]")).toBeNull();
    const link = within(preview).getByText("원격 링크");
    fireEvent.click(link);
    fireEvent.click(within(preview).getByText("나쁜 링크"));
    expect(open).not.toHaveBeenCalled();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByText("저장 안 됨")).toBeInTheDocument(); // 미리보기를 눌러도 글은 그대로 — 클릭이 글을 바꾸지 않는다
  });
});
