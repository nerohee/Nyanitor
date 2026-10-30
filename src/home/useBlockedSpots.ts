// 카드에 덮인 고양이 자리를 잰다 — 장면 · 위 카드 · 아래 판 카드의 상자를 재서 `blockedSpots` (순수 함수) 에 넣는다.
// 창 크기 · 카드 크기가 바뀌면 다시 재고 (한 프레임에 한 번), 결과가 같으면 다시 그리지 않는다.
import { useLayoutEffect, useState, type RefObject } from "react";
import { blockedSpots } from "../components/house/blocked";
import type { SpotId } from "../components/house/spots";

/** 고양이를 덮는 카드들 — 위 카드 · 아래 판의 단추 · 카드 */
export const CARD_SELECTOR = ".hm-status, .hm-slab > *";

/** 장면 안의 카드 요소들 */
export function cardElements(scene: HTMLElement): Element[] {
  return Array.from(scene.querySelectorAll(CARD_SELECTOR));
}

/** 카드에 덮인 자리 — 아직 못 쟀으면 undefined */
export function useBlockedSpots(sceneRef: RefObject<HTMLElement | null>): readonly SpotId[] | undefined {
  const [blocked, setBlocked] = useState<readonly SpotId[]>();

  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const measure = () => {
      const next = blockedSpots(scene.getBoundingClientRect(), cardElements(scene).map((el) => el.getBoundingClientRect()));
      // 같은 결과면 같은 값을 그대로 (다시 그리지 않는다)
      setBlocked((prev) => (prev && prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next));
    };
    measure();

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    if (observer) {
      observer.observe(scene);
      for (const el of cardElements(scene)) observer.observe(el);
      const slab = scene.querySelector(".hm-slab");
      if (slab) observer.observe(slab);
    }
    return () => {
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [sceneRef]);

  return blocked;
}
