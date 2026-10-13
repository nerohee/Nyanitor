// 화면에 보이는 모든 문구는 여기에 둔다 (D-08). 코드 안에 한국어를 직접 쓰지 않는다.
const ko = {
  "app.placeholder": "준비 중입니다.",
  "app.nameLabel": "이름",
  "app.versionLabel": "버전",
  "app.loading": "앱 정보를 불러오는 중…",
  "error.internal": "앱 정보를 불러오지 못했어요. 앱을 다시 켜 보세요.",
  "error.invalid_input": "입력한 값이 올바르지 않아요.",
} as const;

export type TextKey = keyof typeof ko;

export function t(key: TextKey): string {
  return ko[key];
}
