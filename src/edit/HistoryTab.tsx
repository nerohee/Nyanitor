// 기록 탭 — 왼쪽 세로 줄 기록(종류 아이콘 · 메시지 · 언제 · 짧은 번호, 맨 위에 「지금」), 오른쪽 고른 커밋의 차이 + 「이때로 되돌리기」(확인 띠 → 새 커밋 + 설치).
// git 이 없으면(`no_git`) · 아직 시작 전이면(`not_started`) 그 사정만 알린다 — 고치기 · 적용은 된다.
import { useEffect, useState } from "react";
import { t, tf } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomCommit, CustomCommitDiff, CustomCommitKind, CustomHistory, CustomRestoreResult } from "../lib/ipc-types";
import { Icon, type IconName } from "../variants/shared/icons";
import { errorKind } from "../workspace/errors";
import { FileChange, InstallFailure } from "./ApplyBar";
import { describeInstallFailure, errorLine, formatWhen } from "./format";
import { Banner, Chip } from "./parts";
import type { EditData } from "./useCustom";

const KIND_ICON: Record<CustomCommitKind, IconName> = {
  apply: "custom",
  new: "plus",
  restore: "undo",
  origin_update: "download",
  cats: "paw",
  start: "flag",
  other: "dot",
};

type HistoryState = { status: "loading" } | { status: "failed"; kind: AppErrorKind } | { status: "ready"; history: CustomHistory };
type DiffState = { status: "loading" } | { status: "failed"; kind: AppErrorKind } | { status: "ready"; diff: CustomCommitDiff };

interface Props {
  data: EditData;
  report: (kind: AppErrorKind) => void;
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  now: Date;
}

export function HistoryTab({ data, report, now }: Props) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [current, setCurrent] = useState<string | null>(null);

  // 처음 · 큰 바뀜(적용 · 되돌리기 …)마다 다시 읽는다
  useEffect(() => {
    let alive = true;
    ipc.customHistory().then(
      (history) => alive && setState({ status: "ready", history }),
      (raw) => alive && setState({ status: "failed", kind: errorKind(raw) }),
    );
    return () => {
      alive = false;
    };
  }, [data.rev]);

  const commits = state.status === "ready" ? state.history.commits : [];
  const selected = commits.find((commit) => commit.hash === current) ?? commits[0] ?? null;

  if (state.status === "loading")
    return (
      <p className="ed-state" role="status">
        {t("edit.hist.loading")}
      </p>
    );
  if (state.status === "failed")
    return (
      <div className="ed-state" role="alert">
        <p>{tf("edit.hist.failed", { reason: errorLine(state.kind) })}</p>
      </div>
    );
  const { history } = state;
  if (history.state !== "ok")
    return (
      <div className="ed-state" role={history.state === "failed" ? "alert" : "status"}>
        <p className="ed-state__title">{t(history.state === "no_git" ? "edit.hist.noGitTitle" : history.state === "not_started" ? "edit.hist.notStartedTitle" : "edit.hist.failedTitle")}</p>
        <p>{history.state === "failed" ? (history.detail ?? "") : t(history.state === "no_git" ? "edit.hist.noGit" : "edit.hist.notStarted")}</p>
      </div>
    );
  if (commits.length === 0 || !selected)
    return (
      <div className="ed-state" role="status">
        <p>{t("edit.hist.empty")}</p>
      </div>
    );

  return (
    <div className="ed-split">
      <nav className="ed-list" aria-label={t("edit.hist.list")}>
        <p className="ed-list__note">{t("edit.hist.note")}</p>
        <ol className="ed-hist">
          {commits.map((commit, index) => (
            <li key={commit.hash}>
              <button type="button" className="ed-hist__item" aria-current={commit.hash === selected.hash ? "true" : undefined} onClick={() => setCurrent(commit.hash)}>
                <span className="ed-hist__dot" data-kind={commit.kind} aria-hidden="true">
                  <Icon name={KIND_ICON[commit.kind]} size={14} />
                </span>
                <span className="ed-hist__text">
                  <span className="ed-hist__msg">{commit.message}</span>
                  <span className="ed-hist__when">
                    {formatWhen(commit.date, now)} · <code>{commit.short}</code>
                    {index === 0 && <Chip tone="accent">{t("edit.hist.now")}</Chip>}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {history.truncated && <li className="ed-hist__more">{tf("edit.hist.more", { n: commits.length })}</li>}
        </ol>
      </nav>
      <CommitPanel key={selected.hash} commit={selected} isNow={selected.hash === commits[0]!.hash} data={data} report={report} now={now} />
    </div>
  );
}

function CommitPanel({ commit, isNow, data, report, now }: { commit: CustomCommit; isNow: boolean; data: EditData; report: (kind: AppErrorKind) => void; now: Date }) {
  const [state, setState] = useState<DiffState>({ status: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<CustomRestoreResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc.customCommitDiff(commit.hash).then(
      (diff) => alive && setState({ status: "ready", diff }),
      (raw) => alive && setState({ status: "failed", kind: errorKind(raw) }),
    );
    return () => {
      alive = false;
    };
  }, [commit.hash]);

  const restore = async () => {
    setRunning(true);
    setProblem(null);
    try {
      await data.flushAll();
      const result = await ipc.customRestore(commit.hash);
      setDone(result);
      setConfirming(false);
      // 되돌렸으면 새 커밋이 생겼다 — 기록 · 목록 · 바뀌는 것을 다시 읽는다
      if (result.outcome === "restored") await data.refreshAll();
      else await data.refresh();
    } catch (raw) {
      const kind = errorKind(raw);
      setProblem(errorLine(kind));
      report(kind);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="ed-panel" aria-labelledby="ed-hist-title">
      <header className="ed-panel__head">
        <div className="ed-panel__titles">
          <h2 id="ed-hist-title" className="ed-panel__title">
            {commit.message}
          </h2>
          <p className="ed-panel__sub">
            {formatWhen(commit.date, now)} · <code>{commit.short}</code>
            {commit.files.length > 0 && (
              <>
                {" · "}
                {commit.files.join(", ")}
                {commit.filesTotal > commit.files.length ? ` ${tf("edit.hist.filesMore", { n: commit.filesTotal - commit.files.length })}` : ""}
              </>
            )}
          </p>
        </div>
      </header>
      <div className="ed-panel__scroll">
        {done && <RestoreResult result={done} short={commit.short} />}
        {problem && <Banner tone="danger" live title={problem} />}
        {state.status === "loading" && (
          <p className="ed-state" role="status">
            {t("edit.hist.diffLoading")}
          </p>
        )}
        {state.status === "failed" && <Banner tone="danger" live title={tf("edit.hist.failed", { reason: errorLine(state.kind) })} />}
        {state.status === "ready" && <DiffBody diff={state.diff} commit={commit} />}
        {confirming && (
          <Banner
            tone="warn"
            title={tf("edit.hist.undoTitle", { hash: commit.short })}
            actions={
              <>
                <button type="button" className="ws-btn ws-btn--primary" disabled={running} onClick={() => void restore()}>
                  {running ? t("edit.hist.undoing") : t("edit.hist.undoGo")}
                </button>
                <button type="button" className="ws-btn" disabled={running} onClick={() => setConfirming(false)}>
                  {t("variant.ui.cancel")}
                </button>
              </>
            }
          >
            <p>{t("edit.hist.undoBody")}</p>
          </Banner>
        )}
      </div>
      <footer className="ed-foot">
        <p className="ed-foot__note">{t("edit.hist.foot")}</p>
        {!isNow && (
          <button type="button" className="ws-btn" aria-expanded={confirming} disabled={running} onClick={() => setConfirming(true)}>
            <Icon name="undo" size={16} />
            {t("edit.hist.undoHere")}
          </button>
        )}
      </footer>
    </section>
  );
}

function DiffBody({ diff, commit }: { diff: CustomCommitDiff; commit: CustomCommit }) {
  if (diff.state !== "ok") {
    if (diff.state === "failed") return <p className="ed-note">{diff.detail}</p>;
    const key = diff.state === "unknown_commit" ? "edit.hist.unknownCommit" : diff.state === "no_git" ? "edit.hist.noGit" : "edit.hist.notStarted";
    return <p className="ed-note">{t(key)}</p>;
  }
  if (diff.files.length === 0) return <p className="ed-note">{commit.kind === "origin_update" ? t("edit.hist.updateOnly") : t("edit.hist.noFiles")}</p>;
  return (
    <>
      {diff.files.map((file, index) => (
        <FileChange key={file.path} file={file} initiallyOpen={index < 3} />
      ))}
      {diff.filesTotal > diff.files.length && <p className="ed-note">{tf("edit.changes.more", { n: diff.filesTotal - diff.files.length })}</p>}
    </>
  );
}

/** 되돌리기 결과 — 결과마다 쉬운 말 (설치 실패는 적용 실패와 같은 표시) */
function RestoreResult({ result, short }: { result: CustomRestoreResult; short: string }) {
  switch (result.outcome) {
    case "restored":
      return <Banner tone="ok" live title={tf("edit.hist.undone", { hash: short })} />;
    case "has_unapplied":
      return <Banner tone="warn" live title={t("edit.hist.hasUnapplied")} />;
    case "same_as_now":
      return <Banner tone="info" live title={t("edit.hist.sameAsNow")} />;
    case "unknown_commit":
      return <Banner tone="danger" live title={t("edit.hist.unknownCommit")} />;
    case "no_git":
      return <Banner tone="info" live title={t("edit.hist.noGit")} />;
    case "not_started":
      return <Banner tone="info" live title={t("edit.hist.notStarted")} />;
    default:
      return (
        <InstallFailure title={t("edit.hist.undoFailed")} lines={[...(result.outcome === "rollback_failed" ? [t("edit.hist.rollbackFailed")] : []), ...describeInstallFailure(result.script, result.detail)]}>
          <p className="ed-bnr__keep">{t("edit.apply.kept")}</p>
        </InstallFailure>
      );
  }
}
