import { afterEach, describe, expect, it } from "vitest";
import { allowsContextMenu, installChrome } from "./chrome";

afterEach(() => {
  document.body.innerHTML = "";
});

function fireContextMenu(target: Element): boolean {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("installChrome", () => {
  it("꺼져 있으면(개발 빌드) 우클릭을 막지 않는다", () => {
    document.body.innerHTML = `<p id="plain">앱 틀</p>`;
    const dispose = installChrome(document, false);

    expect(fireContextMenu(document.getElementById("plain")!)).toBe(false);
    dispose();
  });

  it("켜 두면 일반 영역의 우클릭을 막는다", () => {
    document.body.innerHTML = `<p id="plain">앱 틀</p>`;
    const dispose = installChrome(document, true);

    expect(fireContextMenu(document.getElementById("plain")!)).toBe(true);
    dispose();
  });

  it("입력칸 · 편집 가능한 곳 · .selectable (그 안쪽 포함) 은 우클릭을 허용한다", () => {
    document.body.innerHTML = `
      <input id="a" />
      <textarea id="b"></textarea>
      <div id="c" contenteditable="true"><span id="c-child">글</span></div>
      <div class="selectable"><b id="d-child">본문</b></div>`;
    const dispose = installChrome(document, true);

    for (const id of ["a", "b", "c", "c-child", "d-child"]) {
      expect(fireContextMenu(document.getElementById(id)!), id).toBe(false);
    }
    dispose();
  });

  it("해제하면 다시 막지 않는다", () => {
    document.body.innerHTML = `<p id="plain">앱 틀</p>`;
    installChrome(document, true)();

    expect(fireContextMenu(document.getElementById("plain")!)).toBe(false);
  });

  it("이미지 끌기를 막는다", () => {
    document.body.innerHTML = `<img id="img" alt="" />`;
    const dispose = installChrome(document, true);
    const event = new Event("dragstart", { bubbles: true, cancelable: true });

    document.getElementById("img")!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    dispose();
  });
});

describe("allowsContextMenu", () => {
  it("대상이 요소가 아니면 허용하지 않는다", () => {
    expect(allowsContextMenu(null)).toBe(false);
    expect(allowsContextMenu(document)).toBe(false);
  });
});
