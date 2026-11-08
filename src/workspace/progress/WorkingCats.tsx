// 일하는 고양이 목록 — 고양이 얼굴 · 이름 · 무엇을(`description`) · 지금 하는 일(`activity`) · 몇 분째 · 백그라운드 표시. 최근 끝난 작업자는 흐리게.
// 시제품 `variants/shared/progress.tsx` 의 `WorkingCats`.
// 답을 기다리는 카드가 있으면 그 카드를 보낸 고양이의 줄이 맨 위에 "답을 기다려요" 로 (버터 색, 글로도 알린다) — 그 작업자는 일하는 줄에서 이 줄로 바뀐다 (같은 고양이 두 줄 아님).
import { CatFigure } from "../../components/cat/CatFigure";
import type { CatId } from "../../components/cat/catalog";
import { t, tf } from "../../i18n/ko";
import { agoText, workedText } from "./elapsed";
import type { WaitingCard } from "../chat/sessionStore";
import { askerCat } from "./placement";
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

/** 기다린 지 — 카드가 생긴 때를 모르면 시간 없이 */
function waitedText(sinceMs: number | null, nowMs: number): string | null {
  if (sinceMs === null) return null;
  const minutes = Math.floor((nowMs - sinceMs) / 60_000);
  if (minutes < 1) return t("ws.progress.waitedNow");
  return tf(minutes < 60 ? "ws.progress.waitedMinutes" : "ws.progress.waitedHours", { n: minutes < 60 ? minutes : Math.floor(minutes / 60) });
}

interface Props {
  working: readonly WorkerEntry[];
  /** 맨 앞 기다리는 카드를 보낸 이 — 없으면 `null` */
  waiting?: WaitingCard | null;
  recent: readonly WorkerEntry[];
  roles?: WorkerRoles;
  nowMs: number;
}

export function WorkingCats({ working, waiting = null, recent, roles, nowMs }: Props) {
  const waitCat = waiting ? askerCat(waiting, roles) : null;
  // 기다리는 고양이를 가리키는 일하는 작업자(먼저 시작한 하나)는 기다리는 줄로 바뀐다
  const waitWorker = waitCat === null ? undefined : working.find((worker) => catForWorker(worker.name, { roles }) === waitCat);
  const rest = working.filter((worker) => worker !== waitWorker);
  const waited = waiting ? waitedText(waiting.sinceMs, nowMs) : null;
  return (
    <>
      {working.length === 0 && waitCat === null ? (
        <p className="ws-wk__none">{t("ws.progress.none")}</p>
      ) : (
        <ul className="ws-wk" aria-label={t("ws.progress.workingTitle")}>
          {waitCat !== null && (
            <li className="ws-wk__item" data-waiting="true">
              <Face cat={waitCat} />
              <span className="ws-wk__text">
                <span className="ws-wk__who">
                  <b>{catName(waitCat)}</b>
                  <span className="ws-wk__wait">{t("ws.progress.waiting")}</span>
                </span>
                {waitWorker && <span className="ws-wk__task">{waitWorker.description?.trim() ? clip(waitWorker.description, TEXT_MAX) : t("ws.progress.untitled")}</span>}
                {waited && <span className="ws-wk__where">{tf("ws.progress.waitedFor", { time: waited })}</span>}
              </span>
            </li>
          )}
          {rest.map((worker) => {
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
