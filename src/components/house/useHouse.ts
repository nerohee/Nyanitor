// 고양이 집 장면을 움직이는 훅들 — 움직임 끔 · 창 숨김 감시, 자리 배정 상태 기계, 가짜 일정.
// 실제 에이전트 상태와 묶는 것은 P5: `useFakeIntents` 대신 실제 `Intents` 를 `useHouseSchedule` 에 넣으면 된다.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CAT_IDS, type CatId } from "../cat/catalog";
import type { PoseName } from "../cat/CatFigure";
import {
  assignSpots,
  FAKE_PLANS,
  initialPlacements,
  pickRoam,
  staggerDelays,
  TAB_ORDER,
  travel,
  type Assignment,
  type CatPlacement,
  type Intents,
  type Placements,
} from "./schedule";
import { SPOTS, type SpotId } from "./spots";

// ── 움직임 끔 · 창 숨김 ──

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReduced(onChange: () => void): () => void {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_QUERY) : null;
  media?.addEventListener("change", onChange);
  // 앱 설정의 "움직임 줄이기" — `:root[data-motion="reduced"]` (tokens.css)
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => {
    media?.removeEventListener("change", onChange);
    observer.disconnect();
  };
}

function reducedSnapshot(): boolean {
  const media = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_QUERY) : null;
  return (media?.matches ?? false) || document.documentElement.dataset.motion === "reduced";
}

function subscribeHidden(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function hiddenSnapshot(): boolean {
  return document.visibilityState === "hidden";
}

export interface SceneMotion {
  /** 움직임 줄이기 — 첫 프레임에서 멈추고 자리는 바로 바꾼다 */
  reduced: boolean;
  /** 창이 숨었다 — 모든 움직임 · 타이머가 멈춘다 */
  hidden: boolean;
}

/** `prefers-reduced-motion` · 앱 설정 · 창 숨김을 본다. 창이 숨으면 `:root[data-hidden]` 을 달아 CSS 도 멈춘다. */
export function useSceneMotion(): SceneMotion {
  const reduced = useSyncExternalStore(subscribeReduced, reducedSnapshot, () => false);
  const hidden = useSyncExternalStore(subscribeHidden, hiddenSnapshot, () => false);
  useEffect(() => {
    const root = document.documentElement;
    if (hidden) root.dataset.hidden = "true";
    else delete root.dataset.hidden;
    return () => {
      delete root.dataset.hidden;
    };
  }, [hidden]);
  return { reduced, hidden };
}

// ── 자리 배정 상태 기계 ──

export type { CatPlacement };

const FADE_MS = 220;
const SETTLE_MS = 40;
/** 가끔 자리를 바꾸는 간격 (움직임 끔이면 느리게 — 바로 바꾼다) */
const ROAM_MIN_MS = 12000;
const ROAM_SPAN_MS = 12000;
const ROAM_REDUCED_MS = 40000;

function spotsOf(placements: Placements): Assignment {
  return Object.fromEntries(CAT_IDS.map((cat) => [cat, placements[cat].spot])) as Assignment;
}

function posesOf(placements: Placements): Record<CatId, PoseName> {
  return Object.fromEntries(CAT_IDS.map((cat) => [cat, placements[cat].pose])) as Record<CatId, PoseName>;
}

/**
 * 고양이 7마리의 자리. `intents` 가 바뀌면 그 자리로 옮기고 (가까우면 걷고, 멀면 사라졌다 나타남),
 * 가만히 있어도 가끔 쉬는 고양이가 자리나 동작을 바꾼다. 창이 숨으면 멈추고, 움직임 끔이면 바로 바꾼다.
 * `pinned`(정보 패널이 열린 고양이)는 가끔 옮기는 일에서 빠진다.
 * 반환은 Tab 순서(`TAB_ORDER`) — 고양이가 옮겨 다녀도 바뀌지 않는다.
 */
export function useHouseSchedule(intents: Intents, motion: SceneMotion, pinned: CatId | null = null): CatPlacement[] {
  const [placements, setPlacements] = useState<Placements>(() => initialPlacements(assignSpots(intents)));
  const latest = useRef(placements);
  const timers = useRef(new Set<number>());
  /** 고양이마다 "가장 최근 이동" 번호 — 끼어든 이동이 있으면 이전 이동의 뒷일을 하지 않는다 */
  const trip = useRef<Partial<Record<CatId, number>>>({});
  const intentsRef = useRef(intents);
  const motionRef = useRef(motion);
  const pinnedRef = useRef(pinned);
  useEffect(() => {
    intentsRef.current = intents;
    motionRef.current = motion;
    pinnedRef.current = pinned;
  });

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((id) => window.clearTimeout(id));
      pending.clear();
    };
  }, []);

  const update = (cat: CatId, patch: Partial<CatPlacement>) => {
    latest.current = { ...latest.current, [cat]: { ...latest.current[cat], ...patch } };
    setPlacements(latest.current);
  };

  const later = (cat: CatId, ticket: number, ms: number, run: () => void) => {
    const id = window.setTimeout(() => {
      timers.current.delete(id);
      if (trip.current[cat] === ticket) run();
    }, ms);
    timers.current.add(id);
  };

  const moveCat = (cat: CatId, to: SpotId) => {
    const from = latest.current[cat].spot;
    if (from === to) return;
    const ticket = (trip.current[cat] ?? 0) + 1;
    trip.current[cat] = ticket;
    const arrive = { spot: to, pose: SPOTS[to].poses[0], facing: "right" as const, walking: false };

    if (motionRef.current.reduced) {
      update(cat, { ...arrive, fade: null, instant: true });
      return;
    }
    const how = travel(from, to);
    if (how.mode === "walk") {
      update(cat, { spot: to, pose: "walk", facing: how.facing, walking: true, walkMs: how.ms, fade: null, instant: false });
      later(cat, ticket, how.ms, () => update(cat, { pose: arrive.pose, facing: arrive.facing, walking: false }));
      return;
    }
    update(cat, { walking: false, fade: "out", instant: false });
    later(cat, ticket, FADE_MS, () => {
      update(cat, { ...arrive, fade: "in", instant: true });
      later(cat, ticket, SETTLE_MS, () => update(cat, { instant: false }));
      later(cat, ticket, FADE_MS, () => update(cat, { fade: null }));
    });
  };

  // 의도가 바뀌면 그 자리로 (처음에는 이미 맞다)
  const intentsKey = CAT_IDS.map((cat) => intents[cat]).join(",");
  useEffect(() => {
    const next = assignSpots(intentsRef.current, spotsOf(latest.current));
    const moving = CAT_IDS.filter((cat) => next[cat] !== latest.current[cat].spot);
    // 움직임 끔이면 기다리지 않고 바로 바꾼다
    const delays = motionRef.current.reduced
      ? {}
      : staggerDelays(moving.map((cat) => ({ cat, from: latest.current[cat].spot, to: next[cat] })));
    for (const cat of moving) {
      // 같은 순간에 한꺼번에 사라졌다 나타나지 않게 고양이마다 엇갈려 옮긴다
      const ticket = (trip.current[cat] ?? 0) + 1;
      trip.current[cat] = ticket;
      const to = next[cat];
      const delay = delays[cat] ?? 0;
      if (delay === 0) moveCat(cat, to);
      else later(cat, ticket, delay, () => moveCat(cat, to));
    }
    // moveCat 은 ref 만 읽는다 — 의도가 바뀔 때만 다시 계산하면 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentsKey]);

  // 가끔 쉬는 고양이가 자리나 동작을 바꾼다
  const { reduced, hidden } = motion;
  useEffect(() => {
    if (hidden) return;
    let id = 0;
    const schedule = () => {
      const wait = reduced ? ROAM_REDUCED_MS : ROAM_MIN_MS + Math.random() * ROAM_SPAN_MS;
      id = window.setTimeout(() => {
        const busy = CAT_IDS.some((cat) => latest.current[cat].walking || latest.current[cat].fade);
        const roam = busy ? null : pickRoam(
              intentsRef.current,
              spotsOf(latest.current),
              posesOf(latest.current),
              Math.random,
              pinnedRef.current,
            );
        if (roam?.kind === "pose") update(roam.cat, { pose: roam.pose });
        else if (roam?.kind === "move") moveCat(roam.cat, roam.to);
        schedule();
      }, wait);
    };
    schedule();
    return () => window.clearTimeout(id);
    // update · moveCat 은 ref 와 setState 만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, hidden]);

  return TAB_ORDER.map((cat) => placements[cat]);
}

// ── 가짜 일정 ──

const PLAN_MS = 40000;

/** 시안용 가짜 일정 — 40초마다 일하는 고양이가 바뀐다 (`FAKE_PLANS`, `firstPlan` 번째부터). 움직임 끔 · 창 숨김에서는 멈춘다. */
export function useFakeIntents(motion: SceneMotion, firstPlan = 0): Intents {
  const [index, setIndex] = useState(() => (firstPlan >= 0 && firstPlan < FAKE_PLANS.length ? firstPlan : 0));
  const { reduced, hidden } = motion;
  useEffect(() => {
    if (reduced || hidden) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % FAKE_PLANS.length), PLAN_MS);
    return () => window.clearInterval(id);
  }, [reduced, hidden]);
  return FAKE_PLANS[index];
}
