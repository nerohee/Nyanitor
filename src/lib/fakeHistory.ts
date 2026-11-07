// 브라우저(`npm run dev`)에서 채팅 · 츄르 화면이 돌도록 하는 가짜 채팅 기록 · 츄르 요약. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/history/`)와 같은 명령 · 결과 모양을 흉내 낸다. 고르는 법은 기존 가짜(`fakeProjects.ts`)처럼 주소 쿼리:
//   ?history=full (기본) — 1번 프로젝트("고양이 앨범")에 기록이 가득 있다: 저장하는 이벤트 종류가 다 나오고, 답한 카드(허용 · 항상 허용 · 거부 · 다르게 말하기 · 질문 답) ·
//     취소된 카드 · 답 없이 지나간(expired) 카드가 있다. 앞쪽에는 쪽 나누기를 볼 수 있게 옛 대화가 길게 있다. 나머지 프로젝트는 비어 있다.
//   ?history=empty — 모든 프로젝트가 비어 있고 츄르도 0
//   ?history=apikey — `full` 과 같되 츄르가 키로 과금된 턴 (비용이 "참고용 추정" 이 아니다)
//   주소 쿼리 `?workers=one|two|background|permission` (P7-02, `fakeWorkers.ts`) 이 있으면 `full` 기록에 작업자 항목이 더해진다 — 마침 · 실패 · 멈춤(끝 알림 없이 앱이 다시 켜짐). 기본에는 없다.
// 가짜 세션(`fakeClaude.ts`)이 돌고 있으면 그 턴들이 츄르의 "지금 세션" 에 더해진다. 시험은 `reset({...})` 로 쿼리 대신 값을 정한다.
import { AppError, CHAT_PAGE_MAX, type ChatEntry, type ChatListEvent, type ChatPage, type ChatWorkerState, type ClaudeEvent, type ProjectUsage, type UsageSum, type UsageSummary } from "./ipc-types";
import { FAKE_WORKERS, parseFakeWorkersQuery, type FakeWorkerSpec } from "./fakeWorkers";
import { fakeProjects } from "./fakeProjects";

type Handler = (args: Record<string, unknown>) => unknown;

export type FakeHistoryMode = "full" | "empty" | "apikey";
const HISTORY_MODES: readonly FakeHistoryMode[] = ["full", "empty", "apikey"];

/** 주소 쿼리 → 가짜 설정. 모르는 값은 기본값 (`full`). */
export function parseFakeHistoryQuery(search: string): FakeHistoryMode {
  const value = new URLSearchParams(search).get("history");
  return HISTORY_MODES.find((mode) => mode === value) ?? "full";
}

/** 가짜 세션이 턴 하나를 끝낼 때마다 더하는 토큰 · 비용 (`fakeClaude.ts` 의 턴 요약과 같은 값) */
export const FAKE_TURN_USAGE = { inputTokens: 3, outputTokens: 42, cacheCreationInputTokens: 0, cacheReadInputTokens: 1200 } as const;
export const FAKE_TURN_COST = 0.0021;

/** 가짜 세션이 지금 돌고 있는 것 (`fakeClaude.liveRun()`) */
export interface FakeLiveRun {
  projectId: number;
  sessionId: string | null;
  turns: number;
}

const NOW = 1_800_000_000;

// ── 채팅 기록 ──

const ANSWERED = (requestId: string, rest: Partial<Extract<ClaudeEvent, { type: "request_answered" }>> & { kind: Extract<ClaudeEvent, { type: "request_answered" }>["kind"] }): Extract<ClaudeEvent, { type: "request_answered" }> => ({
  type: "request_answered",
  requestId,
  text: null,
  answers: null,
  ...rest,
});

const USAGE = { inputTokens: 3, outputTokens: 640, cacheCreationInputTokens: 1800, cacheReadInputTokens: 24_000 };

function turnEnded(outcome: "success" | "interrupted" | "error" | "limit", extra: Partial<Extract<ChatListEvent, { type: "turn_ended" }>> = {}): ChatListEvent {
  return {
    type: "turn_ended",
    outcome,
    subtype: outcome === "success" ? "success" : "error_during_execution",
    isError: outcome !== "success",
    terminalReason: outcome === "interrupted" ? "aborted_tools" : outcome === "success" ? "completed" : null,
    result: null,
    errors: [],
    apiErrorStatus: outcome === "limit" ? 429 : null,
    durationMs: 8400,
    numTurns: 3,
    usage: USAGE,
    costUsd: 0.042,
    totalCostUsd: 0.042,
    ...extra,
  };
}

/** 앞쪽의 옛 대화 — 쪽 나누기를 볼 수 있게 길다 (사용자 말 · 답 · 턴 끝이 되풀이된다) */
function olderConversation(): ChatListEvent[] {
  const events: ChatListEvent[] = [];
  for (let n = 1; n <= 24; n += 1) {
    events.push({ type: "user_message", text: `옛 대화 ${n} — 사진 목록 화면을 조금 더 다듬어 줘`, deferred: false });
    events.push({ type: "text", text: `옛 대화 ${n} — 목록 간격을 넓히고 날짜 줄을 위로 옮겼어요.` });
    events.push(turnEnded("success"));
  }
  return events;
}

type Fixed = { event: ChatListEvent; request?: ChatEntry["request"]; truncated?: boolean; worker?: ChatWorkerState };

/** 기록에 있는 작업자 한 번: 메인의 `Agent` 호출 줄 + 작업자 시작 항목 (끝은 항목의 `worker` 로 합쳐져 있다) */
function workerRows(id: string, spec: FakeWorkerSpec, background: boolean, worker: ChatWorkerState, startedAtMs: number): Fixed[] {
  return [
    { event: { type: "tool_use", toolUseId: id, tool: "Agent", summary: spec.description } },
    { event: { type: "worker_started", toolUseId: id, agentId: `agent-${id}`, name: spec.name, description: spec.description, background, depth: 1, atMs: startedAtMs }, worker },
  ];
}

/** 작업자 항목들 — 마침 · 실패 · 멈춤 (앱이 꺼진 사이에 끝 알림을 못 받아 "멈춤" 이 된 것) */
function recentWorkers(): Fixed[] {
  const at = (secondsAgo: number) => (NOW - secondsAgo) * 1000;
  return [
    ...workerRows("toolu-agent-h1", FAKE_WORKERS.tester, false, { status: "done", endedAtMs: at(1500) }, at(1560)),
    ...workerRows("toolu-agent-h2", FAKE_WORKERS.ui, true, { status: "failed", endedAtMs: at(1400) }, at(1530)),
    ...workerRows("toolu-agent-h3", FAKE_WORKERS.system, true, { status: "stopped", endedAtMs: null }, at(1500)),
  ];
}

/** 시제품(`variants/fixtures-workspace.ts`)의 채팅 항목 종류가 모두 나오는 대화 */
function recentConversation(withWorkers: boolean): Fixed[] {
  const permission = (requestId: string, tool: string, command: string | null, path: string | null, rule: string | null): ChatListEvent => ({
    type: "permission_request",
    requestId,
    toolUseId: `toolu-${requestId}`,
    tool,
    displayName: tool,
    description: command ?? path,
    command,
    path,
    cwd: "C:\\dev\\cat-album",
    alwaysRule: rule ? { rule, scope: "suggested", folder: null } : null,
  });
  const question = (requestId: string, header: string, text: string): ChatListEvent => ({
    type: "question_request",
    requestId,
    toolUseId: `toolu-${requestId}`,
    questions: [
      {
        question: text,
        header,
        multiSelect: false,
        options: [
          { label: "A", description: "추천", preview: null },
          { label: "B", description: null, preview: null },
          { label: "C", description: null, preview: null },
        ],
      },
    ],
  });
  return [
    // 앞 실행: 이어 하려던 세션이 CLI 에 없었다
    { event: { type: "session_started", projectId: 1, projectDir: "C:\\dev\\cat-album", pid: 3120, resumed: true, resumeSessionId: "00000000-0000-4000-8000-00000000dead", cliVersion: "2.1.296", model: "opus", effort: "high" } },
    { event: { type: "resume_not_found", sessionId: "00000000-0000-4000-8000-00000000dead" } },
    { event: turnEnded("error", { result: "No conversation found with session ID", errors: ["No conversation found with session ID: 00000000-0000-4000-8000-00000000dead"] }) },
    { event: { type: "session_ended", ended: "died", exitCode: 1, forced: false, midTurn: false, stderrTail: ["No conversation found with session ID"] } },
    // 이번 실행
    { event: { type: "session_started", projectId: 1, projectDir: "C:\\dev\\cat-album", pid: 4242, resumed: false, resumeSessionId: null, cliVersion: "2.1.296", model: "opus", effort: "high" } },
    { event: { type: "user_message", text: "/desktop-app requirements.md 를 읽고 시작해 줘", deferred: false } },
    { event: { type: "text", text: "요구사항을 읽었어요. 먼저 몇 가지만 물어볼게요." } },
    { event: question("fake-hist-q1", "범위", "사진은 어디에서 가져올까요?"), request: { status: "answered", answer: ANSWERED("fake-hist-q1", { kind: "answer", answers: { "사진은 어디에서 가져올까요?": "A" } }) } },
    { event: { type: "text", text: "알겠어요. 폴더에서 읽는 걸로 할게요." } },
    { event: { type: "tool_use", toolUseId: "toolu-1", tool: "Read", summary: "requirements.md" } },
    ...(withWorkers ? recentWorkers() : []),
    { event: permission("fake-hist-p1", "Bash", "npm install exifr", null, "Bash(npm install:*)"), request: { status: "answered", answer: ANSWERED("fake-hist-p1", { kind: "always_allow" }) } },
    { event: permission("fake-hist-p2", "Write", null, "C:\\dev\\cat-album\\src\\gallery.ts", "Edit(/src/**)"), request: { status: "answered", answer: ANSWERED("fake-hist-p2", { kind: "allow" }) } },
    { event: permission("fake-hist-p3", "Write", null, "C:\\dev\\cat-album\\.env", null), request: { status: "answered", answer: ANSWERED("fake-hist-p3", { kind: "deny", text: "그 파일은 건드리지 마" }) } },
    // 실패한 도구 결과는 기록에 글 없이 저장된다 (D-48) — 진짜 `history/record.rs` 와 같은 모양
    { event: { type: "tool_result", toolUseId: "toolu-2", isError: true, summary: "" } },
    { event: permission("fake-hist-p4", "Bash", "git push origin main", null, null), request: { status: "answered", answer: ANSWERED("fake-hist-p4", { kind: "tell", text: "푸시는 내가 할게, 커밋까지만 해 줘" }) } },
    { event: turnEnded("interrupted") },
    { event: { type: "user_message", text: "푸시는 내가 할게, 커밋까지만 해 줘", deferred: true } },
    { event: permission("fake-hist-p5", "Bash", "git commit -m '사진 목록'", null, "Bash(git commit:*)"), request: { status: "cancelled", answer: null } },
    { event: { type: "rate_limit", status: "allowed_warning", rateLimitType: "five_hour", resetsAt: NOW + 3600, fiveHourUtilization: 0.86, sevenDayUtilization: 0.31 } },
    { event: { type: "text", text: "계획을 정리했어요. 승인해 주세요." } },
    // 앱이 꺼진 사이에 지나간 카드 — 답할 수 없다
    { event: question("fake-hist-q2", "승인", "이 계획으로 시작할까요?"), request: { status: "expired", answer: null } },
    { event: permission("fake-hist-p6", "Bash", "npm run build", null, "Bash(npm run build:*)"), request: { status: "expired", answer: null } },
    { event: turnEnded("limit", { result: "You've hit your limit", apiErrorStatus: 429 }) },
    { event: { type: "session_ended", ended: "died", exitCode: null, forced: true, midTurn: true, stderrTail: [] } },
  ];
}

function buildEntries(withWorkers: boolean): ChatEntry[] {
  const all: Fixed[] = [...olderConversation().map((event) => ({ event })), ...recentConversation(withWorkers)];
  return all.map((fixed, index) => ({
    id: index + 1,
    at: NOW - (all.length - index) * 90,
    sessionId: index < 72 ? "00000000-0000-4000-8000-0000000000a1" : "00000000-0000-4000-8000-0000000000a2",
    truncated: fixed.truncated ?? false,
    event: fixed.event,
    request: fixed.request ?? (fixed.event.type === "permission_request" || fixed.event.type === "question_request" ? { status: "expired", answer: null } : null),
    // 작업자 시작 항목에만 (진짜 `chat::read_page` 처럼 끝은 여기로 합쳐지고 `worker_ended` 항목은 따로 나오지 않는다)
    ...(fixed.worker ? { worker: fixed.worker } : {}),
  }));
}

/** 진짜 `chat::read_page` 와 같다: `before` 보다 앞선 것 중 가장 최근 `limit` 개, 오래된 것이 앞 */
export function pageOf(entries: readonly ChatEntry[], before: number | null, limit: number): ChatPage {
  const older = entries.filter((entry) => before === null || entry.id < before);
  const taken = older.slice(Math.max(0, older.length - limit));
  return { entries: taken, hasMore: older.length > limit };
}

// ── 츄르 ──

function makeSum(parts: { turns: number; input: number; output: number; creation: number; read: number; cost: number; billing: "subscription" | "key" }): UsageSum {
  const subscription = parts.billing === "subscription" ? parts.turns : 0;
  const key = parts.billing === "key" ? parts.turns : 0;
  return {
    turns: parts.turns,
    inputTokens: parts.input,
    outputTokens: parts.output,
    cacheCreationInputTokens: parts.creation,
    cacheReadInputTokens: parts.read,
    totalTokens: parts.input + parts.output + parts.creation + parts.read,
    costUsd: Math.round(parts.cost * 1e9) / 1e9,
    subscriptionTurns: subscription,
    apiKeyTurns: key,
    referenceOnly: parts.turns > key,
  };
}

const ZERO = makeSum({ turns: 0, input: 0, output: 0, creation: 0, read: 0, cost: 0, billing: "subscription" });

function addSums(a: UsageSum, b: UsageSum): UsageSum {
  const turns = a.turns + b.turns;
  const apiKeyTurns = a.apiKeyTurns + b.apiKeyTurns;
  const parts = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
  return {
    turns,
    ...parts,
    totalTokens: parts.inputTokens + parts.outputTokens + parts.cacheCreationInputTokens + parts.cacheReadInputTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e9) / 1e9,
    subscriptionTurns: a.subscriptionTurns + b.subscriptionTurns,
    apiKeyTurns,
    referenceOnly: turns > apiKeyTurns,
  };
}

/** 가짜 세션이 돈 만큼의 합 */
function liveSum(turns: number, billing: "subscription" | "key"): UsageSum {
  return makeSum({
    turns,
    input: FAKE_TURN_USAGE.inputTokens * turns,
    output: FAKE_TURN_USAGE.outputTokens * turns,
    creation: FAKE_TURN_USAGE.cacheCreationInputTokens * turns,
    read: FAKE_TURN_USAGE.cacheReadInputTokens * turns,
    cost: FAKE_TURN_COST * turns,
    billing,
  });
}

/** 먼저 있던 츄르 (프로젝트 번호 → 오늘 · 전체) */
function baseUsage(billing: "subscription" | "key"): Map<number, { today: UsageSum; total: UsageSum }> {
  return new Map([
    [
      1,
      {
        today: makeSum({ turns: 6, input: 22, output: 3900, creation: 10_800, read: 144_000, cost: 0.252, billing }),
        total: makeSum({ turns: 48, input: 190, output: 31_000, creation: 92_000, read: 1_150_000, cost: 2.016, billing }),
      },
    ],
    [
      2,
      {
        today: makeSum({ turns: 3, input: 9, output: 1500, creation: 4300, read: 61_000, cost: 0.11, billing }),
        total: makeSum({ turns: 11, input: 40, output: 6200, creation: 15_000, read: 210_000, cost: 0.4, billing }),
      },
    ],
  ]);
}

export function createFakeHistory() {
  /** 시험이 정한 값. 없으면 부를 때마다 주소 쿼리를 읽는다 */
  let override: FakeHistoryMode | null = null;
  const mode = (): FakeHistoryMode => override ?? parseFakeHistoryQuery(typeof window === "undefined" ? "" : window.location.search);
  /** 시험이 정한 "작업자 항목이 있는가". 없으면 주소 쿼리 `?workers=` 가 있는지 본다 */
  let workersOverride: boolean | null = null;
  const withWorkers = (): boolean => workersOverride ?? parseFakeWorkersQuery(typeof window === "undefined" ? "" : window.location.search) !== "none";

  const entriesOf = (projectId: number): ChatEntry[] => (mode() === "empty" || projectId !== 1 ? [] : buildEntries(withWorkers()));

  /** 번호가 숫자(정수)가 아니면 거절 — Rust 의 `i64` 해석과 같은 쪽 */
  const integer = (value: unknown, what: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new AppError("invalid_input", `${what} is not a number`);
    return value;
  };

  /** 쓸 수 있는 `liveRun` 제공자를 받아 명령 처리기를 만든다 (가짜 세션 모듈이 건네 준다) */
  function handlersFor(liveRun: () => FakeLiveRun | null): Record<string, Handler> {
    return {
      project_chat_history: (args): ChatPage => {
        const id = integer(args.id, "project id");
        const before = args.before === null || args.before === undefined ? null : integer(args.before, "before");
        const limit = integer(args.limit, "limit");
        if (limit < 1) throw new AppError("invalid_input", "invalid input: limit must be at least 1");
        // 등록된 프로젝트만 (진짜는 DB 가 안 열리면 `db_unavailable`, 없는 번호면 `project_not_found`)
        fakeProjects.requireRegistered(id);
        return pageOf(entriesOf(id), before, Math.min(limit, CHAT_PAGE_MAX));
      },

      app_usage_summary: (): UsageSummary => {
        fakeProjects.checkReadable();
        const billing = mode() === "apikey" ? "key" : "subscription";
        const base = mode() === "empty" ? new Map<number, { today: UsageSum; total: UsageSum }>() : baseUsage(billing);
        const live = liveRun();
        const liveTurns = live ? liveSum(live.turns, billing) : ZERO;
        const rows = new Map<number, { today: UsageSum; total: UsageSum }>();
        for (const [projectId, sums] of base) if (fakeProjects.isRegistered(projectId)) rows.set(projectId, sums);
        if (live && live.turns > 0 && fakeProjects.isRegistered(live.projectId)) {
          const before = rows.get(live.projectId) ?? { today: ZERO, total: ZERO };
          rows.set(live.projectId, { today: addSums(before.today, liveTurns), total: addSums(before.total, liveTurns) });
        }
        const projects: ProjectUsage[] = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([projectId, sums]) => ({ projectId, ...sums }));
        const today = projects.reduce((sum, project) => addSums(sum, project.today), ZERO);
        return {
          // 이 PC 의 자정 (유닉스 초)
          since: Math.floor(new Date().setHours(0, 0, 0, 0) / 1000),
          today,
          projects,
          session: live ? { projectId: live.projectId, sessionId: live.sessionId, usage: liveTurns } : null,
        };
      },
    };
  }

  return {
    handlersFor,
    /** 시험용: 쿼리 대신 값을 정한다 (인자 없이 부르면 다시 쿼리를 읽는다) */
    reset(next?: FakeHistoryMode, options?: { workers?: boolean }) {
      override = next ?? null;
      workersOverride = options?.workers ?? null;
    },
  };
}

export const fakeHistory = createFakeHistory();
