// 한글 조사 고르기 — 이름 뒤에 받침이 있는지로 "이" · "가" 를 정한다 (예: 먹물이 · 나비가).
// 받침을 알 수 없는 끝 글자(영문 · 숫자 · 기호)는 받침이 없는 것으로 본다.

/** 마지막 글자에 받침이 있나 */
export function hasBatchim(word: string): boolean {
  const code = word.trim().charCodeAt(word.trim().length - 1);
  if (Number.isNaN(code) || code < 0xac00 || code > 0xd7a3) return false;
  return (code - 0xac00) % 28 !== 0;
}

/** 이름 + 이/가 — "먹물이" · "나비가" */
export function withSubject(name: string): string {
  return `${name}${hasBatchim(name) ? "이" : "가"}`;
}
