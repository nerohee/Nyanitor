/**
 * 집 화면의 창 비율 배율 (`--hm-s`) — 기준 창 1280×800 에서 1, 그보다 작으면 폭 · 높이 중 더 줄어든 쪽만큼 줄고, 큰 창에서도 1 (키우지 않는다) (P6-08).
 *
 * 예전에는 CSS `tan(atan2(100vw, 1280px))` 로 구했는데, macOS 웹뷰(WebKit)가 이 값을 음수로 내서
 * 큰 창일수록 카드가 좁아지고 위 · 왼쪽으로 밀려 잘렸다 (P11-08, 2026-11-17 고객 MacBook Air). 그래서 창 크기로 직접 계산한다.
 */
import { useEffect, useState } from "react";

export const HOME_BASE_W = 1280;
export const HOME_BASE_H = 800;

/** 창 크기 → 배율 (0 초과 1 이하). 크기를 모르면 (0 · 음수 · 숫자 아님) 1 — 줄이지 않는다 */
export function homeScale(width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return 1;
  const s = Math.min(1, width / HOME_BASE_W, height / HOME_BASE_H);
  return Math.round(s * 10000) / 10000;
}

function current(): number {
  return typeof window === "undefined" ? 1 : homeScale(window.innerWidth, window.innerHeight);
}

/** 창 크기가 바뀔 때마다 다시 계산한 배율 */
export function useHomeScale(): number {
  const [scale, setScale] = useState(current);
  useEffect(() => {
    const update = () => setScale(current());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return scale;
}
