// 실제 「내 수정」 화면 — 시안 P2-15 (③ 스티커 수첩, D-43). 뒤로 물러난 마당 위 종이(`ws-paper`) 한 장에 위 탭 셋 [에이전트 · 스킬] [기록] [원본 바뀜 (n)],
// 목록 | 고치기(모델 · 수준 · 덧붙일 지시 · 통째로 바꾸기), 기록 · 이때로 되돌리기, 원본 바뀜 고르기, 아래 적용 바. 데이터는 `useCustom`, 명령은 `ipc.custom*` 뿐이다.
// 보기는 셋 — 탭 보기(지금) · 새로 만들기(`NewItem`) · 고양이 고르기(`CatPick`). 라우터 없이 이 화면 안에서 바꾼다 (왼쪽 메뉴는 「내 수정」 그대로).
// 새로 만들기 단추는 머리 줄 오른쪽(`headActions`), 고양이 바꾸기는 적용 바 왼쪽(`itemActions`) 자리에 넣는다 — 밖에서 더 붙일 수도 있다.
// 새 에이전트 초안(칸 값 + 고른 고양이)은 이 화면이 들고 있어, 새로 만들기 ↔ 고양이 고르기를 오가도 쓰던 글이 남는다 (취소하면 버린다).
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AppNav, type NavPlace } from "../components/nav/AppNav";
import { HouseScene } from "../components/house/HouseScene";
import { timeOfDay } from "../components/house/time";
import { useClock } from "../home/useClock";
import { t, tf } from "../i18n/ko";
import type { AppErrorKind, CustomItemInfo, CustomListEntry } from "../lib/ipc-types";
import { Icon, type IconName } from "../variants/shared/icons";
import "../workspace/workspace.css";
import { ApplyBar, ChangesPanel } from "./ApplyBar";
import { HistoryTab } from "./HistoryTab";
import { ItemDetailPanel } from "./ItemDetail";
import { CatPick } from "./CatPick";
import { ItemList } from "./ItemList";
import { NewItem, type NewFormError } from "./NewItem";
import { OriginTab } from "./OriginTab";
import { errorLine, refuseText, unreadableText } from "./format";
import { EMPTY_DRAFT, copyCandidates, createItem, type CreateStep, type NewDraft } from "./newDraft";
import { Banner, NotOursBanner } from "./parts";
import { useCustom, type EditData } from "./useCustom";
import "./edit.css";

type Tab = "items" | "history" | "origin";

/** 보기 — 탭 보기 · 새로 만들기 · 고양이 고르기 (`agent` = 처음 고를 에이전트 키 `main` / 이름, `fromNew` = 새 에이전트로 들어왔다 — 초안이 고르는 대상) */
type View = { kind: "tabs" } | { kind: "new" } | { kind: "pick"; agent: string | null; fromNew: boolean };

const STEP_TEXT: Record<CreateStep, "edit.new.partial.copy" | "edit.new.partial.label" | "edit.new.partial.cat"> = {
  copy: "edit.new.partial.copy",
  label: "edit.new.partial.label",
  cat: "edit.new.partial.cat",
};

const TABS: ReadonlyArray<{ id: Tab; icon: IconName; label: "edit.tab.items" | "edit.tab.history" | "edit.tab.origin"; lead: "edit.lead" | "edit.histLead" | "edit.originLead" }> = [
  { id: "items", icon: "custom", label: "edit.tab.items", lead: "edit.lead" },
  { id: "history", icon: "history", label: "edit.tab.history", lead: "edit.histLead" },
  { id: "origin", icon: "alert", label: "edit.tab.origin", lead: "edit.originLead" },
];

/** P9-03 이 붙이는 단추가 화면과 주고받는 것 */
export interface EditSlotApi {
  /** 목록 · 바뀌는 것 · 고양이 연결을 다시 읽는다 (고양이 바꾼 뒤 등) */
  reload: () => Promise<void>;
  /** 에이전트 · 스킬 탭에서 그 항목을 고른다 (새로 만든 뒤 등) */
  select: (id: string) => void;
  /** 명령이 오류로 끝났을 때 화면 위 띠로 알린다 */
  report: (kind: AppErrorKind) => void;
}

interface Props {
  /** 왼쪽 메뉴 */
  onGo: (place: NavPlace) => void;
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  clock?: () => Date;
  /** 처음 보기를 고양이 고르기로 — 고를 에이전트의 열쇠(`main` / 에이전트 이름). 고양이 집의 「고양이 바꾸기」 가 넘긴다 (처음 한 번만 본다) */
  startPick?: string;
  /** 머리 줄 오른쪽 자리 (새로 만들기 — P9-03) */
  headActions?: (api: EditSlotApi) => ReactNode;
  /** 적용 바 왼쪽 자리 (고른 에이전트의 고양이 바꾸기 — P9-03). 에이전트 · 스킬 탭에서만, 고른 항목이 있으면 그 정보와 함께 */
  itemActions?: (item: CustomItemInfo | null, api: EditSlotApi) => ReactNode;
}

function okItems(entries: readonly CustomListEntry[]): CustomItemInfo[] {
  return entries.flatMap((entry) => (entry.state === "ok" ? [entry] : []));
}

export default function EditScreen({ onGo, clock, startPick, headActions, itemActions }: Props) {
  const now = useClock(clock);
  const time = timeOfDay(now);
  const data: EditData = useCustom();
  const [tab, setTab] = useState<Tab>("items");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [problem, setProblem] = useState<AppErrorKind | null>(null);
  const tabs = useRef(new Map<Tab, HTMLButtonElement>());
  const [view, setView] = useState<View>(() => (startPick ? { kind: "pick", agent: startPick, fromNew: false } : { kind: "tabs" }));
  const [draft, setDraft] = useState<NewDraft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<NewFormError | null>(null);
  const [creating, setCreating] = useState(false);
  /** 방금 만든 것 중 다 저장하지 못했거나(`failed`) 알릴 것이 있는 것 — 탭 보기에 띠로 */
  const [made, setMade] = useState<{ name: string; failed: CreateStep[]; notOurs: boolean } | null>(null);

  const report = (kind: AppErrorKind) => setProblem(kind);
  const shownProblem = problem ?? data.refreshError;
  const ready = data.list.status === "ready" ? data.list.list : null;
  const entries = ready?.items ?? [];
  const available = ready?.available === true;
  const entry = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;
  const originItems = okItems(entries).filter((item) => item.originChanged === true);
  const slot: EditSlotApi = { reload: data.refresh, select: setSelectedId, report };
  const selectedInfo = entry?.state === "ok" ? entry : null;
  // 기록 · 원본 바뀜 탭은 자기 단추 줄이 있어, 적용 바는 적용 안 한 것이 생겼을 때부터 그 탭에 있는 동안만 보인다
  // (1024×640 에서 비교 칸이 좁아지지 않게 — 그 탭에서 적용한 뒤 결과 띠는 남는다)
  const pending = ready?.unapplied.known === true && ready.unapplied.count > 0;
  const [barTab, setBarTab] = useState<Tab | null>(null);
  if (pending && tab !== "items" && barTab !== tab) setBarTab(tab);
  if (!pending && barTab !== null && barTab !== tab) setBarTab(null);
  const showBar = tab === "items" || pending || barTab === tab;

  // 다른 곳으로 — 쓰던 글을 먼저 저장한다 (적용 안 한 것은 남으므로 묻지 않는다)
  const patchDraft = (patch: Partial<NewDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    if ("name" in patch || "kind" in patch) setFormError(null);
  };
  const closeNew = () => {
    setDraft(EMPTY_DRAFT);
    setFormError(null);
    setView({ kind: "tabs" });
  };

  /** 초안으로 항목 만들기 — 거절 · 오류면 새로 만들기로 (칸 그대로), 만들어졌으면 목록을 다시 읽고 새 항목을 골라 탭 보기로 */
  const create = async () => {
    if (creating) return;
    setCreating(true);
    setFormError(null);
    try {
      // 쓰던 글을 먼저 저장해 둔다 (하네스는 한 번에 하나만 쓴다)
      await data.flushAll();
      const candidates = copyCandidates(entries, draft.kind);
      const copyFrom = draft.start === "copy" ? (candidates.find((item) => item.id === draft.from)?.id ?? candidates[0]?.id ?? null) : null;
      const result = await createItem(draft, copyFrom, draft.kind === "agent" && data.labels[draft.name] !== undefined);
      if (result.status === "refused") {
        const nameReason = result.reason === "name_in_source" || result.reason === "name_taken";
        setFormError({ field: nameReason ? "name" : "general", text: refuseText(result.reason) });
        setView({ kind: "new" });
        return;
      }
      if (result.status === "error") {
        setFormError({ field: "general", text: errorLine(result.kind) });
        setView({ kind: "new" });
        return;
      }
      await data.refresh();
      setSelectedId(result.id);
      setTab("items");
      setMade(result.failed.length > 0 || result.notOurs ? { name: draft.name, failed: result.failed, notOurs: result.notOurs } : null);
      closeNew();
    } finally {
      setCreating(false);
    }
  };

  const go = (place: NavPlace) => {
    void data.flushAll().then(() => onGo(place));
  };

  const onTabKey = (event: KeyboardEvent) => {
    const at = TABS.findIndex((item) => item.id === tab);
    const to =
      event.key === "ArrowRight" ? (at + 1) % TABS.length : event.key === "ArrowLeft" ? (at + TABS.length - 1) % TABS.length : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : -1;
    if (to < 0) return;
    event.preventDefault();
    setTab(TABS[to]!.id);
    tabs.current.get(TABS[to]!.id)?.focus();
  };

  const current = TABS.find((item) => item.id === tab)!;
  const body = (() => {
    if (data.list.status === "loading")
      return (
        <p className="ed-state" role="status">
          {t("edit.loading")}
        </p>
      );
    if (data.list.status === "failed")
      return (
        <div className="ed-state" role="alert">
          <p className="ed-state__title">{t("edit.failedTitle")}</p>
          <p>{errorLine(data.list.kind)}</p>
          <button type="button" className="ws-btn" onClick={() => void data.refresh()}>
            {t("edit.retry")}
          </button>
        </div>
      );
    if (!available)
      return (
        <div className="ed-state" role="status">
          <p className="ed-state__title">{t("edit.noSourceTitle")}</p>
          <p>{t("edit.noSource")}</p>
        </div>
      );
    return null;
  })();

  const problemNode = shownProblem ? (
    <div className="ed-problem">
      <Banner
        tone={shownProblem === "harness_busy" ? "warn" : "danger"}
        live
        title={errorLine(shownProblem)}
        actions={
          <>
            {shownProblem === "harness_busy" && (
              <button
                type="button"
                className="ws-btn ws-btn--small"
                onClick={() => {
                  setProblem(null);
                  data.clearRefreshError();
                  void data.refresh();
                }}
              >
                {t("edit.retry")}
              </button>
            )}
            <button
              type="button"
              className="ws-btn ws-btn--small ws-btn--ghost"
              onClick={() => {
                setProblem(null);
                data.clearRefreshError();
              }}
            >
              {t("variant.ui.dismiss")}
            </button>
          </>
        }
      />
    </div>
  ) : null;
  const madeNode = made ? (
    <div className="ed-problem">
      {made.failed.length > 0 && (
        <Banner
          tone="warn"
          live
          title={tf("edit.new.partialTitle", { name: made.name })}
          actions={
            <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={() => setMade(null)}>
              {t("variant.ui.dismiss")}
            </button>
          }
        >
          {made.failed.map((step) => (
            <p key={step}>{t(STEP_TEXT[step])}</p>
          ))}
        </Banner>
      )}
      {made.notOurs && <NotOursBanner />}
    </div>
  ) : null;

  const newButton = available ? (
    <button
      type="button"
      className="ws-btn"
      onClick={() => {
        setMade(null);
        setView({ kind: "new" });
      }}
    >
      <Icon name="plus" size={16} />
      {t("edit.newGo")}
    </button>
  ) : null;
  const pickKey = selectedInfo && selectedInfo.kind !== "skill" ? (selectedInfo.kind === "main" ? "main" : selectedInfo.name) : null;
  const pickButton =
    pickKey !== null ? (
      <button type="button" className="ws-btn" onClick={() => setView({ kind: "pick", agent: pickKey, fromNew: false })}>
        <Icon name="paw" size={16} />
        {t("edit.pick.go")}
      </button>
    ) : null;

  return (
    <div className="ws ed" data-testid="edit" data-skin="3" data-time={time}>
      <AppNav current="edit" onGo={go} />
      <main className="ws-stage">
        <HouseScene className="ws-backdrop" time={time} placements={[]} />
        <div className="ed-wrap">
          {view.kind === "tabs" && (
            <div className="ed-tabs" role="tablist" aria-label={t("edit.tabs")} onKeyDown={onTabKey}>
              {TABS.map((item) => {
                const selected = item.id === tab;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    id={`ed-tab-${item.id}`}
                    aria-selected={selected}
                    // 읽는 중 · 실패 · 하네스 없음일 때는 탭 패널 대신 안내(`body`)를 그린다 — 없는 패널을 가리키지 않게 (P10-12 E2E axe)
                    aria-controls={body ? undefined : `ed-panel-${item.id}`}
                    tabIndex={selected ? 0 : -1}
                    className="ed-tab"
                    data-tab={item.id}
                    ref={(el) => {
                      if (el) tabs.current.set(item.id, el);
                      else tabs.current.delete(item.id);
                    }}
                    onClick={() => setTab(item.id)}
                  >
                    <Icon name={item.icon} size={16} />
                    {t(item.label)}
                    {item.id === "origin" && originItems.length > 0 && (
                      <span className="ed-tab__badge">
                        <span aria-hidden="true">{originItems.length}</span>
                        <span className="ws-sr">{tf("edit.tab.originCount", { n: originItems.length })}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          <div className="ws-paper ed-tray">
            {view.kind === "tabs" && (
              <header className="ed-tray__head">
                <div className="ed-tray__titles">
                  <h1 className="ed-tray__title" tabIndex={-1}>{t("edit.title")}</h1>
                  <p className="ed-tray__lead">{t(current.lead)}</p>
                </div>
                {newButton}
                {headActions?.(slot)}
              </header>
            )}
            {view.kind === "tabs" && problemNode}
            {view.kind === "tabs" && madeNode}
            {body ?? (
              <>
                {view.kind === "new" && (
                  <NewItem
                    draft={draft}
                    onChange={patchDraft}
                    entries={entries}
                    roles={data.roles}
                    labels={data.labels}
                    error={formError}
                    busy={creating}
                    banner={problemNode}
                    onCancel={closeNew}
                    onSubmit={() => (draft.kind === "agent" ? setView({ kind: "pick", agent: null, fromNew: true }) : void create())}
                  />
                )}
                {view.kind === "pick" && (
                  <CatPick
                    data={data}
                    entries={entries}
                    agent={view.agent}
                    draft={view.fromNew ? { name: draft.name, label: draft.label, cat: draft.cat } : null}
                    onDraftCat={(cat) => patchDraft({ cat })}
                    onBack={() => setView({ kind: "new" })}
                    onDone={() => void create()}
                    creating={creating}
                    onExit={(key) => {
                      setSelectedId(key === "main" ? "main" : `agent:${key}`);
                      setView({ kind: "tabs" });
                    }}
                    report={report}
                    banner={problemNode}
                  />
                )}
                <section role="tabpanel" id="ed-panel-items" aria-labelledby="ed-tab-items" className="ed-tabpanel" hidden={tab !== "items" || view.kind !== "tabs"}>
                  {entries.length === 0 ? (
                    <p className="ed-state" role="status">
                      {t("edit.empty")}
                    </p>
                  ) : (
                    <div className="ed-split">
                      <ItemList entries={entries} current={entry?.id ?? null} onPick={setSelectedId} roles={data.roles} cats={data.cats} labels={data.labels} />
                      {selectedInfo ? (
                        <ItemDetailPanel
                          key={`${selectedInfo.id}:${data.rev}`}
                          entry={selectedInfo}
                          data={data}
                          report={report}
                          onGoOrigin={(id) => {
                            setFocus((prev) => ({ id, n: (prev?.n ?? 0) + 1 }));
                            setTab("origin");
                          }}
                          changes={<ChangesPanel changes={data.changes} />}
                        />
                      ) : entry ? (
                        <section className="ed-panel" aria-labelledby="ed-panel-title">
                          <header className="ed-panel__head">
                            <h2 id="ed-panel-title" className="ed-panel__title">
                              {entry.name}
                            </h2>
                          </header>
                          <div className="ed-state" role="alert">
                            <p className="ed-state__title">{t("edit.item.unreadable")}</p>
                            <p>{entry.state === "unreadable" ? unreadableText(entry.reason) : ""}</p>
                            <p className="ed-state__hint">{t("edit.item.unreadableHint")}</p>
                          </div>
                        </section>
                      ) : null}
                    </div>
                  )}
                </section>
                <section role="tabpanel" id="ed-panel-history" aria-labelledby="ed-tab-history" className="ed-tabpanel" hidden={tab !== "history" || view.kind !== "tabs"}>
                  <HistoryTab data={data} report={report} now={now} />
                </section>
                <section role="tabpanel" id="ed-panel-origin" aria-labelledby="ed-tab-origin" className="ed-tabpanel" hidden={tab !== "origin" || view.kind !== "tabs"}>
                  <OriginTab items={originItems} data={data} report={report} focus={focus} />
                </section>
                {showBar && view.kind === "tabs" && (
                  <ApplyBar
                    data={data}
                    report={report}
                    extra={
                      tab === "items" ? (
                        <>
                          {pickButton}
                          {itemActions?.(selectedInfo, slot)}
                        </>
                      ) : undefined
                    }
                  />
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
