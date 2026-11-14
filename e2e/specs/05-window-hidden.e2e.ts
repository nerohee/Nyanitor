// 흐름 5 — 창 숨김 (D-55): 창이 숨으면 웹뷰의 `document.visibilityState` 가 `hidden` 이 되어 애니메이션 · 주기 읽기가 쉰다.
// 최소화 → 다시 보이게 (WebDriver 로 되돌릴 수 있다), 그리고 창 닫기 단추와 같은 신호 → 트레이로 숨김 (되돌릴 길 = 트레이 아이콘뿐이라 마지막에).
import { browser, $, expect } from "@wdio/globals";
import { closeAppWindow, findAppPid } from "../lib/ui.ts";

const visibility = () => browser.execute(() => document.visibilityState);

describe("창 숨김", () => {
  before(async () => {
    await $("h1").waitForDisplayed();
  });

  it("처음에는 보인다 (visible)", async () => {
    expect(await visibility()).toBe("visible");
  });

  it("최소화하면 hidden 이 되고 다시 열면 visible 로 돌아온다", async () => {
    await browser.minimizeWindow();
    await browser.waitUntil(async () => (await visibility()) === "hidden", { timeout: 10_000, timeoutMsg: "최소화했는데 visibilityState 가 hidden 이 안 됐다" });
    await browser.maximizeWindow();
    await browser.waitUntil(async () => (await visibility()) === "visible", { timeout: 10_000, timeoutMsg: "다시 열었는데 visibilityState 가 visible 로 안 돌아왔다" });
  });

  it("창 닫기 신호를 보내면 앱은 끝나지 않고 숨고 (hidden) 웹뷰는 계속 살아 있다", async () => {
    const pid = findAppPid();
    expect(closeAppWindow(pid)).toBe(true);
    await browser.waitUntil(async () => (await visibility()) === "hidden", { timeout: 10_000, timeoutMsg: "창 닫기 뒤에 visibilityState 가 hidden 이 안 됐다" });
    // 앱은 트레이로 숨었을 뿐 — 웹뷰가 아직 응답한다
    expect(await browser.execute(() => document.title)).toBeTruthy();
  });
});
