# Jua (주아) — 테마 시안 글꼴 (P2-11)

- 글꼴: **Jua Regular** — Woowahan Brothers (배달의민족 주아체), Copyright 2018 The Jua Project Authors
- 라이선스: **SIL Open Font License 1.1** — 같은 폴더 `OFL.txt` (원문)
- 받은 곳: https://github.com/google/fonts/tree/main/ofl/jua (원본 저장소 https://github.com/woowabros/Jua)
- 바꾼 것: 글자 줄이기(서브셋)만 — KS X 1001 한글 2,350자 + ASCII + 문장 부호 + `src/i18n/ko.ts` 에 쓰인 글자. woff2.
  `pyftsubset Jua-Regular.ttf --text-file=chars.txt --flavor=woff2 --layout-features='*'` (fontTools 4.67). 원본 2.1 MB → 343 KB.
- OFL 에 따라 글꼴 이름 "Jua" 를 그대로 쓰는 것은 서브셋(수정본)의 경우 예약 이름 조항이 없어 괜찮다 (Jua 의 OFL 에는 Reserved Font Name 이 없다). 글꼴 파일만 따로 팔지 않는다.
- 쓰는 곳: 제목 · 단추 · 탭 · 메뉴 글자 · 큰 숫자 (`--font-round`). 본문은 시스템 글꼴 그대로.
- 새 글자가 필요하면(KS X 1001 밖 한글) 위 명령으로 다시 만든다.
