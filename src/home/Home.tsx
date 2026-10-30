// 실제 메인 화면 — 고양이 집 (시안 a 「들여다보는 창」, D-30 · ③ 스티커 수첩, D-43).
// 집이 화면 전체 무대, 카드는 그림의 빈 곳: 왼쪽 위 = 준비 상태 + 사용량, 아래 판 = 최근 프로젝트 + 새 프로젝트 단추 (P6-04).
// 왼쪽에 메뉴(고양이 집 · 작업 공간) — 프로젝트를 누르면 작업 공간에서 열린다.
// 지금은 모든 고양이가 쉬는 중이다 — 일하는 고양이 · 실제 작업 상태 연결은 P7.
import { useState } from "react";
import { HouseScene } from "../components/house/HouseScene";
import { AppNav, type NavPlace } from "../components/nav/AppNav";
import { REST_ALL } from "../components/house/schedule";
import { timeOfDay } from "../components/house/time";
import { useCatPanel } from "../components/house/useCatPanel";
import { useHouseSchedule, useSceneMotion } from "../components/house/useHouse";
import { t } from "../i18n/ko";
import { useProjects } from "../workspace/useProjects";
import { HomeCatInfo } from "./HomeCatInfo";
import { HomeProjects } from "./HomeProjects";
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
  /** 왼쪽 메뉴 */
  onGo: (place: NavPlace) => void;
  /** 판의 최근 프로젝트를 눌렀다 — 작업 공간에서 연다 */
  onOpenProject: (id: number) => void;
  /** 새 프로젝트 단추 — 작업 공간으로 가서 새 프로젝트 창을 연다 */
  onNewProject: () => void;
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  clock?: () => Date;
}

export default function Home({ onGo, onOpenProject, onNewProject, clock }: HomeProps) {
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
  const projects = useProjects();
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
    <div className="home" data-testid="home" data-skin="3" data-time={time}>
      <AppNav current="house" onGo={onGo} />
      <main className="hm-view">
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

          {/* 아래 판 — 최근 프로젝트 몇 개 + 새 프로젝트 단추 (크기 · 자리는 시제품과 같다) */}
          <HomeProjects
            state={projects.state}
            now={now}
            onOpen={onOpenProject}
            onNew={onNewProject}
            onRetry={() => void projects.reload()}
          />

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
    </div>
  );
}
