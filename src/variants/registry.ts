import type { VariantModule } from "./types";

// `src/variants/a/index.tsx` 처럼 한 글자 폴더만 시안으로 본다 (틀 자신의 `frame/` 폴더는 빠진다).
const modules = import.meta.glob<VariantModule>("./*/index.tsx", { eager: true });

export const variants: Record<string, VariantModule> = {};
for (const [path, mod] of Object.entries(modules)) {
  const match = /^\.\/([a-z])\/index\.tsx$/.exec(path);
  if (match) variants[match[1]] = mod;
}

export const variantIds: readonly string[] = Object.keys(variants).sort();
