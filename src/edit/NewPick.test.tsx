// 「내 수정」의 새로 만들기 · 고양이 고르기 · 보이는 이름 시험 (브라우저 가짜 내 수정, `fakeCustom`) — 스킬 / 에이전트 만들기 · 초안을 들고 오가기 · 복사로 만들기 · 이름 검사 ·
// `customNew` 거절 · 만든 뒤 단계 실패 · 고양이 맞바꿈(커밋 하나) · 되돌리기 · 기본값으로 · 완료 잠금 · 보이는 이름 고침 / 지움 / 규칙 · 지울 때 줄 정리 · 키보드.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCustom, type FakeCustomMode } from "../lib/fakeCustom";
import { fakeHouse } from "../lib/fakeHouse";
import { ipc } from "../lib/ipc";
import { getMine, resetMine } from "../lib/mine";
import { AppError } from "../lib/ipc-types";
import EditScreen from "./EditScreen";
import { splitFront } from "./newDraft";

const NOW = new Date("2026-11-10T12:00:00+09:00");
const WAIT = { timeout: 4000 };
const LIST = "에이전트 · 스킬 목록";

beforeEach(() => {
  fakeHouse.reset();
  fakeCustom.reset();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 40));
  vi.restoreAllMocks();
  fakeHouse.reset();
  fakeCustom.reset();
});

async function mount(mode: FakeCustomMode = "full", setup?: () => Promise<unknown>) {
  fakeCustom.reset(mode);
  await setup?.();
  const onGo = vi.fn();
  render(<EditScreen onGo={onGo} clock={() => NOW} />);
  await screen.findByRole("navigation", { name: LIST });
  await screen.findByText("화면 구현");
  return { onGo };
}

function listNames(): string[] {
  const list = screen.getByRole("navigation", { name: LIST });
  return within(list)
    .getAllByText(/./, { selector: ".ed-item__name" })
    .map((el) => el.textContent ?? "");
}

async function pick(name: string) {
  const list = screen.getByRole("navigation", { name: LIST });
  fireEvent.click(within(list).getByText(name, { selector: ".ed-item__name" }).closest("button")!);
  await waitFor(() => expect(document.getElementById("ed-panel-title")).toHaveTextContent(new RegExp(`^${name}`)));
  await waitFor(() => expect(screen.queryByText("읽는 중…")).not.toBeInTheDocument());
}

function applyBar() {
  return document.querySelector(".ed-apply") as HTMLElement;
}

async function openNew() {
  fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
  await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
}

function form(): HTMLElement {
  return document.querySelector(".ed-new") as HTMLElement;
}

function fill(label: RegExp | string, value: string) {
  fireEvent.change(within(form()).getByLabelText(label), { target: { value } });
}

function primary(name: RegExp | string) {
  return screen.getByRole("button", { name });
}

function catCard(cat: string) {
  return screen.getByRole("radio", { name: new RegExp(`^${cat}`) });
}

async function pickView() {
  await screen.findByRole("heading", { level: 1, name: "에이전트 고양이 고르기" });
}

/** 가짜 `full` 의 번역(translator)은 두부를 골라 둔 모양이다 — 「아직 안 고름」을 볼 시험은 그 줄을 먼저 지운다 */
const noCat = () => ipc.customCatsSave([{ agent: "translator", cat: null }]);
const catsNow = async () => (await ipc.customCatsRead()).agents;
const labelsNow = async () => (await ipc.customLabelsRead()).agents;

async function history() {
  const h = await ipc.customHistory();
  return h.commits;
}

describe("새로 만들기 — 스킬", () => {
  it("스킬 만들기 → 목록에 · 새 항목이 골라진 채 탭 보기로 · 적용 안 한 것 1", async () => {
    await mount("fresh");
    const before = listNames().length;
    await openNew();
    // 스킬이면 보이는 이름 칸 · 고양이 안내가 없다
    fireEvent.click(screen.getByRole("radio", { name: "스킬" }));
    expect(within(form()).queryByLabelText(/^보이는 이름/)).not.toBeInTheDocument();
    expect(screen.queryByText(/고양이를 골라요/)).not.toBeInTheDocument();
    expect(within(form()).getByText("스킬 이름 (영문)")).toBeInTheDocument();
    expect(primary("만들기")).toBeDisabled();
    fill("스킬 이름 (영문)", "translate-docs");
    expect(primary("만들기")).toBeDisabled(); // 소개가 아직 없다
    fill("언제 쓰나", "문서를 번역해요");
    expect(within(form()).getByText("~/.claude-harness/custom/skills/translate-docs/SKILL.md", { exact: false })).toBeInTheDocument();
    expect(primary("만들기")).toBeEnabled();
    fireEvent.click(primary("만들기"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "내 수정" })).toBeInTheDocument(), WAIT);
    await waitFor(() => expect(listNames()).toContain("translate-docs"), WAIT);
    expect(listNames().length).toBe(before + 1);
    await waitFor(() => expect(document.getElementById("ed-panel-title")).toHaveTextContent(/^translate-docs/), WAIT);
    await waitFor(() => expect(within(applyBar()).getByText(/^적용 안 한 것 1개$/)).toBeInTheDocument(), WAIT);
  });

  it("이름이 틀린 모양 · 이미 있는 이름이면 칸 아래에 바로 알린다 (원본 / 내가 만든 것을 가른다)", async () => {
    await mount();
    await openNew();
    fill("에이전트 이름 (영문)", "Bad Name");
    expect(within(form()).getByText(/영문 소문자로 시작하고, 소문자 · 숫자 · - 만 써 주세요/)).toBeInTheDocument();
    expect(primary(/다음: 고양이 고르기/)).toBeDisabled();
    fill("에이전트 이름 (영문)", "harness-designer");
    expect(within(form()).getByText("원본에 같은 이름이 있어요.")).toBeInTheDocument();
    fill("에이전트 이름 (영문)", "translator");
    expect(within(form()).getByText("이미 만든 이름이에요.")).toBeInTheDocument();
    fill("언제 쓰나", "번역해요");
    expect(primary(/다음: 고양이 고르기/)).toBeDisabled();
    fill("에이전트 이름 (영문)", "translator-two");
    expect(within(form()).queryByText(/같은 이름|이미 만든/)).not.toBeInTheDocument();
    expect(primary(/다음: 고양이 고르기/)).toBeEnabled();
    // 스킬도 같은 종류 안에서 가린다
    fireEvent.click(screen.getByRole("radio", { name: "스킬" }));
    fill("스킬 이름 (영문)", "desktop-app");
    expect(within(form()).getByText("원본에 같은 이름이 있어요.")).toBeInTheDocument();
    fill("스킬 이름 (영문)", "translate-docs");
    expect(within(form()).getByText("이미 만든 이름이에요.")).toBeInTheDocument();
  });

  it("보이는 이름은 20 글자까지 — 넘으면 알리고 주 단추가 잠긴다. 비워도 된다", async () => {
    await mount();
    await openNew();
    fill("에이전트 이름 (영문)", "helper-two");
    fill("언제 쓰나", "도와요");
    expect(primary(/다음: 고양이 고르기/)).toBeEnabled();
    fill(/^보이는 이름/, "가".repeat(21));
    expect(within(form()).getByText("보이는 이름은 1~20 글자로, 줄바꿈 없이 써 주세요.")).toBeInTheDocument();
    expect(primary(/다음: 고양이 고르기/)).toBeDisabled();
    fill(/^보이는 이름/, "가".repeat(20));
    expect(primary(/다음: 고양이 고르기/)).toBeEnabled();
    fill(/^보이는 이름/, "");
    expect(primary(/다음: 고양이 고르기/)).toBeEnabled();
  });

  it("글자 수가 다 차면 더 쳐지지 않는다 — 이름 64 · 보이는 이름 20 · 소개 300 (P9-04 실행 확인)", async () => {
    await mount();
    await openNew();
    expect(within(form()).getByLabelText("에이전트 이름 (영문)")).toHaveAttribute("maxLength", "64");
    expect(within(form()).getByLabelText(/^보이는 이름/)).toHaveAttribute("maxLength", "20");
    expect(within(form()).getByLabelText("언제 쓰나")).toHaveAttribute("maxLength", "300");
  });

  it("소개 칸은 한 줄로 — 줄바꿈은 공백이 된다", async () => {
    await mount();
    await openNew();
    fill("언제 쓰나", "첫 줄\n둘째 줄");
    expect((within(form()).getByLabelText("언제 쓰나") as HTMLTextAreaElement).value).toBe("첫 줄 둘째 줄");
  });

  it("취소 — 쓴 것이 없으면 바로, 있으면 확인한 뒤 버린다", async () => {
    await mount();
    await openNew();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await screen.findByRole("heading", { level: 1, name: "내 수정" });
    await openNew();
    fill("에이전트 이름 (영문)", "scratch");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    const box = await screen.findByRole("dialog");
    fireEvent.click(within(box).getByRole("button", { name: "계속 쓰기" }));
    expect((within(form()).getByLabelText("에이전트 이름 (영문)") as HTMLInputElement).value).toBe("scratch");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "버리기" }));
    await screen.findByRole("heading", { level: 1, name: "내 수정" });
    // 다시 열면 비어 있다 (초안을 버렸다)
    await openNew();
    expect((within(form()).getByLabelText("에이전트 이름 (영문)") as HTMLInputElement).value).toBe("");
  });

  it("미리보기의 모델 · 수준은 한 줄 단추 — 정하지 않음으로 두면 앞머리에 값이 없다 (펼치는 목록 없음)", async () => {
    await mount();
    await openNew();
    expect(document.querySelector("select")).toBeNull();
    const model = screen.getByRole("radiogroup", { name: "모델" });
    expect(within(model).getByRole("radio", { name: "Sonnet" })).toBeChecked();
    fireEvent.click(within(model).getByRole("radio", { name: "정하지 않음" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "수준" })).getByRole("radio", { name: "정하지 않음" }));
    fill("에이전트 이름 (영문)", "plain-agent");
    fill("언제 쓰나", "값 없이");
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    fireEvent.click(catCard("두부"));
    fireEvent.click(primary("완료"));
    await waitFor(() => expect(listNames()).toContain("plain-agent"), WAIT);
    const read = await ipc.customItemRead("agent:plain-agent");
    expect(read.state === "ok" && read.replaceText.state === "text" ? read.replaceText.text : "").not.toMatch(/^(model|effort):/m);
  });
});

describe("새로 만들기 — 에이전트 · 고양이 고르기를 오가며", () => {
  it("다음 → 고양이 고르기(완료 잠김) → 이전(칸 그대로) → 다시 다음(고른 고양이 그대로) → 완료 → 보이는 이름 · 고양이로 목록에", async () => {
    await mount();
    await openNew();
    fill("에이전트 이름 (영문)", "reviewer-two");
    fill(/^보이는 이름/, "검토");
    fill("언제 쓰나", "두 번째 점검");
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    // 새 에이전트로 들어옴 — 띠 · 초안 줄(아직 안 고름) · 완료 잠김 · 다른 에이전트는 보기만
    expect(screen.getByText(/새 에이전트 「검토」 — 어떤 고양이로 보일지 골라 주세요/)).toBeInTheDocument();
    const draftTab = screen.getByRole("tab", { name: /검토/ });
    expect(draftTab).toHaveAttribute("aria-selected", "true");
    expect(within(draftTab).getByText("아직 안 고름")).toBeInTheDocument();
    expect(primary("완료")).toBeDisabled();
    expect(screen.getByText("검토의 고양이를 먼저 골라 주세요. 고르면 완료할 수 있어요.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /화면 구현/ }));
    expect(catCard("단추")).toBeDisabled();
    expect(catCard("두부")).toBeDisabled();
    fireEvent.click(screen.getByRole("tab", { name: /검토/ }));
    // 고르기는 초안에만 — 맞바꿈이 없고, 아무것도 저장되지 않는다 (둘이 같은 고양이여도 된다)
    const saves = vi.spyOn(ipc, "customCatsSave");
    fireEvent.click(catCard("두부"));
    expect(saves).not.toHaveBeenCalled();
    expect(catCard("두부")).toBeChecked();
    expect(primary("완료")).toBeEnabled();
    expect(screen.getByText("검토의 고양이: 두부. 완료하면 에이전트가 만들어져요.")).toBeInTheDocument();
    expect(await catsNow()).toEqual({ translator: "dubu" });
    // 이전 — 새로 만들기로, 쓰던 칸 그대로
    fireEvent.click(screen.getByRole("button", { name: "이전" }));
    await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
    expect((within(form()).getByLabelText("에이전트 이름 (영문)") as HTMLInputElement).value).toBe("reviewer-two");
    expect((within(form()).getByLabelText(/^보이는 이름/) as HTMLInputElement).value).toBe("검토");
    expect((within(form()).getByLabelText("언제 쓰나") as HTMLTextAreaElement).value).toBe("두 번째 점검");
    // 다시 — 고른 고양이가 그대로
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    expect(catCard("두부")).toBeChecked();
    fireEvent.click(primary("완료"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "내 수정" })).toBeInTheDocument(), WAIT);
    await waitFor(() => expect(listNames()).toContain("검토"), WAIT);
    await waitFor(() => expect(document.getElementById("ed-panel-title")).toHaveTextContent(/^검토/), WAIT);
    expect(await labelsNow()).toEqual({ translator: "번역", "reviewer-two": "검토" });
    expect(await catsNow()).toEqual({ translator: "dubu", "reviewer-two": "dubu" });
    // 목록 줄에도 두부 얼굴이 보이고(발바닥이 아니다), 에이전트 이름이 아닌 보이는 이름이 보인다
    const row = within(screen.getByRole("navigation", { name: LIST }))
      .getByText("검토", { selector: ".ed-item__name" })
      .closest("button")!;
    expect(row.querySelector(".ed-face .cat-figure")).not.toBeNull();
    const kinds = (await history()).map((c) => c.kind);
    expect(kinds.slice(0, 2)).toEqual(["cats", "labels"]);
  });

  it("있는 것 복사 — 본문은 고른 것과 같고 앞머리는 새 이름 · 소개 (덧붙임 · 값은 복사하지 않는다)", async () => {
    await mount();
    await openNew();
    fill("에이전트 이름 (영문)", "ui-copy");
    fill("언제 쓰나", "화면 구현을 닮은 새 에이전트");
    fireEvent.click(screen.getByRole("radio", { name: /있는 것 복사/ }));
    const from = screen.getByRole("radiogroup", { name: "복사할 것" });
    // 이름 옆 보이는 이름 — `화면 구현` + 파일 이름
    const row = within(from).getByText("harness-builder-ui").closest("label")!;
    expect(row).toHaveTextContent("화면 구현");
    expect(within(from).getByText("translator").closest("label")).toHaveTextContent("번역");
    fireEvent.click(within(row).getByRole("radio"));
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    fireEvent.click(catCard("구름"));
    fireEvent.click(primary("완료"));
    await waitFor(() => expect(listNames()).toContain("ui-copy"), WAIT);
    const made = await ipc.customItemRead("agent:ui-copy");
    const source = await ipc.customItemRead("agent:harness-builder-ui");
    if (made.state !== "ok" || source.state !== "ok" || made.replaceText.state !== "text" || source.originText.state !== "text") throw new Error("읽지 못했다");
    const a = splitFront(made.replaceText.text)!;
    const b = splitFront(source.originText.text)!;
    expect(a.body).toBe(b.body);
    expect(a.front).toContain("name: ui-copy");
    expect(a.front).toContain("description: 화면 구현을 닮은 새 에이전트");
    expect(a.front).not.toContain("harness-builder-ui");
  });

  it("복사할 것을 고르지 않으면 같은 종류의 첫 항목을 복사한다 · 스킬도 복사된다", async () => {
    await mount();
    await openNew();
    fireEvent.click(screen.getByRole("radio", { name: "스킬" }));
    fill("스킬 이름 (영문)", "skill-copy");
    fill("언제 쓰나", "스킬 복사");
    fireEvent.click(screen.getByRole("radio", { name: /있는 것 복사/ }));
    const from = screen.getByRole("radiogroup", { name: "복사할 것" });
    const first = within(from).getAllByRole("radio")[0] as HTMLInputElement;
    expect(first).toBeChecked();
    fireEvent.click(primary("만들기"));
    await waitFor(() => expect(listNames()).toContain("skill-copy"), WAIT);
    const made = await ipc.customItemRead("skill:skill-copy");
    const source = await ipc.customItemRead(first.value);
    if (made.state !== "ok" || source.state !== "ok" || made.replaceText.state !== "text" || source.originText.state !== "text") throw new Error("읽지 못했다");
    expect(splitFront(made.replaceText.text)!.body).toBe(splitFront(source.originText.text)!.body);
    expect(splitFront(made.replaceText.text)!.front).toContain("name: skill-copy");
  });

  it("customNew 가 거절하면 새로 만들기로 돌아가 칸은 그대로 — 이름 거절은 이름 칸 아래에", async () => {
    await mount();
    vi.spyOn(ipc, "customNew").mockResolvedValueOnce({ outcome: "refused", reason: "name_taken", detail: null, changed: false, notOurs: false });
    await openNew();
    fill("에이전트 이름 (영문)", "racing-name");
    fill("언제 쓰나", "거절돼요");
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    fireEvent.click(catCard("나비"));
    fireEvent.click(primary("완료"));
    await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
    expect(within(form()).getByText("내 수정에 같은 이름이 이미 있어요.")).toBeInTheDocument();
    expect((within(form()).getByLabelText("에이전트 이름 (영문)") as HTMLInputElement).value).toBe("racing-name");
    expect((within(form()).getByLabelText("언제 쓰나") as HTMLTextAreaElement).value).toBe("거절돼요");
    // 이름을 고치면 그 알림은 사라진다
    fill("에이전트 이름 (영문)", "racing-name-2");
    expect(within(form()).queryByText("내 수정에 같은 이름이 이미 있어요.")).not.toBeInTheDocument();
  });

  it("customNew 가 오류(잠김)면 칸 위에 띠로 — 칸은 그대로", async () => {
    await mount();
    vi.spyOn(ipc, "customNew").mockRejectedValueOnce(new AppError("harness_busy", "busy"));
    await openNew();
    fireEvent.click(screen.getByRole("radio", { name: "스킬" }));
    fill("스킬 이름 (영문)", "busy-skill");
    fill("언제 쓰나", "잠겼어요");
    fireEvent.click(primary("만들기"));
    expect(await within(form()).findByText("만들지 못했어요")).toBeInTheDocument();
    expect((within(form()).getByLabelText("스킬 이름 (영문)") as HTMLInputElement).value).toBe("busy-skill");
    expect(primary("만들기")).toBeEnabled();
  });

  it("만든 뒤 단계(보이는 이름)가 실패하면 항목은 생긴 채 탭 보기로 — 띠로 다시 하라고 알린다", async () => {
    await mount();
    vi.spyOn(ipc, "customLabelSave").mockRejectedValueOnce(new AppError("file_write_failed", "disk"));
    await openNew();
    fill("에이전트 이름 (영문)", "half-made");
    fill(/^보이는 이름/, "반쪽");
    fill("언제 쓰나", "중간에 실패");
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    fireEvent.click(catCard("물감"));
    fireEvent.click(primary("완료"));
    await waitFor(() => expect(listNames()).toContain("half-made"), WAIT);
    expect(await screen.findByText("「half-made」을 만들었지만 다 저장하지 못했어요")).toBeInTheDocument();
    expect(screen.getByText(/보이는 이름을 저장하지 못했어요 — 아래 「보이는 이름」 칸에서 다시 해 주세요/)).toBeInTheDocument();
    // 고양이는 저장됐다 · 보이는 이름은 칸에서 다시 할 수 있다
    expect(await catsNow()).toEqual({ translator: "dubu", "half-made": "mulgam" });
    const input = (await screen.findByLabelText("보이는 이름 (비워도 돼요)")) as HTMLInputElement;
    expect(input.value).toBe("");
  });
});

describe("고양이 고르기 — 평소", () => {
  async function openPick(agent: string) {
    await pick(agent);
    fireEvent.click(within(applyBar()).getByRole("button", { name: "고양이 바꾸기" }));
    await pickView();
  }

  it("적용 바의 「고양이 바꾸기」로 고른 에이전트를 고른 채 연다 — 스킬에는 단추가 없다. 목록은 오케스트레이터 → 작업자 → 그 밖", async () => {
    await mount("full", noCat);
    await pick("desktop-app");
    expect(within(applyBar()).queryByRole("button", { name: "고양이 바꾸기" })).not.toBeInTheDocument();
    await openPick("화면 구현");
    expect(screen.getByRole("tab", { name: /화면 구현/ })).toHaveAttribute("aria-selected", "true");
    const names = screen.getAllByRole("tab").map((tab) => tab.querySelector(".ed-pk__name")?.textContent);
    expect(names).toEqual(["오케스트레이터", "디자이너", "화면 구현", "시스템 구현", "시험", "정리", "점검", "번역"]);
    expect(screen.getByRole("heading", { name: "화면 구현의 고양이" })).toBeInTheDocument();
    expect(screen.getByText("단추", { selector: ".ed-pk__catname" })).toBeInTheDocument();
    expect(catCard("단추")).toBeChecked();
    expect(within(screen.getByRole("tab", { name: /화면 구현/ })).getByText("기본")).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: /번역/ })).getByText("아직 안 고름")).toBeInTheDocument();
    expect(screen.getByText("지금 정리 담당")).toBeInTheDocument();
    expect(screen.getByText("고양이는 더 늘어나요")).toBeInTheDocument();
    expect(screen.getByText(/고른 것은 바로 저장돼요/)).toBeInTheDocument();
    expect(document.querySelectorAll(".ed-pk__poses li")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "기본값으로" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "모두 기본값으로" })).toBeDisabled();
    // 내 수정으로
    fireEvent.click(screen.getByRole("button", { name: "내 수정으로" }));
    await screen.findByRole("heading", { level: 1, name: "내 수정" });
    expect(document.getElementById("ed-panel-title")).toHaveTextContent(/^화면 구현/);
  });

  it("다른 에이전트가 쓰는 고양이를 고르면 둘을 맞바꿔 한 번에 저장 — 커밋 하나, 띠, 되돌리기 한 번에", async () => {
    await mount();
    await openPick("화면 구현");
    const before = (await history()).length;
    const saves = vi.spyOn(ipc, "customCatsSave");
    fireEvent.click(catCard("두부")); // 정리가 쓰는 고양이
    await screen.findByText("화면 구현, 정리의 고양이를 서로 바꿨어요.");
    expect(saves).toHaveBeenCalledTimes(1);
    expect(saves.mock.calls[0]![0]).toEqual([
      { agent: "harness-builder-ui", cat: "dubu" },
      { agent: "harness-helper", cat: "danchu" },
    ]);
    expect(await catsNow()).toEqual({ translator: "dubu", "harness-builder-ui": "dubu", "harness-helper": "danchu" });
    const commits = await history();
    expect(commits.length).toBe(before + 1);
    expect(commits[0]!.kind).toBe("cats");
    // 목록 줄 · 큰 고양이에 바로 보인다
    expect(within(screen.getByRole("tab", { name: /화면 구현/ })).getByText("바꿈")).toBeInTheDocument();
    expect(within(screen.getByRole("tab", { name: /정리/ })).getByText("바꿈")).toBeInTheDocument();
    expect(catCard("두부")).toBeChecked();
    expect(screen.getByText("지금 정리 담당")).toBeInTheDocument(); // 단추 카드
  });

  it("되돌리기 — 앞 모습으로 다시 한 번에 (줄이 없던 에이전트는 줄을 지운다)", async () => {
    await mount();
    await openPick("화면 구현");
    fireEvent.click(catCard("두부"));
    await screen.findByText("화면 구현, 정리의 고양이를 서로 바꿨어요.");
    const before = (await history()).length;
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await screen.findByText("되돌렸어요.");
    expect(await catsNow()).toEqual({ translator: "dubu" });
    expect(catCard("단추")).toBeChecked();
    const commits = await history();
    expect(commits.length).toBe(before + 1);
    expect(commits[0]!.kind).toBe("cats");
    expect(screen.queryByRole("button", { name: "되돌리기" })).not.toBeInTheDocument();
  });

  it("지금 고양이가 없으면 그 고양이만 (둘이 같은 고양이) — 맞바꿈 없이", async () => {
    await mount("full", noCat);
    await openPick("번역");
    expect(within(screen.getByRole("tab", { name: /번역/ })).getByText("아직 안 고름")).toBeInTheDocument();
    const saves = vi.spyOn(ipc, "customCatsSave");
    fireEvent.click(catCard("먹물"));
    await waitFor(() => expect(saves).toHaveBeenCalledTimes(1));
    expect(saves.mock.calls[0]![0]).toEqual([{ agent: "translator", cat: "mukmul" }]);
    await waitFor(() => expect(within(screen.getByRole("tab", { name: /번역/ })).getByText("바꿈")).toBeInTheDocument());
    expect(within(screen.getByRole("tab", { name: /오케스트레이터/ })).getByText("기본")).toBeInTheDocument();
    expect(screen.queryByText(/서로 바꿨어요/)).not.toBeInTheDocument();
  });

  it("기본값으로(그 줄 지움) · 모두 기본값으로(내 연결 모두 지움, 한 번에) — 되돌리기 띠", async () => {
    await mount();
    await openPick("화면 구현");
    fireEvent.click(catCard("두부"));
    await screen.findByText("화면 구현, 정리의 고양이를 서로 바꿨어요.");
    const reset = screen.getByRole("button", { name: "기본값으로" });
    await waitFor(() => expect(reset).toBeEnabled());
    fireEvent.click(reset);
    await screen.findByText("화면 구현의 고양이를 기본값으로 되돌렸어요.");
    expect(await catsNow()).toEqual({ translator: "dubu", "harness-helper": "danchu" });
    expect(catCard("단추")).toBeChecked();
    // 모두 기본값으로 — 남은 연결을 한 번에
    const resetAll = screen.getByRole("button", { name: "모두 기본값으로" });
    await waitFor(() => expect(resetAll).toBeEnabled());
    const before = (await history()).length;
    const saves = vi.spyOn(ipc, "customCatsSave");
    fireEvent.click(resetAll);
    await screen.findByText("고양이를 모두 기본값으로 되돌렸어요.");
    expect(saves).toHaveBeenCalledTimes(1);
    expect(await catsNow()).toEqual({});
    expect((await history()).length).toBe(before + 1);
    await waitFor(() => expect(screen.getByRole("button", { name: "모두 기본값으로" })).toBeDisabled());
    // 되돌리기 — 지웠던 연결이 다시
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await screen.findByText("되돌렸어요.");
    expect(await catsNow()).toEqual({ translator: "dubu", "harness-helper": "danchu" });
  });

  it("저장이 거절 · 실패하면 띠로 알리고 화면의 고른 모습은 그대로다", async () => {
    await mount();
    await openPick("화면 구현");
    vi.spyOn(ipc, "customCatsSave").mockRejectedValueOnce(new AppError("harness_busy", "busy"));
    fireEvent.click(catCard("두부"));
    expect(await screen.findByText(/고양이를 저장하지 못했어요/)).toBeInTheDocument();
    expect(catCard("단추")).toBeChecked();
  });

  it("키보드 — 세로 탭 위 · 아래 · Home · End, 고양이 카드는 라디오(화살표)", async () => {
    await mount();
    await openPick("화면 구현");
    const tablist = screen.getByRole("tablist", { name: "에이전트" });
    const current = () => screen.getAllByRole("tab").findIndex((tab) => tab.getAttribute("aria-selected") === "true");
    screen.getByRole("tab", { name: /화면 구현/ }).focus();
    expect(current()).toBe(2);
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    expect(current()).toBe(3);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /시스템 구현/ }));
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    fireEvent.keyDown(tablist, { key: "ArrowUp" });
    expect(current()).toBe(1);
    fireEvent.keyDown(tablist, { key: "End" });
    expect(current()).toBe(7);
    fireEvent.keyDown(tablist, { key: "ArrowDown" });
    expect(current()).toBe(0);
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(current()).toBe(0);
    // 탭 하나만 Tab 으로 들어간다
    expect(screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    // 카드는 한 묶음 라디오 — 고르면 저장
    expect(screen.getByRole("radiogroup", { name: /고양이 7마리/ })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(7);
  });
});

describe("보이는 이름", () => {
  const field = () => screen.getByLabelText("보이는 이름 (비워도 돼요)") as HTMLInputElement;

  it("직접 만든 에이전트에만 칸이 있다 — 하네스 작업자 · 오케스트레이터 · 스킬에는 없다", async () => {
    await mount();
    await pick("화면 구현");
    expect(screen.queryByLabelText("보이는 이름 (비워도 돼요)")).not.toBeInTheDocument();
    await pick("오케스트레이터");
    expect(screen.queryByLabelText("보이는 이름 (비워도 돼요)")).not.toBeInTheDocument();
    await pick("translate-docs");
    expect(screen.queryByLabelText("보이는 이름 (비워도 돼요)")).not.toBeInTheDocument();
    await pick("번역");
    expect(field().value).toBe("번역");
    expect(field()).toHaveAttribute("maxLength", "20");
    expect(screen.getByText(/Claude Code 는 에이전트 이름\(translator\)으로 불러요/)).toBeInTheDocument();
  });

  it("Enter 로 저장 — 바로 기록에 남고 목록 · 머리 이름이 바뀐다", async () => {
    await mount();
    await pick("번역");
    const before = (await history()).length;
    fireEvent.change(field(), { target: { value: "  통역  " } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(async () => expect(await labelsNow()).toEqual({ translator: "통역" }), WAIT);
    expect(await screen.findByText("저장했어요")).toBeInTheDocument();
    const list = screen.getByRole("navigation", { name: LIST });
    await waitFor(() => expect(within(list).getByText("통역", { selector: ".ed-item__name" })).toBeInTheDocument());
    expect(document.getElementById("ed-panel-title")).toHaveTextContent(/^통역/);
    const commits = await history();
    expect(commits.length).toBe(before + 1);
    expect(commits[0]!.kind).toBe("labels");
  });

  it("칸을 떠나면 저장 · 비우면 지운다(에이전트 이름이 보인다) · 같은 값이면 저장하지 않는다", async () => {
    await mount();
    await pick("번역");
    const save = vi.spyOn(ipc, "customLabelSave");
    fireEvent.blur(field());
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    await waitFor(() => expect(save).toHaveBeenCalledWith("translator", null));
    expect(await screen.findByText("지웠어요 — 에이전트 이름이 보여요")).toBeInTheDocument();
    expect(await labelsNow()).toEqual({});
    const list = screen.getByRole("navigation", { name: LIST });
    await waitFor(() => expect(within(list).getByText("translator", { selector: ".ed-item__name" })).toBeInTheDocument());
  });

  it("규칙에 어긋나면(21 글자) 칸 아래에 알리고 저장하지 않는다", async () => {
    await mount();
    await pick("번역");
    const save = vi.spyOn(ipc, "customLabelSave");
    fireEvent.change(field(), { target: { value: "가".repeat(21) } });
    expect(screen.getByRole("alert")).toHaveTextContent("보이는 이름은 1~20 글자로, 줄바꿈 없이 써 주세요.");
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.blur(field());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(save).not.toHaveBeenCalled();
    expect(field()).toHaveAttribute("aria-invalid", "true");
  });

  it("Rust 가 bad_label 로 거절해도 쉬운 말로 칸 아래에", async () => {
    await mount();
    await pick("번역");
    vi.spyOn(ipc, "customLabelSave").mockResolvedValueOnce({ outcome: "refused", reason: "bad_label", changed: false, commit: "skipped", commitShort: null, detail: null });
    fireEvent.change(field(), { target: { value: "다른 이름" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(await screen.findByText(/보이는 이름은 1~20 글자로, 줄바꿈 없이 써 주세요/)).toBeInTheDocument();
  });

  it("직접 만든 에이전트를 지워도 보이는 이름 · 고양이 줄은 남긴다 (버리면 함께 돌아오게, P9-06 버그 3) — 같은 이름으로 다시 만들면 비어서 시작한다", async () => {
    await mount("full", () => ipc.customCatsSave([{ agent: "translator", cat: "nabi" }]));
    await pick("번역");
    fireEvent.click(screen.getByRole("button", { name: "지우기" }));
    const box = await screen.findByRole("dialog");
    fireEvent.click(within(box).getByRole("button", { name: "지우기" }));
    await waitFor(() => expect(listNames()).not.toContain("번역"), WAIT);
    expect(await labelsNow()).toEqual({ translator: "번역" });
    expect(await catsNow()).toEqual({ translator: "nabi" });
    // 같은 이름으로 다시 — 이름도 고양이도 비어서 시작한다
    await openNew();
    fill("에이전트 이름 (영문)", "translator");
    fill("언제 쓰나", "다시 만들어요");
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    fireEvent.click(screen.getByRole("tab", { name: /화면 구현/ }));
    fireEvent.click(screen.getByRole("button", { name: "이전" }));
    await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await pickView();
    expect(within(screen.getByRole("tab", { name: /translator/ })).getByText("아직 안 고름")).toBeInTheDocument();
  });
});

describe("내 연결을 앱 전체에 알리기 · 처음 보기 (P9-05)", () => {
  afterEach(() => resetMine());

  it("처음 보기를 받으면 고양이 고르기를 그 에이전트를 고른 채 연다 (오케스트레이터는 main)", async () => {
    fakeCustom.reset("full");
    render(<EditScreen onGo={vi.fn()} clock={() => NOW} startPick="harness-helper" />);
    await pickView();
    expect(screen.getByRole("tab", { name: /정리/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "정리의 고양이" })).toBeInTheDocument();
    cleanup();
    render(<EditScreen onGo={vi.fn()} clock={() => NOW} startPick="main" />);
    await pickView();
    expect(screen.getByRole("tab", { name: /오케스트레이터/ })).toHaveAttribute("aria-selected", "true");
  });

  it("처음 보기가 없으면 탭 보기 (지금과 같다)", async () => {
    await mount();
    expect(screen.queryByRole("heading", { level: 1, name: "에이전트 고양이 고르기" })).not.toBeInTheDocument();
  });

  it("고양이를 바꾸면 · 되돌리면 · 기본값으로 하면 공용 모듈이 바로 바뀐다 (집 · 채팅 · 진행 보기가 다시 그린다)", async () => {
    await mount("full", noCat);
    await waitFor(() => expect(getMine().cats).toEqual({}));
    await pick("화면 구현");
    fireEvent.click(within(applyBar()).getByRole("button", { name: "고양이 바꾸기" }));
    await pickView();
    fireEvent.click(catCard("두부"));
    await screen.findByText("화면 구현, 정리의 고양이를 서로 바꿨어요.");
    await waitFor(() => expect(getMine().cats).toEqual({ "harness-builder-ui": "dubu", "harness-helper": "danchu" }));
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    await screen.findByText("되돌렸어요.");
    await waitFor(() => expect(getMine().cats).toEqual({}));
  });

  it("보이는 이름을 저장하면 공용 모듈의 보이는 이름이 바뀐다", async () => {
    await mount();
    await waitFor(() => expect(getMine().labels).toEqual({ translator: "번역" }));
    await pick("번역");
    const field = screen.getByLabelText("보이는 이름 (비워도 돼요)") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "통역" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(getMine().labels).toEqual({ translator: "통역" }));
  });
});
