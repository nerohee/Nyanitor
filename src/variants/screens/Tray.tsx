// 트레이 메뉴 · 알림 견본 (plan §5 트레이 · D-06 · D-14 · D-16 · D-25 · P8). 실제 모양은 OS 가 그린다 — 이 화면은 문구 · 순서 · 언제 알리는지를 보이는 견본.
// 상태: ?screen=tray&state=menu(기본 · 상태 4가지 메뉴)|notify(알림 문구)|quit(일하는 중 종료 경고)
// 트레이 아이콘은 한 가지 색 (desktop/design.md §3) — 상태는 색이 아니라 발바닥 옆 모양(점 · 느낌표 · 고리)으로.
import { HouseScene } from "../../components/house/HouseScene";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, type TextKey } from "../../i18n/ko";
import { ORCHESTRATOR } from "../fixtures";
import { NOTIFY_RULES, TOASTS, TRAY_MENUS, TRAY_STATES, type NotifyGroup, type TrayMenu, type TrayState } from "../fixtures-tray";
import type { OrchStatus } from "../fixtures-workspace";
import { pickState, withParam } from "../query";
import { Icon } from "../shared/icons";
import { Chip, type ScreenFrameProps } from "./parts";
import "../a/house.css";
import "../shared/shared.css";
import "./parts.css";
import "./screens.css";
import "./tray.css";

/** 트레이 아이콘 — 발바닥 + 상태 표시(모양으로만). 16 · 32px 에서 알아보게 단순하게 */
export function TrayGlyph({ status, size = 20 }: { status: OrchStatus; size?: number }) {
  return (
    <svg className="tr-glyph" viewBox="0 0 20 20" width={size} height={size} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <path d="M5.6 13.6c0-2.1 1.7-3.6 3.8-3.6s3.8 1.5 3.8 3.6c0 1.7-1.3 2.7-2.5 2.3-.9-.3-1.7-.3-2.6 0-1.2.4-2.5-.6-2.5-2.3z" />
        <circle cx="4.2" cy="8.6" r="1.5" />
        <circle cx="7.3" cy="5.4" r="1.5" />
        <circle cx="11.5" cy="5.4" r="1.5" />
        <circle cx="14.6" cy="8.6" r="1.5" />
      </g>
      {status === "working" && (
        <path d="M14.2 14.4a3.4 3.4 0 1 0 3.4-3.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
      {status === "waiting" && <circle cx="16.4" cy="14.6" r="3" fill="currentColor" />}
      {status === "error" && (
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M16.6 10.8v3.4" />
          <path d="M16.6 17.4v.1" />
        </g>
      )}
    </svg>
  );
}

const STATUS_KEY: Record<OrchStatus, TextKey> = {
  idle: "variant.ws.status.idle",
  working: "variant.ws.status.working",
  waiting: "variant.ws.status.waiting",
  error: "variant.ws.status.error",
};

function MenuMock({ menu }: { menu: TrayMenu }) {
  return (
    <figure className="tr-case">
      <figcaption className="tr-case__cap rnd">
        <span className="status-dot" data-status={menu.status} aria-hidden="true" />
        {t(STATUS_KEY[menu.status])}
      </figcaption>
      <ul className="tr-menu" aria-label={t("variant.tray.menuOf")}>
        {menu.items.map((item) => (
          <li
            key={item.key}
            className="tr-menu__item"
            data-header={item.header ? "true" : undefined}
            data-primary={item.primary ? "true" : undefined}
            data-sep={item.separatorBefore ? "true" : undefined}
          >
            {item.header && <span className="status-dot" data-status={menu.status} aria-hidden="true" />}
            {t(item.key)}
            {item.asks && "…"}
          </li>
        ))}
      </ul>
      <div className="tr-bar" aria-hidden="true">
        <span className="tr-bar__tip">{t(menu.tooltipKey)}</span>
        <span className="tr-bar__icons">
          <span className="tr-bar__other" />
          <span className="tr-bar__other" />
          <span className="tr-bar__mine">
            <TrayGlyph status={menu.status} />
          </span>
          <span className="tr-bar__clock">15:02</span>
        </span>
      </div>
    </figure>
  );
}

const GROUP_KEY: Record<NotifyGroup, TextKey> = {
  ask: "variant.tray.group.ask",
  phase: "variant.tray.group.phase",
  error: "variant.tray.group.error",
  limit: "variant.tray.group.limit",
  once: "variant.tray.group.once",
};

function Toasts() {
  return (
    <div className="tr-notify">
      <ul className="tr-toasts" aria-label={t("variant.tray.toasts")}>
        {TOASTS.map((toast) => (
          <li key={toast.id} className="tr-toast">
            <div className="tr-toast__app">
              <span className="tr-toast__icon" aria-hidden="true">
                <TrayGlyph status="idle" size={14} />
              </span>
              Nyanitor
              <Chip
                tone={toast.group === "error" ? "delete" : toast.group === "limit" ? "warn" : toast.group === "ask" ? "accent" : "plain"}
              >
                {t(GROUP_KEY[toast.group])}
              </Chip>
            </div>
            <p className="tr-toast__title">{t(toast.titleKey)}</p>
            <p className="tr-toast__body">{t(toast.bodyKey)}</p>
            <p className="tr-toast__click">
              <Icon name="arrow" size={12} />
              {t(toast.clickKey)}
            </p>
          </li>
        ))}
      </ul>
      <aside className="tr-rules box">
        <h2 className="box__title rnd">{t("variant.tray.rules")}</h2>
        <ul>
          {NOTIFY_RULES.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function QuitMock() {
  return (
    <div className="tr-quit">
      <div className="tr-quit__dlg" role="group" aria-labelledby="tr-quit-title">
        <div className="tr-quit__cat" aria-hidden="true">
          <CatFigure cat={ORCHESTRATOR} pose="sit" />
        </div>
        <div className="tr-quit__text">
          <h2 id="tr-quit-title" className="tr-quit__title rnd">
            {t("variant.tray.quit.title")}
          </h2>
          <p>{t("variant.tray.quit.body")}</p>
          <p className="muted su-small">{t("variant.tray.quit.note")}</p>
        </div>
        <div className="tr-quit__actions">
          <button type="button" className="hbtn">
            {t("variant.ui.cancel")}
          </button>
          <button type="button" className="hbtn hbtn--danger">
            <Icon name="stop" size={16} />
            {t("variant.tray.quit.stop")}
          </button>
          <button type="button" className="hbtn hbtn--primary">
            {t("variant.tray.quit.hide")}
          </button>
        </div>
      </div>
      <p className="tr-quit__when muted">{t("variant.tray.quit.when")}</p>
    </div>
  );
}

const LEAD: Record<TrayState, TextKey> = {
  menu: "variant.tray.lead.menu",
  notify: "variant.tray.lead.notify",
  quit: "variant.tray.lead.quit",
};

export function TrayScreen({ search, state: rawState, time }: ScreenFrameProps) {
  const state = pickState(rawState, TRAY_STATES);
  return (
    <div className="tr">
      <HouseScene className="tr-backdrop" time={time} placements={[]} />
      <div className="tr-sheet">
        <header className="tr-head">
          <div>
            <h1 className="tr-head__title rnd">{t("variant.tray.title")}</h1>
            <p className="tr-head__lead">{t(LEAD[state])}</p>
          </div>
          <nav className="dtabs tr-tabs" aria-label={t("variant.tray.tabs")}>
            {TRAY_STATES.map((s, i) => (
              <a key={s} href={withParam(search, "state", i === 0 ? null : s)} aria-current={s === state ? "page" : undefined}>
                {t(`variant.tray.tab.${s}`)}
              </a>
            ))}
          </nav>
        </header>
        {state === "menu" && (
          <>
            <div className="tr-menus">
              {TRAY_MENUS.map((menu) => (
                <MenuMock key={menu.status} menu={menu} />
              ))}
            </div>
            <section className="box tr-notes" aria-labelledby="tr-notes-title">
              <h2 id="tr-notes-title" className="box__title rnd">
                {t("variant.tray.notes")}
              </h2>
              <ul>
                <li>{t("variant.tray.note.primary")}</li>
                <li>{t("variant.tray.note.header")}</li>
                <li>{t("variant.tray.note.asks")}</li>
                <li>
                  {t("variant.tray.note.icon")}
                  <span className="tr-legend" aria-hidden="true">
                    {(["idle", "working", "waiting", "error"] as const).map((s) => (
                      <span key={s}>
                        <TrayGlyph status={s} size={18} />
                      </span>
                    ))}
                  </span>
                </li>
              </ul>
            </section>
          </>
        )}
        {state === "notify" && <Toasts />}
        {state === "quit" && <QuitMock />}
        <p className="tr-foot muted su-small">
          <Icon name="info" size={14} />
          {t("variant.tray.foot")}
        </p>
      </div>
    </div>
  );
}
