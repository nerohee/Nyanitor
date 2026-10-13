// 집 화면의 도구 쪽 조각 — 사용량 · 최근 프로젝트 · 준비 상태. 모양(배치 · 크기)은 시안 CSS 가 정한다.
import { t, tf } from "../../i18n/ko";
import { formatTokens, PROJECTS, READINESS, type UsageFixture, type UsageWindow } from "../fixtures";
import { Icon } from "./icons";

function Meter({ label, window: w }: { label: string; window: UsageWindow }) {
  return (
    <div className="usage__row">
      <div className="usage__line">
        <span>{label}</span>
        <strong>{tf("variant.home.used", { n: w.percent })}</strong>
      </div>
      <div
        className="usage__bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={w.percent}
      >
        <span style={{ width: `${w.percent}%` }} />
      </div>
      <p className="usage__reset">{tf("variant.home.resets", { when: t(w.resetKey) })}</p>
    </div>
  );
}

export function TokenEstimate({ usage }: { usage: UsageFixture }) {
  return (
    <p className="usage__tokens">
      {tf("variant.home.sessionTokens", { n: formatTokens(usage.sessionTokens) })}
      <span className="usage__badge">{t("variant.home.estimate")}</span>
    </p>
  );
}

export function UsageUnavailable() {
  return (
    <div className="usage__none" role="status">
      <Icon name="alert" size={18} />
      <div>
        <strong>{t("variant.home.unavailable")}</strong>
        <p>{t("variant.home.unavailableHint")}</p>
      </div>
    </div>
  );
}

/** 5시간 · 주간 한도 막대 + 앱 세션 토큰 추정. 못 받으면 "확인할 수 없음" (D-24) */
export function UsageBars({ usage, showTokens = true }: { usage: UsageFixture; showTokens?: boolean }) {
  return (
    <div className="usage">
      {usage.status === "ok" ? (
        <>
          <Meter label={t("variant.home.fiveHour")} window={usage.fiveHour} />
          <Meter label={t("variant.home.weekly")} window={usage.weekly} />
        </>
      ) : (
        <UsageUnavailable />
      )}
      {showTokens && <TokenEstimate usage={usage} />}
    </div>
  );
}

/** 최근 프로젝트 — 줄을 누르면 작업 공간으로 (시안에서는 모양만) */
export function ProjectList({ showPath = true, className }: { showPath?: boolean; className?: string }) {
  return (
    <ul className={`projects${className ? ` ${className}` : ""}`}>
      {PROJECTS.map((project) => (
        <li key={project.id}>
          <button type="button" className="projects__item" data-running={project.running ? "true" : undefined}>
            <span className="projects__name">{t(project.nameKey)}</span>
            <span className="projects__phase">
              {project.running && <span className="status-dot" aria-hidden="true" />}
              {t(project.phaseKey)}
            </span>
            {showPath && <code className="projects__path">{project.path}</code>}
            <span className="projects__when">{t(project.openedKey)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ReadyLine() {
  return (
    <p className="ready">
      <Icon name="check" size={18} />
      <span>
        <strong>
          {t("variant.home.ready")} {READINESS.ready}/{READINESS.total}
        </strong>
        <span className="ready__detail">{t("variant.home.readyDetail")}</span>
      </span>
    </p>
  );
}

export function NewProjectButton({ className }: { className?: string }) {
  return (
    <button type="button" className={`hbtn hbtn--primary${className ? ` ${className}` : ""}`}>
      <Icon name="plus" size={18} />
      {t("variant.home.newProject")}
    </button>
  );
}
