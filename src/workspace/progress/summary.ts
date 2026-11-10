// 요약 로그 규칙 (D-13 · D-49) — 채팅 줄(기록 + 실시간)과 작업자 목록을 쉬운 말 한 줄씩으로. 순수 함수, 화면 없음 (진행 탭 P7-04 가 그대로 쓴다).
// AI 를 부르지 않는다 — 아래 규칙으로만 만든다. 같은 일이 실시간 · 기록으로 두 번 와도 채팅 줄이 이미 하나로 합쳐 있어 로그도 한 번만 나온다.
//
//  원인                              → 종류     글
//  세션 시작 (이어 하기면 다른 글)       → start    "먹물이 일을 시작했어요" / "먹물이 하던 일을 이어서 시작했어요"
//  작업자 시작                        → assign   "나비에게 맡겼어요 — 사진 읽기 명령 만들기"
//  작업자 마침 · 못 끝냄 · 멈춤         → back · error · stop   "나비가 일을 끝내고 돌아왔어요" · "…끝내지 못했어요" · "…멈췄어요"
//  질문 카드 (단계 승인)              → ask      "P7 단계 승인을 기다려요" (답한 뒤엔 "…물어봤어요")
//  질문 카드 (그 밖)                  → ask      "먹물이 답을 기다려요 — <질문 머리말>" (작업자의 질문이면 그 고양이)
//  권한 카드                         → ask      "나비가 허락을 기다려요 — Bash npm install"
//  턴이 중단 · 오류 · 한도             → stop · error · stop   "하던 일을 중단했어요" · "Claude Code 가 오류로 멈췄어요" · "한도에 닿아 멈췄어요"
//  먹물이 갑자기 멈춤                  → error    "먹물이 갑자기 멈췄어요"
//  넣지 않는 것: 사용자 글 · 먹물 글 · 도구 줄(성공 · 실패) · 한도 가까움 알림 · 그 밖의 알림
import type { CatId } from "../../components/cat/catalog";
import { tf } from "../../i18n/ko";
import { withSubject } from "../../i18n/josa";
import { orchCat, type Mine } from "../../lib/mine";
import type { WorkerRef } from "../../lib/ipc-types";
import { parseApproval } from "../chat/approval";
import type { ChatData, ChatLine } from "../chat/model";
import { catForWorker, catName, type WorkerRoles } from "./workerCat";
import type { WorkerEntry } from "./workers";

export type LogKind = "start" | "assign" | "back" | "pass" | "ask" | "error" | "stop" | "phase";

export interface LogItem {
  /** 한 줄의 열쇠 — 원인(채팅 줄 · 작업자)에서 만든다. 다시 만들어도 같다 */
  key: string;
  /** 일어난 때 (유닉스 밀리초). 모르면 null (기록은 초 단위라 같은 초 안의 순서는 일어난 순서) */
  atMs: number | null;
  cat: CatId;
  kind: LogKind;
  text: string;
}

export interface SummaryInput {
  /** 채팅 목록 — `lines` · `starts` 만 쓴다 */
  chat: Pick<ChatData, "lines" | "starts">;
  /** 작업자 목록 (채팅 줄에 없는 작업자를 더하고, 카드의 작업자 이름을 찾는 데 쓴다) */
  workers?: readonly WorkerEntry[];
  /** 에이전트 이름 → 역할 (`rolesOfAgents`) — 없으면 이름 모양으로 짐작 */
  roles?: WorkerRoles;
  /** 내 연결 (안 주면 지금 들고 있는 것) — 오케스트레이터 · 작업자의 고양이 */
  mine?: Mine;
}

const TITLE_MAX = 40;
const TOOL_MAX = 60;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** 만드는 도중의 한 항목 — 순서(`seq`)와 정렬용 시각 */
interface Draft extends LogItem {
  seq: number;
}

/** 요약 로그 — 시간순 (오래된 것이 앞) */
export function buildSummaryLog(input: SummaryInput): LogItem[] {
  const { chat, workers = [], roles, mine } = input;
  const ORCH: CatId = orchCat(mine);
  const drafts: Draft[] = [];
  const add = (item: LogItem) => drafts.push({ ...item, seq: drafts.length });

  // 카드의 작업자 → 고양이 (작업자 목록 → 요청의 이름 → 없으면 먹물)
  const nameByTool = new Map<string, string>();
  for (const line of chat.lines) if (line.kind === "worker") nameByTool.set(line.toolUseId, line.name);
  for (const worker of workers) if (!nameByTool.has(worker.toolUseId)) nameByTool.set(worker.toolUseId, worker.name);
  const requester = (worker: WorkerRef | null | undefined): CatId => {
    const name = (worker?.toolUseId ? nameByTool.get(worker.toolUseId) : undefined) ?? worker?.name ?? null;
    return name === null || !worker ? ORCH : catForWorker(name, { roles, mine });
  };

  const addWorker = (key: string, name: string, description: string | null, startedAtMs: number, status: "running" | "done" | "failed" | "stopped", endedAtMs: number | null) => {
    const cat = catForWorker(name, { roles, mine });
    const cname = catName(cat);
    const desc = description?.trim();
    add({ key: `w-${key}`, atMs: startedAtMs, cat, kind: "assign", text: desc ? tf("ws.progress.log.assign", { cat: cname, description: desc }) : tf("ws.progress.log.assignBare", { cat: cname }) });
    if (status === "running") return;
    const who = withSubject(cname);
    const [kind, text] = status === "done" ? (["back", tf("ws.progress.log.back", { who })] as const) : status === "failed" ? (["error", tf("ws.progress.log.failed", { who })] as const) : (["stop", tf("ws.progress.log.stopped", { who })] as const);
    // 끝난 때를 모르면(앱이 꺼진 사이 멈춤) 시작한 때 — 바로 뒤에 놓인다
    add({ key: `w-${key}-end`, atMs: endedAtMs, cat, kind, text });
  };

  const addLine = (line: ChatLine) => {
    const atMs = line.atMs ?? null;
    switch (line.kind) {
      case "worker":
        addWorker(line.toolUseId, line.name, line.description, line.startedAtMs, line.status, line.endedAtMs);
        break;
      case "question": {
        const cat = requester(line.info.worker);
        const waiting = line.state.status === "pending";
        const only = line.info.questions.length === 1 ? line.info.questions[0] : undefined;
        const approval = only ? parseApproval(only.question) : null;
        if (approval) {
          add({ key: line.key, atMs, cat, kind: "ask", text: tf(waiting ? "ws.progress.log.approvalWait" : "ws.progress.log.approvalAsked", { phase: approval.phase }) });
          break;
        }
        const first = line.info.questions[0];
        const head = clip(first?.header || first?.question || "", TITLE_MAX) || tf("ws.progress.log.askBare", {});
        const title = line.info.questions.length > 1 ? tf("ws.progress.log.askMore", { title: head, n: line.info.questions.length - 1 }) : head;
        add({ key: line.key, atMs, cat, kind: "ask", text: tf(waiting ? "ws.progress.log.askWait" : "ws.progress.log.askAsked", { who: withSubject(catName(cat)), title }) });
        break;
      }
      case "permission": {
        const cat = requester(line.info.worker);
        const target = line.info.command ?? line.info.path;
        const tool = clip([line.info.displayName ?? line.info.tool, target ?? ""].join(" "), TOOL_MAX);
        add({ key: line.key, atMs, cat, kind: "ask", text: tf(line.state.status === "pending" ? "ws.progress.log.permWait" : "ws.progress.log.permAsked", { who: withSubject(catName(cat)), tool }) });
        break;
      }
      case "turnEnd":
        if (line.outcome === "interrupted") add({ key: line.key, atMs, cat: ORCH, kind: "stop", text: tf("ws.progress.log.interrupted", {}) });
        else if (line.outcome === "limit") add({ key: line.key, atMs, cat: ORCH, kind: "stop", text: tf("ws.progress.log.limit", {}) });
        else add({ key: line.key, atMs, cat: ORCH, kind: "error", text: tf("ws.progress.log.turnError", {}) });
        break;
      case "notice":
        if (line.code === "session_died") add({ key: line.key, atMs, cat: ORCH, kind: "error", text: tf("ws.progress.log.died", { who: withSubject(catName(ORCH)) }) });
        break;
      default:
        // 사용자 글 · 먹물 글 · 도구 줄 · 도구 실패 — 로그에 넣지 않는다
        break;
    }
  };

  const addStarts = (afterKey: string | null) => {
    for (const start of chat.starts) {
      if (start.afterKey !== afterKey) continue;
      add({ key: `s-${start.key}`, atMs: start.atMs, cat: ORCH, kind: "start", text: tf(start.resumed ? "ws.progress.log.resume" : "ws.progress.log.start", { who: withSubject(catName(ORCH)) }) });
    }
  };

  addStarts(null);
  for (const line of chat.lines) {
    addLine(line);
    addStarts(line.key);
  }
  // 채팅 줄에는 없는 작업자 (아직 대화를 읽기 전 · 오래된 쪽 밖)
  const inLines = new Set(chat.lines.filter((line) => line.kind === "worker").map((line) => (line.kind === "worker" ? line.toolUseId : "")));
  for (const worker of workers) if (!inLines.has(worker.toolUseId)) addWorker(worker.toolUseId, worker.name, worker.description, worker.startedAtMs, worker.status, worker.endedAtMs);

  return ordered(drafts);
}

/** 시각순 — 시각을 모르는 항목은 바로 앞 항목의 시각을 따라간다. 같은 시각이면 만든 순서 */
function ordered(drafts: Draft[]): LogItem[] {
  let last = 0;
  const sortAt = new Map<Draft, number>();
  for (const draft of drafts) {
    last = draft.atMs ?? last;
    sortAt.set(draft, last);
  }
  return [...drafts]
    .sort((a, b) => (sortAt.get(a) ?? 0) - (sortAt.get(b) ?? 0) || a.seq - b.seq)
    .map((draft) => ({ key: draft.key, atMs: draft.atMs, cat: draft.cat, kind: draft.kind, text: draft.text }));
}
