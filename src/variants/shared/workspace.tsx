// 작업 공간 공통 조각 — 나란히/탭 틀, 채팅(머리 · 대화 · 입력줄 · 스킬 고르기 · 중단 · 오류 띠).
// 편집기는 editor.tsx, 진행 보기는 progress.tsx, 프로젝트는 projects.tsx. 배치 · 크기는 시안 CSS 가 정한다.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, tf, type TextKey } from "../../i18n/ko";
import { ORCHESTRATOR } from "../fixtures";
import { SKILLS, type ChatItem, type OrchStatus, type RunBar as RunBarKind, type WorkspaceFixture } from "../fixtures-workspace";
import { ChatItemView, isPending, PENDING_CARD_ID } from "./cards";
import { Icon } from "./icons";
import "./shared.css";
import "./workspace.css";
import "./workspace-detail.css";

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
  /** 탭에 붙는 짧은 상태 (예: 진행 탭의 "P3") */
  note?: string;
  /** 살펴볼 것이 있으면 그 설명 — 접은 띠 · 탭에 점으로 */
  alert?: string;
  /** 넓은 창에서 칸 너비 (grid 값). 접으면 띠 */
  size: string;
  /** 넓은 창에서 접을 수 있나 */
  collapsible?: boolean;
  content: ReactNode | ((collapse: (() => void) | undefined) => ReactNode);
}

interface WorkPanelsProps {
  panels: WorkPanel[];
  wide: boolean;
  active: string;
  onActive: (id: string) => void;
  /** 넓은 창에서 처음에 접어 둘 칸 */
  initialCollapsed?: string[];
  className?: string;
  /** 탭 줄 왼쪽 (좁은 창의 프로젝트 바꾸기) */
  tabStart?: ReactNode;
  /** 탭 줄 오른쪽 (시안 a 의 작은 창문) */
  tabExtra?: ReactNode;
}

/** 넓으면 칸을 나란히(접을 수 있는 칸은 띠로), 좁으면 탭. 탭은 ←/→ · Home/End 로 옮긴다 (WAI-ARIA tabs) */
export function WorkPanels({ panels, wide, active, onActive, initialCollapsed = [], className, tabStart, tabExtra }: WorkPanelsProps) {
  const [collapsed, setCollapsed] = useState<string[]>(initialCollapsed);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const strips = useRef(new Map<string, HTMLButtonElement>());
  const render = (panel: WorkPanel, collapse?: () => void) =>
    typeof panel.content === "function" ? panel.content(collapse) : panel.content;

  if (wide) {
    const columns = panels.map((panel) => (collapsed.includes(panel.id) ? "44px" : panel.size)).join(" ");
    return (
      <div className={`wp wp--wide${className ? ` ${className}` : ""}`} style={{ gridTemplateColumns: columns }}>
        {panels.map((panel) =>
          collapsed.includes(panel.id) ? (
            <button
              key={panel.id}
              type="button"
              className="wp__strip"
              ref={(el) => {
                if (el) strips.current.set(panel.id, el);
                else strips.current.delete(panel.id);
              }}
              aria-label={tf("variant.ws.expand", { name: panel.label }) + (panel.alert ? ` — ${panel.alert}` : "")}
              title={panel.alert}
              onClick={() => setCollapsed((prev) => prev.filter((id) => id !== panel.id))}
            >
              <Icon name="expand" size={16} />
              <span className="wp__strip-text">{panel.label}</span>
              {panel.alert && <span className="wp__alert" aria-hidden="true" />}
            </button>
          ) : (
            <section key={panel.id} className={`wp__panel wp__panel--${panel.id}`} aria-label={panel.label}>
              {render(panel, panel.collapsible ? () => setCollapsed((prev) => [...prev, panel.id]) : undefined)}
            </section>
          ),
        )}
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
    <div className={`wp wp--tabs${className ? ` ${className}` : ""}`}>
      <div className="wp__bar">
        {tabStart}
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
                onClick={() => onActive(panel.id)}
                ref={(el) => {
                  if (el) tabs.current.set(panel.id, el);
                  else tabs.current.delete(panel.id);
                }}
              >
                {panel.label}
                {panel.alert && (
                  <>
                    <span className="wp__alert" aria-hidden="true" />
                    <span className="sr">{panel.alert}</span>
                  </>
                )}
                {panel.note && <span className="wp__note">{panel.note}</span>}
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
        {render(current)}
      </section>
    </div>
  );
}

// ── 채팅 머리 ──

export function OrchestratorStatus({
  status,
  noteKey,
  pending,
  onJump,
}: {
  status: OrchStatus;
  noteKey?: TextKey;
  pending: number;
  onJump: () => void;
}) {
  return (
    <div className="wstatus" data-state={status}>
      <span className="wstatus__avatar" aria-hidden="true">
        <CatFigure cat={ORCHESTRATOR} crop="face" />
      </span>
      <b>{t(`cat.${ORCHESTRATOR}.name`)}</b>
      <span className="wstatus__pill" role="status">
        <span className="status-dot" aria-hidden="true" />
        {t(`variant.ws.status.${status}`)}
        {noteKey && <span className="wstatus__note">{t(noteKey)}</span>}
      </span>
      <span className="wstatus__spacer" />
      {pending > 0 ? (
        <button type="button" className="hbtn wstatus__jump" onClick={onJump}>
          <Icon name="arrow" size={16} />
          {tf("variant.ws.chat.jumpN", { n: pending })}
        </button>
      ) : (
        <span className="wstatus__model" title={t("variant.ws.chat.modelHint")}>
          Opus · high
        </span>
      )}
    </div>
  );
}

// ── 스킬 고르기 (listbox 팝오버) ──

function SkillPicker({
  value,
  onChange,
  forceOpen,
  onClosed,
}: {
  value: string;
  onChange: (id: string) => void;
  forceOpen: boolean;
  onClosed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const isOpen = open || forceOpen;

  useEffect(() => {
    if (isOpen) list.current?.focus();
  }, [isOpen]);

  const close = (focusButton = true) => {
    setOpen(false);
    onClosed();
    if (focusButton) button.current?.focus();
  };
  const pick = (index: number) => {
    onChange(SKILLS[index].id);
    close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") setCursor((c) => (c + 1) % SKILLS.length);
    else if (event.key === "ArrowUp") setCursor((c) => (c - 1 + SKILLS.length) % SKILLS.length);
    else if (event.key === "Home") setCursor(0);
    else if (event.key === "End") setCursor(SKILLS.length - 1);
    else if (event.key === "Enter" || event.key === " ") pick(cursor);
    else if (event.key === "Escape" || event.key === "Tab") {
      close(event.key === "Escape");
      if (event.key === "Tab") return;
    } else return;
    event.preventDefault();
  };

  return (
    <div className="wskill">
      <button
        ref={button}
        type="button"
        className="wcomposer__skill"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listId}
        onClick={() => {
          setCursor(
            Math.max(
              0,
              SKILLS.findIndex((s) => s.id === value),
            ),
          );
          setOpen((v) => !v);
        }}
      >
        <span>{t("variant.ws.chat.skill")}</span>
        <code>{value || t("variant.ws.chat.skillNone")}</code>
        <Icon name="chevron" size={14} />
      </button>
      {isOpen && (
        <div className="wskill__pop">
          <p className="wskill__title" id={`${listId}-title`}>
            {t("variant.ws.chat.skillTitle")}
          </p>
          <ul
            ref={list}
            id={listId}
            role="listbox"
            tabIndex={0}
            aria-labelledby={`${listId}-title`}
            aria-activedescendant={`${listId}-${cursor}`}
            className="wskill__list"
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node)) close(false);
            }}
          >
            {SKILLS.map((skill, i) => (
              <li
                key={skill.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={skill.id === value}
                data-cursor={i === cursor ? "true" : undefined}
                className="wskill__opt"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(i)}
                onMouseEnter={() => setCursor(i)}
              >
                <code>{skill.id}</code>
                {skill.mine && <span className="wskill__mine">{t("variant.ws.chat.skillMine")}</span>}
                <span className="wskill__desc">{t(skill.descKey)}</span>
              </li>
            ))}
          </ul>
          <p className="wskill__keys">{t("variant.ws.chat.skillKeys")}</p>
        </div>
      )}
    </div>
  );
}

// ── 입력줄 ──

function Composer({ status, onStop }: { status: OrchStatus; onStop: () => void }) {
  const [skill, setSkill] = useState("/desktop-app");
  const [slash, setSlash] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const working = status === "working";

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  const onInputKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 빈 칸에서 "/" — 스킬 고르기
    if (event.key === "/" && event.currentTarget.value === "") {
      event.preventDefault();
      setSlash(true);
    }
    if (event.key === "Enter" && !event.shiftKey) event.preventDefault();
  };

  return (
    <form className="wcomposer" onSubmit={(event) => event.preventDefault()}>
      {confirming && (
        <div
          className="wstop"
          role="alertdialog"
          aria-labelledby="wstop-title"
          aria-describedby="wstop-body"
          onKeyDown={(event) => event.key === "Escape" && (setConfirming(false), stopRef.current?.focus())}
        >
          <p id="wstop-title" className="wstop__title">
            {t("variant.ws.stop.title")}
          </p>
          <p id="wstop-body" className="wstop__body">
            {t("variant.ws.stop.body")}
          </p>
          <div className="wstop__actions">
            <button
              ref={confirmRef}
              type="button"
              className="hbtn hbtn--danger"
              onClick={() => {
                setConfirming(false);
                onStop();
              }}
            >
              <Icon name="stop" size={16} />
              {t("variant.ws.stop.go")}
            </button>
            <button
              type="button"
              className="hbtn"
              onClick={() => {
                setConfirming(false);
                stopRef.current?.focus();
              }}
            >
              {t("variant.ws.stop.keep")}
            </button>
          </div>
        </div>
      )}
      <textarea
        className="wcomposer__input"
        rows={2}
        aria-label={t("variant.ws.chat.input")}
        placeholder={t(
          working
            ? "variant.ws.chat.placeholderWorking"
            : status === "waiting"
              ? "variant.ws.chat.placeholderWaiting"
              : "variant.ws.chat.placeholder",
        )}
        onKeyDown={onInputKey}
      />
      <div className="wcomposer__row">
        <SkillPicker value={skill} onChange={setSkill} forceOpen={slash} onClosed={() => setSlash(false)} />
        <span className="wcomposer__keys" aria-hidden="true">
          {t("variant.ws.chat.keys")}
        </span>
        <span className="wcomposer__spacer" />
        {working && (
          <button
            ref={stopRef}
            type="button"
            className="hbtn wcomposer__stop"
            aria-expanded={confirming}
            onClick={() => setConfirming(true)}
          >
            <Icon name="stop" size={16} />
            {t("variant.ws.chat.stop")}
          </button>
        )}
        <button type="submit" className="hbtn hbtn--primary">
          <Icon name="send" size={16} />
          {t("variant.ws.chat.send")}
        </button>
      </div>
    </form>
  );
}

/** 입력줄 자리를 대신하는 띠 — 오류 · 한도 · 연결 끊김 */
function RunBar({ kind, onRetry, onRaw }: { kind: RunBarKind; onRetry: () => void; onRaw: () => void }) {
  const [resume, setResume] = useState(true);
  const resumeId = useId();
  if (kind === "limit")
    return (
      <div className="wrunbar" data-kind="limit">
        <div className="wrunbar__main">
          <Icon name="clock" size={18} />
          <div className="wrunbar__text">
            <p className="wrunbar__title">{t("variant.ws.runbar.limit")}</p>
            <div
              className="wrunbar__meter"
              role="meter"
              aria-label={t("variant.ws.runbar.limitMeter")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={100}
            >
              <span style={{ width: "100%" }} />
            </div>
            <p className="wrunbar__sub">{t("variant.ws.runbar.limitSub")}</p>
          </div>
        </div>
        <div className="wrunbar__actions">
          <span className="wrunbar__toggle">
            <span id={resumeId}>{t("variant.ws.runbar.limitResume")}</span>
            <button
              type="button"
              role="switch"
              className="tgl"
              aria-checked={resume}
              aria-labelledby={resumeId}
              onClick={() => setResume(!resume)}
            >
              <span className="tgl__track" aria-hidden="true">
                <span className="tgl__knob" />
              </span>
              <span className="tgl__text" aria-hidden="true">
                {t(resume ? "variant.ui.on" : "variant.ui.off")}
              </span>
            </button>
          </span>
        </div>
      </div>
    );
  if (kind === "offline")
    return (
      <div className="wrunbar" data-kind="offline">
        <div className="wrunbar__main">
          <Icon name="unplug" size={18} />
          <div className="wrunbar__text">
            <p className="wrunbar__title">{t("variant.ws.runbar.offline")}</p>
            <div className="prg" role="progressbar" aria-label={t("variant.ws.runbar.offline")} data-indeterminate="true">
              <span />
            </div>
            <p className="wrunbar__sub">{t("variant.ws.runbar.offlineSub")}</p>
          </div>
        </div>
        <div className="wrunbar__actions">
          <button type="button" className="hbtn" onClick={onRaw}>
            {t("variant.ws.runbar.raw")}
          </button>
          <button type="button" className="hbtn hbtn--primary" onClick={onRetry}>
            <Icon name="refresh" size={16} />
            {t("variant.ws.runbar.retryNow")}
          </button>
        </div>
      </div>
    );
  return (
    <div className="wrunbar" data-kind="error" role="alert">
      <div className="wrunbar__main">
        <Icon name="alert" size={18} />
        <div className="wrunbar__text">
          <p className="wrunbar__title">{t("variant.ws.runbar.error")}</p>
          <p className="wrunbar__sub">{t("variant.ws.runbar.errorSub")}</p>
        </div>
      </div>
      <div className="wrunbar__actions">
        <button type="button" className="hbtn" onClick={onRaw}>
          <Icon name="terminal" size={16} />
          {t("variant.ws.runbar.raw")}
        </button>
        <button type="button" className="hbtn hbtn--primary" onClick={onRetry}>
          <Icon name="refresh" size={16} />
          {t("variant.ws.runbar.retry")}
        </button>
      </div>
    </div>
  );
}

function now(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 채팅 칸: 머리(상태 · 기다리는 카드로) · 대화 · 입력줄 또는 오류 띠. 카드에 답하면 상태가 바뀐다 (시제품 안에서만) */
export function ChatPane({ fx, onRaw }: { fx: WorkspaceFixture; onRaw: () => void }) {
  const [answered, setAnswered] = useState<string[]>([]);
  const [extra, setExtra] = useState<ChatItem[]>([]);
  const [status, setStatus] = useState<OrchStatus>(fx.status);
  const [runBar, setRunBar] = useState(fx.runBar);
  const log = useRef<HTMLDivElement>(null);
  const items = [...fx.chat, ...extra];
  const pendingItems = items.filter((item) => isPending(item) && !answered.includes(item.id));
  const pendingIndex = items.findIndex((item) => isPending(item) && !answered.includes(item.id));

  // 채팅은 맨 아래(가장 최근)부터 — 기다리는 카드가 있으면 그 카드 머리가 보이게
  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    const card = document.getElementById(PENDING_CARD_ID);
    if (card && el.contains(card)) {
      const top = card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
      if (top < el.scrollTop) el.scrollTop = top;
    }
  }, [items.length]);

  const jump = () => {
    const card = document.getElementById(PENDING_CARD_ID);
    card?.scrollIntoView?.({ block: "start" });
    card?.focus();
  };
  const onAnswered = (id: string) => {
    setAnswered((prev) => [...prev, id]);
    if (pendingItems.length <= 1) setStatus("working");
  };
  const onStop = () => {
    setStatus("idle");
    setExtra((prev) => [
      ...prev,
      {
        kind: "notice",
        id: `stop-${prev.length}`,
        tone: "stopped",
        titleKey: "variant.ws.notice.stopped",
        bodyKey: "variant.ws.notice.stoppedBody",
        time: now(),
      },
    ]);
  };
  const onRetry = () => {
    setRunBar(undefined);
    setStatus("working");
    setExtra((prev) => [
      ...prev,
      { kind: "notice", id: `retry-${prev.length}`, tone: "phase", titleKey: "variant.ws.notice.resumed", time: now() },
    ]);
  };

  return (
    <div className="wchat">
      <OrchestratorStatus status={status} noteKey={runBar ? fx.statusNoteKey : undefined} pending={pendingItems.length} onJump={jump} />
      <div className="wchat__log" ref={log}>
        {items.length === 0 ? (
          <div className="wempty">
            <p className="wempty__title">{t("variant.ws.chat.emptyTitle")}</p>
            <p className="wempty__body">{t("variant.ws.chat.emptyBody")}</p>
          </div>
        ) : (
          <div className="wchat__items">
            {items.map((item, i) => (
              <ChatItemView
                key={item.id}
                item={item}
                pendingId={i === pendingIndex ? PENDING_CARD_ID : undefined}
                onAnswered={onAnswered}
              />
            ))}
          </div>
        )}
      </div>
      {runBar ? <RunBar kind={runBar} onRetry={onRetry} onRaw={onRaw} /> : <Composer status={status} onStop={onStop} />}
    </div>
  );
}
