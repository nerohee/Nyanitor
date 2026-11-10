// 「내 수정」 충돌 경우 화면 흐름 시험 (P9-06, 브라우저 가짜 내 수정 `fakeCustom`) — 여러 단계를 이어서 부딪힌다.
// 하나씩 따로 보는 것은 EditScreen.test.tsx · NewPick.test.tsx 에 있다 (겹치지 않게 뺐다). 여기서는:
// 만들기 → 적용 → 지우기 → 같은 이름으로 다시 만들기(경우 6) · 원본이 두 번 바뀌는 통째 파일(경우 3) · 업데이트와 적용 안 한 것이 섞임(경우 4) ·
// 기록 되돌리기가 새로 만든 것 · 고양이 · 이름을 함께 옮김(경우 5) · 적용 도중 다른 쓰기(경우 8, 가짜의 잠금).
// 버그로 보이는 것은 `it.skip` + 주석으로 남겼다 (풀면 실패한다).
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCustom, type FakeCustomMode } from "../lib/fakeCustom";
import { fakeHouse } from "../lib/fakeHouse";
import { ipc } from "../lib/ipc";
import { AppError } from "../lib/ipc-types";
import { getMine, resetMine } from "../lib/mine";
import EditScreen from "./EditScreen";

// 화면을 여러 번 오가는 긴 흐름이라 전체 시험을 함께 돌릴 때는 기본 5초를 넘을 수 있다
vi.setConfig({ testTimeout: 30000 });

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
  resetMine();
  fakeHouse.reset();
  fakeCustom.reset();
});

/** 가짜를 처음 모습으로 하고 (`setup` 으로 미리 일을 벌인 뒤) 화면을 연다 */
async function show(mode: FakeCustomMode = "full", setup?: () => Promise<unknown>) {
  fakeCustom.reset(mode);
  await setup?.();
  return reopen();
}

/** 가짜는 그대로 두고 화면만 새로 연다 (원본이 바뀐 뒤 · 되돌린 뒤 다시 열어 보는 것) */
async function reopen() {
  cleanup();
  render(<EditScreen onGo={vi.fn()} clock={() => NOW} />);
  await screen.findByRole("navigation", { name: LIST });
  await screen.findByText("화면 구현");
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

const applyBar = () => document.querySelector(".ed-apply") as HTMLElement;
const form = () => document.querySelector(".ed-new") as HTMLElement;
const primary = (name: RegExp | string) => screen.getByRole("button", { name });
const catCard = (cat: string) => screen.getByRole("radio", { name: new RegExp(`^${cat}`) });
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));

function fill(label: RegExp | string, value: string) {
  fireEvent.change(within(form()).getByLabelText(label), { target: { value } });
}

async function applyNow() {
  fireEvent.click(within(applyBar()).getByRole("button", { name: "적용" }));
  await within(applyBar()).findByText(/^적용했어요 — 기록 /, undefined, WAIT);
}

async function createViaScreen(name: string, label: string, cat: string) {
  fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
  await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
  fill("에이전트 이름 (영문)", name);
  if (label) fill(/^보이는 이름/, label);
  fill("언제 쓰나", `${name} 를 만들어요`);
  fireEvent.click(primary(/다음: 고양이 고르기/));
  await screen.findByRole("heading", { level: 1, name: "에이전트 고양이 고르기" });
  fireEvent.click(catCard(cat));
  fireEvent.click(primary("완료"));
  await screen.findByRole("heading", { level: 1, name: "내 수정" }, WAIT);
  await waitFor(() => expect(listNames()).toContain(label || name), WAIT);
}

async function deleteViaScreen(shown: string) {
  await pick(shown);
  fireEvent.click(screen.getByRole("button", { name: "지우기" }));
  const box = await screen.findByRole("dialog");
  fireEvent.click(within(box).getByRole("button", { name: "지우기" }));
  await waitFor(() => expect(listNames()).not.toContain(shown), WAIT);
}

const catsNow = async () => (await ipc.customCatsRead()).agents;
const labelsNow = async () => (await ipc.customLabelsRead()).agents;
const kindsNow = async () => (await ipc.customHistory()).commits.map((c) => c.kind);
const unappliedNow = async () => (await ipc.customList()).unapplied.count;

describe("경우 6 — 만들기 · 고양이 · 이름 → 적용 → 지우기 → 같은 이름으로 다시 만들기", () => {
  it("적용까지 한 에이전트를 지워도 이름 · 고양이 줄은 남지만, 같은 이름으로 다시 만들면 옛 이름 · 고양이가 되살아나지 않는다", async () => {
    await show();
    await createViaScreen("scout", "정찰", "나비");
    expect(await labelsNow()).toEqual({ translator: "번역", scout: "정찰" });
    expect(await catsNow()).toEqual({ translator: "dubu", scout: "nabi" });
    await applyNow();
    expect(await unappliedNow()).toBe(0);

    await deleteViaScreen("정찰");
    await waitFor(() => expect(listNames()).not.toContain("정찰"), WAIT);
    // 줄은 남는다 (지움을 버리면 함께 돌아오도록 — 버그 3 고침). 옆 에이전트의 줄도 그대로다
    expect(await labelsNow()).toEqual({ translator: "번역", scout: "정찰" });
    expect(await catsNow()).toEqual({ translator: "dubu", scout: "nabi" });

    // 같은 이름으로 다시 — 이름은 비워 둔다
    fireEvent.click(screen.getByRole("button", { name: "새로 만들기" }));
    await screen.findByRole("heading", { level: 1, name: "새로 만들기" });
    expect(within(form()).queryByText(/같은 이름|이미 만든/)).not.toBeInTheDocument();
    fill("에이전트 이름 (영문)", "scout");
    expect(within(form()).queryByText(/같은 이름|이미 만든/)).not.toBeInTheDocument();
    fill("언제 쓰나", "다시 만들어요");
    fireEvent.click(primary(/다음: 고양이 고르기/));
    await screen.findByRole("heading", { level: 1, name: "에이전트 고양이 고르기" });
    expect(within(screen.getByRole("tab", { name: /scout/ })).getByText("아직 안 고름")).toBeInTheDocument();
    fireEvent.click(catCard("구름"));
    fireEvent.click(primary("완료"));
    await waitFor(() => expect(listNames()).toContain("scout"), WAIT);
    expect(listNames()).not.toContain("정찰");
    expect(await labelsNow()).toEqual({ translator: "번역" });
    const cats = await catsNow();
    expect(cats.scout).toBeDefined();
    expect(cats.scout).not.toBe("nabi");
  });

  it("지운 것을 적용하지 않은 채 같은 이름으로 다시 만들려 하면 막히지 않는다 — 지운 파일이 아직 적용 안 한 것이어도 이름이 비어 있다", async () => {
    await show();
    await createViaScreen("scout", "정찰", "나비");
    await applyNow();
    await deleteViaScreen("정찰");
    // 지움은 아직 적용 안 한 것 (파일 하나 지움)
    expect(await unappliedNow()).toBeGreaterThan(0);
    const again = await ipc.customNew({ kind: "agent", name: "scout", description: "다시", model: null, effort: null });
    expect(again.outcome).toBe("saved");
    // 적용하면 한 번에 반영 (설치에 지움 + 새로 만듦이 같이 간다 → 파일 하나가 바뀜으로 보인다)
    const result = await ipc.customApply();
    expect(result.outcome).toBe("applied");
    expect(await unappliedNow()).toBe(0);
  });

  // 버그 후보 3 (작음, 데이터 잃음 — 기록으로는 되살릴 수 있다): 내가 만든 에이전트를 지우면 화면이 보이는 이름 · 고양이 줄을 **바로 커밋**으로 지운다.
  // 그런데 파일 지움은 아직 "적용 안 한 것" 이라 「버리기」 하면 에이전트는 돌아오는데 보이는 이름 · 고양이 줄은 돌아오지 않는다 (이름은 영문 파일 이름으로, 고양이는 처음 모습으로).
  // 기대: 지움을 버리면 이름 · 고양이도 함께 돌아온다 (또는 줄 정리를 적용 때 한다).
  it("P9-06 버그 3 (고침) — 지움을 적용 안 한 채 버리면 이름 · 고양이도 에이전트와 함께 돌아온다 (지울 때 줄을 지우지 않는다)", async () => {
    await show("full");
    await deleteViaScreen("번역");
    expect(await labelsNow()).toEqual({ translator: "번역" });
    expect(await catsNow()).toEqual({ translator: "dubu" });
    const discard = await ipc.customDiscard();
    expect(discard.outcome).toBe("discarded");
    const list = await ipc.customList();
    expect(list.items.some((e) => e.id === "agent:translator")).toBe(true);
    // 에이전트는 돌아왔다 → 이름 · 고양이도 돌아와야 한다
    expect(await labelsNow()).toEqual({ translator: "번역" });
    expect(await catsNow()).toEqual({ translator: "dubu" });
  });
});

describe("경우 3 — 통째 바꾼 파일, 원본이 두 번 바뀜", () => {
  it("원본 바뀜 → 내 것 유지 → 적용 → 원본이 또 바뀜 → 원본으로 바꾸기 → 적용 — 탭 숫자와 기록 순서가 맞는다", async () => {
    await show("fresh", async () => {
      await ipc.customReplaceStart("agent:harness-designer");
      await ipc.customApply();
    });
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).not.toHaveTextContent(/\d/);

    // 원본이 처음 바뀜
    fakeCustom.simulateOriginUpdate();
    await reopen();
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).toHaveTextContent("1");
    tab("원본 바뀜");
    fireEvent.click(await screen.findByRole("button", { name: "내 것 유지" }));
    await screen.findByText("원본이 바뀐 통째 파일이 없어요", undefined, WAIT);
    await applyNow();
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).not.toHaveTextContent("1");

    // 두 번째로 바뀜 — 다시 나타난다
    fakeCustom.simulateOriginUpdate();
    await reopen();
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).toHaveTextContent("1");
    tab("원본 바뀜");
    fireEvent.click(await screen.findByRole("button", { name: "원본으로 바꾸기" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "원본으로 바꾸기" }));
    await screen.findByText(/디자이너 — 원본으로 바꿨어요/, undefined, WAIT);
    await waitFor(() => expect(screen.getByRole("tab", { name: /원본 바뀜/ })).not.toHaveTextContent("1"), WAIT);
    await applyNow();

    expect(await kindsNow()).toEqual(["apply", "origin_update", "apply", "origin_update", "apply", "start"]);
    expect(await unappliedNow()).toBe(0);
    const designer = (await ipc.customList()).items.find((e) => e.id === "agent:harness-designer");
    expect(designer?.state === "ok" ? designer.marks : null).toEqual([]);
  });

  it("원본 바뀜 때 고른 「내 것 유지」는 적용 전에는 되돌릴 수 있다 — 버리면 다시 원본 바뀜으로 나온다", async () => {
    await show("fresh", async () => {
      await ipc.customReplaceStart("agent:harness-designer");
      await ipc.customApply();
      fakeCustom.simulateOriginUpdate();
    });
    tab("원본 바뀜");
    fireEvent.click(await screen.findByRole("button", { name: "내 것 유지" }));
    await screen.findByText("원본이 바뀐 통째 파일이 없어요", undefined, WAIT);
    expect(await unappliedNow()).toBe(1);
    expect((await ipc.customDiscard()).outcome).toBe("discarded");
    await reopen();
    expect(screen.getByRole("tab", { name: /원본 바뀜/ })).toHaveTextContent("1");
  });
});

describe("경우 4 — 업데이트와 적용 안 한 것이 섞임", () => {
  it("저장만 하고 적용 안 함 → 원본 업데이트 받음 → 적용 안 한 것은 그대로 · 업데이트 기록은 빈 커밋 → 적용이 값 · 업데이트 뒤에 쌓인다", async () => {
    await show("fresh", async () => {
      await ipc.customValuesSave("agent:harness-builder-ui", { model: "opus", effort: null });
      await ipc.customValuesSave("agent:harness-tester", { model: "opus", effort: null });
    });
    expect(within(applyBar()).getByText(/^적용 안 한 것 2개$/)).toBeInTheDocument();

    fakeCustom.simulateOriginUpdate();
    await reopen();
    expect(within(applyBar()).getByText(/^적용 안 한 것 2개$/)).toBeInTheDocument();
    const history = (await ipc.customHistory()).commits;
    expect(history[0]!.kind).toBe("origin_update");
    expect(history[0]!.files).toEqual([]);
    expect(history[0]!.filesTotal).toBe(0);

    await applyNow();
    const after = (await ipc.customHistory()).commits;
    expect(after.map((c) => c.kind)).toEqual(["apply", "origin_update", "start"]);
    expect([...after[0]!.files].sort()).toEqual(["agents/harness-builder-ui.values.yml", "agents/harness-tester.values.yml"]);
    expect(await unappliedNow()).toBe(0);
  });
});

describe("가짜(fakeCustom)와 Rust 의 차이", () => {
  // 버그 후보 4 (가짜만 — 실제 앱에는 영향 없음): `fakeCustom.apply` 의 "새 에이전트 · 스킬이 든 적용" 판정이 `agents/[^/]+\.md` 라서
  // 덧붙임 파일(`agents/<이름>.append.md`)도 새 항목으로 센다. Rust 는 `<유효한 이름>.md` 만 센다(`is_item_file`) — 덧붙임만 적용하면 종류는 `apply` 다.
  // 기대: 원본에 있는 에이전트의 덧붙임만 적용하면 커밋 종류가 `apply` (화면의 종류 표시가 개발 모드에서 거짓이 된다).
  it("P9-06 버그 4 (고침) — 가짜도 덧붙임만 적용하면 커밋 종류가 apply", async () => {
    fakeCustom.reset("fresh");
    await ipc.customAppendSave("agent:harness-tester", "덧붙임");
    expect((await ipc.customApply()).outcome).toBe("applied");
    expect((await kindsNow())[0]).toBe("apply");
  });
});

describe("경우 5 — 기록 되돌리기가 새로 만든 것 · 고양이 · 이름을 함께 옮김", () => {
  /** 만들기 전 커밋 번호 · 만들고 적용하고 고양이 · 이름을 저장한 뒤 "지금" 커밋 번호 */
  async function makeScout() {
    const before = (await ipc.customHistory()).commits[0]!.hash;
    expect((await ipc.customNew({ kind: "agent", name: "scout", description: "정찰", model: null, effort: null })).outcome).toBe("saved");
    expect((await ipc.customApply()).outcome).toBe("applied");
    expect((await ipc.customCatsSave([{ agent: "scout", cat: "nabi" }])).commit).toBe("committed");
    expect((await ipc.customLabelSave("scout", "정찰")).commit).toBe("committed");
    const now = (await ipc.customHistory()).commits[0]!.hash;
    return { before, now };
  }

  it("만들기 전 커밋으로 되돌리면 에이전트 · 고양이 · 이름이 함께 빠지고, 다시 지금으로 되돌리면 모두 돌아온다 (화면 · 공용 모듈 포함)", async () => {
    let before = "";
    let now = "";
    await show("full", async () => {
      ({ before, now } = await makeScout());
    });
    expect(listNames()).toContain("정찰");
    await waitFor(() => expect(getMine().labels).toEqual({ translator: "번역", scout: "정찰" }), WAIT);

    // 화면에서 기록 탭으로 되돌린다
    tab("기록");
    const list = await screen.findByRole("navigation", { name: "기록" });
    fireEvent.click(within(list).getByRole("button", { name: /원본 업데이트 받음 \(7c41e2a\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "이때로 되돌리기" }));
    const band = (await screen.findByText(/때로 되돌릴까요\?/)).closest(".ed-bnr") as HTMLElement;
    fireEvent.click(within(band).getByRole("button", { name: "되돌리기" }));
    await screen.findByText(/때로 되돌렸어요 — 새 기록이 생겼어요/, undefined, WAIT);
    expect((await ipc.customList()).items.some((e) => e.id === "agent:scout")).toBe(false);
    expect(await labelsNow()).toEqual({ translator: "번역" });
    expect(await catsNow()).toEqual({ translator: "dubu" });
    expect(await unappliedNow()).toBe(0);
    // 집 · 채팅 · 진행 보기가 쓰는 공용 모듈도 그때 모습을 따라간다
    await waitFor(() => expect(getMine().labels).toEqual({ translator: "번역" }), WAIT);
    await waitFor(() => expect(getMine().cats).toEqual({ translator: "dubu" }), WAIT);

    // 다시 "지금" 으로 — 모두 돌아온다
    const forward = await ipc.customRestore(now);
    expect(forward.outcome).toBe("restored");
    expect(await labelsNow()).toEqual({ translator: "번역", scout: "정찰" });
    expect(await catsNow()).toEqual({ translator: "dubu", scout: "nabi" });
    await reopen();
    expect(listNames()).toContain("정찰");
    // 이력은 줄지 않았다 (되돌리기 둘 다 새 기록)
    const kinds = await kindsNow();
    expect(kinds.slice(0, 2)).toEqual(["restore", "restore"]);
    expect(before).not.toBe(now);
  });

  it("적용 안 한 것이 있으면 되돌리기가 거절되고 고양이 · 이름은 그대로 — 버리고 나면 된다", async () => {
    let before = "";
    await show("full", async () => {
      ({ before } = await makeScout());
      await ipc.customValuesSave("agent:harness-builder-ui", { model: "haiku", effort: null });
    });
    const refused = await ipc.customRestore(before);
    expect(refused.outcome).toBe("has_unapplied");
    expect(await catsNow()).toEqual({ translator: "dubu", scout: "nabi" });
    expect(await labelsNow()).toEqual({ translator: "번역", scout: "정찰" });
    expect((await ipc.customDiscard()).outcome).toBe("discarded");
    expect((await ipc.customRestore(before)).outcome).toBe("restored");
    expect(await catsNow()).toEqual({ translator: "dubu" });
  });

  it("되돌리다 설치가 실패하면 파일 · 고양이 · 이름 어느 것도 반쯤 되돌아가지 않는다", async () => {
    let before = "";
    await show("full", async () => {
      ({ before } = await makeScout());
    });
    const headBefore = (await ipc.customHistory()).commits[0]!.hash;
    fakeCustom.failNextInstall();
    const result = await ipc.customRestore(before);
    expect(result.outcome).toBe("failed");
    expect((await ipc.customHistory()).commits[0]!.hash).toBe(headBefore);
    expect(await catsNow()).toEqual({ translator: "dubu", scout: "nabi" });
    expect(await labelsNow()).toEqual({ translator: "번역", scout: "정찰" });
    expect((await ipc.customList()).items.some((e) => e.id === "agent:scout")).toBe(true);
    expect(await unappliedNow()).toBe(0);
  });
});

describe("경우 8 — 적용 도중 다른 쓰기 (가짜의 한 번에 하나)", () => {
  it("적용이 도는 동안 저장 · 고양이 · 이름 · 되돌리기 · 버리기는 harness_busy — 끝난 뒤 적용 커밋에는 처음 저장한 파일만 있다", async () => {
    await show("fresh", async () => {
      await ipc.customValuesSave("agent:harness-builder-ui", { model: "opus", effort: null });
    });
    const applying = ipc.customApply("느린 적용");
    const blocked = await Promise.allSettled([
      ipc.customValuesSave("agent:harness-designer", { model: "haiku", effort: null }),
      ipc.customAppendSave("agent:harness-designer", "늦게 쓴 글"),
      ipc.customCatsSave([{ agent: "harness-designer", cat: "nabi" }]),
      ipc.customLabelSave("harness-designer", "디자인"),
      ipc.customDiscard(),
      ipc.customRestore("0123456"),
      ipc.customNew({ kind: "agent", name: "late-one", description: "x", model: null, effort: null }),
    ]);
    for (const [index, one] of blocked.entries()) {
      expect(one.status, `${index}`).toBe("rejected");
      expect(((one as PromiseRejectedResult).reason as AppError).kind, `${index}`).toBe("harness_busy");
    }
    const result = await applying;
    expect(result.outcome).toBe("applied");
    expect(result.files).toBe(1);
    const commits = (await ipc.customHistory()).commits;
    expect(commits.map((c) => c.kind)).toEqual(["apply", "start"]);
    expect(commits[0]!.files).toEqual(["agents/harness-builder-ui.values.yml"]);
    expect(await unappliedNow()).toBe(0);
    expect(await catsNow()).toEqual({});
    // 잠금은 풀렸다
    expect((await ipc.customValuesSave("agent:harness-designer", { model: "haiku", effort: null })).outcome).toBe("saved");
  });
});
