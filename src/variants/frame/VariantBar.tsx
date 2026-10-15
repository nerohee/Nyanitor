import { isTextKey, t, type TextKey } from "../../i18n/ko";
import { DEFAULT_SKIN, SCREEN_STATES, SCREENS, screenHref, SKINS, THEMES, TIMES, withParam, type FrameQuery } from "../query";

interface Option {
  /** 링크 주소 */
  href: string;
  key: string;
  label: string;
  current: boolean;
}

function Group({ label, options }: { label: TextKey; options: Option[] }) {
  return (
    <div className="vf-bar__group" role="group" aria-label={t(label)}>
      <span className="vf-bar__label" aria-hidden="true">
        {t(label)}
      </span>
      {options.map((option) => (
        <a key={option.key} className="vf-bar__opt" href={option.href} aria-current={option.current ? "true" : undefined}>
          {option.label}
        </a>
      ))}
    </div>
  );
}

interface VariantBarProps {
  search: string;
  query: FrameQuery;
  variantIds: readonly string[];
  currentName: string;
}

/** 아래쪽 시안 막대 — 링크라서 키보드(Tab · Enter)로 다 쓸 수 있다. `?bar=off` 로 숨긴다. */
export function VariantBar({ search, query, variantIds, currentName }: VariantBarProps) {
  const param = (key: string, value: string | null) => withParam(search, key, value);
  const states = SCREEN_STATES[query.screen] ?? [];
  return (
    <nav className="vf-bar" aria-label={t("variant.bar.label")}>
      <strong className="vf-bar__current">{currentName}</strong>
      {variantIds.length > 1 && (
        <Group
          label="variant.bar.variant"
          options={variantIds.map((id) => ({ key: id, href: param("variant", id), label: id, current: id === query.variant }))}
        />
      )}
      <Group
        label="variant.bar.skin"
        options={SKINS.map((skin) => ({
          key: skin,
          // ① 이 기본 — 쿼리 없이
          href: param("skin", skin === DEFAULT_SKIN ? null : skin),
          label: t(`variant.skin.${skin}`),
          current: skin === query.skin,
        }))}
      />
      <Group
        label="variant.bar.screen"
        options={SCREENS.map((s) => ({
          key: s,
          href: screenHref(search, s),
          label: t(`variant.screen.${s}`),
          current: s === query.screen,
        }))}
      />
      {states.length > 0 && (
        <Group
          label="variant.bar.state"
          options={states.map((state, i) => {
            const key = `variant.state.${query.screen}.${state}`;
            return {
              key: state,
              href: param("state", i === 0 ? null : state),
              label: isTextKey(key) ? t(key) : state,
              current: state === query.state,
            };
          })}
        />
      )}
      <Group
        label="variant.bar.time"
        options={[
          { key: "auto", href: param("time", null), label: t("variant.time.auto"), current: !query.timeFixed },
          ...TIMES.map((time) => ({
            key: time,
            href: param("time", time),
            label: t(`variant.time.${time}`),
            current: query.timeFixed && time === query.time,
          })),
        ]}
      />
      <Group
        label="variant.bar.theme"
        options={THEMES.map((theme) => ({
          key: theme,
          href: param("theme", theme === "system" ? null : theme),
          label: t(`variant.theme.${theme}`),
          current: theme === query.theme,
        }))}
      />
    </nav>
  );
}
