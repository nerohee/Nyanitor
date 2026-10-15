// 첫 실행 · 준비 (plan §5) — 준비가 안 됐을 때 "집" 자리에 뜬다. 빠진 것은 맨 위 하나만 펼쳐 안내하고 다시 확인한다.
// 상태: ?screen=setup&state=login(기본 · 하나 빠짐)|checking|fresh|git|harness|failed|ready|apikey
// 가짜 데이터 (fixtures-screens.ts). 실제 확인 · 터미널 열기는 P3 · P4 (IPC 모양은 지시서 보고).
import { useEffect, useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { CAT_IDS } from "../../components/cat/catalog";
import { t, tf, type TextKey } from "../../i18n/ko";
import {
  activeCheck,
  SETUP_COMMANDS,
  SETUP_FAILED_RAW,
  SETUP_STATES,
  setupChecks,
  type CheckRow,
  type SetupState,
} from "../fixtures-screens";
import { pickState, screenHref } from "../query";
import { Icon } from "../shared/icons";
import { Banner, Chip, Coin, CommandBox, ScreenShell, type ScreenFrameProps } from "./parts";
import "./screens.css";

/** "다시 확인" 을 누르면 이만큼 확인 중으로 보였다가 돌아온다 (시제품) */
const RECHECK_MS = 1400;

const SAY: Record<SetupState, TextKey> = {
  login: "variant.setup.say.login",
  checking: "variant.setup.say.checking",
  fresh: "variant.setup.say.fresh",
  git: "variant.setup.say.git",
  harness: "variant.setup.say.harness",
  failed: "variant.setup.say.failed",
  ready: "variant.setup.say.ready",
  apikey: "variant.setup.say.ready",
};

function rowDetail(row: CheckRow, active: CheckRow | null): string | null {
  if (row.detailKey) return t(row.detailKey);
  if (row.status === "missing" && active && active.id !== row.id) return t("variant.setup.nextTurn");
  if (row.status === "checking") return t("variant.setup.checkingNow");
  return null;
}

/** 펼친 줄의 안내 — 무엇을 하면 되는지 한 단계씩 */
function Guide({ row, search, onRecheck }: { row: CheckRow; search: string; onRecheck: () => void }) {
  const [opened, setOpened] = useState(false);

  if (row.status === "failed") {
    return (
      <div className="su-howto">
        <p className="su-howto__title rnd">{t("variant.setup.failed.title")}</p>
        <p>{t("variant.setup.failed.body")}</p>
        <div className="su-howto__actions">
          <button type="button" className="hbtn hbtn--primary" onClick={onRecheck}>
            <Icon name="refresh" size={18} />
            {t("variant.ui.recheck")}
          </button>
        </div>
        <p className="su-howto__tip">{t("variant.setup.failed.tip")}</p>
        <details className="su-raw">
          <summary>{t("variant.setup.failed.raw")}</summary>
          <pre className="selectable">{SETUP_FAILED_RAW.join("\n")}</pre>
        </details>
      </div>
    );
  }

  if (row.id === "cli") {
    return (
      <div className="su-howto">
        <p className="su-howto__title rnd">{t("variant.setup.cli.title")}</p>
        <p>{t("variant.setup.cli.body")}</p>
        <CommandBox command={SETUP_COMMANDS.cliInstall} />
        <div className="su-howto__actions">
          <button type="button" className="hbtn" title={t("variant.ui.external")}>
            <Icon name="external" size={18} />
            {t("variant.setup.cli.open")}
          </button>
          <button type="button" className="hbtn hbtn--primary" onClick={onRecheck}>
            <Icon name="refresh" size={18} />
            {t("variant.ui.recheck")}
          </button>
        </div>
        <p className="su-howto__tip">
          {t("variant.setup.cli.already")}{" "}
          <a className="su-link" href={screenHref(search, "settings", { section: "claude" })}>
            {t("variant.setup.cli.pick")}
          </a>
        </p>
      </div>
    );
  }

  if (row.id === "login") {
    return (
      <div className="su-howto">
        <p className="su-howto__title rnd">{t("variant.setup.login.title")}</p>
        <ol className="su-steps">
          <li data-done={opened ? "true" : undefined}>{t("variant.setup.login.step1")}</li>
          <li>{t("variant.setup.login.step2")}</li>
          <li>{t("variant.setup.login.step3")}</li>
        </ol>
        <div className="su-howto__actions">
          <button type="button" className={opened ? "hbtn" : "hbtn hbtn--primary"} onClick={() => setOpened(true)}>
            <Icon name="terminal" size={18} />
            {t("variant.setup.login.open")}
          </button>
          {opened && (
            <button type="button" className="hbtn hbtn--primary" onClick={onRecheck}>
              <Icon name="refresh" size={18} />
              {t("variant.ui.recheck")}
            </button>
          )}
        </div>
        {opened && (
          <p className="su-wait" role="status">
            <Coin status="checking" size="sm" />
            {t("variant.setup.login.waiting")}
          </p>
        )}
        <p className="su-howto__note">
          <Icon name="key" size={16} />
          {t("variant.setup.login.privacy")}
        </p>
      </div>
    );
  }

  if (row.id === "git") {
    return (
      <div className="su-howto">
        <p className="su-howto__title rnd">{t("variant.setup.git.title")}</p>
        <p>{t("variant.setup.git.body")}</p>
        <CommandBox command={SETUP_COMMANDS.gitInstall} />
        <div className="su-howto__actions">
          <button type="button" className="hbtn" title={t("variant.ui.external")}>
            <Icon name="external" size={18} />
            {t("variant.setup.git.open")}
          </button>
          <button type="button" className="hbtn hbtn--primary" onClick={onRecheck}>
            <Icon name="refresh" size={18} />
            {t("variant.ui.recheck")}
          </button>
        </div>
        <p className="su-howto__tip">{t("variant.setup.git.tip")}</p>
      </div>
    );
  }

  return (
    <div className="su-howto">
      <p className="su-howto__title rnd">{t("variant.setup.harness.title")}</p>
      <p>{t("variant.setup.harness.body")}</p>
      <div className="su-howto__actions">
        <a className="hbtn hbtn--primary" href={screenHref(search, "harness")}>
          <Icon name="box" size={18} />
          {t("variant.setup.harness.open")}
          <Icon name="arrow" size={16} />
        </a>
      </div>
    </div>
  );
}

function CheckItem({ row, active, search, onRecheck }: { row: CheckRow; active: CheckRow | null; search: string; onRecheck: () => void }) {
  const open = active?.id === row.id;
  const detail = rowDetail(row, active);
  return (
    <li className="su-row" data-status={row.status} data-open={open ? "true" : undefined}>
      <div className="su-row__head">
        <Coin status={row.status} />
        <div className="su-row__name">
          <span className="su-row__title rnd">{t(`variant.setup.${row.id}`)}</span>
          <span className="su-row__what">{t(`variant.setup.${row.id}.what`)}</span>
        </div>
        <div className="su-row__state">
          <span className="su-row__status rnd">{t(`variant.setup.status.${row.status}`)}</span>
          {detail && <span className="su-row__detail">{detail}</span>}
        </div>
      </div>
      {open && <Guide row={row} search={search} onRecheck={onRecheck} />}
    </li>
  );
}

/** 다 됐을 때 — 고양이들이 툇마루에 모여 있다 */
function ReadyShelf({ search }: { search: string }) {
  return (
    <div className="su-ready">
      <ul className="su-shelf" aria-hidden="true">
        {/* 먹물은 옆에서 안내하고 있으니 나머지 여섯 마리 */}
        {CAT_IDS.filter((cat) => cat !== "mukmul").map((cat, i) => (
          <li key={cat} className="su-shelf__cat">
            <CatFigure cat={cat} pose={i % 3 === 1 ? "loaf" : "sit"} />
          </li>
        ))}
      </ul>
      <div className="su-ready__go">
        <a className="hbtn hbtn--primary su-go" href={screenHref(search, "house")}>
          <Icon name="house" size={20} />
          {t("variant.setup.ready.go")}
        </a>
        <p className="muted">{t("variant.setup.ready.note")}</p>
      </div>
    </div>
  );
}

export function SetupScreen({ search, state: rawState, time }: ScreenFrameProps) {
  const state = pickState(rawState, SETUP_STATES);
  const [rechecking, setRechecking] = useState(false);
  const [keyDismissed, setKeyDismissed] = useState(false);

  useEffect(() => {
    if (!rechecking) return;
    const id = window.setTimeout(() => setRechecking(false), RECHECK_MS);
    return () => window.clearTimeout(id);
  }, [rechecking]);

  const base = setupChecks(state);
  // 다시 확인 중에는 됨이 아닌 줄을 하나씩 확인 중으로 (맨 위 하나는 확인 중, 나머지는 기다림)
  const rows: CheckRow[] = rechecking
    ? base.map((row, i, all) => {
        if (row.status === "ok") return row;
        const first = all.findIndex((r) => r.status !== "ok");
        return i === first ? { id: row.id, status: "checking" } : { id: row.id, status: "waiting", detailKey: "variant.setup.waitTurn" };
      })
    : base;
  const active = activeCheck(rows);
  const ready = rows.every((row) => row.status === "ok");
  const okCount = rows.filter((row) => row.status === "ok").length;
  const say: TextKey = rechecking ? "variant.setup.say.checking" : SAY[state];

  return (
    <ScreenShell nav="house" time={time} className="su">
      <div className="tray su-tray">
        <header className="tray__head">
          <div className="tray__titles">
            <h1 className="tray__title rnd">{t("variant.setup.title")}</h1>
            <p className="tray__lead">{t("variant.setup.lead")}</p>
          </div>
          <div className="su-head__side">
            <Chip tone={ready ? "add" : "plain"}>{tf("variant.setup.progress", { n: okCount })}</Chip>
            <button type="button" className="hbtn" onClick={() => setRechecking(true)} disabled={rechecking}>
              <Icon name="refresh" size={18} />
              {t("variant.setup.recheckAll")}
            </button>
          </div>
        </header>

        <div className="tray__body su-body">
          <aside className="su-guide" aria-label={t("variant.setup.guide")}>
            <p className="say su-say" aria-live="polite">
              {t(say)}
            </p>
            <div className="su-cat">
              <CatFigure cat="mukmul" pose="sit" />
            </div>
          </aside>

          <section className="su-main" aria-labelledby="su-list-title">
            <h2 id="su-list-title" className="sr">
              {t("variant.setup.list")}
            </h2>
            {state === "apikey" && !keyDismissed && (
              <Banner
                tone="warn"
                title={t("variant.setup.apikey.title")}
                actions={
                  <>
                    <button type="button" className="hbtn" onClick={() => setKeyDismissed(true)}>
                      {t("variant.ui.dismiss")}
                    </button>
                    <a className="hbtn" href={screenHref(search, "settings", { state: "apikey", section: "claude" })}>
                      {t("variant.setup.apikey.settings")}
                    </a>
                  </>
                }
              >
                <p>{t("variant.setup.apikey.body")}</p>
                <p className="muted su-small">{t("variant.setup.apikey.note")}</p>
              </Banner>
            )}
            <ol className="su-list" aria-labelledby="su-list-title">
              {rows.map((row) => (
                <CheckItem key={row.id} row={row} active={active} search={search} onRecheck={() => setRechecking(true)} />
              ))}
            </ol>
            <p className="su-checked muted">
              {rechecking ? t("variant.setup.checkingNow") : tf("variant.setup.checkedAt", { when: t("variant.fixture.setup.when") })}
            </p>
            {ready && <ReadyShelf search={search} />}
          </section>
        </div>
      </div>
    </ScreenShell>
  );
}
