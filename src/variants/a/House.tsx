// 시안 a 「들여다보는 창」 — 집이 화면 전체 무대, 도구는 그 위에 얹은 종이 (design-references.md)
import { t } from "../../i18n/ko";
import { AGENTS, agentOf } from "../fixtures";
import type { ScreenProps } from "../types";
import { CatInfo } from "../shared/CatInfo";
import { NewProjectButton, ProjectList, ReadyLine, UsageBars } from "../shared/HomeBlocks";
import { HouseNav } from "../shared/HouseNav";
import { Station, Thing, useCatPanel } from "../shared/scene";
import "./house.css";

export function House({ usage }: ScreenProps) {
  const panel = useCatPanel();
  const bubble = (cat: (typeof AGENTS)[number]["cat"]) =>
    panel.openCat === cat ? <CatInfo agent={agentOf(cat)} onClose={panel.close} className="ha-card ha-bubble" /> : null;
  const station = (cat: (typeof AGENTS)[number]["cat"]) => ({ agent: agentOf(cat), panel, bubble: bubble(cat) });

  return (
    <div className="ha">
      <HouseNav className="ha-nav" />

      <div className="ha-scene">
        <section className="ha-room" aria-label={t("variant.home.cats")}>
          <div className="ha-floor" aria-hidden="true" />
          <div className="ha-beam" aria-hidden="true" />
          <div className="ha-glow" aria-hidden="true" />

          {/* 사물 (장식) */}
          <Thing name="lamp" x="50%" top="0" z={1} />
          <Thing name="picture-frame" x="58%" bottom="57%" z={1} />
          <Thing name="plant" x="4%" bottom="17%" z={2} />
          <Thing name="litter-box" x="31%" bottom="20%" z={2} />

          {/* 고양이 — DOM 은 왼쪽 → 오른쪽 (Tab 순서), 앞뒤는 z */}
          <Station {...station("mukmul")} x="12%" bottom="8%" z={8} bubbleSide="right" bubbleAlign="bottom" />
          <Station {...station("kkaebi")} x="19%" bottom="14%" range="24%" z={5} bubbleSide="above" />
          <Station {...station("nabi")} x="40%" bottom="44%" z={3} bubbleSide="right" bubbleAlign="top" />
          <Station {...station("dubu")} x="45%" bottom="8%" z={8} bubbleSide="above" />
          <Station {...station("mulgam")} x="59%" bottom="15%" z={5} bubbleSide="above" />
          <Station {...station("danchu")} x="76%" bottom="12%" z={4} bubbleSide="left" bubbleAlign="bottom" />
          <Station {...station("gureum")} x="91%" bottom="17%" z={3} bubbleSide="left" bubbleAlign="top" />
        </section>

        <aside className="ha-card ha-status">
          <ReadyLine />
          <UsageBars usage={usage} />
        </aside>

        <div className="ha-slab">
          <NewProjectButton className="ha-new" />
          <section className="ha-recent" aria-labelledby="ha-recent-title">
            <h2 id="ha-recent-title" className="ha-recent__title">
              {t("variant.home.recent")}
            </h2>
            <ProjectList showPath={false} className="ha-projects" />
          </section>
        </div>
      </div>
    </div>
  );
}
