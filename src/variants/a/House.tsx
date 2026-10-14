// 시안 a 「들여다보는 창」 — 집이 화면 전체 무대, 도구는 그 위에 얹은 종이 (design-references.md)
// 장면은 한옥 마당 그림 한 장 위에 고양이가 자리마다 와 있는 모습. 카드는 그림의 빈 곳(A: 왼쪽 위 담장, B: 아래 잔디)에.
import { useState } from "react";
import { HouseScene } from "../../components/house/HouseScene";
import { useCatPanel } from "../../components/house/useCatPanel";
import { useFakeIntents, useHouseSchedule, useSceneMotion } from "../../components/house/useHouse";
import { t } from "../../i18n/ko";
import { agentOf } from "../fixtures";
import type { ScreenProps } from "../types";
import { CatInfo } from "../shared/CatInfo";
import { NewProjectButton, ProjectList, ReadyLine, UsageBars } from "../shared/HomeBlocks";
import { HouseNav } from "../shared/HouseNav";
import "./house.css";

/** 주소에 `&spots=on` 이 있으면 자리 십자 표시 (좌표를 맞출 때 쓴다) */
function spotsDebug(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("spots") === "on";
}

/** 주소에 `&plan=2` 가 있으면 가짜 일정의 그 번째(0부터)로 시작 (스크린샷 · 고객 확인용) */
function firstPlan(): number {
  const value = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("plan");
  return value === null ? 0 : Number(value) || 0;
}

export function House({ time, usage }: ScreenProps) {
  const panel = useCatPanel();
  const motion = useSceneMotion();
  // 지금은 가짜 일정 — P5 에서 실제 에이전트 상태(`Intents`)로 바꾼다
  const intents = useFakeIntents(motion, firstPlan());
  const placements = useHouseSchedule(intents, motion, panel.openCat);
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);

  const renderPanel = (cat: (typeof placements)[number]["cat"]) => {
    const placement = placements.find((p) => p.cat === cat);
    if (!placement) return null;
    return (
      <CatInfo
        agent={agentOf(cat)}
        activity={placement.walking ? "walk" : placement.spot}
        onClose={panel.close}
        className="ha-card ha-bubble"
      />
    );
  };

  return (
    <div className="ha">
      <HouseNav className="ha-nav" />

      <div className="ha-scene">
        <HouseScene
          className="ha-room"
          label={t("variant.home.cats")}
          time={time}
          placements={placements}
          interaction={{ panel, renderPanel, bubbleLayer }}
          debug={spotsDebug()}
        />

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

        {/* 정보 패널 층 — 카드보다 앞 */}
        <div className="ha-bubbles" ref={setBubbleLayer} />
      </div>
    </div>
  );
}
