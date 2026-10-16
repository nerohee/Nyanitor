// 하네스 설치 · 업데이트 (plan §5, D-04 · D-05 · D-20 · D-21) — 준비 목록 · 설정에서 들어온다.
// 상태: ?screen=harness&state=install(기본 · 처음 설치 미리보기)|installing|installed|failed|update|backups
// 가짜 데이터 (fixtures-screens.ts). 실제 받기 · 설치 · 되돌리기는 P4 (install 스크립트 JSON 출력 — D-22).
import { useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { CAT_IDS } from "../../components/cat/catalog";
import { t, tf, type TextKey } from "../../i18n/ko";
import {
  BACKUPS,
  HARNESS_SOURCE,
  HARNESS_STATES,
  INSTALL_FILES,
  INSTALL_LOG,
  INSTALL_PROGRESS,
  installSteps,
  UPDATE_COMMITS,
  UPDATE_FILES,
  type BackupRow,
  type FileChange,
  type FileKind,
  type HarnessState,
  type RunStep,
} from "../fixtures-screens";
import { pickState, screenHref, withParam } from "../query";
import { Icon } from "../shared/icons";
import { Banner, Chip, Coin, DiffView, Progress, ScreenShell, Segmented, Stepper, type CoinStatus, type ScreenFrameProps } from "./parts";
import "./screens.css";

const STEPS: TextKey[] = ["variant.harness.step.preview", "variant.harness.step.install", "variant.harness.step.done"];

function countOf(files: readonly FileChange[], kind: FileKind): number {
  return files.filter((f) => f.kind === kind).reduce((sum, f) => sum + (f.count ?? 1), 0);
}

const INSTALL_ADD = countOf(INSTALL_FILES, "add");
const INSTALL_CHANGE = countOf(INSTALL_FILES, "change");

// ── 바뀌는 파일 목록 + 차이 보기 ──

type Filter = "all" | "add" | "change" | "delete";

function DiffPanel({ file }: { file: FileChange | undefined }) {
  if (!file) return <p className="hn-diff__empty muted">{t("variant.harness.diffEmpty")}</p>;
  const adds = file.diff?.filter((l) => l.sign === "+").length ?? 0;
  const dels = file.diff?.filter((l) => l.sign === "-").length ?? 0;
  let info: string;
  if (file.kind === "delete") info = t("variant.harness.diffGone");
  else if (file.kind === "add" && file.count) info = tf("variant.harness.newFolder", { n: file.count });
  else if (file.kind === "add") info = tf("variant.harness.diffNew", { n: adds });
  else info = tf("variant.harness.diffLines", { a: adds, d: dels });
  return (
    <div className="hn-diff">
      <p className="hn-diff__head">
        <code className="mono">{file.path}</code>
        <span className="muted">{info}</span>
      </p>
      {file.diff && <DiffView lines={file.diff} label={`${t("variant.harness.diff")} — ${file.path}`} />}
    </div>
  );
}

function FileList({ files, filters, mode }: { files: readonly FileChange[]; filters: readonly Filter[]; mode: "install" | "update" }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string>(files[0]?.path ?? "");
  const shown = files.filter((f) => filter === "all" || f.kind === filter);
  const file = files.find((f) => f.path === selected);
  const summary =
    mode === "install"
      ? tf("variant.harness.summary.install", { a: INSTALL_ADD, c: INSTALL_CHANGE, k: HARNESS_SOURCE.keepCount })
      : tf("variant.harness.summary.update", { a: countOf(files, "add"), c: countOf(files, "change"), d: countOf(files, "delete") });
  return (
    <section className="hn-files" aria-labelledby="hn-files-title">
      <div className="hn-files__head">
        <h2 id="hn-files-title" className="hn-h rnd">
          {t("variant.harness.files")}
          <span className="hn-h__sub">{t("variant.harness.filesIn")}</span>
        </h2>
        <span className="muted hn-files__sum">{summary}</span>
        <Segmented
          label={t("variant.harness.filter")}
          value={filter}
          onChange={setFilter}
          options={filters.map((value) => ({ value, label: t(`variant.harness.filter.${value}`) }))}
        />
      </div>
      <ul className="lst hn-list">
        {shown.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className="hn-file"
              aria-current={f.path === selected ? "true" : undefined}
              onClick={() => setSelected(f.path)}
            >
              <Chip tone={f.kind}>{t(`variant.harness.kind.${f.kind}`)}</Chip>
              <code className="hn-file__path">{f.path}</code>
              {f.count && <span className="hn-file__count">{tf("variant.harness.fileCount", { n: f.count })}</span>}
              {f.noteKey && <span className="hn-file__note">{t(f.noteKey)}</span>}
              {f.overlap && (
                <Chip tone="warn">
                  <Icon name="custom" size={12} />
                  {t("variant.harness.overlap")}
                </Chip>
              )}
            </button>
          </li>
        ))}
      </ul>
      {mode === "install" && <p className="hn-keep muted">{tf("variant.harness.keepNote", { n: HARNESS_SOURCE.keepCount })}</p>}
      <DiffPanel file={file} />
    </section>
  );
}

// ── 설치 진행 단계 ──

const RUN_COIN: Record<RunStep["status"], CoinStatus> = {
  done: "ok",
  running: "running",
  todo: "waiting",
  failed: "failed",
  undone: "undone",
};

function RunSteps({ steps }: { steps: RunStep[] }) {
  return (
    <ol className="lst hn-run">
      {steps.map((step) => (
        <li key={step.labelKey} className="hn-run__item" data-status={step.status}>
          <Coin status={RUN_COIN[step.status]} size="sm" />
          <span className="hn-run__label">{t(step.labelKey)}</span>
          <span className="hn-run__status rnd">{t(`variant.harness.run.${step.status}`)}</span>
        </li>
      ))}
    </ol>
  );
}

// ── 상태별 ──

function InstallPreview() {
  return (
    <div className="hn-grid">
      <div className="hn-side">
        <div className="box">
          <h2 className="box__title rnd">{t("variant.harness.source")}</h2>
          <p className="mono selectable hn-break">{HARNESS_SOURCE.repo}</p>
          <p className="muted su-small">
            {HARNESS_SOURCE.branch} · <code className="mono">{HARNESS_SOURCE.commit}</code> · {t("variant.fixture.harness.when")}
          </p>
        </div>
        <div className="box">
          <h2 className="box__title rnd">{t("variant.harness.target")}</h2>
          <dl className="hn-paths">
            <dt className="mono selectable">{HARNESS_SOURCE.repoDir}</dt>
            <dd className="muted">{t("variant.harness.target.repo")}</dd>
            <dt className="mono selectable">{HARNESS_SOURCE.claudeDir}</dt>
            <dd className="muted">{t("variant.harness.target.claude")}</dd>
          </dl>
        </div>
        <div className="box">
          <h2 className="box__title rnd">{t("variant.harness.backup")}</h2>
          <p className="mono selectable hn-break">{HARNESS_SOURCE.backupDir}</p>
          <p className="muted su-small">{tf("variant.harness.backupDesc", { n: INSTALL_CHANGE })}</p>
        </div>
      </div>
      <FileList files={INSTALL_FILES} filters={["all", "add", "change"]} mode="install" />
    </div>
  );
}

function UpdatePreview({ search }: { search: string }) {
  const overlaps = UPDATE_FILES.filter((f) => f.overlap);
  return (
    <div className="hn-grid">
      <div className="hn-side">
        <div className="box hn-versions">
          <div>
            <span className="muted su-small">{t("variant.harness.update.now")}</span>
            <p className="hn-ver">
              <code className="mono">{HARNESS_SOURCE.commit}</code> · {t("variant.fixture.harness.when")}
            </p>
          </div>
          <Icon name="arrow" size={20} />
          <div>
            <span className="muted su-small">{t("variant.harness.update.next")}</span>
            <p className="hn-ver">
              <code className="mono">{HARNESS_SOURCE.next}</code> · {t("variant.fixture.harness.nextWhen")}
            </p>
          </div>
        </div>
        <div className="box">
          <h2 className="box__title rnd">{tf("variant.harness.update.commits", { n: UPDATE_COMMITS.length })}</h2>
          <ul className="lst hn-commits">
            {UPDATE_COMMITS.map((c) => (
              <li key={c.hash}>
                <code className="mono muted">{c.hash}</code>
                <span>{t(c.textKey)}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="muted su-small hn-checked">
          {tf("variant.harness.update.checked", { when: t("variant.fixture.setup.when") })}
          <button type="button" className="hbtn hbtn--ghost">
            <Icon name="refresh" size={16} />
            {t("variant.ui.recheck")}
          </button>
        </p>
      </div>
      <div className="hn-files-wrap">
        {overlaps.length > 0 && (
          <Banner
            tone="warn"
            title={tf("variant.harness.update.overlapTitle", { n: overlaps.length })}
            actions={
              <a className="hbtn" href={screenHref(search, "edit", { state: "conflict" })}>
                <Icon name="custom" size={18} />
                {t("variant.harness.update.overlapGo")}
              </a>
            }
          >
            <p>
              <code className="mono">{overlaps.map((f) => f.path).join(", ")}</code>
            </p>
            <p className="muted su-small">{t("variant.harness.update.overlapBody")}</p>
          </Banner>
        )}
        <FileList files={UPDATE_FILES} filters={["all", "add", "change", "delete"]} mode="update" />
      </div>
    </div>
  );
}

function Installing() {
  return (
    <div className="hn-center">
      <div className="hn-progress">
        <div className="hn-progress__cat" aria-hidden="true">
          <CatFigure cat="dubu" pose="walk" />
        </div>
        <div className="hn-progress__main">
          <h2 className="hn-h rnd">{t("variant.harness.installing.title")}</h2>
          <p className="muted">{t("variant.harness.installing.cat")}</p>
          <Progress label={t("variant.harness.installing.title")} value={INSTALL_PROGRESS.written} max={INSTALL_PROGRESS.total} />
          <p className="hn-progress__line">
            <span className="rnd">
              {tf("variant.harness.installing.count", { n: INSTALL_PROGRESS.written, total: INSTALL_PROGRESS.total })}
            </span>
            <span className="muted">
              {t("variant.harness.installing.file")} <code className="mono">{INSTALL_PROGRESS.file}</code>
            </span>
          </p>
        </div>
      </div>
      <RunSteps steps={installSteps("installing")} />
    </div>
  );
}

function Installed({ search }: { search: string }) {
  return (
    <div className="hn-center">
      <Banner tone="ok" live title={t("variant.harness.installed.title")}>
        <p>{t("variant.harness.installed.body")}</p>
      </Banner>
      <ul className="su-shelf hn-shelf" aria-hidden="true">
        {CAT_IDS.map((cat, i) => (
          <li key={cat} className="su-shelf__cat">
            <CatFigure cat={cat} pose={i % 2 ? "loaf" : "sit"} />
          </li>
        ))}
      </ul>
      <dl className="kv hn-done">
        <dt>{t("variant.harness.files")}</dt>
        <dd>{tf("variant.harness.installed.files", { a: INSTALL_ADD, c: INSTALL_CHANGE })}</dd>
        <dt>{t("variant.harness.backup")}</dt>
        <dd className="mono selectable">{HARNESS_SOURCE.backupDir}</dd>
      </dl>
      <div className="su-howto__actions">
        <a className="hbtn hbtn--primary" href={screenHref(search, "house")}>
          <Icon name="house" size={18} />
          {t("variant.harness.installed.home")}
        </a>
        <a className="hbtn" href={screenHref(search, "setup", { state: "ready" })}>
          {t("variant.harness.installed.setup")}
        </a>
      </div>
    </div>
  );
}

function Failed() {
  return (
    <div className="hn-center">
      <Banner tone="danger" live title={t("variant.harness.failed.title")}>
        <p>{t("variant.harness.failed.body")}</p>
        <p>
          <Icon name="undo" size={14} /> {tf("variant.harness.failed.undone", { n: 3 })}
        </p>
      </Banner>
      <RunSteps steps={installSteps("failed")} />
      <p className="su-howto__tip">{t("variant.harness.failed.tip")}</p>
      <details className="su-raw">
        <summary>{t("variant.harness.failed.log")}</summary>
        <pre className="selectable">{INSTALL_LOG.join("\n")}</pre>
      </details>
    </div>
  );
}

function Backups() {
  const [asking, setAsking] = useState<string | null>(null);
  return (
    <div className="hn-center hn-backups">
      <dl className="kv">
        <dt>{t("variant.harness.backups.where")}</dt>
        <dd className="hn-where">
          <code className="mono selectable">{HARNESS_SOURCE.backupsRoot}</code>
          <button type="button" className="hbtn hbtn--ghost">
            <Icon name="folder" size={16} />
            {t("variant.ui.openFolder")}
          </button>
        </dd>
      </dl>
      <ul className="lst hn-blist">
        {BACKUPS.map((b: BackupRow) => (
          <li key={b.id} className="hn-backup">
            <div className="hn-backup__row">
              <span className="hn-backup__icon" aria-hidden="true">
                <Icon name="folder" size={18} />
              </span>
              <div className="hn-backup__text">
                <span className="rnd hn-backup__when">{t(b.whenKey)}</span>
                <span className="muted su-small">
                  {t(b.whyKey)} · <code className="mono">{b.dir}</code> ·{" "}
                  {tf("variant.harness.backups.files", { n: b.files, size: b.size })}
                </span>
              </div>
              <button
                type="button"
                className="hbtn"
                aria-expanded={asking === b.id}
                onClick={() => setAsking(asking === b.id ? null : b.id)}
              >
                <Icon name="undo" size={18} />
                {t("variant.harness.backups.restore")}
              </button>
            </div>
            {asking === b.id && (
              <Banner
                tone="warn"
                title={tf("variant.harness.backups.confirm", { when: t(b.whenKey) })}
                actions={
                  <>
                    <button type="button" className="hbtn" onClick={() => setAsking(null)}>
                      {t("variant.ui.cancel")}
                    </button>
                    <button type="button" className="hbtn hbtn--primary">
                      <Icon name="undo" size={18} />
                      {t("variant.harness.backups.restore")}
                    </button>
                  </>
                }
              >
                <p className="muted su-small">{t("variant.harness.backups.confirmBody")}</p>
              </Banner>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const LEAD: Record<HarnessState, TextKey> = {
  install: "variant.harness.install.lead",
  installing: "variant.harness.install.lead",
  installed: "variant.harness.install.lead",
  failed: "variant.harness.install.lead",
  update: "variant.harness.update.lead",
  backups: "variant.harness.backups.lead",
};

const STEP_AT: Partial<Record<HarnessState, number>> = { install: 0, installing: 1, failed: 1, installed: 2 };

export function HarnessScreen({ search, state: rawState, time }: ScreenFrameProps) {
  const state = pickState(rawState, HARNESS_STATES);
  const backups = state === "backups";
  const mainState = state === "backups" || state === "update" ? "update" : "install";
  const step = STEP_AT[state];
  const go = (next: HarnessState) => withParam(search, "state", next === "install" ? null : next);

  let body;
  if (state === "install") body = <InstallPreview />;
  else if (state === "update") body = <UpdatePreview search={search} />;
  else if (state === "installing") body = <Installing />;
  else if (state === "installed") body = <Installed search={search} />;
  else if (state === "failed") body = <Failed />;
  else body = <Backups />;

  let foot = null;
  if (state === "install")
    foot = (
      <>
        <p className="tray__foot-note">{t("variant.harness.scriptNote")}</p>
        <a className="hbtn" href={screenHref(search, "setup", { state: "harness" })}>
          {t("variant.ui.cancel")}
        </a>
        <a className="hbtn hbtn--primary" href={go("installing")}>
          <Icon name="download" size={18} />
          {t("variant.harness.installGo")}
        </a>
      </>
    );
  else if (state === "update")
    foot = (
      <>
        <p className="tray__foot-note">{t("variant.harness.update.backupNote")}</p>
        <a className="hbtn" href={screenHref(search, "settings", { section: "harness" })}>
          {t("variant.ui.later")}
        </a>
        <button type="button" className="hbtn hbtn--primary">
          <Icon name="download" size={18} />
          {t("variant.harness.update.go")}
        </button>
      </>
    );
  else if (state === "installing")
    foot = (
      <>
        <p className="tray__foot-note">{t("variant.harness.installing.note")}</p>
        <a className="hbtn" href={go("failed")}>
          <Icon name="undo" size={18} />
          {t("variant.harness.installing.stop")}
        </a>
      </>
    );
  else if (state === "failed")
    foot = (
      <>
        <span className="tray__foot-note" />
        <a className="hbtn" href={screenHref(search, "setup", { state: "harness" })}>
          {t("variant.ui.cancel")}
        </a>
        <a className="hbtn hbtn--primary" href={go("installing")}>
          <Icon name="refresh" size={18} />
          {t("variant.harness.failed.retry")}
        </a>
      </>
    );

  return (
    <ScreenShell nav="settings" time={time} className="hn">
      <div className={state === "install" || state === "update" ? "hn-wrap" : "hn-wrap hn-wrap--fit"}>
        {/* 서랍 탭 — 쟁반 위에 걸려 있다 */}
        <nav className="dtabs hn-tabs" aria-label={t("variant.harness.tabs")}>
          <a href={go(mainState)} aria-current={!backups ? "page" : undefined}>
            <Icon name="box" size={16} />
            {t("variant.harness.tab.main")}
          </a>
          <a href={go("backups")} aria-current={backups ? "page" : undefined}>
            <Icon name="undo" size={16} />
            {t("variant.harness.tab.backups")}
          </a>
        </nav>
        <div className="tray hn-tray">
          <header className="tray__head hn-head">
            <div className="tray__titles">
              <h1 className="tray__title rnd">{t("variant.harness.title")}</h1>
              <p className="tray__lead">{t(LEAD[state])}</p>
            </div>
            {step !== undefined && <Stepper label={t("variant.harness.steps")} steps={STEPS} current={step} />}
          </header>
          <div className="tray__body hn-body">{body}</div>
          {foot && <footer className="tray__foot">{foot}</footer>}
        </div>
      </div>
    </ScreenShell>
  );
}
