// 시험 화면의 카드 — 권한 · 질문. 디자인 없는 시험용 (진짜 카드는 `src/variants/shared/cards.tsx` 의 모양으로 P6 에서).
// 카드는 답을 `onRespond` 로 올릴 뿐이다. 항상 허용의 규칙은 요청 이벤트의 `alwaysRule` 이고 화면이 고르지 않는다.
import { useId, useState } from "react";
import { t, tf, type TextKey } from "../i18n/ko";
import type {
  AlwaysRule,
  AnswerValue,
  ClaudeResponse,
  PermissionRequestInfo,
  QuestionInfo,
  QuestionRequestInfo,
} from "../lib/ipc";

export type Respond = (requestId: string, response: ClaudeResponse) => Promise<void>;

const RULE_NOTE: Record<AlwaysRule["scope"], TextKey> = {
  suggested: "lab.perm.ruleSuggested",
  folder: "lab.perm.ruleFolder",
  file: "lab.perm.ruleFile",
};

/** 항상 허용이 무엇을 허용하는지 한 문장 (카드가 미리 보여 준다 — D-23) */
export function ruleNote(rule: AlwaysRule): string {
  return tf(RULE_NOTE[rule.scope], { folder: rule.folder ?? "" });
}

export function PermissionCardLab({ info, onRespond }: { info: PermissionRequestInfo; onRespond: Respond }) {
  const [sending, setSending] = useState(false);
  const [telling, setTelling] = useState(false);
  const [words, setWords] = useState("");
  const noteId = useId();

  const send = async (response: ClaudeResponse) => {
    setSending(true);
    try {
      await onRespond(info.requestId, response);
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="lab-card" aria-label={t("lab.perm.title")}>
      <h3>
        {t("lab.perm.title")} — <code>{info.tool}</code>
      </h3>
      {info.description && <p>{info.description}</p>}
      <pre className="lab-code">{info.command ?? info.path ?? ""}</pre>
      <p>
        {t("lab.perm.where")}: <code>{info.cwd}</code>
      </p>
      <div className="lab-row">
        <button type="button" disabled={sending} onClick={() => void send({ kind: "allow" })}>
          {t("lab.perm.allow")}
        </button>
        {info.alwaysRule && (
          <button type="button" disabled={sending} aria-describedby={noteId} onClick={() => void send({ kind: "always_allow" })}>
            {t("lab.perm.always")}
          </button>
        )}
        <button type="button" disabled={sending} onClick={() => void send({ kind: "deny" })}>
          {t("lab.perm.deny")}
        </button>
        <button type="button" disabled={sending} aria-expanded={telling} onClick={() => setTelling((open) => !open)}>
          {t("lab.perm.tell")}
        </button>
      </div>
      {info.alwaysRule && (
        <p id={noteId} className="lab-note">
          {t("lab.perm.rule")}: <code>{info.alwaysRule.rule}</code> — {ruleNote(info.alwaysRule)}
        </p>
      )}
      {telling && (
        <div className="lab-row">
          <textarea aria-label={t("lab.perm.tellInput")} rows={2} value={words} onChange={(event) => setWords(event.target.value)} />
          <button
            type="button"
            disabled={sending || words.trim() === ""}
            onClick={() => void send({ kind: "tell", text: words.trim() })}
          >
            {t("lab.perm.tellSend")}
          </button>
        </div>
      )}
    </article>
  );
}

export interface QuestionDraft {
  /** 고른 선택지 라벨 */
  picked: string[];
  /** "직접 쓰기" 를 골랐나 · 쓴 글 */
  writing: boolean;
  written: string;
}

const EMPTY_DRAFT: QuestionDraft = { picked: [], writing: false, written: "" };

/** 카드의 고른 것을 질문 문장 → 답 으로. 아직 다 안 골랐으면 null. 하나만 고르는 질문은 글 하나, 여러 개는 글 배열. */
export function buildAnswers(questions: QuestionInfo[], drafts: QuestionDraft[]): Record<string, AnswerValue> | null {
  const answers: Record<string, AnswerValue> = {};
  for (const [index, question] of questions.entries()) {
    const draft = drafts[index] ?? EMPTY_DRAFT;
    const written = draft.written.trim();
    if (draft.writing && written === "") return null;
    if (question.multiSelect) {
      const list = [...draft.picked, ...(draft.writing ? [written] : [])];
      if (list.length === 0) return null;
      answers[question.question] = list;
    } else {
      const single = draft.writing ? written : draft.picked[0];
      if (single === undefined || single === "") return null;
      answers[question.question] = single;
    }
  }
  return answers;
}

function QuestionBlock({
  question,
  draft,
  onChange,
}: {
  question: QuestionInfo;
  draft: QuestionDraft;
  onChange: (next: QuestionDraft) => void;
}) {
  const name = useId();
  const type = question.multiSelect ? "checkbox" : "radio";

  const toggle = (label: string, checked: boolean) => {
    if (!question.multiSelect) {
      onChange({ ...draft, picked: [label], writing: false });
    } else {
      onChange({ ...draft, picked: checked ? [...draft.picked, label] : draft.picked.filter((l) => l !== label) });
    }
  };
  const toggleWrite = (checked: boolean) => {
    if (!question.multiSelect) onChange({ picked: [], writing: checked, written: draft.written });
    else onChange({ ...draft, writing: checked });
  };

  return (
    <fieldset className="lab-question">
      <legend>
        {question.header && <strong>{question.header} · </strong>}
        {question.question}
        {question.multiSelect && <em> ({t("lab.question.multi")})</em>}
      </legend>
      {question.options.map((option) => (
        <label key={option.label} className="lab-option">
          <input
            type={type}
            name={name}
            checked={draft.picked.includes(option.label)}
            onChange={(event) => toggle(option.label, event.target.checked)}
          />
          {option.label}
          {option.description && <span className="lab-note"> — {option.description}</span>}
        </label>
      ))}
      <label className="lab-option">
        <input type={type} name={name} checked={draft.writing} onChange={(event) => toggleWrite(event.target.checked)} />
        {t("lab.question.writeIn")}
      </label>
      {draft.writing && (
        <input
          type="text"
          aria-label={t("lab.question.writeInInput")}
          value={draft.written}
          onChange={(event) => onChange({ ...draft, written: event.target.value })}
        />
      )}
    </fieldset>
  );
}

export function QuestionCardLab({ info, onRespond }: { info: QuestionRequestInfo; onRespond: Respond }) {
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() => info.questions.map(() => EMPTY_DRAFT));
  const [sending, setSending] = useState(false);
  const answers = buildAnswers(info.questions, drafts);

  const send = async (response: ClaudeResponse) => {
    setSending(true);
    try {
      await onRespond(info.requestId, response);
    } finally {
      setSending(false);
    }
  };

  return (
    <article className="lab-card" aria-label={t("lab.question.title")}>
      <h3>{t("lab.question.title")}</h3>
      {info.questions.map((question, index) => (
        <QuestionBlock
          key={question.question}
          question={question}
          draft={drafts[index] ?? EMPTY_DRAFT}
          onChange={(next) => setDrafts((all) => all.map((draft, i) => (i === index ? next : draft)))}
        />
      ))}
      <div className="lab-row">
        <button type="button" disabled={sending || answers === null} onClick={() => answers && void send({ kind: "answer", answers })}>
          {t("lab.question.submit")}
        </button>
        <button type="button" disabled={sending} onClick={() => void send({ kind: "deny" })}>
          {t("lab.question.deny")}
        </button>
      </div>
    </article>
  );
}
