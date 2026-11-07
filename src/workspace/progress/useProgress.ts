// 진행(단계 표 + 이어 하기 메모) 읽기 — 진행 탭이 보이고 창이 보일 때만 몇 초마다 싼 `version` 을 묻고, 달라졌을 때만 다시 읽는다 (D-49).
// 탭을 열 때 · 창 포커스 때 바로 묻는다. 프로젝트마다 하나 (프로젝트가 바뀌면 화면이 새로 만든다 — `key`).
// 읽기 실패(`error`)와 형식을 못 읽음(결과 안의 `unreadable`)은 다르다 — 앞은 이 훅의 상태, 뒤는 `read.plan` · `read.handoff` 에 있다.
// 앱이 켜져 있는 동안 보드가 바뀌면 요약 로그에 보탤 줄(`boardLog`)도 만든다 (메모리만, 처음 읽은 것에서는 만들지 않는다).
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { AppErrorKind, ProgressRead } from "../../lib/ipc-types";
import { errorKind } from "../errors";
import { boardChanges } from "./boardLog";
import type { LogItem } from "./summary";

/** 보이는 동안 이만큼마다 바뀌었는지 묻는다 */
export const PROGRESS_CHECK_MS = 3000;

export type ProgressState =
  | { kind: "loading" }
  /** 읽는 명령 자체가 실패 (DB · 프로젝트 없음 등) */
  | { kind: "error"; error: AppErrorKind }
  | { kind: "ready"; read: ProgressRead };

export interface ProgressApi {
  state: ProgressState;
  /** 보드가 바뀌어 생긴 로그 줄 (시간순, 이 화면이 열린 뒤 것만) */
  boardLog: LogItem[];
  /** 지금 바로 다시 읽기 (다시 읽기 단추) */
  reload: () => void;
}

export function useProgress(projectId: number, visible: boolean): ProgressApi {
  const [state, setState] = useState<ProgressState>({ kind: "loading" });
  const [boardLog, setBoardLog] = useState<LogItem[]>([]);
  const alive = useRef(true);
  const last = useRef<ProgressRead | null>(null);
  const reading = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const result = await ipc.projectProgressRead(projectId);
      if (!alive.current) return;
      const added = boardChanges(last.current, result, Date.now());
      last.current = result;
      if (added.length > 0) setBoardLog((log) => [...log, ...added]);
      setState({ kind: "ready", read: result });
    } catch (raw) {
      // 이미 읽은 것이 있으면 그대로 두고 다음에 다시 — 처음부터 못 읽었으면 오류를 보인다
      if (alive.current && last.current === null) setState({ kind: "error", error: errorKind(raw) });
    } finally {
      reading.current = false;
    }
  }, [projectId]);

  /** 바뀌었나 — 읽은 것이 없으면 바로 읽고, 있으면 싼 `version` 만 물어 달라졌을 때만 읽는다 */
  const check = useCallback(async () => {
    const have = last.current;
    if (have === null) {
      await read();
      return;
    }
    let version: string;
    try {
      version = await ipc.projectProgressVersion(projectId);
    } catch {
      return; // 확인은 조용히 — 다음에 다시
    }
    if (!alive.current || version === last.current?.version) return;
    await read();
  }, [projectId, read]);

  useEffect(() => {
    if (!visible) return;
    void check();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onFocus = () => void check();
    const tick = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const id = window.setInterval(tick, PROGRESS_CHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(id);
    };
  }, [visible, check]);

  const reload = useCallback(() => {
    if (last.current === null) setState({ kind: "loading" });
    void read();
  }, [read]);

  return { state, boardLog, reload };
}
