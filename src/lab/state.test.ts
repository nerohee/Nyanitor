import { describe, expect, it } from "vitest";
import type { ClaudeEvent, PermissionRequestInfo, QuestionRequestInfo } from "../lib/ipc";
import { describeEvent } from "./describe";
import { initialLabState, labReducer, MAX_LINES, MAX_RAW, type LabAction, type LabState } from "./state";

const permission: PermissionRequestInfo = {
  requestId: "p1",
  toolUseId: "t1",
  tool: "Bash",
  displayName: "Bash",
  description: "mkdir demo",
  command: "mkdir demo",
  path: null,
  cwd: "C:\\p",
  input: { command: "mkdir demo" },
  alwaysRule: { rule: "Bash(mkdir demo *)", scope: "suggested", folder: null },
};

const question: QuestionRequestInfo = {
  requestId: "q1",
  toolUseId: null,
  questions: [{ question: "색?", header: "색", multiSelect: false, options: [{ label: "파랑", description: null, preview: null }] }],
};

function run(actions: LabAction[], from: LabState = initialLabState): LabState {
  return actions.reduce(labReducer, from);
}

const event = (e: ClaudeEvent): LabAction => ({ type: "event", event: e });

describe("labReducer", () => {
  it("세션이 시작되면 돌아가는 중으로, 끝나면 카드를 모두 닫는다", () => {
    const started = run([
      event({ type: "session_started", projectDir: "C:\\p", pid: 1, resumed: false, resumeSessionId: null, cliVersion: "2.1.296" }),
      event({ type: "permission_request", ...permission }),
    ]);
    expect(started.running).toBe(true);
    expect(started.projectDir).toBe("C:\\p");
    expect(started.cards).toHaveLength(1);

    const ended = run([event({ type: "session_ended", ended: "died", exitCode: 1, forced: false, midTurn: true, stderrTail: [] })], started);
    expect(ended.running).toBe(false);
    expect(ended.busy).toBe(false);
    expect(ended.cards).toEqual([]);
    expect(ended.lines[ended.lines.length - 1]?.text).toContain("죽음");
  });

  it("턴이 시작되면 바쁨, 끝나면 한가함", () => {
    const busy = run([event({ type: "turn_started", sessionId: "s1", model: null, cliVersion: null, permissionMode: null, apiKeySource: "none" })]);
    expect(busy).toMatchObject({ busy: true, sessionId: "s1" });
    const idle = run(
      [
        event({
          type: "turn_ended",
          outcome: "success",
          subtype: "success",
          isError: false,
          terminalReason: "completed",
          result: "ok",
          errors: [],
          apiErrorStatus: null,
          durationMs: 1,
          numTurns: 1,
          usage: { inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          costUsd: 0.001,
          totalCostUsd: 0.002,
        }),
      ],
      busy,
    );
    expect(idle.busy).toBe(false);
    expect(idle.lines[idle.lines.length - 1]?.text).toContain("성공");
  });

  it("권한 · 질문 요청은 카드가 되고, 취소되거나 답하면 사라진다", () => {
    const withCards = run([event({ type: "permission_request", ...permission }), event({ type: "question_request", ...question })]);
    expect(withCards.cards.map((c) => c.kind)).toEqual(["permission", "question"]);

    const cancelled = run([event({ type: "request_cancelled", requestId: "p1" })], withCards);
    expect(cancelled.cards.map((c) => c.info.requestId)).toEqual(["q1"]);

    const answered = run([{ type: "cardAnswered", requestId: "q1" }], cancelled);
    expect(answered.cards).toEqual([]);
  });

  it("같은 요청이 두 번 와도 카드는 하나", () => {
    const state = run([event({ type: "permission_request", ...permission }), event({ type: "permission_request", ...permission })]);
    expect(state.cards).toHaveLength(1);
  });

  it("원본 로그는 목록 줄이 아니라 따로 쌓이고, 같은 번호는 한 번만, 개수에 제한이 있다", () => {
    const raw = (seq: number): ClaudeEvent => ({ type: "raw_log", seq, dir: "recv", text: `line ${seq}`, truncated: false, originalLen: 6, atMs: seq });
    let state = run([event(raw(1)), event(raw(1)), event(raw(2))]);
    expect(state.raw.map((r) => r.seq)).toEqual([1, 2]);
    expect(state.lines).toEqual([]);
    state = run(Array.from({ length: MAX_RAW + 20 }, (_, i) => event(raw(i + 10))), state);
    expect(state.raw).toHaveLength(MAX_RAW);
    expect(state.raw[state.raw.length - 1]?.seq).toBe(MAX_RAW + 29);
  });

  it("이벤트 줄 수에도 제한이 있다", () => {
    const state = run(Array.from({ length: MAX_LINES + 5 }, (_, i) => event({ type: "text", text: `t${i}` })));
    expect(state.lines).toHaveLength(MAX_LINES);
    expect(state.lines[state.lines.length - 1]?.text).toContain(`t${MAX_LINES + 4}`);
    // 줄 번호는 겹치지 않는다
    expect(new Set(state.lines.map((l) => l.id)).size).toBe(MAX_LINES);
  });

  it("이어 할 세션이 없다는 알림은 새 시작을 물을 때까지 남고, 새 세션이 시작되면 사라진다", () => {
    const missing = run([event({ type: "resume_not_found", sessionId: "s-old" })]);
    expect(missing.resumeNotFound).toBe("s-old");
    expect(run([{ type: "dismissResumeNotFound" }], missing).resumeNotFound).toBeNull();
    const restarted = run(
      [event({ type: "session_started", projectDir: "C:\\p", pid: 2, resumed: false, resumeSessionId: null, cliVersion: null })],
      missing,
    );
    expect(restarted.resumeNotFound).toBeNull();
  });

  it("화면을 다시 열면 상태 가져오기로 돌아가는 세션과 기다리는 카드를 되살린다", () => {
    const state = run([
      {
        type: "restore",
        state: {
          running: true,
          projectDir: "C:\\p",
          pid: 9,
          sessionId: "s1",
          busy: true,
          pending: [{ type: "permission_request", ...permission }, { type: "question_request", ...question }],
        },
      },
    ]);
    expect(state).toMatchObject({ running: true, busy: true, sessionId: "s1", projectDir: "C:\\p" });
    expect(state.cards).toHaveLength(2);
  });
});

describe("describeEvent", () => {
  it("원본 로그는 설명하지 않는다", () => {
    expect(describeEvent({ type: "raw_log", seq: 1, dir: "send", text: "x", truncated: false, originalLen: 1, atMs: 1 })).toBeNull();
  });

  it("경고는 코드와 내용을 보인다", () => {
    expect(describeEvent({ type: "warning", code: "cli_version_mismatch", detail: "found 2.1.999" })).toBe(
      "경고 cli_version_mismatch — found 2.1.999",
    );
  });

  it("세션 끝은 정상 · 죽음과 종료 코드, 강제 종료, 턴 도중을 보인다", () => {
    const text = describeEvent({ type: "session_ended", ended: "died", exitCode: 1, forced: true, midTurn: true, stderrTail: [] });
    expect(text).toContain("죽음");
    expect(text).toContain("1");
    expect(text).toContain("강제 종료");
    expect(text).toContain("턴 도중");
  });
});
