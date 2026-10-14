// 채팅 안의 선택 카드 4종 (D-14 · D-15) + 메시지. 모양은 토큰 · [data-variant] 로 시안마다 달라진다.
// 시안에서는 눌러도 아무 데도 보내지 않는다 — 고르는 모양 · 키보드 조작만 된다.
import { useId, useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t } from "../../i18n/ko";
import { ORCHESTRATOR } from "../fixtures";
import type { ChatItem, Question } from "../fixtures-workspace";
import { Icon } from "./icons";

type CardItem<K extends ChatItem["kind"]> = Extract<ChatItem, { kind: K }>;

function CardHead({ label, pending, time }: { label: string; pending: boolean; time: string }) {
  return (
    <header className="wcard__head">
      <span className="wcard__kind">{label}</span>
      <span className="wcard__state" data-pending={pending ? "true" : undefined}>
        {pending ? t("variant.ws.card.waiting") : t("variant.ws.card.done")}
      </span>
      <time className="wcard__time">{time}</time>
    </header>
  );
}

function QuestionBlock({ q, done }: { q: Question; done: boolean }) {
  const name = useId();
  const [writing, setWriting] = useState(false);
  const type = q.multi ? "checkbox" : "radio";
  return (
    <fieldset className="wq" disabled={done}>
      <legend className="wq__prompt">
        {t(q.promptKey)}
        {q.multi && <span className="wq__multi">{t("variant.ws.card.multi")}</span>}
      </legend>
      <div className="wq__options">
        {q.options.map((option) => (
          <label key={option.id} className="wopt">
            <input
              type={type}
              name={name}
              value={option.id}
              defaultChecked={q.answer?.includes(option.id)}
              onChange={() => !q.multi && setWriting(false)}
            />
            <span className="wopt__key" aria-hidden="true">
              {option.id}
            </span>
            <span className="wopt__label">{t(option.labelKey)}</span>
            {option.recommended && <span className="wopt__rec">{t("variant.ws.card.recommended")}</span>}
          </label>
        ))}
        {q.writeIn && (
          <div className="wopt wopt--write">
            <label className="wopt__inline">
              <input type={type} name={name} value="write" onChange={(event) => setWriting(event.target.checked)} />
              <span className="wopt__key" aria-hidden="true">
                …
              </span>
              <span className="wopt__label">{t("variant.ws.card.writeIn")}</span>
            </label>
            {writing && !done && (
              <input type="text" className="wopt__text" aria-label={t("variant.ws.card.writeInInput")} autoFocus />
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
}

/** 질문 카드 — 선택지 A/B/C + 권장 + 직접 쓰기, 여러 개 고르기 (고객이 선호하는 형식) */
export function QuestionCard({ item, id }: { item: CardItem<"question">; id?: string }) {
  const pending = !item.done;
  return (
    <article className="wcard wcard--question" data-pending={pending ? "true" : undefined} id={id} tabIndex={-1}>
      <CardHead label={t("variant.ws.card.question")} pending={pending} time={item.time} />
      <form className="wcard__body" onSubmit={(event) => event.preventDefault()}>
        {item.questions.map((q) => (
          <QuestionBlock key={q.id} q={q} done={item.done} />
        ))}
        {pending && (
          <div className="wcard__actions">
            <button type="submit" className="hbtn hbtn--primary">
              {t("variant.ws.card.submit")}
            </button>
          </div>
        )}
      </form>
    </article>
  );
}

/** 권한 카드 — 도구 · 무엇을 하려는지 · 허용 / 거부 / 이 프로젝트에서 항상 허용 (D-15 · D-23) */
export function PermissionCard({ item, id }: { item: CardItem<"permission">; id?: string }) {
  const pending = !item.result;
  return (
    <article className="wcard wcard--permission" data-pending={pending ? "true" : undefined} id={id} tabIndex={-1}>
      <CardHead label={t("variant.ws.card.permission")} pending={pending} time={item.time} />
      <div className="wcard__body">
        <p className="wcard__text">{t(item.whyKey)}</p>
        <p className="wperm__tool">
          <span>{t("variant.ws.perm.tool")}</span> <code>{item.tool}</code>
        </p>
        <pre className="wcard__code selectable">
          <code>{item.command}</code>
        </pre>
        {pending ? (
          <div className="wcard__actions">
            <button type="button" className="hbtn">
              {t("variant.ws.perm.allow")}
            </button>
            <button type="button" className="hbtn">
              {t("variant.ws.perm.deny")}
            </button>
            <button type="button" className="hbtn hbtn--ghost">
              {t("variant.ws.perm.always")}
            </button>
          </div>
        ) : (
          <p className="wcard__result">
            <Icon name="check" size={16} />
            {t(`variant.ws.perm.result.${item.result ?? "allow"}`)}
          </p>
        )}
      </div>
    </article>
  );
}

/** 승인 카드 — 무엇을 · 왜 지금 · 산출물 · 하지 않는 것 → 승인 / 고칠 점 */
export function ApprovalCard({ item, id }: { item: CardItem<"approval">; id?: string }) {
  const pending = !item.done;
  return (
    <article className="wcard wcard--approval" data-pending={pending ? "true" : undefined} id={id} tabIndex={-1}>
      <CardHead label={t("variant.ws.card.approval")} pending={pending} time={item.time} />
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
          <div className="wcard__actions">
            <button type="button" className="hbtn hbtn--primary">
              {t("variant.ws.approval.approve")}
            </button>
            <button type="button" className="hbtn">
              {t("variant.ws.approval.changes")}
            </button>
          </div>
        ) : (
          <p className="wcard__result">
            <Icon name="check" size={16} />
            {t("variant.ws.approval.result")}
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
    <article className="wcard wcard--run" data-pending={pending ? "true" : undefined} id={id} tabIndex={-1}>
      <CardHead label={t("variant.ws.card.runCheck")} pending={pending} time={item.time} />
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

export function ChatItemView({ item, pendingId }: { item: ChatItem; pendingId?: string }) {
  switch (item.kind) {
    case "user":
    case "orch":
      return <Message item={item} />;
    case "question":
      return <QuestionCard item={item} id={pendingId} />;
    case "permission":
      return <PermissionCard item={item} id={pendingId} />;
    case "approval":
      return <ApprovalCard item={item} id={pendingId} />;
    case "runcheck":
      return <RunCheckCard item={item} id={pendingId} />;
  }
}

export function isPending(item: ChatItem): boolean {
  if (item.kind === "permission") return !item.result;
  if (item.kind === "question" || item.kind === "approval" || item.kind === "runcheck") return !item.done;
  return false;
}
