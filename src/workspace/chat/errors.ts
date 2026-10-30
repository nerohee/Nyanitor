// 채팅의 시작 · 보내기 · 답 보내기 오류 → 한 줄. 채팅에서 자주 만나는 것은 따로, 나머지는 작업 공간의 공통 문구.
import { t, type TextKey } from "../../i18n/ko";
import type { AppErrorKind } from "../../lib/ipc-types";
import { errorKind, errorText } from "../errors";

const CHAT_ERROR_TEXT: Partial<Record<AppErrorKind, TextKey>> = {
  claude_not_found: "ws.chat.err.claude_not_found",
  session_running: "ws.chat.err.session_running",
  no_session: "ws.chat.err.no_session",
  no_saved_session: "ws.chat.err.no_saved_session",
  request_not_found: "ws.chat.err.request_not_found",
  turn_in_progress: "ws.chat.err.turn_in_progress",
  project_folder_missing: "ws.chat.err.project_folder_missing",
  project_folder_forbidden: "ws.chat.err.project_folder_forbidden",
  project_not_found: "ws.chat.err.project_not_found",
};

export function chatErrorKindText(kind: AppErrorKind): string {
  const key = CHAT_ERROR_TEXT[kind];
  return key ? t(key) : errorText(kind);
}

export function chatErrorText(raw: unknown): string {
  return chatErrorKindText(errorKind(raw));
}
