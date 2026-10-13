import { t } from "../../i18n/ko";
import { withParam } from "../query";
import { Icon } from "./icons";

/**
 * 왼쪽 탐색 (plan §5): 집 · 작업 공간 · 내 수정 · 설정.
 * 시안에서는 집 · 작업 공간만 시안 틀의 `screen` 을 바꾸고, 나머지는 눌리는 모양만.
 */
export function HouseNav({ className, current = "house" }: { className: string; current?: "house" | "workspace" }) {
  const search = typeof window === "undefined" ? "" : window.location.search;
  return (
    <nav className={className} aria-label={t("variant.nav.label")}>
      <ul>
        <li>
          <a href={withParam(search, "screen", "house")} aria-current={current === "house" ? "page" : undefined}>
            <Icon name="house" />
            <span>{t("variant.nav.house")}</span>
          </a>
        </li>
        <li>
          <a href={withParam(search, "screen", "workspace")} aria-current={current === "workspace" ? "page" : undefined}>
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
          <button type="button">
            <Icon name="settings" />
            <span>{t("variant.nav.settings")}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
