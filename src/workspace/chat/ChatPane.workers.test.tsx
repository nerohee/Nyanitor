// 채팅의 작업자 (가짜 세션 `?workers=` 시나리오) — 작업자 줄이 뜨고 끝나면 같은 줄이 바뀐다 · Agent 도구 줄은 안 보인다 · 권한 카드에 그 작업자 고양이 ·
// 기록(`?history=full` + 작업자)의 마침 · 실패 · 멈춤 줄 · 카드 머리의 작업자 (없으면 먹물).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../../lib/fakeClaude";
import { fakeHistory } from "../../lib/fakeHistory";
import type { FakeWorkersMode } from "../../lib/fakeWorkers";
import { fakeProjects } from "../../lib/fakeProjects";
import { fakeSkills } from "../../lib/fakeSkills";
import { ipc } from "../../lib/ipc";
import type { PermissionRequestInfo, ProjectEntry, QuestionRequestInfo } from "../../lib/ipc-types";
import { resetWorkerRoles } from "../progress/workerCat";
import { PermissionCard, QuestionRequest } from "./Cards";
import { ChatPane } from "./ChatPane";
import { resetSessionStore, startSessionStore, useSessionStore } from "./sessionStore";

const PACE = 40;

function projectsList(): ProjectEntry[] {
  return (fakeProjects.handlers.projects_list({}) as { projects: ProjectEntry[] }).projects;
}
const project = (id: number): ProjectEntry => {
  const found = projectsList().find((entry) => entry.id === id);
  if (!found) throw new Error(`no fake project ${id}`);
  return found;
};

function reset(workers?: FakeWorkersMode, history: "empty" | "full" = "empty") {
  resetSessionStore();
  resetWorkerRoles();
  fakeClaude.reset({ workers, pace: PACE });
  fakeProjects.reset();
  fakeHistory.reset(history, { workers: workers !== undefined });
  fakeSkills.reset();
}

beforeEach(() => reset());
afterEach(async () => {
  vi.restoreAllMocks();
  // 가짜 세션의 타이머가 다음 시험에 새지 않게
  await ipc.claudeSessionStop();
  await new Promise((resolve) => setTimeout(resolve, PACE * 8));
  reset();
});

async function mount(id = 1) {
  await startSessionStore();
  return render(<ChatPane key={id} project={project(id)} projects={projectsList()} onGoProject={() => undefined} />);
}

async function say(text: string) {
  const box = screen.getByRole("textbox", { name: "보낼 말" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

const workerRows = () => Array.from(document.querySelectorAll<HTMLElement>(".wc-worker"));

describe("작업자 줄 (가짜 세션)", () => {
  it("one — 맡김 줄이 뜨고(일하는 중) 끝나면 같은 줄이 '돌아옴' 으로 바뀐다. Agent 도구 줄은 안 보인다", async () => {
    reset("one");
    await mount(1);
    await say("작업자에게 맡겨 줘");
    const row = await waitFor(() => {
      const found = workerRows();
      expect(found).toHaveLength(1);
      return found[0] as HTMLElement;
    });
    // 깨비(harness-tester) — 얼굴 + "깨비에게 맡김 — 무엇" + 상태
    expect(within(row).getByText("깨비에게 맡김 — 채팅 화면 시험 쓰기")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-status", "running");
    expect(within(row).getByText("일하는 중")).toBeInTheDocument();
    expect(row.querySelector(".cat-figure")).not.toBeNull();
    // 끝나면 같은 줄(같은 요소)에서 바뀐다
    await waitFor(() => expect(row).toHaveAttribute("data-status", "done"), { timeout: 3000 });
    expect(within(row).getByText("돌아옴")).toBeInTheDocument();
    expect(workerRows()).toHaveLength(1);
    expect(workerRows()[0]).toBe(row);
    // Agent 도구 줄 · 결과는 안 보인다
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(document.querySelector(".wc-tool")).toBeNull();
  });

  it("two — 줄이 둘 (단추 · 나비), 끝나는 때가 달라도 각자 줄에서 바뀐다", async () => {
    reset("two");
    await mount(1);
    await say("둘에게 맡겨 줘");
    await waitFor(() => expect(workerRows()).toHaveLength(2));
    const texts = workerRows().map((row) => row.querySelector(".wc-worker__text")?.textContent);
    expect(texts).toEqual(["단추에게 맡김 — 사진 목록 화면 만들기", "나비에게 맡김 — 사진 읽기 명령 만들기"]);
    await waitFor(() => expect(workerRows().map((row) => row.getAttribute("data-status"))).toEqual(["done", "done"]), { timeout: 3000 });
  });

  it("background — 턴이 먼저 끝나도 줄은 '일하는 중' 으로 남고(백그라운드 표시), 끝 알림 뒤에 바뀐다", async () => {
    reset("background");
    await mount(1);
    await say("뒤에서 해 줘");
    const row = await waitFor(() => {
      const found = workerRows()[0];
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    expect(within(row).getByText("백그라운드")).toBeInTheDocument();
    // 부른 턴이 끝났는데(= 보내기 가능 상태로 돌아옴) 줄은 아직 일하는 중
    await waitFor(() => expect(useSessionStore.getState().session?.busy).toBe(false));
    expect(row).toHaveAttribute("data-status", "running");
    await waitFor(() => expect(row).toHaveAttribute("data-status", "done"), { timeout: 3000 });
  });

  it("permission — 권한 카드 머리에 그 작업자 고양이와 '깨비가 보냄'", async () => {
    reset("permission");
    await mount(1);
    await say("권한이 필요한 일을 맡겨 줘");
    const card = await screen.findByRole("article", { name: "권한 요청" }, { timeout: 3000 });
    expect(within(card).getByText("깨비가 보냄")).toBeInTheDocument();
    expect(card.querySelector(".wc-card__avatar .cat-figure")).not.toBeNull();
    // 작업자 줄은 따로 — 일하는 중
    expect(workerRows()[0]).toHaveAttribute("data-status", "running");
  });

  it("작업자가 없는 가짜 세션의 권한 카드는 지금처럼 — 작업자 표시 없음", async () => {
    reset();
    await mount(1);
    await say("그냥 해 줘");
    const card = await screen.findByRole("article", { name: "권한 요청" });
    expect(within(card).queryByText(/ 보냄$/)).not.toBeInTheDocument();
    expect(card.querySelector(".wc-card__who")).toBeNull();
  });
});

describe("기록의 작업자 줄", () => {
  it("?history=full + 작업자 — 마침 · 실패 · 멈춤 줄이 뜨고 Agent 줄은 없다", async () => {
    reset("one", "full");
    await mount(1);
    await waitFor(() => expect(workerRows().length).toBeGreaterThanOrEqual(3));
    const byText = (needle: string) => workerRows().find((row) => row.textContent?.includes(needle));
    expect(byText("채팅 화면 시험 쓰기")).toHaveAttribute("data-status", "done");
    expect(byText("사진 목록 화면 만들기")).toHaveAttribute("data-status", "failed");
    expect(byText("사진 읽기 명령 만들기")).toHaveAttribute("data-status", "stopped");
    expect(within(byText("사진 목록 화면 만들기") as HTMLElement).getByText("못 끝냄")).toBeInTheDocument();
    expect(within(byText("사진 읽기 명령 만들기") as HTMLElement).getByText("멈춤")).toBeInTheDocument();
    // 상태 글자는 색만이 아니라 아이콘과 함께 (실시간이 아니라 알림 역할은 없다)
    expect(byText("채팅 화면 시험 쓰기")?.getAttribute("role")).toBeNull();
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
  });
});

const permInfo = (worker: PermissionRequestInfo["worker"]): PermissionRequestInfo => ({ requestId: "r", toolUseId: null, worker, tool: "Bash", displayName: null, description: null, command: "npm install", path: null, cwd: "C:\\p", input: undefined, alwaysRule: null });
const PENDING = { status: "pending", answer: null } as const;

describe("카드 머리의 작업자", () => {
  it("요청의 작업자 이름으로 — 단추 · 나비 …, 하네스 밖 이름은 두부", () => {
    const { rerender } = render(<PermissionCard info={permInfo({ agentId: "a", toolUseId: "t", name: "harness-builder-ui" })} state={PENDING} onRespond={vi.fn()} />);
    expect(screen.getByText("단추가 보냄")).toBeInTheDocument();
    rerender(<PermissionCard info={permInfo({ agentId: "a", toolUseId: "t", name: "general-purpose" })} state={PENDING} onRespond={vi.fn()} />);
    expect(screen.getByText("두부가 보냄")).toBeInTheDocument();
  });

  it("작업자 목록(toolUseId)이 이름을 가진 것이 먼저 — 요청에 이름이 없어도 찾는다", () => {
    useSessionStore.setState({
      chats: {
        1: {
          load: "ready",
          loadError: null,
          data: { lines: [], starts: [], agentCalls: [], nextKey: 1, lastStart: null, halted: null },
          buffer: [],
          bufferAt: [],
          workers: [{ toolUseId: "tool-9", agentId: "a", name: "harness-builder-system", description: null, background: false, depth: 1, startedAtMs: 1, activity: null, status: "running", endedAtMs: null }],
          hasMore: false,
          oldestId: null,
          loadingOlder: false,
          olderFailed: false,
          resumable: null,
        },
      },
    });
    render(<PermissionCard info={permInfo({ agentId: "a", toolUseId: "tool-9", name: null })} state={PENDING} onRespond={vi.fn()} />);
    expect(screen.getByText("나비가 보냄")).toBeInTheDocument();
  });

  it("작업자 표시가 없거나(메인 쪽 · 기록에서 읽은 옛 카드) 누군지 모르면 지금 모양 그대로 (먹물)", () => {
    const { container, rerender } = render(<PermissionCard info={permInfo(null)} state={PENDING} onRespond={vi.fn()} />);
    expect(container.querySelector(".wc-card__who")).toBeNull();
    rerender(<PermissionCard info={permInfo(undefined)} state={PENDING} onRespond={vi.fn()} />);
    expect(container.querySelector(".wc-card__who")).toBeNull();
    rerender(<PermissionCard info={permInfo({ agentId: "a", toolUseId: null, name: null })} state={PENDING} onRespond={vi.fn()} />);
    expect(container.querySelector(".wc-card__who")).toBeNull();
  });

  it("질문 카드 · 승인 카드에도", () => {
    const question: QuestionRequestInfo = { requestId: "q", toolUseId: null, worker: { agentId: "a", toolUseId: null, name: "harness-designer" }, questions: [{ question: "색은?", header: "색", multiSelect: false, options: [{ label: "파랑", description: null, preview: null }] }] };
    const { rerender } = render(<QuestionRequest info={question} state={PENDING} onRespond={vi.fn()} />);
    expect(screen.getByText("물감이 보냄")).toBeInTheDocument();
    const approval: QuestionRequestInfo = { ...question, questions: [{ question: "단계 승인 — P7 진행 보기\n- 무엇을: a\n- 왜 지금: b\n- 산출물: c\n- 하지 않는 것: d", header: null, multiSelect: false, options: [] }] };
    rerender(<QuestionRequest info={approval} state={PENDING} onRespond={vi.fn()} />);
    expect(screen.getByText("물감이 보냄")).toBeInTheDocument();
  });
});
