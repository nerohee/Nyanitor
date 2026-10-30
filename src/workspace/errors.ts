// IPC 오류 → 화면에 한 줄로 알릴 문구. 어느 경우에도 화면은 죽지 않는다.
import { t, type TextKey } from "../i18n/ko";
import { AppError, type AppErrorKind } from "../lib/ipc-types";

/** `ipc.ts` 는 언제나 `AppError` 를 던진다 — 그 밖의 값이 오면 `internal` 로 본다 */
export function errorKind(raw: unknown): AppErrorKind {
  return raw instanceof AppError ? raw.kind : "internal";
}

const ERROR_TEXT: Partial<Record<AppErrorKind, TextKey>> = {
  invalid_input: "ws.error.invalid_input",
  db_unavailable: "ws.error.db_unavailable",
  db_read_only: "ws.error.db_read_only",
  project_not_found: "ws.error.project_not_found",
  no_folder_picked: "ws.error.no_folder_picked",
  folder_dialog_open: "ws.error.folder_dialog_open",
  file_write_failed: "ws.error.file_write_failed",
  project_folder_missing: "ws.error.project_folder_missing",
  project_folder_forbidden: "ws.error.project_folder_forbidden",
};

export function errorText(kind: AppErrorKind): string {
  return t(ERROR_TEXT[kind] ?? "ws.error.other");
}
