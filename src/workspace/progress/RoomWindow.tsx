// 둥근 창문 두 가지 — 진행 탭 맨 위의 큰 창문(같은 마당을 잘라 보는 장면)과 탭 줄 오른쪽의 작은 창문(일하는 고양이 얼굴 단추). 시제품 `variants/a/Workspace.tsx` 의 `RoomWindow` · `MiniWindow`.
import { CatFigure } from "../../components/cat/CatFigure";
import { HouseScene } from "../../components/house/HouseScene";
import type { TimeOfDay } from "../../components/house/time";
import { t, tf } from "../../i18n/ko";
import type { WindowScene } from "./placement";
import { catName } from "./workerCat";

/** 큰 둥근 창문 — 일하는 고양이가 캣휠 · 캣타워에, 먹물이 기다리면 댓돌에 */
export function RoomWindow({ scene, time }: { scene: WindowScene; time: TimeOfDay }) {
  const label = scene.all.length > 0 ? tf("ws.window.some", { cats: scene.all.map(catName).join(", ") }) : t("ws.window.none");
  return (
    <div className="ws-win" role="img" aria-label={label}>
      <HouseScene className="ws-win__room" time={time} placements={scene.placements} crop={scene.crop} />
    </div>
  );
}

/** 탭 줄 오른쪽 작은 둥근 창문 — 지금 일하는 첫 고양이의 얼굴 (없으면 먹물), 둘 이상이면 작은 수. 누르면 진행 탭으로 */
export function MiniWindow({ cat, count, onOpen }: { cat: WindowScene["focus"]; count: number; onOpen: () => void }) {
  const label = count > 0 ? tf("ws.window.mini.some", { n: count }) : t("ws.window.mini.none");
  return (
    <button type="button" className="ws-mini" onClick={onOpen} aria-label={label} title={label} data-working={count > 0 ? "true" : undefined}>
      <span className="ws-mini__face" aria-hidden="true">
        <CatFigure cat={cat} crop="face" />
      </span>
      {count > 1 ? (
        <span className="ws-mini__count" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </button>
  );
}
