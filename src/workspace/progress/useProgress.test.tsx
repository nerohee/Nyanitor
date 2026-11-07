// 진행 읽기 훅 — 보일 때만 묻기 · 바뀔 때만 읽기(싼 version) · 탭을 열 때 / 창 포커스 때 바로 · 읽기 실패와 형식 못 읽음의 구분 · 보드가 바뀌면 로그 줄.
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProgress } from "../../lib/fakeProgress";
import { fakeProjects } from "../../lib/fakeProjects";
import { ipc } from "../../lib/ipc";
import { AppError, type ProgressRead } from "../../lib/ipc-types";
import { PROGRESS_CHECK_MS, useProgress } from "./useProgress";

// 가짜 모듈은 처음 부를 때 불러온다 (진짜 비동기) — 가짜 시계 속에서는 끝나지 않으니 미리 불러 둔다
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

/** 시간을 흘리고 밀린 읽기가 끝나게 한다 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("보일 때만 묻는다", () => {
  it("보이지 않으면 아무것도 묻지 않는다 — 몇 초가 흘러도", async () => {
    const read = vi.spyOn(ipc, "projectProgressRead");
    const version = vi.spyOn(ipc, "projectProgressVersion");
    const { result } = renderHook(() => useProgress(1, false));
    await advance(PROGRESS_CHECK_MS * 4);
    expect(read).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ kind: "loading" });
  });

  it("보이게 되면 바로 읽고, 그 뒤로는 version 만 묻는다 — 바뀌지 않으면 다시 읽지 않는다", async () => {
    const read = vi.spyOn(ipc, "projectProgressRead");
    const version = vi.spyOn(ipc, "projectProgressVersion");
    const { result, rerender } = renderHook(({ visible }) => useProgress(1, visible), { initialProps: { visible: false } });
    rerender({ visible: true });
    await advance(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(1);
    expect(result.current.state.kind).toBe("ready");
    await advance(PROGRESS_CHECK_MS * 3);
    expect(version).toHaveBeenCalledTimes(3);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("version 이 달라지면 그때 다시 읽는다", async () => {
    const read = vi.spyOn(ipc, "projectProgressRead");
    renderHook(() => useProgress(1, true));
    await advance(0);
    expect(read).toHaveBeenCalledTimes(1);
    fakeProgress.touch();
    await advance(PROGRESS_CHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(PROGRESS_CHECK_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("다시 숨으면 멈추고, 다시 보이면 바로 한 번 묻는다 (탭을 열 때)", async () => {
    const version = vi.spyOn(ipc, "projectProgressVersion");
    const { rerender } = renderHook(({ visible }) => useProgress(1, visible), { initialProps: { visible: true } });
    await advance(0);
    rerender({ visible: false });
    version.mockClear();
    await advance(PROGRESS_CHECK_MS * 3);
    expect(version).not.toHaveBeenCalled();
    rerender({ visible: true });
    await advance(0);
    expect(version).toHaveBeenCalledTimes(1);
  });

  it("창 포커스 때 바로 묻는다", async () => {
    const version = vi.spyOn(ipc, "projectProgressVersion");
    renderHook(() => useProgress(1, true));
    await advance(0);
    version.mockClear();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(0);
    expect(version).toHaveBeenCalledTimes(1);
  });

  it("화면에서 사라지면(프로젝트를 바꿔 새로 만듦) 더 묻지 않는다", async () => {
    const version = vi.spyOn(ipc, "projectProgressVersion");
    const { unmount } = renderHook(() => useProgress(1, true));
    await advance(0);
    unmount();
    version.mockClear();
    await advance(PROGRESS_CHECK_MS * 3);
    expect(version).not.toHaveBeenCalled();
  });
});

describe("읽기 실패와 형식 못 읽음", () => {
  it("읽는 명령이 실패하면 error (처음부터), 다시 읽으면 낫는다", async () => {
    const read = vi.spyOn(ipc, "projectProgressRead").mockRejectedValueOnce(new AppError("db_unavailable", "x"));
    const { result } = renderHook(() => useProgress(1, true));
    await advance(0);
    expect(result.current.state).toEqual({ kind: "error", error: "db_unavailable" });
    act(() => result.current.reload());
    await advance(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.state.kind).toBe("ready");
  });

  it("단계 표를 읽을 수 없으면 오류가 아니라 ready 안의 unreadable (이유 포함) — 메모는 그대로", async () => {
    fakeProgress.reset({ progress: "unreadable" });
    const { result } = renderHook(() => useProgress(1, true));
    await advance(0);
    const state = result.current.state;
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(state.read.plan).toEqual({ state: "unreadable", reason: "header_mismatch" });
    expect(state.read.handoff.state).toBe("ok");
  });

  it("이미 읽은 뒤의 읽기 실패는 조용하다 — 지난 값을 그대로 둔다", async () => {
    const { result } = renderHook(() => useProgress(1, true));
    await advance(0);
    const before = result.current.state;
    vi.spyOn(ipc, "projectProgressVersion").mockRejectedValue(new AppError("internal", "x"));
    await advance(PROGRESS_CHECK_MS * 2);
    expect(result.current.state).toBe(before);
  });
});

describe("보드가 바뀌면 로그 줄 (메모리만)", () => {
  const withPhase = (read: ProgressRead, status: "now" | "done"): ProgressRead => {
    if (read.plan.state !== "ok") return read;
    return { ...read, version: `${read.version}-${status}`, plan: { ...read.plan, phases: read.plan.phases.map((phase) => (phase.id === "P7" ? { ...phase, status } : phase)) } };
  };

  it("처음 읽은 것에서는 만들지 않고, 지금 단계가 끝남으로 바뀌면 phase 줄을 하나 만든다", async () => {
    const base = await ipc.projectProgressRead(1);
    const first = withPhase(base, "now");
    const second = withPhase(base, "done");
    vi.spyOn(ipc, "projectProgressRead").mockResolvedValueOnce(first).mockResolvedValue(second);
    vi.spyOn(ipc, "projectProgressVersion").mockResolvedValue(second.version);
    const { result } = renderHook(() => useProgress(1, true));
    await advance(0);
    expect(result.current.boardLog).toEqual([]);
    await advance(PROGRESS_CHECK_MS);
    expect(result.current.boardLog.map((item) => item.kind)).toEqual(["phase"]);
    expect(result.current.boardLog[0]?.text).toBe("P7 단계가 끝났어요");
    // 같은 것을 다시 읽어도 늘지 않는다
    await advance(PROGRESS_CHECK_MS * 2);
    expect(result.current.boardLog).toHaveLength(1);
  });
});
