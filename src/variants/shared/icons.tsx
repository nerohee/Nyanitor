// 시안 공통 선 아이콘 (20 × 20, currentColor). 이모지를 아이콘으로 쓰지 않는다.
export type IconName = "house" | "workspace" | "custom" | "settings" | "plus" | "close" | "back" | "check" | "alert";

const PATHS: Record<IconName, string> = {
  house: "M3.5 9.5 10 4l6.5 5.5V16.5h-13z M8.5 16.5V12.5h3v4",
  workspace: "M4 5h12v8H4z M2.5 16h15 M8 13v3 M12 13v3",
  custom: "M13 3.8 16.2 7 7.2 16H4v-3.2z M11.5 5.3l3.2 3.2",
  settings: "M3.5 6.5h13 M3.5 13.5h13 M7.5 4.5v4 M12.5 11.5v4",
  plus: "M10 4.5v11 M4.5 10h11",
  close: "M5.5 5.5l9 9 M14.5 5.5l-9 9",
  back: "M11.5 4.5 6 10l5.5 5.5 M6.5 10H16",
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  alert: "M10 6v5 M10 13.6v.4 M10 2.8a7.2 7.2 0 1 1 0 14.4 7.2 7.2 0 0 1 0-14.4z",
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
