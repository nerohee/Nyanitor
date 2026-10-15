import { t } from "../../i18n/ko";
import { screenHref } from "../query";
import { Icon } from "./icons";

export type NavPlace = "house" | "workspace" | "custom" | "settings";

/**
 * 왼쪽 탐색 (plan §5): 집 · 작업 공간 · 내 수정 · 설정.
 * 시안에서는 집 · 작업 공간 · 설정이 시안 틀의 `screen` 을 바꾸고, 내 수정은 눌리는 모양만 (묶음 2, P2-14).
 * 첫 실행 · 준비는 준비가 안 됐을 때 "집" 자리에 뜨고, 하네스 · 고양이 고르기는 설정 안에서 들어간다.
 */
export function HouseNav({ className, current = "house" }: { className: string; current?: NavPlace }) {
  const search = typeof window === "undefined" ? "" : window.location.search;
  return (
    <nav className={className} aria-label={t("variant.nav.label")}>
      <ul>
        <li>
          <a href={screenHref(search, "house")} aria-current={current === "house" ? "page" : undefined}>
            <Icon name="house" />
            <span>{t("variant.nav.house")}</span>
          </a>
        </li>
        <li>
          <a href={screenHref(search, "workspace")} aria-current={current === "workspace" ? "page" : undefined}>
            <Icon name="workspace" />
            <span>{t("variant.nav.workspace")}</span>
          </a>
        </li>
        <li>
          <button type="button">
            <Icon name="custom" />
            <span>{t("variant.nav.custom")}</span>
          </button>
        </li>
        <li>
          <a href={screenHref(search, "settings")} aria-current={current === "settings" ? "page" : undefined}>
            <Icon name="settings" />
            <span>{t("variant.nav.settings")}</span>
          </a>
        </li>
      </ul>
    </nav>
  );
}
