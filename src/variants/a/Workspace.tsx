// 시안 a 「들여다보는 창」 작업 공간 — 장면이 종이 뒤로 물러나고, 진행 보기 맨 위 둥근 창문 안에 일하는 고양이 (design-references.md)
// 창문은 집 화면과 같은 장면을 잘라 보는 것 — 일하는 고양이가 있는 곳(캣휠 · 캣타워 · 댓돌)이 가운데에 온다.
// P2-14: 넓은 창(1280 이상)은 프로젝트 | 요구사항(접을 수 있음) | 채팅 | 진행 나란히, 좁은 창은 프로젝트 바꾸기 단추 + 탭 (plan §5).
import { useEffect, useRef, useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { HouseScene, type Crop } from "../../components/house/HouseScene";
import { staticPlacements, type CatPlacement, type Intents } from "../../components/house/schedule";
import { SPOTS, STAGE, type Activity } from "../../components/house/spots";
import { CAT_IDS, type CatId } from "../../components/cat/catalog";
import { t } from "../../i18n/ko";
import { ORCHESTRATOR } from "../fixtures";
import { workspaceFixture, type WorkspaceFixture } from "../fixtures-workspace";
import type { ScreenProps } from "../types";
import type { TimeOfDay } from "../query";
import { HouseNav } from "../shared/HouseNav";
import { RequirementsEditor } from "../shared/editor";
import { PhaseBoard, ProgressLog, RAW_ID, RawOutput, WorkingCats } from "../shared/progress";
import { NewProjectDialog, NoProjects, ProjectNavList, ProjectSwitcher } from "../shared/projects";
import { ChatPane, useWide, WorkPanels } from "../shared/workspace";
import "./house.css";
import "./workspace.css";

/** 창문에 보이는 배경 영역의 크기 (4 : 3 — 창문 모양과 같다) */
const WINDOW_VIEW = { w: 620, h: 465 } as const;

/** 일하는 자리 → 고양이의 의도 */
function intentOf(activity: Activity) {
  if (activity === "wheel") return "making" as const;
  if (activity === "tower") return "watching" as const;
  if (activity === "stone") return "wait" as const;
  return "rest" as const;
}

function windowIntents(fx: WorkspaceFixture): Intents {
  const entries = CAT_IDS.map((cat): [CatId, ReturnType<typeof intentOf>] => {
    const work = fx.working.find((w) => w.cat === cat);
    return [cat, work ? intentOf(work.activity) : "rest"];
  });
  return Object.fromEntries(entries) as Intents;
}

/** 첫 번째 일하는 고양이가 가운데에 오게 (배경 밖으로 나가지 않게 밀어 넣는다). 아무도 없으면 방석 쪽 */
function windowCrop(placements: readonly CatPlacement[], fx: WorkspaceFixture): Crop {
  const focus = placements.find((p) => p.cat === fx.working[0]?.cat);
  const feet = SPOTS[focus?.spot ?? "cushion"].feet;
  const x = Math.min(Math.max(feet.x - WINDOW_VIEW.w / 2, 0), STAGE.width - WINDOW_VIEW.w);
  const y = Math.min(Math.max(feet.y - WINDOW_VIEW.h * 0.62, 0), STAGE.height - WINDOW_VIEW.h);
  return { x, y, ...WINDOW_VIEW };
}

/** 둥근 창문 — 같은 장면이 작게 보이고, 일하는 고양이가 캣휠 · 캣타워에 */
function RoomWindow({ fx, time }: { fx: WorkspaceFixture; time: TimeOfDay }) {
  const placements = staticPlacements(windowIntents(fx));
  return (
    <div className="wa-window" role="img" aria-label={t("variant.ws.window")}>
      <HouseScene className="wa-window__room" time={time} placements={placements} crop={windowCrop(placements, fx)} />
    </div>
  );
}

/** 좁은 창: 탭 줄 오른쪽 작은 동그라미 창문 (일하는 고양이 얼굴) */
function MiniWindow({ fx }: { fx: WorkspaceFixture }) {
  // 일하는 고양이가 없으면 먹물(오케스트레이터)
  const cat = fx.working[0]?.cat ?? ORCHESTRATOR;
  return (
    <span className="wa-mini" aria-hidden="true">
      <CatFigure cat={cat} crop="face" />
    </span>
  );
}

function Progress({ fx, time, rawNonce }: { fx: WorkspaceFixture; time: TimeOfDay; rawNonce: number }) {
  return (
    <div className="wa-progress">
      <div className="wa-progress__inner">
        <div className="wa-progress__live">
          <RoomWindow fx={fx} time={time} />
          <h3 className="wa-h">{t("variant.ws.workingCats")}</h3>
          <WorkingCats working={fx.working} />
        </div>
        <div className="wa-progress__story">
          <h3 className="wa-h">{t("variant.ws.board")}</h3>
          <PhaseBoard phases={fx.phases} paused={fx.runBar !== undefined} />
          <h3 className="wa-h">{t("variant.ws.log")}</h3>
          <ProgressLog log={fx.log} />
          <RawOutput key={rawNonce} raw={fx.raw} open={rawNonce > 0} />
        </div>
      </div>
    </div>
  );
}

function currentPhase(fx: WorkspaceFixture): string | undefined {
  if (!Array.isArray(fx.phases)) return undefined;
  return fx.phases.find((p) => p.status === "now" || p.status === "waiting")?.id;
}

export function Workspace({ work, time }: ScreenProps) {
  const fx = workspaceFixture(work);
  const wide = useWide();
  const [dialog, setDialog] = useState(fx.dialog === "new");
  const [active, setActive] = useState(fx.pending > 0 || fx.runBar || fx.chat.length > 0 ? "chat" : "editor");
  const [rawNonce, setRawNonce] = useState(0);
  const opener = useRef<HTMLElement | null>(null);

  const openDialog = () => {
    opener.current = document.activeElement as HTMLElement | null;
    setDialog(true);
  };
  const closeDialog = () => {
    setDialog(false);
    opener.current?.focus();
  };
  const showRaw = () => {
    setActive("progress");
    setRawNonce((n) => n + 1);
  };
  // 원본 출력을 펼치면 그 자리로
  useEffect(() => {
    if (rawNonce > 0) document.getElementById(RAW_ID)?.scrollIntoView?.({ block: "nearest" });
  }, [rawNonce]);

  const phase = currentPhase(fx);
  return (
    <div className="wa">
      <HouseNav className="ha-nav" current="workspace" />
      <div className="wa-stage">
        {/* 뒤로 물러난 장면 — 같은 마당이 종이 뒤에 비친다 */}
        <HouseScene className="wa-backdrop" time={time} placements={[]} />
        <div className="wa-paper" data-wide={wide ? "true" : undefined} data-none={fx.projects.length === 0 ? "true" : undefined}>
          {fx.projects.length === 0 ? (
            <NoProjects onNew={openDialog} />
          ) : (
            <>
              {wide && <ProjectNavList projects={fx.projects} selectedId={fx.selectedId} onNew={openDialog} className="wa-projects" />}
              <WorkPanels
                wide={wide}
                active={active}
                onActive={setActive}
                initialCollapsed={fx.chat.length > 0 ? ["editor"] : []}
                className="wa-panels"
                tabStart={wide ? undefined : <ProjectSwitcher projects={fx.projects} selectedId={fx.selectedId} onNew={openDialog} />}
                tabExtra={<MiniWindow fx={fx} />}
                panels={[
                  {
                    id: "editor",
                    label: t("variant.ws.tab.editor"),
                    size: "minmax(0, 1fr)",
                    collapsible: true,
                    alert: fx.editor.status === "external" ? t("variant.ws.editor.external") : undefined,
                    content: (collapse) => <RequirementsEditor editor={fx.editor} onCollapse={collapse} />,
                  },
                  {
                    id: "chat",
                    label: t("variant.ws.tab.chat"),
                    badge: fx.pending,
                    size: "minmax(0, 1.25fr)",
                    content: <ChatPane fx={fx} onRaw={showRaw} />,
                  },
                  {
                    id: "progress",
                    label: t("variant.ws.tab.progress"),
                    note: phase,
                    size: "380px",
                    content: <Progress fx={fx} time={time} rawNonce={rawNonce} />,
                  },
                ]}
              />
            </>
          )}
          {dialog && <NewProjectDialog onClose={closeDialog} />}
        </div>
      </div>
    </div>
  );
}
