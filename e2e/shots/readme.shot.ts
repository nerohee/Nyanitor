// README 그림 (`npm run screenshots`) — 실제 앱 창 · 가짜 CLI · 시험 폴더로 같은 장면을 다시 찍는다. 그림은 `assets/readme/` (또는 `SHOTS_OUT`).
// 한 번의 앱 실행에서 차례로 찍는다: 작업 공간 채팅 → 집 → 고양이 정보 창 → 진행 보기 → 내 수정 → 어두운 집.
// 화면에 찍히는 글 (프로젝트 · 대화 · 에이전트) 은 `lib/shotdata.ts` · `lib/shotfiles.ts`, 창 · 시계 · 경로 가리기 · 개인 정보 확인은 `lib/shotkit.ts`.
import path from "node:path";
import { browser, $, expect } from "@wdio/globals";
import { PROJECT_MAIN, seedProjects, stampRecent } from "../lib/shotdata.ts";
import { FIRST_MESSAGE } from "../lib/shotfiles.ts";
import { advanceClock, prepareBrowser, setTheme, snap, type ShotInfo } from "../lib/shotkit.ts";
import { diffSnapshots, loadSnapshot, takeSnapshot } from "../lib/snapshot.ts";
import { composer, goTo, sandbox, sendChat } from "../lib/ui.ts";

const shots: ShotInfo[] = [];

/** 이 선택자에 맞는 요소 수 */
const count = (selector: string) => browser.execute((css) => document.querySelectorAll(css).length, selector);

/** 포커스 · 입력 깜빡임이 그림에 남지 않게 */
async function blurFocus(): Promise<void> {
  await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** 집이 다 그려졌다 — 준비 카드 · 사용량 숫자 · 오늘 츄르 · 최근 프로젝트 · 고양이 일곱 */
async function waitHomeReady(): Promise<void> {
  await $("h1").waitForDisplayed();
  await browser.waitUntil(async () => (await $(".hm-ready").getText()).includes("4/4"), { timeout: 30_000, timeoutMsg: "준비 카드가 4/4 가 안 됐다" });
  await browser.waitUntil(async () => (await count('[role="meter"]')) === 2, { timeout: 30_000, timeoutMsg: "사용량 막대가 안 떴다" });
  await browser.waitUntil(async () => (await $(".hm-usage__read").getText()).includes("읽음"), { timeout: 30_000, timeoutMsg: "사용량 읽은 때가 안 떴다" });
  await browser.waitUntil(async () => (await $(".hm-usage__churros").getText()).includes("츄르 약"), { timeout: 30_000, timeoutMsg: "오늘 츄르가 안 떴다" });
  await browser.waitUntil(async () => (await count(".hm-recent__item")) === 3, { timeout: 30_000, timeoutMsg: "최근 프로젝트 셋이 안 떴다" });
  await browser.waitUntil(async () => (await count("div[data-cat]")) === 7, { timeout: 30_000, timeoutMsg: "고양이 일곱이 안 모였다" });
  await browser.pause(1500); // 자리를 잡고 이름표 · 그림이 바뀐 뒤
}

describe("README 그림", () => {
  before(async () => {
    await $("h1").waitForDisplayed();
    seedProjects(); // 하네스 · 사용량 · 대화 녹화는 앱이 뜨기 전에 놓였다 (run.ts 의 캡처 모드)
    await prepareBrowser();
  });

  it("작업 공간 채팅 — 말하면 작업자 둘이 일하고 단계 승인 카드가 뜬다", async () => {
    await goTo("작업 공간");
    const project = await $('nav[aria-label="프로젝트"]').$(`button*=${PROJECT_MAIN}`);
    await project.waitForDisplayed({ timeout: 20_000 });
    await project.click();
    await composer().waitForDisplayed();
    await sendChat(FIRST_MESSAGE);
    const card = await $("article*=승인 요청");
    await card.waitForDisplayed({ timeout: 30_000, timeoutMsg: "단계 승인 카드가 안 떴다" });
    await browser.waitUntil(async () => (await $("body").getText()).includes("문서 정리"), { timeout: 10_000, timeoutMsg: "작업자 줄이 안 떴다" });
    await browser.pause(800);
    // 대화가 맨 아래까지 내려가 있어 말한 줄이 위에서 조금 잘린다 — 카드 아래 여백만큼 올려 첫 말이 온전히 보이게
    await browser.execute(() => {
      const log = document.querySelector<HTMLElement>(".wc-log");
      if (log) log.scrollTop = Math.max(0, log.scrollTop - 12);
    });
    await blurFocus();
    shots.push(await snap("workspace-chat"));
  });

  it("집 — 일하는 고양이 둘 · 기다리는 먹물 · 준비 완료 · 츄르 · 최근 프로젝트", async () => {
    await advanceClock(3); // 카드를 기다린 지 3분 (이 뒤로 새로 그리는 화면부터 보인다)
    stampRecent(); // 프로젝트를 열며 앱이 고친 "최근에 연 때" 를 정한 값으로
    await goTo("집");
    await waitHomeReady();
    expect(await $(".hm-usage").getText()).toContain("38%");
    shots.push(await snap("home"));
  });

  it("집 — 고양이를 누르면 정보 창이 열린다", async () => {
    await $('[data-cat="dubu"] button').click();
    await $(".hm-info").waitForDisplayed({ timeout: 10_000 });
    await browser.pause(600);
    shots.push(await snap("home-cat"));
  });

  it("작업 공간 진행 보기 — 단계 보드 · 일하는 고양이 · 요약 기록", async () => {
    await goTo("작업 공간");
    await $('[role="tab"]*=진행').click();
    await $('[data-testid="progress-pane"]').waitForDisplayed({ timeout: 20_000 });
    await browser.waitUntil(async () => (await $('[data-testid="progress-pane"]').getText()).includes("P1"), { timeout: 20_000, timeoutMsg: "단계 보드가 안 떴다" });
    await browser.pause(1200);
    await blurFocus();
    shots.push(await snap("workspace-progress"));
  });

  it("내 수정 — 에이전트 파일 하나를 연 모습", async () => {
    await goTo("내 수정");
    const item = await $("button*=화면 구현");
    await item.waitForDisplayed({ timeout: 20_000 });
    await item.click();
    await $('button[role="radio"][data-key="model"]').waitForDisplayed({ timeout: 20_000 });
    await browser.pause(1200);
    await blurFocus();
    shots.push(await snap("edit"));
  });

  it("어두운 집 — 같은 집을 어두운 테마로", async () => {
    stampRecent();
    await goTo("집");
    await waitHomeReady();
    await setTheme("dark");
    await browser.pause(800);
    shots.push(await snap("home-dark"));
    await setTheme("light");
  });

  it("실제 앱 데이터 폴더는 그대로다", async () => {
    const changes = diffSnapshots(loadSnapshot(path.join(sandbox.root, "real-baseline.json")), takeSnapshot());
    expect(changes).toEqual([]);
    console.log(shots.map((shot) => `${shot.name}.png ${shot.width}×${shot.height} ${Math.round(shot.bytes / 1024)}KB`).join("\n"));
  });
});
