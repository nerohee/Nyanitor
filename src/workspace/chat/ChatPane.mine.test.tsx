// 채팅의 내 연결 (P9-05) — 머리 · 먹물 글의 오케스트레이터가 내 연결의 main 고양이로, 작업자 줄 · 권한 카드는 내 연결의 고양이로. 「내 수정」에서 바꾸면 바로 다시 그린다.
import { act, render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "../../lib/fakeClaude";
import { fakeHistory } from "../../lib/fakeHistory";
import type { FakeWorkersMode } from "../../lib/fakeWorkers";
import { fakeProjects } from "../../lib/fakeProjects";
import { fakeSkills } from "../../lib/fakeSkills";
import { ipc } from "../../lib/ipc";
import { NO_MINE, resetMine, setMine } from "../../lib/mine";
import type { ProjectEntry } from "../../lib/ipc-types";
import { resetWorkerRoles } from "../progress/workerCat";
import { ChatPane } from "./ChatPane";
import { resetSessionStore, startSessionStore } from "./sessionStore";

const PACE = 40;

function projectsList(): ProjectEntry[] {
  return (fakeProjects.handlers.projects_list({}) as { projects: ProjectEntry[] }).projects;
}

function reset(workers?: FakeWorkersMode) {
  resetSessionStore();
  resetWorkerRoles();
  resetMine();
  setMine(NO_MINE);
  fakeClaude.reset({ workers, pace: PACE });
  fakeProjects.reset();
  fakeHistory.reset("empty", { workers: workers !== undefined });
  fakeSkills.reset();
}

beforeEach(() => reset());
afterEach(async () => {
  vi.restoreAllMocks();
  await ipc.claudeSessionStop();
  await new Promise((resolve) => setTimeout(resolve, PACE * 8));
  reset();
  resetMine();
});

async function mount() {
  await startSessionStore();
  const project = projectsList()[0]!;
  return render(<ChatPane project={project} projects={projectsList()} onGoProject={() => undefined} />);
}

async function say(text: string) {
  const box = screen.getByRole("textbox", { name: "보낼 말" });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

const head = () => document.querySelector(".wc-head")!;
const headFace = () => head().querySelector(".cat-face")?.getAttribute("data-cat");
const workerRows = () => Array.from(document.querySelectorAll<HTMLElement>(".wc-worker"));

describe("채팅 — 오케스트레이터", () => {
  it("내 연결이 없으면 먹물 (지금과 같다)", async () => {
    await mount();
    expect(within(head() as HTMLElement).getByText("먹물")).toBeInTheDocument();
    expect(headFace()).toBe("mukmul");
  });

  it("main 을 바꾸면 머리의 얼굴 · 이름이 바뀌고, 「내 수정」에서 바꿔 알리면 바로 다시 그린다", async () => {
    setMine({ cats: { main: "nabi" }, labels: {} });
    await mount();
    expect(within(head() as HTMLElement).getByText("나비")).toBeInTheDocument();
    expect(headFace()).toBe("nabi");
    act(() => setMine({ cats: { main: "dubu" }, labels: {} }));
    expect(within(head() as HTMLElement).getByText("두부")).toBeInTheDocument();
    expect(headFace()).toBe("dubu");
    act(() => setMine(NO_MINE));
    expect(headFace()).toBe("mukmul");
  });

  it("먹물 글 줄의 이름 · 얼굴도 같은 고양이", async () => {
    setMine({ cats: { main: "nabi" }, labels: {} });
    await mount();
    await say("안녕");
    await waitFor(() => expect(document.querySelector(".wc-msg--orch .wc-msg__who")).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector(".wc-msg--orch .wc-msg__who")).toHaveTextContent("나비");
    expect(document.querySelector(".wc-msg--orch .cat-face")?.getAttribute("data-cat")).toBe("nabi");
  });
});

describe("채팅 — 작업자 줄 · 카드", () => {
  it("내 연결로 바꾼 ui 작업자 — 작업자 줄이 바뀐 고양이 이름 · 얼굴로", async () => {
    reset("two");
    setMine({ cats: { "harness-builder-ui": "gureum" }, labels: {} });
    await mount();
    await say("둘에게 맡겨 줘");
    await waitFor(() => expect(workerRows()).toHaveLength(2));
    const texts = workerRows().map((row) => row.querySelector(".wc-worker__text")?.textContent);
    expect(texts).toEqual(["구름에게 맡김 — 사진 목록 화면 만들기", "나비에게 맡김 — 사진 읽기 명령 만들기"]);
    expect(workerRows()[0]!.querySelector(".cat-face")?.getAttribute("data-cat")).toBe("gureum");
  });

  it("권한 카드 머리의 작업자도 내 연결의 고양이 ('깨비가 보냄' → 바뀐 이름)", async () => {
    reset("permission");
    setMine({ cats: { "harness-tester": "mulgam" }, labels: {} });
    await mount();
    await say("권한이 필요한 일을 맡겨 줘");
    const card = await screen.findByRole("article", { name: "권한 요청" }, { timeout: 3000 });
    expect(within(card).getByText("물감이 보냄")).toBeInTheDocument();
    expect(card.querySelector(".wc-card__avatar .cat-face")?.getAttribute("data-cat")).toBe("mulgam");
  });
});
