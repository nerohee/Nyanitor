// 하네스 설치 시험 화면 (P4-02) — 개발 빌드 전용, 주소 `?lab=harness`. 디자인 없음. 진짜 하네스 화면은 따로 만든다.
// 상태(위치 · 원본 · 개발자 모드 · git · Git Bash) / 원본 받기 / 업데이트 확인 → 받기 / 미리보기 → 설치 / 백업 목록 → 되돌리기 미리보기 → 되돌리기.
// 화면은 `ipc.ts` 의 함수만 쓰고, 넘기는 값은 백업 번호 하나뿐이다. 설치 · 되돌리기는 미리보기를 본 뒤에만 켜진다.
// 맨 위에 지금 쓰는 `~/.claude` · 하네스 폴더 · 원본 경로를 크게 보인다 — 환경 변수로 정한 시험 폴더가 아니면 실제 폴더라고 경고하고,
// 쓰는 단추(받기 · 업데이트 받기 · 설치 · 되돌리기)는 "알고 있어요" 를 눌러야 켜진다.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import {
  AppError,
  ipc,
  toAppError,
  type GitResult,
  type HarnessBackupInfo,
  type HarnessStatus,
  type ScriptResult,
} from "../lib/ipc";
import {
  describeBackup,
  describeChange,
  describeFileStatus,
  describeGit,
  describeGitBash,
  describeGitInfo,
  describeLocationProblem,
  describeLocationSource,
  describeOrigin,
  describeRepo,
  describeScriptHeadline,
  describePruneSkipped,
  describeUnreadable,
  describeUpdateState,
  installSucceeded,
  isSandbox,
  planBlocker,
} from "./harnessDescribe";
import "./lab.css";

/** 브라우저(Tauri 밖)인가 — 가짜 하네스로 돈다는 안내를 보인다 */
function isBrowserFake(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}

/** 목록에 보일 최대 줄 수 (나머지는 "… 외 N개") */
const SHOW_MAX = 40;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function RawJson({ raw }: { raw: string | null }) {
  return (
    <details>
      <summary>{t("lab.harness.raw.show")}</summary>
      {raw === null ? <p className="lab-note">{t("lab.harness.raw.none")}</p> : <pre className="lab-code">{pretty(raw)}</pre>}
    </details>
  );
}

function Capped<T>({ items, render }: { items: T[]; render: (item: T) => ReactNode }) {
  const shown = items.slice(0, SHOW_MAX);
  return (
    <ul>
      {shown.map((item, index) => (
        <li key={index}>{render(item)}</li>
      ))}
      {items.length > shown.length && <li>{tf("lab.harness.update.more", { n: items.length - shown.length })}</li>}
    </ul>
  );
}

/** 받기 · 업데이트 확인 · 업데이트 받기의 결과 */
function GitResultView({ result }: { result: GitResult }) {
  const update = result.update;
  return (
    <div className="lab-card" aria-label={t("lab.harness.last")}>
      {describeGit(result).map((line, index) => (
        <p key={index} role={index === 0 ? "status" : undefined}>
          {line}
        </p>
      ))}
      {result.pulled.length > 0 && (
        <>
          <h3>{tf("lab.harness.update.pulled", { n: result.pulledTotal })}</h3>
          <Capped
            items={result.pulled}
            render={(c) => (
              <>
                <code>{c.hash}</code> {c.date} {c.subject}
              </>
            )}
          />
          {result.pulledTotal > result.pulled.length && (
            <p className="lab-note">{tf("lab.harness.update.more", { n: result.pulledTotal - result.pulled.length })}</p>
          )}
        </>
      )}
      {update && (
        <>
          <p>{describeUpdateState(update)}</p>
          {update.dirty && <p className="lab-error">{t("lab.harness.update.dirty")}</p>}
          {update.commits.length > 0 && (
            <>
              <h3>{t("lab.harness.update.commits")}</h3>
              <Capped
                items={update.commits}
                render={(c) => (
                  <>
                    <code>{c.hash}</code> {c.date} {c.subject}
                  </>
                )}
              />
              {update.commitsTotal > update.commits.length && (
                <p className="lab-note">{tf("lab.harness.update.more", { n: update.commitsTotal - update.commits.length })}</p>
              )}
            </>
          )}
          {update.filesTotal > 0 && (
            <>
              <h3>{tf("lab.harness.update.files", { n: update.filesTotal })}</h3>
              <Capped
                items={update.files}
                render={(f) => (
                  <>
                    {describeFileStatus(f.status)} — <code>{f.path}</code>
                  </>
                )}
              />
              {update.filesTotal > update.files.length && (
                <p className="lab-note">{tf("lab.harness.update.more", { n: update.filesTotal - update.files.length })}</p>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** 설치 스크립트를 돌린 결과 (미리보기 · 설치 · 목록 · 되돌리기 공통) */
function ScriptResultView({ result, kind }: { result: ScriptResult; kind: "plan" | "install" | "backups" | "restore" }) {
  const report = result.report;
  const unreadable = describeUnreadable(result);
  const wrote = kind === "install" || kind === "restore";
  return (
    <div className="lab-card" aria-label={t("lab.harness.last")}>
      <p role="status">{describeScriptHeadline(result)}</p>
      {unreadable && (
        <div role="alert" className="lab-error">
          <p>{unreadable}</p>
          <dl className="lab-facts">
            <Fact label={t("lab.harness.unreadable.head")}>
              <code className="lab-code">{result.unreadable?.head}</code>
            </Fact>
            {result.unreadable?.stderrHead ? (
              <Fact label={t("lab.harness.unreadable.stderrHead")}>
                <code className="lab-code">{result.unreadable.stderrHead}</code>
              </Fact>
            ) : null}
          </dl>
        </div>
      )}
      {result.detail && <p className="lab-error">{result.detail}</p>}
      {wrote && report && (
        <p role="status">
          {kind === "install"
            ? t(installSucceeded(result) ? "lab.harness.result.installOk" : "lab.harness.result.installFailed")
            : t(report.ok && result.exitCode === 0 ? "lab.harness.result.restoreOk" : "lab.harness.result.restoreFailed")}
        </p>
      )}
      {wrote && report?.rolledBack !== null && report?.rolledBack !== undefined && (
        <p>{t(report.rolledBack ? "lab.harness.result.rolledBackYes" : "lab.harness.result.rolledBackNo")}</p>
      )}
      {result.restoreAdvised && (
        <p className="lab-error">{t(result.outcome === "unreadable" ? "lab.harness.result.restoreAdvisedUnknown" : "lab.harness.result.restoreAdvised")}</p>
      )}
      {(result.script || report?.repo) && (
        <dl className="lab-facts">
          {result.script && (
            <Fact label={t("lab.harness.result.script")}>
              <code>{result.script}</code>
            </Fact>
          )}
          {report?.repo && (
            <Fact label={t("lab.harness.result.repoSeen")}>
              <code>{report.repo}</code>
            </Fact>
          )}
        </dl>
      )}
      {report && kind !== "backups" && (
        <>
          <p>{tf("lab.harness.report.counts", { ...report.counts })}</p>
          {report.same && <p>{t("lab.harness.report.same")}</p>}
          <dl className="lab-facts">
            {report.mode && (
              <Fact label={t("lab.harness.report.mode")}>
                {report.mode === "copy" ? t("lab.harness.report.modeCopy") : report.mode === "link" ? t("lab.harness.report.modeLink") : report.mode}
              </Fact>
            )}
            {report.existingSource && (
              <Fact label={t("lab.harness.report.existing")}>
                <code>{report.existingSource}</code>
              </Fact>
            )}
          </dl>
          {report.developerMode && <p className="lab-note">{t("lab.harness.report.developer")}</p>}
          {report.restartNeeded && <p>{t("lab.harness.report.restart")}</p>}
          {report.originChanged.length > 0 && <p>{tf("lab.harness.report.originChanged", { n: report.originChanged.length })}</p>}
          {report.problems.length > 0 && (
            <>
              <h3>{t("lab.harness.report.problems")}</h3>
              <Capped items={report.problems} render={(p) => `${p.reason}${p.path ? ` — ${p.path}` : ""}${p.detail ? ` (${p.detail})` : ""}`} />
            </>
          )}
          {report.warnings.length > 0 && (
            <>
              <h3>{t("lab.harness.report.warnings")}</h3>
              <Capped items={report.warnings} render={(w) => `${w.reason}${w.path ? ` — ${w.path}` : ""}${w.detail ? ` (${w.detail})` : ""}`} />
            </>
          )}
          {report.error && (
            <p className="lab-error">{tf("lab.harness.report.errorLine", { code: report.error.code, detail: report.error.detail ?? t("lab.none") })}</p>
          )}
          {report.changes.length > 0 && (
            <>
              <h3>{t("lab.harness.report.changes")}</h3>
              <Capped items={report.changes} render={describeChange} />
            </>
          )}
        </>
      )}
      {report?.backup && wrote && <p>{tf("lab.harness.result.backupMade", { id: report.backup.id, files: report.backup.files })}</p>}
      {kind === "install" && report && installSucceeded(result) && !report.backup && <p>{t("lab.harness.result.noBackup")}</p>}
      {result.prune && (
        <div>
          <p>
            {result.prune.removed > 0
              ? tf("lab.harness.result.pruned", { removed: result.prune.removed, kept: result.prune.kept })
              : tf("lab.harness.result.prunedNone", { kept: result.prune.kept })}
          </p>
          {result.prune.skipped && (
            <p className="lab-error">{tf("lab.harness.result.pruneSkipped", { reason: describePruneSkipped(result.prune.skipped) })}</p>
          )}
          {result.prune.skippedEntries.length > 0 && (
            <p className="lab-error">{tf("lab.harness.result.pruneSkippedEntries", { names: result.prune.skippedEntries.join(", ") })}</p>
          )}
          {result.prune.failed.length > 0 && <p className="lab-error">{tf("lab.harness.result.pruneFailed", { ids: result.prune.failed.join(", ") })}</p>}
        </div>
      )}
      <RawJson raw={result.raw} />
    </div>
  );
}

export default function HarnessLab() {
  const [status, setStatus] = useState<HarnessStatus | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [realOk, setRealOk] = useState(false);

  const [cloneOut, setCloneOut] = useState<GitResult | null>(null);
  const [updateOut, setUpdateOut] = useState<GitResult | null>(null);
  /** 가장 최근 업데이트 확인 결과 (받기 단추의 조건) — 받기 · 설치 같은 쓰는 일 뒤에는 지운다 */
  const [checked, setChecked] = useState<GitResult | null>(null);
  const [planOut, setPlanOut] = useState<ScriptResult | null>(null);
  /** 미리보기 뒤에 쓰는 일이 없었다 */
  const [planFresh, setPlanFresh] = useState(false);
  const [installOut, setInstallOut] = useState<ScriptResult | null>(null);
  const [backups, setBackups] = useState<HarnessBackupInfo[] | null>(null);
  const [backupsOut, setBackupsOut] = useState<ScriptResult | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [restorePlanOut, setRestorePlanOut] = useState<ScriptResult | null>(null);
  /** 되돌리기 미리보기를 본 백업 번호 (그 번호만 되돌릴 수 있다) */
  const [restorePlanned, setRestorePlanned] = useState<string | null>(null);
  const [restoreOut, setRestoreOut] = useState<ScriptResult | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatus(await ipc.harnessStatus());
  }, []);

  /** 명령 하나를 돌린다 — 도는 동안 모든 단추가 꺼지고, 실패하면 오류 종류에 맞는 문구를 보인다 */
  const act = useCallback(async (label: string, work: () => Promise<void>) => {
    setPending(label);
    setError(null);
    try {
      await work();
    } catch (raw) {
      setError(toAppError(raw));
    } finally {
      setPending(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    ipc.harnessStatus().then(
      (found) => {
        if (!cancelled) setStatus(found);
      },
      (raw: unknown) => {
        if (!cancelled) setError(toAppError(raw));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  /** 쓰는 일이 있었으면 미리보기 · 확인 결과는 낡은 것이다 */
  const afterWrite = () => {
    setPlanFresh(false);
    setChecked(null);
    setRestorePlanned(null);
  };

  // 시험 폴더인가: 환경 변수로 정했고 **기본 위치와 다를 때만** (환경 변수가 기본 위치를 가리키면 실제 폴더라 안전장치가 켜진다)
  const sandbox = isBrowserFake() || (status !== null && isSandbox(status));
  const locationsKnown = status !== null && status.claudeDir !== null && status.harnessHome !== null;
  const canWrite = pending === null && locationsKnown && (sandbox || realOk);
  const idle = pending === null;
  const gitOk = status?.git.found === true;
  const dev = status?.developerMode === true;
  const repoPresent = status?.repo?.present === true;
  const repoUsable = status?.repo?.usable !== false;
  const hasScript = status?.scriptPath != null;

  const installBlocker = planBlocker(planOut, planFresh);
  const pickedInfo = backups?.find((b) => b.id === picked) ?? null;

  const doClone = () =>
    act("clone", async () => {
      setCloneOut(await ipc.harnessClone());
      afterWrite();
      await refreshStatus();
    });

  const doCheck = () =>
    act("check", async () => {
      const result = await ipc.harnessUpdateCheck();
      setUpdateOut(result);
      setChecked(result);
      await refreshStatus();
    });

  const doPull = () =>
    act("pull", async () => {
      const result = await ipc.harnessUpdatePull();
      setUpdateOut(result);
      afterWrite();
      await refreshStatus();
    });

  const doPlan = () =>
    act("plan", async () => {
      const result = await ipc.harnessInstallPlan();
      setPlanOut(result);
      setPlanFresh(true);
      await refreshStatus();
    });

  const doInstall = () =>
    act("install", async () => {
      const result = await ipc.harnessInstall();
      setInstallOut(result);
      afterWrite();
      // 설치 뒤 백업이 늘거나 정리됐으니 목록은 다시 불러오게 비운다
      setBackups(null);
      setPicked(null);
      await refreshStatus();
    });

  const doBackups = () =>
    act("backups", async () => {
      const result = await ipc.harnessBackups();
      setBackupsOut(result);
      setBackups(result.report?.backups ?? null);
      setPicked(null);
      setRestorePlanned(null);
    });

  const doRestorePlan = (id: string) =>
    act("restorePlan", async () => {
      const result = await ipc.harnessRestorePlan(id);
      setRestorePlanOut(result);
      setRestorePlanned(result.outcome === "ran" && result.report?.ok ? id : null);
    });

  const doRestore = (id: string) =>
    act("restore", async () => {
      const result = await ipc.harnessRestore(id);
      setRestoreOut(result);
      afterWrite();
      setBackups(null);
      setPicked(null);
      await refreshStatus();
    });

  const restoreReady = pickedInfo !== null && picked !== null && restorePlanned === picked;

  return (
    <main className="lab-session" data-testid="harness-lab">
      <header>
        <p>
          <a href="./">{t("lab.back")}</a>
        </p>
        <h1>{t("lab.harness.title")}</h1>
        <p className="lab-note">{t("lab.harness.note")}</p>
        {isBrowserFake() && <p className="lab-note">{t("lab.harness.fakeMode")}</p>}
      </header>

      {error && (
        <p role="alert" className="lab-error">
          {t(`error.${error.kind}`)}
        </p>
      )}
      {pending !== null && (
        <p role="status" className="lab-note">
          {t("lab.harness.busy")}
        </p>
      )}

      <section aria-labelledby="hl-where" className={sandbox ? "lab-where" : "lab-where lab-where-real"} data-testid="harness-where">
        <h2 id="hl-where">{t("lab.harness.where.title")}</h2>
        {status === null && <p>{t("lab.harness.status.checking")}</p>}
        {status && !locationsKnown && <p role="alert">{describeLocationProblem(status.problem ?? "no_home")}</p>}
        {status && locationsKnown && (
          <>
            <dl className="lab-facts lab-where-facts">
              <Fact label={t("lab.harness.where.claudeDir")}>
                <code>{status.claudeDir}</code>
              </Fact>
              <Fact label={t("lab.harness.where.home")}>
                <code>{status.harnessHome}</code>
              </Fact>
              <Fact label={t("lab.harness.where.source")}>
                {status.sourceDir && (status.developerMode || status.repo?.present) ? <code>{status.sourceDir}</code> : t("lab.harness.where.sourceNone")}
              </Fact>
            </dl>
            <p>{describeLocationSource(status)}</p>
            {status.sourceIsNetwork && (
              <p role="alert" className="lab-error">
                {t("lab.harness.where.network")}
              </p>
            )}
            {!sandbox && (
              <>
                <p role="alert" className="lab-error">
                  {t("lab.harness.where.realWarn")}
                </p>
                <label className="lab-option">
                  <input type="checkbox" checked={realOk} onChange={(event) => setRealOk(event.target.checked)} />
                  {t("lab.harness.where.realOk")}
                </label>
              </>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="hl-status">
        <h2 id="hl-status">{t("lab.harness.status.title")}</h2>
        {status && locationsKnown && (
          <dl className="lab-facts">
            <Fact label={t("lab.harness.status.git")}>{describeGitInfo(status)}</Fact>
            <Fact label={t("lab.harness.status.gitBash")}>{describeGitBash(status)}</Fact>
            <Fact label={t("lab.harness.status.dev")}>{t(status.developerMode ? "lab.harness.status.devYes" : "lab.harness.status.devNo")}</Fact>
            <Fact label={t("lab.harness.status.origin")}>{describeOrigin(status.origin)}</Fact>
            <Fact label={t("lab.harness.status.repo")}>{describeRepo(status)}</Fact>
            <Fact label={t("lab.harness.status.script")}>
              {status.scriptPath ? <code>{status.scriptPath}</code> : t("lab.harness.status.scriptNone")}
            </Fact>
            <Fact label={t("lab.harness.status.keep")}>{tf("lab.harness.status.keepValue", { n: status.keepBackups })}</Fact>
          </dl>
        )}
        <div className="lab-row">
          <button type="button" disabled={!idle} onClick={() => void act("status", refreshStatus)}>
            {t("lab.harness.status.recheck")}
          </button>
        </div>
      </section>

      <section aria-labelledby="hl-clone">
        <h2 id="hl-clone">{t("lab.harness.clone.title")}</h2>
        <p className="lab-note">{t("lab.harness.clone.hint")}</p>
        <div className="lab-row">
          <button type="button" disabled={!canWrite || !gitOk || dev || repoPresent} onClick={() => void doClone()}>
            {t("lab.harness.clone.button")}
          </button>
        </div>
        {cloneOut && <GitResultView result={cloneOut} />}
      </section>

      <section aria-labelledby="hl-update">
        <h2 id="hl-update">{t("lab.harness.update.title")}</h2>
        <p className="lab-note">{t("lab.harness.update.hint")}</p>
        <div className="lab-row">
          <button type="button" disabled={!idle || !gitOk || dev || !repoPresent || !repoUsable} onClick={() => void doCheck()}>
            {t("lab.harness.update.check")}
          </button>
          <button type="button" disabled={!canWrite || checked?.update?.canPull !== true} onClick={() => void doPull()}>
            {t("lab.harness.update.pull")}
          </button>
          {checked?.update?.canPull !== true && <span className="lab-note">{t("lab.harness.update.needCheck")}</span>}
        </div>
        {updateOut && <GitResultView result={updateOut} />}
      </section>

      <section aria-labelledby="hl-install">
        <h2 id="hl-install">{t("lab.harness.install.title")}</h2>
        <p className="lab-note">{t("lab.harness.install.hint")}</p>
        <div className="lab-row">
          <button type="button" disabled={!idle || !hasScript} onClick={() => void doPlan()}>
            {t("lab.harness.install.plan")}
          </button>
          <button type="button" disabled={!canWrite || installBlocker !== null} onClick={() => void doInstall()}>
            {t("lab.harness.install.button")}
          </button>
          {installBlocker !== null && <span className="lab-note">{installBlocker}</span>}
        </div>
        {planOut && <ScriptResultView result={planOut} kind="plan" />}
        {installOut && <ScriptResultView result={installOut} kind="install" />}
      </section>

      <section aria-labelledby="hl-backups">
        <h2 id="hl-backups">{t("lab.harness.backups.title")}</h2>
        <p className="lab-note">{t("lab.harness.backups.hint")}</p>
        <div className="lab-row">
          <button type="button" disabled={!idle || !hasScript} onClick={() => void doBackups()}>
            {t("lab.harness.backups.list")}
          </button>
        </div>
        {backups !== null && backups.length === 0 && <p className="lab-note">{t("lab.harness.backups.empty")}</p>}
        {backups !== null && backups.length > 0 && (
          <ul className="lab-backups">
            {backups.map((backup) => (
              <li key={backup.id}>
                <label className="lab-option">
                  <input
                    type="radio"
                    name="backup"
                    aria-label={tf("lab.harness.backups.pick", { id: backup.id })}
                    checked={picked === backup.id}
                    disabled={!idle || !backup.readable}
                    onChange={() => {
                      setPicked(backup.id);
                      setRestorePlanned(null);
                      setRestorePlanOut(null);
                    }}
                  />
                  {describeBackup(backup)}
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="lab-note">{picked ? tf("lab.harness.backups.picked", { id: picked }) : t("lab.harness.backups.none")}</p>
        <div className="lab-row">
          <button type="button" disabled={!idle || picked === null} onClick={() => picked && void doRestorePlan(picked)}>
            {t("lab.harness.backups.restorePlan")}
          </button>
          <button type="button" disabled={!canWrite || !restoreReady} onClick={() => picked && void doRestore(picked)}>
            {t("lab.harness.backups.restore")}
          </button>
          {!restoreReady && <span className="lab-note">{t("lab.harness.backups.needPlan")}</span>}
        </div>
        {backupsOut && <ScriptResultView result={backupsOut} kind="backups" />}
        {restorePlanOut && <ScriptResultView result={restorePlanOut} kind="plan" />}
        {restoreOut && <ScriptResultView result={restoreOut} kind="restore" />}
      </section>

      {!cloneOut && !updateOut && !planOut && !installOut && !backupsOut && !restorePlanOut && !restoreOut && (
        <p className="lab-note">{t("lab.harness.nothingYet")}</p>
      )}
    </main>
  );
}
