// 왼쪽 메뉴 — 고양이 집 · 작업 공간 · 내 수정 세 곳 (설정은 나중에 이 줄에 더한다). 시안 a 의 `HouseNav` 를 실제 화면용으로: 주소 링크가 아니라 앱 상태를 바꾸는 단추.
// ③ 스티커 수첩 (D-43): 수첩 스프링 옆 색 인덱스. 두 화면의 뿌리(`.home` · `.ws`)가 `data-skin="3"` 을 달고 있다.
import { t } from "../../i18n/ko";
import { Icon, type IconName } from "../../variants/shared/icons";
import "./nav.css";

export type NavPlace = "house" | "workspace" | "edit";

const PLACES: ReadonlyArray<{ place: NavPlace; icon: IconName; label: "variant.nav.house" | "variant.nav.workspace" | "variant.nav.custom" }> = [
  { place: "house", icon: "house", label: "variant.nav.house" },
  { place: "workspace", icon: "workspace", label: "variant.nav.workspace" },
  { place: "edit", icon: "custom", label: "variant.nav.custom" },
];

export function AppNav({ current, onGo }: { current: NavPlace; onGo: (place: NavPlace) => void }) {
  return (
    <nav className="an" aria-label={t("variant.nav.label")}>
      <ul>
        {PLACES.map(({ place, icon, label }) => (
          <li key={place}>
            <button type="button" aria-current={current === place ? "page" : undefined} onClick={() => current !== place && onGo(place)}>
              <Icon name={icon} />
              <span>{t(label)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
