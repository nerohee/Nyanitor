// Rust 와 화면이 같은 목록을 쓰는지 지키는 시험 (P3-03) — 한쪽만 늘면 여기서 실패한다.
// Rust 쪽 목록은 소스 파일 글을 읽어(`?raw`) 뽑는다. 읽는 모양이 바뀌면 이 시험이 먼저 "못 찾음" 으로 실패한다.
import errorRs from "../../src-tauri/src/error.rs?raw";
import eventsRs from "../../src-tauri/src/claude/events.rs?raw";
import { describe, expect, it } from "vitest";
import { isTextKey } from "../i18n/ko";
import {
  AppError,
  toAppError,
  type AlwaysScope,
  type AppErrorKind,
  type ClaudeEventType,
  type ClaudeResponse,
  type TurnOutcome,
} from "./ipc";

// 아래 `Record<…, true>` 는 TS 쪽에서 종류가 하나 늘면 컴파일(`tsc`)이 실패하게 하는 장치다.
const TS_ERROR_KINDS: Record<AppErrorKind, true> = {
  invalid_input: true,
  internal: true,
  claude_not_found: true,
  session_running: true,
  no_session: true,
  no_saved_session: true,
  request_not_found: true,
  turn_in_progress: true,
};

const TS_EVENT_TYPES: Record<ClaudeEventType, true> = {
  session_started: true,
  warning: true,
  user_message: true,
  turn_started: true,
  text: true,
  tool_use: true,
  tool_result: true,
  permission_request: true,
  question_request: true,
  request_cancelled: true,
  turn_ended: true,
  rate_limit: true,
  resume_not_found: true,
  session_ended: true,
  raw_log: true,
};

const TS_RESPONSE_KINDS: Record<ClaudeResponse["kind"], true> = {
  allow: true,
  always_allow: true,
  deny: true,
  tell: true,
  answer: true,
};

const TS_OUTCOMES: Record<TurnOutcome, true> = { success: true, interrupted: true, error: true, limit: true };
const TS_SCOPES: Record<AlwaysScope, true> = { suggested: true, folder: true, project: true };

const sorted = (values: Iterable<string>) => [...values].sort();

function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** `pub enum <name> {` 의 바로 아래(들여쓰기 4칸) 변형 이름들 */
function rustVariants(source: string, enumName: string): string[] {
  const start = source.indexOf(`pub enum ${enumName} {`);
  if (start < 0) throw new Error(`enum ${enumName} not found`);
  const rest = source.slice(start);
  const end = rest.indexOf("\n}");
  const body = rest.slice(0, end);
  const names = [...body.matchAll(/^ {4}([A-Z][A-Za-z0-9]*)/gm)].map((m) => m[1] as string);
  if (names.length === 0) throw new Error(`no variants in ${enumName}`);
  return names;
}

describe("Rust ↔ 화면 목록이 같다", () => {
  it("오류 종류: error.rs 의 kind() 와 ipc-types 의 AppErrorKind", () => {
    const body = errorRs.slice(errorRs.indexOf("pub fn kind(&self)"));
    const rustKinds = [...body.slice(0, body.indexOf("\n    }\n")).matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(rustKinds.length).toBeGreaterThan(5);
    expect(sorted(Object.keys(TS_ERROR_KINDS))).toEqual(sorted(rustKinds));
  });

  it("Rust 오류 종류마다 화면은 같은 종류의 AppError 로 받고(internal 로 뭉개지 않고) 문구가 있다", () => {
    const body = errorRs.slice(errorRs.indexOf("pub fn kind(&self)"));
    const rustKinds = [...body.slice(0, body.indexOf("\n    }\n")).matchAll(/=> "([a-z_]+)"/g)].map((m) => m[1] as string);
    for (const kind of rustKinds) {
      const error = toAppError({ kind, message: "m" });
      expect(error).toBeInstanceOf(AppError);
      expect(error.kind, kind).toBe(kind);
      expect(isTextKey(`error.${kind}`), `ko.ts 에 error.${kind} 문구가 없음`).toBe(true);
    }
  });

  it("이벤트 종류: events.rs 의 SessionEvent 와 ipc-types 의 ClaudeEvent", () => {
    const rustTypes = rustVariants(eventsRs, "SessionEvent").map(snake);
    expect(sorted(Object.keys(TS_EVENT_TYPES))).toEqual(sorted(rustTypes));
  });

  it("답 종류: events.rs 의 Response 와 ClaudeResponse", () => {
    expect(sorted(Object.keys(TS_RESPONSE_KINDS))).toEqual(sorted(rustVariants(eventsRs, "Response").map(snake)));
  });

  it("턴 결과 · 항상 허용 범위: Rust enum 과 같다", () => {
    expect(sorted(Object.keys(TS_OUTCOMES))).toEqual(sorted(rustVariants(eventsRs, "TurnOutcome").map(snake)));
    expect(sorted(Object.keys(TS_SCOPES))).toEqual(sorted(rustVariants(eventsRs, "AlwaysScope").map(snake)));
  });

  it("화면이 듣는 이벤트 이름은 commands.rs 와 같다", async () => {
    const commandsRs = (await import("../../src-tauri/src/claude/commands.rs?raw")).default;
    const { CLAUDE_SESSION_EVENT } = await import("./ipc");
    expect(commandsRs).toContain(`pub const SESSION_EVENT: &str = "${CLAUDE_SESSION_EVENT}";`);
  });

  it("화면이 부르는 명령 이름은 모두 Rust 에 등록돼 있다 (lib.rs 목록)", async () => {
    const libRs = (await import("../../src-tauri/src/lib.rs?raw")).default;
    const ipcTs = (await import("./ipc.ts?raw")).default;
    const called = [...ipcTs.matchAll(/call<[^>]*>\("([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(called.length).toBeGreaterThan(8);
    for (const command of called) {
      if (command === "app_info") continue;
      expect(libRs, `${command} 이 lib.rs 에 없음`).toContain(`claude::commands::${command}`);
    }
    // 반대로, Rust 에 등록된 Claude 명령은 화면이 모두 부른다 (안 쓰는 명령을 열어 두지 않는다)
    const registered = [...libRs.matchAll(/claude::commands::(claude_[a-z_]+)/g)].map((m) => m[1] as string);
    expect(sorted(registered)).toEqual(sorted(called.filter((c) => c !== "app_info")));
  });

  it("오류 · 이벤트가 아닌 모양(null · 숫자 · 종류만 있고 문구가 없는 객체)도 internal AppError 가 된다", () => {
    for (const raw of [null, undefined, 42, {}, { kind: "internal" }, { kind: "session_running" }, { message: "m" }]) {
      const error = toAppError(raw);
      expect(error).toBeInstanceOf(AppError);
      expect(error.kind).toBe("internal");
    }
    const same = new AppError("no_session", "x");
    expect(toAppError(same)).toBe(same);
    expect(toAppError(new Error("boom"))).toMatchObject({ kind: "internal", message: "boom" });
  });
});
