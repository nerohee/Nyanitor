// 시안 c 의 세로 탑 (다락 · 거실 · 작업실). 고양이 집에서는 고양이를 누를 수 있고(panel), 작업 공간 기둥에서는 그림만.
import type { CatId } from "../../components/cat/looks";
import type { HouseObjectName } from "../../components/house/HouseObject";
import { t } from "../../i18n/ko";
import type { Activity } from "../fixtures";
import { Station, Thing, type CatAgent, type CatPanel } from "../shared/scene";

function Roof() {
  return (
    <svg className="hc-roof" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d="M4 58 L200 4 L396 58 Z" />
    </svg>
  );
}

/** 고양이마다 집 안 자리. 자기 사물(창 · 캣타워 · 캣휠)을 쓰지 않을 때는 그 앞에 서 있다 */
const HOME: Record<CatId, { x: string; bottom: string; z: number; object?: { name: HouseObjectName; uses: Activity; bottom: string } }> = {
  nabi: { x: "27%", bottom: "34%", z: 2, object: { name: "window", uses: "window", bottom: "34%" } },
  gureum: { x: "70%", bottom: "9%", z: 1, object: { name: "cat-tower", uses: "tower", bottom: "9%" } },
  mulgam: { x: "20%", bottom: "12%", z: 2 },
  dubu: { x: "52%", bottom: "6%", z: 3 },
  mukmul: { x: "83%", bottom: "9%", z: 2 },
  danchu: { x: "27%", bottom: "6%", z: 2, object: { name: "cat-wheel", uses: "wheel", bottom: "6%" } },
  kkaebi: { x: "50%", bottom: "10%", z: 3 },
};

const FLOOR_OF: Record<CatId, "attic" | "living" | "workshop"> = {
  nabi: "attic",
  gureum: "attic",
  mulgam: "living",
  dubu: "living",
  mukmul: "living",
  danchu: "workshop",
  kkaebi: "workshop",
};

function Cat({ agent, panel }: { agent: CatAgent; panel?: CatPanel }) {
  const home = HOME[agent.cat];
  const usesObject = home.object && home.object.uses === agent.activity;
  if (home.object && !usesObject) {
    // 자기 사물 앞에 서서 쉬는 중
    return (
      <>
        <Thing name={home.object.name} x={home.x} bottom={home.object.bottom} z={home.z - 1} />
        <Station agent={agent} panel={panel} x={home.x} bottom={agent.cat === "nabi" ? "6%" : "4%"} z={home.z + 1} />
      </>
    );
  }
  return (
    <Station
      agent={agent}
      panel={panel}
      x={home.x}
      bottom={home.bottom}
      z={home.z}
      range={agent.activity === "walk" ? "32%" : undefined}
    />
  );
}

export function Tower({ agents, panel, className }: { agents: CatAgent[]; panel?: CatPanel; className?: string }) {
  const on = (floor: "attic" | "living" | "workshop") => agents.filter((agent) => FLOOR_OF[agent.cat] === floor);
  // 같은 층 안에서는 왼쪽 → 오른쪽 (Tab 순서)
  const byX = (a: CatAgent, b: CatAgent) => parseFloat(HOME[a.cat].x) - parseFloat(HOME[b.cat].x);
  return (
    <section className={`hc-floors${className ? ` ${className}` : ""}`} aria-label={t("variant.home.cats")}>
      <div className="hc-floor hc-floor--attic">
        <Roof />
        <p className="hc-floor__label" aria-hidden="true">
          {t("variant.room.attic")}
        </p>
        {on("attic")
          .sort(byX)
          .map((agent) => (
            <Cat key={agent.cat} agent={agent} panel={panel} />
          ))}
      </div>
      <div className="hc-floor hc-floor--living">
        <p className="hc-floor__label" aria-hidden="true">
          {t("variant.room.living")}
        </p>
        <Thing name="picture-frame" x="20%" bottom="52%" z={1} />
        {on("living")
          .sort(byX)
          .map((agent) => (
            <Cat key={agent.cat} agent={agent} panel={panel} />
          ))}
      </div>
      <div className="hc-floor hc-floor--workshop">
        <p className="hc-floor__label" aria-hidden="true">
          {t("variant.room.workshop")}
        </p>
        <Thing name="lamp" x="30%" top="0" z={1} />
        <Thing name="litter-box" x="91%" bottom="12%" z={1} />
        {on("workshop")
          .sort(byX)
          .map((agent) => (
            <Cat key={agent.cat} agent={agent} panel={panel} />
          ))}
      </div>
    </section>
  );
}
