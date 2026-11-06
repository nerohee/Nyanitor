// 작업 공간의 칸 틀 — 창 크기와 상관없이 판 하나에 탭 [채팅] [요구사항] (P6-08). 시제품 `variants/shared/workspace.tsx` 의 `WorkPanels` · `useWide` 를 바탕으로.
// 탭은 ←/→ · Home/End 로 옮긴다 (WAI-ARIA tabs). 안 보이는 탭도 마운트된 채로 숨긴다. `useWide` 는 프로젝트 목록을 옆에 둘지 정하는 데 쓴다.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import { Icon } from "../variants/shared/icons";

/** 넓은 창(1280px 이상)이면 프로젝트 목록을 옆에 둔다, 아니면 탭 줄의 프로젝트 바꾸기 (plan §5) */
export function useWide(query = "(min-width: 1280px)"): boolean {
  const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setWide(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return wide;
}

export interface WorkPanel {
  id: string;
  label: string;
  /** 기다리는 카드 수 (좁은 창의 탭에 붙는다, D-25) */
  badge?: number;
  /** 탭에 붙는 짧은 알림 글 (예: "충돌") — 색만이 아니라 글 · 아이콘으로. 이름표에도 붙는다 */
  flag?: string;
  content: ReactNode;
}

interface Props {
  panels: WorkPanel[];
  active: string;
  onActive: (id: string) => void;
  className?: string;
  /** 탭 줄 왼쪽 (좁은 창의 프로젝트 바꾸기) */
  tabStart?: ReactNode;
}

export function WorkPanels({ panels, active, onActive, className, tabStart }: Props) {
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  const index = Math.max(
    0,
    panels.findIndex((panel) => panel.id === active),
  );
  const current = panels[index];
  const move = (to: number) => {
    const next = panels[(to + panels.length) % panels.length];
    onActive(next.id);
    tabs.current.get(next.id)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") move(index + 1);
    else if (event.key === "ArrowLeft") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(panels.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div className={`ws-wp ws-wp--tabs${className ? ` ${className}` : ""}`}>
      <div className="ws-wp__bar">
        {tabStart}
        <div className="ws-wp__tabs" role="tablist" aria-label={t("variant.ws.tabs")} onKeyDown={onKeyDown}>
          {panels.map((panel) => {
            const selected = panel.id === current.id;
            return (
              <button
                key={panel.id}
                type="button"
                role="tab"
                id={`ws-tab-${panel.id}`}
                aria-selected={selected}
                aria-controls={`ws-panel-${panel.id}`}
                tabIndex={selected ? 0 : -1}
                className="ws-wp__tab"
                onClick={() => onActive(panel.id)}
                ref={(el) => {
                  if (el) tabs.current.set(panel.id, el);
                  else tabs.current.delete(panel.id);
                }}
              >
                {panel.label}
                {panel.flag ? (
                  <span className="ws-wp__flag">
                    <Icon name="alert" size={12} />
                    {panel.flag}
                  </span>
                ) : null}
                {panel.badge ? (
                  <span className="ws-wp__badge">
                    <span aria-hidden="true">{panel.badge}</span>
                    <span className="ws-sr">{tf("variant.ws.badge", { n: panel.badge })}</span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
      {/* 안 보이는 탭도 그대로 두고 숨긴다 — 편집기의 글 · 저장이 끊기지 않게 */}
      {panels.map((panel) => (
        <section
          key={panel.id}
          role="tabpanel"
          id={`ws-panel-${panel.id}`}
          aria-labelledby={`ws-tab-${panel.id}`}
          className={`ws-wp__panel ws-wp__panel--${panel.id}`}
          hidden={panel.id !== current.id}
        >
          {panel.content}
        </section>
      ))}
    </div>
  );
}
