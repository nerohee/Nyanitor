// 아래 적용 바 + "적용하면 바뀌는 것" — 적용 안 한 것(점) · 되돌리기(= 버리기, 확인) · 적용(요약 한 줄을 만들어 보냄 · 진행 · 결과별 표시).
// 고양이 바꾸기 같은 항목별 단추는 `extra` 자리에 (P9-03). 적용 · 버리기 전에 쓰던 글은 먼저 저장한다 (`data.flushAll`).
import { useState, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomApplyResult, CustomChanges, CustomFileDiff, CustomFileStatus } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { errorKind } from "../workspace/errors";
import { buildSummary, describeInstallFailure, errorLine } from "./format";
import { Banner, Chip, ConfirmDialog, DiffView, type ChipTone } from "./parts";
import type { EditData } from "./useCustom";

// ── 적용하면 바뀌는 것 ──

const STATUS: Record<CustomFileStatus, { tone: ChipTone; text: "edit.changes.added" | "edit.changes.changed" | "edit.changes.removed" }> = {
  added: { tone: "add", text: "edit.changes.added" },
  changed: { tone: "change", text: "edit.changes.changed" },
  removed: { tone: "delete", text: "edit.changes.removed" },
};

/** 파일 하나의 차이 — 펼친 것만 그린다 (파일이 많을 때 화면이 무거워지지 않게) */
export function FileChange({ file, initiallyOpen }: { file: CustomFileDiff; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details className="ed-file" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <code className="ed-file__path">{file.path}</code>
        <Chip tone={STATUS[file.status].tone}>{t(STATUS[file.status].text)}</Chip>
        {!file.binary && <span className="ed-file__count">{tf("edit.changes.count", { added: file.added, removed: file.removed })}</span>}
      </summary>
      {open &&
        (file.binary ? (
          <p className="ed-file__note">{t("edit.changes.binary")}</p>
        ) : (
          <>
            <DiffView lines={file.lines} label={file.path} />
            {file.truncated && <p className="ed-file__note">{t("edit.changes.truncated")}</p>}
          </>
        ))}
    </details>
  );
}

/** 상세 아래 "적용하면 바뀌는 것" — 적용 안 한 것이 없으면 아무것도 그리지 않는다 */
export function ChangesPanel({ changes }: { changes: CustomChanges | null }) {
  if (!changes) return null;
  if (changes.state === "no_git") return <p className="ed-note">{t("edit.changes.noGit")}</p>;
  if (changes.state === "failed") return <p className="ed-note">{tf("edit.changes.failed", { reason: changes.detail ?? "" })}</p>;
  if (changes.files.length === 0) return null;
  return (
    <section className="ed-sec ed-changes" aria-labelledby="ed-changes-title">
      <h3 id="ed-changes-title" className="ed-sec__title">
        {t("edit.changes.title")}
        <span className="ed-count">{changes.filesTotal}</span>
      </h3>
      {changes.files.map((file, index) => (
        <FileChange key={file.path} file={file} initiallyOpen={index < 3} />
      ))}
      {changes.filesTotal > changes.files.length && <p className="ed-note">{tf("edit.changes.more", { n: changes.filesTotal - changes.files.length })}</p>}
    </section>
  );
}

// ── 적용 결과 · 설치 실패 표시 ──

/** 설치가 실패했을 때 쉬운 말 목록 — 적용 · 되돌리기가 같이 쓴다 */
export function InstallFailure({ title, lines, children }: { title: string; lines: string[]; children?: ReactNode }) {
  return (
    <Banner tone="danger" live title={title}>
      <ul className="ed-bnr__list">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
      {children}
    </Banner>
  );
}

type Result =
  | { tone: "ok"; title: string; note?: string }
  | { tone: "warn"; title: string; lines: string[] }
  | { tone: "info"; title: string }
  | { tone: "danger"; title: string; lines: string[]; keep: boolean };

function resultOf(applied: CustomApplyResult): Result {
  if (applied.outcome === "nothing") return { tone: "info", title: t("edit.apply.nothing") };
  if (applied.outcome === "failed") return { tone: "danger", title: t("edit.apply.failed"), lines: describeInstallFailure(applied.script, applied.detail), keep: true };
  const restart = applied.script?.report?.restartNeeded === true ? t("edit.apply.restart") : undefined;
  if (applied.commit === "failed") return { tone: "warn", title: t("edit.apply.commitFailed"), lines: [applied.detail ?? t("edit.apply.commitFailedHint"), ...(restart ? [restart] : [])] };
  if (applied.commit === "no_git") return { tone: "ok", title: t("edit.apply.doneNoGit"), note: restart };
  return { tone: "ok", title: tf("edit.apply.done", { hash: applied.commitShort ?? "" }), note: restart };
}

// ── 적용 바 ──

interface Props {
  data: EditData;
  report: (kind: AppErrorKind) => void;
  /** 되돌리기 왼쪽 자리 — 고른 항목의 「고양이 바꾸기」 등 (P9-03) */
  extra?: ReactNode;
}

export function ApplyBar({ data, report, extra }: Props) {
  const list = data.list.status === "ready" ? data.list.list : null;
  const unapplied = list?.unapplied ?? null;
  const known = unapplied?.known === true;
  const count = known ? unapplied.count : 0;
  const [applying, setApplying] = useState(false);
  const [discarding, setDiscarding] = useState<null | { busy: boolean; problem: string | null }>(null);
  const [result, setResult] = useState<Result | null>(null);

  // 새로 고친 것이 늘면 "적용했어요" 는 치운다 (실패 · 경고는 이유를 읽을 수 있게 둔다) — 그려지는 중에 맞추는 방식
  const [seenCount, setSeenCount] = useState(count);
  if (count !== seenCount) {
    setSeenCount(count);
    if (count > seenCount && (result?.tone === "ok" || result?.tone === "info")) setResult(null);
  }

  const apply = async () => {
    setApplying(true);
    setResult(null);
    try {
      // 쓰던 글을 먼저 저장하고, 방금 모습으로 요약을 만든다 — 적용 중에는 또 고칠 수 없게 단추를 잠근다
      await data.flushAll();
      const [fresh, diff] = await Promise.all([ipc.customList(), ipc.customChanges().catch(() => null)]);
      const summary = fresh.unapplied.known ? buildSummary({ files: fresh.unapplied.files, diffs: diff?.files ?? null, items: fresh.items, roles: data.roles, labels: data.labels }) : null;
      const applied = await ipc.customApply(summary);
      setResult(resultOf(applied));
      await data.refreshAll();
    } catch (raw) {
      const kind = errorKind(raw);
      setResult({ tone: "danger", title: t("edit.apply.failed"), lines: [errorLine(kind)], keep: true });
      report(kind);
    } finally {
      setApplying(false);
    }
  };

  const discard = async () => {
    setDiscarding({ busy: true, problem: null });
    try {
      await data.flushAll();
      const outcome = await ipc.customDiscard();
      await data.refreshAll();
      setDiscarding(null);
      setResult(outcome.outcome === "discarded" ? { tone: "info", title: tf("edit.discard.done", { n: outcome.files }) } : { tone: "info", title: t("edit.discard.nothing") });
    } catch (raw) {
      const kind = errorKind(raw);
      setDiscarding({ busy: false, problem: errorLine(kind) });
      report(kind);
    }
  };

  const disabled = applying || list === null || !list.available;
  return (
    <div className="ed-apply" aria-busy={applying}>
      {result && (
        <div className="ed-apply__result">
          {result.tone === "danger" ? (
            <InstallFailure title={result.title} lines={result.lines}>
              {result.keep && <p className="ed-bnr__keep">{t("edit.apply.kept")}</p>}
            </InstallFailure>
          ) : result.tone === "warn" ? (
            <Banner tone="warn" live title={result.title}>
              {result.lines.map((line, index) => (
                <p key={index}>{line}</p>
              ))}
            </Banner>
          ) : (
            <Banner
              tone={result.tone}
              live
              title={result.title}
              actions={
                <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={() => setResult(null)}>
                  {t("variant.ui.dismiss")}
                </button>
              }
            >
              {result.tone === "ok" && result.note && <p>{result.note}</p>}
            </Banner>
          )}
        </div>
      )}
      <div className="ed-apply__bar">
        <p className="ed-apply__note">
          {applying ? (
            <span className="ed-apply__state">
              <span className="ed-apply__spin" aria-hidden="true" />
              {t("edit.apply.running")}
            </span>
          ) : known && count > 0 ? (
            <span className="ed-apply__state ed-apply__state--dirty">
              <span className="ws-ed__dot" aria-hidden="true" />
              {tf("edit.apply.dirty", { n: count })}
            </span>
          ) : known ? (
            <span className="ed-apply__state">{t("edit.apply.clean")}</span>
          ) : (
            <span className="ed-apply__state">{t("edit.apply.unknown")}</span>
          )}
          <span className="ed-apply__where">{t("edit.apply.note")}</span>
        </p>
        {applying && <span className="ed-apply__progress" role="progressbar" aria-label={t("edit.apply.running")} />}
        {extra}
        <button type="button" className="ws-btn" disabled={disabled || !known || count === 0} onClick={() => setDiscarding({ busy: false, problem: null })}>
          <Icon name="undo" size={16} />
          {t("edit.revert")}
        </button>
        <button type="button" className="ws-btn ws-btn--primary" disabled={disabled || (known && count === 0 && !data.unsaved)} onClick={() => void apply()}>
          <Icon name="check" size={16} />
          {t("edit.apply")}
        </button>
      </div>
      {discarding && (
        <ConfirmDialog
          titleId="ed-discard-title"
          title={tf("edit.discard.title", { n: count })}
          confirmLabel={t("edit.discard.go")}
          danger
          busy={discarding.busy}
          problem={discarding.problem}
          onConfirm={() => void discard()}
          onCancel={() => setDiscarding(null)}
        >
          <p>{t("edit.discard.body")}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
