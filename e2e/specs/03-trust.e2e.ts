// 흐름 3 — 폴더 신뢰 (D-54): 훅이 있는 폴더는 첫 말에서 확인을 받고, 믿은 폴더는 앱을 다시 띄워도 안 묻는다.
import { browser, $, expect } from "@wdio/globals";
import { axeBothThemes } from "../lib/axe.ts";
import { seedProject } from "../lib/db.ts";
import { composer, describeFocus, goTo, sendChat, sessionLaunches, useReplay } from "../lib/ui.ts";

const SETTINGS = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }, null, 2);
const TITLE = "이 폴더의 설정을 확인해 주세요";
const dialog = () => $('div[role="dialog"]');

async function openProject(name: string): Promise<void> {
  await goTo("작업 공간");
  const project = await $('nav[aria-label="프로젝트"]').$(`button*=${name}`);
  await project.waitForDisplayed();
  await project.click();
  await composer().waitForDisplayed();
}

describe("폴더 신뢰", () => {
  before(async () => {
    await $("h1").waitForDisplayed();
    seedProject("trusty", { ".claude/settings.json": SETTINGS });
    useReplay("start");
  });

  it("훅이 있는 폴더에서 말을 보내면 설정 확인 대화상자가 뜨고 제목에 포커스가 있다", async () => {
    await openProject("trusty");
    await sendChat("안녕");
    await dialog().waitForDisplayed({ timeout: 20_000, timeoutMsg: "신뢰 대화상자가 안 떴다" });
    expect(await dialog().$("h2").getText()).toBe(TITLE);
    expect(await describeFocus()).toBe(`h2|${TITLE}`);
    expect(await dialog().getText()).toContain("echo hi");
  });

  it("신뢰 대화상자에 axe 위반이 없다", async () => {
    // 대화상자가 불러온 내용을 다 보여 줄 때까지
    await dialog().$("button=믿고 시작").waitForEnabled({ timeout: 10_000 });
    const { light, dark } = await axeBothThemes();
    expect({ light }).toEqual({ light: [] });
    expect({ dark }).toEqual({ dark: [] });
  });

  it("「취소」 하면 세션을 시작하지 않고 쓴 글이 입력줄에 남는다", async () => {
    await dialog().$("button=취소").click();
    await dialog().waitForExist({ reverse: true, timeout: 10_000 });
    expect(await composer().getValue()).toBe("안녕");
    // 이 프로젝트의 작업 세션은 뜬 적이 없다 (가짜 CLI 에 세션 인자가 안 왔다)
    await browser.pause(1000);
    expect(sessionLaunches()).toBe(0);
  });

  it("다시 보내고 「믿고 시작」 하면 세션이 시작되고 답이 온다", async () => {
    await composer().click();
    await browser.keys("Enter");
    await dialog().waitForDisplayed({ timeout: 20_000 });
    await dialog().$("button=믿고 시작").waitForEnabled({ timeout: 10_000 });
    await dialog().$("button=믿고 시작").click();
    await dialog().waitForExist({ reverse: true, timeout: 10_000 });
    await browser.waitUntil(async () => (await $("body").getText()).includes("pong"), { timeout: 30_000, timeoutMsg: "가짜 CLI 의 답(pong)이 안 왔다" });
    expect(sessionLaunches()).toBe(1);
  });

  it("앱을 다시 띄워도 같은 폴더는 다시 묻지 않는다", async () => {
    await browser.reloadSession(); // 앱을 끄고 다시 띄운다 (같은 시험 폴더)
    await $("h1").waitForDisplayed({ timeout: 30_000 });
    await openProject("trusty");
    await sendChat("또 안녕");
    await browser.waitUntil(() => sessionLaunches() === 2, { timeout: 30_000, timeoutMsg: "두 번째 세션이 안 떴다" });
    expect(await dialog().isExisting()).toBe(false);
  });
});
