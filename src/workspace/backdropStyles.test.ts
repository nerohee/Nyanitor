// P10-10 (D-55) — 흐린 마당(`.ws-backdrop`) 은 멈춘 그림: jsdom 은 CSS 를 계산하지 못해서 소스 글로 본다.
// 실제로 `document.getAnimations()` 가 0 인지는 브라우저에서 확인한다.
import { describe, expect, it } from "vitest";
// @ts-expect-error @types/node 가 없다 (a11yStyles.test.ts 와 같은 이유) — vitest 는 `?raw` 로 부른 CSS 글을 비워서 파일로 읽는다
import { readFileSync } from "node:fs";

const read = (path: string): string => (readFileSync(new URL(path, import.meta.url), "utf-8") as string).split("\r").join("");
const css = read("./workspace.css");

describe("흐린 마당", () => {
  it("안의 모든 것이 애니메이션 없이 — 풍경 · 고양이 · 장식 모두", () => {
    const at = css.indexOf(".ws-backdrop,\n.ws-backdrop * {");
    expect(at, "`.ws-backdrop` 와 그 안의 모든 것을 고르는 규칙").toBeGreaterThanOrEqual(0);
    const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
    expect(body).toMatch(/animation:\s*none\s*!important/);
  });
});
