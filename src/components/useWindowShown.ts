// 창이 보이는가 (D-55) — 두 신호를 같이 본다: Rust 가 창을 숨기거나 최소화할 때 보내는 `app:window-visibility` (`ipc.onWindowVisibility`)
// 와 웹뷰의 `document.visibilityState`. 하나라도 숨김이면 숨은 것이고, 둘 다 보여야 보이는 것이다.
// 숨으면 화면의 애니메이션 · 주기 읽기가 쉰다 — 주기 읽기 훅은 `subscribeWindowShown` + `isWindowShown`, 그리는 쪽은 `useWindowShown`.
// 듣는 곳이 하나라도 있는 동안에만 이벤트를 듣고, 모두 떠나면 그만 듣고 "보임" 으로 되돌린다.
import { useSyncExternalStore } from "react";
import { ipc } from "../lib/ipc";

type Listener = (shown: boolean) => void;

const listeners = new Set<Listener>();
/** Rust 가 알려 준 보임 (처음은 보임 — 앱이 처음 뜰 때는 이벤트가 오지 않는다) */
let eventShown = true;
let stopListening: (() => void) | null = null;
/** 듣기를 시작한(또는 시작하는 중인) 차례 — 끝내면 올려, 늦게 도착한 듣기 해제를 바로 부른다 */
let generation = 0;
let active = false;

/** 지금 창이 보이는가 */
export function isWindowShown(): boolean {
  return eventShown && document.visibilityState !== "hidden";
}

function emit(): void {
  const shown = isWindowShown();
  for (const listener of [...listeners]) listener(shown);
}

function onVisibilityChange(): void {
  emit();
}

function start(): void {
  active = true;
  const mine = ++generation;
  document.addEventListener("visibilitychange", onVisibilityChange);
  ipc
    .onWindowVisibility((event) => {
      eventShown = event.visible;
      emit();
    })
    .then((unlisten) => {
      if (mine === generation && active) stopListening = unlisten;
      else unlisten();
    })
    .catch(() => undefined); // 듣지 못해도 `visibilitychange` 가 있다
}

function stop(): void {
  active = false;
  generation += 1;
  document.removeEventListener("visibilitychange", onVisibilityChange);
  stopListening?.();
  stopListening = null;
  eventShown = true;
}

/** 보임 · 숨김이 바뀔 때마다 (두 신호 어느 쪽이든) 지금 보이는가를 알려 준다. 돌려주는 함수를 부르면 그만 듣는다 */
export function subscribeWindowShown(listener: Listener): () => void {
  listeners.add(listener);
  if (!active) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const subscribeForReact = (onChange: () => void): (() => void) => subscribeWindowShown(() => onChange());

/** 창이 보이는가 — 바뀌면 다시 그린다 */
export function useWindowShown(): boolean {
  return useSyncExternalStore(subscribeForReact, isWindowShown, () => true);
}
