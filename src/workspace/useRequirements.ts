// 요구사항(requirements.md) 읽기 · 자동 저장 · 바깥 변경 확인 — 편집기 화면의 데이터 쪽. 프로젝트마다 하나 (프로젝트가 바뀌면 화면이 새로 만든다 — `key`).
//
// 지키는 약속: **말없이 덮어쓰지 않는다.**
//   - 저장은 `baseVersion`(마지막으로 읽거나 쓴 `version`)과 함께 — 파일이 그사이 바뀌었으면 Rust 가 쓰지 않고 `conflict` 를 돌려준다.
//   - 바깥에서 바뀌었는데 내가 안 고쳤으면 조용히 새로 읽는다 (한 줄 알림). 고친 것이 있으면 저장하지 않고 충돌 띠 — 고객이 고른다.
//   - 없던 파일의 첫 저장은 `baseVersion: null`.
// 저장은 한 번에 하나만 (돌고 있는 동안 또 부르면 끝난 뒤 이어서). 언마운트(프로젝트 · 화면 바꿈) 때 남은 것을 저장하고, 그 뒤에는 화면 상태를 건드리지 않는다.
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, RequirementsProblem, RequirementsRead } from "../lib/ipc-types";
import { errorKind } from "./errors";

/** 쓰다가 이만큼 쉬면 자동 저장 (시제품과 같다) */
export const AUTOSAVE_MS = 1000;
/** 창이 보이는 동안 이만큼마다 바깥 변경을 본다 (싼 `version` 만 부른다) */
export const CHECK_MS = 5000;
/** "새로 읽었어요" 알림이 떠 있는 시간 */
const NOTICE_MS = 8000;

export type LoadState =
  | { kind: "loading" }
  /** 읽는 명령 자체가 실패 (DB · 프로젝트 없음 등) */
  | { kind: "error"; error: AppErrorKind }
  /** 파일이 있지만 읽을 수 없다 — 편집 못 함 */
  | { kind: "unreadable"; reason: RequirementsProblem }
  /** `absent`: 파일이 아직 없다 (쓰면 만들어진다) */
  | { kind: "ready"; absent: boolean };

export type SaveFailure = { kind: "error"; error: AppErrorKind } | { kind: "refused"; reason: RequirementsProblem };

/** 저장 표시의 바탕 */
export type SaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; failure: SaveFailure };

/** 바깥에서 바뀐 파일의 지금 `version` (파일이 없어졌으면 null) */
export interface Conflict {
  version: string | null;
}

/** 편집기가 그리는 글. `revision` 이 바뀔 때만 편집기가 글을 통째로 바꾼다 (쓰는 중에는 건드리지 않는다) */
export interface RequirementsDoc {
  text: string;
  revision: number;
}

export interface RequirementsApi {
  load: LoadState;
  doc: RequirementsDoc;
  /** 고친 것이 아직 저장되지 않았다 */
  dirty: boolean;
  status: SaveStatus;
  /** 마지막으로 저장된 때 (이 화면에서 저장한 적이 없으면 null) */
  savedAt: Date | null;
  conflict: Conflict | null;
  /** 조용히 새로 읽었다는 알림 */
  notice: boolean;
  dismissNotice: () => void;
  /** 편집기가 글이 바뀔 때마다 부른다 */
  onEdit: (text: string) => void;
  /** 바로 저장 (Ctrl+S · 다시 저장) */
  saveNow: () => void;
  /** 충돌 띠 "여기서 쓴 글 남기기" */
  overwrite: () => void;
  /** 충돌 띠 "바깥에서 고친 글로 바꾸기" (여기서 쓴 글은 사라짐) */
  takeOutside: () => void;
  /** 못 읽었을 때 "다시 읽기" */
  reload: () => void;
  /** 편집기의 글 가져오기 (미리보기 · 시험) */
  getText: () => string;
}

interface Options {
  /** 한글 조합 중에는 글을 바꾸는 일(새로 읽기)을 미룬다 */
  isComposing: MutableRefObject<() => boolean>;
}

export function useRequirements(projectId: number, { isComposing }: Options): RequirementsApi {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [doc, setDoc] = useState<RequirementsDoc>({ text: "", revision: 0 });
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [conflict, setConflictState] = useState<Conflict | null>(null);
  const [notice, setNotice] = useState(false);

  const alive = useRef(true);
  /** 마지막으로 읽거나 쓴 `version` (없는 파일은 null) */
  const base = useRef<string | null>(null);
  /** 디스크에 있다고 아는 글 */
  const saved = useRef("");
  /** 편집기의 지금 글 */
  const text = useRef("");
  const editable = useRef(false);
  const inflight = useRef(false);
  const again = useRef(false);
  const timer = useRef<number | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const conflictRef = useRef<Conflict | null>(null);

  const setConflict = useCallback((next: Conflict | null) => {
    conflictRef.current = next;
    if (alive.current) setConflictState(next);
  }, []);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  /** 읽은 결과를 화면에 반영 (내 글을 버리고 디스크 것으로) */
  const apply = useCallback(
    (result: RequirementsRead) => {
      if (!alive.current) return;
      clearTimer();
      setConflict(null);
      setStatus({ kind: "idle" });
      if (result.state === "unreadable") {
        editable.current = false;
        setLoad({ kind: "unreadable", reason: result.reason });
        return;
      }
      const next = result.state === "ok" ? result.text : "";
      editable.current = true;
      base.current = result.state === "ok" ? result.version : null;
      saved.current = next;
      text.current = next;
      setDirty(false);
      setLoad({ kind: "ready", absent: result.state === "absent" });
      setDoc((prev) => ({ text: next, revision: prev.revision + 1 }));
    },
    [setConflict],
  );

  /** 처음 읽기 · "다시 읽기" */
  const read = useCallback(() => {
    ipc.projectRequirementsRead(projectId).then(
      (result) => apply(result),
      (raw) => {
        if (alive.current) setLoad({ kind: "error", error: errorKind(raw) });
      },
    );
  }, [apply, projectId]);

  const reload = useCallback(() => {
    setLoad({ kind: "loading" });
    read();
  }, [read]);

  /** 저장 — 한 번에 하나. `force` 는 충돌 띠에서 "여기서 쓴 글 남기기" */
  const save = useCallback(
    async (force = false) => {
      clearTimer();
      if (!editable.current) return;
      if (inflight.current) {
        again.current = true;
        return;
      }
      if (conflictRef.current && !force) return;
      inflight.current = true;
      try {
        for (;;) {
          again.current = false;
          const body = text.current;
          if (body === saved.current) break;
          if (alive.current) setStatus({ kind: "saving" });
          let result;
          try {
            result = await ipc.projectRequirementsWrite(projectId, body, base.current);
          } catch (raw) {
            if (alive.current) setStatus({ kind: "failed", failure: { kind: "error", error: errorKind(raw) } });
            break;
          }
          if (result.state === "conflict") {
            setConflict({ version: result.version });
            if (alive.current) setStatus({ kind: "idle" });
            break;
          }
          if (result.state === "refused") {
            if (alive.current) setStatus({ kind: "failed", failure: { kind: "refused", reason: result.reason } });
            break;
          }
          base.current = result.version;
          saved.current = body;
          if (alive.current) {
            setSavedAt(new Date());
            setStatus({ kind: "idle" });
          }
          if (text.current === saved.current) {
            if (alive.current) setDirty(false);
            break;
          }
          // 저장하는 동안 더 쓴 글이 있다 — 쓰는 중이면 쉬었다가, 바로 저장을 눌렀거나 화면을 떠났으면 곧바로
          if (again.current || !alive.current) continue;
          timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
          break;
        }
      } finally {
        inflight.current = false;
      }
    },
    [projectId, setConflict],
  );

  const onEdit = useCallback(
    (next: string) => {
      text.current = next;
      const changed = next !== saved.current;
      setDirty(changed);
      if (!changed) {
        clearTimer();
        return;
      }
      if (conflictRef.current) return;
      setStatus((prev) => (prev.kind === "saving" ? prev : { kind: "idle" }));
      clearTimer();
      timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
    },
    [save],
  );

  const showNotice = () => {
    if (!alive.current) return;
    setNotice(true);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(false), NOTICE_MS);
  };

  /** 바깥 변경 확인 — 파일이 그사이 바뀌었나 */
  const check = useCallback(async () => {
    if (!editable.current || inflight.current || isComposing.current()) return;
    let result;
    try {
      result = await ipc.projectRequirementsVersion(projectId);
    } catch {
      return; // 확인은 조용히 — 다음에 다시
    }
    if (!alive.current || inflight.current || isComposing.current()) return;
    const changed =
      result.state === "ok" ? result.version !== base.current : result.state === "absent" ? base.current !== null : true;
    if (!changed || conflictRef.current) return;
    const outside: Conflict = { version: result.state === "ok" ? result.version : null };
    if (text.current !== saved.current) {
      setConflict(outside);
      return;
    }
    // 고친 것이 없다 — 조용히 새로 읽는다
    let read: RequirementsRead;
    try {
      read = await ipc.projectRequirementsRead(projectId);
    } catch {
      return;
    }
    if (!alive.current || inflight.current || isComposing.current()) return;
    if (text.current !== saved.current) {
      // 읽는 사이에 쓰기 시작했다 — 덮지 않고 띠로
      setConflict({ version: read.state === "ok" ? read.version : null });
      return;
    }
    apply(read);
    showNotice();
  }, [apply, isComposing, projectId, setConflict]);

  // 처음 읽기 + 떠날 때 남은 것 저장
  useEffect(() => {
    alive.current = true;
    read();
    return () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      if (editable.current && !conflictRef.current && text.current !== saved.current) void save();
    };
    // 프로젝트마다 새로 만든다 (화면의 key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 창을 닫거나 숨길 때 남은 것 저장, 창이 다시 보일 때 · 몇 초마다(보이는 동안만) 바깥 변경 확인
  const ready = load.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const flush = () => {
      if (!conflictRef.current && text.current !== saved.current) void save();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
      else void check();
    };
    const onFocus = () => void check();
    const tick = () => {
      if (document.visibilityState === "visible") void check();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    const id = window.setInterval(tick, CHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(id);
    };
  }, [ready, check, save]);

  const overwrite = useCallback(() => {
    const current = conflictRef.current;
    if (!current) return;
    base.current = current.version;
    setConflict(null);
    void save(true);
  }, [save, setConflict]);

  const takeOutside = useCallback(() => {
    ipc.projectRequirementsRead(projectId).then(
      (result) => apply(result),
      (raw) => {
        if (alive.current) setStatus({ kind: "failed", failure: { kind: "error", error: errorKind(raw) } });
      },
    );
  }, [apply, projectId]);

  return {
    load,
    doc,
    dirty,
    status,
    savedAt,
    conflict,
    notice,
    dismissNotice: () => setNotice(false),
    onEdit,
    saveNow: () => void save(),
    overwrite,
    takeOutside,
    reload,
    getText: () => text.current,
  };
}
