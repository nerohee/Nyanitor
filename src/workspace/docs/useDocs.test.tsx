// 문서 읽기 훅 — 보일 때만 목록 읽기(몇 초마다) · 연 문서의 modified 가 바뀌면 다시 읽기 · 문서가 사라짐 · 읽을 수 없음 · 오류 · 늦게 온 답 버리기.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProgress } from "../../lib/fakeProgress";
import { fakeProjects } from "../../lib/fakeProjects";
import { ipc } from "../../lib/ipc";
import { AppError, type DocsList } from "../../lib/ipc-types";
import { DOCS_CHECK_MS, useDocs } from "./useDocs";

beforeAll(async () => {
  await ipc.projectProgressVersion(1);
});
beforeEach(() => {
  vi.useFakeTimers();
  fakeProjects.reset();
  fakeProgress.reset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fakeProgress.reset();
  fakeProjects.reset();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const listing = (files: { path: string; modified: number | null }[], truncated = false): DocsList => ({
  state: "ok",
  docsDir: "docs",
  files: files.map((file) => ({ ...file, size: 10 })),
  truncated,
});

describe("목록", () => {
  it("보이지 않으면 읽지 않고, 보이면 읽고 몇 초마다 다시 읽는다 — 다시 숨으면 멈춘다", async () => {
    const spy = vi.spyOn(ipc, "projectDocsList");
    const { result, rerender } = renderHook(({ visible }) => useDocs(1, visible), { initialProps: { visible: false } });
    await advance(DOCS_CHECK_MS * 2);
    expect(spy).not.toHaveBeenCalled();
    rerender({ visible: true });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.list.kind).toBe("ready");
    await advance(DOCS_CHECK_MS * 2);
    expect(spy).toHaveBeenCalledTimes(3);
    rerender({ visible: false });
    await advance(DOCS_CHECK_MS * 3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("docs 폴더가 없으면 absent, 읽을 수 없으면 unreadable(이유), 명령이 실패하면 error", async () => {
    fakeProgress.reset({ docs: "none" });
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    expect(result.current.list).toEqual({ kind: "absent" });

    vi.spyOn(ipc, "projectDocsList").mockResolvedValueOnce({ state: "unreadable", reason: "link" });
    await advance(DOCS_CHECK_MS);
    expect(result.current.list).toEqual({ kind: "unreadable", reason: "link" });

    vi.spyOn(ipc, "projectDocsList").mockRejectedValue(new AppError("db_unavailable", "x"));
    const second = renderHook(() => useDocs(1, true));
    await advance(0);
    expect(second.result.current.list).toEqual({ kind: "error", error: "db_unavailable" });
  });

  it("이미 읽은 목록이 있으면 다시 읽기 실패는 조용하다", async () => {
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    const before = result.current.list;
    vi.spyOn(ipc, "projectDocsList").mockRejectedValue(new AppError("internal", "x"));
    await advance(DOCS_CHECK_MS * 2);
    expect(result.current.list).toBe(before);
  });

  it("목록이 잘렸으면 truncated", async () => {
    vi.spyOn(ipc, "projectDocsList").mockResolvedValue(listing([{ path: "a.md", modified: 1 }], true));
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    expect(result.current.list.kind === "ready" && result.current.list.listing.truncated).toBe(true);
  });
});

describe("연 문서", () => {
  it("열면 읽는다 — 그 뒤 modified 가 같으면 다시 읽지 않고, 바뀌면 다시 읽는다", async () => {
    let modified = 100;
    vi.spyOn(ipc, "projectDocsList").mockImplementation(async () => listing([{ path: "a.md", modified }]));
    const read = vi.spyOn(ipc, "projectDocRead").mockImplementation(async () => ({ state: "ok", text: `글 ${modified}`, version: `v${modified}` }));
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    act(() => result.current.open("a.md"));
    expect(result.current.doc).toEqual({ kind: "loading" });
    await advance(0);
    expect(read).toHaveBeenCalledWith(1, "a.md");
    expect(result.current.doc).toEqual({ kind: "ready", text: "글 100" });
    expect(result.current.modified).toBe(100);

    await advance(DOCS_CHECK_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);

    modified = 200;
    await advance(DOCS_CHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.doc).toEqual({ kind: "ready", text: "글 200" });
    expect(result.current.modified).toBe(200);
  });

  it("문서가 목록에서 사라지면 gone — 다시 나타나면 다시 읽는다", async () => {
    let files: { path: string; modified: number | null }[] = [{ path: "a.md", modified: 1 }];
    vi.spyOn(ipc, "projectDocsList").mockImplementation(async () => listing(files));
    const read = vi.spyOn(ipc, "projectDocRead").mockResolvedValue({ state: "ok", text: "본문", version: "v" });
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    act(() => result.current.open("a.md"));
    await advance(0);
    expect(result.current.doc?.kind).toBe("ready");

    files = [];
    await advance(DOCS_CHECK_MS);
    expect(result.current.doc).toEqual({ kind: "gone" });
    expect(result.current.path).toBe("a.md");

    files = [{ path: "a.md", modified: 1 }];
    await advance(DOCS_CHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.doc).toEqual({ kind: "ready", text: "본문" });
  });

  it("읽어 보니 없음(absent) → gone, 읽을 수 없음 → unreadable(이유), 오류 → error", async () => {
    const read = vi.spyOn(ipc, "projectDocRead");
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    read.mockResolvedValueOnce({ state: "absent" });
    act(() => result.current.open("README.md"));
    await advance(0);
    expect(result.current.doc).toEqual({ kind: "gone" });
    read.mockResolvedValueOnce({ state: "unreadable", reason: "not_utf8" });
    act(() => result.current.open("03-notes/옛 노트.md"));
    await advance(0);
    expect(result.current.doc).toEqual({ kind: "unreadable", reason: "not_utf8" });
    read.mockRejectedValueOnce(new AppError("invalid_input", "x"));
    act(() => result.current.open("README.md"));
    await advance(0);
    expect(result.current.doc).toEqual({ kind: "error", error: "invalid_input" });
  });

  it("다른 문서를 빨리 열면 늦게 온 앞 문서의 답은 버린다", async () => {
    const resolvers: Record<string, (text: string) => void> = {};
    vi.spyOn(ipc, "projectDocRead").mockImplementation(
      (_id, path) =>
        new Promise((resolve) => {
          resolvers[path] = (text) => resolve({ state: "ok", text, version: path });
        }),
    );
    const { result } = renderHook(() => useDocs(1, true));
    await advance(0);
    act(() => result.current.open("README.md"));
    act(() => result.current.open("01-planning/decisions.md"));
    await act(async () => {
      resolvers["01-planning/decisions.md"]?.("두 번째");
      resolvers["README.md"]?.("첫 번째");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.path).toBe("01-planning/decisions.md");
    expect(result.current.doc).toEqual({ kind: "ready", text: "두 번째" });
  });
});
