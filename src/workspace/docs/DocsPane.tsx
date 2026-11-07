// 문서 탭 (D-49) — 그 프로젝트 `docs/` 의 마크다운을 읽기 전용으로 목록 · 미리보기. 넓은 창(1280 이상)은 목록 | 미리보기 나란히, 좁은 창은 목록 ↔ 미리보기 전환 (뒤로 단추).
// 문서를 고치거나 문서 안 링크를 따라가거나 검색하지 않는다 (미리보기가 링크를 글자로만 보인다). 프로젝트마다 하나 (화면의 `key`).
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { t, tf, type TextKey } from "../../i18n/ko";
import type { RequirementsProblem } from "../../lib/ipc-types";
import { Icon } from "../../variants/shared/icons";
import { errorText } from "../errors";
import { MarkdownPreview } from "../MarkdownPreview";
import { useWide } from "../WorkPanels";
import { groupDocs } from "./group";
import { useDocs, type DocState } from "./useDocs";
import "./docs.css";

const reasonText = (reason: RequirementsProblem): string => t(`ws.docs.reason.${reason}` as TextKey);

/** "11월 7일 09:41" — 이 PC 의 시계로. 모르면 빈 글 */
function modifiedText(seconds: number | null): string {
  if (seconds === null) return "";
  const date = new Date(seconds * 1000);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getMonth() + 1}월 ${date.getDate()}일 ${clock}`;
}

function Body({ doc }: { doc: DocState }) {
  switch (doc.kind) {
    case "loading":
      return (
        <p className="ws-dc__note" role="status">
          {t("ws.docs.docLoading")}
        </p>
      );
    case "error":
      return (
        <p className="ws-dc__note" role="alert">
          <Icon name="alert" size={16} />
          {tf("ws.docs.docFailed", { reason: errorText(doc.error) })}
        </p>
      );
    case "gone":
      return (
        <div className="ws-dc__state" role="status">
          <Icon name="alert" size={24} />
          <h3 className="ws-dc__state-title">{t("ws.docs.docGone")}</h3>
          <p>{t("ws.docs.docGoneBody")}</p>
        </div>
      );
    case "unreadable":
      return (
        <div className="ws-dc__state" role="status">
          <Icon name="alert" size={24} />
          <h3 className="ws-dc__state-title">{t("ws.docs.docUnreadable")}</h3>
          <p>{reasonText(doc.reason)}</p>
        </div>
      );
    case "ready":
      return doc.text.trim() === "" ? <p className="ws-dc__note">{t("ws.docs.docEmpty")}</p> : <MarkdownPreview text={doc.text} />;
  }
}

export function DocsPane({ projectId, visible }: { projectId: number; visible: boolean }) {
  const { list, path, doc, modified, open, reload } = useDocs(projectId, visible);
  const wide = useWide();
  /** 좁은 창에서 무엇을 보이나 */
  const [mode, setMode] = useState<"list" | "doc">("list");
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  const groups = useMemo(() => (list.kind === "ready" ? groupDocs(list.listing.files) : []), [list]);
  const showList = wide || mode === "list";
  const showDoc = wide || mode === "doc";

  // 좁은 창에서 목록 ↔ 미리보기를 옮기면 포커스도 따라간다 (처음 그릴 때는 건드리지 않는다)
  useEffect(() => {
    if (!moved.current) return;
    if (mode === "doc") heading.current?.focus();
    else root.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
  }, [mode]);

  const pick = (target: string) => {
    moved.current = true;
    open(target);
    setMode("doc");
  };
  const back = () => {
    moved.current = true;
    setMode("list");
  };

  /** ↑ ↓ Home End 로 목록의 문서를 오간다 (Tab 으로도 되지만 긴 목록에서는 이쪽이 빠르다) */
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-doc]"));
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
    items[next]?.focus();
    event.preventDefault();
  };

  return (
    <div className="ws-dc" ref={root} data-testid="docs-pane" data-wide={wide ? "true" : undefined}>
      {showList && (
        <nav className="ws-dc__list" aria-label={t("ws.docs.listTitle")} onKeyDown={onListKeyDown}>
          {list.kind === "loading" && (
            <p className="ws-dc__note" role="status">
              {t("ws.docs.loading")}
            </p>
          )}
          {list.kind === "error" && (
            <div className="ws-dc__state" role="alert">
              <Icon name="alert" size={24} />
              <p>{tf("ws.docs.failed", { reason: errorText(list.error) })}</p>
              <button type="button" className="ws-btn ws-btn--small" onClick={reload}>
                <Icon name="refresh" size={16} />
                {t("ws.docs.retry")}
              </button>
            </div>
          )}
          {list.kind === "absent" && (
            <div className="ws-dc__state" role="status">
              <Icon name="folder" size={24} />
              <h3 className="ws-dc__state-title">{t("ws.docs.absent")}</h3>
              <p>{t("ws.docs.absentBody")}</p>
            </div>
          )}
          {list.kind === "unreadable" && (
            <div className="ws-dc__state" role="status">
              <Icon name="alert" size={24} />
              <h3 className="ws-dc__state-title">{t("ws.docs.unreadable")}</h3>
              <p>{reasonText(list.reason)}</p>
              <button type="button" className="ws-btn ws-btn--small" onClick={reload}>
                <Icon name="refresh" size={16} />
                {t("ws.docs.retry")}
              </button>
            </div>
          )}
          {list.kind === "ready" && (
            <>
              {list.listing.truncated && (
                <p className="ws-dc__trunc" role="status">
                  <Icon name="info" size={14} />
                  {t("ws.docs.truncated")}
                </p>
              )}
              {groups.length === 0 && <p className="ws-dc__note">{t("ws.docs.empty")}</p>}
              {groups.map((group) => (
                <section key={group.dir} className="ws-dc__group">
                  <h3 className="ws-dc__dir" title={group.dir || list.listing.docsDir}>
                    <Icon name="folder" size={14} />
                    <span>{tf("ws.docs.root", { dir: group.dir ? `${list.listing.docsDir}/${group.dir}` : list.listing.docsDir })}</span>
                    <span className="ws-dc__count">{tf("ws.docs.count", { n: group.files.length })}</span>
                  </h3>
                  <ul>
                    {group.files.map((file) => (
                      <li key={file.path}>
                        <button type="button" className="ws-dc__item" data-doc={file.path} aria-current={file.path === path ? "true" : undefined} title={file.path} onClick={() => pick(file.path)}>
                          <Icon name="file" size={14} />
                          <span className="ws-dc__name">{file.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </nav>
      )}
      {showDoc && (
        <section className="ws-dc__view" aria-label={t("ws.docs.region")}>
          {path === null || doc === null ? (
            <p className="ws-dc__pick">{t("ws.docs.pick")}</p>
          ) : (
            <>
              <header className="ws-dc__head">
                {!wide && (
                  <button type="button" className="ws-btn ws-btn--small" onClick={back} aria-label={t("ws.docs.backLabel")}>
                    <Icon name="undo" size={16} />
                    {t("ws.docs.back")}
                  </button>
                )}
                <h3 className="ws-dc__title" ref={heading} tabIndex={-1} title={path}>
                  {path}
                </h3>
                <span className="ws-dc__ro">
                  <Icon name="file" size={12} />
                  {t("ws.docs.readOnly")}
                </span>
              </header>
              {modified !== null && doc.kind === "ready" && <p className="ws-dc__mod">{tf("ws.docs.modified", { at: modifiedText(modified) })}</p>}
              <div className="ws-dc__body" tabIndex={0} aria-label={path}>
                <Body doc={doc} />
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
