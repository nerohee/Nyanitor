// 채팅 안의 선택 카드 (D-14 · D-23) — 질문 · 단계 승인 · 권한. 시제품 `variants/shared/cards.tsx` 의 모양에 실제 답 보내기를 붙였다.
// 카드는 답을 `onRespond` 로 올릴 뿐이다 (`claudeSessionRespond`). 답한 카드는 접혀서 고른 답이 보이고, 지나감 · 취소됨은 흐리게 한 줄.
// 항상 허용의 규칙은 요청의 `alwaysRule` 이고 화면이 고르지 않는다 — 없으면 단추를 보이지 않는다 (D-23 · D-45).
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { t, tf, type TextKey } from "../../i18n/ko";
import type { AnswerValue, ClaudeResponse, QuestionInfo, QuestionRequestInfo } from "../../lib/ipc-types";
import { Icon, type IconName } from "../../variants/shared/icons";
import { approvalChoiceOf, approvalLabel, parseApproval, type Approval } from "./approval";
import { dropDraft, getDraft, setDraft } from "./cardDrafts";
import { chatErrorText } from "./errors";
import type { CardState, PermissionView } from "./model";

export type Respond = (requestId: string, response: ClaudeResponse) => Promise<void>;

/** 답 보내기 — 보내는 동안 단추를 끄고, 실패하면 한 줄 (카드는 그대로 남아 다시 보낼 수 있다) */
function useSubmit(respond: Respond, requestId: string) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = async (response: ClaudeResponse) => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await respond(requestId, response);
    } catch (raw) {
      if (alive.current) setError(chatErrorText(raw));
    } finally {
      if (alive.current) setSending(false);
    }
  };
  return { sending, error, submit };
}

/** 글 칸이 열리면 그 칸에 초점 — 채팅 안에서 끌려 내려가지 않게 `nearest` 만 */
function useRevealWhenOpen<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    ref.current.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  return ref;
}

const STATE_LABEL: Record<CardState["status"], TextKey> = {
  pending: "variant.ws.card.waiting",
  answered: "variant.ws.card.done",
  cancelled: "ws.chat.card.cancelled",
  expired: "ws.chat.card.expired",
};

function CardHead({ label, icon, status, note }: { label: string; icon: IconName; status: CardState["status"]; note?: string | null }) {
  return (
    <header className="wc-card__head">
      <span className="wc-card__icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="wc-card__kind">{label}</span>
      {note && <span className="wc-card__more">{note}</span>}
      <span className="wc-card__state" data-status={status}>
        {t(STATE_LABEL[status])}
      </span>
    </header>
  );
}

function SendError({ text }: { text: string | null }) {
  return text ? (
    <p className="wc-card__error" role="alert">
      <Icon name="alert" size={16} />
      {tf("ws.chat.card.sendFailed", { reason: text })}
    </p>
  ) : null;
}

/** 지나감 · 취소됨 — 흐리게 한 줄 */
function Gone({ status }: { status: "cancelled" | "expired" }) {
  return (
    <p className="wc-card__gone">
      <Icon name={status === "expired" ? "clock" : "close"} size={16} />
      {t(status === "expired" ? "ws.chat.card.expiredNote" : "ws.chat.card.cancelledNote")}
    </p>
  );
}

interface CardProps {
  state: CardState;
  onRespond: Respond;
  /** 기다리는 카드로 건너뛰기(`data-pending-card`)를 위한 표시 */
  first?: boolean;
}

function Article({ kind, label, state, first, children }: { kind: string; label: string; state: CardState; first?: boolean; children: ReactNode }) {
  return (
    <article
      className={`wc-card wc-card--${kind}`}
      data-status={state.status}
      data-pending={state.status === "pending" ? "true" : undefined}
      data-pending-card={state.status === "pending" && first ? "true" : undefined}
      tabIndex={-1}
      aria-label={label}
    >
      {children}
    </article>
  );
}

// ── 질문 (AskUserQuestion: 하나 고르기 · 여러 개 고르기 · 직접 쓰기 · 미리보기 있는 선택지) ──

interface Selection {
  picks: number[];
  write: boolean;
  text: string;
}

const EMPTY: Selection = { picks: [], write: false, text: "" };

function isAnswered(sel: Selection): boolean {
  return sel.picks.length > 0 || (sel.write && sel.text.trim() !== "");
}

/** 고른 것 → 답 (질문 문장 → 고른 라벨 · 라벨들 · 직접 쓴 글) */
export function buildAnswers(questions: readonly QuestionInfo[], selections: readonly Selection[]): Record<string, AnswerValue> {
  const answers: Record<string, AnswerValue> = {};
  questions.forEach((question, index) => {
    const sel = selections[index] ?? EMPTY;
    const labels = [...sel.picks].sort((a, b) => a - b).map((pick) => question.options[pick]?.label ?? "");
    const written = sel.write && sel.text.trim() !== "" ? sel.text.trim() : null;
    if (question.multiSelect) answers[question.question] = written === null ? labels : [...labels, written];
    else answers[question.question] = written ?? labels[0] ?? "";
  });
  return answers;
}

function QuestionBlock({
  question,
  value,
  disabled,
  onChange,
  onPicked,
  position,
  legendRef,
}: {
  question: QuestionInfo;
  value: Selection;
  disabled: boolean;
  onChange: (next: Selection) => void;
  /** 하나 고르기에서 선택지를 골랐다 (방향키로 훑을 때는 부르지 않는다) — 질문이 여럿이면 다음으로 넘기는 데 쓴다 */
  onPicked?: () => void;
  /** 질문이 여럿일 때 "질문 2/4" — 화면 읽기 프로그램용 */
  position?: string;
  legendRef?: Ref<HTMLLegendElement>;
}) {
  const name = useId();
  const previewId = useId();
  const multi = question.multiSelect;
  const type = multi ? "checkbox" : "radio";
  const hasPreview = question.options.some((option) => option.preview);
  const [peek, setPeek] = useState<number | null>(null);
  const shown = peek ?? value.picks[0] ?? 0;
  const preview = question.options[shown]?.preview ?? null;
  const writeRef = useRevealWhenOpen<HTMLInputElement>(value.write);

  const arrowing = useRef(false);

  const toggle = (index: number, checked: boolean) => {
    if (!multi) {
      onChange({ ...value, picks: [index], write: false });
      if (!arrowing.current) onPicked?.();
    }
    else onChange({ ...value, picks: checked ? [...value.picks.filter((pick) => pick !== index), index] : value.picks.filter((pick) => pick !== index) });
  };
  const toggleWrite = (checked: boolean) => {
    if (!multi) onChange({ ...value, picks: [], write: true });
    else onChange({ ...value, write: checked });
  };

  return (
    <fieldset className="wc-q" data-preview={hasPreview ? "true" : undefined} disabled={disabled}>
      <legend className="wc-q__prompt" ref={legendRef} tabIndex={legendRef ? -1 : undefined}>
        {position && <span className="ws-sr">{position}</span>}
        {question.header && <span className="wc-q__header">{question.header}</span>}
        <span className="wc-q__text">{question.question}</span>
        {multi && <span className="wc-q__multi">{t("variant.ws.card.multi")}</span>}
      </legend>
      <div className="wc-q__grid">
        <div
          className="wc-q__options"
          onMouseLeave={() => setPeek(null)}
          onKeyDown={(event) => {
            if (event.key.startsWith("Arrow")) arrowing.current = true;
          }}
          onKeyUp={() => {
            arrowing.current = false;
          }}
        >
          {question.options.map((option, index) => (
            <label
              key={`${index}:${option.label}`}
              className="wc-opt"
              data-peek={hasPreview && index === shown ? "true" : undefined}
              onMouseEnter={() => option.preview && setPeek(index)}
            >
              <input
                type={type}
                name={name}
                checked={value.picks.includes(index)}
                aria-describedby={option.preview ? previewId : undefined}
                onFocus={() => option.preview && setPeek(index)}
                onBlur={() => setPeek(null)}
                onChange={(event) => toggle(index, event.target.checked)}
              />
              <span className="wc-opt__key" aria-hidden="true">
                {String.fromCharCode(65 + (index % 26))}
              </span>
              <span className="wc-opt__body">
                <span className="wc-opt__label">{option.label}</span>
                {option.description && <span className="wc-opt__desc">{option.description}</span>}
              </span>
            </label>
          ))}
          <div className="wc-opt wc-opt--write">
            <label className="wc-opt__inline">
              <input type={type} name={name} checked={value.write} onChange={(event) => toggleWrite(event.target.checked)} />
              <span className="wc-opt__key" aria-hidden="true">
                …
              </span>
              <span className="wc-opt__label">{t("variant.ws.card.writeIn")}</span>
            </label>
            {value.write && (
              <input
                ref={writeRef}
                type="text"
                className="wc-opt__text-in"
                aria-label={t("variant.ws.card.writeInInput")}
                value={value.text}
                onChange={(event) => onChange({ ...value, text: event.target.value })}
              />
            )}
          </div>
        </div>
        {hasPreview && preview && (
          <figure className="wc-q__preview" id={previewId}>
            <figcaption>{tf("variant.ws.card.previewOf", { id: String.fromCharCode(65 + (shown % 26)), label: question.options[shown]?.label ?? "" })}</figcaption>
            <pre className="selectable">{preview}</pre>
          </figure>
        )}
      </div>
    </fieldset>
  );
}

function answerText(value: AnswerValue | undefined): string {
  if (value === undefined) return t("ws.chat.card.answeredNoText");
  return (Array.isArray(value) ? value : [value]).filter((item) => item !== "").join(" · ") || t("ws.chat.card.answeredNoText");
}

/** 질문 카드 — 질문이 하나면 고르고 보내기, 여럿이면 질문 하나씩(머리말 탭 · 이전 · 다음) 보이고 마지막에 요약을 보고 보낸다 */
export function QuestionCard({ info, state, onRespond, first }: CardProps & { info: QuestionRequestInfo }) {
  const total = info.questions.length;
  const multiStep = total > 1;
  const draft = getDraft(info.requestId);
  const [selections, setSelections] = useState<Selection[]>(() => (draft && draft.selections.length === total ? draft.selections : info.questions.map(() => EMPTY)));
  const [step, setStep] = useState(() => (multiStep && draft && draft.selections.length === total ? Math.min(draft.step, total) : 0));
  const { sending, error, submit } = useSubmit(onRespond, info.requestId);
  const progressId = useId();
  const tabsId = useId();
  const pending = state.status === "pending";
  const done = selections.filter(isAnswered).length;
  const complete = done === total;
  const summary = multiStep && step >= total;
  const tabs = useRef(new Map<number, HTMLButtonElement>());
  const headRef = useRef<HTMLElement | null>(null);
  const wantFocus = useRef(false);
  /** 요약에서 [바꾸기] 로 왔다 — 고치고 나면 남은 질문을 거치지 않고 요약으로 돌아간다 */
  const backToSummary = useRef(false);

  // 고른 값 · 보던 칸은 카드가 닫힐 때까지 앱 안에 둔다
  useEffect(() => {
    if (pending) setDraft(info.requestId, { selections, step });
    else dropDraft(info.requestId);
  }, [pending, info.requestId, selections, step]);
  // 질문이 바뀌면(탭 줄이 아닌 단추 · 고르기로) 새 질문 제목으로 초점 — "질문 2/4 …" 를 듣게
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    headRef.current?.focus();
  }, [step]);

  const go = (to: number, moveFocus: boolean) => {
    wantFocus.current = moveFocus;
    backToSummary.current = false;
    setStep(Math.max(0, Math.min(total, to)));
  };
  const advance = () => {
    if (backToSummary.current) go(total, true);
    else go(step + 1, true);
  };
  const change = (index: number) => {
    go(index, true);
    backToSummary.current = true;
  };
  const moveTab = (to: number) => {
    const next = (to + total + 1) % (total + 1);
    go(next, false);
    tabs.current.get(next)?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowRight") moveTab(step + 1);
    else if (event.key === "ArrowLeft") moveTab(step - 1);
    else if (event.key === "Home") moveTab(0);
    else if (event.key === "End") moveTab(total);
    else return;
    event.preventDefault();
  };

  const send = (event?: FormEvent) => {
    event?.preventDefault();
    if (!complete || sending) return;
    // 질문이 여럿이면 요약에서만 보낸다
    if (multiStep && !summary) return;
    void submit({ kind: "answer", answers: buildAnswers(info.questions, selections) });
  };
  // 선택지에서 Enter = 질문 하나면 보내기 (다 골랐을 때), 여럿이면 다음으로 (이 질문에 답했을 때)
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLInputElement;
    if (event.key === "Enter" && (target.type === "radio" || target.type === "checkbox")) {
      event.preventDefault();
      if (!multiStep) send();
      else if (!summary && isAnswered(selections[step] ?? EMPTY)) advance();
    }
  };

  const tabName = (index: number) => info.questions[index]?.header || tf("ws.chat.card.tabN", { n: index + 1 });
  const current = summary ? null : info.questions[step];
  const tabId = (index: number) => `${tabsId}-tab-${index}`;

  return (
    <Article kind="question" label={t("variant.ws.card.question")} state={state} first={first}>
      <CardHead label={t("variant.ws.card.question")} icon="info" status={state.status} />
      {pending ? (
        <form className="wc-card__body" onSubmit={send} onKeyDown={onKeyDown}>
          {multiStep && (
            <div className="wc-qtabs">
              <div className="wc-qtabs__list" role="tablist" aria-label={t("ws.chat.card.tabs")} onKeyDown={onTabKeyDown}>
                {info.questions.map((question, index) => {
                  const answered = isAnswered(selections[index] ?? EMPTY);
                  return (
                    <button
                      key={`${index}:${question.question}`}
                      type="button"
                      role="tab"
                      id={tabId(index)}
                      aria-selected={step === index}
                      aria-controls={`${tabsId}-panel`}
                      tabIndex={step === index ? 0 : -1}
                      className="wc-qtab"
                      data-done={answered ? "true" : undefined}
                      disabled={sending}
                      onClick={() => go(index, false)}
                      ref={(el) => {
                        if (el) tabs.current.set(index, el);
                        else tabs.current.delete(index);
                      }}
                    >
                      {answered && <Icon name="check" size={12} />}
                      {tabName(index)}
                      {answered && " "}
                      {answered && <span className="ws-sr">({t("ws.chat.card.tabDone")})</span>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  role="tab"
                  id={tabId(total)}
                  aria-selected={summary}
                  aria-controls={`${tabsId}-panel`}
                  tabIndex={summary ? 0 : -1}
                  className="wc-qtab"
                  disabled={sending}
                  onClick={() => go(total, false)}
                  ref={(el) => {
                        if (el) tabs.current.set(total, el);
                        else tabs.current.delete(total);
                      }}
                >
                  {t("ws.chat.card.tabSummary")}
                </button>
              </div>
              <span className="wc-qtabs__count" aria-hidden="true">
                {summary ? tf("ws.chat.card.stepSummary", { total }) : `${step + 1}/${total}`}
              </span>
            </div>
          )}
          <div className="wc-qpanel" role={multiStep ? "tabpanel" : undefined} id={multiStep ? `${tabsId}-panel` : undefined} aria-labelledby={multiStep ? tabId(step) : undefined}>
            {summary ? (
              <section className="wc-qsum" aria-labelledby={`${tabsId}-sum`}>
                <h3 className="wc-qsum__title" id={`${tabsId}-sum`} tabIndex={-1} ref={(el) => void (headRef.current = el)}>
                  {t("ws.chat.card.summaryTitle")}
                </h3>
                <dl className="wc-qsum__list">
                  {info.questions.map((question, index) => {
                    const ready = isAnswered(selections[index] ?? EMPTY);
                    const picked = buildAnswers([question], [selections[index] ?? EMPTY])[question.question];
                    return (
                      <div key={`${index}:${question.question}`} className="wc-qsum__row">
                        <dt>{tabName(index)}</dt>
                        <dd data-missing={ready ? undefined : "true"}>{ready ? answerText(picked) : t("ws.chat.card.unanswered")}</dd>
                        <button
                          type="button"
                          className="ws-btn ws-btn--small ws-btn--ghost"
                          disabled={sending}
                          aria-label={tf("ws.chat.card.changeOf", { name: tabName(index) })}
                          onClick={() => change(index)}
                        >
                          {t("ws.chat.card.change")}
                        </button>
                      </div>
                    );
                  })}
                </dl>
              </section>
            ) : (
              current && (
                <QuestionBlock
                  key={step}
                  question={current}
                  value={selections[step] ?? EMPTY}
                  disabled={sending}
                  position={multiStep ? `${tf("ws.chat.card.step", { n: step + 1, total })} ` : undefined}
                  legendRef={multiStep ? (el) => void (headRef.current = el) : undefined}
                  onPicked={multiStep ? advance : undefined}
                  onChange={(next) => setSelections((prev) => prev.map((sel, i) => (i === step ? next : sel)))}
                />
              )
            )}
          </div>
          <div className="wc-card__actions">
            {multiStep && (
              <button type="button" className="ws-btn" disabled={sending || step === 0} onClick={() => go(step - 1, true)}>
                {t("ws.chat.card.prev")}
              </button>
            )}
            {multiStep && !summary && (
              <button type="button" className="ws-btn ws-btn--primary" disabled={sending || !isAnswered(selections[step] ?? EMPTY)} onClick={advance}>
                {t("ws.chat.card.next")}
              </button>
            )}
            {(!multiStep || summary) && (
              <button type="submit" className="ws-btn ws-btn--primary" disabled={!complete || sending} aria-describedby={progressId}>
                {t(sending ? "ws.chat.card.sending" : "variant.ws.card.submit")}
              </button>
            )}
            <span className="wc-card__hint" id={progressId}>
              {tf("variant.ws.card.progress", { n: done, total })}
              <span aria-hidden="true"> · </span>
              {multiStep && !summary ? t("ws.chat.card.stepKeys") : t("variant.ws.card.keys")}
            </span>
          </div>
          <SendError text={error} />
        </form>
      ) : (
        <div className="wc-card__body">
          {state.status === "answered" ? (
            <dl className="wc-q-done">
              {info.questions.map((question, index) => (
                <div key={`${index}:${question.question}`}>
                  <dt>{question.header ?? question.question}</dt>
                  <dd>{answerText(state.answer?.answers?.[question.question])}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <>
              <ul className="wc-card__asked">
                {info.questions.map((question, index) => (
                  <li key={`${index}:${question.question}`}>{question.question}</li>
                ))}
              </ul>
              <Gone status={state.status === "expired" ? "expired" : "cancelled"} />
            </>
          )}
        </div>
      )}
    </Article>
  );
}

// ── 단계 승인 (하네스 약속 §7-2: 무엇을 · 왜 지금 · 산출물 · 하지 않는 것) ──

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd data-missing={value === null ? "true" : undefined}>{value ?? t("ws.chat.approval.unreadable")}</dd>
    </>
  );
}

/** 승인 카드 — 네 칸 + 승인 · 고쳐서 다시 · 기타(직접 쓰기). 답은 보통 질문과 같은 `answer` */
export function ApprovalCard({ info, approval, state, onRespond, first }: CardProps & { info: QuestionRequestInfo; approval: Approval }) {
  const question = info.questions[0];
  const { sending, error, submit } = useSubmit(onRespond, info.requestId);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const writeRef = useRevealWhenOpen<HTMLTextAreaElement>(writing);
  const pending = state.status === "pending";
  if (!question) return null;
  const answer = (value: string) => void submit({ kind: "answer", answers: { [question.question]: value } });
  const given = state.answer?.answers?.[question.question];
  const choice = approvalChoiceOf(given);
  const heading = approval.name ? `${approval.phase} ${approval.name}` : approval.phase;

  return (
    <Article kind="approval" label={t("variant.ws.card.approval")} state={state} first={first}>
      <CardHead label={t("variant.ws.card.approval")} icon="check" status={state.status} />
      <div className="wc-card__body">
        <h3 className="wc-card__title">{heading}</h3>
        <dl className="wc-appr">
          <Field label={t("variant.ws.approval.what")} value={approval.what} />
          <Field label={t("variant.ws.approval.why")} value={approval.why} />
          <Field label={t("variant.ws.approval.outputs")} value={approval.outputs} />
          <Field label={t("variant.ws.approval.notDoing")} value={approval.notDoing} />
        </dl>
        {pending ? (
          <>
            <div className="wc-card__actions">
              <button type="button" className="ws-btn ws-btn--primary" disabled={sending} onClick={() => answer(approvalLabel(question, "approve"))}>
                {t("variant.ws.approval.approve")}
              </button>
              <button type="button" className="ws-btn" disabled={sending} onClick={() => answer(approvalLabel(question, "redo"))}>
                {t("ws.chat.approval.redo")}
              </button>
              <button type="button" className="ws-btn ws-btn--ghost" disabled={sending} aria-expanded={writing} onClick={() => setWriting((open) => !open)}>
                {t("ws.chat.approval.other")}
              </button>
            </div>
            {writing && (
              <div className="wc-tell">
                <textarea
                  ref={writeRef}
                  className="wc-tell__in"
                  rows={2}
                  aria-label={t("ws.chat.approval.otherInput")}
                  placeholder={t("variant.ws.approval.changesPh")}
                  value={text}
                  disabled={sending}
                  onChange={(event) => setText(event.target.value)}
                />
                <button type="button" className="ws-btn" disabled={sending || text.trim() === ""} onClick={() => answer(text.trim())}>
                  {t("variant.ws.approval.changesSend")}
                </button>
              </div>
            )}
            <SendError text={error} />
          </>
        ) : state.status === "answered" ? (
          <p className="wc-card__result">
            <Icon name="check" size={16} />
            {choice === "approve"
              ? t("variant.ws.approval.result")
              : choice === "redo"
                ? t("ws.chat.approval.resultRedo")
                : tf("ws.chat.approval.resultOther", { text: Array.isArray(given) ? given.join(" · ") : (given ?? "") })}
          </p>
        ) : (
          <Gone status={state.status === "expired" ? "expired" : "cancelled"} />
        )}
      </div>
    </Article>
  );
}

/** 질문 요청 하나 — 승인 모양이면 승인 카드, 아니면 질문 카드 */
export function QuestionRequest(props: CardProps & { info: QuestionRequestInfo }) {
  const only = props.info.questions.length === 1 ? props.info.questions[0] : undefined;
  const approval = only ? parseApproval(only.question) : null;
  return approval ? <ApprovalCard {...props} approval={approval} /> : <QuestionCard {...props} />;
}

// ── 권한 (D-15 · D-23) ──

const TOOL_LABEL: Partial<Record<string, TextKey>> = {
  Bash: "variant.ws.perm.kind.Bash",
  Write: "variant.ws.perm.kind.Write",
  Edit: "variant.ws.perm.kind.Edit",
  WebFetch: "variant.ws.perm.kind.WebFetch",
};

const INPUT_SHOWN_MAX = 4000;

function inputText(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input, null, 2) ?? "");
  } catch {
    return null;
  }
  return text.length > INPUT_SHOWN_MAX ? `${text.slice(0, INPUT_SHOWN_MAX)}…` : text;
}

function PermissionResult({ info, state }: { info: PermissionView; state: CardState }) {
  const answer = state.answer;
  if (!answer) return <p className="wc-card__result">{t("variant.ws.card.done")}</p>;
  switch (answer.kind) {
    case "allow":
      return (
        <p className="wc-card__result" data-result="allow">
          <Icon name="check" size={16} />
          {t("variant.ws.perm.result.allow")}
        </p>
      );
    case "always_allow":
      return (
        <p className="wc-card__result" data-result="always">
          <Icon name="check" size={16} />
          {t("variant.ws.perm.result.always")}
          {info.alwaysRule && <code>{info.alwaysRule.rule}</code>}
        </p>
      );
    case "tell":
      return (
        <p className="wc-card__result" data-result="deny">
          <Icon name="close" size={16} />
          {answer.text ? tf("ws.chat.perm.resultTell", { text: answer.text }) : t("variant.ws.perm.result.deny")}
        </p>
      );
    default:
      return (
        <p className="wc-card__result" data-result="deny">
          <Icon name="close" size={16} />
          {answer.text ? tf("ws.chat.perm.resultDenyText", { text: answer.text }) : t("variant.ws.perm.result.deny")}
        </p>
      );
  }
}

/** 권한 카드 — 무엇을(도구 · 명령 · 파일) · 어디서 → 이번만 허용 / 항상 허용(규칙이 있을 때) / 거부 / 다르게 하라고 말하기 */
export function PermissionCard({ info, state, onRespond, first, more = 0 }: CardProps & { info: PermissionView; /** 이 카드 뒤에 기다리는 권한 요청 수 (0 이면 안 보임) */ more?: number }) {
  const { sending, error, submit } = useSubmit(onRespond, info.requestId);
  const [telling, setTelling] = useState(false);
  const [words, setWords] = useState("");
  const tellRef = useRevealWhenOpen<HTMLTextAreaElement>(telling);
  const alwaysId = useId();
  const pending = state.status === "pending";
  const target = info.command ?? info.path;
  const kindKey = TOOL_LABEL[info.tool];
  const input = inputText(info.input);

  return (
    <Article kind="permission" label={t("variant.ws.card.permission")} state={state} first={first}>
      <CardHead label={t("variant.ws.card.permission")} icon="key" status={state.status} note={pending && more > 0 ? tf("ws.chat.card.moreRequests", { n: more }) : null} />
      <div className="wc-card__body">
        {info.description && info.description !== target && <p className="wc-card__text">{info.description}</p>}
        <div className="wc-perm">
          <p className="wc-perm__tool">
            {kindKey && <span className="wc-perm__kind">{t(kindKey)}</span>}
            <code>{info.displayName ?? info.tool}</code>
          </p>
          {target && (
            <pre className="wc-card__code selectable">
              <code>{target}</code>
            </pre>
          )}
          <dl className="wc-perm__meta">
            <dt>{t("variant.ws.perm.where")}</dt>
            <dd>
              <code>{info.cwd}</code>
            </dd>
          </dl>
          {input !== null && (
            <details className="wc-perm__input">
              <summary>{t("ws.chat.perm.input")}</summary>
              <pre className="selectable">{input}</pre>
            </details>
          )}
        </div>
        {pending ? (
          <>
            <div className="wc-card__actions">
              <button type="button" className="ws-btn ws-btn--primary" disabled={sending} onClick={() => void submit({ kind: "allow" })}>
                {t("variant.ws.perm.allow")}
              </button>
              {info.alwaysRule && (
                <button type="button" className="ws-btn" disabled={sending} aria-describedby={alwaysId} onClick={() => void submit({ kind: "always_allow" })}>
                  {t("variant.ws.perm.always")}
                </button>
              )}
              <button type="button" className="ws-btn" disabled={sending} onClick={() => void submit({ kind: "deny" })}>
                {t("variant.ws.perm.deny")}
              </button>
              <button type="button" className="ws-btn ws-btn--ghost" disabled={sending} aria-expanded={telling} onClick={() => setTelling((open) => !open)}>
                {t("variant.ws.perm.denyTell")}
              </button>
            </div>
            {info.alwaysRule && (
              <p className="wc-perm__always" id={alwaysId}>
                {t("variant.ws.perm.alwaysNote1")} <code>{info.alwaysRule.rule}</code> {t("variant.ws.perm.alwaysNote2")}
              </p>
            )}
            {telling && (
              <div className="wc-tell">
                <textarea
                  ref={tellRef}
                  className="wc-tell__in"
                  rows={2}
                  aria-label={t("variant.ws.perm.denyTellInput")}
                  placeholder={t("variant.ws.perm.denyTellPh")}
                  value={words}
                  disabled={sending}
                  onChange={(event) => setWords(event.target.value)}
                />
                <button type="button" className="ws-btn" disabled={sending || words.trim() === ""} onClick={() => void submit({ kind: "tell", text: words.trim() })}>
                  {t("variant.ws.perm.denySend")}
                </button>
              </div>
            )}
            <SendError text={error} />
          </>
        ) : state.status === "answered" ? (
          <PermissionResult info={info} state={state} />
        ) : (
          <Gone status={state.status === "expired" ? "expired" : "cancelled"} />
        )}
      </div>
    </Article>
  );
}
