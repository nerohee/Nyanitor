// 시안 b — 선반 위 띠 (docs/01-planning/design-references.md)
import type { VariantMeta } from "../types";

export { House } from "./House";
export { Workspace } from "./Workspace";

export const meta: VariantMeta = {
  nameKey: "variant.b.name",
  summaryKey: "variant.b.summary",
  references: ["Linear", "Neko Atsume", "Fluent 2"],
};
