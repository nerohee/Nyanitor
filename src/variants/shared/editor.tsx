// 요구사항 편집기 (P2-14) — 그 프로젝트 폴더의 requirements.md (D-11).
// 판단: "쓰기" 는 마크다운 기호가 보이는 한 칸이되 제목 · 목록을 색으로 꾸민다(쓰는 그대로 읽힘), "미리보기" 는 전환.
//   나란히(쓰기 | 미리보기)는 넓은 창에서도 칸이 좁아(약 400px) 두 칸 모두 읽기 어렵다 → 전환 + 꾸민 쓰기.
//   실제 편집기는 P6 CodeMirror 6 (D-27) — 마크다운 꾸밈 · 되돌리기 · 찾기를 거기서. 시제품은 textarea 위에 같은 글꼴로 꾸민 글을 겹쳐 흉내 낸다.
// 저장: 쓰다가 1초 쉬면 자동 저장 + Ctrl+S 바로 저장. 다른 곳(터미널)에서 파일이 바뀌면 알림.
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t, tf } from "../../i18n/ko";
import type { EditorFixture } from "../fixtures-workspace";
import { Icon } from "./icons";

type SaveState = { kind: "saved"; at: string } | { kind: "unsaved" } | { kind: "saving" };

const AUTOSAVE_MS = 1000;
const SAVING_MS = 400;

function clock(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** 쓰기 칸 꾸밈 — 글자 폭이 바뀌지 않게 색 · 테두리 그림자만 (커서 위치가 어긋나지 않게) */
function highlight(text: string): ReactNode {
  return text.split("\n").map((line, i) => {
    let body: ReactNode = line;
    const heading = /^(#{1,6} )(.*)$/.exec(line);
    const item = /^(\s*[-*] |\s*\d+\. )(.*)$/.exec(line);
    if (heading)
      body = (
        <>
          <span className="mdh__mark">{heading[1]}</span>
          <span className={`mdh__h mdh__h${heading[1].length - 1}`}>{heading[2]}</span>
        </>
      );
    else if (item)
      body = (
        <>
          <span className="mdh__bullet">{item[1]}</span>
          {item[2]}
        </>
      );
    return (
      <Fragment key={i}>
        {body}
        {"\n"}
      </Fragment>
    );
  });
}

/** 아주 작은 마크다운 보기 (# 제목 · - 목록 · 문단만). 새 의존성 없이 미리보기 모양만 */
function MarkdownLite({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) {
      const items = list;
      blocks.push(
        <ul key={`ul-${blocks.length}`}>
          {items.map((item, i) => (
            <li key={`${i}-${item}`}>{item}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };
  text.split("\n").forEach((line) => {
    if (/^\s*[-*] /.test(line)) {
      list.push(line.replace(/^\s*[-*] /, ""));
      return;
    }
    flush();
    if (line.startsWith("## ")) blocks.push(<h3 key={blocks.length}>{line.slice(3)}</h3>);
    else if (line.startsWith("# ")) blocks.push(<h2 key={blocks.length}>{line.slice(2)}</h2>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{line}</p>);
  });
  flush();
  return <div className="md selectable">{blocks}</div>;
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state.kind === "saved")
    return (
      <span className="wed__saved" data-state="saved">
        <Icon name="check" size={14} />
        {tf("variant.ws.editor.savedAt", { at: state.at })}
      </span>
    );
  if (state.kind === "saving")
    return (
      <span className="wed__saved" data-state="saving">
        {t("variant.ws.editor.saving")}
      </span>
    );
  return (
    <span className="wed__saved" data-state="unsaved">
      <span className="wed__dot" aria-hidden="true" />
      {t("variant.ws.editor.unsaved")}
    </span>
  );
}

export function RequirementsEditor({
  editor,
  initialMode = "write",
  onCollapse,
}: {
  editor: EditorFixture;
  initialMode?: "write" | "preview";
  /** 넓은 창에서 칸 접기 */
  onCollapse?: () => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [text, setText] = useState(() => (editor.textKey ? t(editor.textKey) : ""));
  const [save, setSave] = useState<SaveState>({ kind: "saved", at: "09:12" });
  const [external, setExternal] = useState(editor.status === "external");
  const [started, setStarted] = useState(editor.textKey !== null);
  const hl = useRef<HTMLPreElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // 쓰다가 쉬면 자동 저장 (시제품 — 실제 저장은 P6 IPC)
  useEffect(() => {
    if (save.kind === "unsaved") {
      const id = window.setTimeout(() => setSave({ kind: "saving" }), AUTOSAVE_MS);
      return () => window.clearTimeout(id);
    }
    if (save.kind === "saving") {
      const id = window.setTimeout(() => setSave({ kind: "saved", at: clock() }), SAVING_MS);
      return () => window.clearTimeout(id);
    }
  }, [save]);

  const onChange = (value: string) => {
    setText(value);
    setSave({ kind: "unsaved" });
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      setSave({ kind: "saved", at: clock() });
    }
  };
  const syncScroll = () => {
    if (hl.current && area.current) hl.current.scrollTop = area.current.scrollTop;
  };
  const startExample = () => {
    setStarted(true);
    onChange(t("variant.ws.editor.example"));
    window.setTimeout(() => area.current?.focus(), 0);
  };

  return (
    <div className="wed" onKeyDown={onKeyDown}>
      <div className="wed__bar">
        <span className="wed__file">
          <Icon name="file" size={14} />
          <code className="wed__path" title={editor.path}>
            requirements.md
          </code>
        </span>
        <SaveBadge state={save} />
        <span className="wed__spacer" />
        <div className="wed__mode" role="group" aria-label={t("variant.ws.editor.mode")}>
          <button type="button" aria-pressed={mode === "write"} onClick={() => setMode("write")}>
            {t("variant.ws.editor.write")}
          </button>
          <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")} disabled={!started}>
            {t("variant.ws.editor.preview")}
          </button>
        </div>
        {onCollapse && (
          <button
            type="button"
            className="icon-btn"
            onClick={onCollapse}
            aria-label={t("variant.ws.collapse.editor")}
            title={t("variant.ws.collapse.editor")}
          >
            <Icon name="collapse" size={16} />
          </button>
        )}
      </div>
      {external && (
        <div className="wed__external" role="status">
          <Icon name="alert" size={16} />
          <span>{t("variant.ws.editor.external")}</span>
          <button type="button" className="hbtn" onClick={() => setExternal(false)}>
            {t("variant.ws.editor.reload")}
          </button>
          <button type="button" className="hbtn hbtn--ghost" onClick={() => setExternal(false)}>
            {t("variant.ws.editor.keepMine")}
          </button>
        </div>
      )}
      {!started ? (
        <div className="wempty wed__empty">
          <p className="wempty__title">{t("variant.ws.editor.emptyTitle")}</p>
          <p className="wempty__body">{t("variant.ws.editor.emptyBody")}</p>
          <div className="wempty__actions">
            <button type="button" className="hbtn hbtn--primary" onClick={startExample}>
              {t("variant.ws.editor.emptyAction")}
            </button>
            <button
              type="button"
              className="hbtn"
              onClick={() => {
                setStarted(true);
                window.setTimeout(() => area.current?.focus(), 0);
              }}
            >
              {t("variant.ws.editor.emptyBlank")}
            </button>
          </div>
        </div>
      ) : mode === "write" ? (
        <div className="wed__area">
          <pre className="wed__hl" ref={hl} aria-hidden="true">
            {highlight(text)}
          </pre>
          <textarea
            ref={area}
            className="wed__text"
            aria-label={t("variant.ws.editor.textarea")}
            value={text}
            placeholder={t("variant.ws.editor.placeholder")}
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
            onScroll={syncScroll}
          />
        </div>
      ) : (
        <div className="wed__preview">
          <MarkdownLite text={text} />
        </div>
      )}
      <p className="wed__foot">
        <span>{t("variant.ws.editor.autosave")}</span>
        <kbd>Ctrl</kbd>+<kbd>S</kbd>
      </p>
    </div>
  );
}
