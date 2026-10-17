// 브라우저(`npm run dev`)에서 시험 화면이 돌도록 하는 가짜 Claude 세션. Tauri 밖에서만 `ipc.ts` 가 쓴다.
// 진짜 세션 관리자(`src-tauri/src/claude/`)와 같은 명령 · 이벤트 모양을 흉내 내고 몇 가지 정해진 대본만 돈다:
//  · 보낸 말에 "쓰기" 가 있으면 파일 쓰기 권한 요청 · "질문" 이 있으면 질문 카드 · 그 밖에는 명령 권한 요청
//  · 허용 / 항상 허용 / 거부 / 다르게 말하기 / 질문 답 / 중단 / 끝내기 / 이어 하기
// 문구는 `ko.ts` 의 `lab.fake.*` (D-08).
import { t } from "../i18n/ko";
import {
  AppError,
  type ClaudeEvent,
  type ClaudeResponse,
  type ClaudeSessionState,
  type ClaudeStatus,
  type PermissionRequestInfo,
  type QuestionRequestInfo,
  type RawLogEntry,
  type StartInfo,
  type StartRequest,
  type StopInfo,
  type TurnSummary,
} from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

interface PendingFake {
  info: PermissionRequestInfo | QuestionRequestInfo;
}

const EMPTY_USAGE = { inputTokens: 3, outputTokens: 42, cacheCreationInputTokens: 0, cacheReadInputTokens: 1200 };

function turnSummary(outcome: TurnSummary["outcome"], total: number): TurnSummary {
  return {
    outcome,
    subtype: outcome === "success" ? "success" : "error_during_execution",
    isError: outcome !== "success",
    terminalReason: outcome === "success" ? "completed" : "aborted_tools",
    result: outcome === "success" ? t("lab.fake.done") : null,
    errors: [],
    apiErrorStatus: null,
    durationMs: 1200,
    numTurns: 2,
    usage: EMPTY_USAGE,
    costUsd: 0.0021,
    totalCostUsd: total,
  };
}

export function createFakeClaude() {
  const listeners = new Set<(event: ClaudeEvent) => void>();
  const lastSessions = new Map<string, string>();
  const rawLog: RawLogEntry[] = [];
  let session: { projectDir: string; sessionId: string; busy: boolean; turns: number } | null = null;
  const pending = new Map<string, PendingFake>();
  let counter = 0;

  const emit = (event: ClaudeEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const later = (fn: () => void, ms = 5) => {
    setTimeout(fn, ms);
  };
  const log = (dir: RawLogEntry["dir"], text: string) => {
    const entry: RawLogEntry = { seq: rawLog.length, dir, text, truncated: false, originalLen: text.length, atMs: rawLog.length * 10 };
    rawLog.push(entry);
    emit({ type: "raw_log", ...entry });
  };
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  const requireSession = () => {
    if (!session) throw new AppError("no_session", "no session is running");
    return session;
  };

  function beginTurn(text: string, deferred: boolean) {
    const current = requireSession();
    current.busy = true;
    current.turns += 1;
    emit({ type: "user_message", text, deferred });
    log("send", JSON.stringify({ type: "user", message: { role: "user", content: text } }));
    later(() => {
      if (!session) return;
      lastSessions.set(session.projectDir, session.sessionId);
      emit({ type: "turn_started", sessionId: session.sessionId, model: "fake-haiku", cliVersion: "2.1.296", permissionMode: "default", apiKeySource: "none" });
      emit({ type: "text", text: t("lab.fake.greeting") });
      if (text.includes("질문")) askQuestion();
      else if (text.includes("쓰기")) askPermission("Write");
      else askPermission("Bash");
    });
  }

  function askPermission(tool: "Bash" | "Write") {
    const current = requireSession();
    const requestId = nextId("fake-perm");
    const info: PermissionRequestInfo =
      tool === "Bash"
        ? {
            requestId,
            toolUseId: nextId("toolu"),
            tool: "Bash",
            displayName: "Bash",
            description: "mkdir demo",
            command: "mkdir demo",
            path: null,
            cwd: current.projectDir,
            input: { command: "mkdir demo" },
            alwaysRule: { rule: "Bash(mkdir demo *)", scope: "suggested", folder: null },
          }
        : {
            requestId,
            toolUseId: nextId("toolu"),
            tool: "Write",
            displayName: "Write",
            description: "src/new.ts",
            command: null,
            path: `${current.projectDir}\\src\\new.ts`,
            cwd: current.projectDir,
            input: { file_path: `${current.projectDir}\\src\\new.ts`, content: "export {};" },
            alwaysRule: { rule: "Edit(/src/**)", scope: "folder", folder: "src" },
          };
    emit({ type: "tool_use", toolUseId: info.toolUseId ?? "", tool: info.tool, summary: info.command ?? info.path ?? "" });
    pending.set(requestId, { info });
    emit({ type: "permission_request", ...info });
  }

  function askQuestion() {
    const requestId = nextId("fake-q");
    const info: QuestionRequestInfo = {
      requestId,
      toolUseId: nextId("toolu"),
      questions: [
        {
          question: t("lab.fake.q1.question"),
          header: t("lab.fake.q1.header"),
          multiSelect: false,
          options: [
            { label: t("lab.fake.q1.o1"), description: t("lab.fake.q1.d1"), preview: null },
            { label: t("lab.fake.q1.o2"), description: null, preview: null },
            { label: t("lab.fake.q1.o3"), description: null, preview: null },
          ],
        },
        {
          question: t("lab.fake.q2.question"),
          header: t("lab.fake.q2.header"),
          multiSelect: true,
          options: [
            { label: t("lab.fake.q2.o1"), description: null, preview: null },
            { label: t("lab.fake.q2.o2"), description: null, preview: null },
            { label: t("lab.fake.q2.o3"), description: null, preview: null },
          ],
        },
      ],
    };
    pending.set(requestId, { info });
    emit({ type: "question_request", ...info });
  }

  function finishTurn(outcome: TurnSummary["outcome"], message?: string) {
    const current = session;
    if (!current) return;
    if (message) emit({ type: "text", text: message });
    current.busy = false;
    emit({ type: "turn_ended", ...turnSummary(outcome, 0.0021 * current.turns) });
  }

  const handlers: Record<string, Handler> = {
    claude_discover: (): ClaudeStatus => ({
      found: true,
      path: "C:\\fake\\claude.exe",
      version: "2.1.296",
      knownVersion: "2.1.296",
      versionMatches: true,
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "pro",
      apiKeyPresent: false,
      problem: null,
    }),
    claude_open_login: () => undefined,
    claude_session_start: (args): StartInfo => {
      const request = args.request as StartRequest | undefined;
      const projectDir = request?.projectDir?.trim() ?? "";
      if (!projectDir) throw new AppError("invalid_input", "project folder is empty");
      if (session) throw new AppError("session_running", "a session is already running");
      const saved = lastSessions.get(projectDir) ?? null;
      if (request?.resume && !saved) throw new AppError("no_saved_session", "no saved session for this project");
      session = { projectDir, sessionId: saved ?? nextId("fake-session"), busy: false, turns: 0 };
      rawLog.length = 0;
      const info: StartInfo = { projectDir, pid: 4242, resumed: !!request?.resume, resumeSessionId: request?.resume ? saved : null, cliVersion: "2.1.296" };
      emit({ type: "session_started", ...info });
      return info;
    },
    claude_session_send: (args) => {
      const text = String(args.text ?? "");
      const current = requireSession();
      if (!text.trim()) throw new AppError("invalid_input", "message is empty");
      if (current.busy) throw new AppError("turn_in_progress", "a turn is already in progress");
      beginTurn(text, false);
    },
    claude_session_respond: (args) => {
      const requestId = String(args.requestId ?? "");
      const response = args.response as ClaudeResponse;
      requireSession();
      const waiting = pending.get(requestId);
      if (!waiting) throw new AppError("request_not_found", `request not found: ${requestId}`);
      const isQuestion = "questions" in waiting.info;
      if (isQuestion && response.kind !== "answer" && response.kind !== "deny") {
        throw new AppError("invalid_input", "that answer does not fit this kind of request");
      }
      if (!isQuestion && response.kind === "answer") {
        throw new AppError("invalid_input", "that answer does not fit this kind of request");
      }
      if (response.kind === "always_allow" && !("alwaysRule" in waiting.info && waiting.info.alwaysRule)) {
        throw new AppError("invalid_input", "this request has no always-allow rule");
      }
      pending.delete(requestId);
      log("send", JSON.stringify({ type: "control_response", response: { request_id: requestId, kind: response.kind } }));
      later(() => {
        if (response.kind === "tell") {
          finishTurn("interrupted");
          later(() => {
            if (session) beginTurn(response.text, true);
          });
        } else if (response.kind === "deny") {
          emit({ type: "tool_result", toolUseId: "fake", isError: true, summary: t("lab.fake.denied") });
          finishTurn("success", t("lab.fake.denied"));
        } else if (response.kind === "answer") {
          finishTurn("success", t("lab.fake.answered"));
        } else {
          emit({ type: "tool_result", toolUseId: "fake", isError: false, summary: "ok" });
          finishTurn("success", t("lab.fake.done"));
        }
      });
    },
    claude_session_interrupt: () => {
      requireSession();
      for (const [requestId] of pending) emit({ type: "request_cancelled", requestId });
      const hadPending = pending.size > 0;
      pending.clear();
      if (session?.busy && hadPending) later(() => finishTurn("interrupted"));
    },
    claude_session_stop: (): StopInfo => {
      if (!session) return { wasRunning: false, forced: false };
      const midTurn = session.busy;
      for (const [requestId] of pending) emit({ type: "request_cancelled", requestId });
      pending.clear();
      session = null;
      emit({ type: "session_ended", ended: "normal", exitCode: 0, forced: false, midTurn, stderrTail: [] });
      return { wasRunning: true, forced: false };
    },
    claude_session_state: (): ClaudeSessionState => ({
      running: session !== null,
      projectDir: session?.projectDir ?? null,
      pid: session ? 4242 : null,
      sessionId: session?.sessionId ?? null,
      busy: session?.busy ?? false,
      pending: [...pending.values()].map(({ info }) =>
        "questions" in info ? ({ type: "question_request", ...info } as const) : ({ type: "permission_request", ...info } as const),
      ),
    }),
    claude_last_session: (args) => lastSessions.get(String(args.projectDir ?? "")) ?? null,
    claude_raw_log: () => [...rawLog],
  };

  return {
    handlers,
    subscribe(handler: (event: ClaudeEvent) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    /** 시험용: 모든 상태를 처음으로 */
    reset() {
      session = null;
      pending.clear();
      lastSessions.clear();
      rawLog.length = 0;
      listeners.clear();
      counter = 0;
    },
  };
}

export const fakeClaude = createFakeClaude();
