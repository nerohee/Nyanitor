// 상태 카드 맨 아래 한 줄 — 지금 판 · 새 판 확인 · 받는 중 · 실패 (P11-02).
// 모양은 `ReadyLine` 처럼 "제목 + 작은 글" 두 줄에 단추 하나 — 어느 상태든 두 줄 · 단추 한 개가 그대로라 카드 높이가 덜컥이지 않는다 (P6-08 고객).
import { t, tf, type TextKey } from "../i18n/ko";
import type { AppUpdateStatus } from "../lib/ipc-types";
import { Icon, type IconName } from "../variants/shared/icons";
import { formatMegabytes } from "./AppUpdateDialog";
import { CURRENT_VERSION, type AppUpdateState } from "./useAppUpdate";

interface Shown {
  tone: "plain" | "new" | "warn";
  icon: IconName;
  title: string;
  detail: string;
  /** 단추 글 · 누르면 */
  action: { label: TextKey; run: "check" | "dialog"; disabled?: boolean };
}

const FAILED_TITLE: Record<"check" | "download" | "install", TextKey> = {
  check: "home.update.failed.check",
  download: "home.update.failed.download",
  install: "home.update.failed.install",
};

function describe(status: AppUpdateStatus): Shown {
  const current = tf("home.update.current", { v: CURRENT_VERSION });
  switch (status.state) {
    case "idle":
      return { tone: "plain", icon: "refresh", title: current, detail: "", action: { label: "home.update.check", run: "check" } };
    case "latest":
      return { tone: "plain", icon: "check", title: current, detail: t("home.update.latest"), action: { label: "home.update.check", run: "check" } };
    case "checking":
      return { tone: "plain", icon: "clock", title: t("home.update.checking"), detail: "", action: { label: "home.update.check", run: "check", disabled: true } };
    case "available":
      return {
        tone: "new",
        icon: "download",
        title: tf("home.update.available", { v: status.release.version }),
        detail: tf("home.update.availableDetail", { v: CURRENT_VERSION }),
        action: { label: "home.update.notes", run: "dialog" },
      };
    case "downloading":
      return {
        tone: "new",
        icon: "download",
        title: tf("home.update.downloading", { v: status.version }),
        detail:
          status.total === null
            ? tf("home.update.progressUnknown", { received: formatMegabytes(status.received) })
            : tf("home.update.progress", { received: formatMegabytes(status.received), total: formatMegabytes(status.total) }),
        action: { label: "home.update.more", run: "dialog" },
      };
    case "ready":
      return {
        tone: "new",
        icon: "download",
        title: tf("home.update.ready", { v: status.version }),
        detail: t("home.update.readyDetail"),
        action: { label: "home.update.install", run: "dialog" },
      };
    case "unsupported":
      return {
        tone: "warn",
        icon: "alert",
        title: tf("home.update.unsupported", { v: status.release.version }),
        detail: t("home.update.unsupportedDetail"),
        action: { label: "home.update.notes", run: "dialog" },
      };
    case "failed":
      return { tone: "warn", icon: "alert", title: t(FAILED_TITLE[status.stage]), detail: t("home.update.failedDetail"), action: { label: "home.update.retry", run: "check" } };
  }
}

/** 소리로 알릴 말 — 끝났을 때만 (확인 중 · 받는 중 진행은 알리지 않는다). 대화상자가 열려 있으면 그쪽이 알린다 */
function spoken(status: AppUpdateStatus, shown: Shown): string {
  if (status.state === "latest" || status.state === "available" || status.state === "ready" || status.state === "failed" || status.state === "unsupported") {
    return `${shown.title}. ${shown.detail}`;
  }
  return "";
}

export function AppUpdateLine({ update }: { update: AppUpdateState }) {
  const { status, notice, dialogOpen } = update;
  const shown = describe(status);
  const detail = notice ?? shown.detail;
  const onClick = () => {
    if (shown.action.run === "dialog") update.openDialog();
    else update.check();
  };
  return (
    <div className="hm-update" data-state={status.state} data-tone={shown.tone} aria-busy={status.state === "checking" || status.state === "downloading"}>
      <p className="hm-update__title">
        <Icon name={shown.icon} size={16} />
        <strong>{shown.title}</strong>
      </p>
      <div className="hm-update__foot">
        {/* 한 줄 — 길면 줄임표 (전체는 title · 대화상자). 두 줄로 늘어나면 카드 높이가 바뀐다 */}
        <span className="hm-update__detail" title={detail || undefined}>
          {detail || " "}
        </span>
        <button type="button" className="hm-btn" onClick={onClick} disabled={shown.action.disabled}>
          {t(shown.action.label)}
        </button>
      </div>
      <span className="hm-sr" role="status">
        {dialogOpen ? "" : (notice ?? spoken(status, shown))}
      </span>
    </div>
  );
}
