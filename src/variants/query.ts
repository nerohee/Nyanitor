// 시안 틀이 읽는 주소 쿼리: ?variant=a (없는 시안은 a 로) &screen=house|workspace|edit|setup|settings|harness|pick|tray|cats
// &time=morning|day|evening|night &theme=light|dark (없으면 OS 따라) &bar=off (아래 시안 막대 숨김 — 스크린샷용)
// &usage=unavailable (사용량을 못 받은 상태 보기) &state=… (화면마다 상태 — SCREEN_STATES, 첫 번째가 기본)
// &skin=0|1|2|3 (UI 판 — 없으면 ① 나무 쟁반(D-40). 0 은 보관한 1판 테마, 2 · 3 은 보관한 시안)

import { TIMES, timeOfDay, type TimeOfDay } from "../components/house/time";
import { EDIT_STATES } from "./fixtures-edit";
import { HARNESS_STATES, PICK_STATES, SETTINGS_STATES, SETUP_STATES } from "./fixtures-screens";
import { TRAY_STATES } from "./fixtures-tray";
import { WORK_STATES, type WorkState } from "./fixtures-workspace";

export { TIMES, timeOfDay, type TimeOfDay };

/** 시안 막대의 화면 순서. `tray` 는 트레이 · 알림 견본(OS 가 그리는 것), `cats` 는 그림 규격 확인용 (둘 다 앱 화면 아님) */
export const SCREENS = ["house", "workspace", "edit", "setup", "settings", "harness", "pick", "tray", "cats"] as const;
export const THEMES = ["system", "light", "dark"] as const;
/**
 * UI 판 (P2-11 · D-40). ① 이 기본(쿼리 없음). 0 = 1판 테마, 2 · 3 = 보관한 시안 — 지우지 않고 계속 볼 수 있게.
 * 사용자 설정으로 테마를 고르게 할지는 아직 정하지 않았다 (D-40).
 */
export const SKINS = ["0", "1", "2", "3"] as const;
export const DEFAULT_SKIN = "1" as const;

export type ScreenId = (typeof SCREENS)[number];
export type ThemeChoice = (typeof THEMES)[number];
export type SkinId = (typeof SKINS)[number];

/** 화면마다 고를 수 있는 상태 (첫 번째가 기본). 없는 화면은 상태가 없다 */
export const SCREEN_STATES: Partial<Record<ScreenId, readonly string[]>> = {
  workspace: WORK_STATES,
  edit: EDIT_STATES,
  setup: SETUP_STATES,
  settings: SETTINGS_STATES,
  harness: HARNESS_STATES,
  pick: PICK_STATES,
  tray: TRAY_STATES,
};

export interface FrameQuery {
  variant: string;
  screen: ScreenId;
  time: TimeOfDay;
  /** 쿼리로 시간대를 고정했나 (아니면 PC 시각을 따른다) */
  timeFixed: boolean;
  theme: ThemeChoice;
  /** UI 판 — 없으면 ① */
  skin: SkinId;
  bar: boolean;
  /** 사용량 가짜 데이터 — 받음 / 확인할 수 없음 */
  usage: "ok" | "unavailable";
  /** 작업 공간 상태 (WORK_STATES) */
  work: WorkState;
  /** 지금 화면의 상태 (SCREEN_STATES). 상태가 없는 화면은 "" */
  state: string;
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.find((item) => item === value);
}

/** 화면 상태를 그 화면의 목록에서 고른다 — 모르는 값은 첫 번째(기본) */
export function pickState<T extends string>(value: string, allowed: readonly T[]): T {
  return pick(value, allowed) ?? allowed[0];
}

/** 모르는 값은 기본값으로 — 시안은 첫 번째, 화면은 집, 테마는 OS 따라, UI 판은 ①. */
export function parseFrameQuery(search: string, now: Date, knownVariants: readonly string[]): FrameQuery {
  const params = new URLSearchParams(search);
  const fixedTime = pick(params.get("time"), TIMES);
  const screen = pick(params.get("screen"), SCREENS) ?? "house";
  const states = SCREEN_STATES[screen] ?? [];
  return {
    variant: pick(params.get("variant"), knownVariants) ?? knownVariants[0] ?? "a",
    screen,
    time: fixedTime ?? timeOfDay(now),
    timeFixed: fixedTime !== undefined,
    theme: pick(params.get("theme"), THEMES) ?? "system",
    skin: pick(params.get("skin"), SKINS) ?? DEFAULT_SKIN,
    bar: params.get("bar") !== "off",
    usage: params.get("usage") === "unavailable" ? "unavailable" : "ok",
    work: pick(params.get("state"), WORK_STATES) ?? "running",
    state: pick(params.get("state"), states) ?? states[0] ?? "",
  };
}

/** 쿼리 하나만 바꾼 주소 (`null` 이면 그 키를 뺀다). */
export function withParam(search: string, key: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null) params.delete(key);
  else params.set(key, value);
  return `?${params.toString()}`;
}

/**
 * 다른 화면으로 가는 주소 — 화면마다 뜻이 다른 `state` · `section` · `cat` · `agent` · `item` 은 떼고, 필요하면 새 상태를 붙인다.
 * 시안 · UI 판 · 시간 · 테마 · 막대는 그대로 둔다.
 */
export function screenHref(search: string, screen: ScreenId, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams(search);
  for (const key of ["state", "section", "cat", "agent", "item"]) params.delete(key);
  params.set("screen", screen);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return `?${params.toString()}`;
}

/** App 이 시안 틀로 갈지 — `variant` 나 `screen` 쿼리가 있을 때만. 없으면 지금 화면 그대로. */
export function wantsVariantFrame(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has("variant") || params.has("screen");
}
