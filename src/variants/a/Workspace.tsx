// 시안 a 「들여다보는 창」 작업 공간 — 장면이 종이 뒤로 물러나고, 진행 보기 맨 위 둥근 창문 안에 일하는 고양이 (design-references.md)
// 창문은 집 화면과 같은 장면을 잘라 보는 것 — 일하는 고양이가 있는 곳(캣휠 · 캣타워 · 댓돌)이 가운데에 온다.
import { CatFigure } from "../../components/cat/CatFigure";
import { HouseScene, type Crop } from "../../components/house/HouseScene";
import { staticPlacements, type CatPlacement, type Intents } from "../../components/house/schedule";
import { SPOTS, STAGE, type Activity } from "../../components/house/spots";
import { CAT_IDS, type CatId } from "../../components/cat/catalog";
import { t } from "../../i18n/ko";
import { workspaceFixture, type WorkspaceFixture } from "../fixtures-workspace";
import type { ScreenProps } from "../types";
import type { TimeOfDay } from "../query";
import { HouseNav } from "../shared/HouseNav";
import {
  ChatPane,
  PhaseBoard,
  ProgressLog,
  ProjectNavList,
  RawOutput,
  RequirementsEditor,
  useWide,
  WorkingLine,
  WorkPanels,
} from "../shared/workspace";
import "./house.css";
import "./workspace.css";

/** 창문에 보이는 배경 영역의 크기 (4 : 3 — 창문 모양과 같다) */
const WINDOW_VIEW = { w: 620, h: 465 } as const;

/** 일하는 자리 → 고양이의 의도 */
function intentOf(activity: Activity) {
  if (activity === "wheel") return "making" as const;
  if (activity === "towerTop" || activity === "towerMid") return "watching" as const;
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
  const first = fx.working[0];
  return (
    <span className="wa-mini" aria-hidden="true">
      {first && <CatFigure cat={first.cat} crop="face" />}
    </span>
  );
}

function Progress({ fx, time }: { fx: WorkspaceFixture; time: TimeOfDay }) {
  return (
    <div className="wa-progress">
      <RoomWindow fx={fx} time={time} />
      <WorkingLine fx={fx} />
      <h3 className="wa-h">{t("variant.ws.board")}</h3>
      <PhaseBoard phases={fx.phases} />
      <h3 className="wa-h">{t("variant.ws.log")}</h3>
      <ProgressLog fx={fx} />
      <RawOutput fx={fx} />
    </div>
  );
}

export function Workspace({ work, time }: ScreenProps) {
  const fx = workspaceFixture(work);
  const wide = useWide();
  return (
    <div className="wa">
      <HouseNav className="ha-nav" current="workspace" />
      <div className="wa-stage">
        {/* 뒤로 물러난 장면 — 같은 마당이 종이 뒤에 비친다 */}
        <HouseScene className="wa-backdrop" time={time} placements={[]} />
        <div className="wa-paper">
          <ProjectNavList fx={fx} className="wa-projects" />
          <WorkPanels
            wide={wide}
            initial={fx.pending > 0 ? "chat" : fx.state === "empty" ? "editor" : "chat"}
            className="wa-panels"
            tabExtra={<MiniWindow fx={fx} />}
            panels={[
              { id: "editor", label: t("variant.ws.tab.editor"), content: <RequirementsEditor fx={fx} /> },
              { id: "chat", label: t("variant.ws.tab.chat"), badge: fx.pending, content: <ChatPane fx={fx} /> },
              { id: "progress", label: t("variant.ws.tab.progress"), content: <Progress fx={fx} time={time} /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
