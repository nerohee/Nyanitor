import { CatFigure } from "../../components/cat/CatFigure";
import { CAT_IDS } from "../../components/cat/looks";
import { t } from "../../i18n/ko";
import { TIMES } from "../query";
import { MiniRoom } from "./MiniRoom";

/** `?screen=cats` — 고양이 규격이 실제로 되는지: 같은 부위 그림 + 털색 변수 · 무늬 · 소품 층으로 7마리 */
export function CatsScreen() {
  return (
    <section className="vf-cats" aria-labelledby="vf-cats-title">
      <header className="vf-cats__head">
        <h1 id="vf-cats-title" className="vf-h1">
          {t("variant.cats.title")}
        </h1>
        <p className="vf-muted">{t("variant.cats.desc")}</p>
      </header>

      <div className="vf-cats__grid">
        <MiniRoom className="vf-cats__room">
          <ul className="vf-cats__row">
            {CAT_IDS.map((cat) => (
              <li key={cat} className="vf-cats__cat">
                <CatFigure cat={cat} size={84} />
                <span className="vf-tag">
                  <b>{t(`cat.${cat}.name`)}</b>
                  <small>{t(`cat.${cat}.role`)}</small>
                </span>
              </li>
            ))}
          </ul>
        </MiniRoom>

        <aside className="vf-cats__side">
          <h2 className="vf-h2">{t("variant.cats.spec")}</h2>
          <div className="vf-cats__spec">
            <CatFigure cat="nabi" size={160} motion="still" guides label={t("cat.nabi.name")} />
          </div>
          <p className="vf-muted vf-small">{t("variant.cats.specNote")}</p>

          <h2 className="vf-h2">{t("variant.cats.times")}</h2>
          <ul className="vf-times">
            {TIMES.map((time) => (
              <li key={time} data-time={time} className="vf-times__item">
                <span className="vf-times__swatch" aria-hidden="true">
                  <span className="vf-times__sky" />
                  <span className="vf-times__wall" />
                  <span className="vf-times__floor" />
                </span>
                <span className="vf-small">{t(`variant.time.${time}`)}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </section>
  );
}
