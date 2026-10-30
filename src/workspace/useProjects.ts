// 등록된 프로젝트 목록 읽기 (고양이 집 판 · 작업 공간이 같이 쓴다). 실패는 던지지 않고 화면 상태로 — 언마운트 뒤에는 갱신하지 않는다.
// 다시 읽는 동안에는 지금 목록을 그대로 둔다 (깜빡이지 않게).
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, ProjectDbMode, ProjectEntry } from "../lib/ipc-types";
import { errorKind } from "./errors";

export type ProjectsState =
  | { status: "loading" }
  | { status: "failed"; kind: AppErrorKind }
  | { status: "ready"; db: ProjectDbMode; projects: ProjectEntry[] };

async function fetchState(): Promise<ProjectsState> {
  try {
    const list = await ipc.projectsList();
    return { status: "ready", db: list.db, projects: list.projects };
  } catch (raw) {
    return { status: "failed", kind: errorKind(raw) };
  }
}

export function useProjects(): { state: ProjectsState; reload: () => Promise<void> } {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });
  const alive = useRef(true);
  const latest = useRef(0);

  /** 다시 읽기 — 더 늦게 시작한 읽기가 있으면 이 결과는 버린다 */
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    const next = await fetchState();
    if (alive.current && mine === latest.current) setState(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    const mine = ++latest.current;
    void fetchState().then((next) => {
      if (alive.current && mine === latest.current) setState(next);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  return { state, reload };
}
