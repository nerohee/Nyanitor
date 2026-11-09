// 「내 수정」 화면의 순수 계산 — 항목 이름 · 고양이 · 적용 요약 · 기록 시각 · 거절 이유 / 설치 문제 문구. 화면 상태 없이 시험할 수 있게 따로 둔다.
import { catForAgent, findCat } from "../components/cat/catalog";
import { hasBatchim } from "../i18n/josa";
import { t, tf, type TextKey } from "../i18n/ko";
import { errorText } from "../workspace/errors";
import type {
  AgentRole,
  AppErrorKind,
  AgentsList,
  CustomFileDiff,
  CustomFileStatus,
  CustomItemKind,
  CustomListEntry,
  CustomUnappliedFile,
  CustomUnreadableReason,
  HarnessProblem,
  ScriptResult,
} from "../lib/ipc-types";

/** 에이전트 파일 이름(확장자 뺀 것) → 하네스 역할. 이름을 한국어로 · 고양이를 기본 연결로 찾는 데 쓴다 */
export type RoleMap = ReadonlyMap<string, AgentRole>;

export function rolesOf(list: AgentsList | null): RoleMap {
  const roles = new Map<string, AgentRole>();
  for (const entry of list?.agents ?? []) {
    if (entry.role === null || entry.role === "main" || entry.file === null) continue;
    roles.set(entry.file.replace(/\.md$/, ""), entry.role);
  }
  return roles;
}

/** 항목 이름 — 오케스트레이터 · 하네스 작업자는 다른 화면들이 쓰는 한국어 이름, 그 밖은 파일의 `name` 그대로 */
export function itemLabel(kind: CustomItemKind, name: string, roles: RoleMap): string {
  if (kind === "main") return t("edit.item.main");
  if (kind === "agent") {
    const role = roles.get(name);
    if (role) return t(`home.info.role.${role}`);
  }
  return name;
}

/** 항목의 고양이 — 내 연결 → 기본 연결(역할) → 없음(기본 아이콘). 스킬은 고양이가 없다 */
export function itemCat(kind: CustomItemKind, name: string, roles: RoleMap, userCats: Readonly<Record<string, string>>): string | null {
  if (kind === "skill") return null;
  const mine = userCats[kind === "main" ? "main" : name];
  if (mine !== undefined && findCat(mine)) return mine;
  if (kind === "main") return catForAgent("main");
  const role = roles.get(name);
  return role ? catForAgent(role) : null;
}

// ───────────────────────────── 적용 요약 ─────────────────────────────

type Part = "values" | "append" | "whole" | "origin" | "cats";

interface ParsedPath {
  kind: CustomItemKind | "cats";
  name: string;
  part: Part;
}

const AGENT_FILE = /^agents\/([a-z][a-z0-9-]*)(\.values\.yml|\.append\.md|\.md\.origin|\.md)$/;
const SKILL_FILE = /^skills\/([a-z][a-z0-9-]*)\/SKILL(\.values\.yml|\.append\.md|\.md\.origin|\.md)$/;

function partOf(suffix: string): Part {
  if (suffix === ".values.yml") return "values";
  if (suffix === ".append.md") return "append";
  if (suffix === ".md.origin") return "origin";
  return "whole";
}

/** 내 수정 폴더의 상대 경로 → 어느 항목의 무엇인가 (모르는 파일은 null) */
export function parseCustomPath(path: string): ParsedPath | null {
  if (path === "config.local.json") return { kind: "main", name: "main", part: "values" };
  if (path === "agent-cats.json") return { kind: "cats", name: "cats", part: "cats" };
  const agent = AGENT_FILE.exec(path);
  if (agent) return { kind: "agent", name: agent[1]!, part: partOf(agent[2]!) };
  const skill = SKILL_FILE.exec(path);
  if (skill) return { kind: "skill", name: skill[1]!, part: partOf(skill[2]!) };
  return null;
}

/** "…으로" · "…로" — 받침이 있고 ㄹ 받침이 아니면 "으로" */
function toward(word: string): string {
  const trimmed = word.trim();
  const last = trimmed.charCodeAt(trimmed.length - 1);
  const jong = Number.isNaN(last) || last < 0xac00 || last > 0xd7a3 ? 0 : (last - 0xac00) % 28;
  return `${word}${hasBatchim(word) && jong !== 8 ? "으로" : "로"}`;
}

const VALUE_LINE = /^\s*"?(model|effort)"?\s*:\s*"?([A-Za-z0-9._-]+)"?\s*,?\s*$/;

export function valueLabel(key: "model" | "effort", value: string): string {
  if (key === "model") {
    if (value === "opus") return t("variant.edit.model.opus");
    if (value === "sonnet") return t("variant.edit.model.sonnet");
    if (value === "haiku") return t("variant.edit.model.haiku");
    return value;
  }
  if (value === "low") return t("cat.effort.low");
  if (value === "medium") return t("cat.effort.medium");
  if (value === "high") return t("cat.effort.high");
  return value;
}

/** 값 파일의 바뀐 곳 → "수준을 높음으로" 같은 말. 알 수 없으면 "값을 바꿈" */
function valuesWhat(status: CustomFileStatus, diff: CustomFileDiff | undefined): string {
  if (status === "removed") return t("edit.what.valuesOrigin");
  const set = new Map<string, string>();
  for (const line of diff?.lines ?? []) {
    if (line.sign !== "+") continue;
    const match = VALUE_LINE.exec(line.text);
    if (match) set.set(match[1]!, match[2]!);
  }
  if (set.size === 1) {
    const [key, value] = [...set][0]!;
    const shown = toward(valueLabel(key as "model" | "effort", value));
    return key === "model" ? tf("edit.what.model", { v: shown }) : tf("edit.what.effort", { v: shown });
  }
  return t("edit.what.values");
}

interface SummaryInput {
  files: readonly CustomUnappliedFile[];
  /** 파일별 차이 (있으면 값 바꿈을 구체적으로 적는다) */
  diffs?: readonly CustomFileDiff[] | null;
  items: readonly CustomListEntry[];
  roles: RoleMap;
}

/**
 * 적용 메시지(기록에 남는 한 줄) — 바뀐 항목이 하나면 `<이름> — <무엇>`, 여럿이면 `<첫 이름> 외 n개`.
 * 무엇은 적용 안 한 파일 모양으로: 값(`수준을 높음으로`) · 덧붙임 · 통째 · 새 파일 · 지움. 적용 안 한 것이 없으면 null (Rust 가 기본 메시지를 쓴다).
 */
export function buildSummary({ files, diffs, items, roles }: SummaryInput): string | null {
  const groups = new Map<string, { label: string; whats: string[] }>();
  const byPath = new Map((diffs ?? []).map((diff) => [diff.path, diff]));
  for (const file of files) {
    const parsed = parseCustomPath(file.path);
    if (!parsed) continue;
    const id = parsed.kind === "main" ? "main" : `${parsed.kind}:${parsed.name}`;
    const entry = items.find((item) => item.id === id);
    const marks = entry?.state === "ok" ? entry.marks : [];
    let what: string;
    switch (parsed.part) {
      case "values":
        what = valuesWhat(file.status, byPath.get(file.path));
        break;
      case "append":
        what = file.status === "removed" ? t("edit.what.appendGone") : t("edit.what.append");
        break;
      case "whole":
        if (file.status === "removed") what = entry && !marks.includes("mine") ? t("edit.what.toOrigin") : t("edit.what.gone");
        else if (marks.includes("mine") && file.status === "added") what = t("edit.what.created");
        else if (marks.includes("mine")) what = t("edit.what.mineEdited");
        else what = t("edit.what.whole");
        break;
      case "origin":
        what = t("edit.what.origin");
        break;
      default:
        what = t("edit.what.cats");
    }
    const key = parsed.kind === "cats" ? "cats" : id;
    const label = parsed.kind === "cats" ? t("edit.what.catsName") : itemLabel(parsed.kind, parsed.name, roles);
    const group = groups.get(key) ?? { label, whats: [] };
    if (!group.whats.includes(what)) group.whats.push(what);
    groups.set(key, group);
  }
  const all = [...groups.values()].map((group) => {
    // 통째로 바꾼 파일의 `.origin` 은 같은 말이라 다른 것과 같이 있으면 따로 적지 않는다
    const whats = group.whats.length > 1 ? group.whats.filter((w) => w !== t("edit.what.origin")) : group.whats;
    return { label: group.label, what: whats.join(" · ") };
  });
  if (all.length === 0) return null;
  if (all.length === 1) return tf("edit.summary.one", { name: all[0]!.label, what: all[0]!.what });
  return tf("edit.summary.many", { name: all[0]!.label, n: all.length - 1 });
}

// ───────────────────────────── 기록 시각 ─────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");

/** 오늘 HH:MM / 어제 / M월 D일 — 읽을 수 없는 시각은 그대로 */
export function formatWhen(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(at)) / 86_400_000);
  if (diff === 0) return tf("edit.when.today", { at: `${two(at.getHours())}:${two(at.getMinutes())}` });
  if (diff === 1) return t("edit.when.yesterday");
  return tf("edit.when.date", { m: at.getMonth() + 1, d: at.getDate() });
}

// ───────────────────────────── 거절 이유 · 설치 문제 문구 ─────────────────────────────

const REFUSE_KEYS: Readonly<Record<string, TextKey>> = {
  no_source: "edit.refuse.no_source",
  not_found: "edit.refuse.not_found",
  link_in_path: "edit.refuse.link_in_path",
  too_large: "edit.refuse.too_large",
  not_utf8: "edit.refuse.not_utf8",
  unreadable: "edit.refuse.unreadable",
  bad_values: "edit.refuse.bad_values",
  bad_config: "edit.refuse.bad_config",
  bad_frontmatter: "edit.refuse.bad_frontmatter",
  invalid_agent: "edit.refuse.invalid_agent",
  name_in_source: "edit.refuse.name_in_source",
  name_taken: "edit.refuse.name_taken",
  not_mine: "edit.refuse.not_mine",
  not_replaced: "edit.refuse.not_replaced",
  already_replaced: "edit.refuse.already_replaced",
  not_supported: "edit.refuse.not_supported",
  no_origin: "edit.refuse.no_origin",
};

/** 저장이 거절된 이유 → 쉬운 말. 모르는 이유는 코드 그대로 */
export function refuseText(reason: string | null): string {
  if (reason === null) return t("edit.refuse.unknown");
  const key = REFUSE_KEYS[reason];
  return key ? t(key) : reason;
}

const UNREADABLE_KEYS: Readonly<Record<CustomUnreadableReason, TextKey>> = {
  too_large: "edit.unreadable.too_large",
  read_failed: "edit.unreadable.read_failed",
  not_utf8: "edit.unreadable.not_utf8",
  no_frontmatter: "edit.unreadable.no_frontmatter",
  unclosed_frontmatter: "edit.unreadable.unclosed_frontmatter",
  name_mismatch: "edit.unreadable.name_mismatch",
  bad_values: "edit.unreadable.bad_values",
  bad_origin: "edit.unreadable.bad_origin",
  link_in_custom: "edit.unreadable.link_in_custom",
  target_gone: "edit.unreadable.target_gone",
  bad_config: "edit.unreadable.bad_config",
};

/** 읽을 수 없는 이유 → 쉬운 말. 모르는 이유는 코드 그대로 */
export function unreadableText(reason: string): string {
  const key = (UNREADABLE_KEYS as Readonly<Record<string, TextKey>>)[reason];
  return key ? t(key) : reason;
}

const PROBLEM_KEYS: Readonly<Record<string, TextKey>> = {
  symlinkInCustom: "edit.problem.symlinkInCustom",
  badPath: "edit.problem.badPath",
  unsupported: "edit.problem.unsupported",
  targetMissing: "edit.problem.targetMissing",
  badValues: "edit.problem.badValues",
  badOrigin: "edit.problem.badOrigin",
  invalidAgent: "edit.problem.invalidAgent",
  harnessNotOurs: "edit.problem.harnessNotOurs",
};

const ERROR_CODE_KEYS: Readonly<Record<string, TextKey>> = {
  busy: "edit.errorCode.busy",
  backupFailed: "edit.errorCode.backupFailed",
  writeFailed: "edit.errorCode.writeFailed",
  applyFailed: "edit.errorCode.applyFailed",
  notFound: "edit.errorCode.notFound",
  unexpected: "edit.errorCode.unexpected",
};

const OUTCOME_KEYS: Readonly<Record<string, TextKey>> = {
  unreadable: "edit.outcome.unreadable",
  no_script: "edit.outcome.no_script",
  refused: "edit.outcome.refused",
  timed_out: "edit.outcome.timed_out",
  spawn_failed: "edit.outcome.spawn_failed",
};

/** 막는 문제 한 줄 — 알려진 코드는 쉬운 말 + 파일, 모르는 코드는 그대로 */
export function problemLine(problem: HarnessProblem): string {
  const key = PROBLEM_KEYS[problem.reason];
  const head = key ? t(key) : problem.reason;
  return `${head}${problem.path ? ` — ${problem.path}` : ""}`;
}

/** 설치 결과가 실패일 때 쉬운 말로 — 막는 문제 · 오류 코드 · 스크립트를 돌리지 못한 이유. 모르는 코드는 그대로 둔다 */
export function describeInstallFailure(script: ScriptResult | null, detail: string | null): string[] {
  const lines: string[] = [];
  const report = script?.report ?? null;
  for (const problem of report?.problems ?? []) lines.push(problemLine(problem));
  if (report?.error) {
    const key = ERROR_CODE_KEYS[report.error.code];
    lines.push(`${key ? t(key) : report.error.code}${report.error.detail ? ` — ${report.error.detail}` : ""}`);
  }
  if (script && script.outcome !== "ran") {
    const key = OUTCOME_KEYS[script.outcome];
    lines.push(key ? t(key) : script.outcome);
    if (script.reason) lines.push(script.reason);
  }
  if (detail) lines.push(detail);
  if (lines.length === 0) lines.push(t("edit.apply.failedUnknown"));
  return lines;
}

/** 명령이 오류로 끝났을 때 한 줄 — 다른 하네스 일이 도는 중(`harness_busy`)이면 기다렸다 다시 하라고, 나머지는 작업 공간과 같은 문구 */
export function errorLine(kind: AppErrorKind): string {
  return kind === "harness_busy" ? t("edit.error.busy") : errorText(kind);
}
