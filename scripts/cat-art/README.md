# 고양이 · 집 그림 — 출처 · 프롬프트 · 라이선스

> Images in `src/assets/cats/` and `src/assets/house/` are AI-generated with the OpenAI Images API.
> The prompts used are in `prompts.json` in this folder. License: to be decided before release.

Nyanitor 의 고양이 · 집 그림은 **AI 로 생성** 했다. 이 폴더가 그 출처 기록이다.

| 파일 | 무엇 |
|---|---|
| `prompts.json` | 프롬프트 표 — 모든 그림의 프롬프트 · 참조 순서 · 크기 · 맞춤 규격. **저장소에 남는 출처 기록** |
| `generate.py` | 표를 읽어 그림을 만든다 (OpenAI 이미지 API). 사용법은 `python scripts/cat-art/generate.py --help` |
| `fit.py` | 만든 그림을 앱에 넣을 크기 · 기준점으로 맞춘다. 사용법은 `python scripts/cat-art/fit.py --help` |
| `README.md` | 이 문서 |

## 출처 기록

그림을 만들거나 다시 만들 때마다 한 줄씩 더한다. 프롬프트는 그때의 `prompts.json` 커밋으로 가리킨다.

| 묶음 (`group`) | 도구 · 모델 | 품질 | 만든 날짜 | 프롬프트 (`prompts.json` 커밋) | 비고 |
|---|---|---|---|---|---|
| `test` | OpenAI 이미지 API · (모델) | | | | |
| `sheets` | | | | | |
| `cats` | | | | | |
| `objects` | | | | | |
| `backgrounds` | | | | | |

- 맞춘 그림이 들어가는 곳: `src/assets/cats/<고양이 id>/` · `src/assets/house/`. 그 폴더에도 "AI 생성 (OpenAI, 날짜), 프롬프트는 `scripts/cat-art/`" 한 줄을 둔다 (그림을 붙이는 작업에서).
- 원본(`art/raw/`)과 장부(`art/raw/ledger.jsonl`)는 저장소에 넣지 않는다.
- **화풍 기준 그림 2장** — 고객이 다른 도구로 만든 판단용 그림. 생성 때 참조로만 넣고, 저장소 · 앱에는 넣지 않는다 (`prompts.json` 의 `references` 경로는 고객 PC 의 로컬 문서 폴더).

## 라이선스

**출시 전 확정.** 정할 것: 그림 라이선스 (예: CC0 · CC BY 4.0 · 앱 코드와 같은 라이선스), 저장소 · 배포본 표기 문구. OpenAI 이용 약관상 생성물의 권리는 만든 사람에게 있다 (결정 기록 D-34). 확정 전에는 이 그림을 다른 곳에 따로 배포하지 않는다.

## 프롬프트를 고칠 때

- 특정 게임 · 회사 · 작가 이름이나 상표를 쓰지 않는다. 화풍은 말로 풀어 쓴다.
- 고친 프롬프트로 다시 만든 그림은 위 표에 날짜와 커밋을 적는다 — 어떤 그림이 어떤 프롬프트에서 나왔는지 늘 거슬러 갈 수 있게.
- API 키는 환경 변수 `OPENAI_API_KEY` 에만 둔다. 이 폴더 · 표 · 장부 어디에도 쓰지 않는다.
- 화풍 · 규격 · 그림 목록의 기준은 프로젝트 문서(`cat-art-guide.md` · `cat-assets.md`)에 있다.
