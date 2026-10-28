// PC 시각을 1분마다 다시 본다 — 시간대(아침 · 낮 · 저녁 · 밤)와 "n분 전" 이 이것을 따른다. 창이 다시 보이면 바로 한 번 더.
import { useEffect, useState } from "react";

const MINUTE = 60_000;

function systemClock(): Date {
  return new Date();
}

export function useClock(clock: () => Date = systemClock): Date {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const tick = () => setNow(clock());
    const id = window.setInterval(tick, MINUTE);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clock]);
  return now;
}
