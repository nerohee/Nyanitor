// 실제 메인 화면 — 고양이 집 (시안 a 「들여다보는 창」, D-30 · ③ 스티커 수첩, D-43).
// 집이 화면 전체 무대, 카드는 그림의 빈 곳: 왼쪽 위 = 준비 상태 + 사용량, 아래 판 = 프로젝트 자리 (P6 에서 채운다).
// 지금은 모든 고양이가 쉬는 중이다 — 일하는 고양이 · 실제 작업 상태 연결은 P7.
import { useState } from "react";
import { HouseScene } from "../components/house/HouseScene";
import { REST_ALL } from "../components/house/schedule";
import { timeOfDay } from "../components/house/time";
import { useCatPanel } from "../components/house/useCatPanel";
import { useHouseSchedule, useSceneMotion } from "../components/house/useHouse";
import { t } from "../i18n/ko";
import { HomeCatInfo } from "./HomeCatInfo";
import { ReadyLine, UsageBlock } from "./StatusCard";
import { useAgents, type AgentsState } from "./useAgents";
import { useClock } from "./useClock";
import { useReadiness } from "./useReadiness";
import { useUsage } from "./useUsage";
import "./home.css";

/** 주소에 `?spots=on` 이 있으면 자리 십자 표시 (개발 중 좌표를 맞출 때 쓴다) */
function spotsDebug(): boolean {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("spots") === "on";
}

/** 카드에 한 줄로 알릴 에이전트 목록의 사정 (없으면 null) */
function agentsNote(state: AgentsState): string | null {
  if (state.status === "failed") return t("home.agents.failed");
  if (state.status !== "ready") return null;
  if (state.list.state === "no_harness") return t("home.agents.noHarness");
  if (state.list.state === "location_unusable") return t("home.agents.unusable");
  if (state.list.config === "unreadable") return t("home.agents.configBroken");
  return null;
}

interface HomeProps {
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  clock?: () => Date;
}

export default function Home({ clock }: HomeProps) {
  const now = useClock(clock);
  const time = timeOfDay(now);
  const panel = useCatPanel();
  const motion = useSceneMotion();
  const { state: agents, cats } = useAgents();
  const present = cats.map((c) => c.cat);
  // 일하는 고양이가 없다 (P7) — 쉬는 자리만 오간다. 에이전트가 없는 고양이는 집에 나오지 않는다
  const placements = useHouseSchedule(REST_ALL, motion, panel.openCat, present).filter((p) => present.includes(p.cat));
  const readiness = useReadiness(agents.status === "ready" && agents.list.state === "ok");
  const usage = useUsage();
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);
  const note = agentsNote(agents);

  const renderPanel = (cat: (typeof placements)[number]["cat"]) => {
    const placement = placements.find((p) => p.cat === cat);
    const home = cats.find((c) => c.cat === cat);
    if (!placement || !home) return null;
    return (
      <HomeCatInfo
        home={home}
        activity={placement.walking ? "walk" : placement.spot}
        onClose={panel.close}
      />
    );
  };

  return (
    <main className="home" data-testid="home" data-skin="3" data-time={time}>
      <h1 className="hm-sr">{t("home.title")}</h1>
      <div className="hm-scene">
        <HouseScene
          className="hm-room"
          label={t("home.cats")}
          time={time}
          placements={placements}
          interaction={{ panel, renderPanel, bubbleLayer }}
          debug={spotsDebug()}
        />

        <aside className="hm-card hm-status" aria-label={t("home.status.label")}>
          <ReadyLine readiness={readiness} />
          {note && (
            <p className="hm-note" role="status">
              {note}
            </p>
          )}
          <UsageBlock {...usage} now={now} onRefresh={usage.refresh} />
        </aside>

        {/* 프로젝트 자리 — 이번엔 빈 상태 (P6 에서 목록 · 새 프로젝트로 바뀐다). 크기 · 자리는 시제품과 같다 */}
        <div className="hm-slab">
          <section className="hm-card hm-slab__card" aria-labelledby="hm-projects-title">
            <h2 id="hm-projects-title" className="hm-slab__title">
              {t("home.projects.empty")}
            </h2>
            <p className="hm-slab__hint">{t("home.projects.hint")}</p>
          </section>
        </div>

        {/* 정보 패널 층 — 카드보다 앞 */}
        <div className="hm-bubbles" ref={setBubbleLayer} />

        {/* 개발 빌드에서만: Tauri 창에는 주소창이 없으니 시험 화면으로 가는 링크 (출시 빌드에서는 지워진다) */}
        {import.meta.env.DEV && (
          <nav className="hm-dev" aria-label={t("home.dev.label")}>
            <a href="?lab=session">{t("lab.open")}</a>
            <a href="?lab=harness">{t("lab.harness.open")}</a>
          </nav>
        )}
      </div>
    </main>
  );
}
