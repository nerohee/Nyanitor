// 단계 승인 질문 글 읽기 — 하네스 약속 `shared/app-contract.md` §7-2. 순수 함수 (화면 없이 시험한다).
// 질문 글이 `단계 승인 — P<번호> <이름>` 으로 시작하고 `- 무엇을:` · `- 왜 지금:` · `- 산출물:` · `- 하지 않는 것:` 가운데 하나라도 있으면 승인 카드로 읽는다.
// 순서가 달라도 찾고, 빠진 칸은 `null` ("읽을 수 없음" 으로 보인다). 네 줄이 하나도 없으면 `null` (보통 질문 카드).
import type { QuestionInfo, QuestionOption } from "../../lib/ipc-types";

export interface Approval {
  /** 첫 줄 전체 (`단계 승인 — P4 하네스 설치 · 업데이트`) */
  title: string;
  /** `P4` */
  phase: string;
  /** `하네스 설치 · 업데이트` (없으면 빈 글) */
  name: string;
  what: string | null;
  why: string | null;
  outputs: string | null;
  notDoing: string | null;
}

const TITLE = /^\s*단계\s*승인\s*[—–-]+\s*(P\d+)\s*(.*?)\s*$/;
const FIELD = /^\s*[-*•]\s*(무엇을|왜\s*지금|산출물|하지\s*않는\s*것)\s*[:：]\s*(.*?)\s*$/;

const FIELD_KEY: Record<string, "what" | "why" | "outputs" | "notDoing"> = {
  무엇을: "what",
  "왜지금": "why",
  산출물: "outputs",
  "하지않는것": "notDoing",
};

export function parseApproval(question: string): Approval | null {
  const lines = question.split(/\r?\n/);
  const first = lines.find((line) => line.trim() !== "");
  const head = first === undefined ? null : TITLE.exec(first);
  if (!head) return null;
  const found: Pick<Approval, "what" | "why" | "outputs" | "notDoing"> = { what: null, why: null, outputs: null, notDoing: null };
  let any = false;
  for (const line of lines) {
    const match = FIELD.exec(line);
    if (!match) continue;
    const key = FIELD_KEY[(match[1] ?? "").replace(/\s+/g, "")];
    const value = (match[2] ?? "").trim();
    if (!key) continue;
    any = true;
    // 같은 칸이 두 번 나오면 먼저 나온 것. 값이 빈 칸은 "읽을 수 없음"
    if (found[key] === null && value !== "") found[key] = value;
  }
  if (!any) return null;
  return { title: (first ?? "").trim(), phase: head[1] ?? "", name: head[2] ?? "", ...found };
}

/** 선택지 이름에서 `(권장)` 을 뗀 글 — `승인 (권장)` 과 `승인` 을 같게 본다 */
export function plainLabel(label: string): string {
  return label.replace(/[(（]\s*권장\s*[)）]/g, "").trim();
}

export type ApprovalChoice = "approve" | "redo";

const CHOICE_NAME: Record<ApprovalChoice, string> = { approve: "승인", redo: "고쳐서 다시" };

/** 승인 · 고쳐서 다시 가 질문의 어느 선택지인가 — 이름이 같은 것. 없으면 이름 그대로 (답은 글이라 그대로 보낸다) */
export function approvalLabel(question: QuestionInfo, choice: ApprovalChoice): string {
  const found: QuestionOption | undefined = question.options.find((option) => plainLabel(option.label) === CHOICE_NAME[choice]);
  return found?.label ?? CHOICE_NAME[choice];
}

/** 답한 값이 둘 중 무엇인가 (둘 다 아니면 `other` = 직접 쓴 글) */
export function approvalChoiceOf(value: string | string[] | undefined): ApprovalChoice | "other" | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? (value[0] ?? "") : value;
  if (plainLabel(text) === CHOICE_NAME.approve) return "approve";
  if (plainLabel(text) === CHOICE_NAME.redo) return "redo";
  return "other";
}
