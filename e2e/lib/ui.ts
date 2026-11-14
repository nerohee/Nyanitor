// 시험 도우미 — 사용자가 보는 것 (글자 · 역할 · 이름표) 로 찾는다.
import { browser, $ } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sandboxFromEnv } from "./sandbox.ts";

export const sandbox = sandboxFromEnv();

/** 왼쪽 메뉴의 이동 단추 (집 · 작업 공간 · 내 수정) */
export async function goTo(place: "집" | "작업 공간" | "내 수정"): Promise<void> {
  const nav = await $('nav[aria-label="탐색"]');
  const button = await nav.$(`button=${place}`);
  await button.click();
}

/** 가짜 CLI 가 이 앱 실행에서 재생할 녹화 */
export function useReplay(name: string): void {
  fs.writeFileSync(sandbox.replayFile, name);
}

/** 앱 로그 (시험 폴더 `logs` 아래의 첫 파일) 내용 */
export function readAppLog(): string {
  if (!fs.existsSync(sandbox.logs)) return "";
  return fs
    .readdirSync(sandbox.logs)
    .map((f) => fs.readFileSync(path.join(sandbox.logs, f), "utf8"))
    .join("\n");
}

/** 지금 포커스가 있는 곳을 사람이 읽게 (태그 · 이름표 · 글자) */
export async function describeFocus(): Promise<string> {
  return browser.execute(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "(없음)";
    const label = el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30) ?? "";
    return `${el.tagName.toLowerCase()}|${label}`;
  });
}

/** 앱 안에서 `:focus-visible` 이 맞고 테두리(outline)가 실제로 그려지는가 — 포커스 테가 보이는지 */
export async function focusRing(): Promise<{ matches: boolean; style: string; width: number }> {
  return browser.execute(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { matches: false, style: "none", width: 0 };
    const css = getComputedStyle(el);
    return { matches: el.matches(":focus-visible"), style: css.outlineStyle, width: parseFloat(css.outlineWidth) };
  });
}

/** 열린 프로젝트 → 채팅 탭의 입력줄 */
export const composer = () => $('textarea[aria-label="보낼 말"]');

/** 글을 쓰고 Enter 로 보낸다 */
export async function sendChat(text: string): Promise<void> {
  const input = await composer();
  await input.waitForEnabled();
  await input.click();
  await input.setValue(text);
  await browser.keys("Enter");
}

/** 가짜 CLI 가 받은 인자 줄 — 작업 세션을 띄운 것만 (`--permission-prompt-tool` 이 있는 것) */
export function sessionLaunches(): number {
  const file = path.join(sandbox.root, "fake-claude.log");
  if (!fs.existsSync(file)) return 0;
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes('"argv"') && line.includes("--permission-prompt-tool")).length;
}

/** 이 시험의 tauri-driver 밑에서 뜬 `nyanitor.exe` 의 pid — 고객이 띄운 앱과 섞이지 않게 프로세스 나무로 찾는다 */
export function findAppPid(): number {
  const driverPid = Number(fs.readFileSync(path.join(sandbox.root, "driver.pid"), "utf8"));
  const script = [
    "$all = Get-CimInstance Win32_Process",
    "function Kids($p) { $all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $_; Kids $_.ProcessId } }",
    `$app = Kids ${driverPid} | Where-Object { $_.Name -eq 'nyanitor.exe' } | Select-Object -First 1`,
    "if ($app) { $app.ProcessId }",
  ].join("; ");
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
  if (!/^\d+$/.test(out)) throw new Error("이 시험의 앱 프로세스를 못 찾았다");
  return Number(out);
}

/** 창 닫기 단추와 같은 신호 (WM_CLOSE) 를 앱 창에 보낸다 — 앱은 닫지 않고 트레이로 숨긴다 */
export function closeAppWindow(pid: number): boolean {
  const script = `$p = Get-Process -Id ${pid}; $p.CloseMainWindow()`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim() === "True";
}
