// 작업 공간 공통 조각 — 탭/나란히 틀, 편집기, 채팅, 단계 보드, 요약 로그, 원본 출력, 프로젝트 목록, 일하는 고양이.
// 배치 · 크기는 시안 CSS 가 정한다.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import type { CatId } from "../../components/cat/looks";
import { t, tf } from "../../i18n/ko";
import { AGENTS, type Activity } from "../fixtures";
import type { Phase, WorkspaceFixture } from "../fixtures-workspace";
import { ChatItemView, isPending, PENDING_CARD_ID } from "./cards";
import { Icon } from "./icons";
import type { CatAgent } from "./scene";
import "./workspace.css";

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
  /** 기다리는 카드 수 (탭에 표시, D-25) */
  badge?: number;
  content: ReactNode;
}

interface WorkPanelsProps {
  panels: WorkPanel[];
  wide: boolean;
  initial: string;
  className?: string;
  /** 탭 줄 오른쪽에 붙일 것 (시안 a 의 작은 창문) */
  tabExtra?: ReactNode;
}

/** 넓으면 칸을 나란히, 좁으면 탭. 탭은 ←/→ · Home/End 로 옮긴다 (WAI-ARIA tabs) */
export function WorkPanels({ panels, wide, initial, className, tabExtra }: WorkPanelsProps) {
  const [active, setActive] = useState(initial);
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  if (wide) {
    return (
      <div className={`wp wp--wide${className ? ` ${className}` : ""}`}>
        {panels.map((panel) => (
          <section key={panel.id} className={`wp__panel wp__panel--${panel.id}`} aria-label={panel.label}>
            {panel.content}
          </section>
        ))}
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
    setActive(next.id);
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
    <div className={`wp wp--tabs${className ? ` ${className}` : ""}`}>
      <div className="wp__bar">
        <div className="wp__tabs" role="tablist" aria-label={t("variant.ws.tabs")} onKeyDown={onKeyDown}>
          {panels.map((panel) => {
            const selected = panel.id === current.id;
            return (
              <button
                key={panel.id}
                type="button"
                role="tab"
                id={`wp-tab-${panel.id}`}
                aria-selected={selected}
                aria-controls={`wp-panel-${panel.id}`}
                tabIndex={selected ? 0 : -1}
                className="wp__tab"
                onClick={() => setActive(panel.id)}
                ref={(el) => {
                  if (el) tabs.current.set(panel.id, el);
                  else tabs.current.delete(panel.id);
                }}
              >
                {panel.label}
                {panel.badge ? (
                  <span className="wp__badge" aria-label={tf("variant.ws.badge", { n: panel.badge })}>
                    {panel.badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {tabExtra}
      </div>
      <section
        role="tabpanel"
        id={`wp-panel-${current.id}`}
        aria-labelledby={`wp-tab-${current.id}`}
        className={`wp__panel wp__panel--${current.id}`}
      >
        {current.content}
      </section>
    </div>
  );
}

// ── 편집기 ──

/** 아주 작은 마크다운 보기 (# 제목 · - 목록 · 문단만). 새 의존성 없이 미리보기 모양만 — 실제 편집기는 P6 CodeMirror */
function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  text.split("\n").forEach((line) => {
    if (line.startsWith("- ")) {
      list.push(line.slice(2));
      return;
    }
    flush();
    if (line.startsWith("## ")) blocks.push(<h3 key={blocks.length}>{line.slice(3)}</h3>);
    else if (line.startsWith("# ")) blocks.push(<h2 key={blocks.length}>{line.slice(2)}</h2>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{line}</p>);
  });
  flush();
  return <div className="md selectable">{blocks}</div>;
}

export function RequirementsEditor({ fx, initialMode = "write" }: { fx: WorkspaceFixture; initialMode?: "write" | "preview" }) {
  const [mode, setMode] = useState(initialMode);
  const text = fx.requirementsKey ? t(fx.requirementsKey) : "";
  const empty = !fx.requirementsKey;
  return (
    <div className="wed">
      <div className="wed__bar">
        <code className="wed__path">{fx.requirementsPath}</code>
        <span className="wed__saved">
          <Icon name="check" size={14} />
          {t("variant.ws.editor.saved")}
        </span>
        <div className="wed__mode" role="group" aria-label={t("variant.ws.editor.mode")}>
          <button type="button" aria-pressed={mode === "write"} onClick={() => setMode("write")}>
            {t("variant.ws.editor.write")}
          </button>
          <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>
            {t("variant.ws.editor.preview")}
          </button>
        </div>
      </div>
      {empty && (
        <div className="wempty">
          <p className="wempty__title">{t("variant.ws.editor.emptyTitle")}</p>
          <p className="wempty__body">{t("variant.ws.editor.emptyBody")}</p>
          <button type="button" className="hbtn hbtn--primary">
            {t("variant.ws.editor.emptyAction")}
          </button>
        </div>
      )}
      {mode === "write" || empty ? (
        <textarea
          className="wed__text"
          aria-label={t("variant.ws.editor.textarea")}
          defaultValue={text}
          placeholder={empty ? t("variant.ws.editor.placeholder") : undefined}
          spellCheck={false}
        />
      ) : (
        <div className="wed__preview">
          <MarkdownLite text={text} />
        </div>
      )}
    </div>
  );
}

// ── 채팅 ──

export function OrchestratorStatus({ fx }: { fx: WorkspaceFixture }) {
  return (
    <p className="wstatus" data-state={fx.orchestrator}>
      <span className="wstatus__avatar" aria-hidden="true">
        <CatFigure cat="nabi" crop="face" motion="still" />
      </span>
      <b>{t("cat.nabi.name")}</b>
      <span className="status-dot" aria-hidden="true" />
      <span>{t(`variant.ws.chat.status.${fx.orchestrator}`)}</span>
    </p>
  );
}

function Composer({ running }: { running: boolean }) {
  return (
    <form className="wcomposer" onSubmit={(event) => event.preventDefault()}>
      <textarea className="wcomposer__input" rows={2} aria-label={t("variant.ws.chat.input")} placeholder={t("variant.ws.chat.placeholder")} />
      <div className="wcomposer__row">
        <button type="button" className="wcomposer__skill" aria-haspopup="listbox">
          <span>{t("variant.ws.chat.skill")}</span>
          <code>/desktop-app</code>
        </button>
        <span className="wcomposer__spacer" />
        {running && (
          <button type="button" className="hbtn">
            {t("variant.ws.chat.stop")}
          </button>
        )}
        <button type="submit" className="hbtn hbtn--primary">
          {t("variant.ws.chat.send")}
        </button>
      </div>
    </form>
  );
}

/** 채팅 칸: 상태 · (기다리는 카드 안내) · 대화 · 입력줄 */
export function ChatPane({ fx, showStatus = true, below }: { fx: WorkspaceFixture; showStatus?: boolean; below?: ReactNode }) {
  const pendingIndex = fx.chat.findIndex(isPending);
  const log = useRef<HTMLDivElement>(null);
  // 채팅은 맨 아래(가장 최근 · 기다리는 카드)부터 보인다
  useLayoutEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [fx.chat.length]);
  const jump = () => {
    const card = document.getElementById(PENDING_CARD_ID);
    card?.scrollIntoView({ block: "center" });
    card?.focus();
  };
  return (
    <div className="wchat">
      {showStatus && <OrchestratorStatus fx={fx} />}
      {fx.pending > 0 && (
        <div className="wchat__waiting" role="status">
          <span>{t("variant.ws.chat.waitingBanner")}</span>
          <button type="button" className="hbtn" onClick={jump}>
            {t("variant.ws.chat.jump")}
          </button>
        </div>
      )}
      <div className="wchat__log" ref={log}>
        {fx.chat.length === 0 ? (
          <div className="wempty">
            <p className="wempty__title">{t("variant.ws.chat.emptyTitle")}</p>
            <p className="wempty__body">{t("variant.ws.chat.emptyBody")}</p>
          </div>
        ) : (
          fx.chat.map((item, i) => (
            <ChatItemView key={item.id} item={item} pendingId={i === pendingIndex ? PENDING_CARD_ID : undefined} />
          ))
        )}
      </div>
      {below}
      <Composer running={fx.orchestrator === "thinking"} />
    </div>
  );
}

// ── 진행 보기 ──

export function PhaseBoard({ phases, className }: { phases: Phase[]; className?: string }) {
  return (
    <ol className={`wboard${className ? ` ${className}` : ""}`} aria-label={t("variant.ws.board")}>
      {phases.map((phase) => (
        <li key={phase.id} className="wboard__item" data-status={phase.status} aria-current={phase.status === "running" || phase.status === "waiting" ? "step" : undefined}>
          <span className="wboard__id">{phase.id}</span>
          <span className="wboard__name">{t(phase.labelKey)}</span>
          <span className="wboard__owners">{phase.owners.map((cat) => t(`cat.${cat}.name`)).join(" · ")}</span>
          <span className="wboard__status">{t(`variant.ws.phase.${phase.status}`)}</span>
        </li>
      ))}
    </ol>
  );
}

export function ProgressLog({ fx }: { fx: WorkspaceFixture }) {
  if (fx.log.length === 0) return <p className="wlog__empty">{t("variant.ws.logEmpty")}</p>;
  return (
    <ol className="wlog">
      {fx.log.map((item) => (
        <li key={`${item.time}-${item.textKey}`}>
          <time>{item.time}</time>
          <span className="wlog__face" aria-hidden="true">
            <CatFigure cat={item.cat} crop="face" motion="still" />
          </span>
          <span>{t(item.textKey)}</span>
        </li>
      ))}
    </ol>
  );
}

/** CLI 원본 출력 — 접어 두고 펼치기 (D-13). <details> 라 Enter · Space 로 열린다 */
export function RawOutput({ fx }: { fx: WorkspaceFixture }) {
  if (fx.raw.length === 0) return null;
  return (
    <details className="wraw">
      <summary>
        {t("variant.ws.raw")}
        <span>{t("variant.ws.rawHint")}</span>
      </summary>
      <pre className="selectable">{fx.raw.join("\n")}</pre>
    </details>
  );
}

// ── 프로젝트 목록 ──

export function ProjectNavList({ fx, className, layout = "list" }: { fx: WorkspaceFixture; className?: string; layout?: "list" | "chips" }) {
  return (
    <nav className={`wproj wproj--${layout}${className ? ` ${className}` : ""}`} aria-label={t("variant.ws.projects")}>
      {layout === "list" && <h2 className="wproj__title">{t("variant.ws.projects")}</h2>}
      <ul>
        {fx.projects.map((project) => (
          <li key={project.id}>
            <button type="button" className="wproj__item" aria-current={project.id === fx.selectedId ? "page" : undefined}>
              <span className="wproj__name">{t(project.nameKey)}</span>
              {project.running ? (
                <span className="wproj__run">
                  <span className="status-dot" aria-hidden="true" />
                  {t("variant.ws.running")}
                </span>
              ) : (
                layout === "list" && <span className="wproj__when">{t(project.openedKey)}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="hbtn hbtn--ghost wproj__new">
        <Icon name="plus" size={16} />
        {t("variant.ws.newProject")}
      </button>
      {layout === "list" && <p className="wproj__note">{t("variant.ws.oneAtATime")}</p>}
    </nav>
  );
}

// ── 고양이 ──

/** 작업 공간에서의 고양이 7마리 — 일하는 고양이는 fixture 대로, 나머지는 집 자리 그대로 (빈 프로젝트면 아무도 일하지 않음) */
export function workspaceAgents(fx: WorkspaceFixture): CatAgent[] {
  const working = new Map<CatId, Activity>(fx.working.map((w) => [w.cat, w.activity]));
  return AGENTS.map((agent) => {
    const now = working.get(agent.cat);
    if (now) return { cat: agent.cat, activity: now };
    if (agent.activity === "wheel" || agent.activity === "tower" || agent.activity === "window") {
      return { cat: agent.cat, activity: "idle" as Activity };
    }
    return { cat: agent.cat, activity: agent.activity };
  });
}

/** 일하는 고양이 이름 한 줄 (그림 옆 글로도 — 색 · 그림만으로 알리지 않음) */
export function WorkingLine({ fx, inline = false }: { fx: WorkspaceFixture; inline?: boolean }) {
  const Tag = inline ? "span" : "p";
  if (fx.working.length === 0) return <Tag className="wworking">{t("variant.ws.noWorking")}</Tag>;
  return (
    <Tag className="wworking">
      {fx.working.map((w, i) => (
        <Fragment key={w.cat}>
          {i > 0 && " · "}
          <b>{t(`cat.${w.cat}.name`)}</b> {t(`cat.activity.${w.activity}`)}
        </Fragment>
      ))}
    </Tag>
  );
}
