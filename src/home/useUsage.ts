// 사용량 한도 읽기 — 처음 한 번, "다시 읽기", 화면이 다시 보일 때 5분 지났으면 다시. 못 받아도 앱은 그대로 (D-24).
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { UsageResult } from "../lib/ipc-types";

/** 화면이 다시 보였을 때 이 시간이 지났으면 다시 읽는다 */
export const USAGE_STALE_MS = 5 * 60_000;

export interface UsageState {
  /** 아직 한 번도 못 읽었으면 null (처음 읽는 중) */
  result: UsageResult | null;
  /** 읽는 중 — 이전 값이 있으면 그대로 두고 조용한 표시만 */
  reading: boolean;
}

export function useUsage(): UsageState & { refresh: () => void } {
  const [state, setState] = useState<UsageState>({ result: null, reading: true });
  const alive = useRef(true);
  const reading = useRef(false);
  const lastRead = useRef(0);

  const load = useCallback(() => {
    if (reading.current) return;
    reading.current = true;
    setState((s) => ({ ...s, reading: true }));
    const done = (result: UsageResult) => {
      reading.current = false;
      lastRead.current = Date.now();
      if (alive.current) setState({ result, reading: false });
    };
    // 명령이 실패해도(앱 오류) 화면은 "읽지 못함" 상태로 — 앱이 죽지 않는다
    ipc.usageRead().then(done, () => done({ state: "unavailable", reason: "failed" }));
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastRead.current >= USAGE_STALE_MS) load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { ...state, refresh: load };
}
