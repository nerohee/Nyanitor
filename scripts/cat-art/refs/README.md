# 기준 그림 (refs)

이 폴더 = 새 고양이 · 배경 · 물건을 **같은 화풍으로** 만들 때 참조하는 그림이다. OpenAI 이미지 API 로 생성 (모델 `gpt-image-2.5-sunburst-2026-09-08`) — 생성물은 사용자 소유 (결정 D-34 · D-35). WebP (품질 92), 원본과 같은 크기.

## 지금 있는 것 — 1판 (2026-10-14)

| 파일 | 내용 | 2판에서 |
|---|---|---|
| `bg-hanok.webp` | 1판 한옥 빈 배경 (원본 `art/raw/house/bg-draft.png`) | 배경 생성의 **둘째 참조** (`ref-bg-hanok`) — 한옥 부품 모양만. 크기 · 배치는 따르지 않는다 (부품이 크게 그려짐, `docs` 의 `cat-art-guide.md` §1) |
| `sheet-<id>.webp` (7장) | 1판 고양이 설정 그림 (통통한 체형) | **쓰지 않는다** — 2판 고양이에 넣으면 통통함이 옮는다 (D-38). 1판 기록으로만 남김 |

## 2판 (D-38) — 2026-10-14 고객 확인 뒤 넣음

| 넣을 파일 | 원본 (저장소 밖) | `prompts.json` 의 `references` 이름 | 언제 |
|---|---|---|---|
| `bg-v2.webp` | `art/raw/v2/house/bg-day.png` (고른 후보 b2 — b 의 지붕 · 방만 고침) | `ref-bg-v2` | 넣음 |
| `sheet-v2-<id>.webp` (7장) | `art/raw/v2/cats/<id>/sheet.png` | `ref-sheet-v2-<id>` | 넣음 |
| `obj-v2-<물건>.webp` (6장: bowl · cushion · box · ball · tower · wheel) | 그릇 · 방석 · 공 · 캣타워는 `art/raw/v2/house/<물건>-empty.png` (나비 합친 그림에서 고양이를 지운 것 — 앱에 쓰는 빈 그림), 상자 · 캣휠은 `<물건>.png` | `ref-obj-v2-<물건>` | 넣음 |
| `with-<물건>[-n]-nabi.webp` (8장) | `art/raw/v2/cats/nabi/with-*.png` | `ref-with-<물건>[-n]` | 넣음 — 새 고양이의 합친 그림 첫 참조 (공 · 캣휠은 고친 뒤 판) |

- 넣을 때 `bg-hanok.webp` · `sheet-<id>.webp`(1판)는 지우지 않는다 (1판 기록). 2판이 확정되면 `references` 에서 `ref-bg-hanok` 만 남기고 정리할지 메인이 판단.
- 투명 그림(물건 · 합친 그림)은 WebP 알파 무손실로.

## 새 고양이를 더하는 방법 (2판)

1. 설정 그림: `prompts.json` 에 `cat-v2-<새id>-sheet` — `refs: ["ref-sheet-v2-nabi", "style-scene-cats"]`, `then_ref_as: "cat-v2-<새id>"`, 프롬프트는 다른 6마리 설정 그림 항목과 같은 틀 (털 · 눈 · 소품 문장만 새로). `final` 없음.
2. 합친 그림 8장: `v2-<새id>-with-<물건>` — `refs: ["ref-with-<물건>", "cat-v2-<새id>"]` (둘째 프레임은 + 자기 첫 프레임), `anchor: "none"`, `canvas` 는 물건 판과 같게, `final: src/assets/cats/<새id>/with-<물건>.webp`. **나비의 합친 그림을 첫 참조로 고쳐 그려야 물건이 같게 나온다.**
3. 기본 자세 7장: `v2-<새id>-<자세>` — `refs: ["v2-nabi-<자세>" 의 보관본, "cat-v2-<새id>"]`, `anchor: "feet"`, `canvas: "512x512"`, `size_like: "v2-nabi-<자세>"`.
4. `generate.py --only …` 로 설정 그림부터 → 고르고 → 나머지. `fit.py --only … --same-scale` 로 맞춘다.
5. 확정되면 `sheet-v2-<새id>.webp` 로 이 폴더에 더하고 `references` 에 `ref-sheet-v2-<새id>`, 카탈로그(`src/assets/cats/catalog.json`)에 `poses` · `with` 를 적는다 (`docs` 의 `cat-assets.md` §A8).
- 화풍 기준 `style-scene-cats` 는 고객 PC 의 로컬 문서 폴더에만 있다 (Gemini 그림 — 저장소에 넣지 않음, D-34). 다른 PC 에서는 그 참조를 빼고 `ref-sheet-v2-nabi` 만으로 만든다.
