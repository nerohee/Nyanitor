// 지난 시간 표기 — 1분 안은 "방금", 59분까지는 분, 60분부터는 시간 (P7 써 보기, 고객). 집 화면 "n분 전" 과 같은 단위.
import { t, tf } from "../../i18n/ko";

const MINUTE = 60_000;

/** 일한 지 — "방금 시작했어요" · "n분째" · "n시간째" */
export function workedText(startedAtMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - startedAtMs) / MINUTE);
  if (minutes < 1) return t("ws.progress.justNow");
  if (minutes < 60) return tf("ws.progress.minutes", { n: minutes });
  return tf("ws.progress.hours", { n: Math.floor(minutes / 60) });
}

/** 끝난 지 — "방금" · "n분 전" · "n시간 전" */
export function agoText(atMs: number, nowMs: number): string {
  const minutes = Math.floor((nowMs - atMs) / MINUTE);
  if (minutes < 1) return t("ws.progress.agoNow");
  if (minutes < 60) return tf("ws.progress.agoMinutes", { n: minutes });
  return tf("ws.progress.agoHours", { n: Math.floor(minutes / 60) });
}
