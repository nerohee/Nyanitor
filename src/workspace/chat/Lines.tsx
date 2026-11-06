// 채팅 목록의 한 줄들 — 사용자 말 · 먹물 글(마크다운) · 도구 사용 · 실패한 도구 결과 · 턴 끝(오류 · 한도 · 중단일 때만) · 알림 줄.
import { useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { catForAgent, type CatId } from "../../components/cat/catalog";
import { isTextKey, t, tf } from "../../i18n/ko";
import { Icon, type IconName } from "../../variants/shared/icons";
import { MarkdownPreview } from "../MarkdownPreview";
import type { ChatLine } from "./model";

/** 오케스트레이터(먹물) — 이름 · 얼굴 */
export const ORCH_CAT = catForAgent("main") as CatId;

export function orchName(): string {
  const key = `cat.${ORCH_CAT}.name`;
  return isTextKey(key) ? t(key) : "";
}

type Of<K extends ChatLine["kind"]> = Extract<ChatLine, { kind: K }>;

function Cut() {
  return <p className="wc-msg__cut">{t("ws.chat.truncated")}</p>;
}

export function UserMessage({ line }: { line: Of<"user"> }) {
  return (
    <div className="wc-msg wc-msg--user">
      <div className="wc-msg__bubble">
        <p className="wc-msg__who">
          {t("variant.ws.chat.you")}
          {line.deferred && <span className="wc-msg__tag">{t("ws.chat.msg.deferred")}</span>}
        </p>
        <p className="wc-msg__text selectable">{line.text}</p>
        {line.truncated && <Cut />}
      </div>
    </div>
  );
}

export function OrchMessage({ line }: { line: Of<"orch"> }) {
  return (
    <div className="wc-msg wc-msg--orch">
      <span className="wc-msg__avatar" aria-hidden="true">
        <CatFigure cat={ORCH_CAT} crop="face" />
      </span>
      <div className="wc-msg__bubble">
        <p className="wc-msg__who">{orchName()}</p>
        <MarkdownPreview text={line.text} />
        {line.truncated && <Cut />}
      </div>
    </div>
  );
}

export function ToolLine({ line }: { line: Of<"tool"> }) {
  return (
    <p className="wc-tool">
      <Icon name="terminal" size={14} />
      <b>{line.tool}</b>
      <span className="wc-tool__summary" title={line.summary}>
        {line.summary}
      </span>
    </p>
  );
}

/** 도구 사용이 몰려 있으면 접는다 — 한 줄 "도구 n개 사용" */
export function ToolGroup({ lines }: { lines: Of<"tool">[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wc-tools">
      <button type="button" className="wc-tools__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Icon name="chevron" size={14} />
        {tf("ws.chat.tools.group", { n: lines.length })}
      </button>
      {open && lines.map((line) => <ToolLine key={line.key} line={line} />)}
    </div>
  );
}

/** 실시간으로 막 생긴 줄인가 — 기록에서 불러온 지난 일은 알림 역할(`alert` · `status`)을 달지 않는다 */
export const isLive = (line: ChatLine): boolean => line.key.startsWith("l-");

export function ToolErrorLine({ line }: { line: Of<"toolError"> }) {
  return (
    <p className="wc-toolerr" role={isLive(line) ? "status" : undefined}>
      <Icon name="alert" size={14} />
      <span>{line.summary.trim() === "" ? t("ws.chat.tools.failedBare") : tf("ws.chat.tools.failed", { summary: line.summary })}</span>
      {line.truncated && <span className="wc-msg__cut">{t("ws.chat.truncated")}</span>}
    </p>
  );
}

type Tone = "error" | "limit" | "warn" | "info" | "stopped";

function Note({ tone, icon, title, body, role }: { tone: Tone; icon: IconName; title: string; body?: string | null; role?: "alert" | "status" }) {
  return (
    <div className="wc-note" data-tone={tone} role={role}>
      <span className="wc-note__icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <div className="wc-note__body">
        <p className="wc-note__title">{title}</p>
        {body && <p className="wc-note__text">{body}</p>}
      </div>
    </div>
  );
}

export function TurnEndLine({ line }: { line: Of<"turnEnd"> }) {
  if (line.outcome === "interrupted") return <Note tone="stopped" icon="stop" title={t("variant.ws.notice.stopped")} body={t("variant.ws.notice.stoppedBody")} />;
  if (line.outcome === "limit") return <Note tone="limit" icon="clock" title={t("ws.chat.turn.limit")} body={line.detail} />;
  return <Note tone="error" icon="alert" title={t("ws.chat.turn.error")} body={line.detail} role={isLive(line) ? "alert" : undefined} />;
}

/** 초기화 시각 — 이 PC 의 시계로 */
function clockText(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function NoticeLine({ line }: { line: Of<"notice"> }) {
  const role = isLive(line) ? "alert" : undefined;
  switch (line.code) {
    case "api_key_in_use":
      return <Note tone="warn" icon="key" title={t("ws.chat.notice.apiKey")} body={t("ws.chat.notice.apiKeyBody")} />;
    case "planner_config":
      return <Note tone="warn" icon="settings" title={t("ws.chat.notice.planner")} body={t("ws.chat.notice.plannerBody")} />;
    case "history_write_failed":
      return <Note tone="warn" icon="save" title={t("ws.chat.notice.history")} body={t("ws.chat.notice.historyBody")} role={role} />;
    case "rate_limit": {
      const window = line.detail === "seven_day" ? t("ws.chat.notice.window7d") : t("ws.chat.notice.window5h");
      const reached = line.limitStatus === "rejected";
      const percent = line.utilization === null ? "" : ` (${Math.round(line.utilization * 100)}%)`;
      return (
        <Note
          tone="limit"
          icon="clock"
          title={tf(reached ? "ws.chat.notice.limitReached" : "ws.chat.notice.limitNear", { window, percent })}
          body={line.resetsAt === null ? null : tf("ws.chat.notice.limitReset", { time: clockText(line.resetsAt) })}
        />
      );
    }
    case "resume_not_found":
      return <Note tone="info" icon="info" title={t("ws.chat.notice.resumeNotFound")} body={t("ws.chat.notice.resumeNotFoundBody")} />;
    case "session_died":
      return <Note tone="error" icon="unplug" title={t("ws.chat.notice.died")} body={line.detail ? line.detail.split("\n").slice(-2).join(" ") : t("ws.chat.notice.diedBody")} role={role} />;
  }
}
