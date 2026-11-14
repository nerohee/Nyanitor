// P10-06 (D-55) — 첫 창 바탕색이 화면의 바탕 토큰과 같은지 (설정 파일 · `window.rs` · `tokens.css` 세 곳이 같은 값).
// 다르면 첫 화면이 그려지기 전 창 색과 화면 색이 달라 깜빡인다.
import { describe, expect, it } from "vitest";
// @ts-expect-error @types/node 가 없다 (vite.config.ts 도 같은 이유로 이렇게 부른다) — vitest 는 `?raw` 로 부른 CSS 글을 비워서 파일로 읽는다
import { readFileSync } from "node:fs";

const read = (path: string): string => (readFileSync(new URL(path, import.meta.url), "utf-8") as string).split("\r").join("");

const tokens = read("../styles/tokens.css");
const windowRs = read("../../src-tauri/src/window.rs");
const conf = JSON.parse(read("../../src-tauri/tauri.conf.json")) as { app: { windows: { backgroundColor?: string }[] } };

/** `0xfb, 0xf8, 0xf3` 모양 */
const rgb = (hex: string) => [1, 3, 5].map((i) => `0x${hex.slice(i, i + 2)}`).join(", ");

describe("첫 창 바탕색", () => {
  const light = /^:root \{[^}]*?--color-bg: (#[0-9a-f]{6});/m.exec(tokens)?.[1];
  const dark = /^:root\[data-theme="dark"\] \{\s*--color-bg: (#[0-9a-f]{6});/m.exec(tokens)?.[1];

  it("토큰 파일에서 밝은 · 어두운 바탕을 찾는다", () => {
    expect(light).toMatch(/^#[0-9a-f]{6}$/);
    expect(dark).toMatch(/^#[0-9a-f]{6}$/);
    expect(light).not.toBe(dark);
  });

  it("설정 파일의 backgroundColor 는 밝은 테마 바탕 토큰과 같다", () => {
    expect(conf.app.windows[0]?.backgroundColor).toBe(light);
  });

  it("window.rs 의 밝은 · 어두운 바탕 상수는 토큰과 같다", () => {
    expect(windowRs).toContain(`pub const LIGHT_BACKGROUND: Color = Color(${rgb(light as string)}, 0xff);`);
    expect(windowRs).toContain(`pub const DARK_BACKGROUND: Color = Color(${rgb(dark as string)}, 0xff);`);
  });
});
