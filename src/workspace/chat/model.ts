// 채팅 목록의 모양과 그것을 만드는 순수 함수들 — 기록(`ChatEntry`)과 실시간 이벤트(`ClaudeEvent`)를 같은 `ChatLine` 으로 접는다 (화면 없이 시험한다).
// 기록 + 실시간 잇기(`mergeLive`): 기록 끝과 겹치는 이벤트를 빼고 나머지를 뒤에 붙인다 (겹침 · 빠짐 없이).
import type {
  ChatEntry,
  ChatListEvent,
  ChatRequestState,
  ClaudeEvent,
  PermissionRequestInfo,
  QuestionRequestInfo,
} from "../../lib/ipc-types";

type Answered = Extract<ClaudeEvent, { type: "request_answered" }>;

/** 카드의 지금 상태 — 기록의 `request.status` 와 같은 뜻. 실시간 카드는 답을 받기 전까지 `pending` */
export interface CardState {
  status: "pending" | "answered" | "cancelled" | "expired";
  answer: Answered | null;
}

/** 권한 카드 — 기록에서 온 것은 도구 입력(`input`)이 없다 (D-48) */
export type PermissionView = Omit<PermissionRequestInfo, "input"> & { input?: unknown };

/** 채팅 알림 줄의 종류 — 경고(`warning`) 가운데 채팅에 보이는 것 · 한도 · 이어 할 대화 없음 · 먹물이 갑자기 멈춤 */
export type NoticeCode =
  | "api_key_in_use"
  | "planner_config"
  | "history_write_failed"
  | "rate_limit"
  | "resume_not_found"
  | "session_died";

export type ChatBody =
  | { kind: "user"; text: string; deferred: boolean; truncated: boolean }
  | { kind: "orch"; text: string; truncated: boolean }
  | { kind: "tool"; tool: string; summary: string }
  | { kind: "toolError"; summary: string; truncated: boolean }
  | { kind: "question"; info: QuestionRequestInfo; state: CardState }
  | { kind: "permission"; info: PermissionView; state: CardState }
  | { kind: "turnEnd"; outcome: "interrupted" | "error" | "limit"; detail: string | null }
  | { kind: "notice"; code: NoticeCode; detail: string | null; resetsAt: number | null; utilization: number | null; limitStatus: string | null };

export type ChatLine = { key: string } & ChatBody;

export type ChatLineKind = ChatLine["kind"];

/** 먹물이 멈춰 있는 이유 — 갑자기 멈춤(`died`) · 마지막 턴이 오류 · 한도 */
export type Halted = "died" | "error" | "limit" | null;

export interface ChatData {
  lines: ChatLine[];
  /** 실시간 줄의 다음 번호 */
  nextKey: number;
  /** 가장 최근 세션 시작 — 모델 · 수준 (앱이 다시 그려져도 기록에서 읽는다) */
  lastStart: { model: string | null; effort: string | null } | null;
  halted: Halted;
}

export const emptyChat = (): ChatData => ({ lines: [], nextKey: 1, lastStart: null, halted: null });

/** 채팅에 보이는 경고 코드 — 나머지 경고는 채팅에 보이지 않는다 */
const PLANNER_WARNINGS = new Set(["planner_config_missing", "planner_config_unreadable", "planner_model_unusable", "planner_effort_unusable"]);

const PENDING: CardState = { status: "pending", answer: null };

function cardState(request: ChatRequestState | null | undefined): CardState {
  return request ? { status: request.status, answer: request.answer } : PENDING;
}

interface Meta {
  /** 기록 항목 번호 (실시간이면 없다) */
  id?: number;
  truncated?: boolean;
  request?: ChatRequestState | null;
}

function noticeOf(code: NoticeCode, extra: Partial<Extract<ChatBody, { kind: "notice" }>> = {}): ChatBody {
  return { kind: "notice", code, detail: null, resetsAt: null, utilization: null, limitStatus: null, ...extra };
}

function withKey(data: ChatData, meta: Meta | undefined, line: ChatBody): { data: ChatData; line: ChatLine } {
  if (meta?.id !== undefined) return { data, line: { ...line, key: `h-${meta.id}` } as ChatLine };
  return { data: { ...data, nextKey: data.nextKey + 1 }, line: { ...line, key: `l-${data.nextKey}` } as ChatLine };
}

function push(data: ChatData, meta: Meta | undefined, line: ChatBody): ChatData {
  const made = withKey(data, meta, line);
  return { ...made.data, lines: [...made.data.lines, made.line] };
}

function setCard(data: ChatData, requestId: string, change: (state: CardState) => CardState): ChatData {
  let changed = false;
  const lines = data.lines.map((line) => {
    if ((line.kind !== "question" && line.kind !== "permission") || line.info.requestId !== requestId) return line;
    const next = change(line.state);
    if (next === line.state) return line;
    changed = true;
    return { ...line, state: next } as ChatLine;
  });
  return changed ? { ...data, lines } : data;
}

/** 이미 있는 카드를 새 이벤트로 고친다 — 같은 `requestId` 가 두 번 오면(다시 그릴 때 `pending` + 기록) 한 장으로 */
function upsertCard(data: ChatData, event: Extract<ClaudeEvent | ChatListEvent, { type: "permission_request" | "question_request" }>, meta: Meta | undefined): ChatData {
  const existing = data.lines.findIndex((line) => (line.kind === "question" || line.kind === "permission") && line.info.requestId === event.requestId);
  if (existing < 0) return push(data, meta, event.type === "question_request" ? { kind: "question", info: event, state: cardState(meta?.request) } : { kind: "permission", info: event, state: cardState(meta?.request) });
  const line = data.lines[existing];
  if (!line || (line.kind !== "question" && line.kind !== "permission")) return data;
  // 정보는 새것으로(실시간은 도구 입력이 있다). 상태는 더 나아간 쪽 — 답함 · 취소 · 지나감이 기다림을 이긴다
  const incoming = meta?.request ? cardState(meta.request) : null;
  const state = line.state.status !== "pending" ? line.state : (incoming ?? line.state);
  const replaced = event.type === "question_request" ? { ...line, kind: "question" as const, info: event, state } : { ...line, kind: "permission" as const, info: event, state };
  return { ...data, lines: data.lines.map((candidate, index) => (index === existing ? (replaced as ChatLine) : candidate)) };
}

/** 이벤트 하나를 목록에 접는다. 기록 항목이면 `meta` 에 번호 · 잘림 · 카드 상태가 온다 */
export function foldEvent(data: ChatData, event: ClaudeEvent | ChatListEvent, meta?: Meta): ChatData {
  const truncated = meta?.truncated ?? false;
  switch (event.type) {
    case "session_started":
      return { ...data, lastStart: { model: event.model, effort: event.effort }, halted: null };
    case "user_message":
      return push({ ...data, halted: null }, meta, { kind: "user", text: event.text, deferred: event.deferred, truncated });
    case "text":
      return push(data, meta, { kind: "orch", text: event.text, truncated });
    case "tool_use":
      return push(data, meta, { kind: "tool", tool: event.tool, summary: event.summary });
    case "tool_result":
      // 성공한 결과는 기록에도 없다 — 실패한 것만 한 줄
      return event.isError ? push(data, meta, { kind: "toolError", summary: event.summary, truncated }) : data;
    case "permission_request":
    case "question_request":
      return upsertCard(data, event, meta);
    case "request_answered":
      return setCard(data, event.requestId, (state) => (state.status === "answered" ? state : { status: "answered", answer: event }));
    case "request_cancelled":
      return setCard(data, event.requestId, (state) => (state.status === "pending" ? { status: "cancelled", answer: null } : state));
    case "turn_ended": {
      if (event.outcome === "success") return { ...data, halted: null };
      const halted: Halted = event.outcome === "interrupted" ? null : event.outcome;
      const detail = event.result?.trim() || event.errors[0]?.trim() || null;
      return push({ ...data, halted }, meta, { kind: "turnEnd", outcome: event.outcome, detail });
    }
    case "rate_limit":
      // 한도에 닿거나 가까워졌을 때만 (`allowed` 는 기록에도 없다)
      if (event.status === "allowed") return data;
      return push(
        data,
        meta,
        noticeOf("rate_limit", {
          resetsAt: event.resetsAt,
          limitStatus: event.status,
          utilization: event.rateLimitType === "seven_day" ? event.sevenDayUtilization : event.fiveHourUtilization,
          detail: event.rateLimitType,
        }),
      );
    case "resume_not_found":
      return push(data, meta, noticeOf("resume_not_found"));
    case "session_ended": {
      const ended: ChatData = { ...data, halted: event.ended === "died" ? "died" : null };
      // 끝난 세션이 기다리던 카드는 취소됨 — Rust 가 취소 이벤트를 먼저 주지만 못 받았어도 남지 않게
      const cleaned = { ...ended, lines: ended.lines.map((line) => ((line.kind === "question" || line.kind === "permission") && line.state.status === "pending" && meta?.id === undefined ? ({ ...line, state: { status: "cancelled", answer: null } } as ChatLine) : line)) };
      return event.ended === "died" ? push(cleaned, meta, noticeOf("session_died", { detail: event.stderrTail.join("\n") || null })) : cleaned;
    }
    case "warning":
      if (event.code === "api_key_in_use") return push(data, meta, noticeOf("api_key_in_use"));
      if (PLANNER_WARNINGS.has(event.code)) return push(data, meta, noticeOf("planner_config", { detail: event.code }));
      if (event.code === "history_write_failed") return push(data, meta, noticeOf("history_write_failed", { detail: event.detail }));
      return data;
    default:
      // turn_started · raw_log — 채팅에 보이지 않는다
      return data;
  }
}

/** 기록 한 쪽(오래된 것이 앞) → 목록 */
export function fromEntries(entries: readonly ChatEntry[]): ChatData {
  let data = emptyChat();
  for (const entry of entries) data = foldEvent(data, entry.event, { id: entry.id, truncated: entry.truncated, request: entry.request });
  return data;
}

/** 이전 쪽을 앞에 붙인다. 지금 목록의 `lastStart` · `halted` 가 우선 (더 최근) */
export function prependEntries(data: ChatData, entries: readonly ChatEntry[]): ChatData {
  const older = fromEntries(entries);
  const have = new Set(data.lines.map((line) => line.key));
  return { ...data, lines: [...older.lines.filter((line) => !have.has(line.key)), ...data.lines], lastStart: data.lastStart ?? older.lastStart };
}

// ───────────────────────── 기록 + 실시간 잇기 ─────────────────────────

/** 기록에 저장되는 이벤트인가 (`ChatListEventType` · 성공한 `tool_result` 와 `allowed` 인 `rate_limit` 은 저장하지 않는다) */
export function isStoredEvent(event: ClaudeEvent): boolean {
  switch (event.type) {
    case "session_started":
    case "user_message":
    case "text":
    case "tool_use":
    case "permission_request":
    case "question_request":
    case "turn_ended":
    case "resume_not_found":
    case "session_ended":
      return true;
    case "tool_result":
      return event.isError;
    case "rate_limit":
      return event.status !== "allowed";
    default:
      return false;
  }
}

/** 이벤트의 "같음" 표시 — 기록의 긴 글은 잘려 있고(끝에 `…`) 권한 카드에는 도구 입력이 없어서, 알아볼 수 있는 값만 비교한다 */
function signature(event: ClaudeEvent | ChatListEvent): string {
  switch (event.type) {
    case "session_started":
      return `session_started:${event.pid}:${event.resumed}`;
    case "user_message":
      return `user_message:${event.deferred}`;
    case "text":
      return "text";
    case "tool_use":
    case "tool_result":
      return `${event.type}:${event.toolUseId}`;
    case "permission_request":
    case "question_request":
      return `${event.type}:${event.requestId}`;
    case "turn_ended":
      return `turn_ended:${event.outcome}:${event.totalCostUsd}`;
    case "rate_limit":
      return `rate_limit:${event.resetsAt ?? ""}:${event.status ?? ""}`;
    case "resume_not_found":
      return `resume_not_found:${event.sessionId}`;
    case "session_ended":
      return `session_ended:${event.ended}:${event.exitCode ?? ""}:${event.midTurn}`;
    default:
      return event.type;
  }
}

function sameText(stored: string, live: string): boolean {
  if (stored === live) return true;
  // 저장은 긴 글을 잘라 끝에 `…` 을 붙인다
  return stored.endsWith("…") && live.startsWith(stored.slice(0, -1));
}

function sameEvent(stored: ChatListEvent, live: ClaudeEvent): boolean {
  if (signature(stored) !== signature(live)) return false;
  if ((stored.type === "text" || stored.type === "user_message") && (live.type === "text" || live.type === "user_message")) return sameText(stored.text, live.text);
  return true;
}

/**
 * 읽는 동안 모아 둔 실시간 이벤트(`buffer`)에서 기록 끝(`entries`)과 겹치는 앞부분을 센다.
 * 기록에 저장되는 이벤트끼리만 비교한다. 겹치는 가장 긴 구간을 찾는다:
 *  - 기록의 마지막 `m` 개 = 모은 것의 처음 `m` 개 (모은 것이 짧거나 기록이 더 길 때)
 *  - 기록 전부 = 모은 것의 `m - 기록 수` 번째부터 `m` 개 (모은 것이 기록보다 길 때)
 * 돌려주는 값은 "모은 것(저장되는 것만) 가운데 이미 기록에 있는 개수".
 */
export function overlapCount(entries: readonly ChatEntry[], stored: readonly ClaudeEvent[]): number {
  const history = entries.map((entry) => entry.event);
  if (history.length === 0) return 0;
  for (let m = stored.length; m > 0; m -= 1) {
    const length = Math.min(m, history.length);
    let all = true;
    for (let i = 0; i < length; i += 1) {
      const a = history[history.length - length + i];
      const b = stored[m - length + i];
      if (!a || !b || !sameEvent(a, b)) {
        all = false;
        break;
      }
    }
    if (all) return m;
  }
  return 0;
}

/**
 * 기록(`data`, 이미 접은 것)에 읽는 동안 모은 이벤트를 잇는다.
 * 기록과 겹친 이벤트는 건너뛰되, 답 · 취소 · 경고는 그 자리 목록에 반영한다 (카드 상태가 어긋나지 않게).
 */
export function mergeLive(data: ChatData, entries: readonly ChatEntry[], buffer: readonly ClaudeEvent[]): ChatData {
  const stored = buffer.filter(isStoredEvent);
  let skip = overlapCount(entries, stored);
  let next = data;
  for (const event of buffer) {
    if (isStoredEvent(event)) {
      if (skip > 0) {
        skip -= 1;
        // 기록에 있는 카드는 정보(도구 입력)만 새것으로
        if (event.type === "permission_request" || event.type === "question_request") next = foldEvent(next, event);
        continue;
      }
    }
    next = foldEvent(next, event);
  }
  return next;
}

/** 목록에서 답을 기다리는 카드 수 */
export function pendingCount(lines: readonly ChatLine[]): number {
  return lines.filter((line) => (line.kind === "question" || line.kind === "permission") && line.state.status === "pending").length;
}
