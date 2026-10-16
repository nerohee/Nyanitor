// 에이전트 고양이 고르기 (D-31 · D-37) — 에이전트 목록 ↔ 고양이 목록. 에이전트마다 고양이 하나, 기본값으로 되돌리기.
// 상태: ?screen=pick&state=default(기본)|changed(두 에이전트를 바꾼 뒤)|new(사용자가 만든 에이전트 — 고양이를 아직 안 고름) &agent=designer
// 고른 것은 내 수정 폴더(custom/agent-cats.json)에 저장된다 — 시제품은 화면 안에서만 (P9 에서 IPC).
// 평소에는 누르면 바로 적용 · 완료 단추 없음. 새 에이전트를 만들고 들어온 경우(state=new)만 "완료" — 고르기 전에는 못 누르고,
// 누르면 내 수정(새 에이전트가 보이는 곳)으로 돌아간다 (D-43). 그 왼쪽 "이전" 은 고르기 전에도 누를 수 있고,
// 들어오기 전 화면(내 수정 · 새로 만들기)으로 돌아간다 (P2-15 2차).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { CAT_IDS, POSES, type CatId } from "../../components/cat/catalog";
import { t, tf } from "../../i18n/ko";
import { NEW_AGENT, PICK_AGENTS, PICK_STATES, pickUserLinks, type PickAgent } from "../fixtures-screens";
import { pickState, screenHref } from "../query";
import { Icon } from "../shared/icons";
import { Banner, Chip, ScreenShell, type ScreenFrameProps } from "./parts";
import "./screens.css";

type Links = Record<string, CatId | null>;

function initialLinks(agents: readonly PickAgent[], user: Record<string, CatId>): Links {
  return Object.fromEntries(agents.map((a) => [a.agent, user[a.agent] ?? a.defaultCat]));
}

function agentFromUrl(search: string, agents: readonly PickAgent[]): string | null {
  const value = new URLSearchParams(search).get("agent");
  return agents.find((a) => a.agent === value)?.agent ?? null;
}

function AgentTab({
  agent,
  cat,
  selected,
  onSelect,
  register,
}: {
  agent: PickAgent;
  cat: CatId | null;
  selected: boolean;
  onSelect: () => void;
  register: (el: HTMLButtonElement | null) => void;
}) {
  const isDefault = cat !== null && cat === agent.defaultCat;
  return (
    <button
      type="button"
      role="tab"
      id={`pk-tab-${agent.agent}`}
      aria-selected={selected}
      aria-controls="pk-panel"
      tabIndex={selected ? 0 : -1}
      className="pk-agent"
      onClick={onSelect}
      ref={register}
    >
      <span className="pk-agent__face" aria-hidden="true">
        {cat ? <CatFigure cat={cat} crop="face" /> : <Icon name="paw" size={18} />}
      </span>
      <span className="pk-agent__text">
        <span className="pk-agent__name rnd">{t(agent.nameKey)}</span>
        <span className="pk-agent__cat">
          {cat && <span>{t(`cat.${cat}.name`)}</span>}
          {cat === null ? (
            <Chip tone="warn">{t("variant.pick.none")}</Chip>
          ) : isDefault ? (
            <Chip tone="keep">{t("variant.pick.default")}</Chip>
          ) : (
            <Chip tone="change">{t("variant.pick.changed")}</Chip>
          )}
        </span>
      </span>
    </button>
  );
}

export function CatPickScreen({ search, state: rawState, time }: ScreenFrameProps) {
  const state = pickState(rawState, PICK_STATES);
  const agents = state === "new" ? [...PICK_AGENTS, NEW_AGENT] : PICK_AGENTS;
  const [links, setLinks] = useState<Links>(() => initialLinks(agents, pickUserLinks(state)));
  const [current, setCurrent] = useState<string>(() => agentFromUrl(search, agents) ?? (state === "new" ? NEW_AGENT.agent : "main"));
  const [notice, setNotice] = useState<{ text: string; undo: Links } | null>(null);
  const tabs = useRef(new Map<string, HTMLButtonElement>());

  // 알림은 잠시 뒤 사라진다 (되돌리기 단추가 있는 동안 넉넉히)
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 8000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const agent = agents.find((a) => a.agent === current) ?? agents[0];
  const cat = links[agent.agent];
  const name = (a: PickAgent) => t(a.nameKey);

  const choose = (next: CatId) => {
    if (cat === next) return;
    const before = links;
    const owner = agents.find((a) => a.agent !== agent.agent && links[a.agent] === next);
    const updated: Links = { ...links, [agent.agent]: next };
    // 다른 에이전트가 쓰던 고양이면 서로 바꾼다 (지금 고양이가 없으면 둘이 같은 고양이)
    if (owner && cat) {
      updated[owner.agent] = cat;
      setNotice({ text: tf("variant.pick.swapped", { a: name(agent), b: name(owner) }), undo: before });
    }
    setLinks(updated);
  };

  const reset = () => setLinks((prev) => ({ ...prev, [agent.agent]: agent.defaultCat }));
  const resetAll = () => {
    setNotice(null);
    setLinks(initialLinks(agents, {}));
  };
  const changedCount = agents.filter((a) => links[a.agent] !== a.defaultCat).length;
  const newCat = state === "new" ? links[NEW_AGENT.agent] : null;

  const index = agents.findIndex((a) => a.agent === agent.agent);
  const move = (to: number) => {
    const next = agents[(to + agents.length) % agents.length];
    setCurrent(next.agent);
    tabs.current.get(next.agent)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(agents.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <ScreenShell nav="settings" time={time} className="pk">
      <div className="tray pk-tray">
        <header className="tray__head">
          <div className="tray__titles">
            <h1 className="tray__title rnd">{t("variant.pick.title")}</h1>
            <p className="tray__lead">{t("variant.pick.lead")}</p>
          </div>
          <button type="button" className="hbtn" onClick={resetAll} disabled={changedCount === 0}>
            <Icon name="undo" size={18} />
            {t("variant.pick.resetAll")}
          </button>
        </header>

        <div className="pk-body">
          <div className="pk-agents">
            <h2 className="pk-h rnd" id="pk-agents-title">
              {t("variant.pick.agents")}
            </h2>
            <div className="pk-tabs" role="tablist" aria-orientation="vertical" aria-labelledby="pk-agents-title" onKeyDown={onKeyDown}>
              {agents.map((a) => (
                <AgentTab
                  key={a.agent}
                  agent={a}
                  cat={links[a.agent]}
                  selected={a.agent === agent.agent}
                  onSelect={() => setCurrent(a.agent)}
                  register={(el) => {
                    if (el) tabs.current.set(a.agent, el);
                    else tabs.current.delete(a.agent);
                  }}
                />
              ))}
            </div>
            {state !== "new" && (
              <div className="pk-slot">
                <Icon name="plus" size={18} />
                <div>
                  <p className="rnd">{t("variant.pick.newSlot")}</p>
                  <p className="muted su-small">{t("variant.pick.newSlotHint")}</p>
                </div>
              </div>
            )}
          </div>

          <section className="pk-panel" id="pk-panel" role="tabpanel" aria-labelledby={`pk-tab-${agent.agent}`}>
            {agent.defaultCat === null && cat === null && (
              <Banner tone="info" title={t("variant.pick.newTitle")}>
                <p>{t("variant.pick.newBody")}</p>
              </Banner>
            )}
            {notice && (
              <Banner
                tone="ok"
                live
                title={notice.text}
                actions={
                  <button
                    type="button"
                    className="hbtn"
                    onClick={() => {
                      setLinks(notice.undo);
                      setNotice(null);
                    }}
                  >
                    <Icon name="undo" size={18} />
                    {t("variant.pick.undo")}
                  </button>
                }
              />
            )}

            <div className="pk-hero">
              <div className="pk-hero__cat" aria-hidden="true">
                {cat ? <CatFigure cat={cat} pose="sit" /> : <Icon name="paw" size={48} />}
              </div>
              <div className="pk-hero__text">
                <h2 className="pk-hero__title rnd">{tf("variant.pick.catOf", { agent: name(agent) })}</h2>
                <p className="pk-hero__name rnd">{cat ? t(`cat.${cat}.name`) : t("variant.pick.none")}</p>
                {cat && <p className="muted">{t(`variant.pick.fur.${cat}`)}</p>}
                <p className="muted su-small">
                  {agent.subKey ? t(agent.subKey) : <code className="mono">{agent.file}</code>}
                  {agent.defaultCat && (
                    <>
                      <span aria-hidden="true"> · </span>
                      {tf("variant.pick.defaultIs", { cat: t(`cat.${agent.defaultCat}.name`) })}
                    </>
                  )}
                </p>
                {agent.agent === "main" && <p className="muted su-small">{t("variant.pick.mainNote")}</p>}
                <button type="button" className="hbtn" onClick={reset} disabled={cat === agent.defaultCat}>
                  <Icon name="undo" size={18} />
                  {t("variant.pick.reset")}
                </button>
              </div>
              {cat && (
                <figure className="pk-poses">
                  <figcaption className="muted su-small">{t("variant.pick.poses")}</figcaption>
                  <ul>
                    {POSES.map((pose) => (
                      <li key={pose}>
                        <span className="pk-poses__frame">
                          <CatFigure cat={cat} pose={pose} motion="still" />
                        </span>
                        <span className="su-small muted">{t(`variant.pick.pose.${pose}`)}</span>
                      </li>
                    ))}
                  </ul>
                </figure>
              )}
            </div>

            <div className="pk-pick" role="radiogroup" aria-labelledby="pk-cats-title" aria-describedby="pk-swap-note">
              <div className="pk-pick__head">
                <h3 id="pk-cats-title" className="pk-h rnd">
                  {tf("variant.pick.cats", { n: CAT_IDS.length })}
                </h3>
                <span id="pk-swap-note" className="muted su-small">
                  {t("variant.pick.swapHint")}
                </span>
              </div>
              <div className="pk-grid">
                {CAT_IDS.map((id) => {
                  const owner = agents.find((a) => a.agent !== agent.agent && links[a.agent] === id);
                  const checked = cat === id;
                  return (
                    <label key={id} className="pk-card" data-checked={checked ? "true" : undefined}>
                      <input type="radio" name="pk-cat" value={id} checked={checked} onChange={() => choose(id)} />
                      <span className="pk-card__plate" aria-hidden="true">
                        <CatFigure cat={id} pose="sit" motion="still" />
                      </span>
                      <span className="pk-card__name rnd">{t(`cat.${id}.name`)}</span>
                      <span className="pk-card__fur">{t(`variant.pick.fur.${id}`)}</span>
                      {checked ? (
                        <span className="pk-card__mark">
                          <Icon name="check" size={14} />
                        </span>
                      ) : owner ? (
                        <span className="pk-card__owner">{tf("variant.pick.usedBy", { agent: name(owner) })}</span>
                      ) : null}
                    </label>
                  );
                })}
                <div className="pk-card pk-card--more">
                  <span className="pk-card__plate" aria-hidden="true">
                    <Icon name="plus" size={28} />
                  </span>
                  <span className="pk-card__name rnd">{t("variant.pick.more")}</span>
                  <span className="pk-card__fur">{t("variant.pick.moreBody")}</span>
                </div>
              </div>
            </div>
            <p className="pk-saved muted su-small">
              <Icon name="check" size={14} />
              {t("variant.pick.saved")}
            </p>
          </section>
        </div>
        {state === "new" && (
          <footer className="tray__foot pk-foot">
            <p className="tray__foot-note" id="pk-done-note" aria-live="polite">
              {newCat
                ? tf("variant.pick.doneReady", { agent: name(NEW_AGENT), cat: t(`cat.${newCat}.name`) })
                : tf("variant.pick.doneWhy", { agent: name(NEW_AGENT) })}
            </p>
            <a className="hbtn" href={screenHref(search, "edit", { state: "new" })}>
              {t("variant.pick.back")}
            </a>
            {newCat ? (
              <a className="hbtn hbtn--primary" href={screenHref(search, "edit", { item: NEW_AGENT.agent })} aria-describedby="pk-done-note">
                <Icon name="check" size={18} />
                {t("variant.pick.done")}
              </a>
            ) : (
              <button type="button" className="hbtn hbtn--primary" disabled aria-describedby="pk-done-note">
                <Icon name="check" size={18} />
                {t("variant.pick.done")}
              </button>
            )}
          </footer>
        )}
      </div>
    </ScreenShell>
  );
}
