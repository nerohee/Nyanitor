// 세션 상태 저장소 — 앱 전체에 하나. Claude 이벤트(`ipc.onClaudeEvent`)는 앱이 켜질 때 한 번만 듣는다(`startSessionStore`, `App.tsx` 가 부른다) —
// 화면(작업 공간 ↔ 고양이 집 · 프로젝트 바꾸기)을 오가도 끊기지 않고, 세션은 그동안에도 돌고 대화 · 기다리는 카드가 그대로 쌓인다.
// 세션은 한 번에 하나 (D-12): `session` 이 돌고 있는 그 하나이고, 대화 목록은 프로젝트마다(`chats`) 있다.
// 기록 + 실시간 잇기: 목록을 읽기 전(`load` 가 `ready` 가 아닐 때)에 온 이벤트는 `buffer` 에 모아 두었다가, 읽은 뒤 `mergeLive` 가 기록 끝과 겹치는 것을 빼고 잇는다.
import { create } from "zustand";
import { ipc } from "../../lib/ipc";
import { AppError, type AppErrorKind, type ClaudeEvent, type ClaudeResponse, type ClaudeSessionState, type RawLogEntry, type StartInfo, type TrustCheck } from "../../lib/ipc-types";
import type { WaitingAsker } from "../progress/placement";
import { applyWorkerEvent, mergeHistoryWorkers, stopAllWorkers, type WorkerEntry } from "../progress/workers";
import { emptyChat, foldEvent, fromEntries, mergeLive, prependEntries, settleWorkers, type ChatData } from "./model";

/** 기록을 한 번에 읽는 개수 */
export const PAGE_SIZE = 50;
/** 읽기 전에 모아 두는 이벤트의 상한 (넘으면 오래된 것부터 버린다) */
const BUFFER_MAX = 2000;
/** 원본 출력(`raw_log`)을 메모리에 쥐는 줄 수 — 지금 세션 것만, 저장하지 않는다 (D-48). 넘으면 오래된 것부터 버린다 */
export const RAW_LINES_MAX = 1000;

export type LoadState = "idle" | "loading" | "ready" | "failed";

export interface ProjectChat {
  load: LoadState;
  loadError: AppErrorKind | null;
  data: ChatData;
  /** 읽는 동안(읽기 전부터) 온 실시간 이벤트 — 읽은 뒤 기록과 이어 붙이고 비운다 */
  buffer: ClaudeEvent[];
  /** `buffer` 의 이벤트를 받은 때 (같은 순서, 유닉스 밀리초) — 요약 로그의 시각 */
  bufferAt: number[];
  /** 이 프로젝트의 작업자 (시작 순) — 세션 상태 · 실시간 · 기록에서 하나로 합친 것. 고르는 함수는 `progress/workers.ts` */
  workers: WorkerEntry[];
  /** 이 쪽보다 오래된 기록이 더 있다 */
  hasMore: boolean;
  /** 가진 기록 가운데 가장 오래된 항목의 번호 (다음 쪽의 `before`) */
  oldestId: number | null;
  loadingOlder: boolean;
  olderFailed: boolean;
  /** 이어 할 대화가 있나 — `null` 은 아직 모른다 */
  resumable: boolean | null;
}

/** 지금 돌고 있는 세션 (하나) */
export interface LiveSession {
  projectId: number;
  /** 턴이 도는 중 */
  busy: boolean;
  sessionId: string | null;
}

export interface SessionChurros {
  projectId: number;
  /** 세션 츄르 "약 n" */
  totalTokens: number;
  /** 비용을 "참고용 추정" 으로 보인다 (구독) */
  referenceOnly: boolean;
}

interface QueuedMessage {
  projectId: number;
  text: string;
}

/** 폴더 설정 확인 (D-54) — 세션을 시작하려는데 `trust_required` 라 확인 화면을 띄운 동안의 상태 */
export interface TrustAsk {
  projectId: number;
  /** `loading`: 내용을 읽는 중 · `ready`: 보이는 중 · `granting`: 믿는다고 적는 중 */
  stage: "loading" | "ready" | "granting";
  /** 보이는 내용 (`loading` 의 처음에는 없다) */
  check: TrustCheck | null;
  /** 보는 사이 폴더 설정이 바뀌어 내용을 다시 읽었다 */
  changed: boolean;
}

/** 사용자가 확인 화면에서 취소했다 — 오류가 아니라서 화면은 아무것도 알리지 않는다 (`isTrustDeclined`) */
export class TrustDeclined extends Error {
  constructor() {
    super("the user declined to trust the project folder settings");
    this.name = "TrustDeclined";
  }
}

export const isTrustDeclined = (raw: unknown): boolean => raw instanceof TrustDeclined;

interface State {
  /** 폴더 설정 확인 화면 — 없으면 null (한 번에 하나) */
  trustAsk: TrustAsk | null;
  /** 처음 상태(`claudeSessionState`)를 읽었다 */
  restored: boolean;
  session: LiveSession | null;
  chats: Record<number, ProjectChat>;
  churros: SessionChurros | null;
  /** 츄르를 마지막으로 못 읽었다 (지난 숫자를 그대로 보인다) */
  churrosStale: boolean;
  /** 일하는 중에 보낸 말 — 이번 턴이 끝나면 전해진다 (Rust 는 턴이 도는 중의 보내기를 받지 않는다) */
  queued: QueuedMessage | null;
  queueError: AppErrorKind | null;
  /** 지금(또는 마지막) 세션의 원본 출력 줄 — 최근 `RAW_LINES_MAX` 줄, 프로젝트를 바꾸거나 새 세션이 시작하면 비운다 */
  raw: { projectId: number; lines: RawLogEntry[] } | null;
  /** 세션이 끝나 못 보낸 말 — 입력줄이 되돌려 받는다 */
  draftBack: QueuedMessage | null;
  /** 먹물이 답을 끝낸(성공한) 턴 수 — 화면 읽기 프로그램에 "답했어요" 를 알리는 신호 (실시간만, 기록 읽기로는 오르지 않는다) */
  answeredTurns: number;
}

const initial = (): State => ({ trustAsk: null, restored: false, session: null, chats: {}, churros: null, churrosStale: false, queued: null, queueError: null, raw: null, draftBack: null, answeredTurns: 0 });

export const useSessionStore = create<State>()(() => initial());

const get = () => useSessionStore.getState();
const set = (partial: Partial<State> | ((state: State) => Partial<State>)) => useSessionStore.setState(partial);

export const newChat = (): ProjectChat => ({
  load: "idle",
  loadError: null,
  data: emptyChat(),
  buffer: [],
  bufferAt: [],
  workers: [],
  hasMore: false,
  oldestId: null,
  loadingOlder: false,
  olderFailed: false,
  resumable: null,
});

function patchChat(projectId: number, change: Partial<ProjectChat> | ((chat: ProjectChat) => Partial<ProjectChat>)): void {
  set((state) => {
    const chat = state.chats[projectId] ?? newChat();
    const next = typeof change === "function" ? change(chat) : change;
    return { chats: { ...state.chats, [projectId]: { ...chat, ...next } } };
  });
}

const kindOf = (raw: unknown): AppErrorKind => (raw instanceof AppError ? raw.kind : "internal");

// ───────────────────────── 이벤트 ─────────────────────────

/** 이 이벤트를 그 프로젝트 대화에 넣는다 — 목록을 읽었으면 바로 접고, 아니면 모아 둔다 */
function feed(projectId: number, event: ClaudeEvent): void {
  const atMs = Date.now();
  patchChat(projectId, (chat) => {
    if (chat.load === "ready") return { data: foldEvent(chat.data, event, { atMs }) };
    return { buffer: [...chat.buffer, event].slice(-BUFFER_MAX), bufferAt: [...chat.bufferAt, atMs].slice(-BUFFER_MAX) };
  });
}

/** 작업자 목록에 이 이벤트를 반영한다 — 대화를 읽었는지와 상관없이 바로 (진행 탭이 쓴다) */
function feedWorkers(projectId: number, event: ClaudeEvent): void {
  if (event.type === "worker_started" || event.type === "worker_activity" || event.type === "worker_ended") patchChat(projectId, (chat) => ({ workers: applyWorkerEvent(chat.workers, event) }));
  // 새 세션이 시작하면 옛 세션의 남은 작업자는 끝난 것, 세션이 끝나도 (Rust 가 먼저 주지만 못 받았어도)
  else if (event.type === "session_started" || event.type === "session_ended") patchChat(projectId, (chat) => ({ workers: stopAllWorkers(chat.workers, Date.now()) }));
}

/** 원본 출력 한 줄 — 지금 세션 것만 최근 `RAW_LINES_MAX` 줄 */
function feedRaw(projectId: number, event: Extract<ClaudeEvent, { type: "raw_log" }>): void {
  const entry: RawLogEntry = { seq: event.seq, dir: event.dir, text: event.text, truncated: event.truncated, originalLen: event.originalLen, atMs: event.atMs };
  set((state) => {
    const lines = state.raw && state.raw.projectId === projectId ? state.raw.lines : [];
    return { raw: { projectId, lines: [...lines, entry].slice(-RAW_LINES_MAX) } };
  });
}

let churrosSeq = 0;

/** 세션 츄르를 다시 읽는다 — 턴이 끝날 때마다. 못 읽으면 지난 숫자를 그대로 두고 표시만 */
export async function refreshChurros(): Promise<void> {
  const seq = ++churrosSeq;
  try {
    const summary = await ipc.appUsageSummary();
    if (seq !== churrosSeq) return;
    set({
      churros: summary.session ? { projectId: summary.session.projectId, totalTokens: summary.session.usage.totalTokens, referenceOnly: summary.session.usage.referenceOnly } : null,
      churrosStale: false,
    });
  } catch {
    if (seq === churrosSeq) set({ churrosStale: true });
  }
}

function apply(event: ClaudeEvent): void {
  let session = get().session;
  if (event.type === "session_started") session = { projectId: event.projectId, busy: false, sessionId: event.resumeSessionId };
  // 어느 프로젝트 세션인지 모르는 이벤트는 둘 곳이 없다
  if (!session) return;
  const projectId = session.projectId;
  if (event.type === "raw_log") {
    feedRaw(projectId, event);
    return;
  }
  feed(projectId, event);
  feedWorkers(projectId, event);

  switch (event.type) {
    case "session_started":
      set({ session, queueError: null, raw: { projectId, lines: [] } });
      void refreshChurros();
      break;
    case "turn_started":
      set({ session: { ...session, busy: true, sessionId: event.sessionId } });
      break;
    case "user_message":
      set({ session: { ...session, busy: true } });
      break;
    case "turn_ended":
      set({ session: { ...session, busy: false }, answeredTurns: event.outcome === "success" ? get().answeredTurns + 1 : get().answeredTurns });
      void refreshChurros();
      // 일하는 중에 보낸 말은 이번 턴이 끝난 뒤 (같은 턴 끝에 Rust 가 다르게 말하기를 먼저 보낼 수 있어 한 박자 뒤)
      setTimeout(() => void flushQueued(), 0);
      break;
    case "session_ended": {
      const queued = get().queued;
      set({ session: null, churros: null, queued: null, draftBack: queued ?? get().draftBack });
      patchChat(projectId, { resumable: true });
      break;
    }
    default:
      break;
  }
}

async function flushQueued(): Promise<void> {
  const { queued, session } = get();
  if (!queued || !session || session.projectId !== queued.projectId || session.busy) return;
  set({ queued: null, queueError: null });
  try {
    await ipc.claudeSessionSend(queued.text);
  } catch (raw) {
    // 아직 턴이 돌고 있다면 다음 턴 끝에 다시 — 그 밖의 실패는 말을 남기고 알린다
    const kind = kindOf(raw);
    set({ queued: get().queued ?? queued, queueError: kind === "turn_in_progress" ? null : kind });
  }
}

// ───────────────────────── 시작 · 끝 ─────────────────────────

let unlisten: (() => void) | null = null;
let starting: Promise<void> | null = null;
let early: ClaudeEvent[] = [];

function restore(state: ClaudeSessionState): void {
  if (!state.running || state.projectId === null) return;
  set({ session: { projectId: state.projectId, busy: state.busy, sessionId: state.sessionId } });
  // 기다리던 카드 — 기록에도 `pending` 으로 있다 (읽은 뒤 같은 `requestId` 는 한 장으로 합쳐진다)
  for (const event of state.pending) feed(state.projectId, event);
  // 지금 일하는 작업자 — 채팅 줄 · 작업자 목록 둘 다 (기록에도 있다: 읽은 뒤 `toolUseId` 가 같은 것은 하나로 합쳐진다)
  for (const event of state.workers ?? []) {
    feed(state.projectId, event);
    feedWorkers(state.projectId, event);
  }
  void refreshChurros();
}

/** 앱이 켜질 때 한 번 — 이벤트 듣기를 시작하고 지금 세션 상태를 읽는다. 여러 번 불러도 한 번만 한다 */
export function startSessionStore(): Promise<void> {
  starting ??= (async () => {
    try {
      unlisten = await ipc.onClaudeEvent((event) => {
        if (!get().restored) early.push(event);
        else apply(event);
      });
    } catch {
      // 듣지 못해도 명령은 쓸 수 있다 — 다음에 부를 때 다시 해 본다
      starting = null;
    }
    try {
      restore(await ipc.claudeSessionState());
    } catch {
      // 처음 상태를 못 읽으면 "세션 없음" 으로 시작
    }
    set({ restored: true });
    const waiting = early;
    early = [];
    for (const event of waiting) apply(event);
  })();
  return starting;
}

/** 시험용 — 듣기를 끊고 모든 상태를 처음으로 */
export function resetSessionStore(): void {
  unlisten?.();
  unlisten = null;
  starting = null;
  early = [];
  churrosSeq += 1;
  trustWaiter?.settle("declined");
  trustWaiter = null;
  useSessionStore.setState(initial(), true);
}

// ───────────────────────── 기록 ─────────────────────────

/** 그 프로젝트의 기록 마지막 쪽을 읽고, 읽는 동안 모은 이벤트를 이어 붙인다. 이미 읽었거나 읽는 중이면 아무것도 하지 않는다 */
export async function loadChat(projectId: number): Promise<void> {
  const chat = get().chats[projectId];
  if (chat && (chat.load === "ready" || chat.load === "loading")) return;
  patchChat(projectId, { load: "loading", loadError: null });
  try {
    const page = await ipc.projectChatHistory(projectId, null, PAGE_SIZE);
    const live = get().session?.projectId === projectId;
    patchChat(projectId, (now) => ({
      load: "ready",
      // 지금 세션이 없는데 기록이 "일하는 중" 이면 끝 알림을 못 받은 것 — 멈춤으로
      data: live ? mergeLive(fromEntries(page.entries), page.entries, now.buffer, now.bufferAt) : settleWorkers(mergeLive(fromEntries(page.entries), page.entries, now.buffer, now.bufferAt)),
      workers: mergeHistoryWorkers(now.workers, page.entries, live),
      buffer: [],
      bufferAt: [],
      hasMore: page.hasMore && page.entries.length > 0,
      oldestId: page.entries[0]?.id ?? null,
    }));
  } catch (raw) {
    patchChat(projectId, { load: "failed", loadError: kindOf(raw) });
  }
}

/** 이전 대화 한 쪽 더 */
export async function loadOlder(projectId: number): Promise<void> {
  const chat = get().chats[projectId];
  if (!chat || chat.load !== "ready" || chat.loadingOlder || !chat.hasMore || chat.oldestId === null) return;
  patchChat(projectId, { loadingOlder: true, olderFailed: false });
  try {
    const page = await ipc.projectChatHistory(projectId, chat.oldestId, PAGE_SIZE);
    const live = get().session?.projectId === projectId;
    patchChat(projectId, (now) => ({
      loadingOlder: false,
      data: live ? prependEntries(now.data, page.entries) : settleWorkers(prependEntries(now.data, page.entries)),
      workers: mergeHistoryWorkers(now.workers, page.entries, live),
      hasMore: page.hasMore && page.entries.length > 0,
      oldestId: page.entries[0]?.id ?? now.oldestId,
    }));
  } catch {
    patchChat(projectId, { loadingOlder: false, olderFailed: true });
  }
}

/** 이어 할 대화가 있는지 다시 본다 */
export async function refreshResumable(projectId: number): Promise<void> {
  try {
    const last = await ipc.claudeLastSession(projectId);
    patchChat(projectId, { resumable: last !== null });
  } catch {
    patchChat(projectId, { resumable: false });
  }
}

// ───────────────────────── 세션 조작 ─────────────────────────

// 폴더 설정 확인 (D-54) — 시작이 `trust_required` 로 거절되면 `trustAsk` 를 띄우고, 사용자가 믿거나(`grantTrust`) 취소할(`declineTrust`) 때까지 시작을 기다린다.
// 취소하면 `TrustDeclined` 로 시작이 끝나고, 다른 오류(읽기 · 적기 실패)는 그 오류로 끝난다 — 부른 쪽의 오류 표시가 그대로 받는다.

interface TrustWaiter {
  projectId: number;
  settle: (outcome: "granted" | "declined" | { error: unknown }) => void;
}

let trustWaiter: TrustWaiter | null = null;

const asking = (projectId: number): boolean => trustWaiter?.projectId === projectId && get().trustAsk?.projectId === projectId;

function finishTrust(outcome: "granted" | "declined" | { error: unknown }): void {
  const waiter = trustWaiter;
  trustWaiter = null;
  set({ trustAsk: null });
  waiter?.settle(outcome);
}

/** 폴더 설정을 (다시) 읽어 보인다. 그사이 이미 믿은 상태가 됐으면(`required: false`) 확인 없이 시작한다 */
async function readTrust(projectId: number, changed: boolean): Promise<void> {
  try {
    const check = await ipc.projectTrustCheck(projectId);
    if (!asking(projectId)) return;
    if (!check.required) finishTrust("granted");
    else set({ trustAsk: { projectId, stage: "ready", check, changed } });
  } catch (raw) {
    if (asking(projectId)) finishTrust({ error: raw });
  }
}

function askTrust(projectId: number): Promise<"granted" | "declined"> {
  trustWaiter?.settle("declined");
  return new Promise((resolve, reject) => {
    trustWaiter = {
      projectId,
      settle: (outcome) => (typeof outcome === "string" ? resolve(outcome) : reject(outcome.error)),
    };
    set({ trustAsk: { projectId, stage: "loading", check: null, changed: false } });
    void readTrust(projectId, false);
  });
}

/** 확인 화면의 「믿고 시작」 — 보여 준 내용(`hash`)을 믿는다고 적는다. 그사이 바뀌었으면(`trust_changed`) 새 내용을 다시 읽어 보인다 */
export async function grantTrust(): Promise<void> {
  const ask = get().trustAsk;
  if (!ask || ask.stage !== "ready" || !ask.check) return;
  const { projectId } = ask;
  set({ trustAsk: { ...ask, stage: "granting" } });
  try {
    await ipc.projectTrustGrant(projectId, ask.check.hash);
    if (asking(projectId)) finishTrust("granted");
  } catch (raw) {
    if (!asking(projectId)) return;
    if (kindOf(raw) === "trust_changed") {
      set({ trustAsk: { projectId, stage: "loading", check: ask.check, changed: true } });
      await readTrust(projectId, true);
    } else finishTrust({ error: raw });
  }
}

/** 확인 화면의 「취소」 · Esc — 시작하지 않는다 */
export function declineTrust(): void {
  if (get().trustAsk?.stage === "granting") return;
  finishTrust("declined");
}

/** 한 번 시작한다 — 폴더 설정을 확인해야 하면(`trust_required`) 확인을 받은 뒤 다시. 또 거절되면 그 오류 그대로 */
async function startOnce(projectId: number, resume: boolean): Promise<StartInfo> {
  try {
    return await ipc.claudeSessionStart({ projectId, resume });
  } catch (raw) {
    if (kindOf(raw) !== "trust_required") throw raw;
  }
  if ((await askTrust(projectId)) === "declined") throw new TrustDeclined();
  return ipc.claudeSessionStart({ projectId, resume });
}

/** 세션을 시작한다. 이어 하기(`resume`)가 안 되면(`no_saved_session`) 새 대화로 한 번 더 */
export async function startChat(projectId: number, resume: boolean): Promise<StartInfo> {
  let info: StartInfo;
  try {
    info = await startOnce(projectId, resume);
  } catch (raw) {
    if (!resume || kindOf(raw) !== "no_saved_session") throw raw;
    patchChat(projectId, { resumable: false });
    info = await startOnce(projectId, false);
  }
  // `session_started` 이벤트가 곧 같은 일을 한다 — 먼저 와 있으면 그대로
  if (!get().session) set({ session: { projectId, busy: false, sessionId: info.resumeSessionId } });
  return info;
}

/**
 * 말을 보낸다. 세션이 없으면 먼저 시작한다 (이어 할 대화가 있으면 이어 하기).
 * 일하는 중이면 보내지 않고 `queued` 에 두었다가 이번 턴이 끝나면 보낸다 — `"queued"` 를 돌려준다.
 */
export async function sendMessage(projectId: number, text: string, options: { fresh?: boolean } = {}): Promise<"sent" | "queued"> {
  const live = get().session;
  if (live && live.projectId !== projectId) throw new AppError("session_running", "a session is running in another project");
  if (!live) {
    let resumable = get().chats[projectId]?.resumable ?? null;
    if (resumable === null) {
      await refreshResumable(projectId);
      resumable = get().chats[projectId]?.resumable ?? false;
    }
    await startChat(projectId, resumable && !options.fresh);
  }
  if (get().session?.busy) {
    queueMessage(projectId, text);
    return "queued";
  }
  try {
    await ipc.claudeSessionSend(text);
    return "sent";
  } catch (raw) {
    if (kindOf(raw) !== "turn_in_progress") throw raw;
    queueMessage(projectId, text);
    return "queued";
  }
}

function queueMessage(projectId: number, text: string): void {
  set((state) => ({ queued: state.queued && state.queued.projectId === projectId ? { projectId, text: `${state.queued.text}\n\n${text}` } : { projectId, text }, queueError: null }));
}

/** 기다리는 말을 지운다 (입력줄이 글 칸으로 되돌려 받을 수 있게 돌려준다) */
export function cancelQueued(): QueuedMessage | null {
  const queued = get().queued;
  set({ queued: null, queueError: null });
  return queued;
}

export function takeDraftBack(projectId: number): string | null {
  const back = get().draftBack;
  if (!back || back.projectId !== projectId) return null;
  set({ draftBack: null });
  return back.text;
}

export function respond(requestId: string, response: ClaudeResponse): Promise<void> {
  return ipc.claudeSessionRespond(requestId, response);
}

export function interrupt(): Promise<void> {
  return ipc.claudeSessionInterrupt();
}

export async function stopSession(): Promise<void> {
  await ipc.claudeSessionStop();
}

// ───────────────────────── 읽기 도우미 ─────────────────────────

const NO_WORKERS: WorkerEntry[] = [];
const NO_RAW: RawLogEntry[] = [];

/** 그 프로젝트의 작업자 목록 (시작 순) — 바뀌지 않으면 같은 배열이라 `useSessionStore` 에 바로 쓴다. 지금 일하는 것 · 최근 것은 `progress/workers.ts` 의 `workingWorkers` · `recentWorkers` 로 (`useMemo` 와 함께) */
export function selectWorkers(projectId: number | null) {
  return (state: State): WorkerEntry[] => (projectId === null ? NO_WORKERS : (state.chats[projectId]?.workers ?? NO_WORKERS));
}

/** 작업자를 부른 도구 호출 번호(`toolUseId`)로 그 작업자의 이름 (어느 프로젝트든) — 없으면 null. 카드가 "누구의 요청인가" 를 찾는다 */
export function selectWorkerName(toolUseId: string | null) {
  return (state: State): string | null => {
    if (toolUseId === null) return null;
    for (const chat of Object.values(state.chats)) {
      const found = chat.workers.find((worker) => worker.toolUseId === toolUseId);
      if (found) return found.name;
    }
    return null;
  };
}

/** 그 프로젝트의 원본 출력 줄 (최근 `RAW_LINES_MAX` 줄, 오래된 것이 앞). 다른 프로젝트의 줄은 보이지 않는다 */
export function selectRawLines(projectId: number | null) {
  return (state: State): RawLogEntry[] => (projectId !== null && state.raw?.projectId === projectId ? state.raw.lines : NO_RAW);
}

/** 그 프로젝트에서 답을 기다리는 카드 수 (아직 읽지 않은 대화는 모아 둔 이벤트로 센다) */
export function selectPending(projectId: number | null) {
  return (state: State): number => {
    if (projectId === null) return 0;
    const chat = state.chats[projectId];
    if (!chat) return 0;
    let n = 0;
    for (const line of chat.data.lines) if ((line.kind === "question" || line.kind === "permission") && line.state.status === "pending") n += 1;
    const waiting = new Set<string>();
    for (const event of chat.buffer) {
      if (event.type === "permission_request" || event.type === "question_request") waiting.add(event.requestId);
      else if (event.type === "request_answered" || event.type === "request_cancelled") waiting.delete(event.requestId);
      else if (event.type === "session_ended") waiting.clear();
    }
    return n + waiting.size;
  };
}

/** 맨 앞 기다리는 카드를 보낸 이 — `worker` 는 작업자 이름(먹물 쪽 카드면 `null`), `sinceMs` 는 그 카드가 생긴 때(모르면 `null`) */
export interface WaitingCard extends WaitingAsker {
  sinceMs: number | null;
}

const lastWaiting = new Map<number, WaitingCard | null>();

/** 그 프로젝트의 맨 앞(가장 먼저 온) 기다리는 카드를 보낸 이 — 카드가 없으면 `null`. `selectPending` 과 같은 범위(목록 · 아직 읽지 않은 이벤트).
 *  작업자 이름은 `toolUseId` 로 그 프로젝트의 작업자 목록에서 찾고(`selectWorkerName` 과 같게), 없으면 요청의 `worker.name`, 그것도 없으면 먹물 쪽으로 본다.
 *  값이 같으면 같은 객체를 돌려줘 `useSessionStore` 에 바로 쓴다 */
export function selectWaitingAsker(projectId: number | null) {
  return (state: State): WaitingCard | null => {
    const chat = projectId === null ? undefined : state.chats[projectId];
    let found: WaitingCard | null = null;
    if (projectId !== null && chat) {
      const nameOf = (ref: { toolUseId: string | null; name: string | null } | null | undefined): string | null => {
        if (!ref) return null;
        const listed = ref.toolUseId === null ? undefined : chat.workers.find((worker) => worker.toolUseId === ref.toolUseId);
        return listed?.name ?? ref.name ?? null;
      };
      const card = chat.data.lines.find((line) => (line.kind === "question" || line.kind === "permission") && line.state.status === "pending");
      if (card && (card.kind === "question" || card.kind === "permission")) {
        found = { worker: nameOf(card.info.worker), sinceMs: card.atMs ?? null };
      } else {
        const open = new Map<string, { worker: string | null; sinceMs: number | null }>();
        chat.buffer.forEach((event, index) => {
          if (event.type === "permission_request" || event.type === "question_request") open.set(event.requestId, { worker: nameOf(event.worker), sinceMs: chat.bufferAt[index] ?? null });
          else if (event.type === "request_answered" || event.type === "request_cancelled") open.delete(event.requestId);
          else if (event.type === "session_ended") open.clear();
        });
        const first = open.values().next();
        if (!first.done) found = first.value;
      }
    }
    if (projectId === null) return found;
    const before = lastWaiting.get(projectId) ?? null;
    if (before === found || (before && found && before.worker === found.worker && before.sinceMs === found.sinceMs)) return before;
    lastWaiting.set(projectId, found);
    return found;
  };
}
