// 고양이 집 시간대 — 아침 05–10시 · 낮 10–17시 · 저녁 17–20시 · 밤 20–05시 (tokens.css 의 `[data-time]` 과 같음)

export const TIMES = ["morning", "day", "evening", "night"] as const;
export type TimeOfDay = (typeof TIMES)[number];

export function timeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}
