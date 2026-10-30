// 사용량 카드의 사람 말 — 사용률 · 초기화 시각 · "n분 전". 문구는 ko.ts.
import { t, tf } from "../i18n/ko";

/** 0~1 사용률 → 화면의 % (100% 를 넘기면 그대로 넘긴다) */
export function percentOf(utilization: number): number {
  return Math.max(0, Math.round(utilization * 100));
}

/** 막대 · meter 에는 0~100 안으로 */
export function barPercent(utilization: number): number {
  return Math.min(100, percentOf(utilization));
}

function timeText(date: Date): string {
  const hour = date.getHours();
  return tf("home.when.time", {
    ampm: t(hour < 12 ? "home.when.am" : "home.when.pm"),
    hour: hour % 12 === 0 ? 12 : hour % 12,
    minute: String(date.getMinutes()).padStart(2, "0"),
  });
}

function dayStart(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 초기화 시각(유닉스 초) → "오늘 오후 3:30" · "내일 오전 9:00" · "11월 2일 오후 3:30". 이미 지났으면 "곧". */
export function formatReset(resetsAt: number, now: Date): string {
  const at = new Date(resetsAt * 1000);
  if (at.getTime() <= now.getTime()) return t("home.when.soon");
  const dayDiff = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  const time = timeText(at);
  if (dayDiff <= 0) return tf("home.when.todayAt", { time });
  if (dayDiff === 1) return tf("home.when.tomorrowAt", { time });
  return tf("home.when.dateAt", { month: at.getMonth() + 1, day: at.getDate(), time });
}

/** 읽은 때(유닉스 초) → "방금" · "5분 전" · "2시간 전" · "3일 전" */
export function formatAgo(readAt: number, now: Date): string {
  const minutes = Math.floor((now.getTime() / 1000 - readAt) / 60);
  if (minutes < 1) return t("home.ago.now");
  if (minutes < 60) return tf("home.ago.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return tf("home.ago.hours", { n: hours });
  return tf("home.ago.days", { n: Math.floor(hours / 24) });
}

/** 토큰 수 → 세 자리마다 쉼표 (시제품 `variants/fixtures.ts` 의 `formatTokens` 와 같은 꼴) */
export function formatTokens(n: number): string {
  return n.toLocaleString("ko-KR");
}
