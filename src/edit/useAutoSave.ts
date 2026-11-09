// 글 한 칸의 자동 저장 — 쓰다가 1초 쉬면 저장 + Ctrl+S 바로 저장 + 떠날 때 남은 것 저장 (요구사항 편집기 `useRequirements` 와 같은 방식, 바깥 변경 확인은 없다: 이 글은 이 앱만 쓴다).
// 저장은 한 번에 하나 (돌고 있는 동안 또 부르면 끝난 뒤 이어서). 거절(`refused`)이면 이유를 들고 있다가 칸 아래에 보인다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppErrorKind, CustomWriteResult } from "../lib/ipc-types";
import { AUTOSAVE_MS } from "../workspace/useRequirements";
import { errorKind } from "../workspace/errors";
import type { RequirementsDoc } from "../workspace/useRequirements";

export type AutoSaveFailure = { kind: "error"; error: AppErrorKind } | { kind: "refused"; reason: string | null; notOurs: boolean };

export type AutoSaveStatus = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; failure: AutoSaveFailure };

export interface AutoSave {
  doc: RequirementsDoc;
  /** 고친 것이 아직 저장되지 않았다 */
  dirty: boolean;
  status: AutoSaveStatus;
  /** 마지막으로 저장된 때 (이 화면에서 저장한 적이 없으면 null) */
  savedAt: Date | null;
  onEdit: (text: string) => void;
  /** 바로 저장 (Ctrl+S · 다시 저장) */
  saveNow: () => void;
  /** 쓰던 글을 저장하고 끝날 때까지 기다린다 (적용 · 버리기 · 화면 이동 전) */
  flush: () => Promise<void>;
  getText: () => string;
}

interface Options {
  /** 저장 명령 — 글 전체를 받는다 */
  save: (text: string) => Promise<CustomWriteResult>;
  /** 저장이 끝났을 때 (파일이 실제로 바뀌었으면 `changed`) — 목록 · 바뀌는 것을 다시 읽는 데 쓴다 */
  onSaved?: (result: CustomWriteResult) => void;
}

export function useAutoSave(initial: string, { save, onSaved }: Options): AutoSave {
  const [doc] = useState<RequirementsDoc>({ text: initial, revision: 0 });
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<AutoSaveStatus>({ kind: "idle" });
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const alive = useRef(true);
  const text = useRef(initial);
  const saved = useRef(initial);
  const running = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef<number | null>(null);
  const saveRef = useRef(save);
  const onSavedRef = useRef(onSaved);
  useEffect(() => {
    saveRef.current = save;
    onSavedRef.current = onSaved;
  });

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const run = useCallback((): Promise<void> => {
    clearTimer();
    if (running.current) {
      again.current = true;
      return running.current;
    }
    const job = (async () => {
      try {
        for (;;) {
          again.current = false;
          const body = text.current;
          if (body === saved.current) break;
          if (alive.current) setStatus({ kind: "saving" });
          let result: CustomWriteResult;
          try {
            result = await saveRef.current(body);
          } catch (raw) {
            if (alive.current) setStatus({ kind: "failed", failure: { kind: "error", error: errorKind(raw) } });
            break;
          }
          if (result.outcome === "refused") {
            if (alive.current) setStatus({ kind: "failed", failure: { kind: "refused", reason: result.reason, notOurs: result.notOurs } });
            break;
          }
          saved.current = body;
          if (alive.current) {
            setSavedAt(new Date());
            setStatus({ kind: "idle" });
            if (text.current === saved.current) setDirty(false);
          }
          onSavedRef.current?.(result);
          if (text.current === saved.current) break;
          // 저장하는 동안 더 쓴 글이 있다 — 바로 저장을 눌렀거나 화면을 떠나는 중이면 곧바로, 아니면 쉬었다가
          if (again.current || !alive.current) continue;
          timer.current = window.setTimeout(() => void run(), AUTOSAVE_MS);
          break;
        }
      } finally {
        running.current = null;
      }
    })();
    running.current = job;
    return job;
  }, []);

  const onEdit = useCallback(
    (next: string) => {
      text.current = next;
      const changed = next !== saved.current;
      setDirty(changed);
      clearTimer();
      if (!changed) return;
      setStatus((prev) => (prev.kind === "saving" ? prev : { kind: "idle" }));
      timer.current = window.setTimeout(() => void run(), AUTOSAVE_MS);
    },
    [run],
  );

  const flush = useCallback(async () => {
    clearTimer();
    if (running.current) await running.current;
    if (text.current !== saved.current) await run();
  }, [run]);

  // 떠날 때 남은 것 저장 (그 뒤에는 화면 상태를 건드리지 않는다)
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimer();
      if (text.current !== saved.current) void run();
    };
  }, [run]);

  return {
    doc,
    dirty,
    status,
    savedAt,
    onEdit,
    saveNow: () => void run(),
    flush,
    getText: () => text.current,
  };
}
