import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { resetCardDrafts } from "../workspace/chat/cardDrafts";

afterEach(() => {
  cleanup();
  resetCardDrafts();
});

// jsdom 에는 글자 위치를 재는 `Range.getClientRects` · `getBoundingClientRect` 가 없다 — CodeMirror(요구사항 편집기)가 재려고 부른다.
// 위치는 모르니 빈 값으로 (시험은 글자 · 상태만 본다).
if (typeof Range !== "undefined") {
  const noRects = Object.assign([] as unknown as DOMRectList, { item: () => null });
  const emptyRect = { x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  Range.prototype.getClientRects ??= () => noRects;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
}
