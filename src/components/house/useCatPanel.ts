// 고양이 고르기 · 정보 패널 열고 닫기. Enter(버튼) 로 열고, Esc 로 닫으면 그 고양이 버튼으로 포커스가 돌아간다.
// 패널 바깥(장면 빈 곳 · 카드 · 다른 곳)을 누르면 닫히고 포커스는 누른 곳으로 간다. 고양이 단추 · 패널 안을 누르면 그대로 (고양이는 단추가 알아서 바꾼다).
import { useCallback, useEffect, useRef, useState } from "react";
import { CAT_IDS, type CatId } from "../cat/catalog";

export const PANEL_ID = "house-cat-panel";

/** 주소에 `&cat=nabi` 가 있으면 그 고양이 정보를 연 채로 시작 (스크린샷 · 고객 확인용) */
function catFromUrl(): CatId | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("cat");
  return CAT_IDS.find((id) => id === value) ?? null;
}

export function useCatPanel() {
  const [openCat, setOpenCat] = useState<CatId | null>(catFromUrl);
  const buttons = useRef(new Map<CatId, HTMLButtonElement>());

  const register = useCallback((cat: CatId, el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(cat, el);
    else buttons.current.delete(cat);
  }, []);

  const toggle = useCallback((cat: CatId) => {
    setOpenCat((current) => (current === cat ? null : cat));
  }, []);

  const close = useCallback(() => {
    if (openCat) buttons.current.get(openCat)?.focus();
    setOpenCat(null);
  }, [openCat]);

  useEffect(() => {
    if (!openCat) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        buttons.current.get(openCat)?.focus();
        setOpenCat(null);
      }
    };
    // 눌렀을 때(pointerdown) 닫는다 — 누른 것이 카드 단추여도 그 단추는 평소대로 눌린다 (닫는 건 장면 층의 정보 패널뿐)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".hs-bubble")) return;
      for (const button of buttons.current.values()) if (button.contains(target)) return;
      setOpenCat(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [openCat]);

  return { openCat, register, toggle, close };
}

export type CatPanel = ReturnType<typeof useCatPanel>;
