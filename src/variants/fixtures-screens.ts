// 화면 설계 묶음 1 (P2-13) 가짜 데이터 — 첫 실행 · 설정 · 하네스 · 고양이 고르기.
// 실제 데이터 · IPC 와 연결하지 않는다. 기능 단계(P3 · P4 · P9)에서 같은 모양의 IPC 결과로 바꾼다 — 데이터 모양은 지시서 보고 참고.
// 문구는 ko.ts 에. 여기 쓰는 영문 · 경로 · 버전 · 명령은 번역하지 않는 값.
import type { CatId } from "../components/cat/catalog";
import type { TextKey } from "../i18n/ko";

// ── 첫 실행 · 준비 ──

/** 첫 번째가 기본 — "하나 빠짐(로그인)" 이 가장 흔하고 안내가 잘 보인다 */
export const SETUP_STATES = ["login", "checking", "fresh", "git", "harness", "failed", "ready", "apikey"] as const;
export type SetupState = (typeof SETUP_STATES)[number];

export const CHECK_IDS = ["cli", "login", "git", "harness"] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type CheckStatus = "ok" | "missing" | "checking" | "waiting" | "failed";

export interface CheckRow {
  id: CheckId;
  status: CheckStatus;
  /** 됨 · 기다림일 때 한 줄 (버전 · 경로 · 이유) */
  detailKey?: TextKey;
}

const OK_DETAIL: Record<CheckId, TextKey> = {
  cli: "variant.fixture.setup.cliOk",
  login: "variant.fixture.setup.loginOk",
  git: "variant.fixture.setup.gitOk",
  harness: "variant.fixture.setup.harnessOk",
};

const STATUS_BY_STATE: Record<SetupState, Record<CheckId, CheckStatus>> = {
  login: { cli: "ok", login: "missing", git: "ok", harness: "ok" },
  checking: { cli: "ok", login: "checking", git: "waiting", harness: "waiting" },
  fresh: { cli: "missing", login: "waiting", git: "missing", harness: "missing" },
  git: { cli: "ok", login: "ok", git: "missing", harness: "ok" },
  harness: { cli: "ok", login: "ok", git: "ok", harness: "missing" },
  failed: { cli: "ok", login: "failed", git: "ok", harness: "ok" },
  ready: { cli: "ok", login: "ok", git: "ok", harness: "ok" },
  apikey: { cli: "ok", login: "ok", git: "ok", harness: "ok" },
};

/** 준비 목록 4줄. 빠진 것 · 실패한 것 중 맨 위 하나만 펼쳐 안내한다 ("하나씩") */
export function setupChecks(state: SetupState): CheckRow[] {
  const statuses = STATUS_BY_STATE[state];
  return CHECK_IDS.map((id) => {
    const status = statuses[id];
    if (status === "ok") return { id, status, detailKey: OK_DETAIL[id] };
    if (status === "waiting") return { id, status, detailKey: id === "login" ? "variant.setup.waitCli" : "variant.setup.waitTurn" };
    return { id, status };
  });
}

/** 지금 펼칠 줄 — 빠짐 · 실패 중 첫 번째. 없으면 null */
export function activeCheck(rows: readonly CheckRow[]): CheckRow | null {
  return rows.find((row) => row.status === "missing" || row.status === "failed") ?? null;
}

export const SETUP_COMMANDS = {
  cliInstall: "irm https://claude.ai/install.ps1 | iex",
  gitInstall: "winget install --id Git.Git -e",
  login: "claude auth login",
} as const;

/** 확인 실패일 때 원본 출력 (접어 둠) */
export const SETUP_FAILED_RAW = ["> claude auth status --json", "(no response in 10s)", "exit: timeout"];

// ── 설정 ──

export const SETTINGS_STATES = ["normal", "apikey", "update"] as const;
export type SettingsState = (typeof SETTINGS_STATES)[number];

export const SETTINGS_SECTIONS = ["claude", "look", "house", "notify", "harness", "update", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const SETTINGS_FIXTURE = {
  cliPath: "C:\\Users\\me\\.local\\bin\\claude.exe",
  cliVersion: "2.1.123",
  appVersion: "0.1.0",
  appNext: "0.2.0",
  appNotes: ["variant.fixture.app.n1", "variant.fixture.app.n2", "variant.fixture.app.n3"] as TextKey[],
  harnessVersion: "v0.9.2",
  harnessCommit: "7c41e2a",
  harnessRoot: "~/.claude-harness/",
  repoUrl: "https://github.com/nerohee/nyanitor",
} as const;

// ── 하네스 설치 · 업데이트 ──

export const HARNESS_STATES = ["install", "installing", "installed", "failed", "update", "backups"] as const;
export type HarnessState = (typeof HARNESS_STATES)[number];

export type FileKind = "add" | "change" | "delete" | "keep";

export interface DiffLine {
  /** " " 그대로 · "+" 더함 · "-" 뺌 · "@" 위치 표시 */
  sign: " " | "+" | "-" | "@";
  text: string;
  /** 옛 파일 · 새 파일 줄 번호 */
  old?: number;
  new?: number;
}

export interface FileChange {
  path: string;
  kind: FileKind;
  /** 묶음 줄이면 파일 수 (예: agents/ 7개) */
  count?: number;
  noteKey?: TextKey;
  /** 내 수정(custom)과 겹치는 파일 (D-05) */
  overlap?: boolean;
  diff?: DiffLine[];
}

export const HARNESS_SOURCE = {
  repo: "https://github.com/nerohee/claude-harness",
  branch: "main",
  commit: "7c41e2a",
  next: "b93f0d1",
  repoDir: "~/.claude-harness/repo/",
  claudeDir: "~/.claude/",
  backupDir: "~/.claude-harness/backups/2026-10-15_1432/",
  backupsRoot: "~/.claude-harness/backups/",
  keepCount: 12,
} as const;

/** 줄 번호를 붙인다 — 위치 표시(@) 줄에서 다시 센다 */
function numbered(oldStart: number, newStart: number, lines: Array<[DiffLine["sign"], string]>): DiffLine[] {
  let o = oldStart;
  let n = newStart;
  return lines.map(([sign, text]) => {
    if (sign === "@") return { sign, text };
    if (sign === "+") return { sign, text, new: n++ };
    if (sign === "-") return { sign, text, old: o++ };
    return { sign, text, old: o++, new: n++ };
  });
}

const SETTINGS_DIFF = numbered(1, 1, [
  ["@", "@@ settings.json — 1번째 줄부터 @@"],
  [" ", "{"],
  [" ", '  "model": "opus",'],
  ["-", '  "permissions": { "allow": ["Bash(npm run *)"] }'],
  ["+", '  "permissions": {'],
  ["+", '    "allow": ["Bash(npm run *)", "Bash(git status)", "Bash(git diff *)"]'],
  ["+", "  },"],
  ["+", '  "hooks": {'],
  ["+", '    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "~/.claude/harness/hooks/guard.sh" }] }]'],
  ["+", "  }"],
  [" ", "}"],
]);

const CLAUDE_MD_DIFF = numbered(18, 18, [
  ["@", "@@ CLAUDE.md — 18번째 줄부터 @@"],
  [" ", "- 커밋 메시지는 한국어로."],
  [" ", ""],
  ["+", "## claude-harness"],
  ["+", "에이전트 · 스킬은 ~/.claude/harness 에서 읽는다. 지시서 · 보고 형식은 harness/shared/workflow.md 를 따른다."],
]);

const NEW_AGENT_PREVIEW = numbered(0, 1, [
  ["+", "---"],
  ["+", "name: harness-designer"],
  ["+", "description: 디자이너(아트 디렉터). 레퍼런스 · 토큰 · 시안 · 디자인 검수"],
  ["+", "model: opus"],
  ["+", "effort: high"],
  ["+", "---"],
  ["+", "너는 웹 · 데스크톱 앱 프로젝트의 디자이너다. …"],
]);

export const INSTALL_FILES: FileChange[] = [
  { path: "settings.json", kind: "change", noteKey: "variant.fixture.harness.note.settings", diff: SETTINGS_DIFF },
  { path: "CLAUDE.md", kind: "change", noteKey: "variant.fixture.harness.note.claudeMd", diff: CLAUDE_MD_DIFF },
  { path: "agents/", kind: "add", count: 7, noteKey: "variant.fixture.harness.note.agents", diff: NEW_AGENT_PREVIEW },
  { path: "skills/", kind: "add", count: 5, noteKey: "variant.fixture.harness.note.skills" },
  { path: "hooks/", kind: "add", count: 3, noteKey: "variant.fixture.harness.note.hooks" },
  { path: "harness/", kind: "add", count: 16 },
];

const DESIGNER_DIFF = numbered(41, 41, [
  ["@", "@@ agents/harness-designer.md — 41번째 줄부터 @@"],
  [" ", "### 3. 시안"],
  [" ", "- 지시서의 개수(보통 2~3개)를 서로 확실히 다른 콘셉트로."],
  ["+", "### 3-1. 화면 설계"],
  ["+", "- 가짜 데이터로 눌러 볼 수 있는 시제품. 상태마다 주소로 바로 열리게."],
  [" ", ""],
  [" ", "### 4. 디자인 검수 (구현된 화면)"],
  ["-", "- 고른 시안과 구현된 화면을 비교한다."],
  ["+", "- 고른 시안 · 토큰과 구현된 화면을 같은 크기로 찍어 비교한다."],
]);

const WORKFLOW_DIFF = numbered(120, 120, [
  ["@", "@@ shared/workflow.md — 120번째 줄부터 @@"],
  [" ", "## 8. 이어 하기"],
  ["-", "새 세션은 handoff.md 를 읽는다."],
  ["+", "새 세션은 handoff.md 를 먼저 읽고, 진행 중인 지시서의 작업 항목을 확인한다."],
]);

const GUARD_DIFF = numbered(12, 12, [
  ["@", "@@ hooks/guard.sh — 12번째 줄부터 @@"],
  ["-", 'BASH_BIN="/usr/bin/bash"'],
  ["+", 'BASH_BIN="$(command -v bash || echo /usr/bin/bash)"'],
]);

const TRAY_PREVIEW = numbered(0, 1, [
  ["+", "# 트레이"],
  ["+", "창을 닫으면 트레이에 남는다. 메뉴: 열기 · 상태 · 종료."],
  ["+", "돌던 작업이 있으면 종료 전에 경고한다."],
]);

export const UPDATE_FILES: FileChange[] = [
  { path: "agents/harness-designer.md", kind: "change", overlap: true, diff: DESIGNER_DIFF },
  { path: "shared/workflow.md", kind: "change", diff: WORKFLOW_DIFF },
  { path: "hooks/guard.sh", kind: "change", diff: GUARD_DIFF },
  { path: "skills/desktop-app/tray.md", kind: "add", diff: TRAY_PREVIEW },
  { path: "shared/old-notes.md", kind: "delete" },
];

export const UPDATE_COMMITS: Array<{ hash: string; textKey: TextKey }> = [
  { hash: "b93f0d1", textKey: "variant.fixture.harness.c1" },
  { hash: "a4c27e9", textKey: "variant.fixture.harness.c2" },
  { hash: "51d0b3f", textKey: "variant.fixture.harness.c3" },
  { hash: "0e9a6c2", textKey: "variant.fixture.harness.c4" },
];

export type RunStatus = "done" | "running" | "todo" | "failed" | "undone";

export interface RunStep {
  labelKey: TextKey;
  status: RunStatus;
}

export const INSTALL_PROGRESS = { written: 21, total: 33, file: "agents/harness-tester.md" } as const;

export function installSteps(state: "installing" | "failed"): RunStep[] {
  if (state === "failed") {
    return [
      { labelKey: "variant.harness.run.clone", status: "done" },
      { labelKey: "variant.harness.run.backup", status: "done" },
      { labelKey: "variant.harness.run.write", status: "failed" },
      { labelKey: "variant.harness.run.verify", status: "undone" },
    ];
  }
  return [
    { labelKey: "variant.harness.run.clone", status: "done" },
    { labelKey: "variant.harness.run.backup", status: "done" },
    { labelKey: "variant.harness.run.write", status: "running" },
    { labelKey: "variant.harness.run.verify", status: "todo" },
  ];
}

export const INSTALL_LOG = [
  "> install.ps1 --target ~/.claude --custom ~/.claude-harness/custom --json",
  '{"step":"clone","ok":true,"commit":"7c41e2a"}',
  '{"step":"backup","ok":true,"dir":"~/.claude-harness/backups/2026-10-15_1432/","files":2}',
  '{"step":"write","ok":false,"file":"settings.json","error":"EBUSY: resource busy or locked"}',
  '{"step":"rollback","ok":true,"restored":3}',
];

export interface BackupRow {
  id: string;
  whenKey: TextKey;
  whyKey: TextKey;
  dir: string;
  files: number;
  size: string;
}

export const BACKUPS: BackupRow[] = [
  {
    id: "b1",
    whenKey: "variant.fixture.backup.b1.when",
    whyKey: "variant.fixture.backup.b1.why",
    dir: "2026-10-15_1432/",
    files: 4,
    size: "38 KB",
  },
  {
    id: "b2",
    whenKey: "variant.fixture.backup.b2.when",
    whyKey: "variant.fixture.backup.b2.why",
    dir: "2026-10-02_0910/",
    files: 2,
    size: "6 KB",
  },
];

// ── 에이전트 고양이 고르기 ──

export const PICK_STATES = ["default", "changed", "new"] as const;
export type PickState = (typeof PICK_STATES)[number];

export interface PickAgent {
  /** 에이전트 이름 (메인 대화는 main) */
  agent: string;
  nameKey: TextKey;
  /** 이름 아래 한 줄 — 없으면 파일 이름 */
  subKey?: TextKey;
  file: string | null;
  /** 기본 연결 (agent-cats.json). 사용자가 만든 에이전트는 없음 */
  defaultCat: CatId | null;
}

export const PICK_AGENTS: PickAgent[] = [
  { agent: "main", nameKey: "variant.agent.main", subKey: "variant.agent.main.sub", file: null, defaultCat: "mukmul" },
  { agent: "designer", nameKey: "variant.agent.designer", file: "harness-designer.md", defaultCat: "mulgam" },
  { agent: "builder-ui", nameKey: "variant.agent.builder-ui", file: "harness-builder-ui.md", defaultCat: "danchu" },
  { agent: "builder-system", nameKey: "variant.agent.builder-system", file: "harness-builder-system.md", defaultCat: "nabi" },
  { agent: "tester", nameKey: "variant.agent.tester", file: "harness-tester.md", defaultCat: "kkaebi" },
  { agent: "helper", nameKey: "variant.agent.helper", file: "harness-helper.md", defaultCat: "dubu" },
  { agent: "reviewer", nameKey: "variant.agent.reviewer", file: "harness-reviewer.md", defaultCat: "gureum" },
];

export const NEW_AGENT: PickAgent = {
  agent: "translator",
  nameKey: "variant.agent.translator",
  subKey: "variant.agent.translator.sub",
  file: "translator.md",
  defaultCat: null,
};

/** 상태마다 사용자 연결 (custom/agent-cats.json 에 들어갈 것) */
export function pickUserLinks(state: PickState): Record<string, CatId> {
  if (state === "changed") return { designer: "gureum", reviewer: "mulgam" };
  return {};
}
