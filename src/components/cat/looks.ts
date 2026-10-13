// 고양이 7마리의 생김새 (docs/01-planning/cat-assets.md §6). 털색은 tokens.css 의 [data-cat].
// 색만으로 구분하지 않도록 무늬 · 소품 · 꼬리 모양 · 몸 크기가 함께 다르다.

export const CAT_IDS = ["nabi", "mulgam", "danchu", "mukmul", "kkaebi", "dubu", "gureum"] as const;
export type CatId = (typeof CAT_IDS)[number];

export type PatternId = "tabby" | "calico" | "tuxedo" | "none";
export type PropId = "bell" | "beret" | "glasses";

export interface CatLook {
  pattern: PatternId;
  props: readonly PropId[];
  /** 꼬리 모양 — 먹물은 끝이 굽음 (서기 자세에서만 다름) */
  tail: "plain" | "kink";
}

export const CAT_LOOKS: Record<CatId, CatLook> = {
  nabi: { pattern: "tabby", props: ["bell"], tail: "plain" },
  mulgam: { pattern: "calico", props: ["beret"], tail: "plain" },
  danchu: { pattern: "tuxedo", props: [], tail: "plain" },
  mukmul: { pattern: "none", props: [], tail: "kink" },
  kkaebi: { pattern: "tabby", props: [], tail: "plain" },
  dubu: { pattern: "none", props: [], tail: "plain" },
  gureum: { pattern: "none", props: ["glasses"], tail: "plain" },
};
