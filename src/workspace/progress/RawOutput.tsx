// CLI 원본 출력 — 접어 두고 펼치기 (D-13 · D-48). `<details>` 라 Enter · Space 로 열린다. 펼칠 때만 그리고, 아래로 붙어 따라간다 (사용자가 위로 올리면 멈추고, 다시 맨 아래로 내리면 이어서 따라간다).
// 줄은 이 세션 것만 메모리에 있다 (`selectRawLines`) — 저장하지 않는다.
import { useLayoutEffect, useRef, useState } from "react";
import { t, tf, type TextKey } from "../../i18n/ko";
import type { RawLogEntry } from "../../lib/ipc-types";
import { Icon } from "../../variants/shared/icons";

export const RAW_ID = "ws-raw";

/** 맨 아래에서 이만큼 안이면 "붙어 있다" 로 본다 (px) */
const STICK_SLACK = 8;

const DIR_MARK: Record<RawLogEntry["dir"], string> = { send: "→", recv: "←", stderr: "!", note: "·" };

function lineText(line: RawLogEntry): string {
  return `${DIR_MARK[line.dir]} ${line.text}${line.truncated ? ` ${t("ws.progress.rawTruncated")}` : ""}`;
}

function RawLines({ lines }: { lines: readonly RawLogEntry[] }) {
  const box = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  // 새 줄이 와도 사용자가 위로 올려 둔 동안에는 그대로, 맨 아래에 있으면 따라간다
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={box}
      className="ws-raw__pre selectable"
      // 키보드로도 위아래로 읽을 수 있게
      tabIndex={0}
      aria-label={t("ws.progress.raw")}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK;
      }}
    >
      {lines.map((line) => (
        <span key={line.seq} className="ws-raw__line" data-dir={line.dir} title={t(`ws.progress.rawDir.${line.dir}` as TextKey)}>
          {lineText(line)}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

export function RawOutput({ lines }: { lines: readonly RawLogEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ws-raw" id={RAW_ID} open={open} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="terminal" size={16} />
        {t("ws.progress.raw")}
        <span>{tf("ws.progress.rawHint", { n: lines.length })}</span>
      </summary>
      {open && (lines.length === 0 ? <p className="ws-pg__empty">{t("ws.progress.rawEmpty")}</p> : <RawLines lines={lines} />)}
    </details>
  );
}
