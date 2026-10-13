// 시안 c — 다락 탑 (docs/01-planning/design-references.md)
import type { VariantMeta } from "../types";

export { House } from "./House";
export { Workspace } from "./Workspace";

export const meta: VariantMeta = {
  nameKey: "variant.c.name",
  summaryKey: "variant.c.summary",
  references: ["Richard Scarry", "Neko Atsume", "Apple HIG"],
};
