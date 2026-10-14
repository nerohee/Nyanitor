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

## 맞춤 — `fit.py` 사용법 (2판: 합친 그림 · 빈 물건)

`prompts.json` 에서 `final` 이 있는 항목만 `src/assets/` 로 맞춘다 (`--dry-run` 은 쓰지 않고 할 일만 보여 준다).

```text
# 기본 자세 (v2-cats): 같은 고양이는 같은 배율, 다른 고양이는 나비의 같은 자세 크기 (size_like)
python scripts/cat-art/fit.py --group v2-cats --same-scale --dry-run

# 합친 그림 · 빈 물건: 물건 기준 맞춤 전 · 후를 겹쳐 본다 (src/assets 는 안 건드린다, 결과는 art/raw/v2/overlay/)
python scripts/cat-art/fit.py --group v2-empty v2-objects v2-combos --overlay

# 실제 맞춤 (src/assets 를 덮어쓴다 — 앱 장면 코드와 같이 돌릴 것)
python scripts/cat-art/fit.py --group v2-empty v2-objects v2-combos v2-cats --same-scale
```

표 항목 키 (모두 선택):

| 키 | 뜻 |
|---|---|
| `align_to: "<항목 id>"` | **합친 그림 → 빈 물건(또는 다른 합친 그림) 겹침 맞춤** (anchor `none` 전용). 빈 그림의 불투명 영역을 틀로, 합친 그림에서 같은 색 점이 가장 많이 겹치는 이동(물건 가운데 기준 판의 ±5%, `--align-range`) · 배율(0.95~1.05)을 찾아 옮긴 뒤 판 크기로 저장 대상이 스스로 옮겨지는 합친 그림이면 **그 항목의 맞춘 뒤 모습**이 기준이다 (공 `with-ball-2` 는 같은 고양이 `with-ball-1` 의 맞춘 모습에 맞춰 고양이 뒷몸 · 꼬리를 프레임 사이에 같게 한다). 돌고 도는 연결은 표 검사에서 막는다 |
| `align_scale: [최소, 최대]` · `align_range: 0.15` | `align_to` 항목 전용. 이 항목의 맞춤 **배율 범위**(최소 ≤ 1 ≤ 최대, 기본 0.95~1.05) · **이동 한도**(판 대비, 기본 `--align-range`) — 인자 기본값보다 **앞선다**. 고양이가 통째로 1.1~1.25배 크게 그려진 그림(공 `with-ball-1/-2`)에 쓴다. 범위가 넓으면 배율 후보 간격도 넓어진다 |
| `move_like: "<항목 id>"` | 대상(`align_to` 나 `nudge` 가 있는 항목)과 **같은 이동**을 쓴다 — 물건이 굴러간 `with-ball-2` 가 `with-ball-1` 을 따르는 식 (지금 표는 `with-ball-2` 가 `align_to` 로 `with-ball-1` 에 맞춰 이 키를 안 쓴다). 대상이 옮기지 않았으면 같이 안 옮긴다 |
| `nudge: [dx, dy, 배율]` | 손으로 정한 이동 — **자동 찾기를 대신한다** (같이 있는 `align_to` 는 `--overlay` 의 윤곽선용). 판 px, **판 가운데 기준**: 합친 그림의 점 p 는 `c + 배율 × (p - c) + (dx, dy)` 로 옮겨진다. 자동 맞춤이 찍어 주는 `이동 (dx, dy) 배율 s` 를 그대로 베껴 조금 고치면 된다 |
| `crop_group: "<이름>"` | (선택 기능) 같은 이름 항목들의 **맞춘 내용 합집합 상자**로 모두 같게 잘라 판(1024²)을 줄인다. 묶음 전체를 한 번에 골라야 하고, 상자의 판 좌표는 `src/assets/crop-boxes.json`(`--crop-info`) 에 적힌다. 지금 표에는 넣지 않았다 — 앱이 쓰기로 정한 뒤 물건마다(빈 물건 + 합친 그림 전부) 같은 이름을 붙인다. 끄려면 `--no-crop` |

`crop-boxes.json` 모양: `{"version": 1, "groups": {"<이름>": {"canvas": [W, H], "origin": [x, y], "size": [w, h], "files": ["cats/nabi/with-bowl.webp", …]}}}` — 잘린 그림의 **왼쪽 위가 판의 (x, y)** 에 있다. 묶음 항목이 모두 저장됐을 때만 그 묶음 기록을 갱신하고, 다른 묶음 기록은 그대로 둔다.

맞춤 점수 · 한계:

- 점수 = 빈 물건의 불투명한 점 중, 이동한 합친 그림에서도 불투명하고 **색이 비슷한(R·G·B 차이 48 이하)** 점의 비율. 고양이가 가린 곳은 어느 이동에서도 안 겹치니 점수 상한이 그만큼 낮아진다 (실제 그림: 그릇 0.9 · 방석 0.7 · 상자 0.8 · 캣타워 0.9 · 캣휠 0.9, 공 1.0).
- 점수가 `--align-min-score`(기본 0.45) 보다 낮으면 **경고하고 옮기지 않는다**. 이동 · 배율 한도에 닿은 결과는 0.60 이상이어야 받는다 (한도 밖의 진짜 위치를 못 찾고 가장자리에 걸린 가짜 일치를 거르려고). 이동 없이도 점수가 같은(0.01 미만 차이) 그림은 다시 뽑아 흐려지지 않도록 그대로 둔다.
- 고양이가 물건을 많이 가리는 그림(그릇에 머리를 박은 것 등) 은 가려진 만큼 신호가 약하다. 그래도 눈에 띄는 윤곽 · 색 덩어리가 보이면 맞지만, 가려진 부분에 기대는 맞춤은 아니라는 것을 기억할 것 — **옮긴 결과는 `--overlay` 의 `*-grid-after.png` 로 눈으로 확인**한다.
- 이동 한도(5%) 밖으로 크게 밀린 그림은 위 이유로 거절된다 → `--align-range 0.15` 로 넓혀 보거나, `nudge` 로 손보거나, 그 그림을 다시 뽑는다.
- 옮기느라 판 밖으로 잘려 나간 불투명한 점이 0.2% 를 넘으면 알린다.

`--overlay` 가 `art/raw/v2/overlay/` (`--overlay-dir`, 상대 경로는 `art/` 안) 에 만드는 그림 — 물건마다 4장:

- `<물건>-stack-before.png` · `-after.png` — 빈 물건과 합친 그림들을 같은 무게로 겹친 평균 (물건이 겹치면 선명, 어긋나면 번짐) + 빈 물건 윤곽선(자홍색).
- `<물건>-grid-before.png` · `-after.png` — 합친 그림마다 한 칸, 빈 물건 윤곽선을 그 위에. 칸 이름 옆에 적용한 이동 (`+1,-6 x1.019`, 옮기지 않았으면 `(not moved)`). 윤곽선이 물건 테두리에 겹쳐야 맞은 것.

기타 인자: `--no-align`(빈 물건 원본이 아직 없을 때 — 판 그대로 맞춤), `--frame-group`(`--same-scale` · `--match-frames` 판단에 더할 그룹. 기본은 `cats` 와 `-cats` 로 끝나는 그룹 = `v2-cats`), `--align-min-score`, `--align-range`. 자세한 설명은 `python scripts/cat-art/fit.py --help`.

시험: `python -m unittest discover -s scripts/cat-art/tests` (가상 환경의 파이썬으로).

## 라이선스

**출시 전 확정.** 정할 것: 그림 라이선스 (예: CC0 · CC BY 4.0 · 앱 코드와 같은 라이선스), 저장소 · 배포본 표기 문구. OpenAI 이용 약관상 생성물의 권리는 만든 사람에게 있다 (결정 기록 D-34). 확정 전에는 이 그림을 다른 곳에 따로 배포하지 않는다.

## 프롬프트를 고칠 때

- 특정 게임 · 회사 · 작가 이름이나 상표를 쓰지 않는다. 화풍은 말로 풀어 쓴다.
- 고친 프롬프트로 다시 만든 그림은 위 표에 날짜와 커밋을 적는다 — 어떤 그림이 어떤 프롬프트에서 나왔는지 늘 거슬러 갈 수 있게.
- API 키는 환경 변수 `OPENAI_API_KEY` 에만 둔다. 이 폴더 · 표 · 장부 어디에도 쓰지 않는다.
- 화풍 · 규격 · 그림 목록의 기준은 프로젝트 문서(`cat-art-guide.md` · `cat-assets.md`)에 있다.
