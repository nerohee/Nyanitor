// 실제 「내 수정」 화면 — 시안 P2-15 (③ 스티커 수첩, D-43). 뒤로 물러난 마당 위 종이(`ws-paper`) 한 장에 위 탭 셋 [에이전트 · 스킬] [기록] [원본 바뀜 (n)],
// 목록 | 고치기(모델 · 수준 · 덧붙일 지시 · 통째로 바꾸기), 기록 · 이때로 되돌리기, 원본 바뀜 고르기, 아래 적용 바. 데이터는 `useCustom`, 명령은 `ipc.custom*` 뿐이다.
// 새로 만들기 · 고양이 바꾸기는 P9-03 이 `headActions`(머리 줄 오른쪽) · `itemActions`(적용 바 왼쪽) 자리에 붙인다.
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
import { ItemList } from "./ItemList";
import { OriginTab } from "./OriginTab";
import { errorLine, unreadableText } from "./format";
import { Banner } from "./parts";
import { useCustom, type EditData } from "./useCustom";
import "./edit.css";

type Tab = "items" | "history" | "origin";

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
  /** 머리 줄 오른쪽 자리 (새로 만들기 — P9-03) */
  headActions?: (api: EditSlotApi) => ReactNode;
  /** 적용 바 왼쪽 자리 (고른 에이전트의 고양이 바꾸기 — P9-03). 에이전트 · 스킬 탭에서만, 고른 항목이 있으면 그 정보와 함께 */
  itemActions?: (item: CustomItemInfo | null, api: EditSlotApi) => ReactNode;
}

function okItems(entries: readonly CustomListEntry[]): CustomItemInfo[] {
  return entries.flatMap((entry) => (entry.state === "ok" ? [entry] : []));
}

export default function EditScreen({ onGo, clock, headActions, itemActions }: Props) {
  const now = useClock(clock);
  const time = timeOfDay(now);
  const data: EditData = useCustom();
  const [tab, setTab] = useState<Tab>("items");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [problem, setProblem] = useState<AppErrorKind | null>(null);
  const tabs = useRef(new Map<Tab, HTMLButtonElement>());

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

  return (
    <div className="ws ed" data-testid="edit" data-skin="3" data-time={time}>
      <AppNav current="edit" onGo={go} />
      <main className="ws-stage">
        <HouseScene className="ws-backdrop" time={time} placements={[]} />
        <div className="ed-wrap">
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
                  aria-controls={`ed-panel-${item.id}`}
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
          <div className="ws-paper ed-tray">
            <header className="ed-tray__head">
              <div className="ed-tray__titles">
                <h1 className="ed-tray__title">{t("edit.title")}</h1>
                <p className="ed-tray__lead">{t(current.lead)}</p>
              </div>
              {headActions?.(slot)}
            </header>
            {shownProblem && (
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
            )}
            {body ?? (
              <>
                <section role="tabpanel" id="ed-panel-items" aria-labelledby="ed-tab-items" className="ed-tabpanel" hidden={tab !== "items"}>
                  {entries.length === 0 ? (
                    <p className="ed-state" role="status">
                      {t("edit.empty")}
                    </p>
                  ) : (
                    <div className="ed-split">
                      <ItemList entries={entries} current={entry?.id ?? null} onPick={setSelectedId} roles={data.roles} cats={data.cats} />
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
                <section role="tabpanel" id="ed-panel-history" aria-labelledby="ed-tab-history" className="ed-tabpanel" hidden={tab !== "history"}>
                  <HistoryTab data={data} report={report} now={now} />
                </section>
                <section role="tabpanel" id="ed-panel-origin" aria-labelledby="ed-tab-origin" className="ed-tabpanel" hidden={tab !== "origin"}>
                  <OriginTab items={originItems} data={data} report={report} focus={focus} />
                </section>
                {showBar && (
                  <ApplyBar data={data} report={report} extra={tab === "items" ? itemActions?.(selectedInfo, slot) : undefined} />
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
