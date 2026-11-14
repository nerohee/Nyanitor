// 흐름 1 — 앱이 뜨고 고양이 집이 보인다. 시험 폴더로 격리되어 실제 데이터 폴더는 그대로다.
import fs from "node:fs";
import path from "node:path";
import { browser, $, expect } from "@wdio/globals";
import { loadSnapshot, takeSnapshot, diffSnapshots } from "../lib/snapshot.ts";
import { readAppLog, sandbox } from "../lib/ui.ts";

describe("뜸 · 고양이 집", () => {
  it("시험 폴더 로그의 첫 줄이 격리 모드를 알린다", async () => {
    await browser.waitUntil(() => readAppLog() !== "", { timeout: 20_000, timeoutMsg: "시험 폴더 logs 에 로그가 없다" });
    const first = readAppLog().split("\n").find((l) => l.trim() !== "") ?? "";
    expect(first).toContain("E2E mode:");
  });

  it("앱 데이터 · 로컬 데이터가 시험 폴더 아래에 생긴다", async () => {
    await browser.waitUntil(() => fs.existsSync(path.join(sandbox.data, "nyanitor.db")), { timeout: 20_000, timeoutMsg: "시험 폴더에 DB 가 없다" });
    expect(fs.existsSync(path.join(sandbox.root, "local"))).toBe(true);
  });

  it("실제 앱 데이터 폴더의 파일은 새로 생기지도 바뀌지도 않는다", async () => {
    const changes = diffSnapshots(loadSnapshot(path.join(sandbox.root, "real-baseline.json")), takeSnapshot());
    expect(changes).toEqual([]);
  });

  it("고양이 집이 보인다", async () => {
    const title = await $("h1");
    await title.waitForDisplayed();
    expect(await title.getText()).toBeTruthy();
  });
});
