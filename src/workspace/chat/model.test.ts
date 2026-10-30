// 채팅 목록 모델 — 이벤트 접기 · 기록 + 실시간 잇기 (겹침 · 빠짐 없음) · 카드 상태.
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatListEvent, ClaudeEvent } from "../../lib/ipc-types";
import { emptyChat, foldEvent, fromEntries, isStoredEvent, mergeLive, overlapCount, pendingCount, prependEntries, type ChatData } from "./model";

const USAGE = { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

function turnEnded(outcome: "success" | "interrupted" | "error" | "limit", total = 1): Extract<ClaudeEvent, { type: "turn_ended" }> {
  return {
    type: "turn_ended",
    outcome,
    subtype: null,
    isError: outcome !== "success",
    terminalReason: null,
    result: null,
    errors: [],
    apiErrorStatus: null,
    durationMs: 1,
    numTurns: 1,
    usage: USAGE,
    costUsd: 0.1,
    totalCostUsd: total,
  };
}

const text = (value: string): ClaudeEvent => ({ type: "text", text: value });
const user = (value: string, deferred = false): ClaudeEvent => ({ type: "user_message", text: value, deferred });
const permission = (requestId: string, withInput = false): Extract<ClaudeEvent, { type: "permission_request" }> => ({
  type: "permission_request",
  requestId,
  toolUseId: `t-${requestId}`,
  tool: "Bash",
  displayName: "Bash",
  description: null,
  command: "ls",
  path: null,
  cwd: "C:\\p",
  input: withInput ? { command: "ls" } : undefined,
  alwaysRule: null,
});
const question = (requestId: string): ClaudeEvent => ({
  type: "question_request",
  requestId,
  toolUseId: `t-${requestId}`,
  questions: [{ question: "q?", header: null, multiSelect: false, options: [] }],
});
const asList = (event: ClaudeEvent): ChatListEvent => event as ChatListEvent;

/** 기록 항목 만들기 (카드는 기본이 지나감) */
function entries(events: ChatListEvent[], firstId = 1): ChatEntry[] {
  return events.map((event, index) => ({
    id: firstId + index,
    at: 1_800_000_000 + index,
    sessionId: "s1",
    truncated: false,
    event,
    request: event.type === "permission_request" || event.type === "question_request" ? { status: "expired", answer: null } : null,
  }));
}

function fold(events: ClaudeEvent[], from: ChatData = emptyChat()): ChatData {
  return events.reduce((data, event) => foldEvent(data, event), from);
}

const kinds = (data: ChatData) => data.lines.map((line) => line.kind);
const texts = (data: ChatData) => data.lines.map((line) => (line.kind === "user" || line.kind === "orch" ? line.text : line.kind));

describe("이벤트 접기", () => {
  it("채팅에 보이는 것만 줄이 된다 — 도구 성공 결과 · turn_started · raw_log · 알 수 없는 경고는 빠진다", () => {
    const data = fold([
      { type: "turn_started", sessionId: "s", model: null, cliVersion: null, permissionMode: null, apiKeySource: null },
      user("안녕"),
      text("네"),
      { type: "tool_use", toolUseId: "a", tool: "Read", summary: "x.md" },
      { type: "tool_result", toolUseId: "a", isError: false, summary: "ok" },
      { type: "tool_result", toolUseId: "b", isError: true, summary: "EACCES" },
      { type: "warning", code: "cli_version_mismatch", detail: null },
      { type: "raw_log", seq: 1, dir: "recv", text: "x", truncated: false, originalLen: 1, atMs: 0 },
      turnEnded("success"),
    ]);
    expect(kinds(data)).toEqual(["user", "orch", "tool", "toolError"]);
  });

  it("턴 끝은 오류 · 한도 · 중단일 때만 줄이 된다, 경고는 채팅에 보이는 것만", () => {
    const data = fold([
      turnEnded("interrupted"),
      turnEnded("error"),
      turnEnded("limit"),
      { type: "warning", code: "api_key_in_use", detail: null },
      { type: "warning", code: "planner_model_unusable", detail: "bad_shape" },
      { type: "warning", code: "history_write_failed", detail: "disk_full" },
      { type: "warning", code: "project_touch_failed", detail: null },
      { type: "rate_limit", status: "allowed", rateLimitType: "five_hour", resetsAt: 1, fiveHourUtilization: 0.1, sevenDayUtilization: 0 },
      { type: "rate_limit", status: "rejected", rateLimitType: "five_hour", resetsAt: 1_800_000_000, fiveHourUtilization: 1, sevenDayUtilization: 0 },
      { type: "resume_not_found", sessionId: "gone" },
      { type: "session_ended", ended: "died", exitCode: 1, forced: false, midTurn: true, stderrTail: ["boom"] },
      { type: "session_ended", ended: "normal", exitCode: 0, forced: false, midTurn: false, stderrTail: [] },
    ]);
    expect(data.lines.map((line) => (line.kind === "turnEnd" ? `turn:${line.outcome}` : line.kind === "notice" ? line.code : line.kind))).toEqual([
      "turn:interrupted",
      "turn:error",
      "turn:limit",
      "api_key_in_use",
      "planner_config",
      "history_write_failed",
      "rate_limit",
      "resume_not_found",
      "session_died",
    ]);
  });

  it("카드 — 답하면 answered, 취소되면 cancelled, 한 번 답한 카드는 되돌리지 않는다", () => {
    let data = fold([permission("p1", true), question("q1"), permission("p2")]);
    expect(pendingCount(data.lines)).toBe(3);
    data = fold(
      [
        { type: "request_answered", requestId: "p1", kind: "allow", text: null, answers: null },
        { type: "request_cancelled", requestId: "q1" },
        // 답한 뒤 늦게 온 취소는 무시
        { type: "request_cancelled", requestId: "p1" },
      ],
      data,
    );
    const states = data.lines.map((line) => (line.kind === "permission" || line.kind === "question" ? line.state.status : null));
    expect(states).toEqual(["answered", "cancelled", "pending"]);
    expect(pendingCount(data.lines)).toBe(1);
  });

  it("같은 requestId 가 두 번 오면 한 장 — 정보는 새것(도구 입력), 상태는 더 나아간 쪽", () => {
    let data = fromEntries(entries([asList(permission("p1"))]));
    // 기록에서 온 카드는 지나감(expired) — 같은 카드의 실시간 이벤트가 와도 한 장이고 지나감 그대로
    data = foldEvent(data, permission("p1", true));
    expect(data.lines).toHaveLength(1);
    const line = data.lines[0];
    expect(line?.kind === "permission" && line.info.input).toEqual({ command: "ls" });
    expect(line?.kind === "permission" && line.state.status).toBe("expired");
  });

  it("세션이 끝나면 기다리던 실시간 카드는 취소됨", () => {
    const data = fold([permission("p1"), { type: "session_ended", ended: "normal", exitCode: 0, forced: false, midTurn: true, stderrTail: [] }]);
    expect(pendingCount(data.lines)).toBe(0);
    const line = data.lines[0];
    expect(line?.kind === "permission" && line.state.status).toBe("cancelled");
  });

  it("멈춤 표시 — 갑자기 멈추면 died, 오류 · 한도, 새 말 · 성공 턴 · 중단이면 풀린다", () => {
    expect(fold([{ type: "session_ended", ended: "died", exitCode: 1, forced: false, midTurn: false, stderrTail: [] }]).halted).toBe("died");
    expect(fold([turnEnded("error")]).halted).toBe("error");
    expect(fold([turnEnded("limit")]).halted).toBe("limit");
    expect(fold([turnEnded("error"), user("다시")]).halted).toBeNull();
    expect(fold([turnEnded("error"), turnEnded("success")]).halted).toBeNull();
    expect(fold([turnEnded("limit"), turnEnded("interrupted")]).halted).toBeNull();
  });

  it("모델 · 수준은 가장 최근 세션 시작에서", () => {
    const start = (model: string | null): ClaudeEvent => ({ type: "session_started", projectId: 1, projectDir: "C:\\p", pid: 1, resumed: false, resumeSessionId: null, cliVersion: null, model, effort: "high" });
    expect(fold([start("opus"), start(null)]).lastStart).toEqual({ model: null, effort: "high" });
  });
});

describe("기록 + 실시간 잇기", () => {
  const history = entries([asList(user("a")), asList(text("b")), asList(turnEnded("success", 1)), asList(user("c")), asList(text("d"))]);
  const base = fromEntries(history);

  it("기록의 키는 h-번호, 실시간은 l-번호 — 겹치지 않는다", () => {
    const merged = mergeLive(base, history, [text("e")]);
    expect(merged.lines.map((line) => line.key)).toEqual(["h-1", "h-2", "h-4", "h-5", "l-1"]);
  });

  it("읽는 동안 온 이벤트가 이미 기록에 있으면 빼고, 없는 것만 뒤에 붙인다", () => {
    // 모은 것: c(기록에 있음) d(기록에 있음) e(새것) — 겹침은 앞의 둘
    const merged = mergeLive(base, history, [user("c"), text("d"), text("e")]);
    expect(texts(merged)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("모은 것이 전부 기록에 있으면 하나도 더하지 않는다 (겹침 없음)", () => {
    const merged = mergeLive(base, history, [user("c"), text("d")]);
    expect(merged.lines).toHaveLength(base.lines.length);
  });

  it("모은 것이 기록보다 길어도(읽기 전에 오래 쌓임) 기록 전체와 겹친 만큼만 뺀다", () => {
    const stored = [user("x"), text("y"), user("a"), text("b"), turnEnded("success", 1), user("c"), text("d"), text("e")].filter(isStoredEvent);
    expect(overlapCount(history, stored)).toBe(7);
  });

  it("모은 것이 기록과 하나도 안 겹치면 전부 붙인다 (빠짐 없음)", () => {
    const merged = mergeLive(base, history, [text("새1"), text("새2")]);
    expect(texts(merged).slice(-2)).toEqual(["새1", "새2"]);
    expect(merged.lines).toHaveLength(base.lines.length + 2);
  });

  it("기록이 비었으면 모은 것을 전부 붙인다", () => {
    const merged = mergeLive(fromEntries([]), [], [user("처음"), text("응")]);
    expect(kinds(merged)).toEqual(["user", "orch"]);
  });

  it("기록의 긴 글(끝에 …)은 잘렸어도 같은 이벤트로 본다", () => {
    const cut = entries([asList(text("아주 긴 글의 앞부분…"))]);
    cut[0] = { ...cut[0]!, truncated: true };
    const merged = mergeLive(fromEntries(cut), cut, [text("아주 긴 글의 앞부분 그리고 뒷부분 전부")]);
    expect(merged.lines).toHaveLength(1);
    expect(merged.lines[0]).toMatchObject({ kind: "orch", truncated: true });
  });

  it("카드는 requestId 로 겹침을 알고, 겹쳐도 도구 입력(실시간만 있다)은 새것으로 채운다", () => {
    const withCard = entries([asList(text("계획")), asList(permission("p9"))]);
    withCard[1] = { ...withCard[1]!, request: { status: "pending", answer: null } };
    const merged = mergeLive(fromEntries(withCard), withCard, [permission("p9", true)]);
    expect(merged.lines).toHaveLength(2);
    const card = merged.lines[1];
    expect(card?.kind === "permission" && card.info.input).toEqual({ command: "ls" });
    expect(card?.kind === "permission" && card.state.status).toBe("pending");
  });

  it("읽는 동안 답이 온 카드는 답한 것으로 (답 · 취소 이벤트는 겹쳐도 반영)", () => {
    const withCard = entries([asList(permission("p9"))]);
    withCard[0] = { ...withCard[0]!, request: { status: "pending", answer: null } };
    const merged = mergeLive(fromEntries(withCard), withCard, [permission("p9", true), { type: "request_answered", requestId: "p9", kind: "allow", text: null, answers: null }]);
    const card = merged.lines[0];
    expect(card?.kind === "permission" && card.state.status).toBe("answered");
    expect(pendingCount(merged.lines)).toBe(0);
  });

  it("이전 쪽은 앞에 붙고 이미 있는 항목과 겹치지 않는다", () => {
    const older = entries([asList(user("옛1")), asList(text("옛2"))], 1);
    const newer = entries([asList(user("새1"))], 3);
    const merged = prependEntries(fromEntries(newer), older);
    expect(merged.lines.map((line) => line.key)).toEqual(["h-1", "h-2", "h-3"]);
    expect(prependEntries(merged, older).lines).toHaveLength(3);
  });
});
