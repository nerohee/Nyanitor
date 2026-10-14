import { useEffect, useRef } from "react";
import { PANEL_ID } from "../../components/house/useCatPanel";
import { activityTextKey } from "../../components/house/spots";
import { t } from "../../i18n/ko";
import { isWorking, type Activity, type AgentFixture } from "../fixtures";
import { Icon } from "./icons";
import "./shared.css";

interface CatInfoProps {
  agent: AgentFixture;
  /** 지금 있는 자리 = 하는 일 */
  activity: Activity;
  onClose: () => void;
  className?: string;
}

/** 고양이 정보 패널 내용: 이름 · 에이전트 · 역할 · 지금 하는 일 · 모델 · 수준 · 성격 · 맡는 일 · 고치기 (D-07) */
export function CatInfo({ agent, activity, onClose, className }: CatInfoProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const cat = agent.cat;
  const working = isWorking(activity);

  // 열리면 제목으로 포커스 — 화면 읽기 프로그램이 바로 읽고, Tab 이 패널 안으로 이어진다
  useEffect(() => {
    heading.current?.focus();
  }, [cat]);

  return (
    <section id={PANEL_ID} className={`cat-info${className ? ` ${className}` : ""}`} aria-labelledby={`${PANEL_ID}-title`}>
      <header className="cat-info__head">
        <div className="cat-info__title">
          <h2 id={`${PANEL_ID}-title`} ref={heading} tabIndex={-1}>
            {t(`cat.${cat}.name`)}
          </h2>
          <p className="cat-info__agent">
            {t(`cat.${cat}.role`)}
            <span aria-hidden="true"> · </span>
            <code>{agent.agentFile ?? t("cat.info.main")}</code>
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("cat.info.close")}>
          <Icon name="close" size={18} />
        </button>
      </header>

      <p className="cat-info__status" data-working={working ? "true" : undefined}>
        <span className="status-dot" aria-hidden="true" />
        <span>
          {t(working ? "cat.info.working" : "cat.info.resting")} — {t(`cat.activity.${activityTextKey(activity)}`)}
        </span>
      </p>

      <dl className="cat-info__meta">
        <div>
          <dt>{t("cat.info.model")}</dt>
          <dd>{agent.model}</dd>
        </div>
        <div>
          <dt>{t("cat.info.effort")}</dt>
          <dd>{t(`cat.effort.${agent.effort}`)}</dd>
        </div>
      </dl>

      <p className="cat-info__summary">{t(`cat.${cat}.summary`)}</p>
      <h3 className="cat-info__label">{t("cat.info.duties")}</h3>
      <p className="cat-info__duties">{t(`cat.${cat}.duties`)}</p>

      <div className="cat-info__actions">
        <button type="button" className="hbtn">
          <Icon name="custom" size={18} />
          {t("cat.info.edit")}
        </button>
      </div>
    </section>
  );
}
