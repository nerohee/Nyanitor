// 시안 틀 (P2). 주소 쿼리로 화면 · 상태 · 시간대 · 테마 · UI 판을 골라 띄운다 (query.ts). 시안은 a 로 정했다 (D-30) — b · c 는 지웠다.
// UI 판은 ① 나무 쟁반이 기본 (D-40). 1판(skin=0) · ② · ③ 은 보관 — 시안 막대에서 계속 고를 수 있다.
// 앱 화면이 이 틀을 대신하면 `src/variants/` 폴더째, `App.tsx` 의 연결 몇 줄, `ko.ts` 의 `variant.` 키를 지운다.
import { useEffect, useLayoutEffect, useState } from "react";
import { t } from "../i18n/ko";
import { USAGE_OK, USAGE_UNAVAILABLE } from "./fixtures";
import { parseFrameQuery, type ScreenId } from "./query";
import { variantIds, variants } from "./registry";
import { CatsScreen } from "./frame/CatsScreen";
import { CatPickScreen } from "./screens/CatPick";
import { HarnessScreen } from "./screens/Harness";
import { SettingsScreen } from "./screens/Settings";
import { SetupScreen } from "./screens/Setup";
import { VariantBar } from "./frame/VariantBar";
import "./frame/frame.css";
import "./skins/skins.css";

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
    const shared = { search, state: query.state, time: query.time };
    if (screen === "setup") return <SetupScreen {...shared} />;
    if (screen === "settings") return <SettingsScreen {...shared} />;
    if (screen === "harness") return <HarnessScreen {...shared} />;
    if (screen === "pick") return <CatPickScreen {...shared} />;
    const Screen = screen === "house" ? mod?.House : mod?.Workspace;
    return Screen ? <Screen time={query.time} usage={query.usage === "ok" ? USAGE_OK : USAGE_UNAVAILABLE} work={query.work} /> : null;
  }

  return (
    <div
      className={query.bar ? "vf vf--with-bar" : "vf"}
      data-testid="variant-frame"
      data-variant={query.variant}
      data-time={query.time}
      data-screen={query.screen}
      data-skin={query.skin === "0" ? undefined : query.skin}
    >
      <div className="vf__stage">{renderScreen(query.screen)}</div>
      {query.bar && (
        <VariantBar
          search={search}
          query={query}
          variantIds={variantIds}
          currentName={`${mod ? t(mod.meta.nameKey) : query.variant} · ${t(`variant.skin.${query.skin}`)}`}
        />
      )}
    </div>
  );
}
