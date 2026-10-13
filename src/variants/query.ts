// 시안 틀이 읽는 주소 쿼리: ?variant=a|b|c &screen=house|workspace|cats &time=morning|day|evening|night
// &theme=light|dark (없으면 OS 따라) &bar=off (아래 시안 막대 숨김 — 스크린샷용)
// &usage=unavailable (사용량을 못 받은 상태 보기) &state=running|waiting|empty (작업 공간 상태)

import { WORK_STATES, type WorkState } from "./fixtures-workspace";

export const SCREENS = ["house", "workspace", "cats"] as const;
export const TIMES = ["morning", "day", "evening", "night"] as const;
export const THEMES = ["system", "light", "dark"] as const;

export type ScreenId = (typeof SCREENS)[number];
export type TimeOfDay = (typeof TIMES)[number];
export type ThemeChoice = (typeof THEMES)[number];

export interface FrameQuery {
  variant: string;
  screen: ScreenId;
  time: TimeOfDay;
  /** 쿼리로 시간대를 고정했나 (아니면 PC 시각을 따른다) */
  timeFixed: boolean;
  theme: ThemeChoice;
  bar: boolean;
  /** 사용량 가짜 데이터 — 받음 / 확인할 수 없음 */
  usage: "ok" | "unavailable";
  /** 작업 공간 상태 — 진행 중 / 기다리는 카드 / 빈 프로젝트 */
  work: WorkState;
}

/** 고양이 집 시간대 — 아침 05–10시 · 낮 10–17시 · 저녁 17–20시 · 밤 20–05시 (tokens.css 와 같음) */
export function timeOfDay(date: Date): TimeOfDay {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "morning";
  if (hour >= 10 && hour < 17) return "day";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

/** 모르는 값은 기본값으로 — 시안은 첫 번째, 화면은 집, 테마는 OS 따라. */
export function parseFrameQuery(search: string, now: Date, knownVariants: readonly string[]): FrameQuery {
  const params = new URLSearchParams(search);
  const fixedTime = pick(params.get("time"), TIMES);
  return {
    variant: pick(params.get("variant"), knownVariants) ?? knownVariants[0] ?? "a",
    screen: pick(params.get("screen"), SCREENS) ?? "house",
    time: fixedTime ?? timeOfDay(now),
    timeFixed: fixedTime !== undefined,
    theme: pick(params.get("theme"), THEMES) ?? "system",
    bar: params.get("bar") !== "off",
    usage: params.get("usage") === "unavailable" ? "unavailable" : "ok",
    work: pick(params.get("state"), WORK_STATES) ?? "running",
  };
}

/** 쿼리 하나만 바꾼 주소 (`null` 이면 그 키를 뺀다). */
export function withParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null) params.delete(key);
  else params.set(key, value);
  return `?${params.toString()}`;
}

/** App 이 시안 틀로 갈지 — `variant` 나 `screen` 쿼리가 있을 때만. 없으면 지금 화면 그대로. */
export function wantsVariantFrame(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("variant") || params.has("screen");
}
