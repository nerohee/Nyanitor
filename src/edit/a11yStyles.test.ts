// P10-04 (D-55) — 글자 모양으로만 확인할 수 있는 스타일 고침: jsdom 은 CSS 를 계산하지 못해서 소스 글과 토큰 값으로 본다.
// 실제 보이는 모습(낮은 창 683×343 · 포커스 테)은 브라우저에서 확인한다.
import { describe, expect, it } from "vitest";
// @ts-expect-error @types/node 가 없다 (vite.config.ts 도 같은 이유로 이렇게 부른다) — vitest 는 `?raw` 로 부른 CSS 글을 비워서 파일로 읽는다
import { readFileSync } from "node:fs";

const read = (path: string): string => (readFileSync(new URL(path, import.meta.url), "utf-8") as string).split("\r").join("");
const editCss = read("./edit.css");
const homeCss = read("../home/home.css");
const houseCss = read("../components/house/house.css");
const tokens = read("../styles/tokens.css");

/** 규칙 하나의 본문 (선택자가 그대로 맞는 첫 규칙) */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} 규칙을 찾는다`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** `[data-skin="3"]` 절(밝게) · `:root[data-theme="dark"] [data-skin="3"]` 절(어둡게)에서 토큰 값 하나 */
function token(name: string, dark: boolean): string {
  const head = dark ? ':root[data-theme="dark"] [data-skin="3"] {' : '[data-skin="3"] {';
  const at = tokens.indexOf(head);
  expect(at).toBeGreaterThanOrEqual(0);
  const block = tokens.slice(at, tokens.indexOf("}", at));
  const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  expect(found, `${name} (${dark ? "어둡게" : "밝게"})`).not.toBeNull();
  return found![1]!;
}

describe("읽을 수 없는 항목 이름 — 투명도 대신 토큰 색 (대비 4.5:1 이상)", () => {
  it("투명도로 흐리게 하지 않고 · 파일 이름은 12px 이상", () => {
    expect(editCss).not.toMatch(/data-unreadable[^{]*\{[^}]*opacity/);
    expect(rule(editCss, '.ed-item[data-unreadable="true"] .ed-item__name')).toContain("color: var(--color-text-muted)");
    expect(rule(editCss, ".ed-item__file")).toContain("font-size: var(--text-xs)");
  });

  for (const dark of [false, true]) {
    it(`흐린 이름(--color-text-muted)이 목록 바탕 · 올린 줄 · 고른 줄 위에서 4.5:1 이상 — ${dark ? "어둡게" : "밝게"}`, () => {
      const fore = token("--color-text-muted", dark);
      for (const back of ["--color-surface-sunken", "--color-surface", "--accent-soft"]) {
        const value = ratio(fore, token(back, dark));
        expect(value, `${back} 위 ${value.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("고양이 포커스 테", () => {
  it("집 화면의 `.home :focus-visible` 보다 높은 선택자로 집 장면의 짙은 선 + 크림 테가 이긴다", () => {
    expect(homeCss).toMatch(/\.home :focus-visible\s*\{/);
    expect(houseCss).toMatch(/\.hs-cat \.hs-cat__btn:focus-visible\s*\{/);
    const body = rule(houseCss, ".hs-cat .hs-cat__btn:focus-visible");
    expect(body).toContain("outline: 2px solid var(--house-tag-text)");
    expect(body).toContain("box-shadow: 0 0 0 5px var(--house-tag-bg)");
  });
});

describe("낮은 창", () => {
  const at = editCss.indexOf("@media (max-height: 420px)");
  const block = at >= 0 ? editCss.slice(at, editCss.indexOf("\n}\n", at)) : "";
  it("683×343 은 줄이고 (머리말 · 적용 바 · 아래 줄), 911×450 · 1024×640 은 해당하지 않는다", () => {
    expect(at).toBeGreaterThanOrEqual(0);
    for (const part of [".ed-tray__head", ".ed-tray__lead", ".ed-apply__where", ".ed-apply__bar", ".ed-foot", ".ed-panel__head"]) expect(block).toContain(part);
    expect(343).toBeLessThanOrEqual(420);
    expect(450).toBeGreaterThan(420);
  });
});
