// PC 시각을 1분마다 다시 본다 — 시간대(아침 · 낮 · 저녁 · 밤)와 "n분 전" 이 이것을 따른다. 창이 다시 보이면 바로 한 번 더.
import { useEffect, useState } from "react";
import { isWindowShown, subscribeWindowShown } from "../components/useWindowShown";

const MINUTE = 60_000;

function systemClock(): Date {
  return new Date();
}

export function useClock(clock: () => Date = systemClock): Date {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const tick = () => setNow(clock());
    // 창이 숨어 있는 동안에는 1분마다 보지 않는다 — 다시 보이면 바로 한 번 보고 1분마다
    let id: number | null = null;
    const startTimer = () => {
      if (id === null) id = window.setInterval(tick, MINUTE);
    };
    const stopTimer = () => {
      if (id !== null) window.clearInterval(id);
      id = null;
    };
    if (isWindowShown()) startTimer();
    const unsubscribe = subscribeWindowShown((shown) => {
      if (shown) {
        tick();
        startTimer();
      } else stopTimer();
    });
    return () => {
      stopTimer();
      unsubscribe();
    };
  }, [clock]);
  return now;
}
