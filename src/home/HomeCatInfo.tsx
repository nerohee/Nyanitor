// 고양이 정보 패널 (실제 화면) — 이름 · 에이전트 · 보이는 이름(없으면 역할) · 지금 하는 일 · 모델 · 수준 · 성격 · 맡는 일.
// 고치는 곳은 「내 수정」 — 아래 「고양이 바꾸기」 가 그 에이전트를 고른 채 고양이 고르기를 연다 (P9-05). 시제품 `variants/shared/CatInfo.tsx` 를 바탕으로 새로 썼다.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { PANEL_ID } from "../components/house/useCatPanel";
import { activityTextKey, type Activity } from "../components/house/spots";
import { isTextKey, t, tf, type TextKey } from "../i18n/ko";
import type { AgentInfo, AgentUnreadable } from "../lib/ipc-types";
import { mineLabel, useMine } from "../lib/mine";
import { Icon } from "../variants/shared/icons";
import { agentKeyOf, type HomeCat } from "./useAgents";

/** 이 글자 수를 넘으면 맡는 일을 접어 둔다 (CSS 가 3줄에서 자른다) */
export const DUTIES_FOLD_LENGTH = 90;

/** 일하는 고양이(캣휠 · 캣타워) · 댓돌에서 기다리는 먹물의 일 — 쉬는 고양이는 없다 */
export type HomeCatWork =
  | { kind: "job"; projectName: string | null; description: string | null; worked: string; onOpen: () => void }
  | { kind: "waiting"; projectName: string | null; count: number; description?: string | null; onOpen: () => void };

interface HomeCatInfoProps {
  home: HomeCat;
  /** 지금 있는 자리 = 하는 일 */
  activity: Activity;
  /** 지금 맡은 일 (있으면 "쉬는 중" 대신 일하는 중 · 기다리는 중과 일 줄 · 단추) */
  work?: HomeCatWork;
  /** 「고양이 바꾸기」 — 그 에이전트의 열쇠(`main` / 에이전트 이름). 안 주면 단추가 없다. 읽을 수 없는 에이전트 파일이면 단추도 없다 */
  onChangeCat?: (agent: string) => void;
  onClose: () => void;
  className?: string;
}

const MODEL_NAMES: Readonly<Record<string, string>> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };

function modelText(model: string | null): string {
  if (!model) return t("home.info.unknown");
  return MODEL_NAMES[model.toLowerCase()] ?? model;
}

function effortText(effort: string | null): string {
  if (!effort) return t("home.info.unknown");
  const key = `cat.effort.${effort}`;
  if (isTextKey(key)) return t(key);
  const more = `home.info.effort.${effort}`;
  return isTextKey(more) ? t(more) : effort;
}

function reasonText(reason: AgentUnreadable["reason"]): string {
  const key = `home.info.reason.${reason}`;
  return isTextKey(key) ? t(key) : t("home.info.reason.other");
}

/** 맡는 일 — 에이전트 파일 앞머리의 `description`. 긴 글은 접어 두고 "더 보기" */
function Duties({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = text.length > DUTIES_FOLD_LENGTH;
  return (
    <>
      <p id={id} className="hm-info__duties" data-folded={long && !open ? "true" : undefined}>
        {text}
      </p>
      {long && (
        <button type="button" className="hm-link" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          {t(open ? "home.info.less" : "home.info.more")}
        </button>
      )}
    </>
  );
}

function ReadableBody({ info, cat }: { info: AgentInfo; cat: HomeCat["cat"] }) {
  const duties = info.description?.trim() || t(`cat.${cat}.duties`);
  return (
    <>
      <dl className="hm-info__meta">
        <div>
          <dt>{t("cat.info.model")}</dt>
          <dd>{modelText(info.model)}</dd>
        </div>
        <div>
          <dt>{t("cat.info.effort")}</dt>
          <dd>{effortText(info.effort)}</dd>
        </div>
        {info.readOnly && (
          <div className="hm-info__readonly">
            <dd>{t("home.info.readOnly")}</dd>
          </div>
        )}
      </dl>
      <p className="hm-info__summary">{t(`cat.${cat}.summary`)}</p>
      <h3 className="hm-info__label">{t("cat.info.duties")}</h3>
      <Duties text={duties} />
    </>
  );
}

/** 맡은 일 — 프로젝트 · 맡긴 일 · 일한 시간 (먹물이 기다릴 때는 기다리는 카드 수) + 그 프로젝트의 진행 · 채팅 열기 */
function WorkLines({ work }: { work: HomeCatWork }) {
  return (
    <>
      <dl className="hm-info__meta hm-info__work">
        {work.projectName && (
          <div>
            <dt>{t("home.info.project")}</dt>
            <dd>{work.projectName}</dd>
          </div>
        )}
        {work.kind === "job" ? (
          <>
            {work.description && (
              <div>
                <dt>{t("home.info.task")}</dt>
                <dd>{work.description}</dd>
              </div>
            )}
            <div>
              <dt>{t("home.info.worked")}</dt>
              <dd>{work.worked}</dd>
            </div>
          </>
        ) : (
          <>
            {work.description && (
              <div>
                <dt>{t("home.info.task")}</dt>
                <dd>{work.description}</dd>
              </div>
            )}
            <div>
              <dt>{t("home.info.waitingCards")}</dt>
              <dd>{tf("home.info.cardCount", { n: work.count })}</dd>
            </div>
          </>
        )}
      </dl>
      <button type="button" className="hm-link" onClick={work.onOpen}>
        {t(work.kind === "job" ? "home.info.openProgress" : "home.info.openChat")}
      </button>
    </>
  );
}

/** 상태 칩("쉬는 중 — 상자 안에서 쉬는 중")이 패널 한 줄에 다 들어가는가 — 안 들어가면 뒤 설명을 숨기고 "쉬는 중" 만 (P6-08 고객).
 *  칩 조각(점 · 상태 · 설명)의 제 폭을 더해 패널 안쪽 폭과 견준다. 숨긴 설명도 자리만 빠지고 폭은 잴 수 있게 둔다 (home.css) */
function useStatusFits(activity: Activity, state: string) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [short, setShort] = useState(false);
  useLayoutEffect(() => {
    const pill = ref.current;
    const panel = pill?.parentElement;
    if (!pill || !panel) return;
    const check = () => {
      const parts = Array.from(pill.querySelectorAll<HTMLElement>(":scope > .hm-dot, :scope > .hm-info__state, :scope > .hm-info__doing"));
      if (parts.length === 0) return;
      const ps = getComputedStyle(pill);
      const px = (value: string) => parseFloat(value) || 0;
      const gap = px(ps.columnGap);
      const chrome = px(ps.paddingLeft) + px(ps.paddingRight) + px(ps.borderLeftWidth) + px(ps.borderRightWidth);
      const needed = chrome + parts.reduce((sum, el) => sum + el.offsetWidth + px(getComputedStyle(el).marginLeft), 0) + gap * (parts.length - 1);
      const cs = getComputedStyle(panel);
      const available = panel.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight);
      // 폭을 못 재는 곳(시험 환경)에서는 늘 다 보인다
      setShort(available > 0 && needed > available + 0.5);
    };
    check();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(check) : null;
    observer?.observe(panel);
    return () => observer?.disconnect();
  }, [activity, state]);
  return { ref, short };
}

export function HomeCatInfo({ home, activity, work, onChangeCat, onClose, className }: HomeCatInfoProps) {
  const mine = useMine();
  const heading = useRef<HTMLHeadingElement>(null);
  const { cat, entry } = home;
  const stateText = work === undefined ? t("cat.info.resting") : work.kind === "job" ? t("cat.info.working") : t("home.info.waiting");
  const { ref: statusRef, short: statusShort } = useStatusFits(activity, stateText);
  // 일하는 · 기다리는 중이면 뒤 설명은 자리만 ("캣휠에서") — 쉬는 중의 설명은 `cat.activity.*` 그대로
  const placeKey = `home.info.at.${activity}`;
  const doing = work && isTextKey(placeKey) ? t(placeKey) : t(`cat.activity.${activityTextKey(activity)}` as TextKey);

  // 열리면 제목으로 포커스 — 화면 읽기 프로그램이 바로 읽고, Tab 이 패널 안으로 이어진다
  useEffect(() => {
    heading.current?.focus();
  }, [cat]);

  // 보이는 이름 → 역할 이름 → 에이전트 이름 (엔트리를 모르는 먹물만 있는 집은 메인 대화)
  const role = entry ? mineLabel(agentKeyOf(entry), entry.role, mine) : t("home.info.role.main");
  const isMain = entry === null || entry.role === "main";
  // 읽을 수 없는 파일의 이름은 아래 안내 줄에 있다
  const agentName = isMain ? t("home.info.agentMain") : entry?.state === "ok" ? entry.name : null;
  const infoEntry = entry?.state === "ok" ? entry : null;

  return (
    <section id={PANEL_ID} className={`hm-info${className ? ` ${className}` : ""}`} aria-labelledby={`${PANEL_ID}-title`}>
      <header className="hm-info__head">
        <div className="hm-info__title">
          <h2 id={`${PANEL_ID}-title`} ref={heading} tabIndex={-1}>
            {t(`cat.${cat}.name`)}
          </h2>
          <p className="hm-info__agent">
            {role}
            {agentName && agentName !== role && (
              <>
                <span aria-hidden="true"> · </span>
                <code>{agentName}</code>
              </>
            )}
          </p>
        </div>
        <button type="button" className="hm-icon-btn" onClick={onClose} aria-label={t("cat.info.close")}>
          <Icon name="close" size={18} />
        </button>
      </header>

      <p className={`hm-info__status${work ? ` hm-info__status--${work.kind === "job" ? "work" : "wait"}` : ""}`} ref={statusRef} data-short={statusShort ? "true" : undefined} title={statusShort ? `${stateText} — ${doing}` : undefined}>
        <span className="hm-dot" aria-hidden="true" />
        <span className="hm-info__state">{stateText}</span>
        {/* 뒤 설명은 한 줄에 다 들어갈 때만 — 좁은 패널에서 넘치면 통째로 숨긴다. 숨겨도 화면 읽기 프로그램에는 따로 남긴다 */}
        <span className="hm-info__doing" aria-hidden={statusShort ? "true" : undefined}>
          — {doing}
        </span>
        {statusShort && <span className="hm-sr">— {doing}</span>}
      </p>

      {work && <WorkLines work={work} />}

      {entry?.state === "unreadable" ? (
        <>
          <p className="hm-info__broken" role="note">
            <Icon name="alert" size={18} />
            <span>
              <strong>{t("home.info.unreadable")}</strong>
              <span className="hm-info__reason">
                {t("home.info.file")}: <code>{entry.file}</code>
              </span>
              <span className="hm-info__reason">{reasonText(entry.reason)}</span>
            </span>
          </p>
          <p className="hm-info__summary">{t(`cat.${cat}.summary`)}</p>
        </>
      ) : infoEntry ? (
        <ReadableBody info={infoEntry} cat={cat} />
      ) : (
        <>
          <p className="hm-info__summary">{t(`cat.${cat}.summary`)}</p>
          <h3 className="hm-info__label">{t("cat.info.duties")}</h3>
          <p className="hm-info__duties">{t(`cat.${cat}.duties`)}</p>
        </>
      )}

      {onChangeCat && entry?.state === "ok" && (
        <button type="button" className="hm-link hm-info__change" onClick={() => onChangeCat(agentKeyOf(entry))}>
          {t("home.info.changeCat")}
        </button>
      )}
    </section>
  );
}
