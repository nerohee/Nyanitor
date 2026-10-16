// 트레이 메뉴 · 알림 견본 (P2-14 · 기능은 P8). 트레이 메뉴와 알림은 OS 기본 모양 — 여기서는 문구 · 순서 · 언제를 정한다.
// 문구는 ko.ts, 규칙은 design-references.md "P2-14 트레이 · 알림" 절.
import type { TextKey } from "../i18n/ko";
import type { OrchStatus } from "./fixtures-workspace";

export const TRAY_STATES = ["menu", "notify", "quit"] as const;
export type TrayState = (typeof TRAY_STATES)[number];

export interface TrayMenuItem {
  key: TextKey;
  /** 상태 줄 (누를 수 없음) */
  header?: boolean;
  /** 기본 항목 (굵게 — 아이콘을 두 번 누르면 이것) */
  primary?: boolean;
  /** 누르면 한 번 더 묻는다 (… 표시) */
  asks?: boolean;
  separatorBefore?: boolean;
}

export interface TrayMenu {
  status: OrchStatus;
  tooltipKey: TextKey;
  items: TrayMenuItem[];
}

export const TRAY_MENUS: TrayMenu[] = [
  {
    status: "idle",
    tooltipKey: "variant.tray.tip.idle",
    items: [
      { key: "variant.tray.head.idle", header: true },
      { key: "variant.tray.open", primary: true },
      { key: "variant.tray.quit", separatorBefore: true },
    ],
  },
  {
    status: "working",
    tooltipKey: "variant.tray.tip.working",
    items: [
      { key: "variant.tray.head.working", header: true },
      { key: "variant.tray.open", primary: true },
      { key: "variant.tray.quit", asks: true, separatorBefore: true },
    ],
  },
  {
    status: "waiting",
    tooltipKey: "variant.tray.tip.waiting",
    items: [
      { key: "variant.tray.head.waiting", header: true },
      { key: "variant.tray.goCard", primary: true },
      { key: "variant.tray.open" },
      { key: "variant.tray.quit", asks: true, separatorBefore: true },
    ],
  },
  {
    status: "error",
    tooltipKey: "variant.tray.tip.error",
    items: [
      { key: "variant.tray.head.error", header: true },
      { key: "variant.tray.openError", primary: true },
      { key: "variant.tray.quit", separatorBefore: true },
    ],
  },
];

/** 알림 종류 — 설정의 알림 4묶음(ask · phase · error · limit, P2-13)에 매인다 */
export type NotifyGroup = "ask" | "phase" | "error" | "limit" | "once";

export interface ToastSample {
  id: string;
  group: NotifyGroup;
  titleKey: TextKey;
  bodyKey: TextKey;
  /** 누르면 (D-25 — 창을 열고 그 카드로) */
  clickKey: TextKey;
}

export const TOASTS: ToastSample[] = [
  {
    id: "question",
    group: "ask",
    titleKey: "variant.tray.n.question",
    bodyKey: "variant.tray.n.questionBody",
    clickKey: "variant.tray.click.card",
  },
  {
    id: "approval",
    group: "ask",
    titleKey: "variant.tray.n.approval",
    bodyKey: "variant.tray.n.approvalBody",
    clickKey: "variant.tray.click.card",
  },
  {
    id: "permission",
    group: "ask",
    titleKey: "variant.tray.n.permission",
    bodyKey: "variant.tray.n.permissionBody",
    clickKey: "variant.tray.click.card",
  },
  {
    id: "runcheck",
    group: "ask",
    titleKey: "variant.tray.n.runcheck",
    bodyKey: "variant.tray.n.runcheckBody",
    clickKey: "variant.tray.click.card",
  },
  {
    id: "phase",
    group: "phase",
    titleKey: "variant.tray.n.phase",
    bodyKey: "variant.tray.n.phaseBody",
    clickKey: "variant.tray.click.board",
  },
  {
    id: "error",
    group: "error",
    titleKey: "variant.tray.n.error",
    bodyKey: "variant.tray.n.errorBody",
    clickKey: "variant.tray.click.chat",
  },
  {
    id: "limitNear",
    group: "limit",
    titleKey: "variant.tray.n.limitNear",
    bodyKey: "variant.tray.n.limitNearBody",
    clickKey: "variant.tray.click.chat",
  },
  {
    id: "limitHit",
    group: "limit",
    titleKey: "variant.tray.n.limitHit",
    bodyKey: "variant.tray.n.limitHitBody",
    clickKey: "variant.tray.click.chat",
  },
  {
    id: "firstClose",
    group: "once",
    titleKey: "variant.tray.n.firstClose",
    bodyKey: "variant.tray.n.firstCloseBody",
    clickKey: "variant.tray.click.open",
  },
];

/** 알리지 않는 때 · 묶는 규칙 (견본 오른쪽 표) */
export const NOTIFY_RULES: TextKey[] = [
  "variant.tray.rule.focus",
  "variant.tray.rule.group",
  "variant.tray.rule.settings",
  "variant.tray.rule.click",
  "variant.tray.rule.noAnswer",
  "variant.tray.rule.badge",
];
