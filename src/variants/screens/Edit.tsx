// 내 수정 (plan §5 · D-05 · D-07 · D-21 · P9) — 에이전트 · 스킬 목록, 파일 고치기(모델 · 수준 값 / 덧붙일 지시 / 통째로), 새로 만들기,
// 기록 · 되돌리기(내 수정 폴더의 로컬 git), 원본이 바뀐 통째 교체 파일(내 것 유지 / 원본으로 / 비교).
// 상태: ?screen=edit&state=list(기본)|dirty(적용 전)|replace(통째로 바꾼 파일)|new(새로 만들기)|history(기록)|conflict(원본 바뀜) &item=designer
// 가짜 데이터 (fixtures-edit.ts). 실제 읽기 · 쓰기 · git 은 P9.
import { useState } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, tf, type TextKey } from "../../i18n/ko";
import {
  CUSTOM_ROOT,
  EDIT_HISTORY,
  EDIT_ITEMS,
  EDIT_STATES,
  editSelected,
  MINE_VS_ORIGIN,
  ORIGIN_CHANGE,
  ORIGIN_PREVIEW,
  REPLACED_TEXT,
  type CustomMark,
  type EditItem,
  type EditState,
  type EffortId,
  type HistoryEntry,
  type ModelId,
} from "../fixtures-edit";
import { pickState, screenHref, withParam } from "../query";
import { Icon } from "../shared/icons";
import { Banner, Chip, DiffView, Field, RadioRows, ScreenShell, Segmented, Select, type ChipTone, type ScreenFrameProps } from "./parts";
import "./edit.css";
import "./screens.css";

const MODELS: ModelId[] = ["opus", "sonnet", "haiku"];
const EFFORTS: EffortId[] = ["low", "medium", "high"];

const MARK: Record<CustomMark, { tone: ChipTone; key: TextKey }> = {
  values: { tone: "change", key: "variant.edit.mark.values" },
  append: { tone: "change", key: "variant.edit.mark.append" },
  replace: { tone: "warn", key: "variant.edit.mark.replace" },
  mine: { tone: "add", key: "variant.edit.mark.mine" },
};

function itemFrom(search: string, state: EditState): EditItem {
  const id = new URLSearchParams(search).get("item") ?? editSelected(state);
  return EDIT_ITEMS.find((item) => item.id === id) ?? EDIT_ITEMS[0];
}

function Marks({ item }: { item: EditItem }) {
  return (
    <>
      {item.marks.map((mark) => (
        <Chip key={mark} tone={MARK[mark].tone}>
          {t(MARK[mark].key)}
        </Chip>
      ))}
      {item.originChanged && (
        <Chip tone="delete">
          <Icon name="alert" size={12} />
          {t("variant.edit.mark.origin")}
        </Chip>
      )}
    </>
  );
}

function ItemFace({ item }: { item: EditItem }) {
  return (
    <span className="ed-face" data-kind={item.kind} aria-hidden="true">
      {item.cat ? <CatFigure cat={item.cat} crop="face" /> : <Icon name={item.kind === "skill" ? "file" : "paw"} size={18} />}
    </span>
  );
}

// ── 목록 ──

function ItemList({ current, onPick }: { current: string; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const match = (item: EditItem) => !query.trim() || t(item.nameKey).includes(query.trim()) || item.file.includes(query.trim());
  const groups: Array<{ key: TextKey; items: EditItem[] }> = [
    { key: "variant.edit.group.main", items: EDIT_ITEMS.filter((i) => i.kind === "main") },
    { key: "variant.edit.group.agents", items: EDIT_ITEMS.filter((i) => i.kind === "agent") },
    { key: "variant.edit.group.skills", items: EDIT_ITEMS.filter((i) => i.kind === "skill") },
  ];
  return (
    <nav className="ed-list" aria-label={t("variant.edit.listLabel")}>
      <label className="wproj__search ed-search">
        <Icon name="search" size={14} />
        <input
          type="search"
          className="wproj__search-in"
          placeholder={t("variant.edit.search")}
          aria-label={t("variant.edit.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div className="ed-list__scroll">
        {groups.map((group) => {
          const items = group.items.filter(match);
          if (items.length === 0) return null;
          return (
            <section key={group.key} aria-label={t(group.key)}>
              <h2 className="ed-list__title rnd">
                {t(group.key)}
                <span className="wproj__count">{group.items.length}</span>
              </h2>
              <ul className="ed-list__items">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="ed-item"
                      aria-current={item.id === current ? "true" : undefined}
                      onClick={() => onPick(item.id)}
                    >
                      <ItemFace item={item} />
                      <span className="ed-item__text">
                        <span className="ed-item__name rnd">{t(item.nameKey)}</span>
                        <span className="ed-item__file">{item.file}</span>
                      </span>
                      <span className="ed-item__marks">
                        <Marks item={item} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
  );
}

// ── 고치기 ──

function ValueRow({
  label,
  value,
  origin,
  onChange,
  options,
}: {
  label: string;
  value: string;
  origin: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const changed = value !== origin;
  return (
    <div className="ed-value" data-changed={changed ? "true" : undefined}>
      <span className="ed-value__label">{label}</span>
      <Select label={label} value={value} options={options} onChange={onChange} />
      <span className="ed-value__origin">
        {changed ? (
          <>
            {tf("variant.edit.origin", { v: options.find((o) => o.value === origin)?.label ?? origin })}
            <button type="button" className="su-link" onClick={() => onChange(origin)}>
              {t("variant.edit.toOrigin")}
            </button>
          </>
        ) : (
          t("variant.edit.sameAsOrigin")
        )}
      </span>
    </div>
  );
}

function Editor({ item, search, startDirty, onWhole }: { item: EditItem; search: string; startDirty: boolean; onWhole: () => void }) {
  const originModel = item.model ?? "sonnet";
  const originEffort = item.effort ?? "medium";
  // 마지막으로 적용한 값 (처음에는 내 수정 폴더에 있는 값)
  const [saved, setSaved] = useState<{ model: string; effort: string; append: string }>(() => ({
    model: item.myModel ?? originModel,
    effort: item.myEffort ?? originEffort,
    append: item.appendKey ? t(item.appendKey) : "",
  }));
  const savedModel = saved.model;
  const savedEffort = saved.effort;
  const savedAppend = saved.append;
  const [model, setModel] = useState<string>(startDirty ? "opus" : savedModel);
  const [effort, setEffort] = useState<string>(savedEffort);
  const [append, setAppend] = useState(savedAppend);
  const [applied, setApplied] = useState<string | null>(null);
  const dirtyCount = [model !== savedModel, effort !== savedEffort, append !== savedAppend].filter(Boolean).length;
  const hasValues = item.kind !== "skill";
  const mine = item.marks.includes("mine");
  const apply = () => {
    setSaved({ model, effort, append });
    setApplied(tf("variant.edit.applied", { hash: "f3a91c2" }));
  };
  const revert = () => {
    setModel(savedModel);
    setEffort(savedEffort);
    setAppend(savedAppend);
  };
  const modelOptions = MODELS.map((m) => ({ value: m, label: t(`variant.edit.model.${m}`) }));
  const effortOptions = EFFORTS.map((e) => ({ value: e, label: t(`cat.effort.${e}`) }));

  return (
    <>
      <div className="ed-panel__scroll">
        {applied && dirtyCount === 0 && <Banner tone="ok" live title={applied} />}
        {mine && (
          <Banner tone="info" title={t("variant.edit.mineTitle")}>
            <p>{t("variant.edit.mineBody")}</p>
          </Banner>
        )}
        {hasValues && (
          <section className="ed-sec" aria-labelledby="ed-values">
            <h3 id="ed-values" className="ed-sec__title rnd">
              {t("variant.edit.values")}
            </h3>
            <p className="ed-sec__lead muted">{t(item.kind === "main" ? "variant.edit.valuesMain" : "variant.edit.valuesLead")}</p>
            <div className="ed-values">
              <ValueRow label={t("cat.info.model")} value={model} origin={originModel} onChange={setModel} options={modelOptions} />
              <ValueRow label={t("cat.info.effort")} value={effort} origin={originEffort} onChange={setEffort} options={effortOptions} />
            </div>
            <p className="ed-hint muted su-small">
              <Icon name="info" size={14} />
              {t("variant.edit.modelHint")}
            </p>
          </section>
        )}
        {item.kind !== "main" && !mine && (
          <section className="ed-sec" aria-labelledby="ed-append">
            <h3 id="ed-append" className="ed-sec__title rnd">
              {t("variant.edit.append")}
            </h3>
            <p className="ed-sec__lead muted">{t("variant.edit.appendLead")}</p>
            <textarea
              className="fld ed-append"
              rows={5}
              aria-labelledby="ed-append"
              value={append}
              placeholder={t("variant.edit.appendPh")}
              onChange={(e) => setAppend(e.target.value)}
              spellCheck={false}
            />
          </section>
        )}
        {mine && (
          <section className="ed-sec" aria-labelledby="ed-mine">
            <h3 id="ed-mine" className="ed-sec__title rnd">
              {t("variant.edit.wholeFile")}
            </h3>
            <textarea
              className="fld ed-whole"
              rows={10}
              aria-labelledby="ed-mine"
              defaultValue={t("variant.fixture.edit.translator.file")}
              spellCheck={false}
            />
          </section>
        )}
        {item.kind !== "main" && !mine && (
          <details className="ed-origin">
            <summary className="rnd">
              <Icon name="file" size={16} />
              {t("variant.edit.originView")}
              <span className="muted su-small">{tf("variant.edit.originPath", { file: item.file })}</span>
            </summary>
            <pre className="selectable">{ORIGIN_PREVIEW[item.id] ?? ORIGIN_PREVIEW["builder-ui"]}</pre>
            <div className="ed-origin__whole">
              <p className="muted su-small">{t("variant.edit.wholeWarn")}</p>
              <button type="button" className="hbtn" onClick={onWhole}>
                <Icon name="custom" size={16} />
                {t("variant.edit.wholeGo")}
              </button>
            </div>
          </details>
        )}
        {dirtyCount > 0 && (
          <div className="ed-sec">
            <h3 className="ed-sec__title rnd">{t("variant.edit.willWrite")}</h3>
            <DiffView
              label={t("variant.edit.willWrite")}
              lines={[
                { sign: "@", text: `@@ ${CUSTOM_ROOT}${item.file} @@` },
                ...(model !== savedModel
                  ? [
                      { sign: "-" as const, text: `model: ${savedModel}`, old: 4 },
                      { sign: "+" as const, text: `model: ${model}`, new: 4 },
                    ]
                  : []),
                ...(effort !== savedEffort
                  ? [
                      { sign: "-" as const, text: `effort: ${savedEffort}`, old: 5 },
                      { sign: "+" as const, text: `effort: ${effort}`, new: 5 },
                    ]
                  : []),
                ...(append !== savedAppend ? [{ sign: "+" as const, text: t("variant.edit.appendChanged"), new: 1 }] : []),
              ]}
            />
          </div>
        )}
      </div>
      <footer className="tray__foot ed-foot">
        <p className="tray__foot-note">
          {dirtyCount > 0 ? (
            <span className="ed-dirty">
              <span className="wed__dot" aria-hidden="true" />
              {tf("variant.edit.dirty", { n: dirtyCount })}
            </span>
          ) : (
            t("variant.edit.clean")
          )}
          <span className="ed-foot__where">{t("variant.edit.applyNote")}</span>
        </p>
        {item.cat && item.kind === "agent" && (
          <a className="hbtn hbtn--ghost" href={screenHref(search, "pick", { agent: item.id })}>
            <Icon name="paw" size={16} />
            {t("variant.edit.changeCat")}
          </a>
        )}
        <button type="button" className="hbtn" onClick={revert} disabled={dirtyCount === 0}>
          <Icon name="undo" size={16} />
          {t("variant.edit.revert")}
        </button>
        <button type="button" className="hbtn hbtn--primary" onClick={apply} disabled={dirtyCount === 0}>
          <Icon name="check" size={16} />
          {t("variant.edit.apply")}
        </button>
      </footer>
    </>
  );
}

function WholeEditor({ item, search, onBack }: { item: EditItem; search: string; onBack: () => void }) {
  return (
    <>
      <div className="ed-panel__scroll">
        <Banner tone="warn" title={t("variant.edit.replaceTitle")}>
          <p>{t("variant.edit.replaceBody")}</p>
        </Banner>
        {item.originChanged && (
          <Banner
            tone="danger"
            title={t("variant.edit.originChangedTitle")}
            actions={
              <a className="hbtn" href={withParam(search, "state", "conflict")}>
                {t("variant.edit.originChangedGo")}
              </a>
            }
          >
            <p>{t("variant.edit.originChangedBody")}</p>
          </Banner>
        )}
        <section className="ed-sec" aria-labelledby="ed-whole">
          <h3 id="ed-whole" className="ed-sec__title rnd">
            {t("variant.edit.wholeFile")}
            <span className="muted su-small">{CUSTOM_ROOT + item.file}</span>
          </h3>
          <textarea className="fld ed-whole" rows={14} aria-labelledby="ed-whole" defaultValue={REPLACED_TEXT} spellCheck={false} />
        </section>
      </div>
      <footer className="tray__foot ed-foot">
        <p className="tray__foot-note">{t("variant.edit.clean")}</p>
        <button type="button" className="hbtn" onClick={onBack}>
          <Icon name="undo" size={16} />
          {t("variant.edit.backToAppend")}
        </button>
        <button type="button" className="hbtn hbtn--primary" disabled>
          <Icon name="check" size={16} />
          {t("variant.edit.apply")}
        </button>
      </footer>
    </>
  );
}

function ItemPanel({ item, search, state }: { item: EditItem; search: string; state: EditState }) {
  const [whole, setWhole] = useState(item.marks.includes("replace"));
  return (
    <section className="ed-panel" aria-labelledby="ed-panel-title">
      <header className="ed-panel__head">
        <span className="ed-panel__face">
          <ItemFace item={item} />
        </span>
        <div className="ed-panel__titles">
          <h2 id="ed-panel-title" className="ed-panel__title rnd">
            {t(item.nameKey)}
            <Marks item={item} />
          </h2>
          <p className="muted su-small">
            <code className="mono">{item.file}</code>
            <span aria-hidden="true"> · </span>
            {t(item.descKey)}
          </p>
        </div>
      </header>
      {whole ? (
        <WholeEditor item={item} search={search} onBack={() => setWhole(false)} />
      ) : (
        <Editor key={item.id} item={item} search={search} startDirty={state === "dirty"} onWhole={() => setWhole(true)} />
      )}
    </section>
  );
}

// ── 새로 만들기 ──

type NewKind = "agent" | "skill";

/** 종류 고르기 — 판 머리 줄 오른쪽에 (다른 상태에서 "새로 만들기" 단추가 있는 자리). 폼의 세로 길이를 줄이려고 (D-43) */
function NewKindPick({ kind, onChange }: { kind: NewKind; onChange: (kind: NewKind) => void }) {
  return (
    <div className="ed-new__kind">
      <span className="ed-field__label rnd" aria-hidden="true">
        {t("variant.edit.new.kind")}
      </span>
      <Segmented
        label={t("variant.edit.new.kind")}
        value={kind}
        onChange={onChange}
        options={[
          { value: "agent", label: t("variant.edit.new.agent"), icon: "paw" },
          { value: "skill", label: t("variant.edit.new.skill"), icon: "file" },
        ]}
      />
    </div>
  );
}

function NewForm({ search, kind }: { search: string; kind: NewKind }) {
  const [id, setId] = useState("translator");
  const [name, setName] = useState(t("variant.agent.translator"));
  const [desc, setDesc] = useState(t("variant.fixture.edit.translator.desc"));
  const [model, setModel] = useState<string>("sonnet");
  const [effort, setEffort] = useState<string>("medium");
  const [start, setStart] = useState<"blank" | "copy">("blank");
  const [from, setFrom] = useState("builder-ui");
  const file = kind === "agent" ? `agents/${id || "…"}.md` : `skills/${id || "…"}/SKILL.md`;
  // 미리보기는 앞머리 위 · 아래로 나누고, 에이전트면 그 사이의 model · effort 줄을 바로 고르는 칸으로 (D-43 — 모델 · 수준을 옆 칸으로)
  const frontTop = [`---`, `name: ${id}`, `description: ${desc}`].join("\n");
  const frontBottom = [`---`, ``, t("variant.edit.new.bodyHint")].join("\n");
  return (
    <>
      <div className="tray__body ed-new">
        <div className="ed-new__form">
          {/* 파일 이름 | 보이는 이름 — 한 줄에 둘, 파일 이름 도움말은 그 아래 한 줄 (1024×640 에서도 판이 스크롤되지 않게, D-43) */}
          <div className="ed-new__pair">
            <label className="ed-field">
              <span className="ed-field__label rnd">{t("variant.edit.new.id")}</span>
              <Field label={t("variant.edit.new.id")} value={id} mono onChange={(v) => setId(v.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />
            </label>
            <label className="ed-field">
              <span className="ed-field__label rnd">{t("variant.edit.new.name")}</span>
              <Field label={t("variant.edit.new.name")} value={name} onChange={setName} />
            </label>
            <span className="muted su-small ed-new__hint">{t("variant.edit.new.idHint")}</span>
          </div>
          <label className="ed-field">
            <span className="ed-field__label rnd">{t("variant.edit.new.desc")}</span>
            <textarea
              className="fld ed-desc"
              rows={2}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              aria-label={t("variant.edit.new.desc")}
            />
            <span className="muted su-small">{t("variant.edit.new.descHint")}</span>
          </label>
          <div className="ed-field ed-new__start">
            <span className="ed-field__label rnd">{t("variant.edit.new.start")}</span>
            <RadioRows
              label={t("variant.edit.new.start")}
              value={start}
              onChange={setStart}
              options={[
                { value: "blank", label: t("variant.edit.new.blank"), desc: t("variant.edit.new.blankDesc") },
                {
                  value: "copy",
                  label: t("variant.edit.new.copy"),
                  desc: t("variant.edit.new.copyDesc"),
                  extra: (
                    <Select
                      label={t("variant.edit.new.copy")}
                      value={from}
                      onChange={setFrom}
                      options={EDIT_ITEMS.filter((i) => i.kind === kind).map((i) => ({
                        value: i.id,
                        label: `${t(i.nameKey)} — ${i.file}`,
                      }))}
                    />
                  ),
                },
              ]}
            />
          </div>
        </div>
        <aside className="ed-new__preview">
          <h2 className="ed-sec__title rnd">{t("variant.edit.new.preview")}</h2>
          <p className="mono selectable ed-new__path">
            {CUSTOM_ROOT}
            <wbr />
            {file}
          </p>
          <div className="ed-new__file">
            <pre className="selectable">{frontTop}</pre>
            {kind === "agent" && (
              <div className="ed-new__values" role="group" aria-label={t("variant.edit.values")}>
                <span className="ed-new__key" aria-hidden="true">
                  model:
                </span>
                <Select
                  label={t("cat.info.model")}
                  value={model}
                  onChange={setModel}
                  options={MODELS.map((m) => ({ value: m, label: t(`variant.edit.model.${m}`) }))}
                />
                <span className="ed-new__key" aria-hidden="true">
                  effort:
                </span>
                <Select
                  label={t("cat.info.effort")}
                  value={effort}
                  onChange={setEffort}
                  options={EFFORTS.map((e) => ({ value: e, label: t(`cat.effort.${e}`) }))}
                />
              </div>
            )}
            <pre className="selectable">{frontBottom}</pre>
          </div>
          {kind === "agent" && (
            <div className="ed-new__cat">
              <span className="ed-face" aria-hidden="true">
                <Icon name="paw" size={18} />
              </span>
              <p className="su-small">{t("variant.edit.new.catNext")}</p>
            </div>
          )}
        </aside>
      </div>
      <footer className="tray__foot">
        <p className="tray__foot-note">{t(kind === "agent" ? "variant.edit.new.footAgent" : "variant.edit.new.footSkill")}</p>
        <a className="hbtn" href={withParam(search, "state", null)}>
          {t("variant.ui.cancel")}
        </a>
        {kind === "agent" ? (
          <a className="hbtn hbtn--primary" href={screenHref(search, "pick", { state: "new" })}>
            {t("variant.edit.new.goCat")}
            <Icon name="arrow" size={16} />
          </a>
        ) : (
          <a className="hbtn hbtn--primary" href={withParam(search, "state", null)}>
            <Icon name="check" size={16} />
            {t("variant.edit.new.create")}
          </a>
        )}
      </footer>
    </>
  );
}

// ── 기록 ──

const HIST_ICON: Record<HistoryEntry["kind"], "custom" | "plus" | "download" | "undo"> = {
  edit: "custom",
  new: "plus",
  update: "download",
  undo: "undo",
};

function History() {
  const [current, setCurrent] = useState(EDIT_HISTORY[0].id);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const entry = EDIT_HISTORY.find((h) => h.id === current) ?? EDIT_HISTORY[0];
  return (
    <div className="tray__body ed-split">
      <nav className="ed-list" aria-label={t("variant.edit.histList")}>
        <p className="ed-list__note muted su-small">{tf("variant.edit.histNote", { root: CUSTOM_ROOT })}</p>
        <ol className="ed-hist">
          {EDIT_HISTORY.map((h, i) => (
            <li key={h.id}>
              <button
                type="button"
                className="ed-hist__item"
                aria-current={h.id === current ? "true" : undefined}
                onClick={() => {
                  setCurrent(h.id);
                  setConfirm(false);
                  setDone(null);
                }}
              >
                <span className="ed-hist__dot" data-kind={h.kind} aria-hidden="true">
                  <Icon name={HIST_ICON[h.kind]} size={14} />
                </span>
                <span className="ed-hist__text">
                  <span className="ed-hist__msg">{t(h.textKey)}</span>
                  <span className="ed-hist__when muted">
                    {t(h.whenKey)} · <code className="mono">{h.hash}</code>
                    {i === 0 && <Chip tone="accent">{t("variant.edit.histNow")}</Chip>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </nav>
      <section className="ed-panel" aria-labelledby="ed-hist-title">
        <header className="ed-panel__head">
          <div className="ed-panel__titles">
            <h2 id="ed-hist-title" className="ed-panel__title rnd">
              {t(entry.textKey)}
            </h2>
            <p className="muted su-small">
              {t(entry.whenKey)} · <code className="mono">{entry.hash}</code> · {entry.files.join(", ")}
            </p>
          </div>
        </header>
        <div className="ed-panel__scroll">
          {done && <Banner tone="ok" live title={done} />}
          {entry.diff ? <DiffView lines={entry.diff} label={t(entry.textKey)} /> : <p className="muted">{t("variant.edit.histUpdate")}</p>}
          {confirm && (
            <Banner
              tone="warn"
              title={tf("variant.edit.undoTitle", { hash: entry.hash })}
              actions={
                <>
                  <button
                    type="button"
                    className="hbtn hbtn--primary"
                    onClick={() => {
                      setConfirm(false);
                      setDone(tf("variant.edit.undone", { hash: entry.hash }));
                    }}
                  >
                    {t("variant.edit.undoGo")}
                  </button>
                  <button type="button" className="hbtn" onClick={() => setConfirm(false)}>
                    {t("variant.ui.cancel")}
                  </button>
                </>
              }
            >
              <p>{t("variant.edit.undoBody")}</p>
            </Banner>
          )}
        </div>
        <footer className="tray__foot">
          <p className="tray__foot-note">{t("variant.edit.histFoot")}</p>
          <button
            type="button"
            className="hbtn"
            aria-expanded={confirm}
            onClick={() => setConfirm(true)}
            disabled={entry.id === EDIT_HISTORY[0].id}
          >
            <Icon name="undo" size={16} />
            {t("variant.edit.undoHere")}
          </button>
        </footer>
      </section>
    </div>
  );
}

// ── 원본 바뀜 ──

function Conflict({ search }: { search: string }) {
  const item = EDIT_ITEMS.find((i) => i.originChanged) ?? EDIT_ITEMS[1];
  const [view, setView] = useState<"origin" | "mine">("origin");
  const [chosen, setChosen] = useState<"keep" | "origin" | null>(null);
  return (
    <div className="tray__body ed-split">
      <nav className="ed-list" aria-label={t("variant.edit.conflictList")}>
        <p className="ed-list__note muted su-small">{t("variant.edit.conflictNote")}</p>
        <ul className="ed-list__items">
          <li>
            <button type="button" className="ed-item" aria-current="true">
              <ItemFace item={item} />
              <span className="ed-item__text">
                <span className="ed-item__name rnd">{t(item.nameKey)}</span>
                <span className="ed-item__file">{item.file}</span>
              </span>
              <span className="ed-item__marks">
                {chosen ? (
                  <Chip tone="keep">{t(`variant.edit.chosen.${chosen}`)}</Chip>
                ) : (
                  <Chip tone="delete">{t("variant.edit.needChoice")}</Chip>
                )}
              </span>
            </button>
          </li>
        </ul>
      </nav>
      <section className="ed-panel" aria-labelledby="ed-cf-title">
        <header className="ed-panel__head">
          <span className="ed-panel__face">
            <ItemFace item={item} />
          </span>
          <div className="ed-panel__titles">
            <h2 id="ed-cf-title" className="ed-panel__title rnd">
              {tf("variant.edit.conflictTitle", { name: t(item.nameKey) })}
            </h2>
            <p className="muted su-small">{t("variant.edit.conflictLead")}</p>
          </div>
        </header>
        <div className="ed-panel__scroll">
          {chosen === null ? (
            <Banner tone="info" title={t("variant.edit.conflictSafe")}>
              <p>{t("variant.edit.conflictSafeBody")}</p>
            </Banner>
          ) : (
            <Banner
              tone="ok"
              live
              title={t(`variant.edit.chosenDone.${chosen}`)}
              actions={
                <button type="button" className="hbtn" onClick={() => setChosen(null)}>
                  <Icon name="undo" size={16} />
                  {t("variant.edit.chooseAgain")}
                </button>
              }
            />
          )}
          <div className="ed-compare">
            <div className="ed-compare__head">
              <h3 className="ed-sec__title rnd">{t("variant.edit.compare")}</h3>
              <Segmented
                label={t("variant.edit.compare")}
                value={view}
                onChange={setView}
                options={[
                  { value: "origin", label: t("variant.edit.compare.origin") },
                  { value: "mine", label: t("variant.edit.compare.mine") },
                ]}
              />
            </div>
            <p className="muted su-small">{t(view === "origin" ? "variant.edit.compare.originHint" : "variant.edit.compare.mineHint")}</p>
            <DiffView lines={view === "origin" ? ORIGIN_CHANGE : MINE_VS_ORIGIN} label={t(`variant.edit.compare.${view}`)} />
          </div>
        </div>
        <footer className="tray__foot">
          <p className="tray__foot-note">{t("variant.edit.conflictFoot")}</p>
          <a className="hbtn hbtn--ghost" href={screenHref(search, "harness", { state: "update" })}>
            <Icon name="box" size={16} />
            {t("variant.edit.toHarness")}
          </a>
          <button type="button" className="hbtn" onClick={() => setChosen("origin")} aria-pressed={chosen === "origin"}>
            <Icon name="download" size={16} />
            {t("variant.edit.choose.origin")}
          </button>
          <button type="button" className="hbtn hbtn--primary" onClick={() => setChosen("keep")} aria-pressed={chosen === "keep"}>
            <Icon name="check" size={16} />
            {t("variant.edit.choose.keep")}
          </button>
        </footer>
      </section>
    </div>
  );
}

const LEAD: Record<EditState, TextKey> = {
  list: "variant.edit.lead",
  dirty: "variant.edit.lead",
  replace: "variant.edit.lead",
  new: "variant.edit.new.lead",
  history: "variant.edit.histLead",
  conflict: "variant.edit.conflictLeadTop",
};

export function EditScreen({ search, state: rawState, time }: ScreenFrameProps) {
  const state = pickState(rawState, EDIT_STATES);
  const [current, setCurrent] = useState(() => itemFrom(search, state).id);
  const item = EDIT_ITEMS.find((i) => i.id === current) ?? EDIT_ITEMS[0];
  const go = (next: EditState | null) => withParam(withParam(search, "item", null), "state", next);
  const tab = state === "history" ? "history" : state === "conflict" ? "conflict" : "items";
  const conflicts = EDIT_ITEMS.filter((i) => i.originChanged).length;
  const [newKind, setNewKind] = useState<NewKind>("agent");

  let body;
  if (state === "new") body = <NewForm search={search} kind={newKind} />;
  else if (state === "history") body = <History />;
  else if (state === "conflict") body = <Conflict search={search} />;
  else
    body = (
      <div className="tray__body ed-split">
        <ItemList current={current} onPick={setCurrent} />
        <ItemPanel key={item.id} item={item} search={search} state={state} />
      </div>
    );

  return (
    <ScreenShell nav="custom" time={time} className="ed">
      <div className="ed-wrap">
        <nav className="dtabs ed-tabs" aria-label={t("variant.edit.tabs")}>
          <a href={go(null)} aria-current={tab === "items" ? "page" : undefined}>
            <Icon name="custom" size={16} />
            {t("variant.edit.tab.items")}
          </a>
          <a href={go("history")} aria-current={tab === "history" ? "page" : undefined}>
            <Icon name="history" size={16} />
            {t("variant.edit.tab.history")}
          </a>
          <a href={go("conflict")} aria-current={tab === "conflict" ? "page" : undefined}>
            <Icon name="alert" size={16} />
            {t("variant.edit.tab.conflict")}
            {conflicts > 0 && <span className="wp__badge">{conflicts}</span>}
          </a>
        </nav>
        <div className="tray ed-tray">
          <header className="tray__head">
            <div className="tray__titles">
              <h1 className="tray__title rnd">{state === "new" ? t("variant.edit.new.title") : t("variant.edit.title")}</h1>
              <p className="tray__lead">{t(LEAD[state])}</p>
            </div>
            {state === "new" ? (
              <NewKindPick kind={newKind} onChange={setNewKind} />
            ) : (
              <a className="hbtn" href={go("new")}>
                <Icon name="plus" size={18} />
                {t("variant.edit.newGo")}
              </a>
            )}
          </header>
          {body}
        </div>
      </div>
    </ScreenShell>
  );
}
