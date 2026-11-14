// 프로젝트 문서(`docs/` 의 .md) 읽기 — 읽기 전용 (D-49). 탭이 보일 때 목록을 읽고 몇 초마다 다시 읽는다. 연 문서의 `modified` 가 바뀌면 그 문서를 다시 읽는다.
// 프로젝트마다 하나 (프로젝트가 바뀌면 화면이 새로 만든다 — `key`). 목록 · 문서를 읽는 사이 다른 요청이 끼면 늦게 온 것은 버린다.
import { useCallback, useEffect, useRef, useState } from "react";
import { isWindowShown, subscribeWindowShown } from "../../components/useWindowShown";
import { ipc } from "../../lib/ipc";
import type { AppErrorKind, DocFile, DocsListing, RequirementsProblem } from "../../lib/ipc-types";
import { errorKind } from "../errors";

/** 보이는 동안 이만큼마다 목록을 다시 읽는다 */
export const DOCS_CHECK_MS = 5000;

export type DocsListState =
  | { kind: "loading" }
  | { kind: "error"; error: AppErrorKind }
  /** docs 폴더가 없다 */
  | { kind: "absent" }
  | { kind: "unreadable"; reason: RequirementsProblem }
  | { kind: "ready"; listing: DocsListing };

export type DocState =
  | { kind: "loading" }
  | { kind: "error"; error: AppErrorKind }
  /** 문서가 사라졌다 (열려 있던 것이 목록에서 빠졌거나 읽어 보니 없음) */
  | { kind: "gone" }
  | { kind: "unreadable"; reason: RequirementsProblem }
  | { kind: "ready"; text: string };

export interface DocsApi {
  list: DocsListState;
  /** 연 문서의 경로 (없으면 null) */
  path: string | null;
  doc: DocState | null;
  /** 연 문서의 수정 시각 (유닉스 초, 모르면 null) */
  modified: number | null;
  open: (path: string) => void;
  /** 목록을 처음부터 다시 읽기 (다시 읽기 단추) */
  reload: () => void;
}

export function useDocs(projectId: number, visible: boolean): DocsApi {
  const [list, setList] = useState<DocsListState>({ kind: "loading" });
  const [path, setPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocState | null>(null);
  const [modified, setModified] = useState<number | null>(null);

  const alive = useRef(true);
  const listing = useRef<DocsListing | null>(null);
  const busy = useRef(false);
  /** 열린 문서 — 요청 번호로 늦게 온 답을 버린다 */
  const opened = useRef<{ path: string | null; modified: number | null; token: number; gone: boolean }>({ path: null, modified: null, token: 0, gone: false });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readDoc = useCallback(
    async (target: string, at: number | null, quiet: boolean) => {
      const mine = ++opened.current.token;
      opened.current.path = target;
      opened.current.modified = at;
      opened.current.gone = false;
      try {
        const result = await ipc.projectDocRead(projectId, target);
        if (!alive.current || mine !== opened.current.token) return;
        if (result.state === "ok") setDoc({ kind: "ready", text: result.text });
        else if (result.state === "absent") {
          opened.current.gone = true;
          setDoc({ kind: "gone" });
        } else setDoc({ kind: "unreadable", reason: result.reason });
      } catch (raw) {
        if (!alive.current || mine !== opened.current.token) return;
        // 이미 보이는 글이 있으면 조용히 그대로 (다음에 다시) — 처음 읽기면 오류를 보인다
        if (!quiet) setDoc({ kind: "error", error: errorKind(raw) });
        else opened.current.modified = null; // 다음 목록 읽기에서 다시 시도
      }
    },
    [projectId],
  );

  /** 목록을 읽고, 열린 문서가 바뀌었는지 본다 */
  const readList = useCallback(async () => {
    try {
      const result = await ipc.projectDocsList(projectId);
      if (!alive.current) return;
      if (result.state === "absent") {
        listing.current = null;
        setList({ kind: "absent" });
        return;
      }
      if (result.state === "unreadable") {
        listing.current = null;
        setList({ kind: "unreadable", reason: result.reason });
        return;
      }
      const next: DocsListing = { docsDir: result.docsDir, files: result.files, truncated: result.truncated };
      listing.current = next;
      setList({ kind: "ready", listing: next });
      const current = opened.current;
      if (current.path === null) return;
      const file: DocFile | undefined = next.files.find((candidate) => candidate.path === current.path);
      if (!file) {
        if (!current.gone) {
          current.gone = true;
          current.token += 1;
          setDoc({ kind: "gone" });
          setModified(null);
        }
      } else if (current.gone || file.modified !== current.modified) {
        setModified(file.modified);
        void readDoc(current.path, file.modified, true);
      }
    } catch (raw) {
      // 처음부터 못 읽었으면 오류를 보인다 — 이미 읽은 목록이 있으면 그대로 두고 다음에 다시
      if (alive.current && listing.current === null) setList({ kind: "error", error: errorKind(raw) });
    }
  }, [projectId, readDoc]);

  /** 목록 확인 — 읽는 중이면 건너뛴다 */
  const poll = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await readList();
    } finally {
      busy.current = false;
    }
  }, [readList]);

  useEffect(() => {
    if (!visible) return;
    void poll();
    const onFocus = () => void poll();
    const tick = () => {
      if (isWindowShown()) void poll();
    };
    window.addEventListener("focus", onFocus);
    const unsubscribe = subscribeWindowShown((shown) => {
      if (shown) void poll();
    });
    const id = window.setInterval(tick, DOCS_CHECK_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      unsubscribe();
      window.clearInterval(id);
    };
  }, [visible, poll]);

  const open = useCallback(
    (target: string) => {
      const file = listing.current?.files.find((candidate) => candidate.path === target);
      setPath(target);
      setModified(file?.modified ?? null);
      setDoc({ kind: "loading" });
      void readDoc(target, file?.modified ?? null, false);
    },
    [readDoc],
  );

  const reload = useCallback(() => {
    setList({ kind: "loading" });
    void poll();
  }, [poll]);

  return { list, path, doc, modified, open, reload };
}
