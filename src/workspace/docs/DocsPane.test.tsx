// 문서 탭 화면 시험 (가짜 모드) — 폴더별 목록 · 열기 · 읽기 전용 표시 · 키보드 · 좁은 창의 목록 ↔ 미리보기 · 상태들(없음 · 읽을 수 없음 · 비어 있음 · 잘림 · 문서 읽을 수 없음 · 사라짐 · 바뀜).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProgress, type FakeDocsMode } from "../../lib/fakeProgress";
import { fakeProjects } from "../../lib/fakeProjects";
import { ipc } from "../../lib/ipc";
import { AppError, type DocsList } from "../../lib/ipc-types";
import { DocsPane } from "./DocsPane";

function setWide(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide && query.includes("1280"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeAll(async () => {
  await ipc.projectProgressVersion(1);
});
beforeEach(() => {
  fakeProjects.reset();
  fakeProgress.reset();
  setWide(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  fakeProgress.reset();
  fakeProjects.reset();
  // @ts-expect-error jsdom 에는 matchMedia 가 없다 — 시험이 넣은 것을 지운다
  delete window.matchMedia;
});

const mount = (visible = true) => render(<DocsPane projectId={1} visible={visible} />);
const listNav = () => screen.getByRole("navigation", { name: "문서 목록" });
const docButton = (path: string) => {
  const found = listNav().querySelector<HTMLButtonElement>(`button[data-doc="${path}"]`);
  if (!found) throw new Error(`no doc ${path}`);
  return found;
};
const setDocs = (docs: FakeDocsMode) => fakeProgress.reset({ docs });

describe("목록", () => {
  it("폴더별로 묶어 이름 순 — docs 바로 아래가 맨 위, 폴더마다 문서 수", async () => {
    mount();
    await screen.findByText("README.md");
    const headings = within(listNav())
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "docs/1개",
      "docs/01-planning/1개",
      "docs/01-planning/design/1개",
      "docs/01-planning/design/refs/1개",
      "docs/02-development/2개",
      "docs/02-development/briefs/1개",
      "docs/03-notes/2개",
    ]);
    const names = Array.from(listNav().querySelectorAll(".ws-dc__name")).map((node) => node.textContent);
    expect(names.slice(0, 2)).toEqual(["README.md", "decisions.md"]);
    // 같은 폴더 안은 이름 순
    expect(names.slice(4, 6)).toEqual(["dev-plan.md", "handoff.md"]);
    expect(names).toContain("한글 메모.md");
    // 아직 안 열었다
    expect(screen.getByText("왼쪽에서 문서를 골라 보세요")).toBeInTheDocument();
  });

  it("보이지 않는 동안은 읽지 않는다", async () => {
    const list = vi.spyOn(ipc, "projectDocsList");
    mount(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(list).not.toHaveBeenCalled();
    expect(screen.getByText("문서 목록을 읽는 중…")).toBeInTheDocument();
  });

  it("docs 폴더가 없으면 안내", async () => {
    setDocs("none");
    mount();
    expect(await screen.findByText("docs 폴더가 아직 없어요")).toBeInTheDocument();
  });

  it("목록을 열 수 없으면 이유와 다시 읽기, 명령이 실패하면 오류와 다시 읽기 (누르면 낫는다)", async () => {
    vi.spyOn(ipc, "projectDocsList").mockResolvedValueOnce({ state: "unreadable", reason: "outside_folder" });
    mount();
    expect(await screen.findByText("문서 목록을 열 수 없어요")).toBeInTheDocument();
    expect(screen.getByText("docs 폴더 밖을 가리키고 있어요.")).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    const list = vi.spyOn(ipc, "projectDocsList").mockRejectedValueOnce(new AppError("db_unavailable", "x"));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("문서 목록을 읽지 못했어요");
    fireEvent.click(within(alert).getByRole("button", { name: "다시 읽기" }));
    await screen.findByText("README.md");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("문서가 하나도 없으면 안내, 잘렸으면 알림", async () => {
    const result = (files: string[], truncated: boolean): DocsList => ({ state: "ok", docsDir: "docs", files: files.map((path) => ({ path, size: 1, modified: null })), truncated });
    vi.spyOn(ipc, "projectDocsList").mockResolvedValue(result([], false));
    mount();
    expect(await screen.findByText("읽을 수 있는 문서(.md)가 아직 없어요")).toBeInTheDocument();
    cleanup();

    vi.spyOn(ipc, "projectDocsList").mockResolvedValue(result(["a.md"], true));
    mount();
    expect(await screen.findByText("문서가 많아 목록이 다 담기지 않았어요. 일부만 보여요.")).toBeInTheDocument();
    expect(screen.getByText("a.md")).toBeInTheDocument();
  });
});

describe("문서 열기 (넓은 창)", () => {
  it("누르면 오른쪽에 미리보기와 읽기 전용 표시 — 고치는 입력칸은 없다", async () => {
    mount();
    await screen.findByText("README.md");
    fireEvent.click(docButton("01-planning/decisions.md"));
    expect(await screen.findByRole("heading", { level: 1, name: "결정" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "01-planning/decisions.md" })).toBeInTheDocument();
    expect(screen.getByText("읽기 전용")).toBeInTheDocument();
    expect(docButton("01-planning/decisions.md")).toHaveAttribute("aria-current", "true");
    expect(docButton("README.md")).not.toHaveAttribute("aria-current");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // 목록은 그대로 있다
    expect(listNav()).toBeInTheDocument();
    // 다른 문서를 누르면 바뀐다
    fireEvent.click(docButton("README.md"));
    expect(await screen.findByRole("heading", { level: 1, name: "고양이 앨범" })).toBeInTheDocument();
  });

  it("문서 속 링크는 따라가지 않는다 (글자만)", async () => {
    vi.spyOn(ipc, "projectDocRead").mockResolvedValue({ state: "ok", text: "[다른 문서](other.md) 와 [밖](https://example.com)", version: "v" });
    mount();
    await screen.findByText("README.md");
    fireEvent.click(docButton("README.md"));
    await screen.findByText("다른 문서");
    expect(document.querySelector(".ws-dc__body a")).toBeNull();
  });

  it("읽을 수 없는 문서는 이유, 빈 문서는 안내, 읽는 명령이 실패하면 오류", async () => {
    mount();
    await screen.findByText("README.md");
    fireEvent.click(docButton("03-notes/옛 노트.md"));
    expect(await screen.findByText("이 문서를 열 수 없어요")).toBeInTheDocument();
    expect(screen.getByText("글자 형식(UTF-8)이 아니에요.")).toBeInTheDocument();

    vi.spyOn(ipc, "projectDocRead").mockResolvedValueOnce({ state: "ok", text: "  \n", version: "v" });
    fireEvent.click(docButton("README.md"));
    expect(await screen.findByText("빈 문서예요")).toBeInTheDocument();

    vi.spyOn(ipc, "projectDocRead").mockRejectedValueOnce(new AppError("invalid_input", "x"));
    fireEvent.click(docButton("01-planning/decisions.md"));
    expect(await screen.findByRole("alert")).toHaveTextContent("문서를 읽지 못했어요");
  });

  it("읽어 보니 없으면(사라짐) 안내 — 목록에서 다른 문서를 고르면 다시 보인다", async () => {
    vi.spyOn(ipc, "projectDocRead").mockResolvedValueOnce({ state: "absent" });
    mount();
    await screen.findByText("README.md");
    fireEvent.click(docButton("README.md"));
    expect(await screen.findByText("이 문서가 사라졌어요")).toBeInTheDocument();
    fireEvent.click(docButton("01-planning/decisions.md"));
    expect(await screen.findByRole("heading", { level: 1, name: "결정" })).toBeInTheDocument();
  });

  it("문서가 바뀌면(목록의 modified) 열어 둔 문서를 다시 읽는다 — 몇 초 뒤", async () => {
    const files = (modified: number): DocsList => ({ state: "ok", docsDir: "docs", files: [{ path: "a.md", size: 1, modified }], truncated: false });
    const list = vi.spyOn(ipc, "projectDocsList").mockResolvedValue(files(100));
    let text = "# 처음";
    const read = vi.spyOn(ipc, "projectDocRead").mockImplementation(async () => ({ state: "ok", text, version: text }));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(docButton("a.md"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("heading", { level: 1, name: "처음" })).toBeInTheDocument();
      text = "# 바뀐 뒤";
      list.mockResolvedValue(files(200));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(read).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("heading", { level: 1, name: "바뀐 뒤" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("키보드", () => {
  it("↑ ↓ Home End 로 목록을 오가고 Enter 로 연다", async () => {
    mount();
    await screen.findByText("README.md");
    const buttons = Array.from(listNav().querySelectorAll<HTMLButtonElement>("button[data-doc]"));
    expect(buttons.length).toBe(9);
    buttons[0]?.focus();
    fireEvent.keyDown(listNav(), { key: "ArrowDown" });
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(listNav(), { key: "ArrowDown" });
    expect(buttons[2]).toHaveFocus();
    fireEvent.keyDown(listNav(), { key: "ArrowUp" });
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(listNav(), { key: "End" });
    expect(buttons[8]).toHaveFocus();
    fireEvent.keyDown(listNav(), { key: "ArrowDown" });
    expect(buttons[8]).toHaveFocus();
    fireEvent.keyDown(listNav(), { key: "Home" });
    expect(buttons[0]).toHaveFocus();
    // 단추라 Enter · Space 는 기본 동작(누름)으로 열린다
    fireEvent.click(document.activeElement as HTMLElement);
    expect(await screen.findByRole("heading", { level: 1, name: "고양이 앨범" })).toBeInTheDocument();
  });
});

describe("좁은 창 — 목록 ↔ 미리보기", () => {
  beforeEach(() => setWide(false));

  it("처음엔 목록만, 열면 미리보기만(뒤로 단추 + 포커스가 제목으로), 뒤로 가면 목록(열었던 문서로 포커스)", async () => {
    mount();
    await screen.findByText("README.md");
    expect(screen.queryByText("왼쪽에서 문서를 골라 보세요")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "문서 목록으로 돌아가기" })).not.toBeInTheDocument();
    fireEvent.click(docButton("01-planning/decisions.md"));
    expect(await screen.findByRole("heading", { level: 1, name: "결정" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "문서 목록" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("heading", { level: 3, name: "01-planning/decisions.md" })).toHaveFocus());
    expect(screen.getByText("읽기 전용")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "문서 목록으로 돌아가기" }));
    expect(listNav()).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "결정" })).not.toBeInTheDocument();
    await waitFor(() => expect(docButton("01-planning/decisions.md")).toHaveFocus());
  });
});
