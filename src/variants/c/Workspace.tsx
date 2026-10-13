// 시안 c 「다락 탑」 작업 공간 — 탑이 왼쪽 기둥(탐색 + 일하는 고양이), 오른쪽 위 단계 보드, 그 아래 편집기 | 채팅 (design-references.md)
import { t } from "../../i18n/ko";
import { workspaceFixture, type WorkspaceFixture } from "../fixtures-workspace";
import type { ScreenProps } from "../types";
import { HouseNav } from "../shared/HouseNav";
import {
  ChatPane,
  OrchestratorStatus,
  PhaseBoard,
  ProgressLog,
  ProjectNavList,
  RawOutput,
  RequirementsEditor,
  useWide,
  workspaceAgents,
  WorkingLine,
  WorkPanels,
} from "../shared/workspace";
import { Tower } from "./Tower";
import "./house.css";
import "./workspace.css";

/** 요약 로그는 채팅 아래 접는 칸 — 넓은 창에서는 펼쳐 두고, 좁은 창에서는 접어 둔다 (한 줄 요약은 늘 보임) */
function LogFold({ fx, open }: { fx: WorkspaceFixture; open: boolean }) {
  return (
    <details className="wc-log" open={open}>
      <summary>
        {t("variant.ws.log")}
        <WorkingLine fx={fx} inline />
      </summary>
      <div className="wc-log__body">
        <ProgressLog fx={fx} />
        <RawOutput fx={fx} />
      </div>
    </details>
  );
}

export function Workspace({ work }: ScreenProps) {
  const fx = workspaceFixture(work);
  const wide = useWide();
  return (
    <div className="wc">
      <div className="wc-side">
        <div className="hc-tower wc-tower">
          <Tower agents={workspaceAgents(fx)} />
        </div>
        <HouseNav className="wc-nav" current="workspace" />
      </div>

      <div className="wc-main">
        <header className="wc-head">
          <ProjectNavList fx={fx} layout="chips" className="wc-projects" />
          <OrchestratorStatus fx={fx} />
        </header>
        <PhaseBoard phases={fx.phases} className="wc-board" />
        <WorkPanels
          wide={wide}
          initial={fx.state === "empty" ? "editor" : "chat"}
          className="wc-panels"
          panels={[
            {
              id: "editor",
              label: t("variant.ws.tab.editor"),
              content: <RequirementsEditor fx={fx} initialMode="preview" />,
            },
            {
              id: "chat",
              label: t("variant.ws.tab.chat"),
              badge: fx.pending,
              content: <ChatPane fx={fx} showStatus={false} below={<LogFold fx={fx} open={wide} />} />,
            },
          ]}
        />
      </div>
    </div>
  );
}
