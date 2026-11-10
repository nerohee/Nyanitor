// 브라우저(`npm run dev`)에서 「내 수정」 화면이 돌도록 하는 가짜 내 수정 (P9-01, D-51). Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/custom/`)와 같은 명령 · 결과 모양 · 규칙을 흉내 낸다. 실제 폴더 · git · 설치 스크립트는 어디에도 건드리지 않는다.
//
// 가짜 안에는 진짜처럼 **파일 두 벌**(원본 `source` · 내 수정 `custom`)과 **커밋 목록**이 있다. 목록 · 읽기 · 저장 · 적용 · 기록 · 되돌리기는 모두 이 파일들에서 계산한다:
// 적용 안 한 것 = 지금 `custom` 과 마지막 커밋 모습의 차이, 적용 = 설치(가짜 성공 · 실패) 뒤 커밋, 되돌리기 = 그 커밋 모습으로 + 새 커밋 (이력은 그대로).
// 처음 모습(`?custom=full`)은 시제품(`variants/fixtures-edit.ts`)과 같은 일곱 작업자(오케스트레이터 + 여섯) + 스킬 넷 + 통째로 바꿔서 원본이 바뀐 것(디자이너) + 내가 만든 것(에이전트 `translator` · 스킬 `translate-docs`).
// 고르는 법은 기존 가짜(`fakeHouse.ts`)처럼 주소 쿼리: `?custom=full` (기본) · `dirty` (적용 안 한 것이 둘 있다) · `fresh` (내 수정이 없고 기록도 아직 없다) · `no_source` (하네스를 아직 안 받았다) ·
// `no_git` (git 이 없는 PC) · `install_fails` (설치가 늘 실패 — 적용 · 되돌리기의 실패 흐름). 시험은 `reset(...)` 로 쿼리 대신 값을 정한다.
// 진짜처럼: 한 번에 하나(`harness_busy`) · 보낸 값의 모양이 틀리면 `invalid_input` · 상태 때문에 안 되는 일은 오류가 아니라 `refused` + 이유.
import { t } from "../i18n/ko";
import { diffLines, splitLines as lines } from "./textDiff";
import {
  AppError,
  type AgentRole,
  CUSTOM_CAT_ID_PATTERN,
  CUSTOM_CATS_CHANGES_MAX,
  CUSTOM_LABEL_MAX_CHARS,
  CUSTOM_EFFORTS,
  CUSTOM_DESCRIPTION_MAX_CHARS,
  CUSTOM_MESSAGE_MAX_CHARS,
  CUSTOM_MODELS,
  CUSTOM_NAME_PATTERN,
  CUSTOM_TEXT_MAX_BYTES,
  type CustomApplyResult,
  type CustomCatChange,
  type CustomCats,
  type CustomCatsWriteResult,
  type CustomChanges,
  type CustomCommit,
  type CustomCommitDiff,
  type CustomCommitKind,
  type CustomDiscardResult,
  type CustomFileDiff,
  type CustomFileStatus,
  type CustomHistory,
  type CustomHistoryState,
  type CustomItemDetail,
  type CustomItemInfo,
  type CustomItemKind,
  type CustomItemRead,
  type CustomLabels,
  type CustomList,
  type CustomListEntry,
  type CustomMark,
  type CustomNewItem,
  type CustomRestoreResult,
  type CustomTextPart,
  type CustomUnapplied,
  type CustomUnreadableReason,
  type CustomWriteResult,
  type HarnessReport,
  type ScriptResult,
} from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;
type Files = Map<string, string>;

export type FakeCustomMode = "full" | "dirty" | "fresh" | "no_source" | "no_git" | "install_fails";

const MODES: readonly FakeCustomMode[] = ["full", "dirty", "fresh", "no_source", "no_git", "install_fails"];

/** 주소 쿼리 → 가짜 모드. 모르는 값은 기본값. */
export function parseFakeCustomQuery(search: string): FakeCustomMode {
  const value = new URLSearchParams(search).get("custom");
  return MODES.find((mode) => mode === value) ?? "full";
}

const FAKE_CLAUDE_DIR = "C:\\fake-sandbox\\.claude";
const FAKE_HOME = "C:\\fake-sandbox\\.claude-harness";
const AGENT_CATS = "agent-cats.json";
const AGENT_LABELS = "agent-labels.json";
const CONFIG = "config.local.json";
const WORKER_ROLES = ["designer", "ui", "system", "tester", "helper", "reviewer"] as const;
// eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적이다 (진짜 `char::is_control` 과 같다)
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const FILES_MAX = 200;
const LIST_FILES_MAX = 200;
const COMMIT_FILES_MAX = 50;
const LOG_MAX = 200;

// ───────────────────────────── 글 규칙 (진짜 `values.rs` · `template.rs` · `hash.rs` 와 같은 결) ─────────────────────────────

function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

/** 가짜 해시 — 줄바꿈을 LF 로 맞춘 글(마지막 줄바꿈 보장)에서 만든 64글자 16진수 (진짜는 sha256 · 같은 규칙) */
function fakeHash(text: string): string {
  const body = normalize(text).replace(/\n?$/, "\n");
  let out = "";
  for (let round = 0; out.length < 64; round += 1) {
    let h = 5381 + round * 7919;
    for (let i = 0; i < body.length; i += 1) h = (Math.imul(h, 33) ^ body.charCodeAt(i)) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

interface Values {
  model: string | null;
  effort: string | null;
}

/** 값 파일 읽기 — 진짜(설치 스크립트)와 같은 규칙. 모양이 틀리면 null */
function parseValues(text: string): Values | null {
  const seen = new Set<string>();
  const out: Values = { model: null, effort: null };
  for (const line of lines(text)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 1) return null;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || key === "name" || key === "hooks" || value === "" || value.includes("\t") || seen.has(key)) return null;
    seen.add(key);
    if (key === "model") out.model = value;
    if (key === "effort") out.effort = value;
  }
  return out;
}

/** 값 파일의 새 글 (`null` 이면 파일을 지운다). 주석 · 다른 키 · 순서는 그대로 */
function renderValues(existing: string | null, wanted: Values): string | null {
  const out = existing === null ? [] : lines(existing);
  for (const [key, value] of [["model", wanted.model], ["effort", wanted.effort]] as const) {
    const at = out.findIndex((line) => line.startsWith(`${key}:`));
    if (at >= 0 && value !== null) out[at] = `${key}: ${value}`;
    else if (at >= 0) out.splice(at, 1);
    else if (value !== null) out.push(`${key}: ${value}`);
  }
  const text = `${out.join("\n")}\n`;
  const hasKey = lines(text).some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  return hasKey ? text : null;
}

/** 앞머리 값들 (첫 줄 `---` ~ 닫는 `---`). 못 읽으면 null */
function front(text: string): Map<string, string> | null {
  const all = lines(text);
  if (all[0]?.trimEnd() !== "---") return null;
  const close = all.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close < 0) return null;
  const out = new Map<string, string>();
  for (const line of all.slice(1, close)) {
    const colon = line.indexOf(":");
    if (colon > 0 && !line.startsWith(" ") && !out.has(line.slice(0, colon))) {
      out.set(line.slice(0, colon), line.slice(colon + 1).trim().replace(/^"(.*)"$/, "$1"));
    }
  }
  return out;
}

/** 앞머리의 `key: value` 한 줄을 바꾼다 (`null` = 줄을 지운다). 못 고치면 null */
function setFront(text: string, key: string, value: string | null): string | null {
  const all = lines(text);
  const close = all.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (all[0]?.trimEnd() !== "---" || close < 0) return null;
  const at = all.slice(1, close).findIndex((line) => line.startsWith(`${key}:`));
  if (at >= 0) {
    const next = all[at + 2];
    if (at + 2 < close && next !== undefined && (next.startsWith(" ") || next.startsWith("\t") || next.startsWith("- "))) return null;
    if (value === null) all.splice(at + 1, 1);
    else all[at + 1] = `${key}: ${value}`;
  } else if (value !== null) {
    all.splice(close, 0, `${key}: ${value}`);
  }
  return `${all.join("\n")}\n`;
}

/** 에이전트 글이 설치 스크립트의 틀을 지키는가 — 둘째 줄 `name: <이름>` · 앞머리에 `hooks:` 없음. 어기면 이유 */
function agentProblem(name: string, text: string): string | null {
  const all = normalize(text).split("\n");
  if (all.length < 2 || all[1] !== `name: ${name}`) return `the second line must be \`name: ${name}\``;
  for (const line of all.slice(1)) {
    if (line === "---") break;
    if (line.startsWith("hooks:")) return "`hooks:` must not be used (the install adds the guard hook)";
  }
  return null;
}

function yamlScalar(text: string): string {
  const firstOk = /^[\p{L}\p{N}/.(]/u.test(text);
  const risky = text.includes(": ") || text.includes(" #") || text.endsWith(":") || text.startsWith(" ") || text.endsWith(" ");
  return firstOk && !risky ? text : `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function newText(kind: "agent" | "skill", name: string, description: string, model: string | null, effort: string | null): string {
  let text = `---\nname: ${name}\ndescription: ${yamlScalar(description)}\n`;
  if (model !== null) text += `model: ${model}\n`;
  if (effort !== null) text += `effort: ${effort}\n`;
  text += "---\n\n";
  text += kind === "agent" ? "너는 이 프로젝트의 도우미다. 여기에 맡은 일과 지킬 규칙을 한두 줄로 적는다.\n" : "이 스킬이 하는 일과 쓰는 때를 한두 줄로 적는다.\n";
  return text;
}

// ───────────────────────────── 줄 차이 (진짜는 `git diff`) ─────────────────────────────

function fileDiff(path: string, before: string | undefined, after: string | undefined): CustomFileDiff {
  const status: CustomFileStatus = before === undefined ? "added" : after === undefined ? "removed" : "changed";
  const { lines: all, added, removed } = diffLines(before ?? null, after ?? null);
  const truncated = all.length > 400;
  return { path, status, binary: false, lines: truncated ? all.slice(0, 400) : all, truncated, added, removed };
}

function changedPaths(before: Files, after: Files): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

// ───────────────────────────── 가짜 안의 상태 ─────────────────────────────

interface FakeCommit {
  hash: string;
  date: string;
  message: string;
  kind: CustomCommitKind;
  files: string[];
  tree: Files;
}

interface FakeState {
  mode: FakeCustomMode;
  source: Files;
  custom: Files;
  /** 최신이 먼저 */
  commits: FakeCommit[];
  /** 만든 커밋 수 (번호 · 때를 만드는 데 쓴다) */
  counter: number;
}

const DESIGNER_OLD_BODY = "너는 웹 · 데스크톱 앱 프로젝트의 디자이너(아트 디렉터)다.\n";
const DESIGNER_NEW_BODY = "너는 웹 · 데스크톱 앱 프로젝트의 디자이너(아트 디렉터)다. 화면 설계는 가짜 데이터로 눌러 볼 수 있는 시제품으로 만든다.\n";

function agentText(name: string, description: string, model: string, effort: string, body = "너는 이 하네스의 작업자다.\n"): string {
  return `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\neffort: ${effort}\n---\n\n${body}`;
}

function skillText(name: string, description: string, body = "이 스킬은 하네스가 설치한다.\n"): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
}

function seedSource(): Files {
  const source: Files = new Map();
  const agents: Array<[string, string, string, string]> = [
    ["harness-designer", t("variant.fixture.edit.designer.desc"), "opus", "high"],
    ["harness-builder-ui", t("variant.fixture.edit.builder-ui.desc"), "sonnet", "medium"],
    ["harness-builder-system", t("variant.fixture.edit.builder-system.desc"), "sonnet", "high"],
    ["harness-tester", t("variant.fixture.edit.tester.desc"), "sonnet", "medium"],
    ["harness-helper", t("variant.fixture.edit.helper.desc"), "haiku", "low"],
    ["harness-reviewer", t("variant.fixture.edit.reviewer.desc"), "opus", "high"],
  ];
  for (const [name, description, model, effort] of agents) {
    source.set(`agents/${name}.md`, agentText(name, description, model, effort, name === "harness-designer" ? DESIGNER_NEW_BODY : undefined));
  }
  const skills: Array<[string, string]> = [
    ["desktop-app", t("variant.fixture.skill.desktop")],
    ["web-full", t("variant.fixture.skill.webFull")],
    ["web-lite", t("variant.fixture.skill.webLite")],
    ["harness-resume", t("variant.fixture.skill.resume")],
  ];
  for (const [name, description] of skills) source.set(`skills/${name}/SKILL.md`, skillText(name, description));
  source.set("config.example.json", `${JSON.stringify({ language: "ko", planner: { model: "opus", effort: "high" }, agents: { ui: "harness-builder-ui" } }, null, 2)}\n`);
  return source;
}

type Write = Record<string, string | null>;

/** 처음 모습의 커밋들 (오래된 것부터) — 내 수정 폴더에 어떤 일이 있었는지 */
function seedCommits(): Array<{ kind: CustomCommitKind; message: string; writes: Write }> {
  const oldDesigner = agentText("harness-designer", t("variant.fixture.edit.designer.desc"), "opus", "high", DESIGNER_OLD_BODY);
  const myDesigner = agentText("harness-designer", "claude-harness 디자이너. 따뜻한 게임 UI 를 잘 아는 아트 디렉터.", "opus", "high", `${DESIGNER_OLD_BODY}\n## 일하는 법\n### 1. 레퍼런스\n- 게임 UI 레퍼런스를 꼭 하나 넣는다.\n`);
  return [
    { kind: "start", message: "처음 기록", writes: { ".gitignore": ".*.nyanitor-*.tmp\n" } },
    { kind: "apply", message: "빌더 UI 수준 높임 · 지시 덧붙임", writes: { "agents/harness-builder-ui.values.yml": "effort: high\n", "agents/harness-builder-ui.append.md": `${t("variant.fixture.edit.builder-ui.append")}\n` } },
    {
      kind: "new",
      message: "새 에이전트 translator",
      writes: {
        "agents/translator.md": `${t("variant.fixture.edit.translator.file")}\n`,
        [AGENT_CATS]: `${JSON.stringify({ version: 1, agents: { translator: "dubu" } }, null, 2)}\n`,
        [AGENT_LABELS]: `${JSON.stringify({ version: 1, agents: { translator: "번역" } }, null, 2)}\n`,
      },
    },
    { kind: "apply", message: "디자이너를 통째로 바꿈", writes: { "agents/harness-designer.md": myDesigner, "agents/harness-designer.md.origin": `${fakeHash(oldDesigner)}\n` } },
    { kind: "apply", message: "테스터 지시 덧붙임", writes: { "agents/harness-tester.append.md": `${t("variant.fixture.edit.tester.append")}\n` } },
    { kind: "new", message: "웹 서비스 스킬 덧붙임 · 새 스킬 translate-docs", writes: { "skills/web-full/SKILL.append.md": `${t("variant.fixture.edit.webFull.append")}\n`, "skills/translate-docs/SKILL.md": newText("skill", "translate-docs", t("variant.fixture.skill.translate"), "sonnet", null) } },
    { kind: "origin_update", message: "원본 업데이트 받음 (7c41e2a)", writes: {} },
  ];
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function commitDate(counter: number): string {
  const minutes = 9 * 60 + counter * 7;
  return `2026-11-${pad(5 + Math.floor(minutes / 1440))}T${pad(Math.floor((minutes % 1440) / 60))}:${pad(minutes % 60)}:00+09:00`;
}

function buildState(mode: FakeCustomMode): FakeState {
  const source = mode === "no_source" ? new Map<string, string>() : seedSource();
  const state: FakeState = { mode, source, custom: new Map(), commits: [], counter: 0 };
  if (mode === "fresh" || mode === "no_source" || mode === "no_git") {
    // 내 수정이 없다 (기록도 아직 시작 전). git 이 없는 PC 는 일부 파일만 있는 채로 시작
    if (mode === "no_git") {
      state.custom.set("agents/harness-builder-ui.values.yml", "effort: high\n");
      state.custom.set("agents/translator.md", `${t("variant.fixture.edit.translator.file")}\n`);
    }
    return state;
  }
  const tree: Files = new Map();
  for (const { kind, message, writes } of seedCommits()) {
    const before = new Map(tree);
    for (const [path, text] of Object.entries(writes)) {
      if (text === null) tree.delete(path);
      else tree.set(path, text);
    }
    state.counter += 1;
    state.commits.unshift({
      hash: fakeHash(`${state.counter}:${message}`).slice(0, 40),
      date: commitDate(state.counter),
      message,
      kind,
      files: changedPaths(before, tree),
      tree: new Map(tree),
    });
  }
  state.custom = new Map(tree);
  if (mode === "dirty") {
    state.custom.set("agents/harness-helper.values.yml", "model: sonnet\n");
    state.custom.set("agents/harness-reviewer.append.md", "- 찾은 것은 위험이 큰 순서로 적는다.\n");
  }
  return state;
}

function validName(name: string): boolean {
  return CUSTOM_NAME_PATTERN.test(name);
}

interface Parsed {
  kind: CustomItemKind;
  name: string;
}

function parseId(id: unknown): Parsed {
  const bad = () => new AppError("invalid_input", "item id has the wrong shape");
  if (typeof id !== "string") throw bad();
  if (id === "main") return { kind: "main", name: "main" };
  const [prefix, name, ...rest] = id.split(":");
  if (rest.length > 0 || name === undefined || !validName(name)) throw bad();
  if (prefix === "agent" && name !== "main") return { kind: "agent", name };
  if (prefix === "skill") return { kind: "skill", name };
  throw bad();
}

function filesOf(item: Parsed) {
  const file = item.kind === "agent" ? `agents/${item.name}.md` : `skills/${item.name}/SKILL.md`;
  const stem = file.replace(/\.md$/, "");
  return { file, values: `${stem}.values.yml`, append: `${stem}.append.md`, origin: `${file}.origin` };
}

function checkValues(wanted: Values, already: Values[]): void {
  const ok = (value: string | null, list: readonly string[], current: Array<string | null>) => value === null || list.includes(value) || current.includes(value);
  if (!ok(wanted.model, CUSTOM_MODELS, already.map((v) => v.model)) || !ok(wanted.effort, CUSTOM_EFFORTS, already.map((v) => v.effort))) {
    throw new AppError("invalid_input", "model or effort is not one of the allowed values");
  }
}

function readValuesArg(raw: unknown): Values {
  if (typeof raw !== "object" || raw === null) throw new AppError("invalid_input", "values must be an object");
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) if (key !== "model" && key !== "effort") throw new AppError("invalid_input", `unknown field: ${key}`);
  const pick = (key: string): string | null => {
    const value = input[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new AppError("invalid_input", `${key} must be a text`);
    return value;
  };
  return { model: pick("model"), effort: pick("effort") };
}

function saved(changed: boolean): CustomWriteResult {
  return { outcome: "saved", reason: null, detail: null, changed, notOurs: false };
}

function refused(reason: string, detail: string | null = null): CustomWriteResult {
  return { outcome: "refused", reason, detail, changed: false, notOurs: false };
}

function cleanMessage(text: string): string | null {
  const spaced = text.replace(CONTROL_CHARS, " ");
  const collapsed = spaced.split(/\s+/).filter((part) => part !== "").join(" ");
  const cut = [...collapsed].slice(0, CUSTOM_MESSAGE_MAX_CHARS).join("").trimEnd();
  return cut === "" ? null : cut;
}

function installResult(ok: boolean): ScriptResult {
  const report: HarnessReport = {
    contract: 1,
    command: "install",
    ok,
    exitCode: ok ? 0 : 2,
    dryRun: false,
    claudeDir: FAKE_CLAUDE_DIR,
    harnessHome: FAKE_HOME,
    repo: `${FAKE_HOME}\\repo`,
    mode: "copy",
    developerMode: false,
    existingSource: `${FAKE_HOME}\\repo`,
    restartNeeded: false,
    custom: { dir: `${FAKE_HOME}\\custom`, items: [] },
    changes: [],
    counts: { add: 0, change: 0, remove: 0, skip: 0, same: 11 },
    same: false,
    originChanged: [],
    problems: ok ? [] : [{ path: "agents/harness-builder-ui.values.yml", reason: "badValues", detail: "2번째 줄이 \"키: 값\" 모양이 아니다" }],
    warnings: [],
    backup: null,
    backups: [],
    originHash: null,
    rolledBack: null,
    error: null,
  };
  return {
    outcome: "ran",
    exitCode: report.exitCode,
    report,
    raw: JSON.stringify(report),
    unreadable: null,
    restoreAdvised: false,
    script: `${FAKE_HOME}\\repo\\install.ps1`,
    prune: null,
    detail: null,
    reason: null,
  };
}

export function createFakeCustom() {
  /** 시험이 정한 값. 없으면 처음 부를 때 주소 쿼리를 읽는다. */
  let override: FakeCustomMode | null = null;
  let state: FakeState | null = null;
  let busy = false;
  /** 시험용: 한 번만 설치를 실패시킨다 */
  let failNextInstall = false;

  const mode = (): FakeCustomMode => override ?? parseFakeCustomQuery(typeof window === "undefined" ? "" : window.location.search);
  const current = (): FakeState => {
    state ??= buildState(mode());
    return state;
  };

  /** 한 번에 하나 — 다른 하네스 작업이 도는 중이면 진짜처럼 `harness_busy` */
  async function exclusive<T>(work: () => T): Promise<T> {
    if (busy) throw new AppError("harness_busy", "another harness task is in progress");
    busy = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return work();
    } finally {
      busy = false;
    }
  }

  const gitState = (s: FakeState): CustomHistoryState => (s.mode === "no_git" ? "no_git" : s.commits.length === 0 ? "not_started" : "ok");
  const head = (s: FakeState): Files => s.commits[0]?.tree ?? new Map();

  /** 쓰기 전에 기록이 없으면 시작한다 — 있던 내용 그대로 첫 커밋 (git 이 없으면 아무것도 안 한다) */
  function ensureStarted(s: FakeState): void {
    if (s.mode === "no_git" || s.commits.length > 0) return;
    s.counter += 1;
    s.commits.unshift({ hash: fakeHash(`start:${s.counter}`).slice(0, 40), date: commitDate(s.counter), message: "처음 기록", kind: "start", files: [...s.custom.keys()].sort(), tree: new Map(s.custom) });
  }

  function commit(s: FakeState, message: string, kind: CustomCommitKind, tree: Files): FakeCommit {
    s.counter += 1;
    const made: FakeCommit = { hash: fakeHash(`${s.counter}:${message}:${s.commits.length}`).slice(0, 40), date: commitDate(s.counter), message, kind, files: changedPaths(head(s), tree), tree: new Map(tree) };
    s.commits.unshift(made);
    return made;
  }

  function unappliedOf(s: FakeState): CustomUnapplied {
    if (s.mode === "no_git") return { known: false, count: 0, files: [] };
    const paths = s.commits.length === 0 ? [] : changedPaths(head(s), s.custom);
    return {
      known: true,
      count: paths.length,
      files: paths.slice(0, LIST_FILES_MAX).map((path) => ({ path, status: head(s).get(path) === undefined ? "added" : s.custom.get(path) === undefined ? "removed" : "changed" })),
    };
  }

  const text = (value: string | undefined): CustomTextPart => (value === undefined ? { state: "absent" } : value.length > CUSTOM_TEXT_MAX_BYTES ? { state: "too_large" } : { state: "text", text: value });

  type ResolvedMain = { state: "unreadable"; reason: CustomUnreadableReason } | { state: "ok"; info: CustomItemInfo; detail: CustomItemDetail };
  type Resolved = { state: "missing" } | ResolvedMain;

  function resolveMain(s: FakeState): ResolvedMain {
    const example = s.source.get("config.example.json");
    const planner = (raw: string | undefined): Values => {
      try {
        const parsed = JSON.parse(raw ?? "{}") as { planner?: { model?: string; effort?: string } };
        return { model: parsed.planner?.model ?? null, effort: parsed.planner?.effort ?? null };
      } catch {
        return { model: null, effort: null };
      }
    };
    const customRaw = s.custom.get(CONFIG);
    if (customRaw !== undefined) {
      try {
        JSON.parse(customRaw);
      } catch {
        return { state: "unreadable", reason: "bad_config" };
      }
    }
    const origin = planner(example);
    const mine = customRaw === undefined ? { model: null, effort: null } : planner(customRaw);
    const myModel = mine.model !== origin.model ? mine.model : null;
    const myEffort = mine.effort !== origin.effort ? mine.effort : null;
    const marks: CustomMark[] = myModel !== null || myEffort !== null ? ["values"] : [];
    const info: CustomItemInfo = {
      id: "main",
      kind: "main",
      name: "main",
      description: null,
      file: CONFIG,
      model: origin.model,
      effort: origin.effort,
      myModel,
      myEffort,
      currentModel: customRaw === undefined ? origin.model : mine.model,
      currentEffort: customRaw === undefined ? origin.effort : mine.effort,
      marks,
      originChanged: null,
    };
    return { state: "ok", info, detail: { info, originText: { state: "absent" }, appendText: { state: "absent" }, replaceText: { state: "absent" }, originGone: false } };
  }

  function resolve(s: FakeState, item: Parsed): Resolved {
    if (item.kind === "main") return resolveMain(s);
    const f = filesOf(item);
    const source = s.source.get(f.file);
    const mine = s.custom.get(f.file);
    const valuesRaw = s.custom.get(f.values);
    const append = s.custom.get(f.append);
    const origin = s.custom.get(f.origin);
    const file = f.file;
    const reasonOf = (raw: string | undefined): CustomUnreadableReason | null => {
      if (raw === undefined) return null;
      if (raw.length > CUSTOM_TEXT_MAX_BYTES) return "too_large";
      return null;
    };
    const tooLarge = reasonOf(source) ?? reasonOf(mine) ?? reasonOf(valuesRaw);
    if (tooLarge !== null) return { state: "unreadable", reason: tooLarge };
    const my = valuesRaw === undefined ? null : parseValues(valuesRaw);
    if (valuesRaw !== undefined && my === null) return { state: "unreadable", reason: "bad_values" };
    const recorded = origin === undefined ? null : /^[0-9a-f]{64}$/.test(origin.replace(/\s/g, "").toLowerCase()) ? origin.replace(/\s/g, "").toLowerCase() : "bad";
    if (recorded === "bad") return { state: "unreadable", reason: "bad_origin" };
    if (source === undefined && mine === undefined) {
      return valuesRaw !== undefined || append !== undefined || origin !== undefined ? { state: "unreadable", reason: "target_gone" } : { state: "missing" };
    }
    const effective = front(mine ?? source ?? "");
    const originFront = source === undefined ? effective : front(source);
    if (effective === null || originFront === null) return { state: "unreadable", reason: "no_frontmatter" };
    if (item.kind === "agent" && mine !== undefined && source === undefined && agentProblem(item.name, mine) !== null) return { state: "unreadable", reason: "name_mismatch" };
    const marks: CustomMark[] = [];
    if (valuesRaw !== undefined) marks.push("values");
    if (append !== undefined && append.trim() !== "") marks.push("append");
    if (source !== undefined && mine !== undefined) marks.push("replace");
    if (source === undefined && mine !== undefined) marks.push("mine");
    const originChanged = recorded !== null && mine !== undefined ? recorded !== (source === undefined ? null : fakeHash(source)) : null;
    const info: CustomItemInfo = {
      id: item.kind === "agent" ? `agent:${item.name}` : `skill:${item.name}`,
      kind: item.kind,
      name: item.name,
      description: effective.get("description") ?? null,
      file,
      model: originFront.get("model") ?? null,
      effort: originFront.get("effort") ?? null,
      myModel: my?.model ?? null,
      myEffort: my?.effort ?? null,
      currentModel: my?.model ?? effective.get("model") ?? null,
      currentEffort: my?.effort ?? effective.get("effort") ?? null,
      marks,
      originChanged,
    };
    return {
      state: "ok",
      info,
      detail: { info, originText: text(source), appendText: text(append), replaceText: text(mine), originGone: recorded !== null && mine !== undefined && source === undefined },
    };
  }

  const names = (s: FakeState, kind: "agent" | "skill"): string[] => {
    const set = new Set<string>();
    for (const path of [...s.source.keys(), ...s.custom.keys()]) {
      const match = kind === "agent" ? /^agents\/([^/]+?)(?:\.append\.md|\.values\.yml|\.md\.origin|\.md)$/.exec(path) : /^skills\/([^/]+)\/SKILL\./.exec(path);
      if (match?.[1] !== undefined && validName(match[1]) && !(kind === "agent" && match[1] === "main")) set.add(match[1]);
    }
    return [...set].sort();
  };

  function listOf(s: FakeState): CustomList {
    const available = s.source.size > 0;
    const items: CustomListEntry[] = [];
    const entry = (item: Parsed) => {
      const resolved = resolve(s, item);
      if (resolved.state === "ok") items.push({ state: "ok", ...resolved.info });
      else if (resolved.state === "unreadable") {
        const id = item.kind === "main" ? "main" : `${item.kind}:${item.name}`;
        items.push({ state: "unreadable", id, kind: item.kind, name: item.name, file: item.kind === "main" ? CONFIG : filesOf(item).file, reason: resolved.reason });
      }
    };
    if (available) {
      entry({ kind: "main", name: "main" });
      for (const name of names(s, "agent")) entry({ kind: "agent", name });
      for (const name of names(s, "skill")) entry({ kind: "skill", name });
    }
    return {
      available,
      reason: available ? null : "no_source",
      developerMode: false,
      history: { state: gitState(s), detail: null },
      unapplied: unappliedOf(s),
      items,
      roles: available ? rolesOf(s) : {},
    };
  }

  /** 하네스 작업자 이름 → 역할 — 내 설정 → 원본 예시 순서로 처음 `agents` 가 있는 것 (Rust `main_config::roles` 와 같은 뜻, 가짜는 설치된 설정이 없다) */
  function rolesOf(s: FakeState): Record<string, AgentRole> {
    for (const raw of [s.custom.get(CONFIG), s.source.get("config.example.json")]) {
      if (raw === undefined) continue;
      try {
        const agents = (JSON.parse(raw) as { agents?: unknown }).agents;
        if (typeof agents !== "object" || agents === null) continue;
        const found: Record<string, AgentRole> = {};
        for (const [role, name] of Object.entries(agents)) {
          if (typeof name === "string" && name.trim() !== "" && (WORKER_ROLES as readonly string[]).includes(role)) found[name.trim()] = role as AgentRole;
        }
        if (Object.keys(found).length > 0) return found;
      } catch {
        // 깨진 설정은 건너뛴다
      }
    }
    return {};
  }

  // ───── 쓰기 ─────

  const put = (s: FakeState, path: string, value: string | null): void => {
    if (value === null) s.custom.delete(path);
    else s.custom.set(path, value);
  };

  /** 비게 된 스킬 폴더는 남기지 않는다 (가짜는 파일 목록뿐이라 할 일이 없다) */
  function saveValues(s: FakeState, idArg: unknown, wantedArg: unknown): CustomWriteResult {
    const item = parseId(idArg);
    const wanted = readValuesArg(wantedArg);
    if (item.kind === "main") {
      const view = resolveMain(s);
      if (view.state === "unreadable") return refused("bad_config");
      checkValues(wanted, [{ model: view.info.myModel, effort: view.info.myEffort }, { model: view.info.currentModel, effort: view.info.currentEffort }]);
      const example = JSON.parse(s.source.get("config.example.json") ?? "{}") as { planner?: { model?: string; effort?: string } };
      const base = s.custom.get(CONFIG) ?? s.source.get("config.example.json") ?? "{}";
      const parsed = JSON.parse(base) as Record<string, unknown> & { planner?: { model?: string; effort?: string } };
      const planner = { ...(parsed.planner ?? {}) };
      const target = { model: wanted.model ?? example.planner?.model ?? null, effort: wanted.effort ?? example.planner?.effort ?? null };
      for (const key of ["model", "effort"] as const) {
        const value = target[key];
        if (value === null) delete planner[key];
        else planner[key] = value;
      }
      const next = `${JSON.stringify({ ...parsed, planner }, null, 2)}\n`;
      const exists = s.custom.has(CONFIG);
      if (exists ? s.custom.get(CONFIG) === next : JSON.stringify(parsed.planner ?? {}) === JSON.stringify(planner)) return saved(false);
      ensureStarted(s);
      s.custom.set(CONFIG, next);
      return saved(true);
    }
    const f = filesOf(item);
    const source = s.source.get(f.file);
    const mine = s.custom.get(f.file);
    if (source === undefined && mine === undefined) return refused("not_found");
    if (source === undefined && mine !== undefined) {
      const fields = front(mine);
      if (fields === null) return refused("bad_frontmatter");
      checkValues(wanted, [{ model: fields.get("model") ?? null, effort: fields.get("effort") ?? null }]);
      let edited: string | null = mine;
      for (const [key, value] of [["model", wanted.model], ["effort", wanted.effort]] as const) {
        edited = edited === null ? null : setFront(edited, key, value);
      }
      if (edited === null) return refused("bad_frontmatter");
      if (item.kind === "agent") {
        const problem = agentProblem(item.name, edited);
        if (problem !== null) return refused("invalid_agent", problem);
      }
      if (normalize(mine) === edited) return saved(false);
      ensureStarted(s);
      s.custom.set(f.file, edited);
      return saved(true);
    }
    const existing = s.custom.get(f.values) ?? null;
    const already = existing === null ? null : parseValues(existing);
    checkValues(wanted, [already ?? { model: null, effort: null }]);
    if (existing !== null && already === null) return refused("bad_values");
    const rendered = renderValues(existing, wanted);
    if (rendered === null) {
      if (existing === null) return saved(false);
      ensureStarted(s);
      put(s, f.values, null);
      return saved(true);
    }
    if (existing !== null && normalize(existing) === rendered) return saved(false);
    ensureStarted(s);
    put(s, f.values, rendered);
    return saved(true);
  }

  function saveAppend(s: FakeState, idArg: unknown, body: unknown): CustomWriteResult {
    const item = parseId(idArg);
    if (typeof body !== "string") throw new AppError("invalid_input", "text must be a text");
    if (item.kind === "main") return refused("not_supported");
    const f = filesOf(item);
    if (!s.source.has(f.file)) return refused(s.custom.has(f.file) ? "not_supported" : "not_found");
    const existing = s.custom.get(f.append);
    if (body.trim() === "") {
      if (existing === undefined) return saved(false);
      ensureStarted(s);
      put(s, f.append, null);
      return saved(true);
    }
    const next = normalize(body);
    if (next.length > CUSTOM_TEXT_MAX_BYTES) return refused("too_large");
    if (existing !== undefined && normalize(existing) === next) return saved(false);
    ensureStarted(s);
    put(s, f.append, next);
    return saved(true);
  }

  function replaceStart(s: FakeState, idArg: unknown): CustomWriteResult {
    const item = parseId(idArg);
    if (item.kind === "main") return refused("not_supported");
    const f = filesOf(item);
    const source = s.source.get(f.file);
    if (source === undefined) return refused("not_found");
    if (s.custom.has(f.file)) return refused("already_replaced");
    if (item.kind === "agent") {
      const problem = agentProblem(item.name, source);
      if (problem !== null) return refused("invalid_agent", problem);
    }
    ensureStarted(s);
    s.custom.set(f.file, normalize(source));
    s.custom.set(f.origin, `${fakeHash(source)}\n`);
    return saved(true);
  }

  function textProblem(item: Parsed, body: string): CustomWriteResult | null {
    const fields = front(body);
    if (fields === null) return refused("bad_frontmatter");
    if (item.kind === "agent") {
      const problem = agentProblem(item.name, body);
      return problem === null ? null : refused("invalid_agent", problem);
    }
    const name = fields.get("name");
    return name !== undefined && name !== "" && name !== item.name ? refused("invalid_agent", `\`name\` must be ${item.name}`) : null;
  }

  function saveText(s: FakeState, idArg: unknown, body: unknown): CustomWriteResult {
    const item = parseId(idArg);
    if (typeof body !== "string") throw new AppError("invalid_input", "text must be a text");
    if (item.kind === "main") return refused("not_supported");
    const f = filesOf(item);
    const mine = s.custom.get(f.file);
    if (mine === undefined) return refused("not_replaced");
    const next = normalize(body);
    if (next.length > CUSTOM_TEXT_MAX_BYTES) return refused("too_large");
    const problem = textProblem(item, next);
    if (problem !== null) return problem;
    if (mine === next) return saved(false);
    ensureStarted(s);
    s.custom.set(f.file, next);
    return saved(true);
  }

  function replaceStop(s: FakeState, idArg: unknown): CustomWriteResult {
    const item = parseId(idArg);
    if (item.kind === "main") return refused("not_supported");
    const f = filesOf(item);
    if (!s.custom.has(f.file)) return refused("not_replaced");
    if (!s.source.has(f.file)) return refused("no_origin");
    ensureStarted(s);
    put(s, f.file, null);
    put(s, f.origin, null);
    return saved(true);
  }

  function originKeep(s: FakeState, idArg: unknown): CustomWriteResult {
    const item = parseId(idArg);
    if (item.kind === "main") return refused("not_supported");
    const f = filesOf(item);
    if (!s.custom.has(f.file)) return refused("not_replaced");
    const source = s.source.get(f.file);
    if (source === undefined) {
      if (!s.custom.has(f.origin)) return saved(false);
      ensureStarted(s);
      put(s, f.origin, null);
      return saved(true);
    }
    const line = `${fakeHash(source)}\n`;
    if (s.custom.get(f.origin) === line) return saved(false);
    ensureStarted(s);
    s.custom.set(f.origin, line);
    return saved(true);
  }

  function create(s: FakeState, requestArg: unknown): CustomWriteResult {
    const bad = (what: string) => new AppError("invalid_input", `new item: ${what}`);
    if (typeof requestArg !== "object" || requestArg === null) throw bad("request must be an object");
    const request = requestArg as Partial<CustomNewItem> & Record<string, unknown>;
    for (const key of Object.keys(request)) if (!["kind", "name", "description", "model", "effort"].includes(key)) throw bad(`unknown field: ${key}`);
    const { kind, name } = request;
    if (typeof name !== "string" || !validName(name) || name === "main") throw bad("name has the wrong shape");
    if (kind !== "agent" && kind !== "skill") throw bad("kind must be agent or skill");
    const description = typeof request.description === "string" ? request.description.trim() : "";
    if (description === "" || [...description].length > CUSTOM_DESCRIPTION_MAX_CHARS || new RegExp(CONTROL_CHARS.source).test(description)) throw bad("description must be one short line");
    const wanted = readValuesArg({ model: request.model ?? null, effort: request.effort ?? null });
    checkValues(wanted, []);
    if (s.source.size === 0) return refused("no_source");
    const f = filesOf({ kind, name });
    if (s.source.has(f.file)) return refused("name_in_source");
    const dir = kind === "skill" ? `skills/${name}/` : null;
    const taken = [f.file, f.values, f.append, f.origin].some((path) => s.custom.has(path)) || (dir !== null && [...s.custom.keys()].some((path) => path.startsWith(dir)));
    if (taken) return refused("name_taken");
    ensureStarted(s);
    s.custom.set(f.file, newText(kind, name, description, wanted.model, wanted.effort));
    // 가짜의 "사용자 자신의 파일": 이름이 `my-own-` 으로 시작하면 이미 있는 것으로 친다 (알림 흐름을 눌러 볼 수 있게)
    return { ...saved(true), notOurs: name.startsWith("my-own-") };
  }

  function deleteMine(s: FakeState, idArg: unknown): CustomWriteResult {
    const item = parseId(idArg);
    if (item.kind === "main") return refused("not_supported");
    const f = filesOf(item);
    if (s.source.has(f.file)) return refused("not_mine");
    const own = [f.file, f.values, f.append, f.origin];
    const dir = item.kind === "skill" ? `skills/${item.name}/` : null;
    const any = own.some((path) => s.custom.has(path)) || (dir !== null && [...s.custom.keys()].some((path) => path.startsWith(dir)));
    if (!any) return refused("not_found");
    ensureStarted(s);
    for (const path of [...s.custom.keys()]) if (own.includes(path) || (dir !== null && path.startsWith(dir))) s.custom.delete(path);
    return saved(true);
  }

  function discard(s: FakeState): CustomDiscardResult {
    if (s.mode === "no_git") return { outcome: "no_git", files: 0 };
    if (s.commits.length === 0) return { outcome: "not_started", files: 0 };
    const files = changedPaths(head(s), s.custom).length;
    s.custom = new Map(head(s));
    return { outcome: files === 0 ? "nothing" : "discarded", files };
  }

  /** 설치 — 가짜는 `install_fails` 모드(또는 시험이 한 번 정한 실패)면 실패한다 */
  function install(s: FakeState): ScriptResult {
    const ok = s.mode !== "install_fails" && !failNextInstall;
    failNextInstall = false;
    return installResult(ok);
  }

  function apply(s: FakeState, summaryArg: unknown): CustomApplyResult {
    if (summaryArg !== undefined && summaryArg !== null && typeof summaryArg !== "string") throw new AppError("invalid_input", "summary must be a text");
    const nothing: CustomApplyResult = { outcome: "nothing", script: null, commit: "skipped", commitShort: null, files: 0, detail: null };
    let files = 0;
    if (s.mode !== "no_git") {
      if (s.commits.length === 0) return nothing;
      files = changedPaths(head(s), s.custom).length;
      if (files === 0) return nothing;
    }
    const script = install(s);
    if (script.exitCode !== 0 || script.report?.ok !== true) return { outcome: "failed", script, commit: "skipped", commitShort: null, files, detail: null };
    if (s.mode === "no_git") return { outcome: "applied", script, commit: "no_git", commitShort: null, files, detail: null };
    const addsItem = changedPaths(head(s), s.custom).some((path) => /^(agents\/[^/]+\.md|skills\/[^/]+\/SKILL\.md)$/.test(path) && head(s).get(path) === undefined && !s.source.has(path));
    const message = (typeof summaryArg === "string" ? cleanMessage(summaryArg) : null) ?? `적용 — 파일 ${files}개`;
    const made = commit(s, message, addsItem ? "new" : "apply", s.custom);
    return { outcome: "applied", script, commit: "committed", commitShort: made.hash.slice(0, 7), files, detail: null };
  }

  const commitOf = (c: FakeCommit): CustomCommit => ({
    hash: c.hash,
    short: c.hash.slice(0, 7),
    date: c.date,
    message: c.message,
    kind: c.kind,
    files: c.files.slice(0, COMMIT_FILES_MAX),
    filesTotal: c.files.length,
  });

  function findCommit(s: FakeState, ref: unknown): FakeCommit | "bad" | null {
    if (typeof ref !== "string" || !/^[0-9a-f]{7,40}$/.test(ref)) return "bad";
    const found = s.commits.filter((c) => c.hash.startsWith(ref));
    return found.length === 1 ? found[0]! : null;
  }

  function restore(s: FakeState, refArg: unknown): CustomRestoreResult {
    const found = findCommit(s, refArg);
    if (found === "bad") throw new AppError("invalid_input", "commit id has the wrong shape");
    const bare = (outcome: CustomRestoreResult["outcome"]): CustomRestoreResult => ({ outcome, script: null, commit: "skipped", commitShort: null, detail: null });
    if (s.mode === "no_git") return bare("no_git");
    if (s.commits.length === 0) return bare("not_started");
    if (found === null) return bare("unknown_commit");
    if (changedPaths(head(s), s.custom).length > 0) return bare("has_unapplied");
    if (changedPaths(head(s), found.tree).length === 0) return bare("same_as_now");
    const before = new Map(s.custom);
    s.custom = new Map(found.tree);
    const script = install(s);
    if (script.exitCode !== 0 || script.report?.ok !== true) {
      s.custom = before;
      return { ...bare("failed"), script };
    }
    const made = commit(s, `${found.hash.slice(0, 7)} 때로 되돌림`, "restore", s.custom);
    return { outcome: "restored", script, commit: "committed", commitShort: made.hash.slice(0, 7), detail: null };
  }

  /** `{ agents: { 이름: 글 } }` 파일 읽기 (고양이 · 보이는 이름이 같이 쓴다) — 글인 값만 */
  function readAgentsFile(s: FakeState, file: string): CustomCats {
    const raw = s.custom.get(file);
    if (raw === undefined) return { state: "absent", agents: {} };
    try {
      const parsed = JSON.parse(raw) as { agents?: Record<string, unknown> };
      const agents: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.agents ?? {})) if (typeof value === "string") agents[key] = value;
      return { state: "ok", agents };
    } catch {
      return { state: "unreadable", agents: {} };
    }
  }

  const readCats = (s: FakeState): CustomCats => readAgentsFile(s, AGENT_CATS);

  const bareWrite = (over: Partial<CustomCatsWriteResult>): CustomCatsWriteResult => ({ outcome: "saved", reason: null, changed: false, commit: "skipped", commitShort: null, detail: null, ...over });

  /** 모두 적용해 파일을 한 번 쓰고 그 파일만 커밋 하나 (진짜 `cats::write_edits` 와 같다). 이름 · 글 모양은 부르는 쪽이 이미 확인했다 */
  function writeAgentsFile(s: FakeState, file: string, subject: string, kind: CustomCommitKind, edits: ReadonlyArray<readonly [string, string | null]>): CustomCatsWriteResult {
    const raw = s.custom.get(file);
    let parsed: { version?: number; agents?: Record<string, unknown> } & Record<string, unknown> = { version: 1 };
    if (raw !== undefined) {
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        return bareWrite({ outcome: "refused", reason: "unreadable" });
      }
    }
    const agents = { ...(parsed.agents ?? {}) };
    for (const [agent, value] of edits) {
      if (value === null) delete agents[agent];
      else agents[agent] = value;
    }
    const next = `${JSON.stringify({ ...parsed, agents }, null, 2)}\n`;
    if (raw === undefined ? edits.every(([, value]) => value === null) : normalize(raw) === next) return bareWrite({});
    ensureStarted(s);
    s.custom.set(file, next);
    if (s.mode === "no_git") return bareWrite({ changed: true, commit: "no_git" });
    // 그 파일만 커밋한다 — 다른 적용 안 한 것은 그대로
    const tree = new Map(head(s));
    tree.set(file, next);
    const made = commit(s, subject, kind, tree);
    return bareWrite({ changed: true, commit: "committed", commitShort: made.hash.slice(0, 7) });
  }

  function checkCatLine(agentArg: unknown, catArg: unknown): readonly [string, string | null] {
    if (typeof agentArg !== "string" || (agentArg !== "main" && !validName(agentArg))) throw new AppError("invalid_input", "agent name has the wrong shape");
    if (catArg !== null && catArg !== undefined && (typeof catArg !== "string" || !CUSTOM_CAT_ID_PATTERN.test(catArg))) throw new AppError("invalid_input", "cat id has the wrong shape");
    return [agentArg, typeof catArg === "string" ? catArg : null];
  }

  function saveCat(s: FakeState, agentArg: unknown, catArg: unknown): CustomCatsWriteResult {
    return writeAgentsFile(s, AGENT_CATS, "고양이 연결 바꿈", "cats", [checkCatLine(agentArg, catArg)]);
  }

  /** 여러 줄 한 번에 — 1~64 줄 · 같은 에이전트는 한 번 · 하나라도 모양이 틀리면 아무것도 쓰지 않는다 (`cats::edits_of`) */
  function saveCats(s: FakeState, changesArg: unknown): CustomCatsWriteResult {
    if (!Array.isArray(changesArg) || changesArg.length === 0 || changesArg.length > CUSTOM_CATS_CHANGES_MAX) throw new AppError("invalid_input", "the number of changes is out of range");
    const seen = new Set<string>();
    const edits: Array<readonly [string, string | null]> = [];
    for (const raw of changesArg as unknown[]) {
      const line = raw as Partial<CustomCatChange> | null;
      // `cat` 을 빠뜨린 것이 지움으로 읽히면 안 된다 · 모르는 필드도 거절한다 (진짜는 serde `deny_unknown_fields`)
      if (typeof line !== "object" || line === null || !("cat" in line) || Object.keys(line).some((key) => key !== "agent" && key !== "cat")) throw new AppError("invalid_input", "a change has the wrong shape");
      const edit = checkCatLine(line.agent, line.cat);
      if (seen.has(edit[0])) throw new AppError("invalid_input", "the same agent appears twice");
      seen.add(edit[0]);
      edits.push(edit);
    }
    return writeAgentsFile(s, AGENT_CATS, "고양이 연결 바꿈", "cats", edits);
  }

  /** 보이는 이름 규칙 — 앞뒤 공백을 떼고 1~20 글자(문자 수), 줄바꿈 · 탭 · 제어 문자 없음. `label: null` = 뗀 뒤 비었다 (진짜 `labels::clean_label`) */
  function cleanLabel(raw: string): { ok: true; label: string | null } | { ok: false } {
    const label = raw.trim();
    if (label === "") return { ok: true, label: null };
    if ([...label].length > CUSTOM_LABEL_MAX_CHARS || label.search(CONTROL_CHARS) >= 0 || /[\u2028\u2029]/.test(label)) return { ok: false };
    return { ok: true, label };
  }

  function readLabels(s: FakeState): CustomLabels {
    const read = readAgentsFile(s, AGENT_LABELS);
    const agents: Record<string, string> = {};
    for (const [agent, raw] of Object.entries(read.agents)) {
      const cleaned = cleanLabel(raw);
      if (agent !== "main" && validName(agent) && cleaned.ok && cleaned.label !== null) agents[agent] = cleaned.label;
    }
    return { state: read.state, agents };
  }

  function saveLabel(s: FakeState, agentArg: unknown, labelArg: unknown): CustomCatsWriteResult {
    if (typeof agentArg !== "string" || agentArg === "main" || !validName(agentArg)) throw new AppError("invalid_input", "agent name has the wrong shape");
    if (labelArg !== null && labelArg !== undefined && typeof labelArg !== "string") throw new AppError("invalid_input", "label has the wrong shape");
    const cleaned = typeof labelArg === "string" ? cleanLabel(labelArg) : ({ ok: true, label: null } as const);
    if (!cleaned.ok) return bareWrite({ outcome: "refused", reason: "bad_label" });
    return writeAgentsFile(s, AGENT_LABELS, "보이는 이름을 바꿈", "labels", [[agentArg, cleaned.label]]);
  }

  const handlers: Record<string, Handler> = {
    custom_list: () => structuredClone(listOf(current())),
    custom_item_read: (args): CustomItemRead => {
      const item = parseId(args.itemId);
      const resolved = resolve(current(), item);
      if (resolved.state === "missing") return { state: "not_found" };
      if (resolved.state === "unreadable") {
        return { state: "unreadable", id: item.kind === "main" ? "main" : `${item.kind}:${item.name}`, kind: item.kind, name: item.name, file: item.kind === "main" ? CONFIG : filesOf(item).file, reason: resolved.reason };
      }
      return structuredClone({ state: "ok", ...resolved.detail });
    },
    custom_values_save: (args) => exclusive(() => saveValues(current(), args.itemId, args.values)),
    custom_append_save: (args) => exclusive(() => saveAppend(current(), args.itemId, args.text)),
    custom_replace_start: (args) => exclusive(() => replaceStart(current(), args.itemId)),
    custom_text_save: (args) => exclusive(() => saveText(current(), args.itemId, args.text)),
    custom_replace_stop: (args) => exclusive(() => replaceStop(current(), args.itemId)),
    custom_origin_keep: (args) => exclusive(() => originKeep(current(), args.itemId)),
    custom_new: (args) => exclusive(() => create(current(), args.request)),
    custom_mine_delete: (args) => exclusive(() => deleteMine(current(), args.itemId)),
    custom_changes: (): CustomChanges => {
      const s = current();
      if (s.mode === "no_git") return { state: "no_git", detail: null, files: [], filesTotal: 0 };
      if (s.commits.length === 0) return { state: "not_started", detail: null, files: [], filesTotal: 0 };
      const paths = changedPaths(head(s), s.custom);
      return { state: "ok", detail: null, files: paths.slice(0, FILES_MAX).map((path) => fileDiff(path, head(s).get(path), s.custom.get(path))), filesTotal: paths.length };
    },
    custom_discard: () => exclusive(() => discard(current())),
    custom_apply: (args) => exclusive(() => apply(current(), args.summary)),
    custom_history: (): CustomHistory => {
      const s = current();
      const state = gitState(s);
      if (state !== "ok") return { state, detail: null, commits: [], truncated: false };
      return { state, detail: null, commits: s.commits.slice(0, LOG_MAX).map(commitOf), truncated: s.commits.length > LOG_MAX };
    },
    custom_commit_diff: (args): CustomCommitDiff => {
      const s = current();
      const found = findCommit(s, args.commit);
      if (found === "bad") throw new AppError("invalid_input", "commit id has the wrong shape");
      if (s.mode === "no_git") return { state: "no_git" };
      if (s.commits.length === 0) return { state: "not_started" };
      if (found === null) return { state: "unknown_commit" };
      const index = s.commits.indexOf(found);
      const before = s.commits[index + 1]?.tree ?? new Map<string, string>();
      const paths = changedPaths(before, found.tree);
      return { state: "ok", commit: commitOf(found), files: paths.slice(0, FILES_MAX).map((path) => fileDiff(path, before.get(path), found.tree.get(path))), filesTotal: paths.length };
    },
    custom_restore: (args) => exclusive(() => restore(current(), args.commit)),
    custom_cats_read: () => structuredClone(readCats(current())),
    custom_cat_save: (args) => exclusive(() => saveCat(current(), args.agent, args.cat)),
    custom_cats_save: (args) => exclusive(() => saveCats(current(), args.changes)),
    custom_labels_read: () => structuredClone(readLabels(current())),
    custom_label_save: (args) => exclusive(() => saveLabel(current(), args.agent, args.label)),
  };

  return {
    handlers,
    /** 시험용: 처음 모습으로 (`next` 를 주면 쿼리 대신 그 모드, 없으면 다시 쿼리를 읽는다) */
    reset(next?: FakeCustomMode) {
      override = next ?? null;
      state = null;
      busy = false;
      failNextInstall = false;
    },
    /** 시험 · 개발용: 다음 설치 한 번만 실패한다 (적용 · 되돌리기의 실패 흐름) */
    failNextInstall() {
      failNextInstall = true;
    },
    /** 시험 · 개발용: 원본 업데이트를 받은 것을 흉내 낸다 — 디자이너 원본 글이 바뀌고(통째로 바꾼 파일의 원본 바뀜이 다시 켜진다) 기록이 시작돼 있으면 "원본 업데이트 받음" 빈 커밋이 생긴다 */
    simulateOriginUpdate() {
      const s = current();
      const path = "agents/harness-designer.md";
      const old = s.source.get(path);
      if (old === undefined) return;
      s.source.set(path, old.replace(/\n$/, "") + "\n- 원본이 새로 더한 줄.\n");
      if (s.mode !== "no_git" && s.commits.length > 0) commit(s, "원본 업데이트 받음 (b2c3d4e)", "origin_update", head(s));
    },
  };
}

export const fakeCustom = createFakeCustom();
