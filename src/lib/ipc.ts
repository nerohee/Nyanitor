// 화면이 Rust 명령을 부르는 유일한 입구. 화면 코드는 `@tauri-apps/api/core` 를 직접 가져오지 않는다
// (eslint `no-restricted-imports` 로 막혀 있고 이 파일만 예외).
// Tauri 밖(브라우저, `npm run dev`)에서는 가짜 데이터를 돌려줘서 화면을 보고 시험할 수 있다.
import { invoke } from "@tauri-apps/api/core";

/** `src-tauri/src/error.rs` 의 `AppError::kind()` 와 같이 맞춘다. */
export type AppErrorKind = "invalid_input" | "internal";

export class AppError extends Error {
  readonly kind: AppErrorKind;

  constructor(kind: AppErrorKind, message: string) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
  }
}

export interface AppInfo {
  name: string;
  version: string;
}

function isAppErrorKind(value: unknown): value is AppErrorKind {
  return value === "invalid_input" || value === "internal";
}

/** invoke 가 거절한 값(`{ kind, message }`, 문자열, 그 밖)을 항상 `AppError` 로 바꾼다. */
export function toAppError(raw: unknown): AppError {
  if (raw instanceof AppError) {
    return raw;
  }
  if (typeof raw === "object" && raw !== null) {
    const { kind, message } = raw as { kind?: unknown; message?: unknown };
    if (isAppErrorKind(kind) && typeof message === "string") {
      return new AppError(kind, message);
    }
  }
  const message = raw instanceof Error ? raw.message : String(raw);
  return new AppError("internal", message);
}

// Tauri 가 창에 넣는 `__TAURI_INTERNALS__.invoke` 가 있으면 앱 안이다 (`mockIPC` 도 같은 자리에 넣는다).
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const internals = (window as { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function";
}

const fakeHandlers: Record<string, () => unknown> = {
  app_info: (): AppInfo => ({ name: "Nyanitor", version: "0.0.0-browser" }),
};

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri()) {
    const handler = fakeHandlers[command];
    if (!handler) {
      throw new AppError("internal", `no fake handler for command: ${command}`);
    }
    return handler() as T;
  }
  try {
    return await invoke<T>(command, args);
  } catch (raw) {
    throw toAppError(raw);
  }
}

export const ipc = {
  appInfo: () => call<AppInfo>("app_info"),
};
