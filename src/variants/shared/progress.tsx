// 진행 보기 (D-13 · P7) — 일하는 고양이 · 단계 보드 · 요약 기록 · 원본 출력(접기).
// 단계 보드는 프로젝트의 dev-plan.md 단계 표 + handoff.md "진행 중인 작업" 을 읽은 것 (D-22 약속). 읽을 수 없으면 보드만 "읽을 수 없음".
import { useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { activityTextKey } from "../../components/house/spots";
import { t, tf, type TextKey } from "../../i18n/ko";
import type { LogItem, LogKind, Phase, PhaseStatus, PhaseTask, WorkingCat, WorkspaceFixture } from "../fixtures-workspace";
import { Icon, type IconName } from "./icons";

const PHASE_ICON: Record<PhaseStatus, IconName | null> = { done: "check", now: null, waiting: "dot", todo: null };

/** 단계 보드 — 끝남 · 지금 · 나를 기다림 · 아직. 지금 · 기다림 단계는 지시서(작업)까지 펼친다 */
export function PhaseBoard({ phases, paused = false }: { phases: WorkspaceFixture["phases"]; paused?: boolean }) {
  if (phases === "unreadable")
    return (
      <div className="wboard-bad" role="status">
        <p className="wboard-bad__title">
          <Icon name="alert" size={16} />
          {t("variant.ws.board.unreadable")}
        </p>
        <p className="wboard-bad__body">{t("variant.ws.board.unreadableBody")}</p>
        <p className="wboard-bad__file">
          <code>docs/02-development/dev-plan.md</code>
        </p>
        <div className="wboard-bad__actions">
          <button type="button" className="hbtn">
            <Icon name="refresh" size={16} />
            {t("variant.ws.board.reread")}
          </button>
          <button type="button" className="hbtn hbtn--ghost">
            <Icon name="external" size={16} />
            {t("variant.ws.board.openFile")}
          </button>
        </div>
      </div>
    );
  if (phases === null) return <p className="wlog__empty">{t("variant.ws.board.empty")}</p>;
  const done = phases.filter((p) => p.status === "done").length;
  return (
    <>
      <p className="wboard__sum">{tf("variant.ws.board.sum", { done, total: phases.length })}</p>
      <ol className="wboard" aria-label={t("variant.ws.board")} data-paused={paused ? "true" : undefined}>
        {phases.map((phase) => (
          <PhaseRow key={phase.id} phase={phase} paused={paused} />
        ))}
      </ol>
    </>
  );
}

function PhaseRow({ phase, paused }: { phase: Phase; paused: boolean }) {
  const icon = PHASE_ICON[phase.status];
  const current = phase.status === "now" || phase.status === "waiting";
  return (
    <li className="wboard__item" data-status={phase.status} aria-current={current ? "step" : undefined}>
      <div className="wboard__row">
        <span className="wboard__coin" aria-hidden="true">
          {icon ? (
            <Icon name={icon} size={14} />
          ) : phase.status === "now" && paused ? (
            <Icon name="stop" size={12} />
          ) : phase.status === "now" ? (
            <span className="wboard__spin" />
          ) : null}
        </span>
        <span className="wboard__id">{phase.id}</span>
        <span className="wboard__name">{t(phase.labelKey)}</span>
        <span className="wboard__owners" aria-label={phase.owners.map((cat) => t(`cat.${cat}.name`)).join(", ")}>
          {phase.owners.map((cat) => (
            <span key={cat} className="wboard__face" aria-hidden="true">
              <CatFigure cat={cat} crop="face" />
            </span>
          ))}
        </span>
        <span className="wboard__status">
          {t(phase.status === "now" && paused ? "variant.ws.phase.paused" : `variant.ws.phase.${phase.status}`)}
        </span>
      </div>
      {current && phase.tasks && (
        <ul className="wtasks" aria-label={tf("variant.ws.board.tasks", { id: phase.id })}>
          {phase.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskRow({ task }: { task: PhaseTask }) {
  return (
    <li className="wtask" data-status={task.status}>
      <code className="wtask__id">{task.id}</code>
      <span className="wtask__label">{t(task.labelKey)}</span>
      <span className="wtask__who">
        <span className="wtask__face" aria-hidden="true">
          <CatFigure cat={task.cat} crop="face" />
        </span>
        {t(`cat.${task.cat}.name`)}
      </span>
      <span className="wtask__status">{t(`variant.ws.task.${task.status}`)}</span>
    </li>
  );
}

/** 일하는 고양이 — 누가(고양이 · 에이전트) · 무엇을(지시서) · 어디서(자리) · 얼마나 */
export function WorkingCats({ working }: { working: WorkingCat[] }) {
  if (working.length === 0) return <p className="wworking__none">{t("variant.ws.noWorking")}</p>;
  return (
    <ul className="wcats">
      {working.map((w) => (
        <li key={w.cat} className="wcats__item" data-activity={w.activity}>
          <span className="wcats__face" aria-hidden="true">
            <CatFigure cat={w.cat} crop="face" />
          </span>
          <span className="wcats__text">
            <span className="wcats__who">
              <b>{t(`cat.${w.cat}.name`)}</b>
              <span className="wcats__role">{t(`cat.${w.cat}.role`)}</span>
            </span>
            <span className="wcats__task">{t(w.taskKey)}</span>
            <span className="wcats__where">
              {t(`cat.activity.${activityTextKey(w.activity)}`)} · {tf("variant.ws.minutes", { n: w.minutes })}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const LOG_ICON: Record<LogKind, IconName> = {
  start: "flag",
  assign: "arrow",
  back: "undo",
  pass: "check",
  ask: "info",
  error: "alert",
  stop: "stop",
  phase: "flag",
};

const LOG_KIND: Record<LogKind, TextKey> = {
  start: "variant.ws.log.start",
  assign: "variant.ws.log.assign",
  back: "variant.ws.log.back",
  pass: "variant.ws.log.pass",
  ask: "variant.ws.log.ask",
  error: "variant.ws.log.error",
  stop: "variant.ws.log.stop",
  phase: "variant.ws.log.phase",
};

/** 쉬운 말 요약 기록 — 최근이 위 */
export function ProgressLog({ log }: { log: LogItem[] }) {
  if (log.length === 0) return <p className="wlog__empty">{t("variant.ws.logEmpty")}</p>;
  return (
    <ol className="wlog">
      {[...log].reverse().map((item) => (
        <li key={`${item.time}-${item.textKey}`} data-kind={item.kind}>
          <time>{item.time}</time>
          <span className="wlog__kind" title={t(LOG_KIND[item.kind])}>
            <Icon name={LOG_ICON[item.kind]} size={12} />
            <span className="sr">{t(LOG_KIND[item.kind])}</span>
          </span>
          <span className="wlog__face" aria-hidden="true">
            <CatFigure cat={item.cat} crop="face" />
          </span>
          <span className="wlog__text">{t(item.textKey)}</span>
        </li>
      ))}
    </ol>
  );
}

export const RAW_ID = "ws-raw";

/** CLI 원본 출력 — 접어 두고 펼치기 (D-13). <details> 라 Enter · Space 로 열린다 */
export function RawOutput({ raw, open: initialOpen = false }: { raw: string[]; open?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  if (raw.length === 0) return null;
  return (
    <details className="wraw" id={RAW_ID} open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="terminal" size={16} />
        {t("variant.ws.raw")}
        <span>{tf("variant.ws.rawHint", { n: raw.length })}</span>
      </summary>
      <pre className="selectable">{raw.join("\n")}</pre>
    </details>
  );
}
