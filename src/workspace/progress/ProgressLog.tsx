// 쉬운 말 요약 기록 — 시각 · 고양이 · 한 줄. 새 것이 위 (시제품대로). 아주 길면 최근 것부터 보이고 "이전 기록 더 보기".
import { useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, tf, type TextKey } from "../../i18n/ko";
import { Icon, type IconName } from "../../variants/shared/icons";
import type { LogItem, LogKind } from "./summary";

const LOG_ICON: Record<LogKind, IconName> = {
  start: "flag",
  assign: "arrow",
  back: "undo",
  pass: "check",
  ask: "info",
  error: "alert",
  stop: "stop",
  phase: "flag",
};

/** 한 번에 보이는 줄 수 */
export const LOG_PAGE = 100;

/** 이 PC 의 시계로 "09:41" — 시각을 모르면 빈 글 */
export function logTime(atMs: number | null): string {
  if (atMs === null) return "";
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ProgressLog({ log }: { log: readonly LogItem[] }) {
  const [shown, setShown] = useState(LOG_PAGE);
  if (log.length === 0) return <p className="ws-pg__empty">{t("ws.progress.log.empty")}</p>;
  const newest = [...log].reverse();
  const visible = newest.slice(0, shown);
  const rest = newest.length - visible.length;
  return (
    <>
      <ol className="ws-lg" aria-label={t("ws.progress.logTitle")}>
        {visible.map((item) => {
          const kind = t(`ws.progress.kind.${item.kind}` as TextKey);
          return (
            <li key={item.key} data-kind={item.kind}>
              <time>{logTime(item.atMs)}</time>
              <span className="ws-lg__kind" title={kind}>
                <Icon name={LOG_ICON[item.kind]} size={12} />
                <span className="ws-sr">{kind}</span>
              </span>
              <span className="ws-lg__face" aria-hidden="true">
                <CatFigure cat={item.cat} crop="face" />
              </span>
              <span className="ws-lg__text">{item.text}</span>
            </li>
          );
        })}
      </ol>
      {rest > 0 && (
        <button type="button" className="ws-btn ws-btn--small ws-btn--ghost ws-lg__more" onClick={() => setShown((n) => n + LOG_PAGE)}>
          {tf("ws.progress.log.more", { n: rest })}
        </button>
      )}
    </>
  );
}
