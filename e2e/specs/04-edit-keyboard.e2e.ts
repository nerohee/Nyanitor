// 흐름 4 — 「내 수정」 고르기 키보드 (D-55): 화살표는 칸을 옮기기만 하고, 고르기(저장)는 Enter · Space · 클릭.
// 하네스는 시험 복사본 (`CLAUDE_HARNESS_HOME` 의 원본 `repo`) — 앱 안에서 쓰는 곳은 그 폴더의 `custom` 뿐이다.
import fs from "node:fs";
import path from "node:path";
import { browser, $, expect } from "@wdio/globals";
import { axeBothThemes } from "../lib/axe.ts";
import { seedHarness } from "../lib/harness.ts";
import { goTo, sandbox } from "../lib/ui.ts";

const CATS_FILE = () => path.join(sandbox.harnessHome, "custom", "agent-cats.json");
const AGENT_FILE = () => path.join(sandbox.harnessHome, "custom", "agents", "harness-builder-ui.values.yml");

/** 지금 포커스가 있는 요소의 역할과 글자 */
async function focused(): Promise<{ role: string; text: string; checked: string | null }> {
  return browser.execute(() => {
    const el = document.activeElement as HTMLElement | null;
    return { role: el?.getAttribute("role") ?? "", text: (el?.textContent ?? "").trim(), checked: el?.getAttribute("aria-checked") ?? null };
  });
}

/** 모델 줄에서 지금 고른 값 */
async function chosenModel(): Promise<string> {
  return browser.execute(() => document.querySelector('button[role="radio"][data-key="model"][aria-checked="true"]')?.textContent?.trim() ?? "");
}

describe("「내 수정」 고르기 키보드", () => {
  before(async () => {
    await $("h1").waitForDisplayed();
    seedHarness();
    await goTo("내 수정");
    await $("button*=화면 구현").waitForDisplayed({ timeout: 20_000 });
  });

  it("모델 줄 — 화살표는 칸만 옮기고 저장하지 않는다", async () => {
    await $("button*=화면 구현").click();
    await $('button[role="radio"][data-key="model"]').waitForDisplayed();
    // 이 항목의 모델 줄 (모델 · 수준 둘 중 첫째) 의 지금 칸으로 들어간다
    const before = await browser.execute(() => {
      const radio = document.querySelector<HTMLElement>('button[role="radio"][data-key="model"][aria-checked="true"]');
      radio?.focus();
      return (radio?.textContent ?? "").trim();
    });
    expect(before).toBe("Sonnet");
    await browser.keys("ArrowRight");
    const moved = await focused();
    expect(moved.role).toBe("radio");
    expect(moved.text).not.toBe(before);
    expect(moved.checked).toBe("false"); // 옮기기만 했다
    await browser.pause(1500); // 저장이 일어난다면 이 사이에
    expect(fs.existsSync(AGENT_FILE())).toBe(false);
    expect(await chosenModel()).toBe("Sonnet");
  });

  it("모델 줄 — Enter 로 고르면 저장된다", async () => {
    const target = (await focused()).text;
    await browser.keys("Enter");
    await browser.waitUntil(() => fs.existsSync(AGENT_FILE()), { timeout: 20_000, timeoutMsg: "Enter 로 골랐는데 내 수정 폴더에 저장이 안 됐다" });
    expect(fs.readFileSync(AGENT_FILE(), "utf8")).toMatch(new RegExp(`model:\\s*${target.toLowerCase()}`));
    expect((await focused()).checked).toBe("true");
  });

  it("고양이 바꾸기 — 에이전트 목록에서 고양이 고르기로 들어간다", async () => {
    await $("button*=고양이 바꾸기").click();
    await $("h1*=고양이").waitForDisplayed({ timeout: 15_000 });
    expect(fs.existsSync(CATS_FILE())).toBe(false);
  });

  it("고양이 칸 — Tab 으로 들어가 화살표를 눌러도 저장되지 않는다 (고른 표시 · 파일 그대로)", async () => {
    const tab = await $('[role="tab"]*=화면 구현');
    await tab.click();
    const first = await browser.execute(() => document.querySelector('[role="radiogroup"] [role="radio"][aria-checked="true"]')?.textContent?.trim() ?? "");
    expect(first).not.toBe("");
    for (let i = 0; i < 6 && (await focused()).role !== "radio"; i += 1) await browser.keys("Tab");
    expect((await focused()).role).toBe("radio");
    await browser.keys("ArrowRight");
    const moved = await focused();
    expect(moved.role).toBe("radio");
    expect(moved.checked).toBe("false");
    await browser.keys("ArrowRight");
    expect((await focused()).checked).toBe("false");
    await browser.pause(1500);
    expect(fs.existsSync(CATS_FILE())).toBe(false);
    const stillChecked = await browser.execute(() => document.querySelector('[role="radiogroup"] [role="radio"][aria-checked="true"]')?.textContent?.trim() ?? "");
    expect(stillChecked).toBe(first);
    expect(await $("body").getText()).not.toContain("서로 바꿨어요");
  });

  it("고양이 칸 — Enter 로 고르면 저장된다", async () => {
    const target = (await focused()).text;
    await browser.keys("Enter");
    await browser.waitUntil(() => fs.existsSync(CATS_FILE()), { timeout: 20_000, timeoutMsg: "Enter 로 골랐는데 agent-cats.json 이 안 생겼다" });
    expect(fs.readFileSync(CATS_FILE(), "utf8")).toContain("harness-builder-ui");
    await browser.waitUntil(async () => (await focused()).checked === "true", { timeout: 10_000, timeoutMsg: "고른 칸에 고른 표시가 안 갔다" });
    expect((await focused()).text).toBe(target);
  });

  it("고양이 고르기 화면에 axe 위반이 없다", async () => {
    const { light, dark } = await axeBothThemes();
    expect({ light }).toEqual({ light: [] });
    expect({ dark }).toEqual({ dark: [] });
  });
});
