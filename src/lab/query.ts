// 시험 화면을 여는 주소 쿼리: `?lab=session` (개발 빌드에서만 — `App.tsx` 가 `import.meta.env.DEV` 와 함께 본다).

export function wantsSessionLab(search: string): boolean {
  return new URLSearchParams(search).get("lab") === "session";
}
