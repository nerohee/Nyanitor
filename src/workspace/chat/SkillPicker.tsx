// 입력줄의 스킬 고르기 (listbox 팝오버) — 시제품 `SkillPicker` 를 실제 스킬 목록(`skillsList`)에 붙였다.
// 열기: 단추 · 빈 글 칸에서 `/`. 화살표 · Home/End · Enter(또는 Space) 로 정하고 Esc 로 닫는다. 고르면 `onPick(스킬)`.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../../i18n/ko";
import type { SkillInfo } from "../../lib/ipc-types";
import { Icon } from "../../variants/shared/icons";
import type { SkillChoicesState } from "./useChatEnv";

interface Props {
  skills: SkillChoicesState;
  open: boolean;
  /** 누가 열었나 — 닫은 뒤 초점을 그리로 돌려 준다 (`/` 로 열었으면 글 칸, 단추로 열었으면 이 단추) */
  openedBy: "input" | "button";
  onOpenChange: (open: boolean, by?: "input" | "button") => void;
  onPick: (skill: SkillInfo) => void;
  /** `/` 로 열었다가 닫았을 때 초점을 글 칸으로 */
  onClosed: () => void;
  disabled?: boolean;
}

export function SkillPicker({ skills, open, openedBy, onOpenChange, onPick, onClosed, disabled = false }: Props) {
  const [cursor, setCursor] = useState(0);
  // 열 때마다 첫 줄에서 시작 (렌더 중에 맞춘다)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setCursor(0);
  }
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const listId = useId();
  const options = skills.state === "ready" ? skills.skills : [];

  useEffect(() => {
    if (!open) return;
    (list.current ?? pop.current)?.focus();
  }, [open]);

  // 화살표로 옮긴 줄이 긴 목록 밖이면 보이게 (포커스는 목록에 그대로 — aria-activedescendant)
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${cursor}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, cursor, listId]);

  const close = (focus: "input" | "button" | null) => {
    onOpenChange(false);
    if (focus === "button") button.current?.focus();
    if (focus === "input") onClosed();
  };
  const pick = (index: number) => {
    const skill = options[index];
    if (!skill) return;
    onOpenChange(false);
    onPick(skill);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const count = options.length;
    if (event.key === "Escape") close(openedBy);
    else if (event.key === "Tab") {
      close(null);
      return;
    } else if (count === 0) return;
    else if (event.key === "ArrowDown") setCursor((value) => (value + 1) % count);
    else if (event.key === "ArrowUp") setCursor((value) => (value - 1 + count) % count);
    else if (event.key === "Home") setCursor(0);
    else if (event.key === "End") setCursor(count - 1);
    else if (event.key === "Enter" || event.key === " ") pick(cursor);
    else return;
    event.preventDefault();
  };

  const message =
    skills.state === "loading"
      ? t("ws.chat.skill.loading")
      : skills.state === "failed"
        ? t("ws.chat.skill.failed")
        : skills.list !== "ok"
          ? t("ws.chat.skill.noHarness")
          : options.length === 0
            ? t("ws.chat.skill.none")
            : null;

  return (
    <div className="wc-skill">
      <button
        ref={button}
        type="button"
        className="wc-composer__skill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => onOpenChange(!open, "button")}
      >
        <span>{t("variant.ws.chat.skill")}</span>
        <code>{t("ws.chat.skill.pick")}</code>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div
          ref={pop}
          className="wc-skill__pop"
          tabIndex={-1}
          onKeyDown={message ? onKeyDown : undefined}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOpenChange(false);
          }}
        >
          <p className="wc-skill__title" id={`${listId}-title`}>
            {t("variant.ws.chat.skillTitle")}
          </p>
          {message ? (
            <p className="wc-skill__empty" role="status">
              {message}
            </p>
          ) : (
            <ul
              ref={list}
              id={listId}
              role="listbox"
              tabIndex={0}
              aria-labelledby={`${listId}-title`}
              aria-activedescendant={`${listId}-${cursor}`}
              className="wc-skill__list"
              onKeyDown={onKeyDown}
            >
              {options.map((skill, index) => (
                <li
                  key={skill.name}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === cursor}
                  data-cursor={index === cursor ? "true" : undefined}
                  className="wc-skill__opt"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(index)}
                  onMouseEnter={() => setCursor(index)}
                >
                  <code>{skill.command}</code>
                  {skill.origin === "mine" && <span className="wc-skill__mine">{t("variant.ws.chat.skillMine")}</span>}
                  {skill.description && <span className="wc-skill__desc">{skill.description}</span>}
                </li>
              ))}
            </ul>
          )}
          <p className="wc-skill__keys">{t("variant.ws.chat.skillKeys")}</p>
        </div>
      )}
    </div>
  );
}

/** 글 앞에 `/<스킬> ` 을 넣는다 (이미 앞에 스킬이 있으면 바꾼다) */
export function withSkill(text: string, command: string): string {
  return `${command} ${text.replace(/^\/\S*\s*/, "")}`;
}

