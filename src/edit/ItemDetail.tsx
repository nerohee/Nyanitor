// 오른쪽 상세 — 고른 항목 하나: 머리 · 모델 · 수준(바꾸면 바로 저장) · 덧붙일 지시(자동 저장) · 원본 보기(+ 통째로 바꾸기) · 통째로 바꾼 항목의 파일 전체 · 내가 만든 항목의 파일 전체 · 지우기.
// 이 컴포넌트는 `key={항목 id + data.rev}` 로 그려진다 — 항목을 바꾸거나 큰 바뀜(적용 · 버리기 · 통째 시작 …)이 있으면 새로 읽는다. 쓰던 글은 그 전에 저장된다 (`useAutoSave` 의 떠날 때 저장 + `flushAll`).
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomItemDetail, CustomItemInfo, CustomItemRead, CustomTextPart, CustomWriteResult } from "../lib/ipc-types";
import { CUSTOM_EFFORTS, CUSTOM_LABEL_MAX_CHARS, CUSTOM_MODELS } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { MarkdownEditor } from "../workspace/MarkdownEditor";
import { errorKind } from "../workspace/errors";
import { errorLine, itemCat, itemLabel, refuseText, unreadableText, valueLabel } from "./format";
import { labelProblem } from "./newDraft";
import { Banner, ConfirmDialog, ItemFace, Marks, NotOursBanner, SaveBadge } from "./parts";
import { useAutoSave } from "./useAutoSave";
import type { EditData } from "./useCustom";

interface Props {
  entry: CustomItemInfo;
  data: EditData;
  /** 명령이 오류로 끝났을 때 (잠김 · 파일 쓰기 실패 …) — 화면 위 띠로 */
  report: (kind: AppErrorKind) => void;
  /** 「골라 보기」 — 원본 바뀜 탭으로 */
  onGoOrigin: (id: string) => void;
  /** 스크롤 칸 맨 아래에 붙는 "적용하면 바뀌는 것" */
  changes?: ReactNode;
}

type ReadState = { status: "loading" } | { status: "failed"; kind: AppErrorKind } | { status: "done"; read: CustomItemRead };

/** 글 덩이 → 편집기에 넣을 글. 읽을 수 없는 덩이는 null (편집하면 덮어쓰게 되니 편집기를 열지 않는다) */
function textOf(part: CustomTextPart): string | null {
  if (part.state === "text") return part.text;
  if (part.state === "absent") return "";
  return null;
}

function partProblem(part: CustomTextPart): string | null {
  if (part.state === "too_large") return t("edit.text.tooLarge");
  if (part.state === "unreadable") return unreadableText(part.reason);
  return null;
}

// ── 모델 · 수준 ──

type ValueKey = "model" | "effort";

function ValueRow({
  id,
  label,
  valueKey,
  value,
  origin,
  showOrigin,
  onChange,
}: {
  id: string;
  label: string;
  valueKey: ValueKey;
  value: string;
  /** 원본 값 (없으면 null) */
  origin: string | null;
  showOrigin: boolean;
  onChange: (next: string) => void;
}) {
  const known: readonly string[] = valueKey === "model" ? CUSTOM_MODELS : CUSTOM_EFFORTS;
  // 목록 밖 옛 값도 그대로 보인다 · 값이 아직 없는 항목은 "정해지지 않음" 을 첫 칸으로
  const options = [...(value === "" || origin === null ? [""] : []), ...known, ...(value !== "" && !known.includes(value) ? [value] : [])];
  const shown = (v: string) => (v === "" ? t("edit.valueNone") : valueLabel(valueKey, v));
  const originText = origin === null ? t("edit.valueNone") : shown(origin);
  const changed = value !== (origin ?? "");
  return (
    <div className="ed-value" data-changed={showOrigin && changed ? "true" : undefined}>
      <span className="ed-value__label" id={`${id}-label`}>
        {label}
      </span>
      {/* 펼치는 목록(<select>)은 OS 가 그려 어두운 테마에서 글씨가 안 보였다 (고객, 2026-11-09) — 셋뿐이라 한 줄 단추로 */}
      <span className="ed-seg" role="radiogroup" aria-labelledby={`${id}-label`}>
        {options.map((option) => (
          <label key={option || "none"} className="ed-seg__opt">
            <input type="radio" name={id} value={option} checked={value === option} onChange={() => onChange(option)} />
            <span>{shown(option)}</span>
          </label>
        ))}
      </span>
      {showOrigin && (
        <span className="ed-value__origin">
          {tf("edit.origin", { v: originText })}
          {changed && (
            <button type="button" className="ed-link" onClick={() => onChange(origin ?? "")}>
              {t("edit.toOrigin")}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

type ValuesState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; text: string };

function ValuesSection({ entry, data, report }: { entry: CustomItemInfo; data: EditData; report: Props["report"] }) {
  const mine = entry.marks.includes("mine");
  const [model, setModel] = useState(entry.currentModel ?? "");
  const [effort, setEffort] = useState(entry.currentEffort ?? "");
  const [state, setState] = useState<ValuesState>({ kind: "idle" });
  const [notOurs, setNotOurs] = useState(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  const ids = useId();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // 값을 저장하는 동안은 적용 단추를 켠다 (누르면 저장이 끝나기를 기다렸다가 적용한다)
  const saving = state.kind === "saving";
  const { markUnsaved } = data;
  useEffect(() => {
    markUnsaved(`${ids}-values`, saving);
    return () => markUnsaved(`${ids}-values`, false);
  }, [markUnsaved, ids, saving]);
  // 값 저장이 돌고 있으면 적용 · 버리기 · 화면 이동이 끝나기를 기다린다 (하네스는 한 번에 하나만 쓴다)
  const { registerFlush } = data;
  useEffect(() => registerFlush(() => queue.current, "values"), [registerFlush]);

  // 원본 값과 같게 고르면 "원본 값으로"(null) — 내가 만든 것은 원본이 없어 고른 값 그대로 (비우면 그 줄을 지운다)
  const wire = (selected: string, origin: string | null): string | null => (selected === "" || (!mine && selected === origin) ? null : selected);

  const save = (nextModel: string, nextEffort: string) => {
    queue.current = queue.current.then(async () => {
      if (alive.current) setState({ kind: "saving" });
      try {
        // 내가 만든 것의 값은 그 파일의 앞머리를 고친다 — 쓰던 글을 먼저 저장해야 그 글 위에 값이 얹힌다
        if (mine) await data.flushAll("text");
        const result: CustomWriteResult = await ipc.customValuesSave(entry.id, { model: wire(nextModel, entry.model), effort: wire(nextEffort, entry.effort) });
        if (result.outcome === "refused") {
          if (alive.current) setState({ kind: "failed", text: refuseText(result.reason) });
          return;
        }
        if (alive.current) {
          setState({ kind: "saved" });
          setNotOurs(result.notOurs);
        }
        if (mine) await data.refreshAll();
        else await data.refresh();
      } catch (raw) {
        const kind = errorKind(raw);
        if (alive.current) setState({ kind: "failed", text: errorLine(kind) });
        report(kind);
      }
    });
  };

  const change = (key: ValueKey, next: string) => {
    if (key === "model") setModel(next);
    else setEffort(next);
    setState({ kind: "saving" });
    save(key === "model" ? next : model, key === "effort" ? next : effort);
  };

  return (
    <section className="ed-sec" aria-labelledby={`${ids}-values`}>
      <h3 id={`${ids}-values`} className="ed-sec__title">
        {t("edit.values")}
        <span className="ed-sec__state" role="status">
          {state.kind === "saving" && t("variant.ws.editor.saving")}
          {state.kind === "saved" && (
            <>
              <Icon name="check" size={14} />
              {t("ws.editor.saved")}
            </>
          )}
          {state.kind === "failed" && (
            <span className="ed-sec__failed">
              <Icon name="alert" size={14} />
              {tf("ws.editor.saveFailed", { reason: state.text })}
            </span>
          )}
        </span>
      </h3>
      <p className="ed-sec__lead">{t(entry.kind === "main" ? "edit.valuesMain" : mine ? "edit.valuesMine" : "edit.valuesLead")}</p>
      <div className="ed-values">
        <ValueRow id={`${ids}-model`} label={t("cat.info.model")} valueKey="model" value={model} origin={entry.model} showOrigin={!mine} onChange={(v) => change("model", v)} />
        <ValueRow id={`${ids}-effort`} label={t("cat.info.effort")} valueKey="effort" value={effort} origin={entry.effort} showOrigin={!mine} onChange={(v) => change("effort", v)} />
      </div>
      <p className="ed-hint">
        <Icon name="info" size={14} />
        {t("edit.modelHint")}
      </p>
      {notOurs && <NotOursBanner />}
    </section>
  );
}

// ── 보이는 이름 (직접 만든 에이전트만, D-52) ──

type LabelState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; cleared: boolean } | { kind: "failed"; text: string };

/** 앱에서만 보이는 이름 한 칸 — Enter · 칸을 떠나면 저장 (바로 기록에 남는다), 비우면 지운다 (에이전트 이름이 보인다). 규칙 어긋남은 칸 아래에 */
function LabelSection({ entry, data, report }: { entry: CustomItemInfo; data: EditData; report: Props["report"] }) {
  const ids = useId();
  const stored = data.labels[entry.name] ?? "";
  const [value, setValue] = useState(stored);
  const [state, setState] = useState<LabelState>({ kind: "idle" });
  /** 파일에 적힌 것으로 아는 값 (앞뒤 공백 뗀 것) — 칸을 고쳤는지는 이것과 견준다 */
  const [written, setWritten] = useState(stored);
  const writtenRef = useRef(stored);
  const latest = useRef(stored);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const bad = labelProblem(value);
  const dirty = value.trim() !== written;
  const { markUnsaved, registerFlush, refresh } = data;
  const savable = dirty && !bad;
  useEffect(() => {
    markUnsaved(`${ids}-label`, savable);
    return () => markUnsaved(`${ids}-label`, false);
  }, [markUnsaved, ids, savable]);

  const commit = (): Promise<void> => {
    queue.current = queue.current.then(async () => {
      const next = latest.current.trim();
      if (next === writtenRef.current || labelProblem(next)) return;
      if (alive.current) setState({ kind: "saving" });
      try {
        const result = await ipc.customLabelSave(entry.name, next === "" ? null : next);
        if (result.outcome === "refused") {
          if (alive.current) setState({ kind: "failed", text: refuseText(result.reason) });
          return;
        }
        writtenRef.current = next;
        if (alive.current) setWritten(next);
        if (alive.current) setState({ kind: "saved", cleared: next === "" });
        await refresh();
      } catch (raw) {
        const kind = errorKind(raw);
        if (alive.current) setState({ kind: "failed", text: errorLine(kind) });
        report(kind);
      }
    });
    return queue.current;
  };
  // 적용 · 버리기 · 다른 화면으로 가기 전에 쓰던 이름을 먼저 저장한다
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  useEffect(() => registerFlush(() => commitRef.current()), [registerFlush]);

  return (
    <section className="ed-sec" aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`} className="ed-sec__title">
        {t("edit.label.title")}
        <span className="ed-sec__state" role="status">
          {state.kind === "saving" && t("edit.label.saving")}
          {state.kind === "saved" && (
            <>
              <Icon name="check" size={14} />
              {t(state.cleared ? "edit.label.cleared" : "edit.label.saved")}
            </>
          )}
        </span>
      </h3>
      <p className="ed-sec__lead" id={`${ids}-lead`}>
        {tf("edit.label.lead", { name: entry.name })}
      </p>
      <input
        className="ed-input ed-label__in"
        maxLength={CUSTOM_LABEL_MAX_CHARS}
        aria-label={t("edit.label.field")}
        aria-describedby={`${ids}-lead`}
        aria-invalid={bad ? true : undefined}
        placeholder={entry.name}
        autoComplete="off"
        value={value}
        onChange={(event) => {
          latest.current = event.target.value;
          setValue(event.target.value);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void commit();
          }
        }}
      />
      {bad && (
        <p className="ed-refused" role="alert">
          <Icon name="alert" size={14} />
          {t("edit.new.labelBad")}
        </p>
      )}
      {state.kind === "failed" && (
        <p className="ed-refused" role="alert">
          <Icon name="alert" size={14} />
          {tf("ws.editor.saveFailed", { reason: state.text })}
        </p>
      )}
    </section>
  );
}

// ── 글 칸 (덧붙임 · 파일 전체) ──

function TextSection({
  title,
  lead,
  fileHint,
  initial,
  save,
  data,
  label,
  tall,
}: {
  title: string;
  lead?: string;
  fileHint?: string;
  initial: string;
  save: (text: string) => Promise<CustomWriteResult>;
  data: EditData;
  label: string;
  /** 파일 전체처럼 긴 글 칸 */
  tall?: boolean;
}) {
  const ids = useId();
  const [notOurs, setNotOurs] = useState(false);
  const api = useAutoSave(initial, {
    save,
    onSaved: (result) => {
      setNotOurs(result.notOurs);
      if (result.changed) void data.refresh();
    },
  });
  const { registerFlush, markUnsaved } = data;
  const { flush } = api;
  useEffect(() => registerFlush(flush), [registerFlush, flush]);
  // 쓰는 중이라 저장 전이면 적용 단추를 켠다
  const unsaved = api.dirty || api.status.kind === "saving";
  useEffect(() => {
    markUnsaved(ids, unsaved);
    return () => markUnsaved(ids, false);
  }, [markUnsaved, ids, unsaved]);
  const refused = api.status.kind === "failed" && api.status.failure.kind === "refused" ? api.status.failure : null;
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      api.saveNow();
    }
  };
  return (
    <section className="ed-sec" aria-labelledby={`${ids}-text`}>
      <h3 id={`${ids}-text`} className="ed-sec__title">
        {title}
        {fileHint && <span className="ed-sec__file">{fileHint}</span>}
        <SaveBadge api={api} />
      </h3>
      {lead && <p className="ed-sec__lead">{lead}</p>}
      {tall ? (
        // 파일 전체 — 앞머리(---)가 든 파일이라 마크다운 강조 없이 고정폭 글자로 (시안과 같다)
        <textarea className="ed-whole" aria-label={label} defaultValue={api.doc.text} spellCheck={false} onChange={(event) => api.onEdit(event.target.value)} onKeyDown={onKeyDown} />
      ) : (
        <div className="ed-cm" onKeyDown={onKeyDown}>
          <MarkdownEditor doc={api.doc} label={label} onChange={api.onEdit} />
        </div>
      )}
      {notOurs && <NotOursBanner />}
      {refused && (
        <p className="ed-refused" role="alert">
          <Icon name="alert" size={14} />
          {refuseText(refused.reason)}
        </p>
      )}
      <p className="ed-keys">
        {t("variant.ws.editor.autosave")} <kbd>Ctrl</kbd>+<kbd>S</kbd>
      </p>
    </section>
  );
}

// ── 상세 ──

/** 지운 에이전트의 보이는 이름 · 고양이 줄을 지운다 — 못 지워도 지운 것은 그대로 (띠로만 알린다) */
async function dropAgentLines(name: string, data: EditData, report: Props["report"]): Promise<void> {
  try {
    if (data.labels[name] !== undefined) await ipc.customLabelSave(name, null);
    if (data.cats[name] !== undefined) await ipc.customCatsSave([{ agent: name, cat: null }]);
  } catch (raw) {
    report(errorKind(raw));
  }
}

type Confirm = null | { kind: "start" | "stop" | "delete"; busy: boolean; problem: string | null };

function ItemBody({ entry, detail, data, report, onGoOrigin, changes }: Props & { detail: CustomItemDetail }) {
  const id = entry.id;
  const mine = entry.marks.includes("mine");
  const replaced = entry.marks.includes("replace");
  const main = entry.kind === "main";
  const label = itemLabel(entry.kind, entry.name, data.roles, data.labels);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const appendText = textOf(detail.appendText);
  const wholeText = textOf(detail.replaceText);
  const originProblem = partProblem(detail.originText);

  const run = async () => {
    if (!confirm) return;
    const { kind } = confirm;
    setConfirm({ ...confirm, busy: true, problem: null });
    try {
      // 쓰던 글을 먼저 저장해 두어야 새로 읽을 때 사라지지 않는다
      await data.flushAll();
      const result = kind === "start" ? await ipc.customReplaceStart(id) : kind === "stop" ? await ipc.customReplaceStop(id) : await ipc.customMineDelete(id);
      if (result.outcome === "refused") {
        if (alive.current) setConfirm({ kind, busy: false, problem: refuseText(result.reason) });
        return;
      }
      // 같은 이름으로 다시 만들었을 때 옛 보이는 이름 · 고양이가 되살아나지 않게 그 줄도 지운다 (있을 때만)
      if (kind === "delete" && entry.kind === "agent") await dropAgentLines(entry.name, data, report);
      await data.refreshAll();
      if (alive.current) setConfirm(null);
    } catch (raw) {
      const errorKindFound = errorKind(raw);
      if (alive.current) setConfirm({ kind, busy: false, problem: errorLine(errorKindFound) });
      report(errorKindFound);
    }
  };

  const whole = (
    <TextSection
      title={t("edit.wholeFile")}
      fileHint={entry.file}
      initial={wholeText ?? ""}
      save={(text) => ipc.customTextSave(id, text)}
      data={data}
      label={t("edit.wholeFile")}
      tall
    />
  );

  return (
    <>
      <div className="ed-panel__scroll">
        {replaced && (
          <Banner tone="warn" title={t("edit.replaceTitle")}>
            <p>{t("edit.replaceBody")}</p>
          </Banner>
        )}
        {replaced && entry.originChanged === true && (
          <Banner
            tone="danger"
            title={detail.originGone ? t("edit.originGoneTitle") : t("edit.originChangedTitle")}
            actions={
              <button type="button" className="ws-btn" onClick={() => onGoOrigin(id)}>
                {t("edit.originChangedGo")}
              </button>
            }
          >
            <p>{detail.originGone ? t("edit.originGoneBody") : t("edit.originChangedBody")}</p>
          </Banner>
        )}
        {mine && entry.kind === "agent" && <LabelSection entry={entry} data={data} report={report} />}
        {mine && (
          <Banner tone="info" title={t("edit.mineTitle")}>
            <p>{t("edit.mineBody")}</p>
          </Banner>
        )}

        {(replaced || mine) &&
          (wholeText === null ? (
            <Banner tone="danger" title={t("edit.wholeUnreadable")}>
              <p>{partProblem(detail.replaceText)}</p>
            </Banner>
          ) : (
            whole
          ))}

        {replaced && (
          <div className="ed-row">
            <p className="ed-row__note">{t("edit.backToAppendNote")}</p>
            <button type="button" className="ws-btn" onClick={() => setConfirm({ kind: "stop", busy: false, problem: null })}>
              <Icon name="undo" size={16} />
              {t("edit.backToAppend")}
            </button>
          </div>
        )}
        {mine && (
          <div className="ed-row">
            <p className="ed-row__note">{t("edit.deleteNote")}</p>
            <button type="button" className="ws-btn ws-btn--danger" onClick={() => setConfirm({ kind: "delete", busy: false, problem: null })}>
              <Icon name="close" size={16} />
              {t("edit.delete")}
            </button>
          </div>
        )}

        <ValuesSection entry={entry} data={data} report={report} />

        {!main && !mine && (
          <>
            {appendText === null ? (
              <Banner tone="danger" title={t("edit.appendUnreadable")}>
                <p>{partProblem(detail.appendText)}</p>
              </Banner>
            ) : (
              <TextSection
                title={t("edit.append")}
                lead={t("edit.appendLead")}
                initial={appendText}
                save={(text) => ipc.customAppendSave(id, text)}
                data={data}
                label={t("edit.append")}
              />
            )}
            <details className="ed-origin">
              <summary>
                <Icon name="file" size={16} />
                <span className="ed-origin__title">{t("edit.originView")}</span>
                <span className="ed-origin__path">{tf("edit.originPath", { file: entry.file })}</span>
              </summary>
              {detail.originText.state === "text" ? <pre className="ed-origin__text">{detail.originText.text}</pre> : <p className="ed-origin__none">{originProblem ?? t("edit.originNone")}</p>}
              {!replaced && (
                <div className="ed-origin__whole">
                  <p>{t("edit.wholeWarn")}</p>
                  <button type="button" className="ws-btn" disabled={detail.originText.state !== "text"} onClick={() => setConfirm({ kind: "start", busy: false, problem: null })}>
                    <Icon name="custom" size={16} />
                    {t("edit.wholeGo")}
                  </button>
                </div>
              )}
            </details>
          </>
        )}
        {changes}
      </div>

      {confirm?.kind === "start" && (
        <ConfirmDialog titleId={`ed-confirm-${id}`} title={tf("edit.confirm.startTitle", { name: label })} confirmLabel={t("edit.wholeGo")} busy={confirm.busy} problem={confirm.problem} onConfirm={() => void run()} onCancel={() => setConfirm(null)}>
          <p>{t("edit.confirm.startBody")}</p>
          <p className="ed-dlg__warn">{t("edit.wholeWarn")}</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "stop" && (
        <ConfirmDialog titleId={`ed-confirm-${id}`} title={t("edit.confirm.stopTitle")} confirmLabel={t("edit.backToAppend")} danger busy={confirm.busy} problem={confirm.problem} onConfirm={() => void run()} onCancel={() => setConfirm(null)}>
          <p>{t("edit.confirm.stopBody")}</p>
        </ConfirmDialog>
      )}
      {confirm?.kind === "delete" && (
        <ConfirmDialog titleId={`ed-confirm-${id}`} title={tf("edit.confirm.deleteTitle", { name: label })} confirmLabel={t("edit.delete")} danger busy={confirm.busy} problem={confirm.problem} onConfirm={() => void run()} onCancel={() => setConfirm(null)}>
          <p>{t(entry.kind === "skill" ? "edit.confirm.deleteBodySkill" : "edit.confirm.deleteBody")}</p>
        </ConfirmDialog>
      )}
    </>
  );
}

export function ItemDetailPanel({ entry, data, report, onGoOrigin, changes }: Props) {
  const [state, setState] = useState<ReadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    ipc.customItemRead(entry.id).then(
      (read) => alive && setState({ status: "done", read }),
      (raw) => alive && setState({ status: "failed", kind: errorKind(raw) }),
    );
    return () => {
      alive = false;
    };
    // 항목 · 큰 바뀜마다 새로 만든다 (부모의 key) — 여기서는 다시 읽기 단추만 읽는 것을 되풀이한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  const label = itemLabel(entry.kind, entry.name, data.roles, data.labels);
  const cat = itemCat(entry.kind, entry.name, data.roles, data.cats);

  return (
    <section className="ed-panel" aria-labelledby="ed-panel-title">
      <header className="ed-panel__head">
        <span className="ed-panel__face">
          <ItemFace cat={cat} kind={entry.kind} />
        </span>
        <div className="ed-panel__titles">
          <h2 id="ed-panel-title" className="ed-panel__title">
            {label}
            <Marks marks={entry.marks} originChanged={entry.originChanged} />
          </h2>
          <p className="ed-panel__sub">
            <code>{entry.file}</code>
            {entry.description && (
              <>
                <span aria-hidden="true"> · </span>
                {entry.description}
              </>
            )}
          </p>
        </div>
      </header>
      {state.status === "loading" && (
        <p className="ed-state" role="status">
          {t("edit.item.loading")}
        </p>
      )}
      {state.status === "failed" && (
        <div className="ed-state" role="alert">
          <p>{tf("edit.item.failed", { reason: errorLine(state.kind) })}</p>
          <button
            type="button"
            className="ws-btn"
            onClick={() => {
              setState({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            {t("ws.proj.retry")}
          </button>
        </div>
      )}
      {state.status === "done" && state.read.state === "not_found" && (
        <div className="ed-state" role="alert">
          <p>{t("edit.item.gone")}</p>
        </div>
      )}
      {state.status === "done" && state.read.state === "unreadable" && (
        <div className="ed-state" role="alert">
          <p className="ed-state__title">{t("edit.item.unreadable")}</p>
          <p>{unreadableText(state.read.reason)}</p>
          <p className="ed-state__hint">{t("edit.item.unreadableHint")}</p>
        </div>
      )}
      {state.status === "done" && state.read.state === "ok" && <ItemBody entry={entry} detail={state.read} data={data} report={report} onGoOrigin={onGoOrigin} changes={changes} />}
    </section>
  );
}
