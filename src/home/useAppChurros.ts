// 오늘 앱이 쓴 세션 츄르 — 집이 보일 때 한 번, 보이는 동안 턴이 끝나 세션 저장소가 츄르를 새로 읽으면 다시 (D-24 · D-48).
// 못 읽으면 지난 숫자를 그대로 두고, 한 번도 못 읽었으면 null (줄을 감춘다 — 앱 기능에는 영향 없다).
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import { useSessionStore } from "../workspace/chat/sessionStore";

export interface AppChurros {
  /** 오늘 앱이 돌린 턴 수 (0 이면 "아직 없음") */
  turns: number;
  /** 토큰 4종의 합 — 츄르 "약 n" */
  totalTokens: number;
}

export function useAppChurros(): AppChurros | null {
  const [churros, setChurros] = useState<AppChurros | null>(null);

  useEffect(() => {
    let alive = true;
    let seq = 0;
    const read = () => {
      const mine = ++seq;
      ipc.appUsageSummary().then(
        (summary) => {
          if (alive && mine === seq) setChurros({ turns: summary.today.turns, totalTokens: summary.today.totalTokens });
        },
        () => undefined, // 못 읽으면 지난 숫자 그대로
      );
    };
    read();
    // 세션 저장소가 턴이 끝날 때 츄르를 새로 읽으면 `churros` 가 바뀐다 — 같은 신호로 다시 읽는다
    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      if (state.churros !== previous.churros) read();
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  return churros;
}
