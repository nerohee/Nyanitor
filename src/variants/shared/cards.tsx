// 채팅 안의 선택 카드 (D-14 · D-15 · D-23) + 메시지 + 앱이 끼워 넣는 알림 줄. 모양은 토큰 · [data-skin] 로 달라진다.
// 시제품 — 눌러도 아무 데도 보내지 않는다. 고르는 모양 · 키보드 조작 · 답한 뒤 모양만 된다 (실제 답 보내기는 P3 control 응답).
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, tf, type TextKey } from "../../i18n/ko";
import { ORCHESTRATOR } from "../fixtures";
import type { ChatItem, NoticeTone, PermissionTool, Question } from "../fixtures-workspace";
import { Icon, type IconName } from "./icons";

type CardItem<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

function reducedMotion(): boolean {
  return document.documentElement.dataset.motion === "reduced" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
}

/**
 * 카드 안의 글 칸(직접 쓰기 · 고칠 점 말하기 · 다르게 하라고 말하기)이 열리면 채팅을 맨 밑으로 내리고 그 칸에 초점 (D-43).
 * 기다리는 카드는 채팅 맨 끝에 있어서 맨 밑 = 열린 칸이 보이는 곳. 움직임 줄이기면 바로 (부드럽게 내리지 않음).
 */
function useRevealWhenOpen<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const field = ref.current;
    if (!open || !field) return;
    field.focus({ preventScroll: true });
    const log = field.closest<HTMLElement>(".wchat__log");
    if (!log) {
      field.scrollIntoView?.({ block: "nearest" });
      return;
    }
    if (reducedMotion() || typeof log.scrollTo !== "function") log.scrollTop = log.scrollHeight;
    else log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
  }, [open]);
  return ref;
}

/** 카드가 답을 받았을 때 (채팅 칸이 기다리는 카드 수 · 상태를 바꾼다) */
export type OnAnswered = (id: string) => void;

function CardHead({ label, icon, pending, time }: { label: string; icon: IconName; pending: boolean; time: string }) {
  return (
    <header className="wcard__head">
      <span className="wcard__icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="wcard__kind">{label}</span>
      <span className="wcard__state" data-pending={pending ? "true" : undefined}>
        {pending ? t("variant.ws.card.waiting") : t("variant.ws.card.done")}
      </span>
      <time className="wcard__time">{time}</time>
    </header>
  );
}

// ── 질문 (AskUserQuestion: 하나 고르기 · 여러 개 고르기 · 직접 쓰기 · 미리보기 있는 선택지) ──

type Answers = Record<string, string[]>;

function QuestionBlock({
  q,
  value,
  writeIn,
  onChange,
  onWriteIn,
}: {
  q: Question;
  value: string[];
  writeIn: string;
  onChange: (next: string[]) => void;
  onWriteIn: (text: string) => void;
}) {
  const name = useId();
  const previewId = useId();
  const type = q.multi ? "checkbox" : "radio";
  const writing = value.includes("write");
  const writeRef = useRevealWhenOpen<HTMLInputElement>(writing);
  const hasPreview = q.options.some((option) => option.previewKey);
  // 미리보기는 포커스 · 마우스가 올라간 선택지, 없으면 고른 것, 없으면 첫 번째
  const [peek, setPeek] = useState<string | null>(null);
  const shownId = peek ?? value.find((id) => id !== "write") ?? q.options[0]?.id;
  const shown = q.options.find((option) => option.id === shownId);

  const toggle = (id: string, checked: boolean) => {
    if (!q.multi) onChange([id]);
    else onChange(checked ? [...value.filter((v) => v !== id), id] : value.filter((v) => v !== id));
  };

  return (
    <fieldset className="wq" data-preview={hasPreview ? "true" : undefined}>
      <legend className="wq__prompt">
        <span className="wq__header">{t(q.headerKey)}</span>
        <span className="wq__text">{t(q.promptKey)}</span>
        {q.multi && <span className="wq__multi">{t("variant.ws.card.multi")}</span>}
      </legend>
      <div className="wq__grid">
        <div className="wq__options" onMouseLeave={() => setPeek(null)}>
          {q.options.map((option) => (
            <label
              key={option.id}
              className="wopt"
              onMouseEnter={() => option.previewKey && setPeek(option.id)}
              data-peek={hasPreview && option.id === shownId ? "true" : undefined}
            >
              <input
                type={type}
                name={name}
                value={option.id}
                checked={value.includes(option.id)}
                aria-describedby={option.previewKey ? previewId : undefined}
                onFocus={() => option.previewKey && setPeek(option.id)}
                onBlur={() => setPeek(null)}
                onChange={(event) => toggle(option.id, event.target.checked)}
              />
              <span className="wopt__key" aria-hidden="true">
                {option.id}
              </span>
              <span className="wopt__body">
                <span className="wopt__label">{t(option.labelKey)}</span>
                {option.descKey && <span className="wopt__desc">{t(option.descKey)}</span>}
              </span>
              {option.recommended && <span className="wopt__rec">{t("variant.ws.card.recommended")}</span>}
            </label>
          ))}
          {q.writeIn && (
            <div className="wopt wopt--write">
              <label className="wopt__inline">
                <input
                  type={type}
                  name={name}
                  value="write"
                  checked={value.includes("write")}
                  onChange={(event) => toggle("write", event.target.checked)}
                />
                <span className="wopt__key" aria-hidden="true">
                  …
                </span>
                <span className="wopt__label">{t("variant.ws.card.writeIn")}</span>
              </label>
              {writing && (
                <input
                  ref={writeRef}
                  type="text"
                  className="wopt__text-in"
                  aria-label={t("variant.ws.card.writeInInput")}
                  value={writeIn}
                  onChange={(event) => onWriteIn(event.target.value)}
                />
              )}
            </div>
          )}
        </div>
        {hasPreview && shown?.previewKey && (
          <figure className="wq__preview" id={previewId}>
            <figcaption>{tf("variant.ws.card.previewOf", { id: shown.id, label: t(shown.labelKey) })}</figcaption>
            <pre className="selectable">{t(shown.previewKey)}</pre>
          </figure>
        )}
      </div>
    </fieldset>
  );
}

function answerText(q: Question, ids: readonly string[], writeIn?: string): string {
  return ids
    .map((id) => {
      if (id === "write") return writeIn ? `“${writeIn}”` : t("variant.ws.card.writeIn");
      const option = q.options.find((o) => o.id === id);
      return option ? `${option.id} ${t(option.labelKey)}` : id;
    })
    .join(" · ");
}

function QuestionDone({ questions, answers, writeIns }: { questions: Question[]; answers: Answers; writeIns: Record<string, string> }) {
  return (
    <dl className="wq-done">
      {questions.map((q) => (
        <div key={q.id}>
          <dt>{t(q.headerKey)}</dt>
          <dd>{answerText(q, answers[q.id] ?? [], writeIns[q.id] ?? (q.writeInKey ? t(q.writeInKey) : undefined))}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 질문 카드 — 선택지 A/B/C + 권장(첫 번째) + 직접 쓰기, 여러 개 고르기, 미리보기. 다 고르면 "답 보내기" */
export function QuestionCard({ item, id, onAnswered }: { item: CardItem<"question">; id?: string; onAnswered?: OnAnswered }) {
  const [answers, setAnswers] = useState<Answers>(() => Object.fromEntries(item.questions.map((q) => [q.id, q.answer ?? []])));
  const [writeIns, setWriteIns] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(item.done);
  const progressId = useId();
  const answered = item.questions.filter((q) => {
    const value = answers[q.id] ?? [];
    if (value.length === 0) return false;
    return !(value.includes("write") && !(writeIns[q.id] ?? "").trim() && value.length === 1);
  }).length;
  const complete = answered === item.questions.length;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!complete) return;
    setSent(true);
    onAnswered?.(item.id);
  };
  // 선택지에서 Enter = 보내기 (다 골랐을 때)
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    if (event.key === "Enter" && (target.type === "radio" || target.type === "checkbox")) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <article
      className="wcard wcard--question"
      data-pending={!sent ? "true" : undefined}
      id={id}
      tabIndex={-1}
      aria-label={t("variant.ws.card.question")}
    >
      <CardHead label={t("variant.ws.card.question")} icon="info" pending={!sent} time={item.time} />
      {sent ? (
        <div className="wcard__body">
          <QuestionDone questions={item.questions} answers={answers} writeIns={writeIns} />
        </div>
      ) : (
        <form className="wcard__body" onSubmit={submit} onKeyDown={onKeyDown}>
          {item.questions.map((q) => (
            <QuestionBlock
              key={q.id}
              q={q}
              value={answers[q.id] ?? []}
              writeIn={writeIns[q.id] ?? ""}
              onChange={(next) => setAnswers((prev) => ({ ...prev, [q.id]: next }))}
              onWriteIn={(text) => setWriteIns((prev) => ({ ...prev, [q.id]: text }))}
            />
          ))}
          <div className="wcard__actions">
            <button type="submit" className="hbtn hbtn--primary" disabled={!complete} aria-describedby={progressId}>
              {t("variant.ws.card.submit")}
            </button>
            <span className="wcard__hint" id={progressId}>
              {tf("variant.ws.card.progress", { n: answered, total: item.questions.length })}
              <span aria-hidden="true"> · </span>
              {t("variant.ws.card.keys")}
            </span>
          </div>
        </form>
      )}
    </article>
  );
}

// ── 권한 (D-15 · D-23) ──

const TOOL_LABEL: Record<PermissionTool, TextKey> = {
  Bash: "variant.ws.perm.kind.Bash",
  Write: "variant.ws.perm.kind.Write",
  Edit: "variant.ws.perm.kind.Edit",
  WebFetch: "variant.ws.perm.kind.WebFetch",
};

/** 권한 카드 — 무엇을(명령 · 파일) · 어디서 · 누가 왜 → 이번만 허용 / 이 프로젝트에서 항상 허용 / 거부(이유 말하기) */
export function PermissionCard({ item, id, onAnswered }: { item: CardItem<"permission">; id?: string; onAnswered?: OnAnswered }) {
  const [result, setResult] = useState(item.result);
  const [denying, setDenying] = useState(false);
  const tellRef = useRevealWhenOpen<HTMLTextAreaElement>(denying);
  const alwaysId = useId();
  const decide = (next: NonNullable<typeof result>) => {
    setResult(next);
    setDenying(false);
    onAnswered?.(item.id);
  };
  const pending = !result;
  return (
    <article
      className="wcard wcard--permission"
      data-pending={pending ? "true" : undefined}
      id={id}
      tabIndex={-1}
      aria-label={t("variant.ws.card.permission")}
    >
      <CardHead label={t("variant.ws.card.permission")} icon="key" pending={pending} time={item.time} />
      <div className="wcard__body">
        <p className="wcard__text">{t(item.whyKey)}</p>
        <div className="wperm">
          <p className="wperm__tool">
            <span className="wperm__kind">{t(TOOL_LABEL[item.tool])}</span>
            <code>{item.tool}</code>
          </p>
          <pre className="wcard__code selectable">
            <code>{item.command ?? item.path}</code>
          </pre>
          <dl className="wperm__meta">
            <dt>{t("variant.ws.perm.where")}</dt>
            <dd>
              <code>{item.cwd}</code>
            </dd>
            {item.lines && (
              <>
                <dt>{t("variant.ws.perm.lines")}</dt>
                <dd>{tf("variant.ws.perm.linesValue", { a: item.lines.add, d: item.lines.del })}</dd>
              </>
            )}
          </dl>
        </div>
        {pending ? (
          <>
            <div className="wcard__actions">
              <button type="button" className="hbtn hbtn--primary" onClick={() => decide("allow")}>
                {t("variant.ws.perm.allow")}
              </button>
              <button type="button" className="hbtn" aria-describedby={alwaysId} onClick={() => decide("always")}>
                {t("variant.ws.perm.always")}
              </button>
              <button type="button" className="hbtn" onClick={() => decide("deny")}>
                {t("variant.ws.perm.deny")}
              </button>
              <button type="button" className="hbtn hbtn--ghost" aria-expanded={denying} onClick={() => setDenying((v) => !v)}>
                {t("variant.ws.perm.denyTell")}
              </button>
            </div>
            <p className="wperm__always" id={alwaysId}>
              {t("variant.ws.perm.alwaysNote1")} <code>{item.rule}</code> {t("variant.ws.perm.alwaysNote2")}
            </p>
            {denying && (
              <div className="wperm__tell">
                <textarea
                  ref={tellRef}
                  className="fld wperm__tell-in"
                  rows={2}
                  aria-label={t("variant.ws.perm.denyTellInput")}
                  placeholder={t("variant.ws.perm.denyTellPh")}
                />
                <button type="button" className="hbtn" onClick={() => decide("deny")}>
                  {t("variant.ws.perm.denySend")}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="wcard__result" data-result={result}>
            <Icon name={result === "deny" ? "close" : "check"} size={16} />
            {t(`variant.ws.perm.result.${result}`)}
            {result === "always" && <code>{item.rule}</code>}
          </p>
        )}
      </div>
    </article>
  );
}

// ── 단계 승인 (승인 게이트 4항목) ──

/** 승인 카드 — 무엇을 · 왜 지금 · 산출물 · 하지 않는 것 → 승인 / 고칠 점 말하기 */
export function ApprovalCard({ item, id, onAnswered }: { item: CardItem<"approval">; id?: string; onAnswered?: OnAnswered }) {
  const [done, setDone] = useState<"approved" | "changes" | null>(item.done ? "approved" : null);
  const [asking, setAsking] = useState(false);
  const askRef = useRevealWhenOpen<HTMLTextAreaElement>(asking);
  const pending = done === null;
  const finish = (how: "approved" | "changes") => {
    setDone(how);
    setAsking(false);
    onAnswered?.(item.id);
  };
  return (
    <article
      className="wcard wcard--approval"
      data-pending={pending ? "true" : undefined}
      id={id}
      tabIndex={-1}
      aria-label={t("variant.ws.card.approval")}
    >
      <CardHead label={t("variant.ws.card.approval")} icon="check" pending={pending} time={item.time} />
      <div className="wcard__body">
        <h3 className="wcard__title">{t(item.titleKey)}</h3>
        <dl className="wappr">
          <dt>{t("variant.ws.approval.what")}</dt>
          <dd>{t(item.whatKey)}</dd>
          <dt>{t("variant.ws.approval.why")}</dt>
          <dd>{t(item.whyKey)}</dd>
          <dt>{t("variant.ws.approval.outputs")}</dt>
          <dd>
            <ul>
              {item.outputKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </dd>
          <dt>{t("variant.ws.approval.notDoing")}</dt>
          <dd>
            <ul>
              {item.notKeys.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </dd>
        </dl>
        {pending ? (
          <>
            <div className="wcard__actions">
              <button type="button" className="hbtn hbtn--primary" onClick={() => finish("approved")}>
                {t("variant.ws.approval.approve")}
              </button>
              <button type="button" className="hbtn" aria-expanded={asking} onClick={() => setAsking((v) => !v)}>
                {t("variant.ws.approval.changes")}
              </button>
            </div>
            {asking && (
              <div className="wperm__tell">
                <textarea
                  ref={askRef}
                  className="fld wperm__tell-in"
                  rows={2}
                  aria-label={t("variant.ws.approval.changesInput")}
                  placeholder={t("variant.ws.approval.changesPh")}
                />
                <button type="button" className="hbtn" onClick={() => finish("changes")}>
                  {t("variant.ws.approval.changesSend")}
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="wcard__result">
            <Icon name="check" size={16} />
            {t(done === "changes" ? "variant.ws.approval.resultChanges" : "variant.ws.approval.result")}
          </p>
        )}
      </div>
    </article>
  );
}

/** 실행 확인 카드 — 띄우는 명령 · 볼 것 → 확인했어요 / 문제가 있어요 */
export function RunCheckCard({ item, id }: { item: CardItem<"runcheck">; id?: string }) {
  const pending = !item.done;
  return (
    <article
      className="wcard wcard--run"
      data-pending={pending ? "true" : undefined}
      id={id}
      tabIndex={-1}
      aria-label={t("variant.ws.card.runCheck")}
    >
      <CardHead label={t("variant.ws.card.runCheck")} icon="terminal" pending={pending} time={item.time} />
      <div className="wcard__body">
        <p className="wcard__label">{t("variant.ws.run.command")}</p>
        <pre className="wcard__code selectable">
          <code>{item.command}</code>
        </pre>
        <p className="wcard__label">{t("variant.ws.run.look")}</p>
        <ul className="wrun__look">
          {item.lookKeys.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        {pending ? (
          <div className="wcard__actions">
            <button type="button" className="hbtn hbtn--primary">
              {t("variant.ws.run.ok")}
            </button>
            <button type="button" className="hbtn">
              {t("variant.ws.run.problem")}
            </button>
          </div>
        ) : (
          <p className="wcard__result">
            <Icon name="check" size={16} />
            {t("variant.ws.run.result")}
          </p>
        )}
      </div>
    </article>
  );
}

// ── 앱이 끼워 넣는 알림 줄 ──

const NOTICE_ICON: Record<NoticeTone, IconName> = {
  stopped: "stop",
  error: "alert",
  limit: "clock",
  offline: "unplug",
  phase: "flag",
};

export function NoticeLine({ item }: { item: CardItem<"notice"> }) {
  return (
    <div className="wnote" data-tone={item.tone} role={item.tone === "error" ? "alert" : undefined}>
      <span className="wnote__icon" aria-hidden="true">
        <Icon name={NOTICE_ICON[item.tone]} size={16} />
      </span>
      <div className="wnote__body">
        <p className="wnote__title">
          {t(item.titleKey)}
          <time>{item.time}</time>
        </p>
        {item.bodyKey && <p className="wnote__text">{t(item.bodyKey)}</p>}
      </div>
    </div>
  );
}

function Message({ item }: { item: CardItem<"user"> | CardItem<"orch"> }) {
  const mine = item.kind === "user";
  return (
    <div className={`wmsg wmsg--${mine ? "user" : "orch"}`}>
      {!mine && (
        <span className="wmsg__avatar" aria-hidden="true">
          <CatFigure cat={ORCHESTRATOR} crop="face" />
        </span>
      )}
      <div className="wmsg__bubble">
        <p className="wmsg__who">
          {mine ? t("variant.ws.chat.you") : t(`cat.${ORCHESTRATOR}.name`)}
          <time>{item.time}</time>
        </p>
        <p className="wmsg__text selectable">
          {item.kind === "user" && item.skill && <code className="wmsg__skill">{item.skill}</code>}
          {t(item.textKey)}
        </p>
      </div>
    </div>
  );
}

export const PENDING_CARD_ID = "ws-pending-card";

export function ChatItemView({ item, pendingId, onAnswered }: { item: ChatItem; pendingId?: string; onAnswered?: OnAnswered }) {
  switch (item.kind) {
    case "user":
    case "orch":
      return <Message item={item} />;
    case "question":
      return <QuestionCard item={item} id={pendingId} onAnswered={onAnswered} />;
    case "permission":
      return <PermissionCard item={item} id={pendingId} onAnswered={onAnswered} />;
    case "approval":
      return <ApprovalCard item={item} id={pendingId} onAnswered={onAnswered} />;
    case "runcheck":
      return <RunCheckCard item={item} id={pendingId} />;
    case "notice":
      return <NoticeLine item={item} />;
  }
}

export function isPending(item: ChatItem): boolean {
  if (item.kind === "permission") return !item.result;
  if (item.kind === "question" || item.kind === "approval" || item.kind === "runcheck") return !item.done;
  return false;
}
