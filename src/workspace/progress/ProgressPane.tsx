// 진행 탭 (D-13 · D-49) — 위에 큰 둥근 창문 + 일하는 고양이, 아래(넓으면 오른쪽)에 단계 보드 · 요약 기록 · 원본 출력(접기). 시안 a 「들여다보는 창」 + ③ 스티커 수첩.
// 단계 표를 읽을 수 없어도(D-22) 창문 · 일하는 고양이 · 기록은 그대로 — 보드만 "읽을 수 없음". 프로젝트마다 하나 (화면의 `key`).
// 일하는 고양이 · 기록 · 원본은 세션 저장소(`chat/sessionStore.ts`)에서 고르고, 단계 · 메모는 `useProgress` 가 읽는다 (보일 때만).
import { useMemo } from "react";
import type { TimeOfDay } from "../../components/house/time";
import { t } from "../../i18n/ko";
import { emptyChat } from "../chat/model";
import { selectRawLines, selectWaitingAsker, selectWorkers, useSessionStore } from "../chat/sessionStore";
import { PhaseBoard } from "./PhaseBoard";
import { ProgressLog } from "./ProgressLog";
import { RawOutput } from "./RawOutput";
import { RoomWindow } from "./RoomWindow";
import { mergeLogs } from "./boardLog";
import { windowScene } from "./placement";
import { buildSummaryLog } from "./summary";
import { useProgress } from "./useProgress";
import type { WorkerRoles } from "./workerCat";
import { recentWorkers, workingWorkers } from "./workers";
import { WorkingCats } from "./WorkingCats";
import "./progress.css";

const EMPTY_CHAT = emptyChat();

interface Props {
  projectId: number;
  /** 이 탭이 보이는 중 — 아니면 단계 · 메모를 묻지 않는다 */
  visible: boolean;
  time: TimeOfDay;
  now: Date;
  roles?: WorkerRoles;
}

export function ProgressPane({ projectId, visible, time, now, roles }: Props) {
  const { state, boardLog, reload } = useProgress(projectId, visible);
  const workers = useSessionStore(selectWorkers(projectId));
  const chat = useSessionStore((store) => store.chats[projectId]?.data ?? EMPTY_CHAT);
  const raw = useSessionStore(selectRawLines(projectId));
  const waiting = useSessionStore(selectWaitingAsker(projectId));

  const working = useMemo(() => workingWorkers(workers), [workers]);
  const recent = useMemo(() => recentWorkers(workers), [workers]);
  const scene = useMemo(() => windowScene(working, waiting, roles), [working, waiting, roles]);
  const log = useMemo(() => mergeLogs(buildSummaryLog({ chat, workers, roles }), boardLog), [chat, workers, roles, boardLog]);

  return (
    <div className="ws-pg" data-testid="progress-pane">
      <div className="ws-pg__inner">
        <div className="ws-pg__live">
          <RoomWindow scene={scene} time={time} />
          <h3 className="ws-pg__h">{t("ws.progress.workingTitle")}</h3>
          <WorkingCats working={working} waiting={waiting} recent={recent} roles={roles} nowMs={now.getTime()} />
        </div>
        <div className="ws-pg__story">
          <h3 className="ws-pg__h">{t("ws.progress.boardTitle")}</h3>
          <PhaseBoard state={state} onReload={reload} />
          <h3 className="ws-pg__h">{t("ws.progress.logTitle")}</h3>
          <ProgressLog log={log} />
          <RawOutput lines={raw} />
        </div>
      </div>
    </div>
  );
}
