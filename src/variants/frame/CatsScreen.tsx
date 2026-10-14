import { CatFigure } from "../../components/cat/CatFigure";
import { CAT_IDS, DEFAULT_CATALOG, POSES, resolvePose, type CatEntry } from "../../components/cat/catalog";
import { t } from "../../i18n/ko";

/** `?screen=cats` — 고양이 7마리 × 자세 9가지가 목록(catalog.json)대로 나오는지. 발은 모두 같은 바닥선 위에 선다. */
export function CatsScreen() {
  return (
    <section className="vf-cats" aria-labelledby="vf-cats-title">
      <header className="vf-cats__head">
        <h1 id="vf-cats-title" className="vf-h1">
          {t("variant.cats.title")}
        </h1>
        <p className="vf-muted">{t("variant.cats.desc")}</p>
      </header>

      <ul className="vf-cats__list">
        {CAT_IDS.map((id) => {
          const entry = DEFAULT_CATALOG.cats.find((cat) => cat.id === id) as CatEntry;
          return (
            <li key={id} className="vf-cats__row">
              <div className="vf-cats__who">
                <span className="vf-cats__face" aria-hidden="true">
                  <CatFigure cat={id} crop="face" />
                </span>
                <b>{t(`cat.${id}.name`)}</b>
                <small className="vf-muted">{t(`cat.${id}.role`)}</small>
              </div>
              <ul className="vf-cats__poses">
                {POSES.map((pose) => {
                  const shown = resolvePose(entry, pose)?.pose ?? pose;
                  return (
                    <li key={pose} className="vf-cats__pose">
                      <span className="vf-cats__frame">
                        <CatFigure cat={id} pose={pose} motion="still" label={`${t(`cat.${id}.name`)} ${pose}`} />
                      </span>
                      <small className="vf-muted">{shown === pose ? pose : `${pose} → ${shown}`}</small>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
