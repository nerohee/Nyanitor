// 시험 화면의 상태 — 세션 이벤트를 받아 목록 · 카드 · 원본 로그로 접는 순수 함수 (화면 없이 시험한다).
import type {
  ClaudeEvent,
  ClaudeSessionState,
  PermissionRequestInfo,
  QuestionRequestInfo,
  RawLogEntry,
} from "../lib/ipc";
import { describeEvent } from "./describe";

export type LabCard =
  | { kind: "permission"; info: PermissionRequestInfo }
  | { kind: "question"; info: QuestionRequestInfo };

export interface LabLine {
  id: number;
  type: ClaudeEvent["type"];
  text: string;
}

export interface LabState {
  running: boolean;
  /** 턴이 도는 중 */
  busy: boolean;
  sessionId: string | null;
  projectDir: string | null;
  lines: LabLine[];
  cards: LabCard[];
  raw: RawLogEntry[];
  /** 이어 하려던 세션이 없어 새로 시작할지 묻는 중 */
  resumeNotFound: string | null;
  nextLineId: number;
}

export type LabAction =
  | { type: "event"; event: ClaudeEvent }
  | { type: "restore"; state: ClaudeSessionState }
  | { type: "raw"; entries: RawLogEntry[] }
  | { type: "cardAnswered"; requestId: string }
  | { type: "dismissResumeNotFound" };

export const MAX_LINES = 400;
export const MAX_RAW = 300;

export const initialLabState: LabState = {
  running: false,
  busy: false,
  sessionId: null,
  projectDir: null,
  lines: [],
  cards: [],
  raw: [],
  resumeNotFound: null,
  nextLineId: 1,
};

function cardId(card: LabCard): string {
  return card.info.requestId;
}

function pushCard(cards: LabCard[], card: LabCard): LabCard[] {
  return [...cards.filter((existing) => cardId(existing) !== cardId(card)), card];
}

function withLine(state: LabState, event: ClaudeEvent): LabState {
  const text = describeEvent(event);
  if (text === null) return state;
  const line: LabLine = { id: state.nextLineId, type: event.type, text };
  return { ...state, lines: [...state.lines, line].slice(-MAX_LINES), nextLineId: state.nextLineId + 1 };
}

function applyEvent(state: LabState, event: ClaudeEvent): LabState {
  switch (event.type) {
    case "raw_log":
      return { ...state, raw: [...state.raw.filter((r) => r.seq !== event.seq), event].slice(-MAX_RAW) };
    case "session_started":
      return withLine({ ...state, running: true, busy: false, projectDir: event.projectDir, cards: [], resumeNotFound: null, raw: [] }, event);
    case "turn_started":
      return withLine({ ...state, busy: true, sessionId: event.sessionId }, event);
    case "user_message":
      return withLine({ ...state, busy: true }, event);
    case "permission_request":
      return withLine({ ...state, cards: pushCard(state.cards, { kind: "permission", info: event }) }, event);
    case "question_request":
      return withLine({ ...state, cards: pushCard(state.cards, { kind: "question", info: event }) }, event);
    case "request_cancelled":
      return withLine({ ...state, cards: state.cards.filter((card) => cardId(card) !== event.requestId) }, event);
    case "turn_ended":
      return withLine({ ...state, busy: false }, event);
    case "resume_not_found":
      return withLine({ ...state, resumeNotFound: event.sessionId }, event);
    case "session_ended":
      return withLine({ ...state, running: false, busy: false, cards: [] }, event);
    default:
      return withLine(state, event);
  }
}

export function labReducer(state: LabState, action: LabAction): LabState {
  switch (action.type) {
    case "event":
      return applyEvent(state, action.event);
    case "restore": {
      const { running, busy, sessionId, projectDir, pending } = action.state;
      let next: LabState = { ...state, running, busy, sessionId, projectDir, cards: [] };
      for (const event of pending) {
        if (event.type === "permission_request") {
          next = { ...next, cards: pushCard(next.cards, { kind: "permission", info: event }) };
        } else if (event.type === "question_request") {
          next = { ...next, cards: pushCard(next.cards, { kind: "question", info: event }) };
        }
      }
      return next;
    }
    case "raw":
      return { ...state, raw: action.entries.slice(-MAX_RAW) };
    case "cardAnswered":
      return { ...state, cards: state.cards.filter((card) => cardId(card) !== action.requestId) };
    case "dismissResumeNotFound":
      return { ...state, resumeNotFound: null };
  }
}
