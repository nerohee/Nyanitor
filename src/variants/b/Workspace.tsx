// 시안 b 「선반 위 띠」 작업 공간 — 위는 낮은 띠(고양이 한 줄 + 오른쪽 작업실), 그 아래 단계 보드, 그리고 세 칸 (design-references.md)
import { useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t } from "../../i18n/ko";
import { isWorking } from "../fixtures";
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
  workspaceAgents,
  WorkingLine,
  WorkPanels,
} from "../shared/workspace";
import "./house.css";
import "./workspace.css";

const WORK_SPOT = { wheel: "30%", tower: "74%", window: "30%" } as const;

function Strip({ fx }: { fx: WorkspaceFixture }) {
  const [open, setOpen] = useState(true);
  const agents = workspaceAgents(fx);
  const resting = agents.filter((agent) => !isWorking(agent.activity) && agent.activity !== "window");
  const working = agents.filter((agent) => isWorking(agent.activity) || agent.activity === "window");
  return (
    <section className="wb-strip" data-open={open ? "true" : undefined} aria-label={t("variant.home.cats")}>
      {open ? (
        <div className="wb-strip__scene">
          <div className="wb-strip__rest">
            {resting.map((agent, i) => (
              <Station
                key={agent.cat}
                agent={agent}
                x={`${8 + i * (84 / Math.max(resting.length - 1, 1)) - (agent.activity === "walk" ? 6 : 0)}%`}
                bottom="18px"
                range="12%"
              />
            ))}
          </div>
          <div className="wb-strip__work">
            <p className="wb-strip__label">{t("variant.room.workshop")}</p>
            {working.length === 0 && (
              <>
                <Thing name="cat-wheel" x="30%" bottom="18px" />
                <Thing name="cat-tower" x="74%" bottom="18px" />
              </>
            )}
            {working.map((agent) => (
              <Station
                key={agent.cat}
                agent={agent}
                x={WORK_SPOT[agent.activity as keyof typeof WORK_SPOT] ?? "50%"}
                bottom={agent.activity === "window" ? "42%" : "18px"}
              />
            ))}
          </div>
        </div>
      ) : (
        <ul className="wb-strip__tags">
          {agents.map((agent) => (
            <li key={agent.cat} data-working={isWorking(agent.activity) ? "true" : undefined}>
              <span className="wb-strip__face" aria-hidden="true">
                <CatFigure cat={agent.cat} crop="face" motion="still" />
              </span>
              {t(`cat.${agent.cat}.name`)}
              {isWorking(agent.activity) && <span className="status-dot" aria-hidden="true" />}
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="wb-strip__toggle hbtn hbtn--ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t("variant.ws.strip.collapse") : t("variant.ws.strip.expand")}
      </button>
    </section>
  );
}

function Progress({ fx }: { fx: WorkspaceFixture }) {
  return (
    <div className="wb-progress">
      <WorkingLine fx={fx} />
      <h3 className="wb-h">{t("variant.ws.log")}</h3>
      <ProgressLog fx={fx} />
      <RawOutput fx={fx} />
    </div>
  );
}

export function Workspace({ work }: ScreenProps) {
  const fx = workspaceFixture(work);
  const wide = useWide();
  return (
    <div className="wb">
      <HouseNav className="hb-nav" current="workspace" />
      <ProjectNavList fx={fx} className="wb-projects" />
      <div className="wb-main">
        <Strip fx={fx} />
        <PhaseBoard phases={fx.phases} className="wb-board" />
        <WorkPanels
          wide={wide}
          initial={fx.state === "empty" ? "editor" : "chat"}
          className="wb-panels"
          panels={[
            { id: "editor", label: t("variant.ws.tab.editor"), content: <RequirementsEditor fx={fx} /> },
            { id: "chat", label: t("variant.ws.tab.chat"), badge: fx.pending, content: <ChatPane fx={fx} /> },
            { id: "progress", label: t("variant.ws.tab.progress"), content: <Progress fx={fx} /> },
          ]}
        />
      </div>
    </div>
  );
}
