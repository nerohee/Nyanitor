// 「내 수정」 화면 시험 (브라우저 가짜 내 수정, `fakeCustom`) — 목록 · 값 바로 저장 → 적용 안 한 것 → 적용 → 기록 · 덧붙임 자동 저장 · 통째 시작 / 돌아가기 · 내가 만든 것 지우기 · 버리기 ·
// 적용 실패 · 기록 되돌리기(`has_unapplied` 포함) · 원본 바뀜 고르기(탭 숫자) · 하네스 없음 / git 없음 / 기록 시작 전 · 잠김 · 거절 표시 · 떠날 때 저장 · 키보드.
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCustom, type FakeCustomMode } from "../lib/fakeCustom";
import { fakeHouse } from "../lib/fakeHouse";
import { ipc } from "../lib/ipc";
import { AppError } from "../lib/ipc-types";
import EditScreen from "./EditScreen";

const NOW = new Date("2026-11-09T12:00:00+09:00");
const WAIT = { timeout: 4000 };

beforeEach(() => {
  fakeHouse.reset();
  fakeCustom.reset();
});

afterEach(async () => {
  cleanup();
  // 화면을 닫을 때 남은 글을 저장하는 일(떠날 때 저장)이 끝난 뒤에 가짜를 되돌린다 — 다음 시험으로 새지 않게
  await new Promise((resolve) => setTimeout(resolve, 40));
  vi.restoreAllMocks();
  fakeHouse.reset();
  fakeCustom.reset();
});

async function mount(mode: FakeCustomMode = "full", props: Partial<Parameters<typeof EditScreen>[0]> = {}) {
  fakeCustom.reset(mode);
  const onGo = vi.fn();
  const rendered = render(<EditScreen onGo={onGo} clock={() => NOW} {...props} />);
  await screen.findByRole("navigation", { name: "에이전트 · 스킬 목록" });
  // 에이전트 목록(이름 · 고양이 연결)까지 읽히게
  await screen.findByText("화면 구현");
  return { onGo, ...rendered };
}

/** 목록에서 항목 고르기 — 이름(또는 파일)을 가진 단추 */
async function pick(name: string) {
  const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
  fireEvent.click(within(list).getByText(name, { selector: ".ed-item__name" }).closest("button")!);
  await waitFor(() => expect(document.getElementById("ed-panel-title")).toHaveTextContent(new RegExp(`^${name}`)));
  // 상세(파일 읽기)가 열릴 때까지
  await waitFor(() => expect(screen.queryByText("읽는 중…")).not.toBeInTheDocument());
}

function valueOf(box: HTMLElement): string {
  return (box as HTMLTextAreaElement).value;
}

/** 항목을 읽은 결과의 덧붙임 글 (끝의 줄바꿈은 떼고, 없으면 null) */
function appendTextOf(read: Awaited<ReturnType<typeof ipc.customItemRead>>): string | null {
  return read.state === "ok" && read.appendText.state === "text" ? read.appendText.text.replace(/\n$/, "") : null;
}

function last<T>(items: T[]): T {
  return items[items.length - 1]!;
}

/** 기록 탭의 되돌리기 확인 띠 (적용 바의 「되돌리기」와 단추 이름이 같아서 띠 안에서만 찾는다) */
function confirmBand(): HTMLElement {
  return screen.getByText(/때로 되돌릴까요\?/).closest(".ed-bnr") as HTMLElement;
}

function view(): EditorView {
  const found = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
  if (!found) throw new Error("편집기가 없다");
  return found;
}

function type(text: string) {
  const v = view();
  act(() => v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, userEvent: "input.type" }));
}

/** 모델 · 수준 한 줄 단추 묶음 */
function valueGroup(label: "모델" | "수준") {
  return screen.getByRole("radiogroup", { name: label });
}

function choose(label: "모델" | "수준", value: string) {
  fireEvent.click(valueGroup(label).querySelector(`button[role="radio"][value="${value}"]`) as HTMLButtonElement);
}

/** 지금 고른 값 (없으면 null) */
function chosen(label: "모델" | "수준"): string | null {
  return (valueGroup(label).querySelector('button[aria-checked="true"]') as HTMLButtonElement | null)?.value ?? null;
}

function applyBar() {
  return document.querySelector(".ed-apply") as HTMLElement;
}

async function applyNow() {
  fireEvent.click(within(applyBar()).getByRole("button", { name: "적용" }));
}

async function tab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
}

async function dialog() {
  return await screen.findByRole("dialog");
}

describe("틀 · 목록", () => {
  it("왼쪽 메뉴에서 「내 수정」이 현재 자리이고, 탭 셋과 제목 · 한 줄 설명이 있다 — 원본 바뀜 탭에는 숫자", async () => {
    await mount();
    const nav = screen.getByRole("navigation", { name: "탐색" });
    expect(within(nav).getByRole("button", { name: "내 수정" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "내 수정" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+개?$/, ""))).toEqual(["에이전트 · 스킬", "기록", "원본 바뀜"]);
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).toHaveTextContent("1");
    expect(screen.getByText(/에이전트 · 스킬을 내 마음대로/)).toBeInTheDocument();
  });

  it("묶음 · 개수 · 한국어 이름 · 표시 칩 — 오케스트레이터 · 작업자는 화면들이 쓰는 이름, 그 밖은 파일의 name", async () => {
    await mount();
    const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
    for (const group of ["오케스트레이터", "에이전트", "스킬"]) expect(within(list).getByRole("heading", { name: new RegExp(group) })).toBeInTheDocument();
    const names = within(list)
      .getAllByText(/./, { selector: ".ed-item__name" })
      .map((el) => el.textContent);
    expect(names.slice(0, 8)).toEqual(["오케스트레이터", "디자이너", "화면 구현", "시스템 구현", "시험", "정리", "점검", "번역"]);
    expect(names).toContain("desktop-app");
    const designer = within(list).getByText("디자이너", { selector: ".ed-item__name" }).closest("button")!;
    expect(within(designer).getByText("통째로")).toBeInTheDocument();
    expect(within(designer).getByText("원본 바뀜")).toBeInTheDocument();
    const ui = within(list).getByText("화면 구현", { selector: ".ed-item__name" }).closest("button")!;
    expect(within(ui).getByText("값 바꿈")).toBeInTheDocument();
    expect(within(ui).getByText("덧붙임")).toBeInTheDocument();
    expect(within(list).getByText("번역", { selector: ".ed-item__name" }).closest("button")!).toHaveTextContent("내가 만듦");
  });

  it("목록 묶음은 이름 붙은 영역이 아니라 묶음이고 제목은 h1 다음 h2 — 오케스트레이터를 골라도 영역 이름이 겹치지 않는다 (D-55)", async () => {
    await mount();
    const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
    expect(within(list).queryAllByRole("region")).toHaveLength(0);
    for (const group of ["오케스트레이터", "에이전트", "스킬"]) {
      const head = within(list).getByRole("heading", { name: new RegExp(`^${group}`) });
      expect(head.tagName).toBe("H2");
      expect(within(list).getByRole("group", { name: new RegExp(`^${group}`) })).toBeInTheDocument();
    }
    // 오케스트레이터 상세 — 제목이 묶음 이름과 같아도 영역 이름은 하나씩
    await pick("오케스트레이터");
    const names = screen.getAllByRole("region").map((el) => el.getAttribute("aria-label") ?? document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent ?? "");
    expect(new Set(names).size).toBe(names.length);
    const levels = screen.getAllByRole("heading").map((h) => Number(h.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    levels.forEach((level, at) => expect(at === 0 || level <= levels[at - 1]! + 1).toBe(true));
  });

  it("찾기 칸은 이름 · 파일로 거른다 — 없으면 안내", async () => {
    await mount();
    const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
    fireEvent.change(within(list).getByRole("searchbox", { name: "이름 · 파일 찾기" }), { target: { value: "builder-system" } });
    expect(within(list).getAllByText(/./, { selector: ".ed-item__name" }).map((el) => el.textContent)).toEqual(["시스템 구현"]);
    fireEvent.change(within(list).getByRole("searchbox"), { target: { value: "없는이름" } });
    expect(within(list).getByText("찾는 항목이 없어요")).toBeInTheDocument();
  });

  it("목록은 화살표로 옮기며 고른다 (Tab 으로는 하나만 들어간다)", async () => {
    await mount();
    const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
    const buttons = within(list).getAllByRole("button").filter((b) => b.classList.contains("ed-item"));
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
    await waitFor(() => expect(document.getElementById("ed-panel-title")).toHaveTextContent(/^디자이너/));
    expect(buttons[1]).toHaveFocus();
    expect(buttons[1]).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(buttons[1]!, { key: "End" });
    expect(last(buttons)).toHaveFocus();
    fireEvent.keyDown(last(buttons), { key: "Home" });
    expect(buttons[0]).toHaveFocus();
  });

  it("탭은 좌우 화살표로 옮긴다", async () => {
    await mount();
    const first = screen.getByRole("tab", { name: /^에이전트/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "기록" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "기록" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "기록" }), { key: "ArrowLeft" });
    expect(first).toHaveAttribute("aria-selected", "true");
  });

  it("집으로 가기 — 왼쪽 메뉴", async () => {
    const { onGo } = await mount();
    fireEvent.click(within(screen.getByRole("navigation", { name: "탐색" })).getByRole("button", { name: "집" }));
    await waitFor(() => expect(onGo).toHaveBeenCalledWith("house"));
  });
});

describe("상세 — 값 · 덧붙임 · 원본 보기", () => {
  it("값을 바꾸면 바로 저장 → 적용 안 한 것 1개 → 적용 → 「모두 적용됨」 · 기록 맨 위에 요약 한 줄", async () => {
    await mount();
    expect(within(applyBar()).getByText("모두 적용됨")).toBeInTheDocument();
    await pick("시험");
    choose("수준", "high");
    await waitFor(() => expect(within(applyBar()).getByText("적용 안 한 것 1개")).toBeInTheDocument(), WAIT);
    // 바뀌는 것 — 새 값 파일
    expect(await screen.findByText("agents/harness-tester.values.yml")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "원본 값으로" })).toBeInTheDocument();
    await applyNow();
    await within(applyBar()).findByText(/^적용했어요 — 기록 [0-9a-f]{7}$/, undefined, WAIT);
    expect(within(applyBar()).getByText("모두 적용됨")).toBeInTheDocument();
    await tab("기록");
    // 기록 탭은 숨은 채 붙어 있어, 적용 뒤 다시 읽기 전에는 옛 「지금」 줄이 잠깐 남는다 — 새 줄이 올 때까지 기다린다
    await waitFor(() => expect(screen.getAllByRole("button", { name: /지금/ })[0]).toHaveTextContent("시험 — 수준을 높음으로"), WAIT);
  });

  it("원본 값과 같게 고르면 원본 값으로 — 값 바꿈 표시가 사라진다", async () => {
    await mount();
    await pick("화면 구현");
    // 처음: 수준 high (내 값), 원본 medium
    expect(chosen("수준")).toBe("high");
    fireEvent.click(screen.getByRole("button", { name: "원본 값으로" }));
    await waitFor(() => expect(chosen("수준")).toBe("medium"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "원본 값으로" })).not.toBeInTheDocument(), WAIT);
    await waitFor(() => expect(within(applyBar()).getByText("적용 안 한 것 1개")).toBeInTheDocument(), WAIT);
    const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
    expect(within(within(list).getByText("화면 구현", { selector: ".ed-item__name" }).closest("button")!).queryByText("값 바꿈")).not.toBeInTheDocument();
  });

  it("오케스트레이터는 값만 있고 덧붙임 · 원본 보기가 없다", async () => {
    await mount();
    await pick("오케스트레이터");
    expect(chosen("모델")).toBe("opus");
    expect(screen.queryByRole("heading", { name: "덧붙일 지시" })).not.toBeInTheDocument();
    expect(screen.queryByText("원본 보기")).not.toBeInTheDocument();
    choose("모델", "sonnet");
    await waitFor(() => expect(within(applyBar()).getByText("적용 안 한 것 1개")).toBeInTheDocument(), WAIT);
  });

  it("덧붙임은 쓰다가 1초 쉬면 자동 저장 — 저장됨 표시와 적용 안 한 것", async () => {
    await mount();
    await pick("정리");
    expect(screen.getByRole("heading", { name: /덧붙일 지시/ })).toBeInTheDocument();
    type("- 정리한 것은 한 줄로 알린다.");
    expect(await screen.findByText("저장 안 됨")).toBeInTheDocument();
    await screen.findByText(/^저장됨 \d\d:\d\d$/, undefined, WAIT);
    await waitFor(() => expect(within(applyBar()).getByText("적용 안 한 것 1개")).toBeInTheDocument(), WAIT);
    const read = await ipc.customItemRead("agent:harness-helper");
    expect(appendTextOf(read)).toBe("- 정리한 것은 한 줄로 알린다.");
  });

  it("Ctrl+S 는 기다리지 않고 바로 저장하고, 빈 글은 덧붙임을 지운다", async () => {
    await mount();
    await pick("시험");
    type("");
    fireEvent.keyDown(document.querySelector(".cm-content")!, { key: "s", ctrlKey: true });
    await screen.findByText(/^저장됨 \d\d:\d\d$/, undefined, WAIT);
    const read = await ipc.customItemRead("agent:harness-tester");
    expect(read.state === "ok" && read.appendText).toEqual({ state: "absent" });
  });

  it("원본 보기를 펴면 원본 글이 읽기 전용으로 보인다", async () => {
    await mount();
    await pick("정리");
    const origin = screen.getByText("원본 보기").closest("details")!;
    expect(origin).not.toHaveAttribute("open");
    fireEvent.click(within(origin).getByText("원본 보기"));
    expect(within(origin).getByText(/name: harness-helper/)).toBeInTheDocument();
  });

  it("저장이 거절되면 그 칸 아래에 쉬운 말 — 모르는 이유는 코드 그대로", async () => {
    await mount();
    await pick("정리");
    vi.spyOn(ipc, "customAppendSave").mockResolvedValueOnce({ outcome: "refused", reason: "too_large", detail: null, changed: false, notOurs: false });
    type("글");
    expect(await screen.findByText(/저장하지 못했어요\. 글이 너무 커요/, undefined, WAIT)).toBeInTheDocument();
    vi.spyOn(ipc, "customAppendSave").mockResolvedValueOnce({ outcome: "refused", reason: "something_new", detail: null, changed: false, notOurs: false });
    fireEvent.click(screen.getByRole("button", { name: "다시 저장" }));
    expect(await screen.findByText(/저장하지 못했어요\. something_new/, undefined, WAIT)).toBeInTheDocument();
  });
});

describe("상세 — 통째로 바꾸기 · 내가 만든 것", () => {
  it("통째로 바꾸기는 확인 대화상자를 거쳐 시작한다 — 취소하면 그대로", async () => {
    await mount();
    await pick("정리");
    const origin = screen.getByText("원본 보기").closest("details")!;
    fireEvent.click(within(origin).getByText("원본 보기"));
    fireEvent.click(within(origin).getByRole("button", { name: "통째로 바꾸기" }));
    let box = await dialog();
    expect(within(box).getByText(/원본이 바뀌어도 내 것을 쓰고/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText("이 파일은 통째로 바꿨어요")).not.toBeInTheDocument();

    fireEvent.click(within(origin).getByRole("button", { name: "통째로 바꾸기" }));
    box = await dialog();
    fireEvent.click(within(box).getByRole("button", { name: "통째로 바꾸기" }));
    expect(await screen.findByText("이 파일은 통째로 바꿨어요", undefined, WAIT)).toBeInTheDocument();
    expect(valueOf(screen.getByRole("textbox", { name: "파일 전체" }))).toContain("name: harness-helper");
    await waitFor(() => expect(within(applyBar()).getByText("적용 안 한 것 2개")).toBeInTheDocument(), WAIT);
  });

  it("통째로 바꾼 파일 — 경고 띠 · 원본 바뀜 띠(골라 보기 → 원본 바뀜 탭) · 파일 전체 · 덧붙이기로 돌아가기(확인)", async () => {
    await mount();
    await pick("디자이너");
    expect(screen.getByText("이 파일은 통째로 바꿨어요")).toBeInTheDocument();
    expect(screen.getByText("원본이 바뀌었어요 — 아직 고르지 않았어요")).toBeInTheDocument();
    expect(valueOf(screen.getByRole("textbox", { name: "파일 전체" }))).toContain("name: harness-designer");
    // 모델 · 수준 · 덧붙임 칸도 그대로 있다
    expect(valueGroup("모델")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "골라 보기" }));
    expect(await screen.findByRole("heading", { level: 2, name: "디자이너 — 원본이 바뀌었어요" })).toBeInTheDocument();
    await tab("에이전트 · 스킬");
    fireEvent.click(screen.getByRole("button", { name: "덧붙이기로 돌아가기" }));
    const box = await dialog();
    expect(within(box).getByText(/통째로 바꾼 글은 이 폴더에서 사라지고/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "덧붙이기로 돌아가기" }));
    await waitFor(() => expect(screen.queryByText("이 파일은 통째로 바꿨어요")).not.toBeInTheDocument(), WAIT);
    expect(screen.queryByRole("textbox", { name: "파일 전체" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(applyBar()).getByText(/^적용 안 한 것 \d개$/)).toBeInTheDocument(), WAIT);
  });

  it("파일 전체는 자동 저장 — 거절(둘째 줄 name 이 다름)이면 이유가 그 칸 아래에", async () => {
    await mount();
    await pick("디자이너");
    const box = screen.getByRole("textbox", { name: "파일 전체" });
    fireEvent.change(box, { target: { value: "---\nname: 다른이름\ndescription: x\n---\n\n본문\n" } });
    expect(await screen.findByText(/저장하지 못했어요\. 둘째 줄은 name: 이름/, undefined, WAIT)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "---\nname: harness-designer\ndescription: 새 소개\nmodel: opus\neffort: high\n---\n\n본문 새로\n" } });
    await screen.findByText(/^저장됨 \d\d:\d\d$/, undefined, WAIT);
    const read = await ipc.customItemRead("agent:harness-designer");
    expect(read.state === "ok" && read.replaceText.state === "text" && read.replaceText.text).toContain("본문 새로");
  });

  it("내가 만든 것 — 안내 · 파일 전체 · 덧붙임 칸 없음 · 지우기(확인)로 목록에서 사라진다", async () => {
    await mount();
    await pick("번역");
    expect(screen.getByText("내가 만든 파일이에요")).toBeInTheDocument();
    expect(valueOf(screen.getByRole("textbox", { name: "파일 전체" }))).toContain("name: translator");
    expect(screen.queryByRole("heading", { name: /덧붙일 지시/ })).not.toBeInTheDocument();
    expect(screen.queryByText("원본 보기")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "지우기" }));
    const box = await dialog();
    fireEvent.click(within(box).getByRole("button", { name: "지우기" }));
    await waitFor(() => {
      const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
      expect(within(list).queryByText("번역", { selector: ".ed-item__name" })).not.toBeInTheDocument();
    }, WAIT);
    await waitFor(() => expect(within(applyBar()).getByText(/^적용 안 한 것 \d개$/)).toBeInTheDocument(), WAIT);
  });

  it("내가 만든 것의 모델을 바꾸면 파일은 새로 읽혀도 포커스는 같은 칸에 남는다 (D-55)", async () => {
    await mount();
    await pick("번역");
    const opus = valueGroup("모델").querySelector('button[value="opus"]') as HTMLButtonElement;
    opus.focus();
    fireEvent.click(opus);
    // 앞머리가 바뀐 파일이 편집 칸에 새로 보인다 (새로 읽음)
    await waitFor(() => expect(valueOf(screen.getByRole("textbox", { name: "파일 전체" }))).toContain("model: opus"), WAIT);
    await waitFor(() => expect(document.activeElement).toBe(valueGroup("모델").querySelector('button[value="opus"]')), WAIT);
    expect(document.activeElement).toHaveAttribute("aria-checked", "true");
    expect(chosen("모델")).toBe("opus");
  });

  it("모델 줄 — 화살표 · Home · End 는 칸만 옮기고 저장하지 않는다 · Tab 한 칸 (D-55)", async () => {
    await mount();
    await pick("화면 구현");
    const save = vi.spyOn(ipc, "customValuesSave");
    const group = valueGroup("모델");
    const radios = within(group).getAllByRole("radio");
    expect(radios.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);
    const before = chosen("모델");
    radios[0]!.focus();
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1]!.tabIndex).toBe(0);
    expect(radios[0]!.tabIndex).toBe(-1);
    fireEvent.keyDown(radios[1]!, { key: "End" });
    expect(document.activeElement).toBe(radios[radios.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[0]);
    fireEvent.keyDown(radios[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[radios.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    expect(save).not.toHaveBeenCalled();
    expect(chosen("모델")).toBe(before);
  });

  it("모델 줄 — 클릭 · Enter · Space(단추의 누름)는 저장한다", async () => {
    await mount();
    await pick("화면 구현");
    const save = vi.spyOn(ipc, "customValuesSave");
    choose("모델", "opus");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), WAIT);
    await waitFor(() => expect(chosen("모델")).toBe("opus"), WAIT);
    // 단추에서 Enter · Space 를 누르면 브라우저가 click 을 보낸다 — 키 처리는 그것을 가로채지 않는다
    const sonnet = valueGroup("모델").querySelector('button[value="sonnet"]') as HTMLButtonElement;
    const enter = fireEvent.keyDown(sonnet, { key: "Enter" });
    const space = fireEvent.keyDown(sonnet, { key: " " });
    expect(enter && space).toBe(true);
    fireEvent.click(sonnet);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), WAIT);
  });
});

describe("적용 바", () => {
  it("적용 안 한 것을 버리면(확인) 마지막으로 적용한 모습으로 돌아간다", async () => {
    await mount("dirty");
    expect(within(applyBar()).getByText("적용 안 한 것 2개")).toBeInTheDocument();
    fireEvent.click(within(applyBar()).getByRole("button", { name: "되돌리기" }));
    const box = await dialog();
    expect(within(box).getByText("적용 안 한 것 2개를 버릴까요?")).toBeInTheDocument();
    // 취소
    fireEvent.click(within(box).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(within(applyBar()).getByText("적용 안 한 것 2개")).toBeInTheDocument();
    fireEvent.click(within(applyBar()).getByRole("button", { name: "되돌리기" }));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "버리기" }));
    await within(applyBar()).findByText("모두 적용됨", undefined, WAIT);
    expect(within(applyBar()).getByText(/적용 안 한 것을 버렸어요 — 파일 2개/)).toBeInTheDocument();
  });

  it("여러 항목을 고치면 요약은 「<첫 이름> 외 n개」", async () => {
    await mount("dirty");
    const spy = vi.spyOn(ipc, "customApply");
    await applyNow();
    await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
    expect(spy).toHaveBeenCalledWith("정리 외 1개");
  });

  it("적용이 실패하면 쉬운 말로 이유 · 적용 안 한 것은 그대로 · 기록은 안 생긴다", async () => {
    await mount("dirty");
    fakeCustom.failNextInstall();
    await applyNow();
    const alert = await within(applyBar()).findByRole("alert", undefined, WAIT);
    expect(within(alert).getByText("적용하지 못했어요")).toBeInTheDocument();
    expect(within(alert).getByText(/값 파일 모양이 올바르지 않아요 — agents\/harness-builder-ui\.values\.yml/)).toBeInTheDocument();
    expect(within(alert).getByText("적용 안 한 것은 그대로 남아 있어요.")).toBeInTheDocument();
    expect(within(applyBar()).getByText("적용 안 한 것 2개")).toBeInTheDocument();
    expect((await ipc.customHistory()).commits[0]?.kind).toBe("origin_update");
    // 다시 하면 된다
    await applyNow();
    await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
  });

  it("커밋만 실패하면 「반영은 됐지만 기록을 못 남겼어요」", async () => {
    await mount("dirty");
    vi.spyOn(ipc, "customApply").mockResolvedValueOnce({ outcome: "applied", script: null, commit: "failed", commitShort: null, files: 2, detail: "git 이 멈췄어요" });
    await applyNow();
    expect(await within(applyBar()).findByText("반영은 됐지만 기록을 못 남겼어요", undefined, WAIT)).toBeInTheDocument();
    expect(within(applyBar()).getByText("git 이 멈췄어요")).toBeInTheDocument();
  });

  it("다시 시작해야 하면 알려 준다", async () => {
    await mount("dirty");
    const real = ipc.customApply.bind(ipc);
    vi.spyOn(ipc, "customApply").mockImplementationOnce(async (summary) => {
      const result = await real(summary);
      if (result.script?.report) result.script.report.restartNeeded = true;
      return result;
    });
    await applyNow();
    expect(await within(applyBar()).findByText("열려 있는 Claude Code 를 다시 시작해야 해요", undefined, WAIT)).toBeInTheDocument();
  });

  it("적용 중에는 단추가 잠기고 진행 표시가 보인다", async () => {
    await mount("dirty");
    let release: () => void = () => undefined;
    const real = ipc.customApply.bind(ipc);
    vi.spyOn(ipc, "customApply").mockImplementationOnce(
      (summary) =>
        new Promise((resolve) => {
          release = () => void real(summary).then(resolve);
        }),
    );
    await applyNow();
    expect(await within(applyBar()).findByRole("progressbar", { name: /적용하는 중/ })).toBeInTheDocument();
    expect(within(applyBar()).getByRole("button", { name: "적용" })).toBeDisabled();
    expect(within(applyBar()).getByRole("button", { name: "되돌리기" })).toBeDisabled();
    release();
    await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
    expect(within(applyBar()).queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("바뀌는 것 — 적용 안 한 파일마다 줄 차이", async () => {
    await mount("dirty");
    await pick("화면 구현");
    const section = (await screen.findByRole("heading", { name: /적용하면 바뀌는 것/ })).closest("section")!;
    expect(within(section).getByText("agents/harness-helper.values.yml")).toBeInTheDocument();
    expect(within(section).getByText("agents/harness-reviewer.append.md")).toBeInTheDocument();
    expect(within(section).getByRole("region", { name: "agents/harness-helper.values.yml" })).toHaveTextContent("model: sonnet");
  });

  it("아래 줄에 P9-03 이 붙일 자리 — 머리 줄 오른쪽(headActions) · 적용 바 왼쪽(itemActions, 고른 항목 정보와 함께)", async () => {
    const itemActions = vi.fn((item) => <button type="button">{item ? `고양이 ${item.id}` : "없음"}</button>);
    await mount("full", { headActions: () => <button type="button">새로 만들기 자리</button>, itemActions });
    expect(screen.getByRole("button", { name: "새로 만들기 자리" })).toBeInTheDocument();
    expect(within(applyBar()).getByRole("button", { name: "고양이 main" })).toBeInTheDocument();
    await pick("시험");
    expect(within(applyBar()).getByRole("button", { name: "고양이 agent:harness-tester" })).toBeInTheDocument();
  });
});

describe("기록 탭", () => {
  it("적용 안 한 것이 없으면 기록 · 원본 바뀜 탭에는 적용 바가 없다 (비교 칸이 좁아지지 않게)", async () => {
    await mount();
    expect(applyBar()).not.toBeNull();
    await tab("기록");
    await waitFor(() => expect(applyBar()).toBeNull());
    await tab("원본 바뀜");
    expect(applyBar()).toBeNull();
    await tab("에이전트 · 스킬");
    expect(applyBar()).not.toBeNull();
  });

  it("세로 줄 기록 — 최신이 맨 위(「지금」), 메시지 · 언제 · 짧은 번호, 고르면 그 커밋의 차이", async () => {
    await mount();
    await tab("기록");
    const list = await screen.findByRole("navigation", { name: "기록" });
    const items = within(list).getAllByRole("button");
    expect(items[0]).toHaveTextContent("원본 업데이트 받음 (7c41e2a)");
    expect(within(items[0]!).getByText("지금")).toBeInTheDocument();
    expect(last(items)).toHaveTextContent("처음 기록");
    expect(items[1]).toHaveTextContent(/11월 5일 · [0-9a-f]{7}/);
    fireEvent.click(within(list).getByRole("button", { name: /빌더 UI 수준 높임/ }));
    expect(await screen.findByRole("heading", { level: 2, name: "빌더 UI 수준 높임 · 지시 덧붙임" })).toBeInTheDocument();
    expect(await screen.findByText("agents/harness-builder-ui.values.yml")).toBeInTheDocument();
    // 「지금」 커밋에는 되돌리기 단추가 없다
    fireEvent.click(items[0]!);
    expect(await screen.findByText("원본 업데이트를 받은 기록이에요. 내 수정 파일은 바뀌지 않았어요.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이때로 되돌리기" })).not.toBeInTheDocument();
  });

  it("이때로 되돌리기 — 확인 띠 → 새 기록 · 되돌렸어요", async () => {
    await mount();
    await tab("기록");
    const list = await screen.findByRole("navigation", { name: "기록" });
    fireEvent.click(within(list).getByRole("button", { name: /테스터 지시 덧붙임/ }));
    fireEvent.click(await screen.findByRole("button", { name: "이때로 되돌리기" }));
    expect(await screen.findByText(/때로 되돌릴까요\?/)).toBeInTheDocument();
    expect(screen.getByText(/그 뒤에 한 수정이 모두 빠져요/)).toBeInTheDocument();
    const before = (await ipc.customHistory()).commits.length;
    fireEvent.click(within(confirmBand()).getByRole("button", { name: "되돌리기" }));
    expect(await screen.findByText(/때로 되돌렸어요 — 새 기록이 생겼어요/, undefined, WAIT)).toBeInTheDocument();
    await waitFor(async () => expect((await ipc.customHistory()).commits.length).toBe(before + 1), WAIT);
    // 맨 위가 새 기록 (되돌림)
    await waitFor(() => expect(within(screen.getByRole("navigation", { name: "기록" })).getAllByRole("button")[0]).toHaveTextContent(/때로 되돌림/), WAIT);
  });

  it("적용 안 한 것이 있으면 되돌려지지 않고 먼저 적용하거나 버리라고 알린다", async () => {
    await mount("dirty");
    await tab("기록");
    const list = await screen.findByRole("navigation", { name: "기록" });
    fireEvent.click(within(list).getByRole("button", { name: /테스터 지시 덧붙임/ }));
    fireEvent.click(await screen.findByRole("button", { name: "이때로 되돌리기" }));
    fireEvent.click(within(confirmBand()).getByRole("button", { name: "되돌리기" }));
    expect(await screen.findByText("적용 안 한 것이 있어요 — 먼저 적용하거나 되돌리기(버리기) 해 주세요", undefined, WAIT)).toBeInTheDocument();
  });

  it("지금과 같은 모습이면 「지금과 같아요」", async () => {
    await mount();
    await tab("기록");
    const list = await screen.findByRole("navigation", { name: "기록" });
    // 맨 위(원본 업데이트 받음, 빈 커밋)의 바로 아래가 지금과 같은 모습이다
    fireEvent.click(within(list).getAllByRole("button")[1]!.closest("li")!.querySelector("button")!);
    const first = within(list).getAllByRole("button")[0]!;
    expect(first).toBeInTheDocument();
    const second = within(list).getAllByRole("button")[1]!;
    fireEvent.click(second);
    fireEvent.click(await screen.findByRole("button", { name: "이때로 되돌리기" }));
    fireEvent.click(within(confirmBand()).getByRole("button", { name: "되돌리기" }));
    expect(await screen.findByText("지금과 같아요", undefined, WAIT)).toBeInTheDocument();
  });

  it("되돌리다 설치가 실패하면 적용 실패와 같은 표시 — 기록은 그대로", async () => {
    await mount();
    await tab("기록");
    const list = await screen.findByRole("navigation", { name: "기록" });
    fireEvent.click(within(list).getByRole("button", { name: /테스터 지시 덧붙임/ }));
    fireEvent.click(await screen.findByRole("button", { name: "이때로 되돌리기" }));
    fakeCustom.failNextInstall();
    fireEvent.click(within(confirmBand()).getByRole("button", { name: "되돌리기" }));
    const alert = await screen.findByRole("alert", undefined, WAIT);
    expect(within(alert).getByText("되돌리지 못했어요")).toBeInTheDocument();
    expect(within(alert).getByText(/값 파일 모양이 올바르지 않아요/)).toBeInTheDocument();
    expect((await ipc.customHistory()).commits[0]?.kind).toBe("origin_update");
  });

  it("git 이 없으면(no_git) · 아직 시작 전이면(not_started) 그 사정만 알린다", async () => {
    await mount("no_git");
    await tab("기록");
    expect(await screen.findByText("git 이 없어 기록을 남기지 못해요 — 고치기 · 적용은 돼요.")).toBeInTheDocument();
    cleanup();
    await mount("fresh");
    await tab("기록");
    expect(await screen.findByText("아직 기록이 없어요 — 처음 저장할 때 시작해요.")).toBeInTheDocument();
  });

  it("기록이 200개를 넘으면 끝에 한 줄", async () => {
    await mount();
    const real = await ipc.customHistory();
    vi.spyOn(ipc, "customHistory").mockResolvedValue({ ...real, truncated: true });
    cleanup();
    fakeCustom.reset("full");
    render(<EditScreen onGo={() => undefined} clock={() => NOW} />);
    await tab("기록");
    expect(await screen.findByText(/더 오래된 기록은 가장 최근 \d+개까지만 보여요/)).toBeInTheDocument();
  });
});

describe("원본 바뀜 탭", () => {
  it("원본이 바뀐 통째 파일만 — 내 것과 원본 다른 점 한 가지, 원본 쪽 − · 내 것 쪽 +", async () => {
    await mount();
    await tab("원본 바뀜");
    const list = await screen.findByRole("navigation", { name: "고를 파일" });
    expect(within(list).getByText("디자이너")).toBeInTheDocument();
    expect(within(list).getByText("고르기 전")).toBeInTheDocument();
    expect(screen.getByText("고르기 전까지는 내 것을 그대로 써요")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "내 것과 원본 다른 점" })).toBeInTheDocument();
    // 원본 옛 판 비교나 업데이트 보기는 없다
    expect(screen.queryByText("원본에서 바뀐 것")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "업데이트 보기" })).not.toBeInTheDocument();
    const diff = document.querySelector(".ed-dif") as HTMLElement;
    expect(diff.querySelectorAll(".ed-dif__line[data-sign=add]").length).toBeGreaterThan(0);
    expect(diff.querySelectorAll(".ed-dif__line[data-sign=del]").length).toBeGreaterThan(0);
    expect(screen.getByText("고른 것은 적용 안 한 것에 더해져요 — 적용하면 기록에 남아요.")).toBeInTheDocument();
  });

  it("내 것 유지 → 탭 숫자가 줄고 적용 안 한 것이 생긴다 — 적용하면 기록에 남는다", async () => {
    await mount();
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).toHaveTextContent("1");
    await tab("원본 바뀜");
    fireEvent.click(await screen.findByRole("button", { name: "내 것 유지" }));
    expect(await screen.findByText(/디자이너 — 내 것을 유지했어요/, undefined, WAIT)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: /원본 바뀜/ })).not.toHaveTextContent("1"), WAIT);
    expect(await screen.findByText("원본이 바뀐 통째 파일이 없어요")).toBeInTheDocument();
    await waitFor(() => expect(within(applyBar()).getByText(/^적용 안 한 것 \d개$/)).toBeInTheDocument(), WAIT);
    await applyNow();
    await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
    // 기록 요약: 디자이너 — 원본 바뀜에서 고름
    expect((await ipc.customHistory()).commits[0]?.message).toBe("디자이너 — 원본 바뀜에서 고름");
  });

  it("원본으로 바꾸기는 확인을 거친다 — 통째 글은 사라지고 항목은 목록의 통째로 표시가 빠진다", async () => {
    await mount();
    await tab("원본 바뀜");
    fireEvent.click(await screen.findByRole("button", { name: "원본으로 바꾸기" }));
    const box = await dialog();
    expect(within(box).getByText(/내가 통째로 바꾼 글이 사라지고 원본을 써요/)).toBeInTheDocument();
    fireEvent.click(within(box).getByRole("button", { name: "원본으로 바꾸기" }));
    expect(await screen.findByText(/디자이너 — 원본으로 바꿨어요/, undefined, WAIT)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("tab", { name: /원본 바뀜/ })).not.toHaveTextContent("1"), WAIT);
    await tab("에이전트 · 스킬");
    const list = screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" });
    expect(within(within(list).getByText("디자이너", { selector: ".ed-item__name" }).closest("button")!).queryByText("통째로")).not.toBeInTheDocument();
  });

  it("원본에서 파일이 사라졌으면 비교 대신 안내 — 「원본으로 바꾸기」는 없다", async () => {
    fakeCustom.reset("full");
    const read = await ipc.customItemRead("agent:harness-designer");
    if (read.state !== "ok") throw new Error("읽기 실패");
    vi.spyOn(ipc, "customItemRead").mockResolvedValue({ ...read, originGone: true });
    render(<EditScreen onGo={() => undefined} clock={() => NOW} />);
    await screen.findByRole("navigation", { name: "에이전트 · 스킬 목록" });
    await tab("원본 바뀜");
    expect(await screen.findByText(/원본에서 이 파일이 없어졌어요\. 그대로 쓰려면/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "원본으로 바꾸기" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "내 것 유지" })).toBeInTheDocument();
  });

  it("원본이 또 바뀌면(simulateOriginUpdate) 다시 나타난다", async () => {
    await mount();
    await tab("원본 바뀜");
    fireEvent.click(await screen.findByRole("button", { name: "내 것 유지" }));
    await screen.findByText("원본이 바뀐 통째 파일이 없어요", undefined, WAIT);
    fakeCustom.simulateOriginUpdate();
    cleanup();
    await mount("full");
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).toBeInTheDocument();
  });
});

describe("상태 — 읽는 중 · 하네스 없음 · 잠김 · 오류 · git 없음 · 기록 시작 전", () => {
  it("읽는 중에는 안내 한 줄", async () => {
    vi.spyOn(ipc, "customList").mockReturnValue(new Promise(() => undefined));
    render(<EditScreen onGo={() => undefined} clock={() => NOW} />);
    expect(await screen.findByText("내 수정을 읽는 중…")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^에이전트/ })).toBeInTheDocument();
  });

  it("하네스가 없으면(no_source) 한 화면 안내", async () => {
    fakeCustom.reset("no_source");
    render(<EditScreen onGo={() => undefined} clock={() => NOW} />);
    expect(await screen.findByText("하네스가 아직 설치되지 않았어요")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "에이전트 · 스킬 목록" })).not.toBeInTheDocument();
  });

  it("다른 하네스 일이 도는 중이면(harness_busy) 띠 + 다시 시도", async () => {
    vi.spyOn(ipc, "customList").mockRejectedValueOnce(new AppError("harness_busy", "x"));
    fakeCustom.reset();
    render(<EditScreen onGo={() => undefined} clock={() => NOW} />);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("다른 하네스 일이 끝나면 다시 해 주세요")).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "다시 시도" }));
    await screen.findByRole("navigation", { name: "에이전트 · 스킬 목록" });
  });

  it("값을 저장하다 잠겨 있으면 위 띠로 알리고 다시 시도하면 읽는다", async () => {
    await mount();
    await pick("시험");
    vi.spyOn(ipc, "customValuesSave").mockRejectedValueOnce(new AppError("harness_busy", "x"));
    choose("수준", "high");
    const band = (await screen.findAllByText("다른 하네스 일이 끝나면 다시 해 주세요", undefined, WAIT)).map((el) => el.closest(".ed-bnr")).find(Boolean) as HTMLElement;
    expect(band).toHaveAttribute("role", "status");
    fireEvent.click(within(band).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(document.querySelector(".ed-problem")).toBeNull());
  });

  it("그 밖의 오류는 그 이유 한 줄 — 파일 쓰기 실패 등", async () => {
    await mount();
    await pick("시험");
    vi.spyOn(ipc, "customValuesSave").mockRejectedValueOnce(new AppError("file_write_failed", "x"));
    choose("모델", "opus");
    const alert = await screen.findByRole("alert", undefined, WAIT);
    expect(within(alert).getByText(/파일에 쓰지 못했어요/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole("button", { name: "알겠어요" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("git 이 없으면(no_git) 고치기 · 적용은 되고 적용 안 한 것은 세지 않는다", async () => {
    await mount("no_git");
    expect(within(applyBar()).getByText("git 이 없어 적용 안 한 것을 세지 못해요")).toBeInTheDocument();
    expect(within(applyBar()).getByRole("button", { name: "되돌리기" })).toBeDisabled();
    await pick("시험");
    choose("수준", "high");
    await waitFor(() => expect(chosen("수준")).toBe("high"));
    await applyNow();
    expect(await within(applyBar()).findByText("적용했어요 (git 이 없어 기록은 남기지 않았어요)", undefined, WAIT)).toBeInTheDocument();
  });

  it("기록 시작 전(fresh) — 처음 저장하면 기록이 시작되고 적용 안 한 것이 된다", async () => {
    await mount("fresh");
    await pick("시험");
    choose("수준", "high");
    await waitFor(() => expect(within(applyBar()).getByText("적용 안 한 것 1개")).toBeInTheDocument(), WAIT);
  });

  it("읽을 수 없는 항목은 흐리게 + 이유, 골라도 안내만 나온다", async () => {
    await mount();
    const real = await ipc.customList();
    const items = real.items.map((entry) =>
      entry.id === "agent:harness-helper" && entry.state === "ok" ? ({ state: "unreadable", id: entry.id, kind: entry.kind, name: entry.name, file: entry.file, reason: "bad_values" } as const) : entry,
    );
    vi.spyOn(ipc, "customList").mockResolvedValue({ ...real, items });
    cleanup();
    fakeCustom.reset("full");
    render(<EditScreen onGo={() => undefined} clock={() => NOW} />);
    const list = await screen.findByRole("navigation", { name: "에이전트 · 스킬 목록" });
    const row = (await within(list).findByText("정리", { selector: ".ed-item__name" })).closest("button")!;
    expect(row).toHaveAttribute("data-unreadable", "true");
    expect(within(row).getByText("읽을 수 없음")).toBeInTheDocument();
    expect(within(row).getByText("값 파일 모양이 올바르지 않아요.")).toBeInTheDocument();
    fireEvent.click(row);
    expect(await screen.findByText("이 파일은 읽을 수 없어요")).toBeInTheDocument();
  });
});

describe("저장 뒤의 사정", () => {
  it("저장 결과가 notOurs 면 알림 띠 — ~/.claude 의 내 파일을 설치가 건너뛴다", async () => {
    await mount();
    await pick("정리");
    vi.spyOn(ipc, "customAppendSave").mockResolvedValueOnce({ outcome: "saved", reason: null, detail: null, changed: false, notOurs: true });
    type("- 글");
    expect(await screen.findByText("~/.claude 에 같은 이름의 내 파일이 이미 있어요", undefined, WAIT)).toBeInTheDocument();
  });

  it("저장 뒤 다시 읽다가 잠겨도 읽어 둔 목록은 그대로 두고 띠로만 알린다", async () => {
    await mount();
    await pick("시험");
    vi.spyOn(ipc, "customList").mockRejectedValueOnce(new AppError("harness_busy", "x"));
    choose("수준", "high");
    expect((await screen.findAllByText("다른 하네스 일이 끝나면 다시 해 주세요", undefined, WAIT)).length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "에이전트 · 스킬 목록" })).toBeInTheDocument();
    expect(chosen("수준")).toBe("high");
  });

  it("값을 바꾸자마자 적용을 눌러도 값 저장이 끝나기를 기다렸다가 적용한다 (잠김 오류 없이)", async () => {
    await mount();
    await pick("시험");
    choose("수준", "high");
    await applyNow();
    await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
    expect((await ipc.customHistory()).commits[0]?.message).toBe("시험 — 수준을 높음으로");
  });
});

describe("떠날 때 저장", () => {
  it("쓰던 덧붙임이 있으면 다른 곳으로 가기 전에 저장하고 간다", async () => {
    const { onGo } = await mount();
    await pick("정리");
    type("- 떠나기 전에 쓴 글");
    expect(await screen.findByText("저장 안 됨")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("navigation", { name: "탐색" })).getByRole("button", { name: "작업 공간" }));
    await waitFor(() => expect(onGo).toHaveBeenCalledWith("workspace"), WAIT);
    const read = await ipc.customItemRead("agent:harness-helper");
    expect(appendTextOf(read)).toBe("- 떠나기 전에 쓴 글");
  });

  it("적용을 누르면 쓰던 글을 먼저 저장하고 그것까지 적용한다", async () => {
    await mount();
    await pick("정리");
    type("- 적용 직전에 쓴 글");
    await applyNow();
    await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
    const read = await ipc.customItemRead("agent:harness-helper");
    expect(appendTextOf(read)).toBe("- 적용 직전에 쓴 글");
    expect((await ipc.customHistory()).commits[0]?.message).toBe("정리 — 지시 덧붙임");
  });

  it("화면을 닫을 때(언마운트) 남은 글도 저장한다", async () => {
    const { unmount } = await mount();
    await pick("정리");
    type("- 닫을 때 쓴 글");
    unmount();
    await waitFor(async () => {
      const read = await ipc.customItemRead("agent:harness-helper");
      expect(appendTextOf(read)).toBe("- 닫을 때 쓴 글");
    }, WAIT);
  });
});
