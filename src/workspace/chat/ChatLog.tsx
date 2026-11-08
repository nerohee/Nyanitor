// 채팅 목록 — 줄 그리기 + 스크롤: 처음엔 맨 아래(기다리는 카드가 있으면 그 카드 머리가 보이게), 새 글이 오면 맨 아래에 붙되
// 사용자가 위를 보고 있으면 끌어내리지 않고 "새 글 n" 단추, 이전 쪽을 앞에 붙여도 보던 자리가 그대로.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t, tf } from "../../i18n/ko";
import { Icon } from "../../variants/shared/icons";
import { QuestionRequest, PermissionCard, type Respond } from "./Cards";
import { NoticeLine, OrchMessage, ToolErrorLine, ToolGroup, ToolLine, TurnEndLine, UserMessage, WorkerLine } from "./Lines";
import type { ChatLine } from "./model";

/** 도구 사용이 이만큼 이어지면 접는다 */
const TOOL_GROUP_MIN = 3;
/** 맨 아래에서 이만큼(px) 안이면 "맨 아래" 로 본다 */
const STICK_PX = 48;

type Block = { type: "line"; line: ChatLine } | { type: "tools"; lines: Extract<ChatLine, { kind: "tool" }>[] };

/** 이어진 도구 줄을 묶는다 */
export function groupLines(lines: readonly ChatLine[]): Block[] {
  const blocks: Block[] = [];
  let run: Extract<ChatLine, { kind: "tool" }>[] = [];
  const flush = () => {
    if (run.length >= TOOL_GROUP_MIN) blocks.push({ type: "tools", lines: run });
    else for (const line of run) blocks.push({ type: "line", line });
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "tool") run.push(line);
    else {
      flush();
      blocks.push({ type: "line", line });
    }
  }
  flush();
  return blocks;
}

interface Props {
  lines: readonly ChatLine[];
  hasMore: boolean;
  loadingOlder: boolean;
  olderFailed: boolean;
  onLoadOlder: () => void;
  onRespond: Respond;
  /** 목록이 비었을 때 대신 보일 것 */
  empty?: ReactNode;
}

function LineView({ line, first, more, onRespond }: { line: ChatLine; first: boolean; more: number; onRespond: Respond }) {
  switch (line.kind) {
    case "user":
      return <UserMessage line={line} />;
    case "orch":
      return <OrchMessage line={line} />;
    case "tool":
      return <ToolLine line={line} />;
    case "toolError":
      return <ToolErrorLine line={line} />;
    case "question":
      return <QuestionRequest info={line.info} state={line.state} onRespond={onRespond} first={first} />;
    case "permission":
      return <PermissionCard info={line.info} state={line.state} onRespond={onRespond} first={first} more={more} />;
    case "worker":
      return <WorkerLine line={line} />;
    case "turnEnd":
      return <TurnEndLine line={line} />;
    case "notice":
      return <NoticeLine line={line} />;
  }
}

export function ChatLog({ lines, hasMore, loadingOlder, olderFailed, onLoadOlder, onRespond, empty }: Props) {
  const log = useRef<HTMLDivElement>(null);
  /** 맨 아래를 보고 있는가 (스크롤할 때마다 갱신) */
  const stuck = useRef(true);
  const prev = useRef<{ first: string | null; last: string | null; count: number; height: number } | null>(null);
  const [unread, setUnread] = useState(0);

  const noLines = lines.length === 0;
  const firstPending = lines.findIndex((line) => (line.kind === "question" || line.kind === "permission") && line.state.status === "pending");

  // 기다리는 권한 요청은 가장 먼저 온 하나만 그린다 — 나머지는 그 카드 머리의 "남은 요청 n개" 로 (답하면 다음 것이 그 자리에)
  const pendingPerms = lines.filter((line) => line.kind === "permission" && line.state.status === "pending");
  const frontPerm = pendingPerms[0];
  const morePerms = pendingPerms.length - 1;

  // 맨 아래를 보고 있으면 늘 맨 아래를 따라간다 (편집기 채팅처럼) — 기다리는 카드가 있어도 그 뒤 새 글 · 다음 카드까지 (P7 써 보기, 고객).
  // 위로 올려 읽는 중이면 끌어내리지 않고 "새 글 n" 단추. 카드로 돌아가는 길은 "기다리는 카드로" 단추
  const toBottom = (el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    stuck.current = true;
  };

  useLayoutEffect(() => {
    const el = log.current;
    if (!el) return;
    const first = lines[0]?.key ?? null;
    const last = lines[lines.length - 1]?.key ?? null;
    const before = prev.current;
    prev.current = { first, last, count: lines.length, height: el.scrollHeight };
    if (!before || before.count === 0) {
      toBottom(el);
      setUnread(0);
      return;
    }
    if (first !== before.first && last === before.last) {
      // 이전 쪽을 앞에 붙였다 — 보던 자리를 그대로
      el.scrollTop += el.scrollHeight - before.height;
      return;
    }
    // 맨 아래를 보고 있으면 끝 줄이 같아도(다음 카드가 그 자리에 · 카드에 답함) 다시 맨 아래로
    if (stuck.current) toBottom(el);
    else if (last !== before.last) setUnread((n) => n + Math.max(1, lines.length - before.count));
  }, [lines]);

  // 줄 수는 같은데 높이만 바뀔 때 (카드가 접히거나 펼쳐짐, 글이 늘어남) — 맨 아래를 보고 있었으면 따라간다
  useEffect(() => {
    const el = log.current;
    const items = el?.firstElementChild;
    if (!el || !items || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(items);
    return () => observer.disconnect();
  }, [noLines]);

  const onScroll = () => {
    const el = log.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
    if (stuck.current) setUnread(0);
  };

  const blocks = groupLines(lines).filter((block) => block.type === "tools" || block.line.kind !== "permission" || block.line.state.status !== "pending" || block.line === frontPerm);

  return (
    <div className="wc-logwrap">
      <div className="wc-log" ref={log} onScroll={onScroll} data-testid="chat-log">
        {lines.length === 0 ? (
          empty
        ) : (
          <div className="wc-items">
            {hasMore && (
              <div className="wc-older">
                <button type="button" className="ws-btn ws-btn--small" disabled={loadingOlder} onClick={onLoadOlder}>
                  <Icon name="history" size={14} />
                  {t(loadingOlder ? "ws.chat.older.loading" : "ws.chat.older")}
                </button>
                {olderFailed && (
                  <p className="wc-card__error" role="alert">
                    <Icon name="alert" size={16} />
                    {t("ws.chat.older.failed")}
                  </p>
                )}
              </div>
            )}
            {blocks.map((block) =>
              block.type === "tools" ? (
                <ToolGroup key={block.lines[0]?.key} lines={block.lines} />
              ) : (
                <LineView key={block.line.key} line={block.line} first={lines.indexOf(block.line) === firstPending} more={block.line === frontPerm ? morePerms : 0} onRespond={onRespond} />
              ),
            )}
          </div>
        )}
      </div>
      {unread > 0 && (
        <button
          type="button"
          className="ws-btn ws-btn--primary ws-btn--small wc-unread"
          onClick={() => {
            if (log.current) toBottom(log.current);
            setUnread(0);
          }}
        >
          <Icon name="arrow" size={14} />
          {tf("ws.chat.unread", { n: unread })}
        </button>
      )}
    </div>
  );
}
