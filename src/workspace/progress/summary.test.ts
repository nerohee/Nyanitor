// 요약 로그 규칙 — 종류마다 하나씩 · 로그에 안 들어가는 줄 · 실시간 + 기록이 겹쳐도 한 번만 · 시간순 · 조사.
import { describe, expect, it } from "vitest";
import type { ChatEntry, ChatListEvent, ClaudeEvent, WorkerRef } from "../../lib/ipc-types";
import { emptyChat, foldEvent, fromEntries, mergeLive, type ChatData } from "../chat/model";
import { buildSummaryLog } from "./summary";
import { mergeHistoryWorkers, applyWorkerEvent, type WorkerEntry } from "./workers";

type Item = { event: ClaudeEvent; atMs?: number; request?: ChatEntry["request"]; worker?: ChatEntry["worker"] };

/** 이벤트들을 (시각과 함께) 채팅 목록으로 접는다 */
function chatOf(items: Item[]): ChatData {
  return items.reduce((data, item) => foldEvent(data, item.event, { atMs: item.atMs, request: item.request, worker: item.worker }), emptyChat());
}
const log = (items: Item[], more: { workers?: WorkerEntry[] } = {}) => buildSummaryLog({ chat: chatOf(items), ...more });
const texts = (items: Item[]) => log(items).map((entry) => `${entry.kind}:${entry.text}`);

const started = (resumed = false): ClaudeEvent => ({ type: "session_started", projectId: 1, projectDir: "C:\\p", pid: 1, resumed, resumeSessionId: null, cliVersion: null, model: null, effort: null });
const wStart = (id: string, name: string, description: string | null, atMs: number): Extract<ClaudeEvent, { type: "worker_started" }> => ({ type: "worker_started", toolUseId: id, agentId: `a-${id}`, name, description, background: true, depth: 1, atMs });
const wEnd = (id: string, outcome: "done" | "failed" | "stopped", atMs: number): ClaudeEvent => ({ type: "worker_ended", toolUseId: id, outcome, atMs });
const turnEnded = (outcome: "success" | "interrupted" | "error" | "limit"): ClaudeEvent => ({
  type: "turn_ended",
  outcome,
  subtype: null,
  isError: outcome !== "success",
  terminalReason: null,
  result: "자세한 오류",
  errors: [],
  apiErrorStatus: null,
  durationMs: 1,
  numTurns: 1,
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  costUsd: 0,
  totalCostUsd: 0,
});
const perm = (requestId: string, worker: WorkerRef | null = null): ClaudeEvent => ({ type: "permission_request", requestId, toolUseId: null, worker, tool: "Bash", displayName: null, description: null, command: "npm install", path: null, cwd: "C:\\p", input: undefined, alwaysRule: null });
const ask = (requestId: string, question: string, header: string | null = null, worker: WorkerRef | null = null): ClaudeEvent => ({ type: "question_request", requestId, toolUseId: null, worker, questions: [{ question, header, multiSelect: false, options: [] }] });
const APPROVAL = "단계 승인 — P7 진행 보기\n- 무엇을: 화면 만들기\n- 왜 지금: 다음 단계\n- 산출물: 진행 탭\n- 하지 않는 것: 고양이 집";
const answered = { status: "answered", answer: null } as const;

describe("종류마다 하나씩", () => {
  it("세션 시작 → start (이어 하기면 다른 글)", () => {
    expect(texts([{ event: started() }])).toEqual(["start:먹물이 일을 시작했어요"]);
    expect(texts([{ event: started(true) }])).toEqual(["start:먹물이 하던 일을 이어서 시작했어요"]);
  });

  it("작업자 시작 → assign · 끝 → back · error · stop (이름은 고양이 이름, 조사는 받침에 맞게)", () => {
    expect(
      texts([
        { event: wStart("a", "harness-builder-system", "사진 읽기 명령 만들기", 1000) },
        { event: wStart("b", "harness-builder-ui", "목록 화면", 1100) },
        { event: wStart("c", "harness-reviewer", null, 1200) },
        { event: wEnd("a", "done", 2000) },
        { event: wEnd("b", "failed", 3000) },
        { event: wEnd("c", "stopped", 4000) },
      ]),
    ).toEqual([
      "assign:나비에게 맡겼어요 — 사진 읽기 명령 만들기",
      "assign:단추에게 맡겼어요 — 목록 화면",
      "assign:구름에게 일을 맡겼어요",
      "back:나비가 일을 끝내고 돌아왔어요",
      "error:단추가 일을 끝내지 못했어요",
      "stop:구름이 멈췄어요",
    ]);
  });

  it("질문 카드 → ask — 단계 승인이면 승인 제목, 아니면 질문 머리말 (작업자의 질문이면 그 고양이)", () => {
    const items = texts([{ event: ask("r1", APPROVAL) }, { event: ask("r2", "어떤 색이 좋아요?", "색") }, { event: ask("r3", "이 문장이 머리말 대신이에요") }]);
    expect(items).toEqual(["ask:P7 단계 승인을 기다려요", "ask:먹물이 답을 기다려요 — 색", "ask:먹물이 답을 기다려요 — 이 문장이 머리말 대신이에요"]);
    const worker: WorkerRef = { agentId: "a", toolUseId: "w1", name: "harness-tester" };
    const asked = log([{ event: wStart("w1", "harness-tester", "시험", 1) }, { event: ask("r4", "q?", "범위", worker) }]);
    expect(asked[1]).toMatchObject({ kind: "ask", cat: "kkaebi", text: "깨비가 답을 기다려요 — 범위" });
  });

  it("질문이 여럿이면 첫 머리말 외 n개 · 답한 뒤엔 '물어봤어요'", () => {
    const many: ClaudeEvent = { type: "question_request", requestId: "m", toolUseId: null, questions: [{ question: "a?", header: "하나", multiSelect: false, options: [] }, { question: "b?", header: "둘", multiSelect: false, options: [] }, { question: "c?", header: "셋", multiSelect: false, options: [] }] };
    expect(texts([{ event: many }])).toEqual(["ask:먹물이 답을 기다려요 — 하나 외 2개"]);
    expect(texts([{ event: ask("r2", "어떤 색?", "색"), request: answered }, { event: ask("r1", APPROVAL), request: answered }])).toEqual(["ask:먹물이 물어봤어요 — 색", "ask:P7 단계 승인을 물어봤어요"]);
  });

  it("권한 카드 → ask — 작업자가 한 요청이면 그 고양이 이름, 아니면 먹물", () => {
    const worker: WorkerRef = { agentId: "a", toolUseId: "w1", name: null };
    const items = log([{ event: wStart("w1", "harness-builder-system", "읽기", 1) }, { event: perm("p1", worker) }, { event: perm("p2") }]);
    expect(items.map((entry) => [entry.cat, entry.text])).toEqual([
      ["nabi", "나비에게 맡겼어요 — 읽기"],
      ["nabi", "나비가 허락을 기다려요 — Bash npm install"],
      ["mukmul", "먹물이 허락을 기다려요 — Bash npm install"],
    ]);
    // 시작 알림보다 요청이 먼저 와서 번호를 못 찾아도 요청의 이름으로
    expect(log([{ event: perm("p3", { agentId: "a", toolUseId: null, name: "harness-tester" }) }])[0]).toMatchObject({ cat: "kkaebi" });
    expect(texts([{ event: perm("p4"), request: answered }])).toEqual(["ask:먹물이 허락을 물어봤어요 — Bash npm install"]);
  });

  it("긴 도구 요약은 잘린다", () => {
    const long: ClaudeEvent = { ...(perm("p") as Extract<ClaudeEvent, { type: "permission_request" }>), command: "x".repeat(200) };
    const [item] = log([{ event: long }]);
    expect(item?.text.length).toBeLessThan(120);
    expect(item?.text.endsWith("…")).toBe(true);
  });

  it("중단 · 오류 · 한도 → stop · error · stop, 먹물이 갑자기 멈춤 → error", () => {
    expect(texts([{ event: turnEnded("interrupted") }, { event: turnEnded("error") }, { event: turnEnded("limit") }, { event: { type: "session_ended", ended: "died", exitCode: 1, forced: false, midTurn: true, stderrTail: ["x"] } }])).toEqual([
      "stop:하던 일을 중단했어요",
      "error:Claude Code 가 오류로 멈췄어요",
      "stop:한도에 닿아 멈췄어요",
      "error:먹물이 갑자기 멈췄어요",
    ]);
  });
});

describe("로그에 안 들어가는 줄", () => {
  it("사용자 글 · 먹물 글 · 도구 줄(성공 · 실패) · 성공한 턴 끝 · 한도 가까움 알림 · 그 밖의 알림", () => {
    const items: Item[] = [
      { event: { type: "user_message", text: "안녕", deferred: false } },
      { event: { type: "text", text: "네" } },
      { event: { type: "tool_use", toolUseId: "r", tool: "Read", summary: "a.md" } },
      { event: { type: "tool_result", toolUseId: "r", isError: true, summary: "EACCES" } },
      { event: { type: "tool_use", toolUseId: "ag", tool: "Agent", summary: "x" } },
      { event: turnEnded("success") },
      { event: { type: "rate_limit", status: "allowed_warning", rateLimitType: "five_hour", resetsAt: null, fiveHourUtilization: 0.9, sevenDayUtilization: null } },
      { event: { type: "warning", code: "api_key_in_use", detail: null } },
      { event: { type: "resume_not_found", sessionId: "s" } },
    ];
    expect(log(items)).toEqual([]);
  });
});

describe("겹치지 않음 · 시간순", () => {
  it("실시간과 기록으로 같은 일이 두 번 와도 로그는 한 번 (세션 시작 · 작업자 · 카드)", () => {
    const rows: { event: ClaudeEvent; request: ChatEntry["request"]; worker: ChatEntry["worker"] }[] = [
      { event: started(), request: null, worker: null },
      { event: wStart("t1", "harness-builder-ui", "목록", 1_800_000_001_500), request: null, worker: { status: "running", endedAtMs: null } },
      { event: perm("p1"), request: { status: "pending", answer: null }, worker: null },
    ];
    const history: ChatEntry[] = rows.map((item, index) => ({ id: index + 1, at: 1_800_000_000 + index, sessionId: "s", truncated: false, event: item.event as ChatListEvent, request: item.request, worker: item.worker }));
    const base = fromEntries(history);
    const merged = mergeLive(base, history, [started(), wStart("t1", "harness-builder-ui", "목록", 1_800_000_001_500), perm("p1"), wEnd("t1", "done", 1_800_000_050_000)], [1, 2, 3, 4]);
    const items = buildSummaryLog({ chat: merged });
    expect(items.map((entry) => entry.kind)).toEqual(["start", "assign", "ask", "back"]);
  });

  it("작업자 목록에만 있는 작업자(대화를 읽기 전 · 오래된 쪽 밖)도 더해지고, 채팅 줄에 있는 것은 두 번 나오지 않는다", () => {
    const workers = mergeHistoryWorkers([], [], true);
    const listed = applyWorkerEvent(applyWorkerEvent(workers, wStart("only", "harness-tester", "시험 쓰기", 5000)), wEnd("only", "done", 8000));
    const inChat = applyWorkerEvent([], wStart("a", "harness-builder-ui", "목록", 1000));
    const items = buildSummaryLog({ chat: chatOf([{ event: wStart("a", "harness-builder-ui", "목록", 1000) }]), workers: [...inChat, ...listed] });
    expect(items.map((entry) => entry.text)).toEqual(["단추에게 맡겼어요 — 목록", "깨비에게 맡겼어요 — 시험 쓰기", "깨비가 일을 끝내고 돌아왔어요"]);
  });

  it("시각순 — 먼저 시작한 작업자의 끝은 그 뒤에 일어난 일(카드) 뒤에 온다. 같은 시각이면 만든 순서", () => {
    const items = log([
      { event: started(), atMs: 1000 },
      { event: wStart("a", "harness-builder-ui", "목록", 2000) },
      { event: perm("p1"), atMs: 3000 },
      { event: wEnd("a", "done", 4000) },
      { event: turnEnded("interrupted"), atMs: 5000 },
    ]);
    expect(items.map((entry) => entry.kind)).toEqual(["start", "assign", "ask", "back", "stop"]);
    expect(items.map((entry) => entry.atMs)).toEqual([1000, 2000, 3000, 4000, 5000]);
  });

  it("끝난 때를 모르는 멈춤(앱이 꺼진 사이)은 시작 바로 뒤, 시각을 모르는 줄은 앞 줄의 시각을 따라간다", () => {
    const items = log([
      { event: wStart("a", "harness-builder-ui", "목록", 2000), worker: { status: "stopped", endedAtMs: null } },
      { event: perm("p1") },
      { event: turnEnded("limit"), atMs: 9000 },
    ]);
    expect(items.map((entry) => entry.kind)).toEqual(["assign", "stop", "ask", "stop"]);
    expect(items[1]?.atMs).toBeNull();
  });

  it("세션 시작은 그 앞 줄 뒤에 놓인다 (여러 세션)", () => {
    const items = log([
      { event: started(), atMs: 1000 },
      { event: turnEnded("error"), atMs: 2000 },
      { event: started(true), atMs: 3000 },
      { event: turnEnded("interrupted"), atMs: 4000 },
    ]);
    expect(items.map((entry) => entry.kind)).toEqual(["start", "error", "start", "stop"]);
    expect(items[2]?.text).toContain("이어서");
  });

  it("각 항목의 열쇠는 겹치지 않고 다시 만들어도 같다", () => {
    const items: Item[] = [{ event: started(), atMs: 1 }, { event: wStart("a", "harness-tester", "x", 2) }, { event: wEnd("a", "done", 3) }, { event: perm("p1"), atMs: 4 }];
    const first = log(items).map((entry) => entry.key);
    expect(new Set(first).size).toBe(first.length);
    expect(log(items).map((entry) => entry.key)).toEqual(first);
  });

  it("빈 대화 → 빈 로그", () => {
    expect(buildSummaryLog({ chat: emptyChat() })).toEqual([]);
  });
});

describe("내 연결 (P9-05)", () => {
  const mine = { cats: { main: "nabi", "harness-builder-ui": "gureum" }, labels: {} };

  it("오케스트레이터 줄(시작 · 멈춤 · 갑자기 멈춤)은 바뀐 고양이와 그 이름으로", () => {
    const items = buildSummaryLog({ chat: chatOf([{ event: started(), atMs: 1 }, { event: turnEnded("limit"), atMs: 2 }]), mine });
    expect(items.map((entry) => entry.cat)).toEqual(["nabi", "nabi"]);
    expect(items[0]?.text).toBe("나비가 일을 시작했어요");
  });

  it("작업자 줄은 내 연결의 고양이 · 그 이름으로", () => {
    const items = buildSummaryLog({ chat: chatOf([{ event: wStart("a", "harness-builder-ui", "목록 화면", 1000) }]), mine });
    expect(items[0]).toMatchObject({ cat: "gureum", kind: "assign" });
    expect(items[0]?.text).toContain("구름");
  });
});
