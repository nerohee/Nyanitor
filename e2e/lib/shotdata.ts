// README 그림에 쓰는 프로젝트 자료 — 이름 · 요구사항 · 단계 문서. 앱이 DB 를 만든 뒤에 시험 쪽에서 넣는다 (프로젝트 고르기는 OS 폴더 대화상자라 누를 수 없다).
// 하네스 · 사용량 · 대화 녹화는 `shotfiles.ts`.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { seedProject } from "./db.ts";
import { clockSeconds } from "./shotfiles.ts";
import { sandbox } from "./ui.ts";

// ───────────────────────── 프로젝트 ─────────────────────────

export const PROJECT_MAIN = "고양이 카페 예약";
export const PROJECT_LIBRARY = "동네 도서관 앱";
export const PROJECT_WALK = "산책 기록 앱";

const REQUIREMENTS_MAIN = `# 고양이 카페 예약

## 하려는 일
고양이 카페 손님이 방문할 날짜 · 시간 · 인원을 골라 예약하는 웹 앱.

## 꼭 필요한 것
- 손님은 날짜 · 시간 · 인원(1~4명)을 골라 예약한다.
- 같은 시간대에는 최대 8명까지만 받는다.
- 예약이 끝나면 예약 번호가 나오는 확인 화면을 보여 준다.
- 카페 주인은 오늘 예약을 한눈에 본다.
- 취소는 방문 하루 전까지 할 수 있다.

## 나중에
- 알림 문자 · 결제
`;

const DEV_PLAN_MAIN = `# 고양이 카페 예약 개발 계획

## 작업 규칙
1. 모든 단계는 시작 전 승인을 받는다.
2. 범위가 바뀌면 이 문서를 먼저 고친다.

## 단계 개요
| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |
|---|---|---|---|---|
| P0 | 셋업 · 기획 확정 | 직접 | 기획 승인 | 완료 (2026-10-26) |
| P1 | 요구사항 정리 | 직접 → reviewer | 요구사항 승인 | 진행 중 (2026-10-26) — 마지막 점검 |
| P2 | 예약 화면 시안 | designer | 시안 고르기 | |
| P3 | 예약 받기 · 저장 | ui · system → tester | 실행 확인 | |
| P4 | 주인용 오늘 예약 목록 | ui · system | 실행 확인 | |
| P5 | 마무리 점검 | reviewer · tester | 점검 결과 승인 | |

담당: \`designer\` = 디자인, \`ui\` = 화면, \`system\` = 서버 · 저장

## P1. 요구사항 정리
- 목표: 손님과 주인이 하는 일을 짧은 문장으로 정한다.

## P2. 예약 화면 시안
- 목표: 손님이 보는 예약 화면의 모양을 세 가지로 그려 보고 하나를 고른다.
`;

const HANDOFF_MAIN = `# 이어 하기 메모

- 스킬: \`web-full\`
- 요구사항: \`requirements.md\` (프로젝트 루트)
- 지금 단계: **P1 요구사항 정리 — 진행 중 (2026-10-26)**
- 마지막 갱신: 2026-10-26

## 지금 상태

**작업자 일하는 중 — P1 문서 정리 · 요구사항 점검 (2026-10-26)**

## 진행 중인 작업

| 지시서 | 담당 | 상태 | 맡길 때 git | 보고 |
|---|---|---|---|---|
| \`briefs/P1-01-문서-정리.md\` | helper | 맡김 (2026-10-26) | | |
| \`briefs/P1-02-요구사항-점검.md\` | reviewer | 맡김 (2026-10-26) | | |

## 사용자에게 기다리는 것

- P2 단계 승인

## 다음 할 일

1. P1 점검이 끝나면 P2 시안.
`;

const BRIEF_DOCS = `# P1-01 문서 정리

- 담당: \`helper\` · 단계: P1

## 작업 항목
- [x] 요구사항 문장 맞추기
- [ ] 문서 폴더 정리
`;

const BRIEF_REVIEW = `# P1-02 요구사항 점검

- 담당: \`reviewer\` · 단계: P1

## 작업 항목
- [x] 빠진 경우 찾기
- [ ] 겹치는 문장 정리
- [ ] 결과 보고
`;

const REQUIREMENTS_SMALL = (title: string, line: string) => `# ${title}\n\n- ${line}\n`;

/** 프로젝트 셋을 만들고 "최근에 연 때" 를 정한다. 반환은 이름 → 번호 */
export function seedProjects(): Record<string, number> {
  const main = seedProject(
    PROJECT_MAIN,
    {
      "requirements.md": REQUIREMENTS_MAIN,
      "docs/02-development/dev-plan.md": DEV_PLAN_MAIN,
      "docs/02-development/handoff.md": HANDOFF_MAIN,
      "docs/02-development/briefs/P1-01-문서-정리.md": BRIEF_DOCS,
      "docs/02-development/briefs/P1-02-요구사항-점검.md": BRIEF_REVIEW,
    },
    "/web-full",
  );
  const library = seedProject(PROJECT_LIBRARY, { "requirements.md": REQUIREMENTS_SMALL("동네 도서관 앱", "책 제목으로 찾고 빌릴 수 있는지 본다.") }, "/web-lite");
  const walk = seedProject(PROJECT_WALK, { "requirements.md": REQUIREMENTS_SMALL("산책 기록 앱", "오늘 걸은 거리와 시간을 적는다.") }, "/web-lite");
  const ids = { [PROJECT_MAIN]: main.id, [PROJECT_LIBRARY]: library.id, [PROJECT_WALK]: walk.id };
  stampRecent();
  seedTodayChurros(main.id);
  return ids;
}

/** 오늘 앱이 쓴 세션 츄르 — 앱은 턴이 끝나야 적는데 그림의 대화는 승인 카드에서 멈춰 있어서, 앞서 끝난 턴 셋을 미리 넣는다 (토큰 네 종의 합 = 21,300 + 18,400 + 12,600 = 52,300) */
function seedTodayChurros(projectId: number): void {
  const db = new DatabaseSync(path.join(sandbox.data, "nyanitor.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    // 시각은 실제 지금 — 앱의 "오늘" (이 PC 의 자정부터) 에 들어가야 한다. 그림 속 시계와는 따로다
    const at = Math.floor(Date.now() / 1000);
    const insert = db.prepare(
      "INSERT INTO usage_turns (project_id, session_id, run_id, at, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, outcome, api_key_source) VALUES (?, NULL, 0, ?, ?, ?, ?, ?, ?, 'success', 'none')",
    );
    insert.run(projectId, at, 4, 620, 8_076, 12_600, 0.0125);
    insert.run(projectId, at, 3, 540, 6_257, 11_600, 0.0102);
    insert.run(projectId, at, 2, 410, 4_188, 8_000, 0.0071);
  } finally {
    db.close();
  }
}

/** 프로젝트를 열면 앱이 "최근에 연 때" 를 실제 시각으로 고친다 — 집 그림을 찍기 전에 정한 값으로 되돌린다 */
export function stampRecent(): void {
  const db = new DatabaseSync(path.join(sandbox.data, "nyanitor.db"));
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const set = db.prepare("UPDATE projects SET last_opened_at = ?, created_at = ? WHERE name = ?");
    set.run(clockSeconds(-12), clockSeconds(-60 * 24 * 3), PROJECT_MAIN);
    set.run(clockSeconds(-60 * 3), clockSeconds(-60 * 24 * 9), PROJECT_LIBRARY);
    set.run(clockSeconds(-60 * 24 * 2), clockSeconds(-60 * 24 * 12), PROJECT_WALK);
  } finally {
    db.close();
  }
}

