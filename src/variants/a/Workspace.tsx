// 시안 a 「들여다보는 창」 작업 공간 — 장면이 종이 뒤로 물러나고, 진행 보기 맨 위 둥근 창문 안에 일하는 고양이 (design-references.md)
import { CatFigure } from "../../components/cat/CatFigure";
import { t } from "../../i18n/ko";
import { workspaceFixture, type WorkspaceFixture } from "../fixtures-workspace";
import type { ScreenProps } from "../types";
import { HouseNav } from "../shared/HouseNav";
import { Station, Thing } from "../shared/scene";
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

const SPOT = {
  wheel: { x: "34%", bottom: "9%" },
  tower: { x: "70%", bottom: "9%" },
  window: { x: "34%", bottom: "38%" },
} as const;

/** 둥근 창문 — 같은 방이 작게 보이고, 일하는 고양이가 캣휠 · 캣타워에 */
function RoomWindow({ fx }: { fx: WorkspaceFixture }) {
  return (
    <div className="wa-window" role="img" aria-label={t("variant.ws.window")}>
      <div className="wa-window__room">
        <div className="wa-window__floor" />
        {fx.working.length === 0 && <Thing name="cushion" x="50%" bottom="10%" />}
        {fx.working.map((w) => {
          const spot = SPOT[w.activity as keyof typeof SPOT];
          return spot ? <Station key={w.cat} agent={w} x={spot.x} bottom={spot.bottom} /> : null;
        })}
      </div>
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

function Progress({ fx }: { fx: WorkspaceFixture }) {
  return (
    <div className="wa-progress">
      <RoomWindow fx={fx} />
      <WorkingLine fx={fx} />
      <h3 className="wa-h">{t("variant.ws.board")}</h3>
      <PhaseBoard phases={fx.phases} />
      <h3 className="wa-h">{t("variant.ws.log")}</h3>
      <ProgressLog fx={fx} />
      <RawOutput fx={fx} />
    </div>
  );
}

export function Workspace({ work }: ScreenProps) {
  const fx = workspaceFixture(work);
  const wide = useWide();
  return (
    <div className="wa">
      <HouseNav className="ha-nav" current="workspace" />
      <div className="wa-stage">
        <div className="wa-backdrop" aria-hidden="true" />
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
              { id: "progress", label: t("variant.ws.tab.progress"), content: <Progress fx={fx} /> },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
