// 왼쪽 목록 — 찾기 칸 + 묶음(오케스트레이터 · 에이전트 · 스킬) + 항목(고양이 얼굴 · 이름 · 파일 · 표시 칩). 읽을 수 없는 항목은 흐리게 + 이유.
// 키보드: 위 · 아래 화살표 · Home · End 로 항목을 옮기며 고른다 (한 번에 하나만 Tab 으로 들어간다).
import { useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n/ko";
import type { CustomItemKind, CustomListEntry } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { itemCat, itemLabel, unreadableText, type RoleMap } from "./format";
import { Chip, ItemFace, Marks } from "./parts";

interface Props {
  entries: readonly CustomListEntry[];
  current: string | null;
  onPick: (id: string) => void;
  roles: RoleMap;
  cats: Readonly<Record<string, string>>;
}

const GROUPS: ReadonlyArray<{ kind: CustomItemKind; title: "edit.group.main" | "edit.group.agents" | "edit.group.skills" }> = [
  { kind: "main", title: "edit.group.main" },
  { kind: "agent", title: "edit.group.agents" },
  { kind: "skill", title: "edit.group.skills" },
];

/** 하네스 작업자는 집 · 시안과 같은 역할 순서(디자이너 · 화면 구현 · 시스템 구현 · 시험 · 정리 · 점검)로 먼저, 그 밖은 파일 이름 순으로 (이미 그 순서로 온다) */
const ROLE_ORDER: readonly string[] = ["designer", "ui", "system", "tester", "helper", "reviewer"];

function ordered(group: CustomListEntry[], roles: RoleMap): CustomListEntry[] {
  const rank = (entry: CustomListEntry) => {
    const at = entry.kind === "agent" ? ROLE_ORDER.indexOf(roles.get(entry.name) ?? "") : -1;
    return at < 0 ? ROLE_ORDER.length : at;
  };
  return group.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry);
}

export function ItemList({ entries, current, onPick, roles, cats }: Props) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const needle = query.trim().toLowerCase();
  const label = (entry: CustomListEntry) => itemLabel(entry.kind, entry.name, roles);
  const matches = (entry: CustomListEntry) => needle === "" || label(entry).toLowerCase().includes(needle) || entry.file.toLowerCase().includes(needle) || entry.name.toLowerCase().includes(needle);
  const groups = GROUPS.map((group) => ({ ...group, all: ordered(entries.filter((entry) => entry.kind === group.kind), roles) })).map((group) => ({ ...group, shown: group.all.filter(matches) }));
  const visible = groups.flatMap((group) => group.shown);
  // Tab 으로 들어가는 항목: 고른 항목이 보이면 그것, 아니면 첫 항목
  const tabStop = visible.find((entry) => entry.id === current)?.id ?? visible[0]?.id ?? null;

  const onKeyDown = (event: KeyboardEvent) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key) || visible.length === 0) return;
    const at = visible.findIndex((entry) => entry.id === document.activeElement?.getAttribute("data-item"));
    if (at < 0) return;
    const to = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : Math.min(visible.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    const next = visible[to]!;
    onPick(next.id);
    Array.from(list.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])
      .find((el) => el.dataset.item === next.id)
      ?.focus();
  };

  return (
    <nav className="ed-list" aria-label={t("edit.listLabel")}>
      <label className="ed-search">
        <Icon name="search" size={14} />
        <input type="search" className="ed-search__in" placeholder={t("edit.search")} aria-label={t("edit.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="ed-list__scroll" ref={list} onKeyDown={onKeyDown}>
        {visible.length === 0 && (
          <p className="ed-list__none" role="status">
            {t("edit.listNone")}
          </p>
        )}
        {groups.map((group) =>
          group.shown.length === 0 ? null : (
            <section key={group.kind} aria-label={t(group.title)}>
              <h3 className="ed-list__title">
                {t(group.title)}
                <span className="ed-count">{group.all.length}</span>
              </h3>
              <ul className="ed-list__items">
                {group.shown.map((entry) => {
                  const ok = entry.state === "ok";
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="ed-item"
                        data-item={entry.id}
                        data-unreadable={ok ? undefined : "true"}
                        aria-current={entry.id === current ? "true" : undefined}
                        tabIndex={entry.id === tabStop ? 0 : -1}
                        onClick={() => onPick(entry.id)}
                      >
                        <ItemFace cat={itemCat(entry.kind, entry.name, roles, cats)} kind={entry.kind} />
                        <span className="ed-item__text">
                          <span className="ed-item__name">{label(entry)}</span>
                          <span className="ed-item__file">{entry.file}</span>
                        </span>
                        <span className="ed-item__marks">
                          {entry.state === "ok" ? (
                            <Marks marks={entry.marks} originChanged={entry.originChanged} />
                          ) : (
                            <Chip tone="delete">
                              <Icon name="alert" size={12} />
                              {t("edit.mark.unreadable")}
                            </Chip>
                          )}
                        </span>
                        {entry.state === "unreadable" && <span className="ed-item__why">{unreadableText(entry.reason)}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ),
        )}
      </div>
    </nav>
  );
}
