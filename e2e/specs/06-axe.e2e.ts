// 흐름 6 — 접근성 (D-55): 고양이 집 · 작업 공간 (채팅 · 진행 · 문서 · 요구사항) · 「내 수정」 (하네스 전 · 후) 에서 axe 위반 0 (밝은 · 어두운 테마).
// 신뢰 대화상자는 03-trust 에서 같은 검사를 한다.
import { $, browser, expect } from "@wdio/globals";
import { axeBothThemes } from "../lib/axe.ts";
import { seedProject } from "../lib/db.ts";
import { seedHarness } from "../lib/harness.ts";
import { goTo } from "../lib/ui.ts";

async function expectNoViolations(): Promise<void> {
  const { light, dark } = await axeBothThemes();
  expect({ light }).toEqual({ light: [] });
  expect({ dark }).toEqual({ dark: [] });
}

async function openTab(name: string): Promise<void> {
  const tab = await $('[role="tablist"]').$(`[role="tab"]*=${name}`);
  await tab.click();
  await browser.pause(300); // 탭 판이 바뀌는 동안
}

describe("접근성 (axe)", () => {
  before(async () => {
    await $("h1").waitForDisplayed();
    seedProject("axe-demo", { "requirements.md": "# 요구사항\n\n- 첫째\n- 둘째\n", "docs/notes.md": "# 노트\n\n본문\n" });
  });

  it("고양이 집", async () => {
    await $("h1").waitForDisplayed();
    // 사용량 · 고양이 그림이 자리 잡도록
    await browser.pause(1500);
    await expectNoViolations();
  });

  it("작업 공간 — 채팅", async () => {
    await goTo("작업 공간");
    await $('nav[aria-label="프로젝트"]').$("button*=axe-demo").click();
    await $('textarea[aria-label="보낼 말"]').waitForDisplayed();
    await expectNoViolations();
  });

  it("작업 공간 — 진행", async () => {
    await openTab("진행");
    await expectNoViolations();
  });

  it("작업 공간 — 문서", async () => {
    await openTab("문서");
    await expectNoViolations();
  });

  it("작업 공간 — 요구사항", async () => {
    await openTab("요구사항");
    await $(".cm-editor").waitForDisplayed({ timeout: 15_000 });
    await expectNoViolations();
  });

  it("내 수정 — 하네스를 받기 전 (원본이 없는 상태)", async () => {
    await goTo("내 수정");
    await $("h1").waitForDisplayed();
    await browser.pause(800);
    await expectNoViolations();
  });

  it("내 수정 — 하네스가 있을 때 (에이전트 · 스킬 목록과 상세)", async () => {
    seedHarness();
    await goTo("집");
    await $("h1").waitForDisplayed();
    await goTo("내 수정");
    await $("button*=화면 구현").waitForDisplayed({ timeout: 20_000 });
    await expectNoViolations();
    await $("button*=화면 구현").click();
    await $('button[role="radio"][data-key="model"]').waitForDisplayed();
    await expectNoViolations();
  });
});
