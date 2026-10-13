import { CatFigure } from "../../components/cat/CatFigure";
import { t } from "../../i18n/ko";
import type { ScreenId } from "../query";
import type { VariantMeta } from "../types";
import { MiniRoom } from "./MiniRoom";

/** 시안 폴더에 아직 그 화면이 없을 때 — 시안 이름 · 한 줄 설명 · 그 시안의 토큰(강조색 · 둥글기 · 그림자)을 보인다. */
export function TokenPreview({ meta, screen }: { meta: VariantMeta; screen: Exclude<ScreenId, "cats"> }) {
  return (
    <section className="vf-preview" aria-labelledby="vf-preview-title">
      <MiniRoom className="vf-preview__room">
        <div className="vf-preview__cats">
          <CatFigure cat="nabi" size={112} />
          <CatFigure cat="kkaebi" size={112} />
        </div>
      </MiniRoom>

      <div className="vf-card vf-preview__card">
        <p className="vf-eyebrow">{t(`variant.screen.${screen}`)}</p>
        <h1 id="vf-preview-title" className="vf-h1">
          {t(meta.nameKey)}
        </h1>
        <p>{t(meta.summaryKey)}</p>
        <p className="vf-muted vf-small">{t(`variant.placeholder.${screen}`)}</p>

        <div className="vf-preview__actions">
          <button type="button" className="vf-btn vf-btn--primary">
            {t("variant.preview.primary")}
          </button>
          <button type="button" className="vf-btn">
            {t("variant.preview.secondary")}
          </button>
        </div>

        <ul className="vf-preview__list">
          <li className="vf-preview__row is-selected">{t("variant.preview.selected")}</li>
          <li className="vf-preview__row">{t("variant.preview.body")}</li>
          <li className="vf-preview__row vf-muted">{t("variant.preview.muted")}</li>
        </ul>
        <p className="vf-accent-text">{t("variant.preview.link")}</p>
        <p className="vf-muted vf-small">{meta.references.join(" · ")}</p>
      </div>
    </section>
  );
}
