// 고양이 부위별 SVG (docs/01-planning/cat-assets.md 규격). 그림 파일을 갈아 끼우면 여기는 그대로 둔다.
// 파일은 문자열로 가져와 바깥 <svg> 만 벗기고 한 <svg> 안에 층 순서대로 쌓는다 — 그래야 CSS 변수(털색)가 닿는다.

const files = import.meta.glob<string>("../../assets/cats/**/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 부위 파일에서 XML 선언 · 주석 · 바깥 `<svg ...>` · `</svg>` 를 벗겨 안쪽만 남긴다. */
export function svgInner(raw: string): string {
  return raw
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[\s\S]*?<svg\b[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .trim();
}

const parts = new Map<string, string>();
for (const [path, raw] of Object.entries(files)) {
  // "../../assets/cats/base/tail.svg" → "base/tail"
  const name = path.replace(/^.*\/assets\/cats\//, "").replace(/\.svg$/, "");
  parts.set(name, svgInner(raw));
}

/** `base/tail` · `patterns/tabby-head` · `poses/sit/body` · `props/glasses` 처럼 부른다. 없으면 빈 문자열. */
export function catPart(name: string): string {
  return parts.get(name) ?? "";
}

/** 규격의 viewBox · 기준점 (cat-assets.md §1) */
export const CAT_VIEWBOX = "0 0 160 160";
export const CAT_ANCHOR = { x: 80, y: 148 } as const;
