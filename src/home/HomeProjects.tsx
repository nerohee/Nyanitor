// 고양이 집의 아래 판 — 새 프로젝트 단추 + 최근 프로젝트 몇 개 (시제품 `variants/shared/HomeBlocks.tsx` 의 `NewProjectButton` · `ProjectList`).
// 프로젝트를 누르면 작업 공간에서 열린다. 읽는 중 · 못 읽음 · 읽기 전용 · 프로젝트 없음도 이 판 안에서 한 줄로 알린다.
import { t, tf } from "../i18n/ko";
import { Icon } from "../variants/shared/icons";
import { errorText } from "../workspace/errors";
import type { ProjectsState } from "../workspace/useProjects";
import { formatAgo } from "./format";

/** 판에 보이는 최근 프로젝트 수 (시제품과 같다) */
const RECENT_COUNT = 3;

interface Props {
  state: ProjectsState;
  now: Date;
  onOpen: (id: number) => void;
  onNew: () => void;
  onRetry: () => void;
}

export function HomeProjects({ state, now, onOpen, onNew, onRetry }: Props) {
  const writable = state.status === "ready" && state.db === "ok";
  const projects = state.status === "ready" ? state.projects.slice(0, RECENT_COUNT) : [];
  const empty = state.status === "ready" && state.projects.length === 0;

  return (
    <div className="hm-slab">
      <button type="button" className="hm-btn hm-new" disabled={!writable} onClick={onNew}>
        <Icon name="plus" size={18} />
        {t("variant.home.newProject")}
      </button>
      <section className="hm-card hm-slab__card" aria-labelledby="hm-projects-title" data-wide={projects.length > 0 ? "true" : undefined}>
        <h2 id="hm-projects-title" className="hm-slab__title">
          {empty ? t("home.projects.empty") : t("variant.home.recent")}
        </h2>
        {state.status === "loading" && (
          <p className="hm-slab__hint" role="status">
            {t("home.projects.loading")}
          </p>
        )}
        {state.status === "failed" && (
          <p className="hm-slab__hint" role="alert">
            {tf("home.projects.failed", { reason: errorText(state.kind) })}{" "}
            <button type="button" className="hm-link" onClick={onRetry}>
              {t("home.projects.retry")}
            </button>
          </p>
        )}
        {empty && <p className="hm-slab__hint">{t("home.projects.hint")}</p>}
        {state.status === "ready" && state.db === "read_only" && (
          <p className="hm-slab__hint" role="status">
            {t("home.projects.readOnly")}
          </p>
        )}
        {projects.length > 0 && (
          <ul className="hm-recent">
            {projects.map((project) => (
              <li key={project.id}>
                <button type="button" className="hm-recent__item" onClick={() => onOpen(project.id)}>
                  <span className="hm-recent__name">{project.name}</span>
                  <span className="hm-recent__when" data-missing={project.folder === "missing" ? "true" : undefined}>
                    {project.folder === "missing" ? t("ws.proj.missing") : formatAgo(project.lastOpenedAt, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
