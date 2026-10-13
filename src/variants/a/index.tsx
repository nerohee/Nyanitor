// 시안 a — 들여다보는 창 (docs/01-planning/design-references.md)
import type { VariantMeta } from "../types";

export { House } from "./House";
export { Workspace } from "./Workspace";

export const meta: VariantMeta = {
  nameKey: "variant.a.name",
  summaryKey: "variant.a.summary",
  references: ["Neko Atsume", "Fluent 2", "Apple HIG"],
};
