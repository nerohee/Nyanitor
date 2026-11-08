// 일하는 고양이 목록 — 고양이 얼굴 · 이름 · 무엇을(`description`) · 지금 하는 일(`activity`) · 몇 분째 · 백그라운드 표시. 최근 끝난 작업자는 흐리게.
// 시제품 `variants/shared/progress.tsx` 의 `WorkingCats`.
import { CatFigure } from "../../components/cat/CatFigure";
import type { CatId } from "../../components/cat/catalog";
import { t, tf } from "../../i18n/ko";
import { agoText, workedText } from "./elapsed";
import { catForWorker, catName, type WorkerRoles } from "./workerCat";
import type { WorkerEntry } from "./workers";

const TEXT_MAX = 80;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

function Face({ cat }: { cat: CatId }) {
  return (
    <span className="ws-wk__face" aria-hidden="true">
      <CatFigure cat={cat} crop="face" />
    </span>
  );
}

/** 지금 하는 일 한 줄 — 하는 일 글이 없으면 "일하는 중" */
function activityText(worker: WorkerEntry): string {
  const activity = worker.activity;
  const what = activity?.summary?.trim() || activity?.tool?.trim() || "";
  const uses = activity?.toolUses ? tf("ws.progress.toolUses", { n: activity.toolUses }) : "";
  return [what ? clip(what, TEXT_MAX) : t("ws.progress.working"), uses].filter(Boolean).join(" · ");
}

const minutesText = (worker: WorkerEntry, nowMs: number): string => workedText(worker.startedAtMs, nowMs);

const endedText = (worker: WorkerEntry, nowMs: number): string => agoText(worker.endedAtMs ?? worker.startedAtMs, nowMs);

interface Props {
  working: readonly WorkerEntry[];
  recent: readonly WorkerEntry[];
  roles?: WorkerRoles;
  nowMs: number;
}

export function WorkingCats({ working, recent, roles, nowMs }: Props) {
  return (
    <>
      {working.length === 0 ? (
        <p className="ws-wk__none">{t("ws.progress.none")}</p>
      ) : (
        <ul className="ws-wk" aria-label={t("ws.progress.workingTitle")}>
          {working.map((worker) => {
            const cat = catForWorker(worker.name, { roles });
            return (
              <li key={worker.toolUseId} className="ws-wk__item" data-background={worker.background ? "true" : undefined}>
                <Face cat={cat} />
                <span className="ws-wk__text">
                  <span className="ws-wk__who">
                    <b>{catName(cat)}</b>
                    {worker.background ? (
                      <span className="ws-wk__bg" title={t("ws.progress.backgroundHint")}>
                        {t("ws.progress.background")}
                      </span>
                    ) : null}
                  </span>
                  <span className="ws-wk__task">{worker.description?.trim() ? clip(worker.description, TEXT_MAX) : t("ws.progress.untitled")}</span>
                  <span className="ws-wk__where">
                    {activityText(worker)} · {minutesText(worker, nowMs)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {recent.length > 0 && (
        <>
          <h4 className="ws-pg__sub">{t("ws.progress.recentTitle")}</h4>
          <ul className="ws-wk ws-wk--recent" aria-label={t("ws.progress.recentTitle")}>
            {recent.map((worker) => {
              const cat = catForWorker(worker.name, { roles });
              const outcome = worker.status === "running" ? "stopped" : worker.status;
              return (
                <li key={worker.toolUseId} className="ws-wk__item" data-outcome={outcome}>
                  <Face cat={cat} />
                  <span className="ws-wk__text">
                    <span className="ws-wk__who">
                      <b>{catName(cat)}</b>
                      <span className="ws-wk__outcome">{t(`ws.progress.outcome.${outcome}`)}</span>
                    </span>
                    <span className="ws-wk__task">{worker.description?.trim() ? clip(worker.description, TEXT_MAX) : t("ws.progress.untitled")}</span>
                    <span className="ws-wk__where">{endedText(worker, nowMs)}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
