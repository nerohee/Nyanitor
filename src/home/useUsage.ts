// 사용량 한도 읽기 — 처음 한 번, "다시 읽기", 화면이 다시 보일 때 5분 지났으면 다시. 못 받아도 앱은 그대로 (D-24).
// 잠깐 못 받으면(시간 초과 · 실패 · 빈 응답) 마지막 숫자를 남기고 "갱신 실패" 만 붙인다 (2026-10-29 고객, 댓글 제안).
import { useCallback, useEffect, useRef, useState } from "react";
import { subscribeWindowShown } from "../components/useWindowShown";
import { ipc } from "../lib/ipc";
import type { UsageResult } from "../lib/ipc-types";

/** 화면이 다시 보였을 때 이 시간이 지났으면 다시 읽는다 */
export const USAGE_STALE_MS = 5 * 60_000;

export interface UsageState {
  /** 아직 한 번도 못 읽었으면 null (처음 읽는 중) */
  result: UsageResult | null;
  /** 읽는 중 — 이전 값이 있으면 그대로 두고 조용한 표시만 */
  reading: boolean;
  /** 마지막 읽기가 잠깐 실패해서 `result` 가 그 전에 읽은 숫자다 */
  stale: boolean;
}

/** 막대를 그릴 숫자가 있는 결과 */
function hasNumbers(result: UsageResult | null): boolean {
  return result?.state === "ok" && (result.fiveHour !== null || result.sevenDay !== null);
}

/** 다시 읽으면 될 수도 있는 실패 — 로그인 · 구독 · 설치처럼 분명한 이유는 아니다 */
function isTransient(result: UsageResult): boolean {
  return result.state === "unavailable" ? result.reason === "timeout" || result.reason === "failed" : !hasNumbers(result);
}

export function useUsage(): UsageState & { refresh: () => void } {
  const [state, setState] = useState<UsageState>({ result: null, reading: true, stale: false });
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
      if (!alive.current) return;
      setState((s) =>
        isTransient(result) && hasNumbers(s.result)
          ? { result: s.result, reading: false, stale: true }
          : { result, reading: false, stale: false },
      );
    };
    // 명령이 실패해도(앱 오류) 화면은 "읽지 못함" 상태로 — 앱이 죽지 않는다
    ipc.usageRead().then(done, () => done({ state: "unavailable", reason: "failed" }));
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const unsubscribe = subscribeWindowShown((shown) => {
      if (shown && Date.now() - lastRead.current >= USAGE_STALE_MS) load();
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [load]);

  return { ...state, refresh: load };
}
