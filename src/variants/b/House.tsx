// 시안 b 「선반 위 띠」 — 집은 위쪽 가로 띠(방 세 칸), 도구는 그 아래 차분한 격자 (design-references.md)
import type { CatId } from "../../components/cat/looks";
import { t } from "../../i18n/ko";
import { AGENTS, agentOf, isWorking } from "../fixtures";
import type { ScreenProps } from "../types";
import { CatInfo } from "../shared/CatInfo";
import { NewProjectButton, ProjectList, ReadyLine, UsageBars } from "../shared/HomeBlocks";
import { HouseNav } from "../shared/HouseNav";
import { Station, Thing, useCatPanel } from "../shared/scene";
import "./house.css";

function Roster() {
  const working = AGENTS.filter((agent) => isWorking(agent.activity));
  const resting = AGENTS.filter((agent) => !isWorking(agent.activity));
  return (
    <div className="hb-roster">
      <h2 className="hb-card__title">{t("variant.home.cats")}</h2>
      <p className="hb-roster__group" data-working="true">
        <span className="status-dot" aria-hidden="true" />
        <span>
          <strong>{t("variant.home.workingNow")}</strong>{" "}
          {working.map((agent) => t(`cat.${agent.cat}.name`)).join(" · ")}
        </span>
      </p>
      <p className="hb-roster__group">
        <span className="status-dot" aria-hidden="true" />
        <span>
          <strong>{t("variant.home.restingNow")}</strong>{" "}
          {resting.map((agent) => t(`cat.${agent.cat}.name`)).join(" · ")}
        </span>
      </p>
      <p className="hb-roster__hint">{t("variant.home.catHint")}</p>
    </div>
  );
}

export function House({ usage }: ScreenProps) {
  const panel = useCatPanel();
  const station = (cat: CatId) => ({ agent: agentOf(cat), panel });

  return (
    <div className="hb">
      <HouseNav className="hb-nav" />

      <div className="hb-main">
        <section className="hb-strip" aria-label={t("variant.home.cats")}>
          <div className="hb-room hb-room--window">
            <p className="hb-room__label" aria-hidden="true">
              {t("variant.room.window")}
            </p>
            <Thing name="plant" x="14%" bottom="12%" z={2} />
            <Station {...station("nabi")} x="54%" bottom="38%" z={1} />
            <Station {...station("kkaebi")} x="18%" bottom="7%" range="66%" z={4} />
          </div>

          <div className="hb-room hb-room--living">
            <p className="hb-room__label" aria-hidden="true">
              {t("variant.room.living")}
            </p>
            <Thing name="picture-frame" x="24%" bottom="56%" z={1} />
            <Station {...station("mulgam")} x="22%" bottom="12%" z={3} />
            <Station {...station("dubu")} x="52%" bottom="7%" z={4} />
            <Station {...station("mukmul")} x="83%" bottom="9%" z={3} />
          </div>

          <div className="hb-room hb-room--workshop">
            <p className="hb-room__label" aria-hidden="true">
              {t("variant.room.workshop")}
            </p>
            <Thing name="lamp" x="62%" top="0" z={1} />
            <Station {...station("danchu")} x="34%" bottom="7%" z={3} />
            <Station {...station("gureum")} x="82%" bottom="9%" z={2} />
          </div>
        </section>

        <div className="hb-desk">
          <section className="hb-card hb-home" aria-labelledby="hb-recent-title">
            <div className="hb-home__top">
              <ReadyLine />
              <NewProjectButton />
            </div>
            <h2 id="hb-recent-title" className="hb-card__title">
              {t("variant.home.recent")}
            </h2>
            <ProjectList showPath={false} className="hb-projects" />
          </section>

          <section className="hb-card hb-usage" aria-labelledby="hb-usage-title">
            <h2 id="hb-usage-title" className="hb-card__title">
              {t("variant.home.usage")}
            </h2>
            <UsageBars usage={usage} />
          </section>

          <div className="hb-card hb-info">
            {panel.openCat ? <CatInfo agent={agentOf(panel.openCat)} onClose={panel.close} /> : <Roster />}
          </div>
        </div>
      </div>
    </div>
  );
}
