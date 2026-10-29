// 채팅 기록 · 세션 츄르 IPC (P6-03) — 명령 이름 · 보내는 값(프로젝트 번호와 쪽 나누기 값뿐), 브라우저 가짜(모든 종류 · 답한 카드 · 지나간 카드 · 쪽 나누기 · 빈 프로젝트 · 츄르 합 · 주소 쿼리).
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_TURN_USAGE, fakeHistory, pageOf, parseFakeHistoryQuery } from "./fakeHistory";
import { fakeClaude } from "./fakeClaude";
import { fakeProjects } from "./fakeProjects";
import { CHAT_PAGE_MAX, ipc, type ChatEntry, type ChatListEventType, type ClaudeEvent } from "./ipc";

function resetFakes() {
  fakeHistory.reset();
  fakeProjects.reset();
  fakeClaude.reset();
}

beforeEach(resetFakes);

afterEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
  resetFakes();
});

/** 쪽을 끝까지 올라가며 모은다 (오래된 것이 앞) */
async function readAll(id: number, limit: number): Promise<ChatEntry[]> {
  const all: ChatEntry[] = [];
  let before: number | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await ipc.projectChatHistory(id, before, limit);
    all.unshift(...page.entries);
    before = page.entries[0]?.id ?? before;
    if (!page.hasMore) return all;
  }
  throw new Error("the history never ended");
}

describe("채팅 기록 · 츄르 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 부르고, 프로젝트 번호와 쪽 나누기 값만 보낸다 (경로 없음)", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    await ipc.projectChatHistory(3, null, 50);
    await ipc.projectChatHistory(3, 120, 25);
    await ipc.appUsageSummary();
    expect(handler.mock.calls).toEqual([
      ["project_chat_history", { id: 3, before: null, limit: 50 }],
      ["project_chat_history", { id: 3, before: 120, limit: 25 }],
      ["app_usage_summary", {}],
    ]);
  });

  it("Rust 가 돌려준 모양을 그대로 넘긴다 (지나간 카드 · 합)", async () => {
    const page = {
      entries: [
        {
          id: 7,
          at: 1,
          sessionId: null,
          truncated: false,
          event: { type: "text", text: "안녕" },
          request: null,
        },
      ],
      hasMore: false,
    };
    mockIPC((command) => (command === "project_chat_history" ? page : null));
    await expect(ipc.projectChatHistory(1, null, 10)).resolves.toEqual(page);
  });

  it("Rust 오류(프로젝트 없음 · DB 못 씀)를 같은 종류의 AppError 로 받는다", async () => {
    mockIPC(() => {
      throw { kind: "project_not_found", message: "project not found: 9" };
    });
    await expect(ipc.projectChatHistory(9, null, 10)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.appUsageSummary()).rejects.toMatchObject({ kind: "project_not_found" });
  });
});

describe("채팅 기록 ipc (브라우저 가짜 모드)", () => {
  it("1번 프로젝트의 기록에는 저장하는 이벤트 종류가 모두 나온다", async () => {
    const entries = await readAll(1, 30);
    const types = new Set(entries.map((entry) => entry.event.type));
    const expected: ChatListEventType[] = [
      "session_started",
      "user_message",
      "text",
      "tool_use",
      "tool_result",
      "permission_request",
      "question_request",
      "turn_ended",
      "rate_limit",
      "resume_not_found",
      "session_ended",
    ];
    for (const type of expected) expect(types.has(type), type).toBe(true);
    // 목록에는 답 · 취소가 따로 나오지 않고 카드의 상태로 합쳐진다
    expect(types.has("request_answered" as never)).toBe(false);
    expect(types.has("request_cancelled" as never)).toBe(false);
    // 번호는 늘기만 하고 시각도 거꾸로 가지 않는다
    expect(entries.every((entry, i) => i === 0 || (entry.id > (entries[i - 1] as ChatEntry).id && entry.at >= (entries[i - 1] as ChatEntry).at))).toBe(true);
    // 사용자 메시지 두 종류 (다르게 말하기가 중단된 턴 뒤에 보낸 것)
    expect(entries.some((entry) => entry.event.type === "user_message" && entry.event.deferred)).toBe(true);
  });

  it("카드 상태가 모두 나온다 — 답함(답 종류 다섯 가지) · 취소됨 · 지나감, 그리고 카드가 아닌 항목에는 상태가 없다", async () => {
    const entries = await readAll(1, 30);
    const cards = entries.filter((entry) => entry.request !== null);
    expect(cards.every((entry) => entry.event.type === "permission_request" || entry.event.type === "question_request")).toBe(true);
    expect(entries.filter((entry) => entry.request === null).every((entry) => entry.event.type !== "permission_request" && entry.event.type !== "question_request")).toBe(true);
    const statuses = new Set(cards.map((entry) => entry.request?.status));
    expect(statuses).toEqual(new Set(["answered", "cancelled", "expired"]));
    const kinds = new Set(cards.map((entry) => entry.request?.answer?.kind).filter((kind) => kind !== undefined));
    expect(kinds).toEqual(new Set(["answer", "always_allow", "allow", "deny", "tell"]));
    // 답은 카드의 요청 번호와 짝이고, 답한 것만 `answer` 가 있다
    for (const card of cards) {
      const request = card.request;
      if (!request) continue;
      const event = card.event;
      if (event.type !== "permission_request" && event.type !== "question_request") continue;
      if (request.status === "answered") expect(request.answer?.requestId).toBe(event.requestId);
      else expect(request.answer).toBeNull();
    }
    // 앱을 다시 켠 뒤라 답할 수 없는 카드는 맨 끝에 가까이 있다 (살아 있는 세션이 없으니 기다림(`pending`)은 없다)
    expect(statuses.has("pending")).toBe(false);
    // 답한 글이 남아 있다 (거부 이유 · 다르게 말하기 · 질문 답)
    const answers = cards.map((entry) => entry.request?.answer).filter((answer) => answer != null);
    expect(answers.find((answer) => answer.kind === "deny")?.text).toBeTruthy();
    expect(answers.find((answer) => answer.kind === "tell")?.text).toBeTruthy();
    expect(Object.keys(answers.find((answer) => answer.kind === "answer")?.answers ?? {})).toHaveLength(1);
  });

  it("쪽을 이으면 전체와 같다 — 최근 것부터, 쪽 안은 오래된 것이 앞, 빠지거나 겹치지 않는다", async () => {
    const whole = await ipc.projectChatHistory(1, null, CHAT_PAGE_MAX);
    expect(whole.entries.length).toBeGreaterThan(60);
    const first = await ipc.projectChatHistory(1, null, 10);
    expect(first.hasMore).toBe(true);
    expect(first.entries).toHaveLength(10);
    // 가장 최근 10개
    expect(first.entries.map((entry) => entry.id)).toEqual(whole.entries.slice(-10).map((entry) => entry.id));
    const joined = await readAll(1, 7);
    expect(joined.map((entry) => entry.id)).toEqual(whole.entries.map((entry) => entry.id));
    // 맨 앞보다 앞은 비었다
    const nothing = await ipc.projectChatHistory(1, whole.entries[0]?.id ?? 0, 10);
    expect(nothing).toEqual({ entries: [], hasMore: false });
    // 딱 맞는 쪽은 더 없다고 한다
    const exact = await ipc.projectChatHistory(1, null, whole.entries.length);
    expect(exact.hasMore).toBe(false);
  });

  it("너무 큰 쪽은 줄이고, 0 이나 숫자가 아닌 값은 거절한다", async () => {
    const big = await ipc.projectChatHistory(1, null, 100_000);
    expect(big.entries.length).toBeLessThanOrEqual(CHAT_PAGE_MAX);
    await expect(ipc.projectChatHistory(1, null, 0)).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.projectChatHistory(1, null, 1.5)).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.projectChatHistory("1" as unknown as number, null, 10)).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("빈 프로젝트는 빈 쪽이고, 등록 안 된 번호는 거절한다", async () => {
    await expect(ipc.projectChatHistory(2, null, 10)).resolves.toEqual({ entries: [], hasMore: false });
    await expect(ipc.projectChatHistory(99, null, 10)).rejects.toMatchObject({ kind: "project_not_found" });
    // 프로젝트를 빼면 그 기록도 없다
    await ipc.projectRemove(1);
    await expect(ipc.projectChatHistory(1, null, 10)).rejects.toMatchObject({ kind: "project_not_found" });
  });

  it("DB 를 못 읽는 가짜(?db=unavailable)에서는 db_unavailable", async () => {
    fakeProjects.reset({ db: "unavailable" });
    await expect(ipc.projectChatHistory(1, null, 10)).rejects.toMatchObject({ kind: "db_unavailable" });
    await expect(ipc.appUsageSummary()).rejects.toMatchObject({ kind: "db_unavailable" });
  });

  it("주소 쿼리 ?history=empty 는 모든 프로젝트를 비운다", async () => {
    window.history.replaceState({}, "", "/?history=empty");
    expect(parseFakeHistoryQuery(window.location.search)).toBe("empty");
    await expect(ipc.projectChatHistory(1, null, 10)).resolves.toEqual({ entries: [], hasMore: false });
    const summary = await ipc.appUsageSummary();
    expect(summary.today.turns).toBe(0);
    expect(summary.projects).toEqual([]);
    expect(summary.session).toBeNull();
  });

  it("쿼리 읽기: 모르는 값은 기본(full)", () => {
    expect(parseFakeHistoryQuery("")).toBe("full");
    expect(parseFakeHistoryQuery("?history=weird")).toBe("full");
    expect(parseFakeHistoryQuery("?history=apikey")).toBe("apikey");
  });

  it("pageOf 는 경계에서 Rust 와 같다 (before 는 그 번호보다 앞만)", () => {
    const make = (id: number): ChatEntry => ({ id, at: id, sessionId: null, truncated: false, event: { type: "text", text: String(id) }, request: null });
    const entries = [1, 2, 3, 4, 5].map(make);
    expect(pageOf(entries, null, 2).entries.map((e) => e.id)).toEqual([4, 5]);
    expect(pageOf(entries, 4, 2).entries.map((e) => e.id)).toEqual([2, 3]);
    expect(pageOf(entries, 2, 5)).toMatchObject({ hasMore: false });
    expect(pageOf(entries, 1, 5).entries).toEqual([]);
  });
});

describe("츄르 요약 ipc (브라우저 가짜 모드)", () => {
  it("오늘 합 = 프로젝트별 오늘 합의 합이고, 합 안의 값이 서로 맞는다", async () => {
    const summary = await ipc.appUsageSummary();
    expect(summary.projects.map((project) => project.projectId)).toEqual([1, 2]);
    const turns = summary.projects.reduce((sum, project) => sum + project.today.turns, 0);
    expect(summary.today.turns).toBe(turns);
    for (const sum of [summary.today, ...summary.projects.flatMap((project) => [project.today, project.total])]) {
      expect(sum.totalTokens).toBe(sum.inputTokens + sum.outputTokens + sum.cacheCreationInputTokens + sum.cacheReadInputTokens);
      expect(sum.subscriptionTurns + sum.apiKeyTurns).toBeLessThanOrEqual(sum.turns);
    }
    for (const project of summary.projects) expect(project.total.turns).toBeGreaterThanOrEqual(project.today.turns);
    // 구독이라 "참고용 추정"
    expect(summary.today.referenceOnly).toBe(true);
    expect(summary.today.subscriptionTurns).toBe(summary.today.turns);
    // 돌고 있는 세션이 없다
    expect(summary.session).toBeNull();
    // 이 PC 의 자정은 지금 이전이고 하루 안이다
    const now = Math.floor(Date.now() / 1000);
    expect(summary.since).toBeLessThanOrEqual(now);
    expect(now - summary.since).toBeLessThanOrEqual(86_400 + 3600);
  });

  it("?history=apikey 면 키로 과금된 턴이라 참고용 추정이 아니다", async () => {
    fakeHistory.reset("apikey");
    const summary = await ipc.appUsageSummary();
    expect(summary.today.apiKeyTurns).toBe(summary.today.turns);
    expect(summary.today.referenceOnly).toBe(false);
  });

  it("가짜 세션이 돌면 끝난 턴만큼 '지금 세션' 과 오늘 합이 늘고, 세션이 끝나면 지금 세션은 없다", async () => {
    const before = await ipc.appUsageSummary();
    await ipc.claudeSessionStart({ projectId: 1 });
    // 아직 턴이 없다 — 지금 세션은 0
    const started = await ipc.appUsageSummary();
    expect(started.session).toMatchObject({ projectId: 1, sessionId: null });
    expect(started.session?.usage.turns).toBe(0);
    expect(started.today).toEqual(before.today);

    const events: ClaudeEvent[] = [];
    const stop = await ipc.onClaudeEvent((event) => events.push(event));
    await ipc.claudeSessionSend("안녕");
    await vi.waitFor(() => expect(events.some((event) => event.type === "permission_request")).toBe(true));
    const card = events.find((event) => event.type === "permission_request");
    if (card?.type !== "permission_request") throw new Error("no permission card");
    await ipc.claudeSessionRespond(card.requestId, { kind: "allow" });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn_ended")).toBe(true));
    stop();

    const running = await ipc.appUsageSummary();
    expect(running.session?.usage.turns).toBe(1);
    expect(running.session?.usage.outputTokens).toBe(FAKE_TURN_USAGE.outputTokens);
    expect(running.session?.sessionId).toBeTruthy();
    expect(running.today.turns).toBe(before.today.turns + 1);
    const project = running.projects.find((entry) => entry.projectId === 1);
    const beforeProject = before.projects.find((entry) => entry.projectId === 1);
    expect(project?.total.turns).toBe((beforeProject?.total.turns ?? 0) + 1);

    await ipc.claudeSessionStop();
    expect((await ipc.appUsageSummary()).session).toBeNull();
  });

  it("가짜 세션에서 답하면 `request_answered` 가 요청 바로 다음에 나가고, 글은 다듬은 값이다", async () => {
    await ipc.claudeSessionStart({ projectId: 1 });
    const events: ClaudeEvent[] = [];
    const stop = await ipc.onClaudeEvent((event) => events.push(event));
    await ipc.claudeSessionSend("질문 하나만");
    await vi.waitFor(() => expect(events.some((event) => event.type === "question_request")).toBe(true));
    const question = events.find((event) => event.type === "question_request");
    if (question?.type !== "question_request") throw new Error("no question card");
    const [first, second] = question.questions;
    await ipc.claudeSessionRespond(question.requestId, {
      kind: "answer",
      answers: { [first?.question ?? ""]: "  직접 쓴 글  ", [second?.question ?? ""]: ["A", " B "] },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "turn_ended")).toBe(true));
    stop();
    const types = events.map((event) => event.type);
    const at = types.indexOf("request_answered");
    expect(at).toBeGreaterThan(types.indexOf("question_request"));
    const answered = events[at];
    if (answered?.type !== "request_answered") throw new Error("no answer event");
    expect(answered.requestId).toBe(question.requestId);
    expect(answered.kind).toBe("answer");
    expect(answered.answers).toEqual({ [first?.question ?? ""]: "직접 쓴 글", [second?.question ?? ""]: ["A", "B"] });
    expect(answered.text).toBeNull();
    await ipc.claudeSessionStop();
  });
});
