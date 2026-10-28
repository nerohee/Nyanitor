// 고양이 정보 패널 (실제 화면) — 이름 · 에이전트 · 역할 · 지금 하는 일 · 모델 · 수준 · 성격 · 맡는 일.
// 읽기 전용: 고치기 · 고양이 바꾸기 단추는 없다 (내 수정 · 고양이 고르기는 P9). 시제품 `variants/shared/CatInfo.tsx` 를 바탕으로 새로 썼다.
import { useEffect, useId, useRef, useState } from "react";
import { PANEL_ID } from "../components/house/useCatPanel";
import { activityTextKey, type Activity } from "../components/house/spots";
import { isTextKey, t, type TextKey } from "../i18n/ko";
import type { AgentEntry, AgentInfo, AgentUnreadable } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import type { HomeCat } from "./useAgents";

/** 이 글자 수를 넘으면 맡는 일을 접어 둔다 (CSS 가 3줄에서 자른다) */
export const DUTIES_FOLD_LENGTH = 90;

interface HomeCatInfoProps {
  home: HomeCat;
  /** 지금 있는 자리 = 하는 일 */
  activity: Activity;
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

function roleText(role: AgentEntry["role"]): string | null {
  return role === null ? null : t(`home.info.role.${role}`);
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

export function HomeCatInfo({ home, activity, onClose, className }: HomeCatInfoProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const { cat, entry } = home;

  // 열리면 제목으로 포커스 — 화면 읽기 프로그램이 바로 읽고, Tab 이 패널 안으로 이어진다
  useEffect(() => {
    heading.current?.focus();
  }, [cat]);

  const role = entry ? roleText(entry.role) : t("home.info.role.main");
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
            {agentName && (
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

      <p className="hm-info__status">
        <span className="hm-dot" aria-hidden="true" />
        <span>
          {t("cat.info.resting")} — {t(`cat.activity.${activityTextKey(activity)}` as TextKey)}
        </span>
      </p>

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
    </section>
  );
}
