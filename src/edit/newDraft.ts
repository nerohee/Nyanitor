// 새로 만들기의 순수한 쪽 — 초안(칸 값 + 고른 고양이) 모양 · 칸 검사 · 복사할 본문 만들기 · 만들기 순서(`createItem`).
// 화면 상태 없이 시험할 수 있게 `NewItem.tsx` · `CatPick.tsx` 와 따로 둔다. 쓰는 명령은 `ipc.custom*` 뿐이다 (경로를 보내는 길은 없다).
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomItemInfo, CustomListEntry } from "../lib/ipc-types";
import { CUSTOM_DESCRIPTION_MAX_CHARS, CUSTOM_LABEL_MAX_CHARS, CUSTOM_NAME_PATTERN } from "../lib/ipc-types";
import { errorKind } from "../workspace/errors";

export type NewKind = "agent" | "skill";

/** 새로 만들기 칸 + 고양이 고르기에서 고른 고양이 — 화면(`EditScreen`)이 들고 오간다 */
export interface NewDraft {
  kind: NewKind;
  name: string;
  /** 보이는 이름 (에이전트만 · 비우면 에이전트 이름이 보인다) */
  label: string;
  description: string;
  start: "blank" | "copy";
  /** 복사할 항목 id — 모르면 같은 종류의 첫 항목 */
  from: string | null;
  /** 앞머리 `model` · `effort` — 빈 글 = 정하지 않음 */
  model: string;
  effort: string;
  /** 고른 고양이 (에이전트만 · 아직 안 골랐으면 null) */
  cat: string | null;
}

export const EMPTY_DRAFT: NewDraft = { kind: "agent", name: "", label: "", description: "", start: "blank", from: null, model: "sonnet", effort: "medium", cat: null };

/** 쓴 것이 있다 (취소할 때 묻는다) */
export function hasWriting(draft: NewDraft): boolean {
  return draft.name !== "" || draft.label !== "" || draft.description !== "" || draft.cat !== null || draft.start !== "blank";
}

// eslint-disable-next-line no-control-regex -- 제어 문자를 찾는 것이 목적이다 (Rust 의 `char::is_control` 과 같다)
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const chars = (text: string) => [...text].length;

/** 이름 칸의 최대 글자 수 — `CUSTOM_NAME_PATTERN` (`^[a-z][a-z0-9-]{0,63}$`) 과 같다. 다 차면 더 쳐지지 않게 칸에 건다 */
export const NAME_MAX_CHARS = 64;

export type NameProblem = "bad" | "source" | "taken" | "exists";

/** 이름 칸 검사 — 빈 칸은 문제가 아니라 아직 안 쓴 것 (null). 같은 종류의 목록에 있으면 원본 것인지 내 것인지 가른다 */
export function nameProblem(kind: NewKind, name: string, entries: readonly CustomListEntry[]): NameProblem | null {
  if (name === "") return null;
  if (!CUSTOM_NAME_PATTERN.test(name) || (kind === "agent" && name === "main")) return name === "main" ? "source" : "bad";
  const found = entries.find((entry) => entry.kind === kind && entry.name === name);
  if (!found) return null;
  if (found.state !== "ok") return "exists";
  return found.marks.includes("mine") ? "taken" : "source";
}

/** 보이는 이름 칸 검사 — 앞뒤 공백을 뗀 뒤 1~20 글자 · 줄바꿈 없음 (비워도 된다) */
export function labelProblem(label: string): boolean {
  const trimmed = label.trim();
  if (trimmed === "") return false;
  return chars(trimmed) > CUSTOM_LABEL_MAX_CHARS || CONTROL.test(trimmed);
}

/** 소개 칸을 한 줄로 — 줄바꿈은 공백 하나로 (Rust 가 한 줄만 받는다) */
export function oneLine(text: string): string {
  return [...text.replace(/[\r\n]+/g, " ")].slice(0, CUSTOM_DESCRIPTION_MAX_CHARS).join("");
}

export function descriptionReady(description: string): boolean {
  const trimmed = description.trim();
  return trimmed !== "" && chars(trimmed) <= CUSTOM_DESCRIPTION_MAX_CHARS && !CONTROL.test(trimmed);
}

/** 이름 · 소개가 맞고 보이는 이름이 규칙을 지킨다 — 주 단추가 켜지는 조건 */
export function draftReady(draft: NewDraft, entries: readonly CustomListEntry[], copyCount: number): boolean {
  if (draft.name === "" || nameProblem(draft.kind, draft.name, entries) !== null) return false;
  if (!descriptionReady(draft.description)) return false;
  if (draft.kind === "agent" && labelProblem(draft.label)) return false;
  if (draft.start === "copy" && copyCount === 0) return false;
  return true;
}

/** 복사할 수 있는 항목 — 같은 종류의 읽을 수 있는 것 (오케스트레이터 제외) */
export function copyCandidates(entries: readonly CustomListEntry[], kind: NewKind): CustomItemInfo[] {
  return entries.flatMap((entry) => (entry.state === "ok" && entry.kind === kind ? [entry] : []));
}

// ───────────────────────────── 본문 복사 ─────────────────────────────

/** 앞머리(첫 `---` ~ 둘째 `---`, 줄바꿈 포함)와 그 뒤 본문으로 가른다. 앞머리가 없거나 닫히지 않으면 null */
export function splitFront(text: string): { front: string; body: string } | null {
  const all = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  if (all[0]?.trimEnd() !== "---") return null;
  const close = all.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (close < 0) return null;
  return { front: `${all.slice(0, close + 1).join("\n")}\n`, body: all.slice(close + 1).join("\n") };
}

/** 새로 만든 틀의 앞머리(새 이름 · 소개 · 값)는 두고, 본문만 고른 항목의 글로 바꾼 글. 어느 쪽이든 앞머리가 없으면 null */
export function copiedText(fresh: string, source: string): string | null {
  const head = splitFront(fresh);
  const from = splitFront(source);
  return head && from ? head.front + from.body : null;
}

// ───────────────────────────── 만들기 순서 ─────────────────────────────

/** `customNew` 뒤 단계 중 실패한 것 */
export type CreateStep = "copy" | "label" | "cat";

export type CreateResult =
  /** `customNew` 가 거절 — 아무것도 안 만들어졌다 (초안 그대로 새로 만들기로) */
  | { status: "refused"; reason: string | null }
  /** `customNew` 가 오류 (잠김 · 쓰기 실패 …) */
  | { status: "error"; kind: AppErrorKind }
  /** 항목이 만들어졌다. `failed` 가 비어 있지 않으면 그 단계는 다시 해야 한다 */
  | { status: "created"; id: string; failed: CreateStep[]; notOurs: boolean };

async function copyBody(newId: string, fromId: string): Promise<boolean> {
  const [fresh, source] = await Promise.all([ipc.customItemRead(newId), ipc.customItemRead(fromId)]);
  if (fresh.state !== "ok" || source.state !== "ok" || fresh.replaceText.state !== "text") return false;
  // 통째 바꿨거나 내가 만든 것은 내 글, 아니면 원본 글 (원본 + 덧붙임 · 값은 복사하지 않는다)
  const part = source.info.marks.includes("replace") || source.info.marks.includes("mine") ? source.replaceText : source.originText;
  if (part.state !== "text") return false;
  const text = copiedText(fresh.replaceText.text, part.text);
  if (text === null) return false;
  return (await ipc.customTextSave(newId, text)).outcome === "saved";
}

/**
 * 초안으로 항목을 만든다 — 스킬은 `customNew` → (복사), 에이전트는 `customNew` → (복사) → 보이는 이름 → 고양이.
 * `customNew` 가 안 되면 그 이유로 끝(아무것도 안 만들어졌다). 만들어진 뒤 단계는 하나가 실패해도 다음 단계를 해 보고, 실패한 것만 돌려준다.
 * `copyFrom` 은 복사할 항목 id (빈 틀이면 null), `staleLabel` 은 같은 이름의 옛 보이는 이름 줄이 파일에 남아 있다 (비우면 지운다).
 */
export async function createItem(draft: NewDraft, copyFrom: string | null, staleLabel: boolean): Promise<CreateResult> {
  const agent = draft.kind === "agent";
  const id = `${draft.kind}:${draft.name}`;
  let made;
  try {
    made = await ipc.customNew({
      kind: draft.kind,
      name: draft.name,
      description: draft.description.trim(),
      ...(agent ? { model: draft.model === "" ? null : draft.model, effort: draft.effort === "" ? null : draft.effort } : {}),
    });
  } catch (raw) {
    return { status: "error", kind: errorKind(raw) };
  }
  if (made.outcome === "refused") return { status: "refused", reason: made.reason };

  const failed: CreateStep[] = [];
  const attempt = async (step: CreateStep, run: () => Promise<boolean>) => {
    try {
      if (!(await run())) failed.push(step);
    } catch {
      failed.push(step);
    }
  };
  if (copyFrom !== null) await attempt("copy", () => copyBody(id, copyFrom));
  if (agent) {
    const label = draft.label.trim();
    if (label !== "") await attempt("label", async () => (await ipc.customLabelSave(draft.name, label)).outcome === "saved");
    else if (staleLabel) await attempt("label", async () => (await ipc.customLabelSave(draft.name, null)).outcome === "saved");
    if (draft.cat !== null) {
      const cat = draft.cat;
      await attempt("cat", async () => (await ipc.customCatsSave([{ agent: draft.name, cat }])).outcome === "saved");
    }
  }
  return { status: "created", id, failed, notOurs: made.notOurs };
}
