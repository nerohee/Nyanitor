// 시안 공통 선 아이콘 (20 × 20, currentColor). 이모지를 아이콘으로 쓰지 않는다.
export type IconName =
  | "house"
  | "workspace"
  | "custom"
  | "settings"
  | "plus"
  | "close"
  | "check"
  | "alert"
  | "refresh"
  | "folder"
  | "download"
  | "undo"
  | "terminal"
  | "external"
  | "copy"
  | "info"
  | "file"
  | "chevron"
  | "arrow"
  | "key"
  | "bell"
  | "moon"
  | "clock"
  | "box"
  | "paw"
  | "dot"
  | "minus"
  | "stop"
  | "unplug"
  | "flag"
  | "search"
  | "collapse"
  | "expand"
  | "send"
  | "history"
  | "save";

/** 원 하나를 path 로 (cx, cy, r) */
function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
}

const PATHS: Record<IconName, string> = {
  house: "M3.5 9.5 10 4l6.5 5.5V16.5h-13z M8.5 16.5V12.5h3v4",
  workspace: "M4 5h12v8H4z M2.5 16h15 M8 13v3 M12 13v3",
  custom: "M13 3.8 16.2 7 7.2 16H4v-3.2z M11.5 5.3l3.2 3.2",
  settings: "M3.5 6.5h13 M3.5 13.5h13 M7.5 4.5v4 M12.5 11.5v4",
  plus: "M10 4.5v11 M4.5 10h11",
  close: "M5.5 5.5l9 9 M14.5 5.5l-9 9",
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  alert: "M10 6v5 M10 13.6v.4 M10 2.8a7.2 7.2 0 1 1 0 14.4 7.2 7.2 0 0 1 0-14.4z",
  refresh: "M15.6 7.5A6.2 6.2 0 1 0 16.2 11 M16 3.8v3.9h-3.9",
  folder: "M2.8 5.2h5l1.6 2h7.8v8.6H2.8z",
  download: "M10 3.5v9 M6 8.6l4 4 4-4 M3.8 16.5h12.4",
  undo: "M7.4 4.6 3.8 8.2l3.6 3.6 M3.8 8.2h8a4.4 4.4 0 0 1 0 8.8H9.2",
  terminal: "M3 4.5h14v11H3z M6 8l2.5 2L6 12 M10.5 12.5h3.5",
  external: "M11.2 3.6h5.2v5.2 M16.4 3.6 9.2 10.8 M14.2 12.2v4.2H3.6V5.8h4.2",
  copy: "M7.2 7.2h9v9.2h-9z M4 12.8V3.6h9.2",
  info: `M10 9.2v5 M10 6.2v.4 ${circle(10, 10, 7.2)}`,
  file: "M5 2.6h6.6L15 6v11.4H5z M11.4 2.6V6.2H15",
  chevron: "M6 8l4 4 4-4",
  arrow: "M4 10h12 M11.5 5.5 16 10l-4.5 4.5",
  key: `${circle(6.8, 13.2, 3)} M9 11 16.2 3.8 M13.6 6.4l2 2 M11.8 8.2l1.6 1.6`,
  bell: "M5.2 13.4V9a4.8 4.8 0 0 1 9.6 0v4.4l1.5 2H3.7z M8.4 17.6h3.2",
  moon: "M15.8 12.4A6.6 6.6 0 0 1 7.6 4.2a6.6 6.6 0 1 0 8.2 8.2z",
  clock: `${circle(10, 10, 7.2)} M10 6v4.2l2.8 2`,
  box: "M3.4 6.4 10 3l6.6 3.4v7.2L10 17l-6.6-3.4z M3.4 6.4 10 9.8l6.6-3.4 M10 9.8V17",
  // 발바닥 — 고양이 얼굴 아이콘은 쓰지 않는다 (D-39)
  paw: `M6.4 13.4c0-2 1.6-3.4 3.6-3.4s3.6 1.4 3.6 3.4c0 1.6-1.2 2.6-2.4 2.2-.8-.3-1.6-.3-2.4 0-1.2.4-2.4-.6-2.4-2.2z ${circle(5, 8.6, 1.4)} ${circle(8, 5.6, 1.4)} ${circle(12, 5.6, 1.4)} ${circle(15, 8.6, 1.4)}`,
  dot: circle(10, 10, 2.2),
  minus: "M5.5 10h9",
  stop: "M6 6h8v8H6z",
  unplug: "M7.2 3.5v3 M12.8 3.5v3 M5.4 6.5h9.2v2.6a4.6 4.6 0 0 1-9.2 0z M10 13.7v2.8 M3.2 3.2l13.6 13.6",
  flag: "M5 17.2V3.4 M5 4h9.6l-2.2 3.2 2.2 3.2H5",
  search: `${circle(8.6, 8.6, 5.2)} M12.4 12.4l4.2 4.2`,
  collapse: "M11.8 5.2 7 10l4.8 4.8 M15.4 4v12",
  expand: "M8.2 5.2 13 10l-4.8 4.8 M4.6 4v12",
  send: "M3.4 10.2 16.6 3.8 12.6 16.6l-2.8-5.6z M9.8 11 16.6 3.8",
  history: `M3.9 10a6.1 6.1 0 1 0 1.8-4.3 M3.6 3.4v3.3h3.3 M10 6.6v3.6l2.6 1.6`,
  save: "M4 3.6h9.6l2.6 2.6v10.2H4z M7 3.6v4h6v-4 M6.6 16.4v-5h6.8v5",
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
