// 시안 틀 (P2). 주소 쿼리로 시안 · 화면 · 시간대 · 테마를 골라 띄운다 (query.ts).
// 시안을 고른 뒤에는 `src/variants/` 폴더째, `App.tsx` 의 연결 몇 줄, `ko.ts` 의 `variant.` 키를 지운다.
import { useEffect, useLayoutEffect, useState } from "react";
import { t } from "../i18n/ko";
import { USAGE_OK, USAGE_UNAVAILABLE } from "./fixtures";
import { parseFrameQuery, type ScreenId } from "./query";
import { variantIds, variants } from "./registry";
import { CatsScreen } from "./frame/CatsScreen";
import { TokenPreview } from "./frame/TokenPreview";
import { VariantBar } from "./frame/VariantBar";
import "./frame/frame.css";

const MINUTE = 60_000;

function systemClock(): Date {
  return new Date();
}

interface VariantFrameProps {
  /** `window.location.search` */
  search: string;
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  clock?: () => Date;
}

export default function VariantFrame({ search, clock = systemClock }: VariantFrameProps) {
  const [now, setNow] = useState(clock);
  const query = parseFrameQuery(search, now, variantIds);

  // time 쿼리가 없으면 PC 시각을 따라 1분마다 다시 본다
  useEffect(() => {
    if (query.timeFixed) return;
    const id = window.setInterval(() => setNow(clock()), MINUTE);
    return () => window.clearInterval(id);
  }, [query.timeFixed, clock]);

  // 테마 강제는 :root 에 (tokens.css 의 :root[data-theme]). 첫 그림 전에 정해야 색 전환 애니메이션이 안 생긴다
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (query.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = query.theme;
    return () => {
      delete root.dataset.theme;
    };
  }, [query.theme]);

  const mod = variants[query.variant];

  function renderScreen(screen: ScreenId) {
    if (screen === "cats") return <CatsScreen />;
    const Screen = screen === "house" ? mod?.House : mod?.Workspace;
    if (Screen) return <Screen time={query.time} usage={query.usage === "ok" ? USAGE_OK : USAGE_UNAVAILABLE} work={query.work} />;
    return mod ? <TokenPreview meta={mod.meta} screen={screen} /> : null;
  }

  return (
    <div
      className={query.bar ? "vf vf--with-bar" : "vf"}
      data-testid="variant-frame"
      data-variant={query.variant}
      data-time={query.time}
      data-screen={query.screen}
    >
      <div className="vf__stage">{renderScreen(query.screen)}</div>
      {query.bar && (
        <VariantBar
          search={search}
          query={query}
          variantIds={variantIds}
          currentName={mod ? t(mod.meta.nameKey) : query.variant}
        />
      )}
    </div>
  );
}
