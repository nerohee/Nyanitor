// 프로젝트 목록 (넓은 창 왼쪽 칸), 좁은 창의 프로젝트 바꾸기, 프로젝트 없음. 시제품 `variants/shared/projects.tsx` 를 바탕으로 실제 데이터에 맞춘 것.
// 목록은 "최근에 연 순서" 그대로 (한 번에 하나만 돌아가는 오케스트레이터 · 상태 점은 P7).
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { CatFigure } from "../components/cat/CatFigure";
import { FALLBACK_CAT } from "../components/cat/catalog";
import { t, tf } from "../i18n/ko";
import type { ProjectDbMode, ProjectEntry } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { errorText } from "./errors";
import type { ProjectsState } from "./useProjects";

const SEARCH_FROM = 6;

function matches(project: ProjectEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q);
}

function ProjectStatus({ project }: { project: ProjectEntry }) {
  if (project.folder === "ok") return null;
  const key = project.folder === "missing" ? "ws.proj.missing" : "ws.proj.unknown";
  return (
    <span className="ws-proj__status" data-status={project.folder}>
      <Icon name="alert" size={12} />
      {t(key)}
    </span>
  );
}

function ProjectItem({ project, current, onPick }: { project: ProjectEntry; current: boolean; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="ws-proj__item"
        aria-current={current ? "page" : undefined}
        data-missing={project.folder === "missing" ? "true" : undefined}
        onClick={onPick}
      >
        <span className="ws-proj__name">{project.name}</span>
        <ProjectStatus project={project} />
        {project.skill && <code className="ws-proj__skill">{project.skill}</code>}
        <span className="ws-proj__path" title={project.path}>
          {project.path}
        </span>
      </button>
    </li>
  );
}

interface ListProps {
  state: ProjectsState;
  selectedId: number | null;
  onPick: (id: number) => void;
  onNew: () => void;
  onRetry: () => void;
  className?: string;
  /** 좁은 창 팝오버 안 — 제목 없이 */
  compact?: boolean;
}

/** 읽는 중 · 못 읽음 · 읽기 전용 알림 + 목록 + 새 프로젝트 단추 */
export function ProjectNavList({ state, selectedId, onPick, onNew, onRetry, className, compact = false }: ListProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const projects = state.status === "ready" ? state.projects : [];
  const db: ProjectDbMode | null = state.status === "ready" ? state.db : null;
  const shown = projects.filter((project) => matches(project, query));

  return (
    <nav className={`ws-proj${compact ? " ws-proj--compact" : ""}${className ? ` ${className}` : ""}`} aria-label={t("ws.projects")}>
      {!compact && (
        <h2 className="ws-proj__title">
          {t("ws.projects")}
          {state.status === "ready" && <span className="ws-proj__count">{projects.length}</span>}
        </h2>
      )}
      {db === "read_only" && (
        <p className="ws-note" role="status">
          <Icon name="info" size={14} />
          {t("ws.proj.readOnly")}
        </p>
      )}
      {state.status === "loading" && (
        <p className="ws-proj__none" role="status">
          {t("ws.proj.loading")}
        </p>
      )}
      {state.status === "failed" && (
        <div className="ws-note ws-note--warn" role="alert">
          <Icon name="alert" size={14} />
          <span>{tf("ws.proj.failed", { reason: errorText(state.kind) })}</span>
          <button type="button" className="ws-btn ws-btn--small" onClick={onRetry}>
            {t("ws.proj.retry")}
          </button>
        </div>
      )}
      {projects.length >= SEARCH_FROM && (
        <label className="ws-proj__search" htmlFor={searchId}>
          <Icon name="search" size={14} />
          <input
            id={searchId}
            type="search"
            className="ws-proj__search-in"
            placeholder={t("ws.proj.search")}
            aria-label={t("ws.proj.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      {state.status === "ready" && (
        <div className="ws-proj__list">
          {shown.length > 0 ? (
            <ul>
              {shown.map((project) => (
                <ProjectItem key={project.id} project={project} current={project.id === selectedId} onPick={() => onPick(project.id)} />
              ))}
            </ul>
          ) : (
            <p className="ws-proj__none">{t("ws.proj.noMatch")}</p>
          )}
        </div>
      )}
      <button type="button" className="ws-btn ws-btn--ghost ws-proj__new" disabled={db !== "ok"} onClick={onNew}>
        <Icon name="plus" size={16} />
        {t("ws.newProject")}
      </button>
    </nav>
  );
}

/** 좁은 창 — 프로젝트 목록 대신 탭 줄 왼쪽의 "프로젝트 바꾸기" 단추 (누르면 목록이 내려온다. Esc · 고르기 · 바깥으로 포커스가 나가면 닫힌다) */
export function ProjectSwitcher({ state, selectedId, onPick, onNew, onRetry }: Omit<ListProps, "className" | "compact">) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const current = state.status === "ready" ? state.projects.find((project) => project.id === selectedId) : undefined;
  const close = (focusButton = true) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  return (
    <div
      className="ws-switch"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={button}
        type="button"
        className="ws-switch__btn"
        aria-expanded={open}
        aria-controls={popId}
        title={t("ws.switch")}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="folder" size={16} />
        <span className="ws-switch__name">{current ? current.name : t("ws.projects")}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="ws-switch__pop" id={popId}>
          <ProjectNavList
            state={state}
            selectedId={selectedId}
            compact
            onPick={(id) => {
              onPick(id);
              close();
            }}
            onNew={() => {
              setOpen(false);
              onNew();
            }}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  );
}

/** 프로젝트가 하나도 없을 때 — 종이 한가운데 */
export function NoProjects({ onNew, disabled }: { onNew: () => void; disabled: boolean }) {
  return (
    <div className="ws-none">
      <div className="ws-none__cat" aria-hidden="true">
        <CatFigure cat={FALLBACK_CAT} pose="sit" />
      </div>
      <h2 className="ws-none__title">{t("ws.none.title")}</h2>
      <p className="ws-none__body">{t("ws.none.body")}</p>
      <ol className="ws-none__steps">
        <li>{t("ws.none.step1")}</li>
        <li>{t("ws.none.step2")}</li>
        <li>{t("ws.none.step3")}</li>
      </ol>
      {disabled && (
        <p className="ws-note" role="status">
          <Icon name="info" size={14} />
          {t("ws.proj.readOnly")}
        </p>
      )}
      <div className="ws-none__actions">
        <button type="button" className="ws-btn ws-btn--primary" disabled={disabled} onClick={onNew}>
          <Icon name="plus" size={18} />
          {t("ws.newProject")}
        </button>
      </div>
      <p className="ws-none__note">{t("ws.none.note")}</p>
    </div>
  );
}
