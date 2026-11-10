// 단계 보드 (D-13 · D-22) — 단계 표(`dev-plan.md`)와 이어 하기 메모(`handoff.md`)를 읽은 것. 끝남 · 지금 · 나를 기다림 · 아직 · 알 수 없음.
// 지금 · 기다림 단계는 그 단계의 작업(지시서)까지 펼친다. 단계 표만 읽을 수 없으면 보드만 "읽을 수 없음", 메모만 읽을 수 없으면 한 줄 알림 (나머지는 그대로).
// 시제품 `variants/shared/progress.tsx` 의 `PhaseBoard`.
import { CatFigure } from "../../components/cat/CatFigure";
import type { CatId } from "../../components/cat/catalog";
import { t, tf, type TextKey } from "../../i18n/ko";
import type { AppErrorKind, HandoffRead, HandoffTask, PlanPhase, ProgressReason, ProgressRead } from "../../lib/ipc-types";
import { useMine } from "../../lib/mine";
import { Icon, type IconName } from "../../variants/shared/icons";
import { errorText } from "../errors";
import { boardCounts, ownerCat, phaseView, taskName, tasksOfPhase, waitingItems, type PhaseView } from "./board";
import { catName } from "./workerCat";
import type { ProgressState } from "./useProgress";

const PHASE_ICON: Record<PhaseView, IconName | null> = { done: "check", now: null, waiting: "dot", todo: null, unknown: "info" };
const WAITING_SHOWN = 3;

function reasonText(reason: ProgressReason): string {
  return t(`ws.progress.reason.${reason}` as TextKey);
}

function CatFace({ cat, className }: { cat: CatId; className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <CatFigure cat={cat} crop="face" />
    </span>
  );
}

/** 담당 칸 — `→` 차례 · `·` 함께. 고양이는 얼굴, 모르는 말은 글 */
function Owners({ groups }: { groups: string[][] }) {
  const mine = useMine();
  const label = groups.map((group) => group.map((word) => { const cat = ownerCat(word, mine); return cat ? catName(cat) : word; }).join(" · ")).join(" → ");
  if (groups.length === 0) return null;
  return (
    <span className="ws-pb__owners" role="img" aria-label={`${t("ws.progress.board.owners")}: ${label}`} title={label}>
      {groups.map((group, index) => (
        <span key={index} className="ws-pb__group" aria-hidden="true">
          {index > 0 && <Icon name="arrow" size={12} />}
          {group.map((word, i) => {
            const cat = ownerCat(word, mine);
            return cat ? <CatFace key={`${word}-${i}`} cat={cat} className="ws-pb__face" /> : <span key={`${word}-${i}`} className="ws-pb__word">{word}</span>;
          })}
        </span>
      ))}
    </span>
  );
}

function statusLabel(view: PhaseView, phase: PlanPhase): string {
  if (view === "unknown") return phase.statusText.trim() || t("ws.progress.phase.unknown");
  return t(`ws.progress.phase.${view}` as TextKey);
}

function PhaseRow({ phase, handoff }: { phase: PlanPhase; handoff: HandoffRead }) {
  const view = phaseView(phase, handoff);
  const icon = PHASE_ICON[view];
  const current = view === "now" || view === "waiting";
  const tasks = current ? tasksOfPhase(phase, handoff) : [];
  const status = statusLabel(view, phase);
  return (
    <li className="ws-pb__item" data-status={view} aria-current={current ? "step" : undefined}>
      <div className="ws-pb__row">
        <span className="ws-pb__coin" aria-hidden="true">
          {icon ? <Icon name={icon} size={14} /> : view === "now" ? <span className="ws-pb__spin" /> : null}
        </span>
        <span className="ws-pb__id">{phase.id}</span>
        <span className="ws-pb__name" title={phase.goal ?? undefined}>
          {phase.name ?? phase.summary}
        </span>
        <Owners groups={phase.owners} />
        <span className="ws-pb__status" title={view === "unknown" ? undefined : phase.statusText || undefined}>
          {status}
        </span>
      </div>
      {tasks.length > 0 && (
        <ul className="ws-pt" aria-label={tf("ws.progress.board.tasks", { id: phase.id })}>
          {tasks.map((task) => (
            <TaskRow key={task.id ?? task.label} task={task} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskRow({ task }: { task: HandoffTask }) {
  const mine = useMine();
  const cat = ownerCat(task.owner, mine);
  const name = taskName(task);
  const progress = task.progress && task.progress.total > 0 ? task.progress : null;
  const status = task.status === "unknown" ? task.statusText.trim() || t("ws.progress.task.unknown") : t(`ws.progress.task.${task.status}` as TextKey);
  return (
    <li className="ws-pt__item" data-status={task.status}>
      {task.id ? <code className="ws-pt__id">{task.id}</code> : <span className="ws-pt__id" />}
      <span className="ws-pt__label" title={task.label}>
        {name}
      </span>
      <span className="ws-pt__who">
        {cat ? <CatFace cat={cat} className="ws-pt__face" /> : null}
        {cat ? catName(cat) : task.owner}
      </span>
      <span className="ws-pt__status">{status}</span>
      {progress && (
        <span className="ws-pt__progress">
          <span
            className="ws-pt__bar"
            role="progressbar"
            aria-label={tf("ws.progress.board.progressLabel", { name })}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={Math.min(progress.done, progress.total)}
          >
            <span style={{ width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }} />
          </span>
          <span className="ws-pt__num">{tf("ws.progress.board.progress", { done: progress.done, total: progress.total })}</span>
        </span>
      )}
    </li>
  );
}

/** 보드 위의 "나를 기다리는 것" 짧은 목록 (메모의 `## 사용자에게 기다리는 것`) */
function WaitingList({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, WAITING_SHOWN);
  return (
    <div className="ws-pb__waiting" role="status">
      <p className="ws-pb__waiting-title">
        <Icon name="bell" size={14} />
        {t("ws.progress.board.waitingTitle")}
      </p>
      <ul>
        {shown.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
        {items.length > shown.length && <li className="ws-pb__waiting-more">{tf("ws.progress.board.waitingMore", { n: items.length - shown.length })}</li>}
      </ul>
    </div>
  );
}

function Bad({ title, body, reason, file, onReload }: { title: string; body: string; reason: ProgressReason; file: string; onReload: () => void }) {
  return (
    <div className="ws-pb__bad" role="status">
      <p className="ws-pb__bad-title">
        <Icon name="alert" size={16} />
        {title}
      </p>
      <p className="ws-pb__bad-body">{body}</p>
      <p className="ws-pb__bad-body">
        <code>{file}</code> — {reasonText(reason)}
      </p>
      <div className="ws-pb__bad-actions">
        <button type="button" className="ws-btn ws-btn--small" onClick={onReload}>
          <Icon name="refresh" size={16} />
          {t("ws.progress.board.retry")}
        </button>
      </div>
    </div>
  );
}

interface Props {
  state: ProgressState;
  onReload: () => void;
}

export function PhaseBoard({ state, onReload }: Props) {
  if (state.kind === "loading") {
    return (
      <p className="ws-pg__empty" role="status">
        {t("ws.progress.board.loading")}
      </p>
    );
  }
  if (state.kind === "error") return <BoardError error={state.error} onReload={onReload} />;
  const read: ProgressRead = state.read;
  const { plan, handoff } = read;
  if (plan.state === "absent" && handoff.state === "absent") return <p className="ws-pg__empty">{t("ws.progress.board.empty")}</p>;
  if (plan.state === "unreadable") {
    return (
      <>
        <Bad title={t("ws.progress.board.unreadable")} body={t("ws.progress.board.unreadableBody")} reason={plan.reason} file="docs/02-development/dev-plan.md" onReload={onReload} />
        <WaitingList items={waitingItems(handoff)} />
      </>
    );
  }
  if (plan.state === "absent") {
    return (
      <>
        <p className="ws-pg__empty">{t("ws.progress.board.noPlan")}</p>
        <WaitingList items={waitingItems(handoff)} />
      </>
    );
  }
  const counts = boardCounts(read);
  return (
    <>
      <WaitingList items={waitingItems(handoff)} />
      {handoff.state === "unreadable" && (
        <p className="ws-pb__note" role="status">
          <Icon name="alert" size={14} />
          {t("ws.progress.board.memoUnreadable")} {reasonText(handoff.reason)}
        </p>
      )}
      {counts && <p className="ws-pb__sum">{tf("ws.progress.board.sum", counts)}</p>}
      <ol className="ws-pb" aria-label={t("ws.progress.boardTitle")}>
        {plan.phases.map((phase) => (
          <PhaseRow key={phase.id} phase={phase} handoff={handoff} />
        ))}
      </ol>
    </>
  );
}

function BoardError({ error, onReload }: { error: AppErrorKind; onReload: () => void }) {
  return (
    <div className="ws-pb__bad" role="alert">
      <p className="ws-pb__bad-title">
        <Icon name="alert" size={16} />
        {tf("ws.progress.board.failed", { reason: errorText(error) })}
      </p>
      <div className="ws-pb__bad-actions">
        <button type="button" className="ws-btn ws-btn--small" onClick={onReload}>
          <Icon name="refresh" size={16} />
          {t("ws.progress.board.retry")}
        </button>
      </div>
    </div>
  );
}
