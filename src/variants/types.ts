import type { ComponentType } from "react";
import type { TextKey } from "../i18n/ko";
import type { UsageFixture } from "./fixtures";
import type { WorkState } from "./fixtures-workspace";
import type { TimeOfDay } from "./query";

export interface VariantMeta {
  /** `variant.<id>.name` */
  nameKey: TextKey;
  /** `variant.<id>.summary` — 한 줄 설명 */
  summaryKey: TextKey;
  /** 가져온 레퍼런스 (design-references.md 의 이름) */
  references: readonly string[];
}

export interface ScreenProps {
  time: TimeOfDay;
  /** 사용량 가짜 데이터 (fixtures.ts) — 쿼리 usage=unavailable 이면 못 받은 상태 */
  usage: UsageFixture;
  /** 작업 공간 상태 (쿼리 state=running|waiting|empty) */
  work: WorkState;
}

/**
 * 시안 폴더 `src/variants/<한 글자>/index.tsx` 가 내보내는 것.
 * 폴더를 더하면 registry 가 알아서 붙이고, 폴더째 지우면 빠진다.
 */
export interface VariantModule {
  meta: VariantMeta;
  House?: ComponentType<ScreenProps>;
  Workspace?: ComponentType<ScreenProps>;
}
