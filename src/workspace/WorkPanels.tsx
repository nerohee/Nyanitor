// 작업 공간의 칸 틀 — 넓은 창(1280px 이상)이면 칸을 나란히(접을 수 있는 칸은 띠로), 좁은 창이면 탭. 시제품 `variants/shared/workspace.tsx` 의 `WorkPanels` · `useWide` 를 바탕으로.
// 탭은 ←/→ · Home/End 로 옮긴다 (WAI-ARIA tabs). 칸 너비는 칸마다 정한다 (시안과 같게).
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import { Icon } from "../variants/shared/icons";

/** 넓은 창(1280px 이상)이면 나란히, 아니면 탭 (plan §5) */
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
  /** 넓은 창에서 칸 너비 (grid 값). 접으면 띠 */
  size: string;
  /** 넓은 창에서 접을 수 있나 */
  collapsible?: boolean;
  content: ReactNode | ((collapse: (() => void) | undefined) => ReactNode);
}

interface Props {
  panels: WorkPanel[];
  wide: boolean;
  active: string;
  onActive: (id: string) => void;
  className?: string;
  /** 탭 줄 왼쪽 (좁은 창의 프로젝트 바꾸기) */
  tabStart?: ReactNode;
}

export function WorkPanels({ panels, wide, active, onActive, className, tabStart }: Props) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const render = (panel: WorkPanel, collapse?: () => void) => (typeof panel.content === "function" ? panel.content(collapse) : panel.content);

  if (wide) {
    const columns = panels.map((panel) => (collapsed.includes(panel.id) ? "44px" : panel.size)).join(" ");
    return (
      <div className={`ws-wp ws-wp--wide${className ? ` ${className}` : ""}`} style={{ gridTemplateColumns: columns }}>
        {panels.map((panel) => {
          const folded = collapsed.includes(panel.id);
          return (
            <Fragment key={panel.id}>
              {folded && (
                <button
                  type="button"
                  className="ws-wp__strip"
                  aria-label={tf("variant.ws.expand", { name: panel.label })}
                  onClick={() => setCollapsed((prev) => prev.filter((id) => id !== panel.id))}
                >
                  <Icon name="expand" size={16} />
                  <span className="ws-wp__strip-text">{panel.label}</span>
                </button>
              )}
              {/* 접어도 칸은 그대로 두고 숨긴다 — 편집기의 글 · 저장이 끊기지 않게 */}
              <section className={`ws-wp__panel ws-wp__panel--${panel.id}`} aria-label={panel.label} hidden={folded}>
                {render(panel, panel.collapsible ? () => setCollapsed((prev) => [...prev, panel.id]) : undefined)}
              </section>
            </Fragment>
          );
        })}
      </div>
    );
  }

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
                {panel.badge ? (
                  <span className="ws-wp__badge" aria-label={tf("variant.ws.badge", { n: panel.badge })}>
                    {panel.badge}
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
          {render(panel)}
        </section>
      ))}
    </div>
  );
}
