// 질문 카드에서 고르던 값 — 카드가 화면에서 사라졌다 다시 그려져도(다른 프로젝트 · 집 화면에 갔다 옴) 남도록 앱 안에 들고 있다.
// 답을 보냈거나 카드가 닫히면(`answered` · `cancelled` · `expired`) 지운다. 키는 요청 번호(`requestId`).
export interface DraftSelection {
  picks: number[];
  write: boolean;
  text: string;
}

export interface QuestionDraft {
  selections: DraftSelection[];
  /** 보고 있는 칸 — 0..질문 수-1 은 질문, 질문 수는 요약 */
  step: number;
}

const drafts = new Map<string, QuestionDraft>();

export const getDraft = (requestId: string): QuestionDraft | undefined => drafts.get(requestId);
export const setDraft = (requestId: string, draft: QuestionDraft): void => void drafts.set(requestId, draft);
export const dropDraft = (requestId: string): void => void drafts.delete(requestId);
/** 시험용 — 앱 전체에 하나뿐인 저장소를 비운다 */
export const resetCardDrafts = (): void => drafts.clear();
