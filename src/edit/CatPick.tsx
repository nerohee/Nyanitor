// 「내 수정」 안의 에이전트 고양이 고르기 (시안 P2-15-pick · pick-new, D-31 · D-41 · D-43) — 왼쪽 에이전트 목록 | 오른쪽 큰 고양이 · 자세 · 고양이 카드.
// 평소(「고양이 바꾸기」로 들어옴)는 누르면 바로 저장 — 다른 에이전트가 쓰는 고양이면 둘을 맞바꿔 한 번에 저장하고(커밋 하나) 되돌리기 띠를 보인다.
// 새 에이전트로 들어오면 고르기는 **초안에만** (저장은 「완료」 때 — 맞바꿈 없음), 다른 에이전트는 보기만 한다. 「이전」은 새로 만들기로 (칸 그대로).
// 쓰는 명령은 `ipc.customCatsSave` 뿐 (여러 줄 · 커밋 하나). 목록 · 연결은 `useCustom` 이 다시 읽는다.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CatFigure } from "../components/cat/CatFigure";
import { CAT_IDS, POSES, catForAgent } from "../components/cat/catalog";
import { t, tf, type TextKey } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { AppErrorKind, CustomCatChange, CustomListEntry } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { errorKind } from "../workspace/errors";
import { ordered } from "./ItemList";
import { errorLine, itemCat, itemLabel, refuseText } from "./format";
import { Banner, Chip } from "./parts";
import type { EditData } from "./useCustom";

/** 초안 에이전트 줄의 키 — 실제 에이전트 이름은 `^[a-z]` 로 시작해 겹치지 않는다 */
const DRAFT = "#draft";

interface Row {
  key: string;
  kind: "main" | "agent" | "draft";
  name: string;
  label: string;
  /** 지금 보이는 고양이 (내 연결 → 기본) */
  cat: string | null;
  defaultCat: string | null;
  /** 내 연결이 파일에 적혀 있다 (「기본값으로」 · 「바꿈」) */
  linked: boolean;
  /** 직접 만든 에이전트 */
  mine: boolean;
  file: string | null;
}

export interface PickDraft {
  name: string;
  label: string;
  cat: string | null;
}

interface Props {
  data: EditData;
  entries: readonly CustomListEntry[];
  /** 처음 고를 에이전트 (`main` 또는 에이전트 이름) — 모르면 첫 줄 (새 에이전트로 들어오면 초안) */
  agent: string | null;
  /** 새 에이전트로 들어왔다 — 초안 (이름 · 고른 고양이) */
  draft: PickDraft | null;
  onDraftCat: (cat: string) => void;
  /** 「이전」 — 새로 만들기로 */
  onBack: () => void;
  /** 「완료」 — 에이전트 만들기 */
  onDone: () => void;
  /** 만드는 중 (완료를 눌렀다) */
  creating: boolean;
  /** 「내 수정으로」 — 마지막으로 보던 에이전트 키와 함께 */
  onExit: (agent: string) => void;
  report: (kind: AppErrorKind) => void;
  /** 화면 위 오류 띠 (EditScreen 이 준다) */
  banner?: ReactNode;
}

interface Notice {
  text: string;
  /** 되돌릴 때 쓰는 앞 모습 (없으면 되돌리기 단추 없음) */
  undo: CustomCatChange[] | null;
}

const FUR: Record<string, TextKey> = {
  mukmul: "edit.pick.fur.mukmul",
  nabi: "edit.pick.fur.nabi",
  mulgam: "edit.pick.fur.mulgam",
  danchu: "edit.pick.fur.danchu",
  kkaebi: "edit.pick.fur.kkaebi",
  dubu: "edit.pick.fur.dubu",
  gureum: "edit.pick.fur.gureum",
};

const POSE_TEXT: Record<(typeof POSES)[number], TextKey> = {
  sit: "edit.pick.pose.sit",
  loaf: "edit.pick.pose.loaf",
  sleep: "edit.pick.pose.sleep",
  walk: "edit.pick.pose.walk",
  groom: "edit.pick.pose.groom",
};

const catName = (id: string) => t(`cat.${id as (typeof CAT_IDS)[number]}.name`);
const furOf = (id: string) => (FUR[id] ? t(FUR[id]!) : "");

/** 오케스트레이터 → 하네스 작업자(역할 순서) → 그 밖(이름 순) */
function rowsOf(entries: readonly CustomListEntry[], data: EditData): Row[] {
  const rows: Row[] = [];
  const make = (entry: CustomListEntry): Row | null => {
    if (entry.state !== "ok" || entry.kind === "skill") return null;
    const main = entry.kind === "main";
    const key = main ? "main" : entry.name;
    const role = main ? "main" : data.roles.get(entry.name);
    return {
      key,
      kind: main ? "main" : "agent",
      name: entry.name,
      label: itemLabel(entry.kind, entry.name, data.roles, data.labels),
      cat: itemCat(entry.kind, entry.name, data.roles, data.cats),
      defaultCat: role ? catForAgent(role) : null,
      linked: data.cats[key] !== undefined,
      mine: entry.marks.includes("mine"),
      file: main ? null : entry.file,
    };
  };
  const main = entries.find((entry) => entry.kind === "main");
  const first = main ? make(main) : null;
  if (first) rows.push(first);
  const agents = entries.filter((entry) => entry.kind === "agent").sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of ordered(agents, data.roles)) {
    const row = make(entry);
    if (row) rows.push(row);
  }
  return rows;
}

export function CatPick({ data, entries, agent, draft, onDraftCat, onBack, onDone, creating, onExit, report, banner }: Props) {
  const rows = rowsOf(entries, data);
  const all: Row[] = draft
    ? [
        ...rows,
        {
          key: DRAFT,
          kind: "draft",
          name: draft.name,
          label: draft.label.trim() || draft.name,
          cat: draft.cat,
          defaultCat: null,
          linked: false,
          mine: true,
          file: `${draft.name}.md`,
        },
      ]
    : rows;
  const [current, setCurrent] = useState<string>(() => (draft ? DRAFT : (agent ?? "main")));
  const [notice, setNotice] = useState<Notice | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const cards = useRef(new Map<string, HTMLButtonElement>());
  // 고양이 칸의 「지금 칸」(로빙 탭인덱스) — 에이전트를 바꾸면 그 에이전트의 고른 칸부터 다시
  const [cursor, setCursor] = useState<{ key: string; id: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // 처음 열 때 고른 에이전트가 목록에서 보이게 (1024×640 에서는 맨 아래 초안 줄이 목록 밖에 있다)
  const opened = useRef(current);
  useEffect(() => {
    tabs.current.get(opened.current)?.scrollIntoView?.({ block: "nearest" });
  }, []);

  const row = all.find((r) => r.key === current) ?? all[0];
  const picking = draft === null || row?.key === DRAFT;
  const anyLinked = Object.keys(data.cats).length > 0;

  /** 고양이 연결 쓰기 — 앞 모습을 들고 있다가 되돌리기에 쓴다. 한 번에 한 번만 */
  const save = async (changes: CustomCatChange[], text: string | null) => {
    if (busy || changes.length === 0) return;
    const undo = changes.map((change) => ({
      agent: change.agent,
      cat: data.cats[change.agent] ?? null,
    }));
    setBusy(true);
    setProblem(null);
    try {
      const result = await ipc.customCatsSave(changes);
      if (result.outcome === "refused") {
        if (alive.current) setProblem(`${t("edit.pick.failed")} — ${refuseText(result.reason)}`);
        return;
      }
      await data.refresh();
      if (alive.current) setNotice(text === null ? null : { text, undo });
    } catch (raw) {
      const kind = errorKind(raw);
      if (alive.current) setProblem(`${t("edit.pick.failed")} — ${errorLine(kind)}`);
      report(kind);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const choose = (next: string) => {
    if (!row || row.cat === next) return;
    if (draft) {
      if (row.key === DRAFT) onDraftCat(next);
      return;
    }
    const changes: CustomCatChange[] = [{ agent: row.key, cat: next }];
    // 다른 에이전트가 쓰던 고양이면 서로 바꾼다 (지금 고양이가 없으면 둘이 같은 고양이)
    const owner = row.cat ? all.find((r) => r.key !== row.key && r.cat === next) : undefined;
    if (owner && row.cat) changes.push({ agent: owner.key, cat: row.cat });
    void save(changes, owner && row.cat ? tf("edit.pick.swapped", { a: row.label, b: owner.label }) : null);
  };

  const resetOne = () => {
    if (!row || row.key === DRAFT || !row.linked) return;
    void save([{ agent: row.key, cat: null }], tf("edit.pick.resetOne", { agent: row.label }));
  };
  const resetAll = () => {
    const agents = Object.keys(data.cats);
    if (agents.length === 0) return;
    void save(
      agents.map((name) => ({ agent: name, cat: null })),
      t("edit.pick.resetAllDone"),
    );
  };
  const undo = async () => {
    const back = notice?.undo;
    if (!back || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await ipc.customCatsSave(back);
      if (result.outcome === "refused") {
        if (alive.current) setProblem(`${t("edit.pick.failed")} — ${refuseText(result.reason)}`);
        return;
      }
      await data.refresh();
      if (alive.current) setNotice({ text: t("edit.pick.undone"), undo: null });
    } catch (raw) {
      const kind = errorKind(raw);
      if (alive.current) setProblem(`${t("edit.pick.failed")} — ${errorLine(kind)}`);
      report(kind);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const index = all.findIndex((r) => r.key === row?.key);
  const move = (to: number) => {
    const next = all[(to + all.length) % all.length];
    if (!next) return;
    setCurrent(next.key);
    tabs.current.get(next.key)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(all.length - 1);
    else return;
    event.preventDefault();
  };

  if (!row) return null;
  // 화살표는 칸 사이를 옮겨 다니기만 한다 — 고르기(저장)는 Space · Enter · 클릭 (D-55)
  const stop = cursor && cursor.key === row.key && (CAT_IDS as readonly string[]).includes(cursor.id) ? cursor.id : (row.cat ?? CAT_IDS[0]);
  const onCardKey = (event: KeyboardEvent, id: string) => {
    const at = CAT_IDS.indexOf(id as (typeof CAT_IDS)[number]);
    let to: number;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") to = at + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") to = at - 1;
    else if (event.key === "Home") to = 0;
    else if (event.key === "End") to = CAT_IDS.length - 1;
    else return;
    event.preventDefault();
    const next = CAT_IDS[(to + CAT_IDS.length) % CAT_IDS.length];
    if (!next) return;
    setCursor({ key: row.key, id: next });
    cards.current.get(next)?.focus();
  };
  const draftLabel = draft ? draft.label.trim() || draft.name : "";
  const owners = (id: string) => all.find((r) => r.key !== row.key && r.cat === id);
  const sub = row.kind === "main" ? t("edit.pick.mainSub") : row.mine ? t("edit.pick.mineSub") : null;

  return (
    <>
      <header className="ed-tray__head">
        <div className="ed-tray__titles">
          <h1 className="ed-tray__title" tabIndex={-1}>{t("edit.pick.title")}</h1>
          <p className="ed-tray__lead">{t("edit.pick.lead")}</p>
        </div>
        <button type="button" className="ws-btn" onClick={resetAll} disabled={!anyLinked || busy || draft !== null}>
          <Icon name="undo" size={16} />
          {t("edit.pick.resetAll")}
        </button>
      </header>
      {banner}
      <div className="ed-pk">
        <div className="ed-pk__agents">
          <h2 className="ed-pk__h" id="ed-pk-agents-title">
            {t("edit.pick.agents")}
          </h2>
          <div className="ed-pk__tabs" role="tablist" aria-orientation="vertical" aria-labelledby="ed-pk-agents-title" onKeyDown={onKeyDown}>
            {all.map((r) => {
              const isDefault = r.cat !== null && r.cat === r.defaultCat;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="tab"
                  id={`ed-pk-tab-${r.key === DRAFT ? "draft" : r.key}`}
                  aria-selected={r.key === row.key}
                  aria-controls="ed-pk-panel"
                  tabIndex={r.key === row.key ? 0 : -1}
                  className="ed-pk__agent"
                  data-agent={r.key === DRAFT ? "draft" : r.key}
                  onClick={() => setCurrent(r.key)}
                  ref={(el) => {
                    if (el) tabs.current.set(r.key, el);
                    else tabs.current.delete(r.key);
                  }}
                >
                  <span className="ed-pk__face" aria-hidden="true">
                    {r.cat ? <CatFigure cat={r.cat} crop="face" /> : <Icon name="paw" size={18} />}
                  </span>
                  <span className="ed-pk__text">
                    <span className="ed-pk__name">{r.label}</span>
                    <span className="ed-pk__cat">
                      {r.cat && <span>{catName(r.cat)}</span>}
                      {r.cat === null ? (
                        <Chip tone="warn">{t("edit.pick.none")}</Chip>
                      ) : isDefault ? (
                        <Chip tone="keep">{t("edit.pick.default")}</Chip>
                      ) : (
                        <Chip tone="change">{t("edit.pick.changed")}</Chip>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <section className="ed-pk__panel" id="ed-pk-panel" role="tabpanel" aria-labelledby={`ed-pk-tab-${row.key === DRAFT ? "draft" : row.key}`}>
          {draft && (
            <Banner tone="info" title={tf("edit.pick.newBand", { name: draftLabel })}>
              {!picking && <p>{t("edit.pick.viewOnly")}</p>}
            </Banner>
          )}
          {problem && (
            <Banner
              tone="danger"
              live
              title={problem}
              actions={
                <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={() => setProblem(null)}>
                  {t("variant.ui.dismiss")}
                </button>
              }
            />
          )}
          {notice && (
            <Banner
              tone="ok"
              live
              title={notice.text}
              actions={
                <>
                  {notice.undo && (
                    <button type="button" className="ws-btn ws-btn--small" disabled={busy} onClick={() => void undo()}>
                      <Icon name="undo" size={14} />
                      {t("edit.pick.undo")}
                    </button>
                  )}
                  <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={() => setNotice(null)}>
                    {t("variant.ui.dismiss")}
                  </button>
                </>
              }
            />
          )}

          <div className="ed-pk__hero">
            <div className="ed-pk__big" aria-hidden="true">
              {row.cat ? <CatFigure cat={row.cat} pose="sit" /> : <Icon name="paw" size={48} />}
            </div>
            <div className="ed-pk__info">
              <h2 className="ed-pk__title">{tf("edit.pick.catOf", { agent: row.label })}</h2>
              <p className="ed-pk__catname">{row.cat ? catName(row.cat) : t("edit.pick.none")}</p>
              {row.cat && <p className="ed-pk__muted">{furOf(row.cat)}</p>}
              <p className="ed-pk__muted ed-pk__small">
                {sub ?? <code>{row.file}</code>}
                {row.defaultCat && (
                  <>
                    <span aria-hidden="true"> · </span>
                    {tf("edit.pick.defaultIs", {
                      cat: catName(row.defaultCat),
                    })}
                  </>
                )}
              </p>
              {row.kind === "main" && <p className="ed-pk__muted ed-pk__small">{t("edit.pick.mainNote")}</p>}
              <button type="button" className="ws-btn" onClick={resetOne} disabled={!row.linked || busy || row.key === DRAFT}>
                <Icon name="undo" size={16} />
                {t("edit.pick.reset")}
              </button>
            </div>
            {row.cat && (
              <figure className="ed-pk__poses">
                <figcaption className="ed-pk__muted ed-pk__small">{t("edit.pick.poses")}</figcaption>
                <ul>
                  {POSES.map((pose) => (
                    <li key={pose}>
                      <span className="ed-pk__frame">
                        <CatFigure cat={row.cat!} pose={pose} motion="still" />
                      </span>
                      <span className="ed-pk__small ed-pk__muted">{t(POSE_TEXT[pose])}</span>
                    </li>
                  ))}
                </ul>
              </figure>
            )}
          </div>

          <div className="ed-pk__pick" role="radiogroup" aria-labelledby="ed-pk-cats-title" aria-describedby="ed-pk-swap-note">
            <div className="ed-pk__pickhead">
              <h3 id="ed-pk-cats-title" className="ed-pk__h">
                {tf("edit.pick.cats", { n: CAT_IDS.length })}
              </h3>
              <span id="ed-pk-swap-note" className="ed-pk__muted ed-pk__small">
                {draft ? t("edit.pick.viewOnly") : t("edit.pick.swapHint")}
              </span>
            </div>
            <div className="ed-pk__grid">
              {CAT_IDS.map((id) => {
                const owner = owners(id);
                const checked = row.cat === id;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-disabled={busy ? true : undefined}
                    disabled={!picking}
                    tabIndex={id === stop ? 0 : -1}
                    className="ed-pk__card"
                    data-cat={id}
                    data-checked={checked ? "true" : undefined}
                    data-disabled={!picking || busy ? "true" : undefined}
                    onClick={() => choose(id)}
                    onFocus={() => setCursor({ key: row.key, id })}
                    onKeyDown={(event) => onCardKey(event, id)}
                    ref={(el) => {
                      if (el) cards.current.set(id, el);
                      else cards.current.delete(id);
                    }}
                  >
                    <span className="ed-pk__plate" aria-hidden="true">
                      <CatFigure cat={id} pose="sit" motion="still" />
                    </span>
                    <span className="ed-pk__cardname">{catName(id)}</span>
                    <span className="ed-pk__fur">{furOf(id)}</span>
                    {checked ? (
                      <span className="ed-pk__mark">
                        <Icon name="check" size={14} />
                      </span>
                    ) : owner ? (
                      <span className="ed-pk__owner">{tf("edit.pick.usedBy", { agent: owner.label })}</span>
                    ) : null}
                  </button>
                );
              })}
              <div className="ed-pk__card ed-pk__card--more">
                <span className="ed-pk__plate" aria-hidden="true">
                  <Icon name="plus" size={28} />
                </span>
                <span className="ed-pk__cardname">{t("edit.pick.more")}</span>
                <span className="ed-pk__fur">{t("edit.pick.moreBody")}</span>
              </div>
            </div>
          </div>
          {!draft && (
            <p className="ed-pk__saved ed-pk__muted ed-pk__small">
              <Icon name="check" size={14} />
              {t("edit.pick.saved")}
            </p>
          )}
        </section>
      </div>
      <footer className="ed-foot ed-pk__foot">
        {draft ? (
          <>
            <p className="ed-foot__note" id="ed-pk-done-note" aria-live="polite">
              {draft.cat
                ? tf("edit.pick.doneReady", {
                    agent: draftLabel,
                    cat: catName(draft.cat),
                  })
                : tf("edit.pick.doneWhy", { agent: draftLabel })}
            </p>
            <button type="button" className="ws-btn" disabled={creating} onClick={onBack}>
              {t("edit.pick.back")}
            </button>
            <button type="button" className="ws-btn ws-btn--primary" disabled={draft.cat === null || creating} aria-describedby="ed-pk-done-note" onClick={onDone}>
              <Icon name="check" size={16} />
              {creating ? t("edit.pick.doing") : t("edit.pick.done")}
            </button>
          </>
        ) : (
          <>
            <span className="ed-foot__note" />
            <button type="button" className="ws-btn" disabled={busy} onClick={() => onExit(row.key)}>
              {t("edit.pick.exit")}
            </button>
          </>
        )}
      </footer>
    </>
  );
}
