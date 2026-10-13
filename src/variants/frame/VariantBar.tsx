import { t, type TextKey } from "../../i18n/ko";
import { SCREENS, THEMES, TIMES, withParam, type FrameQuery } from "../query";

interface Option {
  value: string | null;
  label: string;
  current: boolean;
}

function Group({ label, param, options, search }: { label: TextKey; param: string; options: Option[]; search: string }) {
  return (
    <div className="vf-bar__group" role="group" aria-label={t(label)}>
      <span className="vf-bar__label" aria-hidden="true">
        {t(label)}
      </span>
      {options.map((option) => (
        <a
          key={option.value ?? "none"}
          className="vf-bar__opt"
          href={withParam(search, param, option.value)}
          aria-current={option.current ? "true" : undefined}
        >
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
  return (
    <nav className="vf-bar" aria-label={t("variant.bar.label")}>
      <strong className="vf-bar__current">{currentName}</strong>
      <Group
        label="variant.bar.variant"
        param="variant"
        search={search}
        options={variantIds.map((id) => ({ value: id, label: id, current: id === query.variant }))}
      />
      <Group
        label="variant.bar.screen"
        param="screen"
        search={search}
        options={SCREENS.map((s) => ({ value: s, label: t(`variant.screen.${s}`), current: s === query.screen }))}
      />
      <Group
        label="variant.bar.time"
        param="time"
        search={search}
        options={[
          { value: null, label: t("variant.time.auto"), current: !query.timeFixed },
          ...TIMES.map((time) => ({
            value: time,
            label: t(`variant.time.${time}`),
            current: query.timeFixed && time === query.time,
          })),
        ]}
      />
      <Group
        label="variant.bar.theme"
        param="theme"
        search={search}
        options={THEMES.map((theme) => ({
          value: theme === "system" ? null : theme,
          label: t(`variant.theme.${theme}`),
          current: theme === query.theme,
        }))}
      />
    </nav>
  );
}
