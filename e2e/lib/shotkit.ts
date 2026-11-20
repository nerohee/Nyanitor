// README 그림 도구 — 창 크기 · 밝기 · 움직임을 고정하고, 시계 · 난수를 고정하고, 경로를 가리고, 개인 정보가 없는지 확인한 뒤 그림을 남긴다.
// 앱 코드는 고치지 않는다 — 앱 창 안에서 `browser.execute` 로 쓰는 것만이다 (WebView 의 `Date` · `Math.random` 바꿔 끼우기, CDP 의 화면 설정).
import { browser } from "@wdio/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLOCK } from "./shotfiles.ts";
import { sandbox } from "./ui.ts";

/** 창 안쪽 (CSS 픽셀) — 집 화면의 기준 크기와 같다 (`useHomeScale`) */
export const VIEW = { width: 1280, height: 800 } as const;

/** 그림에서 프로젝트 폴더의 윗부분으로 보일 중립 경로 (실제 시험 폴더는 `%TEMP%` 아래라 사용자 이름이 들어 있다) */
const NEUTRAL_PROJECTS = "D:\\projects";

type Cdp = (method: string, params: object) => Promise<unknown>;

function cdp(): Cdp {
  return (browser as unknown as { sendCommand: Cdp }).sendCommand.bind(browser);
}

/** 밝은 테마 · 어두운 테마 — 앱은 OS 설정(`prefers-color-scheme`)을 따르므로 화면 설정을 바꿔 끼운다 (앱 설정 · 실제 OS 설정은 건드리지 않는다) */
export async function setTheme(theme: "light" | "dark"): Promise<void> {
  await cdp()("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await browser.pause(300);
}

/** 창 안쪽을 `VIEW` 크기로 — 창 바깥 크기를 맞춘 뒤 안쪽 차이를 보정한다 */
async function fitWindow(): Promise<void> {
  await browser.setWindowSize(VIEW.width, VIEW.height);
  for (let i = 0; i < 4; i += 1) {
    const inner = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
    if (inner.w === VIEW.width && inner.h === VIEW.height) return;
    const outer = await browser.getWindowSize();
    await browser.setWindowSize(outer.width + (VIEW.width - inner.w), outer.height + (VIEW.height - inner.h));
  }
  const inner = await browser.execute(() => ({ w: window.innerWidth, h: window.innerHeight }));
  if (inner.w !== VIEW.width || inner.h !== VIEW.height) throw new Error(`창 안쪽을 ${VIEW.width}×${VIEW.height} 로 못 맞췄다: ${inner.w}×${inner.h}`);
}

/** 경로 가리기 · 시계 · 난수를 앱 창에 건다 (한 번). 이미 그려진 화면은 다음에 다시 그려질 때부터 바뀐다 — 화면을 오가며 새로 그린다 */
async function installShims(): Promise<void> {
  const roots = [sandbox.projects];
  await browser.execute(
    (base, roots, neutral) => {
      const w = window as unknown as Record<string, unknown>;
      if (w.__shotsInstalled) return;
      w.__shotsInstalled = true;

      // 시계: 새로 만드는 `Date` 는 항상 이 시각 (고정) — 실제 날짜가 아니라 그림 속 "지금"
      const RealDate = Date;
      let offset = 0;
      class FixedDate extends RealDate {
        constructor(...args: unknown[]) {
          if (args.length === 0) super(base + offset);
          else super(...(args as [number]));
        }
        static now(): number {
          return base + offset;
        }
      }
      window.Date = FixedDate as unknown as DateConstructor;
      w.__shotsAdvance = (ms: number) => {
        offset += ms;
      };

      // 난수: 같은 씨앗 (쉬는 고양이가 앉는 자리가 같게)
      let seed = 20261026;
      Math.random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      // 경로: 시험 폴더 경로(사용자 이름이 든다)를 중립 경로로 — 글 · 이름표 · 속성 모두, 나중에 다시 그려져도
      const pairs: [string, string][] = [];
      for (const root of roots) {
        pairs.push([root, neutral]);
        pairs.push([root.replaceAll("\\", "\\\\"), neutral.replaceAll("\\", "\\\\")]);
        pairs.push([root.replaceAll("\\", "/"), neutral.replaceAll("\\", "/")]);
      }
      const mask = (value: string): string => {
        let out = value;
        for (const [from, to] of pairs) if (out.includes(from)) out = out.split(from).join(to);
        return out;
      };
      const ATTRS = ["title", "aria-label", "alt", "placeholder", "value", "data-doc"];
      const fixNode = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.nodeValue ?? "";
          const masked = mask(text);
          if (masked !== text) node.nodeValue = masked;
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const el = node as Element;
        // 진행 기록의 시각: 작업자 줄은 앱 (Rust) 이 실제 시계로 적는다 — 그림 속 시계로 맞춘다
        if (el.tagName === "TIME" && el.closest(".ws-lg")) {
          const now = new Date();
          const clock = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
          if (el.textContent !== clock) el.textContent = clock;
        }
        for (const name of ATTRS) {
          const value = el.getAttribute(name);
          if (value !== null) {
            const masked = mask(value);
            if (masked !== value) el.setAttribute(name, masked);
          }
        }
        el.childNodes.forEach(fixNode);
      };
      fixNode(document.documentElement);
      new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === "characterData" || record.type === "attributes") fixNode(record.target);
          record.addedNodes.forEach(fixNode);
        }
      }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    },
    new Date(CLOCK.year, CLOCK.month - 1, CLOCK.day, CLOCK.hour, CLOCK.minute, 0).getTime(),
    roots,
    NEUTRAL_PROJECTS,
  );
}

/** 찍기 전 한 번 — 창 크기 · 밝은 테마 · 줄인 움직임 · 시계 · 난수 · 경로 가리기 */
export async function prepareBrowser(): Promise<void> {
  await fitWindow();
  await cdp()("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await installShims();
}

/** 그림 속 시계를 앞으로 보낸다 (다음에 새로 그려지는 화면부터 보인다 — "n분째" 처럼) */
export async function advanceClock(minutes: number): Promise<void> {
  await browser.execute((ms) => (window as unknown as { __shotsAdvance: (n: number) => void }).__shotsAdvance(ms), minutes * 60_000);
}

/** 마우스를 아무것도 없는 구석으로 — 눌러 둔 단추의 눌림 · 가리킴 표시가 그림에 남지 않게 */
export async function parkMouse(): Promise<void> {
  await browser.action("pointer").move({ x: VIEW.width - 2, y: VIEW.height - 2, duration: 0 }).perform();
  await browser.pause(150);
}

/** 개인 정보가 화면에 있는지 — 사용자 이름이 든 경로 · 시험 폴더 · 앱 데이터 폴더. 있으면 글로 돌려준다 (없으면 빈 목록) */
export async function leaks(): Promise<string[]> {
  const needles = [
    sandbox.root,
    path.basename(sandbox.root),
    "nyanitor-e2e",
    os.tmpdir(),
    os.homedir(),
    `\\Users\\${os.userInfo().username}`,
    `/Users/${os.userInfo().username}`,
    "AppData",
  ];
  return browser.execute((needles) => {
    const dump = document.documentElement.outerHTML;
    const found: string[] = [];
    for (const needle of needles) {
      for (const form of [needle, needle.replaceAll("\\", "\\\\"), needle.replaceAll("\\", "/")]) {
        if (form !== "" && dump.toLowerCase().includes(form.toLowerCase())) found.push(form);
      }
    }
    return [...new Set(found)];
  }, needles);
}

export interface ShotInfo {
  name: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
}

/** PNG 머리에서 크기를 읽는다 */
function pngSize(file: string): { width: number; height: number } {
  const head = fs.readFileSync(file).subarray(0, 24);
  if (head.toString("ascii", 1, 4) !== "PNG") throw new Error(`PNG 가 아니다: ${file}`);
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** 그림 한 장 — 개인 정보가 없는지 먼저 확인하고 (있으면 그림을 남기지 않고 멈춘다) `E2E_SHOTS_OUT/<이름>.png` 로 저장한다 */
export async function snap(name: string): Promise<ShotInfo> {
  const out = process.env.E2E_SHOTS_OUT;
  if (!out) throw new Error("E2E_SHOTS_OUT 이 없다 — `npm run screenshots` 로 돌린다");
  const found = await leaks();
  if (found.length > 0) throw new Error(`${name}: 개인 정보가 화면에 있다 — ${found.join(" · ")}`);
  await parkMouse();
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${name}.png`);
  await browser.saveScreenshot(file);
  const size = pngSize(file);
  const bytes = fs.statSync(file).size;
  console.log(`그림 ${name}.png — ${size.width}×${size.height} · ${Math.round(bytes / 1024)} KB`);
  return { name, file, ...size, bytes };
}
