// 진행 탭 화면 시험 (가짜 모드) — 일하는 고양이 · 단계 보드의 상태 하나하나 · 펼친 작업 · 진행률 없음 · 읽을 수 없음에서 나머지는 보임(D-22) · 요약 기록 · 원본 접기.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../../lib/fakeClaude";
import { fakeProgress, type FakeProgressMode } from "../../lib/fakeProgress";
import { fakeProjects } from "../../lib/fakeProjects";
import { ipc } from "../../lib/ipc";
import { AppError, type ClaudeEvent, type HandoffTask, type ProgressRead, type RawLogEntry } from "../../lib/ipc-types";
import { newChat, resetSessionStore, useSessionStore } from "../chat/sessionStore";
import { resetWorkerRoles } from "./workerCat";
import { ProgressPane } from "./ProgressPane";
import { buildSummaryLog } from "./summary";
import type { WorkerEntry } from "./workers";

// 요약 기록 계산이 불리는지 세려고 — 그대로 부르고 횟수만 센다
vi.mock("./summary", async (original) => {
  const real = await original<typeof import("./summary")>();
  return { ...real, buildSummaryLog: vi.fn(real.buildSummaryLog) };
});

const NOW = new Date("2026-11-07T10:00:00");

const worker = (over: Partial<WorkerEntry> & Pick<WorkerEntry, "toolUseId">): WorkerEntry => ({
  agentId: null,
  name: "harness-builder-ui",
  description: "진행 탭 만들기",
  background: false,
  depth: 1,
  startedAtMs: NOW.getTime() - 5 * 60_000,
  activity: null,
  status: "running",
  endedAtMs: null,
  ...over,
});

function putWorkers(workers: WorkerEntry[], raw: RawLogEntry[] = []) {
  useSessionStore.setState({ chats: { 1: { ...newChat(), load: "ready", workers } }, raw: raw.length > 0 ? { projectId: 1, lines: raw } : null });
}

function mount(visible = true) {
  return render(<ProgressPane projectId={1} visible={visible} time="day" now={NOW} />);
}

function setProgress(progress: FakeProgressMode) {
  fakeProgress.reset({ progress });
}

beforeAll(async () => {
  await ipc.projectProgressVersion(1);
});
beforeEach(() => {
  resetSessionStore();
  resetWorkerRoles();
  fakeProjects.reset();
  fakeProgress.reset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSessionStore();
  fakeProgress.reset();
  fakeProjects.reset();
});

const board = () => screen.getByRole("list", { name: "단계" });
const row = (id: string) => {
  const found = within(board())
    .getAllByRole("listitem")
    .find((item) => item.classList.contains("ws-pb__item") && item.querySelector(".ws-pb__id")?.textContent === id);
  if (!found) throw new Error(`no phase row ${id}`);
  return found;
};

describe("일하는 고양이", () => {
  it("아무도 없으면 문구, 창문은 모두 쉬는 중", async () => {
    mount();
    expect(screen.getByText("지금 일하는 고양이가 없어요")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "작업실 창문 — 모두 쉬고 있어요" })).toBeInTheDocument();
    await screen.findByRole("list", { name: "단계" });
  });

  it("얼굴 · 이름 · 무엇을 · 지금 하는 일 · 몇 분째 · 백그라운드 표시, 창문에 일하는 고양이 이름", async () => {
    putWorkers([
      worker({ toolUseId: "t1", activity: { tool: "Edit", summary: "ProgressPane.tsx 고치는 중", toolUses: 4 } }),
      worker({ toolUseId: "t2", name: "harness-tester", description: "시험 쓰기", background: true, startedAtMs: NOW.getTime() - 20_000 }),
    ]);
    mount();
    const list = screen.getByRole("list", { name: "일하는 고양이" });
    const [first, second] = within(list).getAllByRole("listitem");
    // 단추(danchu = ui 담당)
    expect(first).toHaveTextContent("단추");
    expect(first).toHaveTextContent("진행 탭 만들기");
    expect(first).toHaveTextContent("ProgressPane.tsx 고치는 중 · 도구 4번 · 5분째");
    expect(first.querySelector(".cat-figure")).not.toBeNull();
    expect(first).not.toHaveTextContent("백그라운드");
    // 깨비(tester) — 백그라운드, 방금 시작
    expect(second).toHaveTextContent("깨비");
    expect(second).toHaveTextContent("백그라운드");
    expect(second).toHaveTextContent("일하는 중 · 방금 시작했어요");
    expect(screen.getByRole("img", { name: /작업실 창문 — 일하는 고양이: 단추, 깨비/ })).toBeInTheDocument();
    expect(screen.queryByText("지금 일하는 고양이가 없어요")).not.toBeInTheDocument();
    await screen.findByRole("list", { name: "단계" });
  });

  it("작업자의 권한 카드가 기다리면 그 고양이 줄이 맨 위에 '답을 기다려요' + 기다린 지 — 같은 고양이 두 줄 아님, 창문 이름표는 그대로", async () => {
    putWorkers([worker({ toolUseId: "t1" }), worker({ toolUseId: "t2", name: "harness-tester", description: "시험 쓰기", startedAtMs: NOW.getTime() - 20_000 })]);
    act(() =>
      useSessionStore.setState((state) => ({
        chats: {
          ...state.chats,
          1: { ...state.chats[1], buffer: [{ type: "permission_request", requestId: "r1", worker: { agentId: "a", toolUseId: "t2", name: null } } as ClaudeEvent], bufferAt: [NOW.getTime() - 3 * 60_000] },
        },
      })),
    );
    mount();
    const items = within(screen.getByRole("list", { name: "일하는 고양이" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("data-waiting", "true");
    expect(items[0]).toHaveTextContent("깨비");
    expect(items[0]).toHaveTextContent("답을 기다려요");
    expect(items[0]).toHaveTextContent("시험 쓰기");
    expect(items[0]).toHaveTextContent("기다린 지 3분");
    expect(items[1]).toHaveTextContent("단추");
    expect(items[1]).not.toHaveAttribute("data-waiting");
    expect(screen.getAllByText("깨비")).toHaveLength(1);
    await screen.findByRole("list", { name: "단계" });
  });

  it("먹물이 질문을 기다리면 먹물 줄이 맨 위 (작업자 없어도), 카드가 생긴 때를 모르면 시간 없이", async () => {
    putWorkers([]);
    act(() => useSessionStore.setState((state) => ({ chats: { ...state.chats, 1: { ...state.chats[1], buffer: [{ type: "question_request", requestId: "q1" } as ClaudeEvent], bufferAt: [] } } })));
    mount();
    const items = within(screen.getByRole("list", { name: "일하는 고양이" })).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("먹물");
    expect(items[0]).toHaveTextContent("답을 기다려요");
    expect(items[0]).not.toHaveTextContent("기다린 지");
    expect(screen.queryByText("지금 일하는 고양이가 없어요")).not.toBeInTheDocument();
    await screen.findByRole("list", { name: "단계" });
  });

  it("최근 끝난 작업자는 따로 흐리게 — 끝냄 · 못 끝냄 · 멈춤을 글로", async () => {
    putWorkers([
      worker({ toolUseId: "a", status: "done", endedAtMs: NOW.getTime() - 3 * 60_000 }),
      worker({ toolUseId: "b", name: "harness-reviewer", description: "검수", status: "failed", endedAtMs: NOW.getTime() - 30_000 }),
      worker({ toolUseId: "c", name: "harness-tester", description: "시험", status: "stopped", endedAtMs: null, startedAtMs: NOW.getTime() - 9 * 60_000 }),
    ]);
    mount();
    expect(screen.getByText("지금 일하는 고양이가 없어요")).toBeInTheDocument();
    const recent = screen.getByRole("list", { name: "방금 끝낸 일" });
    const items = within(recent).getAllByRole("listitem");
    // 끝난 때가 가까운 것이 앞
    expect(items[0]).toHaveTextContent("구름");
    expect(items[0]).toHaveTextContent("못 끝냄");
    expect(items[0]).toHaveTextContent("방금");
    expect(items[1]).toHaveTextContent("단추");
    expect(items[1]).toHaveTextContent("끝냄");
    expect(items[1]).toHaveTextContent("3분 전");
    expect(items[2]).toHaveTextContent("멈춤");
    expect(items[2]).toHaveTextContent("9분 전");
    await screen.findByRole("list", { name: "단계" });
  });
});

describe("단계 보드", () => {
  it("running — 끝남 · 지금 · 아직, 지금 단계의 작업을 펼친다 (지시서 · 담당 고양이 · 상태 · 진행률)", async () => {
    mount();
    await screen.findByRole("list", { name: "단계" });
    expect(screen.getByText("7 / 12 단계 끝")).toBeInTheDocument();
    expect(row("P0")).toHaveAttribute("data-status", "done");
    expect(row("P0")).toHaveTextContent("끝남");
    expect(row("P7")).toHaveAttribute("data-status", "now");
    expect(row("P7")).toHaveAttribute("aria-current", "step");
    expect(row("P7")).toHaveTextContent("지금");
    expect(row("P8")).toHaveAttribute("data-status", "todo");
    expect(row("P8")).toHaveTextContent("아직");
    // 지금 단계만 작업이 펼쳐진다
    expect(row("P7").querySelector(".ws-pt")).not.toBeNull();
    expect(row("P6").querySelector(".ws-pt")).toBeNull();
    expect(row("P8").querySelector(".ws-pt")).toBeNull();
    const tasks = within(screen.getByRole("list", { name: "P7 작업" })).getAllByRole("listitem");
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toHaveTextContent("P7-01");
    expect(tasks[0]).toHaveTextContent("project-docs");
    expect(tasks[0]).toHaveTextContent("나비");
    expect(tasks[0]).toHaveTextContent("맡김");
    expect(tasks[0]).toHaveTextContent("5 / 7");
    const bar = within(tasks[0] as HTMLElement).getByRole("progressbar", { name: "project-docs 진행" });
    expect(bar).toHaveAttribute("aria-valuenow", "5");
    expect(bar).toHaveAttribute("aria-valuemax", "7");
    expect(tasks[1]).toHaveTextContent("돌아옴");
    expect(tasks[2]).toHaveTextContent("다시 맡김");
    // 메모가 "사용자에게 기다리는 것" 이 없으면 위 목록도 없다
    expect(screen.queryByText("나를 기다리는 것")).not.toBeInTheDocument();
  });

  it("담당은 얼굴들 — 차례(→)와 함께(·)가 이름표에 그대로, 모르는 말은 글", async () => {
    mount();
    await screen.findByRole("list", { name: "단계" });
    expect(within(row("P5")).getByRole("img", { name: "담당: 물감 → 단추 · 나비 → 물감" })).toBeInTheDocument();
    expect(row("P5").querySelectorAll(".ws-pb__face")).toHaveLength(4);
    expect(within(row("P3")).getByRole("img", { name: "담당: 나비 → 깨비 → 구름" })).toBeInTheDocument();
  });

  it("진행률이 없는 작업(null · total 0)은 막대가 없다 · 모르는 상태는 글 그대로", async () => {
    const task = (id: string, progress: HandoffTask["progress"], status: HandoffTask["status"] = "assigned", statusText = "맡김"): HandoffTask => ({
      label: `briefs/${id}-x.md`,
      brief: `briefs/${id}-x.md`,
      id,
      phase: "P7",
      owner: "ui",
      status,
      statusText,
      progress,
    });
    const base = await ipc.projectProgressRead(1);
    if (base.handoff.state !== "ok") throw new Error("가짜 메모를 읽을 수 있어야 한다");
    const read: ProgressRead = {
      ...base,
      handoff: { ...base.handoff, tasks: { state: "ok", value: [task("P7-10", null), task("P7-11", { done: 0, total: 0 }), task("P7-12", { done: 1, total: 4 }, "unknown", "끝 — 고객 고름")] } },
    };
    vi.spyOn(ipc, "projectProgressRead").mockResolvedValue(read);
    mount();
    const tasks = within(await screen.findByRole("list", { name: "P7 작업" })).getAllByRole("listitem");
    expect(tasks).toHaveLength(3);
    expect(within(tasks[0] as HTMLElement).queryByRole("progressbar")).toBeNull();
    expect(within(tasks[1] as HTMLElement).queryByRole("progressbar")).toBeNull();
    expect(within(tasks[2] as HTMLElement).getByRole("progressbar")).toBeInTheDocument();
    expect(tasks[2]).toHaveTextContent("끝 — 고객 고름");
  });

  it("알 수 없는 단계 상태는 상태 칸의 글 그대로 (없으면 알 수 없음)", async () => {
    const base = await ipc.projectProgressRead(1);
    if (base.plan.state !== "ok") throw new Error("가짜 단계 표를 읽을 수 있어야 한다");
    const phases = base.plan.phases.map((phase) => (phase.id === "P8" ? { ...phase, status: "unknown" as const, statusText: "보류 (고객 요청)" } : phase.id === "P9" ? { ...phase, status: "unknown" as const, statusText: "" } : phase));
    vi.spyOn(ipc, "projectProgressRead").mockResolvedValue({ ...base, plan: { ...base.plan, phases } });
    mount();
    await screen.findByRole("list", { name: "단계" });
    expect(row("P8")).toHaveAttribute("data-status", "unknown");
    expect(row("P8")).toHaveTextContent("보류 (고객 요청)");
    expect(row("P9")).toHaveTextContent("알 수 없음");
  });

  it("waiting — 지금 단계가 나를 기다림, 메모의 기다리는 것이 보드 위에 짧게", async () => {
    setProgress("waiting");
    mount();
    await screen.findByRole("list", { name: "단계" });
    expect(row("P7")).toHaveAttribute("data-status", "waiting");
    expect(row("P7")).toHaveTextContent("나를 기다림");
    expect(row("P7").querySelector(".ws-pt")).not.toBeNull();
    const waiting = screen.getByText("나를 기다리는 것").closest("div") as HTMLElement;
    expect(waiting).toHaveTextContent("P7 배치 — 탭 + 둥근 창문으로 갈지 골라 주세요");
    expect(waiting).toHaveTextContent("실행 확인 — 진행 탭이 맞게 보이는지");
  });

  it("none(하네스 전) — 아직 계획이 없어요, 나머지(창문 · 기록)는 그대로", async () => {
    setProgress("none");
    mount();
    expect(await screen.findByText(/아직 계획이 없어요/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "단계" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /작업실 창문/ })).toBeInTheDocument();
    expect(screen.getByText("아직 기록이 없어요")).toBeInTheDocument();
  });

  it("단계 표만 읽을 수 없음 — 보드만 읽을 수 없음 + 이유, 창문 · 일하는 고양이 · 기록은 그대로 (D-22)", async () => {
    setProgress("unreadable");
    putWorkers([worker({ toolUseId: "t1" })]);
    mount();
    expect(await screen.findByText("단계 표를 읽을 수 없어요")).toBeInTheDocument();
    expect(screen.getByText(/표의 머리 줄이 약속과 달라요/)).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "단계" })).not.toBeInTheDocument();
    // 나머지는 그대로
    expect(screen.getByRole("list", { name: "일하는 고양이" })).toHaveTextContent("진행 탭 만들기");
    expect(screen.getByRole("img", { name: /작업실 창문 — 일하는 고양이/ })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "요약 기록" })).toHaveTextContent("단추에게 맡겼어요 — 진행 탭 만들기");
    expect(screen.getByRole("button", { name: "다시 읽기" })).toBeInTheDocument();
  });

  it("메모만 읽을 수 없음 — 보드는 보이고(작업 없이) 한 줄 알림", async () => {
    setProgress("memo_unreadable");
    mount();
    await screen.findByRole("list", { name: "단계" });
    expect(screen.getByText(/이어 하기 메모를 읽을 수 없어요/)).toBeInTheDocument();
    expect(screen.getByText(/찾는 절 제목이 없어요/)).toBeInTheDocument();
    expect(row("P7")).toHaveAttribute("data-status", "now");
    expect(row("P7").querySelector(".ws-pt")).toBeNull();
  });

  it("읽는 명령이 실패하면(오류) 형식 문제와 달리 읽지 못했어요 + 다시 읽기 — 누르면 낫는다", async () => {
    const read = vi.spyOn(ipc, "projectProgressRead").mockRejectedValueOnce(new AppError("db_unavailable", "x"));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("단계를 읽지 못했어요");
    expect(screen.queryByText("단계 표를 읽을 수 없어요")).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "다시 읽기" }));
    await screen.findByRole("list", { name: "단계" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("보이지 않는 동안은 읽지 않는다 (visible=false)", async () => {
    const read = vi.spyOn(ipc, "projectProgressRead");
    mount(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText("단계를 읽는 중…")).toBeInTheDocument();
  });
});

describe("요약 기록", () => {
  it("작업자 맡김 · 돌아옴 줄이 새 것이 위로 보인다 (시각 · 종류 글 · 얼굴)", async () => {
    const t0 = new Date("2026-11-07T09:41:00").getTime();
    putWorkers([worker({ toolUseId: "t1", startedAtMs: t0, status: "done", endedAtMs: t0 + 120_000 })]);
    mount();
    const items = within(screen.getByRole("list", { name: "요약 기록" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("09:43");
    expect(items[0]).toHaveTextContent("돌아옴");
    expect(items[0]).toHaveTextContent("단추가 일을 끝내고 돌아왔어요");
    expect(items[1]).toHaveTextContent("09:41");
    expect(items[1]).toHaveTextContent("맡김");
    expect(items[1].querySelector(".cat-figure")).not.toBeNull();
    await screen.findByRole("list", { name: "단계" });
  });

  it("앱이 켜져 있는 동안 보드가 바뀔 때만 단계 끝 · 검수 통과 줄이 더해진다 (처음 읽은 것에서는 아님)", async () => {
    vi.useFakeTimers();
    const base = await (async () => {
      vi.useRealTimers();
      const value = await ipc.projectProgressRead(1);
      vi.useFakeTimers();
      return value;
    })();
    if (base.plan.state !== "ok" || base.handoff.state !== "ok") throw new Error("가짜 진행을 읽을 수 있어야 한다");
    const plan = base.plan;
    const handoff = base.handoff;
    if (handoff.tasks.state !== "ok") throw new Error("가짜 작업 목록을 읽을 수 있어야 한다");
    const tasks = handoff.tasks.value;
    const first: ProgressRead = { ...base, version: "v1" };
    const second: ProgressRead = {
      version: "v2",
      plan: { ...plan, phases: plan.phases.map((phase) => (phase.id === "P7" ? { ...phase, status: "done" as const } : phase)) },
      handoff: { ...handoff, tasks: { state: "ok", value: tasks.map((task) => (task.id === "P7-02" ? { ...task, status: "passed" as const } : task)) } },
    };
    vi.spyOn(ipc, "projectProgressRead").mockResolvedValueOnce(first).mockResolvedValue(second);
    vi.spyOn(ipc, "projectProgressVersion").mockResolvedValue("v2");
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("아직 기록이 없어요")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const items = within(screen.getByRole("list", { name: "요약 기록" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-kind")).sort()).toEqual(["pass", "phase"]);
    expect(screen.getByText("P7 단계가 끝났어요")).toBeInTheDocument();
    expect(screen.getByText("P7-02 작업이 검수를 통과했어요")).toBeInTheDocument();
  });

  it("아주 긴 기록은 최근 100줄만, 더 보기로 이어서", async () => {
    const many = Array.from({ length: 130 }, (_, i) => worker({ toolUseId: `w${i}`, startedAtMs: NOW.getTime() - (200 - i) * 1000, status: "running" }));
    putWorkers(many);
    mount();
    const log = screen.getByRole("list", { name: "요약 기록" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(100);
    fireEvent.click(screen.getByRole("button", { name: "이전 기록 더 보기 (30줄)" }));
    expect(within(log).getAllByRole("listitem")).toHaveLength(130);
    await screen.findByRole("list", { name: "단계" });
  });
});

describe("원본 출력", () => {
  const raw = (n: number): RawLogEntry[] => Array.from({ length: n }, (_, i) => ({ seq: i + 1, dir: i % 2 === 0 ? ("recv" as const) : ("send" as const), text: `줄 ${i + 1}`, truncated: i === 2, originalLen: 10, atMs: 1000 + i }));

  it("접어 두고 — 펼칠 때만 그린다 · 방향 표시 · 잘린 줄 표시", async () => {
    putWorkers([], raw(3));
    mount();
    const details = document.querySelector("details.ws-raw") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("Claude Code 가 보낸 그대로 · 3줄")).toBeInTheDocument();
    expect(details.querySelector("pre")).toBeNull();
    details.open = true;
    fireEvent(details, new Event("toggle"));
    const pre = await waitFor(() => {
      const found = details.querySelector("pre");
      expect(found).not.toBeNull();
      return found as HTMLPreElement;
    });
    expect(pre.textContent).toContain("← 줄 1");
    expect(pre.textContent).toContain("→ 줄 2");
    expect(pre.textContent).toContain("← 줄 3 …(잘림)");
    details.open = false;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(details.querySelector("pre")).toBeNull());
  });

  it("줄이 없으면 안내 — 아래로 붙어 따라가다가 사용자가 위로 올리면 멈춘다", async () => {
    putWorkers([], []);
    mount();
    const details = document.querySelector("details.ws-raw") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText(/아직 받은 줄이 없어요/)).toBeInTheDocument();

    act(() => putWorkers([], raw(2)));
    const pre = (await waitFor(() => {
      const found = details.querySelector("pre");
      expect(found).not.toBeNull();
      return found;
    })) as HTMLPreElement;
    // jsdom 은 배치를 계산하지 않는다 — 높이를 흉내 낸다
    Object.defineProperty(pre, "scrollHeight", { configurable: true, value: 500 });
    Object.defineProperty(pre, "clientHeight", { configurable: true, value: 100 });
    // 맨 아래에 있으면 새 줄에 따라간다
    pre.scrollTop = 400;
    fireEvent.scroll(pre);
    act(() => putWorkers([], raw(3)));
    expect(pre.scrollTop).toBe(500);
    // 위로 올리면 멈춘다
    pre.scrollTop = 50;
    fireEvent.scroll(pre);
    act(() => putWorkers([], raw(4)));
    expect(pre.scrollTop).toBe(50);
  });
});

describe("안 보일 때는 요약 기록을 다시 계산하지 않는다 (D-55)", () => {
  const calls = () => vi.mocked(buildSummaryLog).mock.calls.length;
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  it("탭이 안 보이는 동안 이벤트가 와도 계산하지 않고, 보이면 한 번", async () => {
    const view = mount(true);
    await settle();
    vi.mocked(buildSummaryLog).mockClear();
    view.rerender(<ProgressPane projectId={1} visible={false} time="day" now={NOW} />);
    act(() => putWorkers([worker({ toolUseId: "t1" })]));
    act(() => putWorkers([worker({ toolUseId: "t1" }), worker({ toolUseId: "t2", name: "harness-tester" })]));
    expect(calls()).toBe(0);
    view.rerender(<ProgressPane projectId={1} visible={true} time="day" now={NOW} />);
    expect(calls()).toBe(1);
    // 보이는 동안에는 이벤트마다 그대로
    act(() => putWorkers([worker({ toolUseId: "t1" })]));
    expect(calls()).toBe(2);
  });

  it("창이 숨으면(앱 신호) 계산하지 않고, 다시 보이면 그때의 내용으로 한 번", async () => {
    mount(true);
    await settle();
    vi.mocked(buildSummaryLog).mockClear();
    act(() => fakeClaude.simulateWindowVisibility(false));
    act(() => putWorkers([worker({ toolUseId: "t1" })]));
    act(() => putWorkers([worker({ toolUseId: "t1" }), worker({ toolUseId: "t2", name: "harness-tester" })]));
    expect(calls()).toBe(0);
    act(() => fakeClaude.simulateWindowVisibility(true));
    expect(calls()).toBe(1);
  });

  it("창이 숨으면(웹뷰 visibilitychange) 도 같다", async () => {
    mount(true);
    await settle();
    vi.mocked(buildSummaryLog).mockClear();
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => putWorkers([worker({ toolUseId: "t1" })]));
    expect(calls()).toBe(0);
    state.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(calls()).toBe(1);
  });
});
