// 요구사항 편집기 — 그 프로젝트 폴더의 requirements.md (D-11). 시제품 `variants/shared/editor.tsx` 의 모양에 실제 읽기 · 저장을 이은 것.
// 쓰기(CodeMirror 6) ↔ 미리보기 전환, 저장 표시, 바깥에서 바뀌었을 때의 충돌 띠, 없음 · 읽을 수 없음. 데이터 쪽은 `useRequirements`.
// 단축키: `Ctrl+S` 바로 저장, `Ctrl+Shift+V` 쓰기 ↔ 미리보기 (Mac 은 ⌘).
import { useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { t, tf, type TextKey } from "../i18n/ko";
import type { RequirementsProblem } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { errorText } from "./errors";
import { MarkdownEditor, type MarkdownEditorHandle } from "./MarkdownEditor";
import { MarkdownPreview } from "./MarkdownPreview";
import { useRequirements, type RequirementsApi, type SaveFailure } from "./useRequirements";

type Mode = "write" | "preview";

const PROBLEM_TEXT: Record<RequirementsProblem, TextKey> = {
  not_utf8: "ws.req.problem.not_utf8",
  too_large: "ws.req.problem.too_large",
  outside_folder: "ws.req.problem.outside_folder",
  link: "ws.req.problem.link",
  folder_missing: "ws.req.problem.folder_missing",
  not_a_file: "ws.req.problem.not_a_file",
  read_failed: "ws.req.problem.read_failed",
};

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function failureText(failure: SaveFailure): string {
  return failure.kind === "error" ? errorText(failure.error) : t(PROBLEM_TEXT[failure.reason]);
}

function SaveBadge({ api }: { api: RequirementsApi }) {
  const { status, dirty, savedAt, conflict } = api;
  if (status.kind === "failed")
    return (
      <span className="ws-ed__saved" data-state="failed" role="alert">
        <Icon name="alert" size={14} />
        <span>{tf("ws.editor.saveFailed", { reason: failureText(status.failure) })}</span>
        <button type="button" className="ws-btn ws-btn--small" onClick={api.saveNow}>
          {t("ws.editor.retry")}
        </button>
      </span>
    );
  if (status.kind === "saving")
    return (
      <span className="ws-ed__saved" data-state="saving" role="status">
        {t("variant.ws.editor.saving")}
      </span>
    );
  if (dirty)
    return (
      <span className="ws-ed__saved" data-state="unsaved" role="status">
        <span className="ws-ed__dot" aria-hidden="true" />
        {conflict ? t("ws.editor.heldBack") : t("variant.ws.editor.unsaved")}
      </span>
    );
  return (
    <span className="ws-ed__saved" data-state="saved" role="status">
      <Icon name="check" size={14} />
      {savedAt ? tf("variant.ws.editor.savedAt", { at: clock(savedAt) }) : t("ws.editor.saved")}
    </span>
  );
}

/** 충돌 띠 때문에 저장을 멈춘 동안 작업 공간이 쥐는 손잡이 — 떠나기 전에 묻고, "남기고 가기" 면 여기서 쓴 글을 쓴다 */
export interface EditorGuard {
  keepMine: () => void;
}

interface Props {
  projectId: number;
  /** 넓은 창에서 칸 접기 */
  onCollapse?: () => void;
  /** 저장을 멈춘 동안(충돌 띠)만 채워진다. 아니면 null */
  guardRef?: MutableRefObject<EditorGuard | null>;
}

export function RequirementsEditor({ projectId, onCollapse, guardRef }: Props) {
  const handle = useRef<MarkdownEditorHandle>(null);
  const composing = useRef<() => boolean>(() => false);
  useEffect(() => {
    composing.current = () => handle.current?.isComposing() ?? false;
  });
  const api = useRequirements(projectId, { isComposing: composing });
  const [mode, setMode] = useState<Mode>("write");
  const userSwitched = useRef(false);
  const { load, conflict } = api;
  const ready = load.kind === "ready";
  /** 바깥에서 파일이 지워졌다 (충돌 띠의 말 · 단추가 달라진다) */
  const gone = conflict?.version === null;
  const { overwrite } = api;

  // 저장을 멈춘 동안만 작업 공간에 알린다 — 떠날 때 물을 수 있게
  useEffect(() => {
    if (!guardRef) return;
    guardRef.current = conflict ? { keepMine: overwrite } : null;
    return () => {
      guardRef.current = null;
    };
  }, [guardRef, conflict, overwrite]);

  // 미리보기에서 쓰기로 돌아오면 편집기로 포커스
  useEffect(() => {
    if (mode === "write" && userSwitched.current) handle.current?.focus();
  }, [mode]);

  const switchMode = (next: Mode) => {
    if (!ready) return;
    userSwitched.current = true;
    setMode(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      api.saveNow();
    } else if (key === "v" && event.shiftKey) {
      event.preventDefault();
      switchMode(mode === "write" ? "preview" : "write");
    }
  };

  return (
    <div className="ws-ed" onKeyDown={onKeyDown}>
      <div className="ws-ed__bar">
        <span className="ws-ed__file">
          <Icon name="file" size={14} />
          <code className="ws-ed__path" title="requirements.md">
            requirements.md
          </code>
        </span>
        {ready && <SaveBadge api={api} />}
        <span className="ws-ed__spacer" />
        <div className="ws-ed__mode" role="group" aria-label={t("variant.ws.editor.mode")}>
          <button type="button" aria-pressed={mode === "write"} disabled={!ready} onClick={() => switchMode("write")}>
            {t("variant.ws.editor.write")}
          </button>
          <button
            type="button"
            aria-pressed={mode === "preview"}
            disabled={!ready}
            title={t("ws.editor.previewKeys")}
            aria-keyshortcuts="Control+Shift+V"
            onClick={() => switchMode("preview")}
          >
            {t("variant.ws.editor.preview")}
          </button>
        </div>
        {onCollapse && (
          <button type="button" className="ws-icon-btn" onClick={onCollapse} aria-label={t("variant.ws.collapse.editor")} title={t("variant.ws.collapse.editor")}>
            <Icon name="collapse" size={16} />
          </button>
        )}
      </div>

      {conflict && (
        <div className="ws-ed__banner" data-tone="warn" role="alert">
          <Icon name="alert" size={16} />
          <span>
            <strong className="ws-ed__banner-title">{gone ? t("ws.editor.conflictGoneTitle") : t("ws.editor.conflictTitle")}</strong>
            {gone ? t("ws.editor.conflictGone") : t("ws.editor.conflict")}
          </span>
          <span className="ws-ed__banner-actions">
            <button type="button" className="ws-btn ws-btn--small" onClick={api.overwrite}>
              {gone ? t("ws.editor.overwriteGone") : t("ws.editor.overwrite")}
            </button>
            <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={api.takeOutside}>
              {gone ? t("ws.editor.takeOutsideGone") : t("ws.editor.takeOutside")}
            </button>
          </span>
        </div>
      )}
      {api.notice && !conflict && (
        <div className="ws-ed__banner" data-tone="info" role="status">
          <Icon name="info" size={16} />
          <span>{t("ws.editor.reloaded")}</span>
          <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={api.dismissNotice}>
            {t("variant.ui.dismiss")}
          </button>
        </div>
      )}

      {load.kind === "loading" && (
        <p className="ws-ed__state" role="status">
          {t("ws.editor.loading")}
        </p>
      )}
      {load.kind === "error" && (
        <div className="ws-ed__state" role="alert">
          <p>{tf("ws.editor.loadFailed", { reason: errorText(load.error) })}</p>
          <button type="button" className="ws-btn" onClick={api.reload}>
            {t("ws.proj.retry")}
          </button>
        </div>
      )}
      {load.kind === "unreadable" && (
        <div className="ws-ed__state" role="alert">
          <p className="ws-ed__state-title">{t("ws.req.unreadable")}</p>
          <p>{t(PROBLEM_TEXT[load.reason])}</p>
          <p className="ws-ed__hint">{t("ws.req.openElsewhere")}</p>
          <button type="button" className="ws-btn" onClick={api.reload}>
            {t("ws.editor.reread")}
          </button>
        </div>
      )}

      {ready && load.absent && api.savedAt === null && (
        <p className="ws-ed__absent" role="status">
          <Icon name="info" size={14} />
          {t("ws.editor.absent")}
        </p>
      )}
      {ready && (
        <div className="ws-ed__area" hidden={mode !== "write"}>
          <MarkdownEditor doc={api.doc} label={t("variant.ws.editor.textarea")} onChange={api.onEdit} handle={handle} />
        </div>
      )}
      {ready && mode === "preview" && (
        <div className="ws-ed__preview">
          <MarkdownPreview text={api.getText()} />
        </div>
      )}

      <p className="ws-ed__foot">
        <span className="ws-ed__hint-key">
          {t("variant.ws.editor.autosave")} <kbd>Ctrl</kbd>+<kbd>S</kbd>
        </span>
        <span className="ws-ed__hint-key">
          {t("ws.editor.previewToggle")} <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>
        </span>
      </p>
    </div>
  );
}
