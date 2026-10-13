// 웹 티 숨기기 (design.md §3): 출시 빌드에서 브라우저 기본 우클릭 메뉴(새로고침 · 검사)를 막고 이미지 끌기를 막는다.
// 입력칸 · 편집 가능한 곳 · `.selectable` 안에서는 우클릭(복사 · 붙여넣기)을 그대로 둔다.
// 글자 선택 막기는 `styles.css` 가 맡는다.

const CONTEXT_MENU_ALLOWED = "input, textarea, [contenteditable], [contenteditable='true'], .selectable";

/** 우클릭 메뉴를 그대로 보여 줘도 되는 곳인가. */
export function allowsContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(CONTEXT_MENU_ALLOWED) !== null;
}

/** `enabled` 가 참일 때만 막는다 (개발 중에는 우클릭 > 검사를 쓸 수 있게 `import.meta.env.PROD` 를 넘긴다). */
export function installChrome(doc: Document, enabled: boolean): () => void {
  if (!enabled) {
    return () => {};
  }
  const onContextMenu = (event: Event) => {
    if (!allowsContextMenu(event.target)) {
      event.preventDefault();
    }
  };
  const onDragStart = (event: Event) => {
    if (event.target instanceof HTMLImageElement) {
      event.preventDefault();
    }
  };
  doc.addEventListener("contextmenu", onContextMenu);
  doc.addEventListener("dragstart", onDragStart);
  return () => {
    doc.removeEventListener("contextmenu", onContextMenu);
    doc.removeEventListener("dragstart", onDragStart);
  };
}
