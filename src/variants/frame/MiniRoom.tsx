import type { ReactNode } from "react";

/**
 * 시안 틀 확인용 작은 방 — 벽 · 창(하늘 · 지평) · 창으로 드는 빛(창 뒤에 깔림) · 바닥. 색은 시간대 토큰(--house-*).
 * 실제 집 장면은 P2-02 시안이 그린다. 이것은 토큰 · 고양이 규격을 보이기 위한 배경일 뿐이다.
 */
export function MiniRoom({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <div className={className ? `vf-room ${className}` : "vf-room"}>
      <div className="vf-room__light" aria-hidden="true" />
      <div className="vf-room__window" aria-hidden="true">
        <span className="vf-room__sky" />
        <span className="vf-room__horizon" />
      </div>
      <div className="vf-room__floor" aria-hidden="true" />
      <div className="vf-room__stage">{children}</div>
    </div>
  );
}
