// 이벤트 한 줄 설명 (시험 화면의 이벤트 목록). 문구는 `ko.ts` 의 `lab.event.*` (D-08).
import { t, tf } from "../i18n/ko";
import type { ClaudeEvent, TurnOutcome } from "../lib/ipc";

const OUTCOME_KEY = {
  success: "lab.outcome.success",
  interrupted: "lab.outcome.interrupted",
  error: "lab.outcome.error",
  limit: "lab.outcome.limit",
} as const satisfies Record<TurnOutcome, string>;

/** 원본 로그 줄(`raw_log`)은 목록에 넣지 않는다 (null). */
export function describeEvent(event: ClaudeEvent): string | null {
  switch (event.type) {
    case "raw_log":
      return null;
    case "session_started":
      return tf("lab.event.sessionStarted", {
        dir: event.projectDir,
        pid: event.pid,
        resumed: event.resumed ? t("lab.event.resumedSuffix") : "",
      });
    case "warning":
      return tf("lab.event.warning", { code: event.code, detail: event.detail ? ` — ${event.detail}` : "" });
    case "user_message":
      return tf(event.deferred ? "lab.event.userDeferred" : "lab.event.user", { text: event.text });
    case "turn_started":
      return tf("lab.event.turnStarted", { id: event.sessionId, model: event.model ?? t("lab.none") });
    case "text":
      return tf("lab.event.text", { text: event.text });
    case "tool_use":
      return tf("lab.event.toolUse", { tool: event.tool, summary: event.summary });
    case "tool_result":
      return tf("lab.event.toolResult", {
        state: t(event.isError ? "lab.event.toolError" : "lab.event.toolOk"),
        summary: event.summary,
      });
    case "permission_request":
      return tf("lab.event.permission", { tool: event.tool, target: event.command ?? event.path ?? "" });
    case "question_request":
      return tf("lab.event.question", { n: event.questions.length });
    case "request_cancelled":
      return t("lab.event.cancelled");
    case "turn_ended":
      return tf("lab.event.turnEnded", {
        outcome: t(OUTCOME_KEY[event.outcome]),
        cost: event.costUsd.toFixed(4),
        total: event.totalCostUsd.toFixed(4),
        out: event.usage.outputTokens,
      });
    case "rate_limit":
      return tf("lab.event.rateLimit", {
        status: event.status ?? t("lab.none"),
        five: event.fiveHourUtilization === null ? t("lab.none") : String(event.fiveHourUtilization),
      });
    case "resume_not_found":
      return tf("lab.event.resumeNotFound", { id: event.sessionId });
    case "session_ended":
      return tf("lab.event.sessionEnded", {
        kind: t(event.ended === "normal" ? "lab.event.ended.normal" : "lab.event.ended.died"),
        code: event.exitCode === null ? t("lab.none") : event.exitCode,
        forced: event.forced ? t("lab.event.forcedSuffix") : "",
        mid: event.midTurn ? t("lab.event.midTurnSuffix") : "",
      });
    default:
      // Rust 가 새 종류를 먼저 늘린 경우 — 글자 없는 줄(undefined)이 아니라 모른다는 줄을 보인다
      return tf("lab.event.unknown", { type: String((event as { type?: unknown }).type) });
  }
}
