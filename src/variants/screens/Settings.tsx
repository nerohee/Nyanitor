// 설정 (plan §5) — 왼쪽 목차 + 한 장으로 이어지는 설정 줄. 목차를 누르면 그 묶음으로 간다.
// 상태: ?screen=settings&state=normal(기본)|apikey(환경에 키가 있음)|update(새 앱 버전) &section=claude|look|house|notify|harness|update|about
// 테마 · 움직임 줄이기는 이 시제품 안에서 실제로 바뀐다 (:root 의 data-theme · data-motion). 나머지는 가짜 데이터.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t, tf } from "../../i18n/ko";
import { SETTINGS_FIXTURE, SETTINGS_SECTIONS, SETTINGS_STATES, type SettingsSection } from "../fixtures-screens";
import { DEFAULT_SKIN, pickState, screenHref, TIMES, type TimeOfDay } from "../query";
import { Icon, type IconName } from "../shared/icons";
import { Banner, Chip, Coin, Field, RadioRows, ScreenShell, Segmented, Select, SettingRow, Toggle, type ScreenFrameProps } from "./parts";
import "./screens.css";

const SECTION_ICON: Record<SettingsSection, IconName> = {
  claude: "terminal",
  look: "moon",
  house: "paw",
  notify: "bell",
  harness: "box",
  update: "download",
  about: "info",
};

const NOTIFY = ["ask", "phase", "error", "limit"] as const;
type NotifyKey = (typeof NOTIFY)[number];

function sectionFrom(search: string): SettingsSection | null {
  const value = new URLSearchParams(search).get("section");
  return SETTINGS_SECTIONS.find((s) => s === value) ?? null;
}

function Section({ id, children }: { id: SettingsSection; children: ReactNode }) {
  return (
    <section id={`st-${id}`} className="st-sec" aria-labelledby={`st-${id}-title`}>
      <h2 id={`st-${id}-title`} className="st-sec__title rnd">
        <Icon name={SECTION_ICON[id]} size={20} />
        {t(`variant.settings.sec.${id}`)}
      </h2>
      <div className="st-sec__body">{children}</div>
    </section>
  );
}

type ThemePick = "system" | "light" | "dark";

/** 시안 틀의 theme 쿼리에서 시작 (시안 틀이 :root 에 넣는 것보다 이 화면이 먼저 그려진다) */
function themeFrom(search: string): ThemePick {
  const value = new URLSearchParams(search).get("theme");
  return value === "light" || value === "dark" ? value : "system";
}

/** 고른 테마 · 움직임을 바로 :root 에 (tokens.css 의 :root[data-theme] · [data-motion]) */
function applyTheme(theme: ThemePick) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

export function SettingsScreen({ search, state: rawState, time }: ScreenFrameProps) {
  const state = pickState(rawState, SETTINGS_STATES);
  const scroller = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState<SettingsSection>(() => sectionFrom(search) ?? "claude");

  // Claude Code
  const [cliMode, setCliMode] = useState<"auto" | "manual">("auto");
  const [cliPath, setCliPath] = useState<string>(SETTINGS_FIXTURE.cliPath);
  const [keyMode, setKeyMode] = useState<"strip" | "use">("strip");
  // 화면
  const [theme, setTheme] = useState<ThemePick>(() => themeFrom(search));
  const [reduced, setReduced] = useState(false);
  // 고양이 집
  const [timeMode, setTimeMode] = useState<"auto" | "fixed">("auto");
  const [fixedTime, setFixedTime] = useState<TimeOfDay>(time);
  // 알림
  const [notify, setNotify] = useState<Record<NotifyKey, boolean>>({ ask: true, phase: true, error: true, limit: true });
  // 앱 업데이트
  const [appChecking, setAppChecking] = useState(false);

  // 목차를 눌러 움직이는 동안은 누른 칸에 표시를 고정한다 — 두 칸 이상 건너뛸 때 지나가는 칸마다 바뀌지 않게 (D-43).
  // 스크롤이 끝나면(scrollend, 없으면 스크롤 이벤트가 150ms 멈췄을 때) 푼다.
  const locked = useRef<SettingsSection | null>(null);
  const unlockTimer = useRef<number | undefined>(undefined);
  /** 이 묶음에 표시를 고정 — 스크롤이 일어나지 않아도 1초 뒤에는 풀린다 */
  const lockOn = (id: SettingsSection) => {
    locked.current = id;
    window.clearTimeout(unlockTimer.current);
    unlockTimer.current = window.setTimeout(() => {
      locked.current = null;
    }, 1000);
  };

  // 처음 열 때 주소의 section 으로 (짧은 끝 묶음이어도 그 칸에 표시가 남게 고정)
  useLayoutEffect(() => {
    const first = sectionFrom(search);
    if (!first) return;
    lockOn(first);
    document.getElementById(`st-${first}`)?.scrollIntoView?.({ block: "start" });
  }, [search]);

  // 움직임 줄이기는 이 화면을 떠나면 푼다 (시제품 — 저장하지 않음)
  useEffect(
    () => () => {
      delete document.documentElement.dataset.motion;
    },
    [],
  );
  const pickTheme = (next: ThemePick) => {
    setTheme(next);
    applyTheme(next);
  };
  const pickReduced = (next: boolean) => {
    setReduced(next);
    if (next) document.documentElement.dataset.motion = "reduced";
    else delete document.documentElement.dataset.motion;
  };

  useEffect(() => {
    if (!appChecking) return;
    const id = window.setTimeout(() => setAppChecking(false), 1200);
    return () => window.clearTimeout(id);
  }, [appChecking]);

  // 스크롤에 따라 목차의 지금 묶음을 바꾼다 (D-43):
  // 맨 밑까지 내리면 마지막 묶음 — 짧은 묶음(앱 업데이트 · 정보)은 위쪽 기준선까지 올라오지 못하니까.
  // 그 밖에는 위쪽 30% 기준선을 넘어간 묶음 중 마지막.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const SETTLE_MS = 150;
    const unlockSoon = () => {
      window.clearTimeout(unlockTimer.current);
      unlockTimer.current = window.setTimeout(() => {
        locked.current = null;
      }, SETTLE_MS);
    };
    const spy = () => {
      if (locked.current) {
        // 움직이는 중 — scrollend 가 있으면 그것이 풀고(긴 스크롤에서도 go() 의 안전 시간이 먼저 풀지 않게 지운다),
        // 없으면 스크롤 이벤트가 잠깐 멈췄을 때 끝난 것으로
        if ("onscrollend" in root) window.clearTimeout(unlockTimer.current);
        else unlockSoon();
        return;
      }
      const sections = Array.from(root.querySelectorAll<HTMLElement>(".st-sec"));
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      let found: SettingsSection | undefined;
      if (atBottom) {
        found = SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1];
      } else {
        const line = root.getBoundingClientRect().top + root.clientHeight * 0.3;
        const passed = sections.filter((el) => el.getBoundingClientRect().top <= line);
        const id = (passed[passed.length - 1] ?? sections[0])?.id.replace("st-", "");
        found = SETTINGS_SECTIONS.find((s) => s === id);
      }
      if (found) setCurrent(found);
    };
    const onEnd = () => {
      window.clearTimeout(unlockTimer.current);
      locked.current = null;
    };
    root.addEventListener("scroll", spy, { passive: true });
    root.addEventListener("scrollend", onEnd);
    return () => {
      root.removeEventListener("scroll", spy);
      root.removeEventListener("scrollend", onEnd);
      window.clearTimeout(unlockTimer.current);
    };
  }, []);

  const go = (id: SettingsSection) => {
    setCurrent(id);
    lockOn(id);
    const still = reduced || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    document.getElementById(`st-${id}`)?.scrollIntoView?.({ block: "start", behavior: still ? "auto" : "smooth" });
  };

  const keyFound = state === "apikey";

  return (
    <ScreenShell nav="settings" time={time} className="st">
      <div className="tray st-tray">
        <header className="tray__head">
          <div className="tray__titles">
            <h1 className="tray__title rnd">{t("variant.settings.title")}</h1>
          </div>
        </header>
        <div className="st-body">
          <nav className="st-index" aria-label={t("variant.settings.sections")}>
            <ul>
              {SETTINGS_SECTIONS.map((id) => (
                <li key={id}>
                  <a
                    href={`#st-${id}`}
                    aria-current={current === id ? "true" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      go(id);
                    }}
                  >
                    <Icon name={SECTION_ICON[id]} size={18} />
                    <span className="rnd">{t(`variant.settings.sec.${id}`)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="st-scroll" ref={scroller}>
            <Section id="claude">
              <SettingRow id="st-cli" label={t("variant.settings.cli.where")} desc={t("variant.settings.cli.whereDesc")}>
                <RadioRows
                  label={t("variant.settings.cli.where")}
                  value={cliMode}
                  onChange={setCliMode}
                  options={[
                    {
                      value: "auto",
                      label: t("variant.settings.cli.auto"),
                      desc: t("variant.settings.cli.autoDesc"),
                      badge: (
                        <Chip tone="add">
                          <Icon name="check" size={12} />
                          {SETTINGS_FIXTURE.cliVersion}
                        </Chip>
                      ),
                      extra: <code className="mono muted selectable">{SETTINGS_FIXTURE.cliPath}</code>,
                    },
                    {
                      value: "manual",
                      label: t("variant.settings.cli.manual"),
                      desc: t("variant.settings.cli.manualDesc"),
                      extra: (
                        <>
                          <Field label={t("variant.settings.cli.path")} value={cliPath} onChange={setCliPath} mono />
                          <button type="button" className="hbtn">
                            <Icon name="folder" size={18} />
                            {t("variant.settings.cli.browse")}
                          </button>
                        </>
                      ),
                    },
                  ]}
                />
              </SettingRow>
              <SettingRow
                id="st-login"
                label={t("variant.settings.login")}
                desc={t("variant.settings.loginDesc")}
                control={
                  <>
                    <Chip tone="add">
                      <Icon name="check" size={12} />
                      {t("variant.fixture.setup.loginOk")}
                    </Chip>
                    <button type="button" className="hbtn">
                      <Icon name="terminal" size={18} />
                      {t("variant.settings.relogin")}
                    </button>
                  </>
                }
              />
              <SettingRow
                id="st-key"
                label={
                  <>
                    {t("variant.settings.key")}
                    <code className="mono st-envname">ANTHROPIC_API_KEY</code>
                  </>
                }
                desc={keyFound ? t("variant.settings.keyDesc") : t("variant.settings.key.noneDesc")}
                control={
                  <Chip tone={keyFound ? "warn" : "keep"}>{t(keyFound ? "variant.settings.key.found" : "variant.settings.key.none")}</Chip>
                }
              >
                {keyFound && (
                  <>
                    <RadioRows
                      label={t("variant.settings.key")}
                      value={keyMode}
                      onChange={setKeyMode}
                      options={[
                        {
                          value: "strip",
                          label: t("variant.settings.key.strip"),
                          desc: t("variant.settings.key.stripDesc"),
                          badge: <Chip tone="accent">{t("variant.ws.card.recommended")}</Chip>,
                        },
                        { value: "use", label: t("variant.settings.key.use"), desc: t("variant.settings.key.useDesc") },
                      ]}
                    />
                    <p className="st-note">
                      <Icon name="key" size={16} />
                      {t("variant.settings.key.note")}
                    </p>
                  </>
                )}
              </SettingRow>
            </Section>

            <Section id="look">
              <SettingRow
                id="st-theme"
                label={t("variant.settings.theme")}
                desc={t("variant.settings.themeDesc")}
                control={
                  <Segmented
                    label={t("variant.settings.theme")}
                    value={theme}
                    onChange={pickTheme}
                    options={[
                      { value: "system", label: t("variant.theme.system") },
                      { value: "light", label: t("variant.theme.light") },
                      { value: "dark", label: t("variant.theme.dark") },
                    ]}
                  />
                }
              />
              <SettingRow
                id="st-skin"
                label={
                  <>
                    {t("variant.settings.skin")}
                    <Chip tone="keep">{t("variant.settings.skinSlot")}</Chip>
                  </>
                }
                desc={t("variant.settings.skinDesc")}
              >
                <ul className="st-skins" aria-label={t("variant.settings.skin")}>
                  {(["3", "0", "1", "2"] as const).map((skin) => (
                    <li key={skin} className="st-skin" data-skin-chip={skin} aria-current={skin === DEFAULT_SKIN ? "true" : undefined}>
                      <span className="st-skin__swatch" aria-hidden="true" />
                      <span className="rnd">{t(`variant.skin.${skin}`)}</span>
                    </li>
                  ))}
                </ul>
              </SettingRow>
              <SettingRow
                id="st-motion"
                label={t("variant.settings.motion")}
                desc={t("variant.settings.motionDesc")}
                control={<Toggle labelledBy="st-motion" checked={reduced} onChange={pickReduced} />}
              />
            </Section>

            <Section id="house">
              <SettingRow id="st-time" label={t("variant.settings.time")} desc={t("variant.settings.timeDesc")}>
                <RadioRows
                  label={t("variant.settings.time")}
                  value={timeMode}
                  onChange={setTimeMode}
                  options={[
                    { value: "auto", label: t("variant.settings.time.auto"), desc: t("variant.settings.time.autoDesc") },
                    {
                      value: "fixed",
                      label: t("variant.settings.time.fixed"),
                      extra: (
                        <Select
                          label={t("variant.settings.time.which")}
                          value={fixedTime}
                          onChange={setFixedTime}
                          options={TIMES.map((value) => ({ value, label: t(`variant.time.${value}`) }))}
                        />
                      ),
                    },
                  ]}
                />
              </SettingRow>
              <SettingRow
                id="st-cats"
                label={t("variant.settings.cats")}
                desc={t("variant.settings.catsDesc")}
                control={
                  <a className="hbtn" href={screenHref(search, "pick")}>
                    <Icon name="paw" size={18} />
                    {t("variant.settings.catsGo")}
                    <Icon name="arrow" size={16} />
                  </a>
                }
              />
            </Section>

            <Section id="notify">
              <p className="st-lead">{t("variant.settings.notifyLead")}</p>
              {NOTIFY.map((key) => (
                <SettingRow
                  key={key}
                  id={`st-notify-${key}`}
                  label={t(`variant.settings.notify.${key}`)}
                  control={
                    <Toggle
                      labelledBy={`st-notify-${key}`}
                      checked={notify[key]}
                      onChange={(next) => setNotify((prev) => ({ ...prev, [key]: next }))}
                    />
                  }
                />
              ))}
            </Section>

            <Section id="harness">
              <SettingRow
                id="st-harness"
                label={t("variant.settings.harness")}
                desc={t("variant.settings.harnessDesc")}
                control={
                  <Chip tone="add">
                    <Icon name="check" size={12} />
                    {SETTINGS_FIXTURE.harnessVersion} · {SETTINGS_FIXTURE.harnessCommit}
                  </Chip>
                }
              />
              <SettingRow
                id="st-harness-where"
                label={t("variant.settings.harnessWhere")}
                desc={<code className="mono selectable">{SETTINGS_FIXTURE.harnessRoot}</code>}
                control={
                  <button type="button" className="hbtn">
                    <Icon name="folder" size={18} />
                    {t("variant.ui.openFolder")}
                  </button>
                }
              />
              <div className="st-actions">
                <a className="hbtn hbtn--primary" href={screenHref(search, "harness", { state: "update" })}>
                  <Icon name="refresh" size={18} />
                  {t("variant.settings.harnessCheck")}
                </a>
                <a className="hbtn" href={screenHref(search, "harness", { state: "backups" })}>
                  <Icon name="undo" size={18} />
                  {t("variant.settings.harnessBackups")}
                </a>
              </div>
            </Section>

            <Section id="update">
              <SettingRow
                id="st-app"
                label={t("variant.settings.app")}
                desc={<span className="mono">Nyanitor {SETTINGS_FIXTURE.appVersion}</span>}
                control={
                  state === "update" ? null : (
                    <>
                      <span className="st-latest" role="status">
                        {appChecking ? <Coin status="checking" size="sm" /> : <Coin status="ok" size="sm" />}
                        {appChecking
                          ? t("variant.setup.checkingNow")
                          : `${t("variant.settings.appLatest")} · ${t("variant.fixture.app.checked")}`}
                      </span>
                      <button type="button" className="hbtn" onClick={() => setAppChecking(true)} disabled={appChecking}>
                        <Icon name="refresh" size={18} />
                        {t("variant.settings.appCheck")}
                      </button>
                    </>
                  )
                }
              >
                {state === "update" && (
                  <Banner
                    tone="info"
                    title={tf("variant.settings.appNew", { v: SETTINGS_FIXTURE.appNext })}
                    actions={
                      <>
                        <button type="button" className="hbtn">
                          {t("variant.ui.later")}
                        </button>
                        <button type="button" className="hbtn hbtn--primary">
                          <Icon name="download" size={18} />
                          {t("variant.settings.appInstall")}
                        </button>
                      </>
                    }
                  >
                    <p className="muted su-small">{t("variant.settings.appNotes")}</p>
                    <ul className="st-notes">
                      {SETTINGS_FIXTURE.appNotes.map((key) => (
                        <li key={key}>{t(key)}</li>
                      ))}
                    </ul>
                    <p className="muted su-small">{t("variant.settings.appRunning")}</p>
                  </Banner>
                )}
              </SettingRow>
            </Section>

            <Section id="about">
              <dl className="kv st-about">
                <dt>{t("variant.settings.about.repo")}</dt>
                <dd>
                  <a
                    className="su-link"
                    href={SETTINGS_FIXTURE.repoUrl}
                    onClick={(event) => event.preventDefault()}
                    title={t("variant.ui.external")}
                  >
                    github.com/nerohee/nyanitor
                    <Icon name="external" size={14} />
                  </a>
                </dd>
                <dt>{t("variant.settings.about.license")}</dt>
                <dd>{t("variant.settings.about.licenseTbd")}</dd>
                <dt>{t("variant.settings.about.font")}</dt>
                <dd>{t("variant.settings.about.fontValue")}</dd>
                <dt>{t("variant.settings.about.art")}</dt>
                <dd>{t("variant.settings.about.artValue")}</dd>
                <dt>{t("variant.settings.about.claude")}</dt>
                <dd>{t("variant.settings.about.claudeValue")}</dd>
              </dl>
              <div className="st-actions">
                <button type="button" className="hbtn">
                  <Icon name="file" size={18} />
                  {t("variant.settings.about.oss")}
                </button>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </ScreenShell>
  );
}
