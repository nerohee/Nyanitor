// README 그림에 쓰는 장면 자료 중 파일로 놓는 것 — 하네스 · 사용량 · 가짜 CLI 녹화. 화면에 찍히는 글은 모두 여기서 정한다 (앱 사용자가 볼 만한 짧은 한국어 예시).
// 앱을 띄우기 **전에** 시험 폴더에 놓는다 (`prepareShotSandbox`, `run.ts` 가 부른다) — 사용량은 앱이 처음 읽은 값을 5분 기억하고, 하네스는 집이 처음 그려질 때 읽기 때문이다.
// 시각은 `CLOCK` 하나에서 나온다 — 화면 쪽 시계도 같은 값으로 고정한다 (`shotkit.ts`). 그래서 몇 번을 찍어도 "n분 전" · 초기화 시각이 같다.
import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "./sandbox.ts";

/** 그림 속 "지금" (이 PC 의 시계) — 낮 · 실제로 찍는 날보다 앞선 날 (앞선 날이라야 앱이 실제 시각으로 적은 "읽은 때" 가 "방금" 으로 읽힌다) */
export const CLOCK = { year: 2026, month: 10, day: 26, hour: 13, minute: 20 } as const;

/** 그림 속 "지금" + `minutes` 분 (유닉스 초) */
export function clockSeconds(minutes = 0): number {
  return Math.floor(new Date(CLOCK.year, CLOCK.month - 1, CLOCK.day, CLOCK.hour, CLOCK.minute + minutes, 0).getTime() / 1000);
}

// ───────────────────────── 하네스 · 에이전트 ─────────────────────────

const CONFIG_EXAMPLE = `{
  "language": "ko",
  "planner": {
    "model": "opus",
    "effort": "high"
  },
  "agents": {
    "designer": "harness-designer",
    "ui": "harness-builder-ui",
    "system": "harness-builder-system",
    "tester": "harness-tester",
    "helper": "harness-helper",
    "reviewer": "harness-reviewer"
  }
}
`;

interface AgentSeed {
  name: string;
  description: string;
  model: string;
  effort: string;
  color: string;
  body: string;
}

const AGENTS: AgentSeed[] = [
  {
    name: "harness-designer",
    description: "디자이너. 화면의 분위기와 시안을 정하고, 만든 화면이 시안과 맞는지 살펴본다.",
    model: "opus",
    effort: "high",
    color: "purple",
    body: "너는 디자이너다.\n\n- 시안은 서로 다르게 세 가지를 그린다.\n- 색 · 글자 · 간격은 한 번 정하면 토큰으로 둔다.\n- 만든 화면은 시안과 나란히 놓고 본다.\n",
  },
  {
    name: "harness-builder-ui",
    description: "화면 구현자. 고른 시안대로 화면과 부품을 만들고, 창 크기와 키보드 사용을 챙긴다.",
    model: "sonnet",
    effort: "medium",
    color: "blue",
    body: "너는 화면 구현자다.\n\n## 일하는 법\n- 시안과 디자인 토큰을 그대로 따른다.\n- 창이 좁아져도 깨지지 않게 만든다.\n- 마우스 없이 키보드만으로도 쓸 수 있게 한다.\n\n## 하지 않는 것\n- 시안에 없는 화면을 마음대로 더하지 않는다.\n",
  },
  {
    name: "harness-builder-system",
    description: "시스템 엔지니어. 저장 · 서버 · 권한처럼 틀리면 비용이 큰 부분을 지시서대로 구현한다.",
    model: "opus",
    effort: "high",
    color: "green",
    body: "너는 시스템 엔지니어다.\n\n- 실패하는 경우를 먼저 따져 본다.\n- 입력은 받는 쪽에서 다시 확인한다.\n",
  },
  {
    name: "harness-tester",
    description: "시험 작성자. 경계와 실패 상황부터 시험을 쓰고, 버그는 재현하는 시험으로 남긴다.",
    model: "sonnet",
    effort: "high",
    color: "orange",
    body: "너는 시험 작성자다.\n\n- 잘 되는 경우보다 안 되는 경우를 먼저 쓴다.\n",
  },
  {
    name: "harness-helper",
    description: "정리 담당. 판단이 필요 없는 문서 정리와 이름 바꾸기를 빠르고 정확하게 한다.",
    model: "haiku",
    effort: "low",
    color: "yellow",
    body: "너는 정리 담당이다.\n\n- 시킨 일만 한다.\n",
  },
  {
    name: "harness-reviewer",
    description: "감사관. 고치지 않고 찾기만 한다. 보안 · 데이터 손실 · 접근성 · 시험 공백을 점검한다.",
    model: "opus",
    effort: "high",
    color: "red",
    body: "너는 감사관이다.\n\n- 고치지 않고 찾아서 알려 준다.\n",
  },
];

function agentFile(agent: AgentSeed): string {
  return `---\nname: ${agent.name}\ndescription: ${agent.description}\nmodel: ${agent.model}\neffort: ${agent.effort}\ncolor: ${agent.color}\n---\n\n${agent.body}`;
}

function put(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * 하네스를 "설치된" 모양으로 둔다 — 집의 고양이 일곱 마리 (설정 폴더 `agents/` + `harness/`) 와 「내 수정」 의 원본 (`<하네스 폴더>/repo`).
 * 둘 다 시험 폴더 안이다 (실제 `~/.claude` 는 건드리지 않는다).
 */
export function seedInstalledHarness(sandbox: Sandbox): void {
  const agents = Object.fromEntries(AGENTS.map((agent) => [`agents/${agent.name}.md`, agentFile(agent)]));
  put(sandbox.claudeConfig, { "harness/config.example.json": CONFIG_EXAMPLE, ...agents });
  put(path.join(sandbox.harnessHome, "repo"), {
    "config.example.json": CONFIG_EXAMPLE,
    "agents/_common/rules.md": "공통 규칙\n",
    "skills/desktop-app/SKILL.md": "---\nname: desktop-app\ndescription: 데스크톱 앱 만들기\n---\n\n앱을 만든다.\n",
    "skills/web-full/SKILL.md": "---\nname: web-full\ndescription: 웹 앱 만들기\n---\n\n웹 앱을 만든다.\n",
    ...agents,
  });
  // 「내 수정」 에 보일 "덧붙일 지시" (원본 글 끝에 붙는 내 글)
  put(path.join(sandbox.harnessHome, "custom"), {
    "agents/harness-builder-ui.append.md": "- 버튼 글자는 크게, 누르면 바로 반응이 보이게 만든다.\n- 새 색은 더하지 않고 정해 둔 토큰만 쓴다.\n",
  });
}

// ───────────────────────── 사용량 (`/usage`) ─────────────────────────

/** 시험 폴더의 `usage.jsonl` 을 그림용 숫자로 바꾼다 — 5시간 38% (오늘 오후 4:30 초기화) · 주간 21% (3일 뒤 오전 9:00) */
export function writeUsageFixture(fixturesDir: string): void {
  const file = path.join(fixturesDir, "usage.jsonl");
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const at = (day: number, hour: number, minute: number) => new Date(CLOCK.year, CLOCK.month - 1, day, hour, minute, 0).toISOString();
  let changed = 0;
  for (const line of lines) {
    // 앱이 읽는 곳은 `/usage` 답 줄에 붙은 `usage_report` (`usage/fetch.rs`)
    const report = (line.msg as { usage_report?: { rate_limits?: { limits?: Record<string, unknown>[] } } } | undefined)?.usage_report;
    const limits = report?.rate_limits?.limits;
    if (!limits) continue;
    for (const row of limits) {
      if (row.kind === "session") Object.assign(row, { percent: 38, resets_at: at(CLOCK.day, 16, 30), severity: "normal" });
      if (row.kind === "weekly_all") Object.assign(row, { percent: 21, resets_at: at(CLOCK.day + 3, 9, 0), severity: "normal" });
    }
    changed += 1;
  }
  if (changed === 0) throw new Error("usage.jsonl 의 모양이 바뀌었다 — usage_report 의 rate_limits.limits 를 못 찾았다");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

// ───────────────────────── 가짜 CLI 녹화 ─────────────────────────

type Line = Record<string, unknown>;

const SESSION = "00000000-0000-4000-8000-000000000001";
const MODEL = "claude-opus-5-1";

/** 사용자가 보내는 말 — 시험 (`readme.shot.ts`) 이 이 글을 그대로 보낸다 */
export const FIRST_MESSAGE = "고양이 카페 예약 앱을 만들고 싶어요.";

const ANSWER = `좋아요! 요구사항을 정리했어요. 두부와 구름이 마무리하는 동안 다음 단계 승인을 받을게요.`;

const APPROVAL_QUESTION = `단계 승인 — P2 예약 화면 시안
- 무엇을: 손님이 쓸 예약 화면의 모양을 세 가지로 그려 보여 드려요.
- 왜 지금: 요구사항이 정리돼서, 모양부터 골라 두면 만들 때 덜 헤매요.
- 산출물: 시안 세 장과 고르기 질문 하나.
- 하지 않는 것: 예약 저장 · 결제 · 알림 문자는 아직 만들지 않아요.`;

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

const recv = (msg: Line): Line => ({ dir: "recv", msg });
const send = (kind: "user"): Line => ({ dir: "send", msg: { type: kind, message: { role: "user", content: "" } } });

function init(): Line {
  return recv({
    type: "system",
    subtype: "init",
    cwd: "C:\\fake\\project",
    session_id: SESSION,
    tools: ["Agent", "AskUserQuestion", "Read", "Write", "Edit", "Bash"],
    mcp_servers: [],
    model: MODEL,
    permissionMode: "default",
    slash_commands: ["desktop-app", "web-full", "web-lite"],
    apiKeySource: "none",
    claude_code_version: "2.1.319",
    uuid: uuid(),
  });
}

function assistant(content: Line[], parent: string | null = null): Line {
  return recv({
    type: "assistant",
    message: { model: MODEL, id: `msg_${uuid()}`, type: "message", role: "assistant", content, stop_reason: null },
    parent_tool_use_id: parent,
    session_id: SESSION,
    uuid: uuid(),
  });
}

const text = (value: string): Line => ({ type: "text", text: value });

/** 한 턴의 끝 — 토큰 네 종의 합이 그 턴의 츄르다 (`total` 은 그 턴까지의 비용 합) */
function result(tokens: { input: number; output: number; created: number; read: number }, total: number, answer: string): Line {
  return recv({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    session_id: SESSION,
    total_cost_usd: total,
    usage: {
      input_tokens: tokens.input,
      cache_creation_input_tokens: tokens.created,
      cache_read_input_tokens: tokens.read,
      output_tokens: tokens.output,
    },
    result: answer,
    num_turns: 1,
    uuid: uuid(),
  });
}

/** 백그라운드 작업자 하나를 부른다 — 부르는 도구 호출 · 시작 알림 · 도구 결과 · 하는 일 */
function worker(name: string, description: string, doing: { tool: string; summary: string }): Line[] {
  const toolUseId = `toolu_${uuid().slice(-12)}`;
  const taskId = `a${uuid().slice(-12)}`;
  return [
    assistant([{ type: "tool_use", id: toolUseId, name: "Agent", input: { description, subagent_type: name, prompt: description, run_in_background: true }, caller: { type: "direct" } }]),
    recv({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      subagent_type: name,
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: "local_agent",
      uuid: uuid(),
      session_id: SESSION,
    }),
    recv({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: [{ type: "text", text: "작업자를 불렀어요. 끝나면 알려 줄게요." }] }] },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: uuid(),
    }),
    recv({
      type: "system",
      subtype: "task_progress",
      task_id: taskId,
      tool_use_id: toolUseId,
      description: doing.summary,
      subagent_type: name,
      usage: { total_tokens: 1800, tool_uses: 2, duration_ms: 2400 },
      last_tool_name: doing.tool,
      uuid: uuid(),
      session_id: SESSION,
    }),
  ];
}

/**
 * README 용 대화 — 한 번 말하면 먹물이 요구사항을 정리하고, 작업자 둘 (두부 · 구름) 이 일하는 중에 단계 승인을 묻고 답을 기다린다.
 * 답은 시험이 보내지 않는다 (카드가 떠 있는 채로 찍는다). 그래서 녹화는 승인 요청 뒤 응답 줄에서 멈춘다 — 그 뒤 줄은 답이 올 때만 나간다.
 */
export function readmeChat(): Line[] {
  counter = 0;
  const approval = [
    {
      question: APPROVAL_QUESTION,
      header: "P2 승인",
      options: [
        { label: "승인 (권장)", description: "시안 그리기를 시작해요" },
        { label: "고쳐서 다시", description: "범위를 다시 정해요" },
      ],
      multiSelect: false,
    },
  ];
  const approvalToolUse = `toolu_${uuid().slice(-12)}`;
  return [
    send("user"),
    init(),
    assistant([text(ANSWER)]),
    ...worker("harness-helper", "문서 정리", { tool: "Edit", summary: "문서 폴더 정리 중" }),
    ...worker("harness-reviewer", "요구사항 점검", { tool: "Read", summary: "빠진 경우 찾는 중" }),
    recv({
      type: "control_request",
      request_id: uuid(),
      request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", display_name: "AskUserQuestion", input: { questions: approval }, tool_use_id: approvalToolUse, requires_user_interaction: true },
    }),
    { dir: "send", msg: { type: "control_response", response: { subtype: "success", request_id: "never" } } },
    result({ input: 6, output: 934, created: 9060, read: 42300 }, 0.0274, "승인을 기다려요"),
    { dir: "exit", code: 0 },
  ];
}

/** 녹화를 시험 폴더의 `fixtures/<이름>.jsonl` 로 쓴다 */
export function writeRecording(fixturesDir: string, name: string, lines: Line[]): void {
  fs.writeFileSync(path.join(fixturesDir, `${name}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

/** 시험 폴더를 README 그림용으로 — 앱을 띄우기 전에 한 번 (`run.ts` 의 캡처 모드) */
export function prepareShotSandbox(sandbox: Sandbox): void {
  const fixtures = path.join(sandbox.root, "fixtures");
  writeUsageFixture(fixtures);
  writeRecording(fixtures, "readme-chat", readmeChat());
  fs.writeFileSync(sandbox.replayFile, "readme-chat");
  seedInstalledHarness(sandbox);
}
