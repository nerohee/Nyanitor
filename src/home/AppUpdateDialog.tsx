// 새 판 대화상자 — 바뀐 점 · 설치 · 받는 중 · 경고 · 실패 · 이 설치 방식은 안 됨 (P11-02, D-26).
// 같은 대화상자가 상태를 따라 바뀐다: 새 판 → (설치) 받는 중 → 다시 시작, 경고가 오면 같은 자리에서 "그래도 설치" 를 고른다.
// 첫 포커스는 안전한 쪽 (「나중에」 · 「닫기」). 바뀐 점은 GitHub 릴리스 글(마크다운) — `MarkdownPreview` 가 안전하게 그린다.
import { useEffect, useId, useRef } from "react";
import { t, tf, type TextKey } from "../i18n/ko";
import type { AppUpdateWarning } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { Dialog } from "../workspace/Dialog";
import { MarkdownPreview } from "../workspace/MarkdownPreview";
import "../workspace/workspace.css";
import type { AppUpdateState } from "./useAppUpdate";

/** 릴리스 목록 주소 — 앱에 열기 기능이 없어 고를 수 있는 글로만 (바뀐 점이 길어 잘렸을 때 · deb 일 때) */
export const RELEASES_URL = "https://github.com/nerohee/Nyanitor/releases";

const WARNING_TEXT: Record<AppUpdateWarning, TextKey> = {
  working: "home.update.dlg.warning.working",
  harness_fetch: "home.update.dlg.warning.harness_fetch",
  harness_install: "home.update.dlg.warning.harness_install",
};

/** 바이트 → "12.3" (MB, 소수 한 자리) */
export function formatMegabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

export function AppUpdateDialog({ update }: { update: AppUpdateState }) {
  const titleId = useId();
  const later = useRef<HTMLButtonElement>(null);
  const { status, release, warning, notice, installing } = update;
  const version = status.state === "downloading" || status.state === "ready" ? status.version : (release?.version ?? "");
  const downloading = status.state === "downloading";
  const readyInstalling = status.state === "ready" && installing;
  const failed = status.state === "failed" && status.stage !== "check" ? status.stage : null;
  const unsupported = status.state === "unsupported";

  // 설치 단추가 사라지거나 경고가 오면 포커스가 body 로 빠지지 않게 안전한 단추로
  const phase = warning ? `warning-${warning}` : status.state;
  useEffect(() => {
    later.current?.focus();
  }, [phase]);

  const showNotes = !warning && !downloading && release !== null;
  const progressText =
    status.state === "downloading"
      ? status.total === null
        ? tf("home.update.progressUnknown", { received: formatMegabytes(status.received) })
        : tf("home.update.progress", { received: formatMegabytes(status.received), total: formatMegabytes(status.total) })
      : "";
  const percent = status.state === "downloading" && status.total ? Math.min(100, Math.round((status.received / status.total) * 100)) : null;

  return (
    <Dialog titleId={titleId} onClose={update.closeDialog} initialFocus={() => later.current} busy={readyInstalling}>
      <header className="ws-dlg__head">
        <h2 id={titleId} className="ws-dlg__title">
          {tf("home.update.dlg.title", { v: version })}
        </h2>
        {release?.date && <span className="hm-udlg__date">{release.date}</span>}
      </header>
      <div className="ws-dlg__body hm-udlg__body">
        {warning && (
          <p className="ws-note ws-note--warn" data-testid="update-warning">
            <Icon name="alert" size={14} />
            <span>{t(WARNING_TEXT[warning])}</span>
          </p>
        )}
        {failed && (
          <p className="ws-note ws-note--warn" role="alert">
            <Icon name="alert" size={14} />
            <span>{t(failed === "download" ? "home.update.dlg.failed.download" : "home.update.dlg.failed.install")}</span>
          </p>
        )}
        {downloading && (
          <div className="hm-udlg__progress">
            <div
              className="hm-usage__bar"
              role="progressbar"
              aria-label={t("home.update.dlg.progressLabel")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
              aria-valuetext={progressText}
            >
              <span style={{ width: `${percent ?? 100}%` }} />
            </div>
            <p className="hm-update__detail">{progressText}</p>
          </div>
        )}
        {readyInstalling && <p className="hm-udlg__lead">{t("home.update.dlg.restarting")}</p>}
        {status.state === "ready" && !installing && !warning && <p className="hm-udlg__lead">{t("home.update.dlg.readyIdle")}</p>}
        {status.state === "checking" && <p className="hm-udlg__lead">{t("home.update.checking")}</p>}
        {unsupported && (
          <div className="hm-udlg__deb">
            <p className="hm-udlg__lead">{t("home.update.dlg.unsupported")}</p>
            <p className="hm-udlg__url selectable">{RELEASES_URL}</p>
          </div>
        )}
        {showNotes && (
          <section className="hm-udlg__notes" aria-label={t("home.update.dlg.notesLabel")}>
            {release.notes ? <MarkdownPreview text={release.notes} /> : <p className="hm-udlg__lead">{t("home.update.dlg.noNotes")}</p>}
            {release.notesTruncated && (
              <p className="hm-udlg__more">
                {t("home.update.dlg.truncated")} <span className="selectable">{RELEASES_URL}</span>
              </p>
            )}
          </section>
        )}
        {notice && (
          <p className="ws-dlg__error" role="alert">
            {notice}
          </p>
        )}
        {/* 끝났을 때만 알린다 — 받는 중 진행은 막대가 따로 (알리지 않는다) */}
        <span className="hm-sr" role="status">
          {status.state === "ready" ? t("home.update.dlg.readySpoken") : ""}
        </span>
      </div>
      <footer className="ws-dlg__foot">
        <span className="ws-dlg__foot-note" />
        <button type="button" className="ws-btn" ref={later} onClick={update.closeDialog} disabled={readyInstalling}>
          {t(unsupported || downloading || failed ? "home.update.dlg.close" : "home.update.dlg.later")}
        </button>
        {warning ? (
          <button type="button" className="ws-btn ws-btn--primary" onClick={() => update.install(true)}>
            {t("home.update.dlg.force")}
          </button>
        ) : failed ? (
          <button type="button" className="ws-btn ws-btn--primary" onClick={update.check}>
            {t("home.update.dlg.retry")}
          </button>
        ) : (status.state === "available" || status.state === "ready") && !readyInstalling ? (
          <button type="button" className="ws-btn ws-btn--primary" onClick={() => update.install(false)} disabled={installing}>
            {t("home.update.dlg.install")}
          </button>
        ) : null}
      </footer>
    </Dialog>
  );
}
