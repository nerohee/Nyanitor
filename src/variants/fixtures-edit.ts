// 내 수정 (P2-14 화면 설계 묶음 2 · 기능은 P9) 가짜 데이터 — 에이전트 · 스킬 목록, 내 수정 종류, 기록(로컬 git, D-21), 원본 바뀜(D-05).
// 세 층 (D-05): 원본 ~/.claude-harness/repo/ (고치지 않음) · 내 수정 ~/.claude-harness/custom/ (앱에서 고친 것 전부) · 실제 ~/.claude/ (겹쳐 만든 것).
// 수정은 가능하면 덧붙이기 — 모델 · 수준은 값만, 지시는 원본 끝에 덧붙일 글, 새 에이전트 · 스킬은 새 파일. 통째로 바꾼 파일만 원본이 바뀌면 고른다.
import type { CatId } from "../components/cat/catalog";
import type { TextKey } from "../i18n/ko";
import type { DiffLine } from "./fixtures-screens";

/** 첫 번째가 기본 */
export const EDIT_STATES = ["list", "dirty", "replace", "new", "history", "conflict"] as const;
export type EditState = (typeof EDIT_STATES)[number];

export type EditKind = "main" | "agent" | "skill";

/**
 * 이 파일에 내가 한 것 — none 원본 그대로 · values 모델 · 수준만 · append 지시 덧붙임 · replace 통째로 바꿈 · mine 내가 만든 파일
 * (values 와 append 는 함께일 수 있다)
 */
export type CustomMark = "values" | "append" | "replace" | "mine";

export type ModelId = "opus" | "sonnet" | "haiku";
export type EffortId = "low" | "medium" | "high";

export interface EditItem {
  id: string;
  kind: EditKind;
  nameKey: TextKey;
  /** 원본(또는 내 것) 파일 — 하네스 폴더 기준 */
  file: string;
  /** 에이전트면 고양이 */
  cat?: CatId;
  descKey: TextKey;
  /** 원본 값 (에이전트 · 오케스트레이터) */
  model?: ModelId;
  effort?: EffortId;
  /** 내가 바꾼 값 */
  myModel?: ModelId;
  myEffort?: EffortId;
  /** 덧붙인 지시 */
  appendKey?: TextKey;
  marks: CustomMark[];
  /** 원본이 바뀌었는데 내가 통째로 바꾼 파일 — 골라야 함 */
  originChanged?: boolean;
}

export const EDIT_ITEMS: EditItem[] = [
  {
    id: "main",
    kind: "main",
    nameKey: "variant.agent.main",
    file: "config.local.json · planner",
    cat: "mukmul",
    descKey: "variant.fixture.edit.main.desc",
    model: "opus",
    effort: "high",
    marks: [],
  },
  {
    id: "designer",
    kind: "agent",
    nameKey: "variant.agent.designer",
    file: "agents/harness-designer.md",
    cat: "mulgam",
    descKey: "variant.fixture.edit.designer.desc",
    model: "opus",
    effort: "high",
    marks: ["replace"],
    originChanged: true,
  },
  {
    id: "builder-ui",
    kind: "agent",
    nameKey: "variant.agent.builder-ui",
    file: "agents/harness-builder-ui.md",
    cat: "danchu",
    descKey: "variant.fixture.edit.builder-ui.desc",
    model: "sonnet",
    effort: "medium",
    myEffort: "high",
    appendKey: "variant.fixture.edit.builder-ui.append",
    marks: ["values", "append"],
  },
  {
    id: "builder-system",
    kind: "agent",
    nameKey: "variant.agent.builder-system",
    file: "agents/harness-builder-system.md",
    cat: "nabi",
    descKey: "variant.fixture.edit.builder-system.desc",
    model: "sonnet",
    effort: "high",
    marks: [],
  },
  {
    id: "tester",
    kind: "agent",
    nameKey: "variant.agent.tester",
    file: "agents/harness-tester.md",
    cat: "kkaebi",
    descKey: "variant.fixture.edit.tester.desc",
    model: "sonnet",
    effort: "medium",
    appendKey: "variant.fixture.edit.tester.append",
    marks: ["append"],
  },
  {
    id: "helper",
    kind: "agent",
    nameKey: "variant.agent.helper",
    file: "agents/harness-helper.md",
    cat: "dubu",
    descKey: "variant.fixture.edit.helper.desc",
    model: "haiku",
    effort: "low",
    marks: [],
  },
  {
    id: "reviewer",
    kind: "agent",
    nameKey: "variant.agent.reviewer",
    file: "agents/harness-reviewer.md",
    cat: "gureum",
    descKey: "variant.fixture.edit.reviewer.desc",
    model: "opus",
    effort: "high",
    marks: [],
  },
  {
    id: "translator",
    kind: "agent",
    nameKey: "variant.agent.translator",
    file: "agents/translator.md",
    descKey: "variant.fixture.edit.translator.desc",
    model: "sonnet",
    effort: "medium",
    marks: ["mine"],
  },
  {
    id: "desktop-app",
    kind: "skill",
    nameKey: "variant.fixture.edit.skill.desktop",
    file: "skills/desktop-app/SKILL.md",
    descKey: "variant.fixture.skill.desktop",
    marks: [],
  },
  {
    id: "web-full",
    kind: "skill",
    nameKey: "variant.fixture.edit.skill.webFull",
    file: "skills/web-full/SKILL.md",
    descKey: "variant.fixture.skill.webFull",
    appendKey: "variant.fixture.edit.webFull.append",
    marks: ["append"],
  },
  {
    id: "web-lite",
    kind: "skill",
    nameKey: "variant.fixture.edit.skill.webLite",
    file: "skills/web-lite/SKILL.md",
    descKey: "variant.fixture.skill.webLite",
    marks: [],
  },
  {
    id: "harness-resume",
    kind: "skill",
    nameKey: "variant.fixture.edit.skill.resume",
    file: "skills/harness-resume/SKILL.md",
    descKey: "variant.fixture.skill.resume",
    marks: [],
  },
  {
    id: "translate-docs",
    kind: "skill",
    nameKey: "variant.fixture.edit.skill.translate",
    file: "skills/translate-docs/SKILL.md",
    descKey: "variant.fixture.skill.translate",
    marks: ["mine"],
  },
];

/** 상태마다 처음 고른 것 */
export function editSelected(state: EditState): string {
  if (state === "replace" || state === "conflict") return "designer";
  return "builder-ui";
}

/** 원본 파일 앞부분 (읽기 전용 보기) */
export const ORIGIN_PREVIEW: Record<string, string> = {
  "builder-ui": `---
name: harness-builder-ui
description: claude-harness 화면 구현자. 고른 시안 · 디자인 토큰대로 화면 · 컴포넌트 · 화면 상태를 구현한다.
model: sonnet
effort: medium
---

너는 웹 · 데스크톱 앱 프로젝트의 화면 구현자다.
고른 시안과 토큰을 그대로 따르고, 키보드 · 접근성을 함께 만든다.

## 일하는 법
1. 지시서와 고른 시안을 먼저 읽는다.
2. 토큰만 쓴다 — 색 · 간격 값을 화면에 직접 쓰지 않는다.
…`,
  designer: `---
name: harness-designer
description: claude-harness 디자이너(아트 디렉터).
model: opus
effort: high
---

너는 웹 · 데스크톱 앱 프로젝트의 디자이너(아트 디렉터)다.
…`,
};

/** 통째로 바꾼 내 파일 (편집 중 보기) */
export const REPLACED_TEXT = `---
name: harness-designer
description: claude-harness 디자이너. 따뜻한 게임 UI 를 잘 아는 아트 디렉터.
model: opus
effort: high
---

너는 데스크톱 앱 프로젝트의 디자이너다. 취향이 분명하고 과감하다.

## 일하는 법
### 1. 레퍼런스
- 게임 UI 레퍼런스를 꼭 하나 넣는다.
### 2. 시안
- 시안마다 고양이 그림이 들어간 화면을 하나 넣는다.
### 3. 검수
- 고른 시안과 구현된 화면을 같은 크기로 찍어 비교한다.
`;

// ── 기록 (custom/ 로컬 git, D-21) ──

export interface HistoryEntry {
  id: string;
  hash: string;
  whenKey: TextKey;
  textKey: TextKey;
  files: string[];
  /** 앱이 만든 기록 종류 */
  kind: "edit" | "new" | "update" | "undo";
  diff?: DiffLine[];
}

export const EDIT_HISTORY: HistoryEntry[] = [
  {
    id: "h1",
    hash: "e41b9a0",
    whenKey: "variant.fixture.hist.h1.when",
    textKey: "variant.fixture.hist.h1",
    files: ["agents/harness-builder-ui.md"],
    kind: "edit",
    diff: [
      { sign: "@", text: "@@ agents/harness-builder-ui.md — 값 @@" },
      { sign: "-", text: "effort: medium", old: 5 },
      { sign: "+", text: "effort: high", new: 5 },
    ],
  },
  {
    id: "h2",
    hash: "9c2f7d4",
    whenKey: "variant.fixture.hist.h2.when",
    textKey: "variant.fixture.hist.h2",
    files: ["agents/translator.md", "agent-cats.json"],
    kind: "new",
    diff: [
      { sign: "@", text: "@@ agents/translator.md — 새 파일 @@" },
      { sign: "+", text: "---", new: 1 },
      { sign: "+", text: "name: translator", new: 2 },
      { sign: "+", text: "description: 문서를 자연스러운 영어로 옮긴다.", new: 3 },
      { sign: "+", text: "model: sonnet", new: 4 },
      { sign: "+", text: "---", new: 5 },
    ],
  },
  {
    id: "h3",
    hash: "51aa0e3",
    whenKey: "variant.fixture.hist.h3.when",
    textKey: "variant.fixture.hist.h3",
    files: ["agents/harness-designer.md"],
    kind: "edit",
    diff: [
      { sign: "@", text: "@@ agents/harness-designer.md — 통째로 @@" },
      { sign: " ", text: "## 일하는 법", old: 9, new: 9 },
      { sign: "+", text: "### 1. 레퍼런스", new: 10 },
      { sign: "+", text: "- 게임 UI 레퍼런스를 꼭 하나 넣는다.", new: 11 },
    ],
  },
  {
    id: "h4",
    hash: "0b7e215",
    whenKey: "variant.fixture.hist.h4.when",
    textKey: "variant.fixture.hist.h4",
    files: ["agents/harness-tester.md"],
    kind: "edit",
    diff: [
      { sign: "@", text: "@@ agents/harness-tester.md — 끝에 덧붙임 @@" },
      { sign: "+", text: "- 시험 이름은 한국어 문장으로 쓴다.", new: 1 },
    ],
  },
  {
    id: "h5",
    hash: "77d01c9",
    whenKey: "variant.fixture.hist.h5.when",
    textKey: "variant.fixture.hist.h5",
    files: ["(원본 7c41e2a)"],
    kind: "update",
  },
];

// ── 원본 바뀜 (통째로 바꾼 파일) ──

/** 원본 옛 판 → 새 판 (원본에서 바뀐 것) */
export const ORIGIN_CHANGE: DiffLine[] = [
  { sign: "@", text: "@@ 원본 agents/harness-designer.md — 41번째 줄부터 @@" },
  { sign: " ", text: "### 3. 시안", old: 41, new: 41 },
  { sign: " ", text: "- 지시서의 개수(보통 2~3개)를 서로 확실히 다른 콘셉트로.", old: 42, new: 42 },
  { sign: "+", text: "### 3-1. 화면 설계", new: 43 },
  { sign: "+", text: "- 가짜 데이터로 눌러 볼 수 있는 시제품. 상태마다 주소로 바로 열리게.", new: 44 },
  { sign: " ", text: "", old: 43, new: 45 },
  { sign: "-", text: "- 고른 시안과 구현된 화면을 비교한다.", old: 45 },
  { sign: "+", text: "- 고른 시안 · 토큰과 구현된 화면을 같은 크기로 찍어 비교한다.", new: 47 },
];

/** 원본 새 판 ↔ 내 것 (지금 내 파일과 다른 점) */
export const MINE_VS_ORIGIN: DiffLine[] = [
  { sign: "@", text: "@@ 원본 새 판 ↔ 내 것 @@" },
  { sign: "-", text: "description: claude-harness 디자이너(아트 디렉터).", old: 3 },
  { sign: "+", text: "description: claude-harness 디자이너. 따뜻한 게임 UI 를 잘 아는 아트 디렉터.", new: 3 },
  { sign: " ", text: "## 일하는 법", old: 9, new: 9 },
  { sign: "-", text: "### 1. 레퍼런스 조사", old: 10 },
  { sign: "+", text: "### 1. 레퍼런스", new: 10 },
  { sign: "+", text: "- 게임 UI 레퍼런스를 꼭 하나 넣는다.", new: 11 },
  { sign: "-", text: "### 3-1. 화면 설계", old: 43 },
  { sign: "-", text: "- 가짜 데이터로 눌러 볼 수 있는 시제품. 상태마다 주소로 바로 열리게.", old: 44 },
];

export const CUSTOM_ROOT = "~/.claude-harness/custom/";
