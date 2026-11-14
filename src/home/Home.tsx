// 실제 메인 화면 — 고양이 집 (시안 a 「들여다보는 창」, D-30 · ③ 스티커 수첩, D-43).
// 집이 화면 전체 무대, 카드는 그림의 빈 곳: 왼쪽 위 = 준비 상태 + 사용량, 아래 판 = 최근 프로젝트 + 새 프로젝트 단추 (P6-04).
// 왼쪽에 메뉴(고양이 집 · 작업 공간) — 프로젝트를 누르면 작업 공간에서 열린다.
// 앱이 돌린 세션의 작업자가 일하는 동안 그 고양이는 캣휠(점검은 캣타워)에, 기다리는 카드를 보낸 고양이(먹물, 또는 권한을 물은 작업자)는 댓돌에 있다 (P7-05, `useHomeWork`). 나머지는 쉰다.
import { useMemo, useRef, useState } from "react";
import { HouseScene } from "../components/house/HouseScene";
import { AppNav, type NavPlace } from "../components/nav/AppNav";
import { timeOfDay } from "../components/house/time";
import { useCatPanel } from "../components/house/useCatPanel";
import { useHouseSchedule, useSceneMotion } from "../components/house/useHouse";
import { t } from "../i18n/ko";
import { useProjects } from "../workspace/useProjects";
import { HomeCatInfo } from "./HomeCatInfo";
import { HomeProjects } from "./HomeProjects";
import { ReadyLine, UsageBlock } from "./StatusCard";
import { agentKeyOf, useAgents, type AgentsState } from "./useAgents";
import { mineLabel, useMine } from "../lib/mine";
import { useClock } from "./useClock";
import { useAppChurros } from "./useAppChurros";
import { useHomeWork, workedText } from "./useHomeWork";
import { cardElements, useBlockedSpots } from "./useBlockedSpots";
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

/** 일하는 자리 (캣휠 · 캣타워 · 댓돌) */
const WORK_SPOTS: readonly string[] = ["wheel", "tower", "stone"];

interface HomeProps {
  /** 왼쪽 메뉴 */
  onGo: (place: NavPlace) => void;
  /** 판의 최근 프로젝트를 눌렀다 — 작업 공간에서 연다 */
  onOpenProject: (id: number) => void;
  /** 새 프로젝트 단추 — 작업 공간으로 가서 새 프로젝트 창을 연다 */
  onNewProject: () => void;
  /** 정보 패널의 "진행 보기" · "채팅에서 보기" — 그 프로젝트의 작업 공간을 그 탭으로 연다 */
  onOpenWork: (projectId: number, tab: "progress" | "chat") => void;
  /** 정보 패널의 「고양이 바꾸기」 — 「내 수정」의 고양이 고르기를 그 에이전트(`main` / 에이전트 이름)를 고른 채 연다 */
  onChangeCat?: (agent: string) => void;
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  clock?: () => Date;
}

export default function Home({ onGo, onOpenProject, onNewProject, onOpenWork, onChangeCat, clock }: HomeProps) {
  const now = useClock(clock);
  const time = timeOfDay(now);
  const panel = useCatPanel();
  const motion = useSceneMotion();
  const { state: agents, cats } = useAgents();
  const present = cats.map((c) => c.cat);
  // 이름표의 역할 글 — 그 고양이를 맡은 에이전트의 이름 (보이는 이름 → 역할 이름). 고양이를 맞바꾸면 맡은 일도 바뀌어 보인다 (P9-05 검수)
  const mine = useMine();
  const roleLabels = useMemo(
    () => Object.fromEntries(cats.map((c) => [c.cat, c.entry === null || c.entry.role === "main" ? t("cat.mukmul.role") : mineLabel(agentKeyOf(c.entry), c.entry.role, mine)])),
    [cats, mine],
  );
  // 일하는 고양이 · 기다리는 먹물은 세션 저장소에서 (진행 탭 둥근 창문과 같은 규칙). 에이전트가 없는 고양이는 일을 맡아도 집에 나오지 않는다
  const work = useHomeWork();
  // 위 카드 · 아래 판 카드에 덮인 자리는 고양이가 피한다 (창이 좁을수록 많이 덮는다)
  const sceneRef = useRef<HTMLDivElement>(null);
  const blocked = useBlockedSpots(sceneRef);
  const placements = useHouseSchedule(work.intents, motion, panel.openCat, present, blocked).filter((p) => present.includes(p.cat));
  const readiness = useReadiness(agents.status === "ready" && agents.list.state === "ok");
  const usage = useUsage();
  const churros = useAppChurros();
  const projects = useProjects();
  const [bubbleLayer, setBubbleLayer] = useState<HTMLDivElement | null>(null);
  const note = agentsNote(agents);

  const renderPanel = (cat: (typeof placements)[number]["cat"]) => {
    const placement = placements.find((p) => p.cat === cat);
    const home = cats.find((c) => c.cat === cat);
    if (!placement || !home) return null;
    const job = work.jobs[cat];
    const waiting = work.waiting?.cat === cat ? work.waiting : null;
    // 일이 바뀐 직후 아직 걸어 나가기 전이면 (자리와 일이 안 맞으면) "어슬렁거리는 중" — "쉬는 중 · 캣휠에서 일하는 중" 처럼 어긋나 보이지 않게
    const workSpot = job ? (job.intent === "watching" ? "tower" : "wheel") : waiting ? "stone" : null;
    const atWorkSpot = workSpot === null ? !WORK_SPOTS.includes(placement.spot) : placement.spot === workSpot;
    const projectId = job?.projectId ?? waiting?.projectId ?? null;
    const projectName = projectId !== null && projects.state.status === "ready" ? (projects.state.projects.find((p) => p.id === projectId)?.name ?? null) : null;
    return (
      <HomeCatInfo
        home={home}
        activity={placement.walking || !atWorkSpot ? "walk" : placement.spot}
        work={
          job
            ? { kind: "job", projectName, description: job.description, worked: workedText(job.startedAtMs, now.getTime()), onOpen: () => onOpenWork(job.projectId, "progress") }
            : waiting
              ? { kind: "waiting", projectName, count: waiting.count, description: waiting.description, onOpen: () => onOpenWork(waiting.projectId, "chat") }
              : undefined
        }
        onChangeCat={onChangeCat}
        onClose={panel.close}
      />
    );
  };

  return (
    <div className="home" data-testid="home" data-skin="3" data-time={time}>
      <AppNav current="house" onGo={onGo} />
      <main className="hm-view">
        <h1 className="hm-sr" tabIndex={-1}>{t("home.title")}</h1>
        <div className="hm-scene" ref={sceneRef}>
          <HouseScene
            className="hm-room"
            label={t("home.cats")}
            time={time}
            placements={placements}
            roleLabels={roleLabels}
            interaction={{ panel, renderPanel, bubbleLayer, avoid: () => (sceneRef.current ? cardElements(sceneRef.current) : []) }}
            debug={spotsDebug()}
          />

          <aside className="hm-card hm-status" aria-label={t("home.status.label")}>
            <ReadyLine readiness={readiness} />
            {note && (
              <p className="hm-note" role="status">
                {note}
              </p>
            )}
            <UsageBlock {...usage} now={now} churros={churros} onRefresh={usage.refresh} />
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
