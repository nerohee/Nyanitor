// 흐름 2 — 프로젝트 · 채팅 · 권한 카드 · 키보드 (D-25 · D-55).
// 프로젝트는 시험 폴더 DB 에 미리 넣고, 가짜 CLI 가 권한 요청 둘을 한꺼번에 낸다.
import { browser, $, expect } from "@wdio/globals";
import { seedProject } from "../lib/db.ts";
import { describeFocus, focusRing, goTo, sendChat, useReplay } from "../lib/ui.ts";

/** 지금 포커스가 어느 카드 안인가 (카드의 코드 글자 = 파일 이름) */
async function focusedCardText(): Promise<string> {
  return browser.execute(() => {
    const card = document.activeElement?.closest("article");
    return card ? (card.textContent ?? "") : "";
  });
}

describe("프로젝트 · 채팅 · 권한 카드 · 키보드", () => {
  before(async () => {
    await $("h1").waitForDisplayed();
    seedProject("demo");
    useReplay("e2e-permission-two");
  });

  it("작업 공간에 미리 넣은 프로젝트가 보이고 열 수 있다", async () => {
    await goTo("작업 공간");
    const project = await $('nav[aria-label="프로젝트"]').$("button*=demo");
    await project.waitForDisplayed();
    await project.click();
    await $('textarea[aria-label="보낼 말"]').waitForDisplayed();
  });

  it("말을 보내면 권한 카드가 하나 뜨고 남은 요청이 하나 있다고 알린다", async () => {
    await sendChat("hello 파일을 만들어 줘");
    const card = await $('article[aria-label="권한 요청"]');
    await card.waitForDisplayed({ timeout: 30_000, timeoutMsg: "권한 카드가 안 떴다" });
    const text = await card.getText();
    expect(text).toContain("hello.txt");
    expect(text).toContain("남은 요청 1개");
    expect(text).toContain("답을 기다려요");
  });

  it("입력줄에서 Tab 을 한 번 누르면 기다리는 첫 카드로 포커스가 가고 포커스 테가 보인다", async () => {
    const input = await $('textarea[aria-label="보낼 말"]');
    await input.click();
    await browser.keys("Tab");
    expect(await describeFocus()).toMatch(/^article\|/);
    expect(await focusedCardText()).toContain("hello.txt");
    const ring = await focusRing();
    expect(ring.matches).toBe(true);
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });

  it("「이번만 허용」 을 Enter 로 누르면 포커스가 다음 카드로 간다", async () => {
    // 카드 안에서 Tab 으로 「이번만 허용」 까지
    for (let i = 0; i < 6 && !(await describeFocus()).endsWith("|이번만 허용"); i += 1) await browser.keys("Tab");
    expect(await describeFocus()).toBe("button|이번만 허용");
    expect(await focusedCardText()).toContain("hello.txt");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await focusedCardText()).includes("hello2.txt"), {
      timeout: 10_000,
      timeoutMsg: "다음 카드로 포커스가 안 갔다",
    });
    expect(await describeFocus()).toMatch(/^article\|/);
    const ring = await focusRing();
    expect(ring.matches).toBe(true);
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });

  it("마지막 카드에 답하면 포커스가 입력줄로 간다", async () => {
    for (let i = 0; i < 6 && !(await describeFocus()).endsWith("|이번만 허용"); i += 1) await browser.keys("Tab");
    expect(await describeFocus()).toBe("button|이번만 허용");
    expect(await focusedCardText()).toContain("hello2.txt");
    await browser.keys("Enter");
    await browser.waitUntil(async () => (await describeFocus()) === "textarea|보낼 말", {
      timeout: 10_000,
      timeoutMsg: "입력줄로 포커스가 안 갔다",
    });
  });
});
