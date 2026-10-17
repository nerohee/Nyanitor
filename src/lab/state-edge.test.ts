// 시험 화면 상태 — 경계 · 이상한 이벤트 (P3-03)
import { describe, expect, it } from "vitest";
import type { ClaudeEvent, PermissionRequestInfo } from "../lib/ipc";
import { describeEvent } from "./describe";
import { initialLabState, labReducer, MAX_RAW, type LabAction, type LabState } from "./state";

const permission: PermissionRequestInfo = {
  requestId: "p1",
  toolUseId: "t1",
  tool: "Bash",
  displayName: null,
  description: null,
  command: "ls",
  path: null,
  cwd: "C:\\p",
  input: {},
  alwaysRule: null,
};

const event = (e: ClaudeEvent): LabAction => ({ type: "event", event: e });
const run = (actions: LabAction[], from: LabState = initialLabState) => actions.reduce(labReducer, from);
const started = event({ type: "session_started", projectDir: "C:\\p", pid: 1, resumed: false, resumeSessionId: null, cliVersion: null });
const raw = (seq: number): ClaudeEvent => ({ type: "raw_log", seq, dir: "recv", text: `l${seq}`, truncated: false, originalLen: 2, atMs: seq });

describe("labReducer — 경계", () => {
  // P3-03 버그: describe.ts 의 switch 에 default 가 없어 모르는 종류는 undefined 를 돌려주고, state.ts 는 `=== null` 만 거른다.
  it.fails("알 수 없는 이벤트 종류가 와도 멈추지 않고, 글자 없는 줄(undefined)을 목록에 넣지 않는다", () => {
    // Rust 가 새 종류를 먼저 늘린 경우 (화면이 아직 모른다)
    const future = { type: "future_thing", payload: 1 } as unknown as ClaudeEvent;
    const next = run([started, event(future)]);
    expect(next.running).toBe(true);
    for (const line of next.lines) {
      expect(typeof line.text, JSON.stringify(line)).toBe("string");
    }
  });

  it.fails("describeEvent 는 알 수 없는 종류에 undefined 를 돌려주지 않는다 (null 또는 글)", () => {
    const future = { type: "future_thing" } as unknown as ClaudeEvent;
    expect(describeEvent(future) === undefined).toBe(false);
  });

  it("취소 · 답함이 모르는 요청 ID 를 가리켜도 카드는 그대로다", () => {
    const base = run([started, event({ type: "permission_request", ...permission })]);
    const after = run(
      [event({ type: "request_cancelled", requestId: "nope" }), { type: "cardAnswered", requestId: "nope" }],
      base,
    );
    expect(after.cards).toHaveLength(1);
  });

  it("세션이 끝난 뒤 늦게 온 턴 끝 · 취소가 있어도 돌아가는 중으로 되돌아가지 않는다", () => {
    const ended = run([
      started,
      event({ type: "permission_request", ...permission }),
      event({ type: "session_ended", ended: "died", exitCode: 1, forced: false, midTurn: true, stderrTail: [] }),
      event({ type: "request_cancelled", requestId: "p1" }),
    ]);
    expect(ended.running).toBe(false);
    expect(ended.busy).toBe(false);
    expect(ended.cards).toEqual([]);
  });

  it("새 세션이 시작되면 옛 카드 · 원본 로그는 지워지지만 이벤트 목록 줄은 이어진다", () => {
    const first = run([started, event({ type: "permission_request", ...permission }), event(raw(1)), event({ type: "text", text: "안녕" })]);
    const second = run([started], first);
    expect(second.cards).toEqual([]);
    expect(second.raw).toEqual([]);
    expect(second.lines.map((l) => l.type)).toEqual(["session_started", "permission_request", "text", "session_started"]);
  });

  it("줄 번호(id)는 줄이 잘려 나가도 겹치지 않고 계속 커진다", () => {
    const many = run(Array.from({ length: 450 }, (_, i) => event({ type: "text", text: `t${i}` })));
    const ids = many.lines.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("원본 로그가 뒤섞인 순서(번호 거꾸로)로 와도 같은 번호는 한 번만, 개수 제한을 지킨다", () => {
    const shuffled = run([...Array.from({ length: MAX_RAW + 20 }, (_, i) => event(raw(MAX_RAW + 20 - i))), event(raw(5))]);
    expect(shuffled.raw.length).toBeLessThanOrEqual(MAX_RAW);
    const seqs = shuffled.raw.map((r) => r.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("상태 가져오기는 기다리는 요청이 없으면 카드를 비우고, 요청이 아닌 항목은 무시한다", () => {
    const withCard = run([started, event({ type: "permission_request", ...permission })]);
    const restored = run(
      [
        {
          type: "restore",
          state: {
            running: true,
            busy: true,
            sessionId: "s",
            projectDir: "C:\\p",
            pid: 1,
            pending: [{ type: "text", text: "이건 카드가 아님" }],
          },
        },
      ],
      withCard,
    );
    expect(restored.cards).toEqual([]);
    expect(restored.busy).toBe(true);
    // 세션이 없다고 돌아오면 돌아가는 중이 아니다
    const none = run(
      [{ type: "restore", state: { running: false, busy: false, sessionId: null, projectDir: null, pid: null, pending: [] } }],
      restored,
    );
    expect(none.running).toBe(false);
    expect(none.busy).toBe(false);
  });

  it("아주 긴 글 · 비어 있는 글 · 줄바꿈 글도 한 줄 설명이 된다", () => {
    for (const text of ["", "x".repeat(100_000), "a\nb\r\nc"]) {
      const line = describeEvent({ type: "text", text });
      expect(typeof line).toBe("string");
    }
  });

  it("값이 비어 있는 이벤트(null 투성이)도 설명한다", () => {
    const events: ClaudeEvent[] = [
      { type: "warning", code: "x", detail: null },
      { type: "turn_started", sessionId: "s", model: null, cliVersion: null, permissionMode: null, apiKeySource: null },
      { type: "rate_limit", status: null, rateLimitType: null, resetsAt: null, fiveHourUtilization: null, sevenDayUtilization: null },
      { type: "session_ended", ended: "died", exitCode: null, forced: true, midTurn: true, stderrTail: [] },
      { type: "permission_request", ...permission, command: null, path: null },
    ];
    for (const e of events) expect(typeof describeEvent(e), e.type).toBe("string");
  });
});
