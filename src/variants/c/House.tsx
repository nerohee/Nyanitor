// 시안 c 「다락 탑」 — 집은 층층이 쌓인 세로 탑, 오른쪽은 큰 글자 한 줄씩. 그림책 잉크 선 (design-references.md)
import { t, tf } from "../../i18n/ko";
import { AGENTS, agentOf, type UsageFixture } from "../fixtures";
import type { ScreenProps } from "../types";
import { CatInfo } from "../shared/CatInfo";
import { NewProjectButton, ProjectList, TokenEstimate, UsageUnavailable } from "../shared/HomeBlocks";
import { HouseNav } from "../shared/HouseNav";
import { useCatPanel } from "../shared/scene";
import { Tower } from "./Tower";
import "./house.css";

/** 사용량은 큰 숫자 하나(5시간 한도) + 작은 설명 */
function UsageBig({ usage }: { usage: UsageFixture }) {
  if (usage.status !== "ok") {
    return (
      <div className="hc-usage__body">
        <UsageUnavailable />
        <TokenEstimate usage={usage} />
      </div>
    );
  }
  return (
    <div className="hc-usage__body">
      <p className="hc-usage__big">
        <strong>{usage.fiveHour.percent}%</strong>
        <span>
          {t("variant.home.fiveHour")}
          <br />
          {tf("variant.home.resets", { when: t(usage.fiveHour.resetKey) })}
        </span>
      </p>
      <p className="hc-usage__small">
        {t("variant.home.weekly")} {usage.weekly.percent}% ·{" "}
        {tf("variant.home.resets", { when: t(usage.weekly.resetKey) })}
      </p>
      <TokenEstimate usage={usage} />
    </div>
  );
}

export function House({ time, usage }: ScreenProps) {
  const panel = useCatPanel();

  return (
    <div className="hc">
      <div className="hc-side">
        <div className="hc-tower">
          <Tower agents={[...AGENTS]} panel={panel} />
        </div>
        <HouseNav className="hc-nav" />
      </div>

      <main className="hc-content">
        {panel.openCat ? (
          <CatInfo agent={agentOf(panel.openCat)} onClose={panel.close} closeStyle="back" portrait className="hc-info" />
        ) : (
          <>
            <h1 className="hc-greet">{t(`variant.c.greeting.${time}`)}</h1>
            <p className="hc-lead">{t("variant.c.readyLine")}</p>
            <p className="hc-ready">
              {t("variant.home.ready")} · {t("variant.home.readyDetail")}
            </p>
            <NewProjectButton className="hc-new" />

            <section className="hc-block" aria-labelledby="hc-recent-title">
              <h2 id="hc-recent-title" className="hc-block__title">
                {t("variant.home.recent")}
              </h2>
              <ProjectList className="hc-projects" />
            </section>

            <section className="hc-block" aria-labelledby="hc-usage-title">
              <h2 id="hc-usage-title" className="hc-block__title">
                {t("variant.home.usage")}
              </h2>
              <UsageBig usage={usage} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
