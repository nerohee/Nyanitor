// 「내 수정」 화면의 데이터 쪽 — 목록 · 적용 안 한 것의 차이 · 고양이 연결을 읽고, 저장 뒤 다시 읽는다. 읽는 명령은 `ipc.custom*` 뿐이다 (경로를 보내는 길은 없다).
//
// - `refresh()` 목록 + 바뀌는 것만 다시 읽는다 (쓰는 중인 편집기는 그대로). `refreshAll()` 은 거기에 `rev` 를 올려 상세 · 기록이 글을 새로 읽게 한다 (적용 · 버리기 · 되돌리기 · 통째 시작/그만 …).
// - 늦게 온 옛 읽기 결과가 새 것을 덮지 않게 번호를 매긴다.
// - 자동 저장 편집기는 자기 `flush` 를 등록한다 — 적용 · 버리기 · 다른 화면으로 가기 전에 `flushAll()` 로 쓰던 글을 먼저 저장한다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgents } from "../home/useAgents";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomChanges, CustomList } from "../lib/ipc-types";
import { errorKind } from "../workspace/errors";
import { rolesOf, type RoleMap } from "./format";

export type ListState = { status: "loading" } | { status: "failed"; kind: AppErrorKind } | { status: "ready"; list: CustomList };

/** `text` 글 칸의 자동 저장 · `values` 모델 · 수준 저장 */
export type FlushScope = "text" | "values";

export interface EditData {
  list: ListState;
  /** 적용하면 바뀌는 것 (아직 못 읽었으면 null) */
  changes: CustomChanges | null;
  /** 내 고양이 연결 (`customCatsRead` 에 적힌 것만) */
  cats: Readonly<Record<string, string>>;
  roles: RoleMap;
  /** 쓰는 중이라 아직 저장되지 않은 글이 있다 (적용 단추를 켠다 — 누르면 먼저 저장하고 적용한다) */
  unsaved: boolean;
  /** 글 칸이 "저장 안 됨" 인지 알린다 (칸마다 다른 `key`) */
  markUnsaved: (key: string, unsaved: boolean) => void;
  /** 다시 읽다가 실패했다 — 이전에 읽은 목록은 그대로 두고 띠로만 알린다 (처음 읽기 실패는 `list` 가 `failed`) */
  refreshError: AppErrorKind | null;
  clearRefreshError: () => void;
  /** 큰 바뀜 번호 — 바뀌면 상세 · 기록이 새로 읽는다 */
  rev: number;
  refresh: () => Promise<void>;
  refreshAll: () => Promise<void>;
  /** 쓰던 글과 돌고 있는 값 저장을 모두 끝낸다 (끝난 뒤에 다음 일을 한다). `"text"` 면 글만 (값 저장이 자기 안에서 부를 때) */
  flushAll: (scope?: FlushScope) => Promise<void>;
  /** 편집기 · 값 저장이 자기 "끝내기"를 등록한다 — 돌려주는 함수로 뺀다 */
  registerFlush: (flush: () => Promise<void>, scope?: FlushScope) => () => void;
}

export function useCustom(): EditData {
  const { state: agents } = useAgents();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [changes, setChanges] = useState<CustomChanges | null>(null);
  const [cats, setCats] = useState<Readonly<Record<string, string>>>({});
  const [rev, setRev] = useState(0);
  const [refreshError, setRefreshError] = useState<AppErrorKind | null>(null);
  const [unsavedKeys, setUnsavedKeys] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  const seq = useRef(0);
  /** 목록을 한 번이라도 읽었다 */
  const hasList = useRef(false);
  const flushers = useRef(new Set<{ flush: () => Promise<void>; scope: FlushScope }>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** 읽는다 — 결과는 `commit` 이 화면에 넣는다 */
  const read = useCallback(async () => {
    const mine = ++seq.current;
    const [listed, diff, catsRead] = await Promise.allSettled([ipc.customList(), ipc.customChanges(), ipc.customCatsRead()]);
    return { mine, listed, diff, catsRead };
  }, []);

  const commit = useCallback(({ mine, listed, diff, catsRead }: Awaited<ReturnType<typeof read>>) => {
    if (!alive.current || mine !== seq.current) return;
    if (listed.status === "fulfilled") {
      hasList.current = true;
      setList({ status: "ready", list: listed.value });
      setRefreshError(null);
    } else if (hasList.current) {
      // 이미 읽은 목록이 있으면 그대로 두고 띠로만 알린다 (잠깐 잠긴 것으로 화면 전체가 사라지지 않게)
      setRefreshError(errorKind(listed.reason));
    } else {
      setList({ status: "failed", kind: errorKind(listed.reason) });
    }
    setChanges(diff.status === "fulfilled" ? diff.value : null);
    // 고양이 연결을 못 읽어도 화면은 기본 연결로 그린다
    setCats(catsRead.status === "fulfilled" && catsRead.value.state === "ok" ? catsRead.value.agents : {});
  }, []);

  const refresh = useCallback(async () => {
    commit(await read());
  }, [read, commit]);

  const refreshAll = useCallback(async () => {
    await refresh();
    if (alive.current) setRev((n) => n + 1);
  }, [refresh]);

  useEffect(() => {
    void read().then(commit);
  }, [read, commit]);

  const registerFlush = useCallback((flush: () => Promise<void>, scope: FlushScope = "text") => {
    const entry = { flush, scope };
    flushers.current.add(entry);
    return () => {
      flushers.current.delete(entry);
    };
  }, []);

  const flushAll = useCallback(async (scope?: FlushScope) => {
    const wanted = [...flushers.current].filter((entry) => scope === undefined || entry.scope === scope);
    await Promise.all(wanted.map((entry) => entry.flush().catch(() => undefined)));
  }, []);

  const markUnsaved = useCallback((key: string, unsaved: boolean) => {
    setUnsavedKeys((prev) => {
      if (prev.has(key) === unsaved) return prev;
      const next = new Set(prev);
      if (unsaved) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const configured = list.status === "ready" ? list.list.roles : undefined;
  const roles = useMemo(() => rolesOf(agents.status === "ready" ? agents.list : null, configured), [agents, configured]);

  const clearRefreshError = useCallback(() => setRefreshError(null), []);

  return { list, changes, cats, roles, unsaved: unsavedKeys.size > 0, markUnsaved, refreshError, clearRefreshError, rev, refresh, refreshAll, flushAll, registerFlush };
}
