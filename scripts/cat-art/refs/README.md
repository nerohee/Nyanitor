# 기준 그림 (refs)

이 폴더 = 새 고양이 · 배경을 **같은 화풍으로** 만들 때 참조하는 그림이다. OpenAI 이미지 API 로 생성 (날짜 2026-10-14, 모델 `gpt-image-2.5-sunburst-2026-09-08`) — 생성물은 사용자 소유 (결정 D-34 · D-35). WebP (품질 92), 원본과 같은 1536×1024.

| 파일 | 내용 | 원본 (저장소 밖) |
|---|---|---|
| `sheet-<id>.webp` (7장: nabi · mulgam · danchu · mukmul · kkaebi · dubu · gureum) | 고양이 설정 그림 | `art/raw/cats/<id>/sheet.png` |
| `bg-hanok.webp` | 한옥 빈 배경 초안 | `art/raw/house/bg-draft.png` |

`prompts.json` 의 `references` 에 `ref-sheet-<id>` · `ref-bg-hanok` 이름으로 들어 있다. 기존 항목(원본 `art/raw/` 경로)은 그대로다.

## 새 고양이를 더하는 방법
1. `prompts.json` 에 설정 그림 항목 `cat-<새id>-sheet` 를 더한다 — `then_ref_as: "cat-<새id>"`, `refs: ["ref-sheet-nabi"]` (화풍 기준), `final` 없음.
2. 그 뒤에 자세 항목들 — `refs: ["cat-<새id>", ...]`, `size_like: "cat-nabi-<자세>"`, `final: src/assets/cats/<새id>/<자세>.webp`. 설정 그림 → 자세 순서 (참조는 항상 앞 항목).
3. `generate.py --only cat-<새id>-sheet` 로 설정 그림부터 뽑아 고르고, 이어서 `--group cats` 등으로 자세를, `fit.py --only … --same-scale` 로 맞춘다.
4. 설정 그림이 확정되면 `sheet-<새id>.webp` 로 이 폴더에 더하고 `references` 에 `ref-sheet-<새id>` 를 추가한다.
- 주의: 기존 자세 항목의 `nabi-pose-<자세>` 참조는 `art/raw/` 원본이라 저장소에 없다. 다른 PC 에서는 그 줄을 빼거나 `src/assets/cats/nabi/<자세>.webp` 로 바꾼다.
