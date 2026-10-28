// 왼쪽 위 카드 — 준비 상태 + 사용량 (D-24: 사용량을 못 받으면 "확인할 수 없음", 앱은 그대로).
// 시제품 `variants/shared/HomeBlocks.tsx` 의 `ReadyLine` · `UsageBars` · `Meter` · `UsageUnavailable` 를 바탕으로 실제 값으로 새로 썼다.
// 한도 막대는 "츄르" 로 부른다 (D-43, 2026-10-28 고객). 세션 츄르 개수(토큰 · 비용 추정) 줄과 모델별 한도(`scoped`)는 이번엔 보이지 않는다 (P6).
import { t, tf, type TextKey } from "../i18n/ko";
import type { UsageResult, UsageWindow } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { barPercent, formatAgo, formatReset, percentOf } from "./format";
import { READY_ITEMS, type ReadinessState } from "./useReadiness";
import type { UsageState } from "./useUsage";

export function ReadyLine({ readiness }: { readiness: ReadinessState }) {
  const { marks, loading, failed } = readiness;
  const done = READY_ITEMS.filter((item) => marks[item] === "ok").length;
  const missing = READY_ITEMS.filter((item) => marks[item] !== "ok");

  if (loading) {
    return (
      <p className="hm-ready" data-state="loading" role="status">
        <Icon name="clock" size={18} />
        <span className="hm-ready__text">
          <strong>{t("home.ready.checking")}</strong>
        </span>
      </p>
    );
  }
  const complete = missing.length === 0;
  return (
    <p className="hm-ready" data-state={complete ? "done" : "partial"}>
      <Icon name={complete ? "check" : "alert"} size={18} />
      <span className="hm-ready__text">
        <strong>
          {t(complete ? "home.ready.done" : "home.ready.partial")} {done}/{READY_ITEMS.length}
        </strong>
        <span className="hm-ready__detail">
          {failed
            ? t("home.ready.failed")
            : complete
              ? t("home.ready.detail")
              : tf("home.ready.missing", { list: missing.map((item) => t(`home.ready.item.${item}`)).join(" · ") })}
        </span>
      </span>
    </p>
  );
}

function Meter({ label, window: w, now }: { label: string; window: UsageWindow; now: Date }) {
  const percent = percentOf(w.utilization);
  return (
    <div className="hm-usage__row">
      <div className="hm-usage__line">
        <span>{label}</span>
        <strong>{tf("home.usage.used", { n: percent })}</strong>
      </div>
      <div
        className="hm-usage__bar"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={barPercent(w.utilization)}
        aria-valuetext={tf("home.usage.used", { n: percent })}
      >
        <span style={{ width: `${barPercent(w.utilization)}%` }} />
      </div>
      {w.resetsAt !== null && <p className="hm-usage__reset">{tf("home.usage.resets", { when: formatReset(w.resetsAt, now) })}</p>}
    </div>
  );
}

function reasonKey(result: UsageResult | null): TextKey | null {
  if (result?.state === "unavailable") return `home.usage.reason.${result.reason}`;
  if (result?.state === "ok" && result.fiveHour === null && result.sevenDay === null) return "home.usage.reason.empty";
  return null;
}

function Unavailable({ reason }: { reason: TextKey }) {
  return (
    <div className="hm-usage__none" role="status">
      <Icon name="alert" size={18} />
      <div>
        <strong>{t("home.usage.unavailable")}</strong>
        <p>{t(reason)}</p>
        <p>{t("home.usage.noEffect")}</p>
      </div>
    </div>
  );
}

/** 읽는 중 첫 화면 — 막대 자리를 그대로 두고 조용히 */
function Placeholder() {
  return (
    <div className="hm-usage__rows" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="hm-usage__row hm-usage__row--wait">
          <div className="hm-usage__line">
            <span>{t(i === 0 ? "home.usage.fiveHour" : "home.usage.weekly")}</span>
            <strong>–</strong>
          </div>
          <div className="hm-usage__bar" />
          <p className="hm-usage__reset">&nbsp;</p>
        </div>
      ))}
    </div>
  );
}

interface UsageCardProps extends UsageState {
  now: Date;
  onRefresh: () => void;
}

/** 아래 줄 — 읽은 때를 읽는 중 · 갱신 실패에도 남긴다 */
function readLine(reading: boolean, stale: boolean, readAt: number | null, now: Date): string {
  if (readAt === null) return reading ? t("home.usage.reading") : "";
  const ago = formatAgo(readAt, now);
  if (reading) return tf("home.usage.readingSince", { ago });
  return tf(stale ? "home.usage.staleSince" : "home.usage.readAgo", { ago });
}

export function UsageBlock({ result, reading, stale, now, onRefresh }: UsageCardProps) {
  const reason = reasonKey(result);
  const readAt = result?.state === "ok" && !reason ? result.readAt : null;
  return (
    <div className="hm-usage" aria-busy={reading}>
      {result === null ? (
        <Placeholder />
      ) : reason ? (
        <Unavailable reason={reason} />
      ) : result.state === "ok" ? (
        <div className="hm-usage__rows">
          {result.fiveHour && <Meter label={t("home.usage.fiveHour")} window={result.fiveHour} now={now} />}
          {result.sevenDay && <Meter label={t("home.usage.weekly")} window={result.sevenDay} now={now} />}
        </div>
      ) : null}
      <div className="hm-usage__foot">
        <span className="hm-usage__read" role="status">
          {readLine(reading, stale, readAt, now)}
        </span>
        <button type="button" className="hm-btn" onClick={onRefresh} disabled={reading}>
          <Icon name="refresh" size={16} />
          {t("home.usage.refresh")}
        </button>
      </div>
    </div>
  );
}
