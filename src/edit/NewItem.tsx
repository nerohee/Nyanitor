// 「내 수정」 안의 새로 만들기 (시안 P2-15-edit-new) — 종류(에이전트 · 스킬) · 이름 · 보이는 이름 · 언제 쓰나 · 시작점(빈 틀 / 있는 것 복사) · 만들어질 파일 미리보기.
// 칸 값은 부모(`EditScreen`)가 들고 있다 (초안) — 고양이 고르기에 갔다 와도 그대로 남는다. 만들기 순서는 `newDraft.ts` 의 `createItem`.
// 펼치는 목록(<select>)은 OS 가 그려 어두운 테마에서 글씨가 안 보여서 쓰지 않는다 — 종류 · 모델 · 수준은 한 줄 단추, 복사할 것은 앱 안의 라디오 목록.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import { CUSTOM_DESCRIPTION_MAX_CHARS, CUSTOM_EFFORTS, CUSTOM_LABEL_MAX_CHARS, CUSTOM_MODELS, type CustomListEntry } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { itemLabel, valueLabel, type RoleMap } from "./format";
import { copyCandidates, draftReady, hasWriting, labelProblem, NAME_MAX_CHARS, nameProblem, oneLine, type NameProblem, type NewDraft, type NewKind } from "./newDraft";
import { Banner, ConfirmDialog } from "./parts";

/** 칸 아래에 보이는 서버 쪽 알림 — `customNew` 가 거절한 이유 (그 칸을 고치면 사라진다) */
export interface NewFormError {
  field: "name" | "general";
  text: string;
}

interface Props {
  draft: NewDraft;
  onChange: (patch: Partial<NewDraft>) => void;
  entries: readonly CustomListEntry[];
  roles: RoleMap;
  labels: Readonly<Record<string, string>>;
  error: NewFormError | null;
  /** 만드는 중 — 칸 · 단추를 잠근다 */
  busy: boolean;
  /** 화면 위 오류 띠 (EditScreen 이 준다) */
  banner?: ReactNode;
  /** 취소 — 쓴 것이 있으면 이 화면이 먼저 묻고, 확인하면 부른다 */
  onCancel: () => void;
  /** 주 단추 — 에이전트는 고양이 고르기로, 스킬은 바로 만들기 */
  onSubmit: () => void;
}

const PROBLEM_TEXT: Record<NameProblem, "edit.new.idBad" | "edit.new.idInSource" | "edit.new.idTaken" | "edit.new.idExists"> = {
  bad: "edit.new.idBad",
  source: "edit.new.idInSource",
  taken: "edit.new.idTaken",
  exists: "edit.new.idExists",
};

/** 한 줄 단추 묶음 (라디오) — 이름표 · 키보드(화살표)는 라디오가 한다 */
function Seg({
  label,
  name,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  name: string;
  value: string;
  options: ReadonlyArray<{
    value: string;
    text: string;
    icon?: "paw" | "file";
  }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="ed-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value || "none"} className="ed-seg__opt">
          <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={disabled} onChange={() => onChange(option.value)} />
          {option.icon && <Icon name={option.icon} size={14} />}
          <span>{option.text}</span>
        </label>
      ))}
    </span>
  );
}

/** 머리 줄 오른쪽 — 종류 (에이전트 · 스킬) */
export function KindPick({ kind, onChange, disabled }: { kind: NewKind; onChange: (kind: NewKind) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="ed-new__kind">
      <span className="ed-new__kind-label" aria-hidden="true">
        {t("edit.new.kind")}
      </span>
      <Seg
        label={t("edit.new.kind")}
        name={id}
        value={kind}
        disabled={disabled}
        onChange={(value) => onChange(value as NewKind)}
        options={[
          { value: "agent", text: t("edit.new.agent"), icon: "paw" },
          { value: "skill", text: t("edit.new.skill"), icon: "file" },
        ]}
      />
    </div>
  );
}

export function NewItem({ draft, onChange, entries, roles, labels, error, busy, banner, onCancel, onSubmit }: Props) {
  const ids = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const agent = draft.kind === "agent";
  // 처음 열릴 때 이름 칸에 커서 — 키보드만으로 바로 쓴다
  useEffect(() => nameInput.current?.focus(), []);

  const candidates = copyCandidates(entries, draft.kind);
  const from = candidates.find((item) => item.id === draft.from)?.id ?? candidates[0]?.id ?? null;
  const problem = nameProblem(draft.kind, draft.name, entries);
  const nameError = error?.field === "name" ? error.text : problem ? t(PROBLEM_TEXT[problem]) : null;
  const labelBad = agent && labelProblem(draft.label);
  const ready = draftReady(draft, entries, candidates.length);
  const file = agent ? `agents/${draft.name || "…"}.md` : `skills/${draft.name || "…"}/SKILL.md`;
  const frontTop = ["---", `name: ${draft.name || "…"}`, `description: ${draft.description.trim() || "…"}`].join("\n");
  const frontBottom = ["---", "", t("edit.new.bodyHint")].join("\n");

  const cancel = () => {
    if (hasWriting(draft)) setConfirming(true);
    else onCancel();
  };

  return (
    <>
      <header className="ed-tray__head">
        <div className="ed-tray__titles">
          <h1 className="ed-tray__title">{t("edit.new.title")}</h1>
          <p className="ed-tray__lead">{t("edit.new.lead")}</p>
        </div>
        <KindPick kind={draft.kind} onChange={(kind) => onChange({ kind, from: null })} disabled={busy} />
      </header>
      {banner}
      <div className="ed-new">
        <div className="ed-new__form">
          {error?.field === "general" && (
            <Banner tone="danger" live title={t("edit.new.failedTitle")}>
              <p>{error.text}</p>
            </Banner>
          )}
          <div className="ed-new__pair" data-agent={agent ? "true" : undefined}>
            <div className="ed-field">
              <label className="ed-field__label" htmlFor={`${ids}-name`}>
                {t(agent ? "edit.new.idAgent" : "edit.new.idSkill")}
              </label>
              <input
                ref={nameInput}
                id={`${ids}-name`}
                className="ed-input ed-input--mono"
                value={draft.name}
                maxLength={NAME_MAX_CHARS}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={`${ids}-name-note`}
                onChange={(event) => onChange({ name: event.target.value })}
              />
            </div>
            {agent && (
              <div className="ed-field">
                <label className="ed-field__label" htmlFor={`${ids}-label`}>
                  {t("edit.new.label")}
                  <span className="ed-field__opt">{t("edit.new.labelOptional")}</span>
                </label>
                <input
                  id={`${ids}-label`}
                  className="ed-input"
                  value={draft.label}
                  maxLength={CUSTOM_LABEL_MAX_CHARS}
                  disabled={busy}
                  autoComplete="off"
                  aria-invalid={labelBad ? true : undefined}
                  aria-describedby={`${ids}-label-note`}
                  onChange={(event) => onChange({ label: event.target.value })}
                />
              </div>
            )}
            <p className="ed-field__note ed-new__hint" id={`${ids}-name-note`} aria-live="polite" data-bad={nameError ? "true" : undefined}>
              {nameError ? (
                <>
                  <Icon name="alert" size={14} />
                  {nameError}
                </>
              ) : (
                t("edit.new.idHint")
              )}
            </p>
            {agent && (
              <p className="ed-field__note ed-new__hint" id={`${ids}-label-note`} data-bad={labelBad ? "true" : undefined}>
                {labelBad ? (
                  <>
                    <Icon name="alert" size={14} />
                    {t("edit.new.labelBad")}
                  </>
                ) : (
                  t("edit.new.labelHint")
                )}
              </p>
            )}
          </div>
          <div className="ed-field">
            <label className="ed-field__label" htmlFor={`${ids}-desc`}>
              {t("edit.new.desc")}
            </label>
            <textarea
              id={`${ids}-desc`}
              className="ed-input ed-new__desc"
              rows={2}
              maxLength={CUSTOM_DESCRIPTION_MAX_CHARS}
              value={draft.description}
              disabled={busy}
              aria-describedby={`${ids}-desc-note`}
              onChange={(event) => onChange({ description: oneLine(event.target.value) })}
            />
            <p className="ed-field__note" id={`${ids}-desc-note`}>
              {t(agent ? "edit.new.descHint" : "edit.new.descHintSkill")}
              <span className="ed-field__count">
                {tf("edit.new.descCount", {
                  n: [...draft.description].length,
                  max: CUSTOM_DESCRIPTION_MAX_CHARS,
                })}
              </span>
            </p>
          </div>
          <div className="ed-field ed-new__start" role="group" aria-labelledby={`${ids}-start`}>
            <span className="ed-field__label" id={`${ids}-start`}>
              {t("edit.new.start")}
            </span>
            <div className="ed-start">
              <label className="ed-start__card" data-checked={draft.start === "blank" ? "true" : undefined}>
                <input type="radio" name={`${ids}-start`} value="blank" checked={draft.start === "blank"} disabled={busy} onChange={() => onChange({ start: "blank" })} />
                <span className="ed-start__dot" aria-hidden="true" />
                <span className="ed-start__text">
                  <span className="ed-start__name">{t("edit.new.blank")}</span>
                  <span className="ed-start__desc">{t("edit.new.blankDesc")}</span>
                </span>
              </label>
              <div className="ed-start__card ed-start__card--copy" data-checked={draft.start === "copy" ? "true" : undefined}>
                <label className="ed-start__row">
                  <input type="radio" name={`${ids}-start`} value="copy" checked={draft.start === "copy"} disabled={busy} onChange={() => onChange({ start: "copy" })} />
                  <span className="ed-start__dot" aria-hidden="true" />
                  <span className="ed-start__text">
                    <span className="ed-start__name">{t("edit.new.copy")}</span>
                    <span className="ed-start__desc">{t("edit.new.copyDesc")}</span>
                  </span>
                </label>
                {draft.start === "copy" &&
                  (candidates.length === 0 ? (
                    <p className="ed-field__note ed-start__none" role="status">
                      {t("edit.new.copyNone")}
                    </p>
                  ) : (
                    <>
                      <div className="ed-copylist" role="radiogroup" aria-label={t("edit.new.copyFrom")}>
                        {candidates.map((item) => {
                          const label = itemLabel(item.kind, item.name, roles, labels);
                          return (
                            <label key={item.id} className="ed-copylist__row" data-checked={from === item.id ? "true" : undefined}>
                              <input type="radio" name={`${ids}-from`} value={item.id} checked={from === item.id} disabled={busy} onChange={() => onChange({ from: item.id })} />
                              <span className="ed-copylist__text">
                                {label !== item.name && <span className="ed-copylist__label">{label}</span>}
                                <code className="ed-copylist__name">{item.name}</code>
                              </span>
                              {from === item.id && <Icon name="check" size={14} />}
                            </label>
                          );
                        })}
                      </div>
                      <p className="ed-field__note">{t("edit.new.copyNote")}</p>
                    </>
                  ))}
              </div>
            </div>
          </div>
        </div>
        <aside className="ed-new__preview" aria-labelledby={`${ids}-preview`}>
          <h2 className="ed-sec__title" id={`${ids}-preview`}>
            {t("edit.new.preview")}
          </h2>
          <p className="ed-new__path">
            ~/.claude-harness/custom/
            <wbr />
            {file}
          </p>
          <div className="ed-new__file">
            <pre>{frontTop}</pre>
            {agent && (
              <div className="ed-new__values">
                <span className="ed-new__key" aria-hidden="true">
                  model:
                </span>
                <Seg
                  label={t("edit.new.model")}
                  name={`${ids}-model`}
                  value={draft.model}
                  disabled={busy}
                  onChange={(model) => onChange({ model })}
                  options={[
                    ...CUSTOM_MODELS.map((value) => ({
                      value: value as string,
                      text: valueLabel("model", value),
                    })),
                    { value: "", text: t("edit.new.valueNone") },
                  ]}
                />
                <span className="ed-new__key" aria-hidden="true">
                  effort:
                </span>
                <Seg
                  label={t("edit.new.effort")}
                  name={`${ids}-effort`}
                  value={draft.effort}
                  disabled={busy}
                  onChange={(effort) => onChange({ effort })}
                  options={[
                    ...CUSTOM_EFFORTS.map((value) => ({
                      value: value as string,
                      text: valueLabel("effort", value),
                    })),
                    { value: "", text: t("edit.new.valueNone") },
                  ]}
                />
              </div>
            )}
            <pre>{frontBottom}</pre>
          </div>
          {agent && (
            <div className="ed-new__cat">
              <span className="ed-face" aria-hidden="true">
                <Icon name="paw" size={18} />
              </span>
              <p>{t("edit.new.catNext")}</p>
            </div>
          )}
        </aside>
      </div>
      <footer className="ed-foot ed-new__foot">
        <p className="ed-foot__note" id={`${ids}-foot`} aria-live="polite">
          {busy ? t("edit.new.creating") : t("edit.new.foot")}
        </p>
        <button type="button" className="ws-btn" disabled={busy} onClick={cancel}>
          {t("variant.ui.cancel")}
        </button>
        <button
          type="button"
          className="ws-btn ws-btn--primary"
          disabled={!ready || busy}
          title={ready ? undefined : t("edit.new.needs")}
          aria-describedby={`${ids}-foot`}
          onClick={onSubmit}
        >
          {agent ? (
            <>
              {t("edit.new.next")}
              <Icon name="arrow" size={16} />
            </>
          ) : (
            <>
              <Icon name="check" size={16} />
              {t("edit.new.create")}
            </>
          )}
        </button>
      </footer>
      {confirming && (
        <ConfirmDialog
          titleId={`${ids}-discard`}
          title={t("edit.new.discardTitle")}
          confirmLabel={t("edit.new.discardGo")}
          cancelLabel={t("edit.new.discardKeep")}
          danger
          onConfirm={() => {
            setConfirming(false);
            onCancel();
          }}
          onCancel={() => setConfirming(false)}
        >
          <p>{t("edit.new.discardBody")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}
