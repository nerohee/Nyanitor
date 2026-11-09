// 「내 수정」 화면의 작은 부품 — 칩 · 알림 띠 · 차이 보기 · 고양이 얼굴 · 저장 표시 · 확인 대화상자.
// 시제품(`variants/screens/parts.tsx`)과 같은 모양이지만 그 CSS 는 시안 틀(`.vf`) 안에서만 맞아서, 이 화면용 `ed-*` 로 옮겼다 (값은 모두 tokens.css 의 토큰).
import { useRef, type ReactNode } from "react";
import { CatFigure } from "../components/cat/CatFigure";
import { t, tf } from "../i18n/ko";
import type { CustomDiffLine, CustomMark } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { Dialog } from "../workspace/Dialog";
import { errorText } from "../workspace/errors";
import type { AutoSave, AutoSaveFailure } from "./useAutoSave";
import { refuseText } from "./format";

// ── 칩 ──

export type ChipTone = "add" | "change" | "delete" | "keep" | "warn" | "plain" | "accent";

export function Chip({ tone = "plain", children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span className="ed-chip" data-tone={tone}>
      {children}
    </span>
  );
}

const MARK_CHIP: Record<CustomMark, { tone: ChipTone; text: "edit.mark.values" | "edit.mark.append" | "edit.mark.replace" | "edit.mark.mine" }> = {
  values: { tone: "change", text: "edit.mark.values" },
  append: { tone: "change", text: "edit.mark.append" },
  replace: { tone: "warn", text: "edit.mark.replace" },
  mine: { tone: "add", text: "edit.mark.mine" },
};

/** 표시 칩들 — 값 바꿈 · 덧붙임 · 통째로 · 내가 만듦 · (통째 + 원본이 바뀜이면) 원본 바뀜 */
export function Marks({ marks, originChanged }: { marks: readonly CustomMark[]; originChanged: boolean | null }) {
  return (
    <>
      {marks.map((mark) => (
        <Chip key={mark} tone={MARK_CHIP[mark].tone}>
          {t(MARK_CHIP[mark].text)}
        </Chip>
      ))}
      {originChanged === true && (
        <Chip tone="delete">
          <Icon name="alert" size={12} />
          {t("edit.mark.origin")}
        </Chip>
      )}
    </>
  );
}

// ── 알림 띠 ──

export type BannerTone = "info" | "ok" | "warn" | "danger";

const BANNER_ICON = { info: "info", ok: "check", warn: "alert", danger: "alert" } as const;

export function Banner({
  tone,
  title,
  children,
  actions,
  live = false,
}: {
  tone: BannerTone;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  /** 나타날 때 읽어 주기 (오류 · 끝남) */
  live?: boolean;
}) {
  return (
    <div className="ed-bnr" data-tone={tone} role={live ? (tone === "danger" ? "alert" : "status") : undefined}>
      <span className="ed-bnr__icon" aria-hidden="true">
        <Icon name={BANNER_ICON[tone]} size={16} />
      </span>
      <div className="ed-bnr__body">
        <p className="ed-bnr__title">{title}</p>
        {children}
      </div>
      {actions && <div className="ed-bnr__actions">{actions}</div>}
    </div>
  );
}

/** 저장 결과가 `notOurs` 일 때 — `~/.claude` 에 사용자 자신의 같은 이름 파일이 있어 설치가 건너뛴다 */
export function NotOursBanner() {
  return (
    <Banner tone="warn" live title={t("edit.notOurs.title")}>
      <p>{t("edit.notOurs.body")}</p>
    </Banner>
  );
}

// ── 차이 보기 ──

const SIGN_TEXT = { "+": "+", "-": "−", " ": " ", "@": "" } as const;

export function DiffView({ lines, label }: { lines: readonly CustomDiffLine[]; label: string }) {
  return (
    <div className="ed-dif" role="region" aria-label={label} tabIndex={0}>
      <ol className="ed-dif__lines">
        {lines.map((line, i) => (
          <li key={i} className="ed-dif__line" data-sign={line.sign === " " ? "same" : line.sign === "+" ? "add" : line.sign === "-" ? "del" : "hunk"}>
            {line.sign === "@" ? (
              <span className="ed-dif__hunk">{line.text}</span>
            ) : (
              <>
                <span className="ed-dif__no" aria-hidden="true">
                  {line.old ?? ""}
                </span>
                <span className="ed-dif__no" aria-hidden="true">
                  {line.new ?? ""}
                </span>
                <span className="ed-dif__sign" aria-hidden="true">
                  {SIGN_TEXT[line.sign]}
                </span>
                {line.sign === "+" && <span className="ws-sr">{t("edit.diff.added")} </span>}
                {line.sign === "-" && <span className="ws-sr">{t("edit.diff.removed")} </span>}
                <code className="ed-dif__text">{line.text || " "}</code>
              </>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ── 고양이 얼굴 ──

/** 목록 · 머리의 둥근 얼굴 — 고양이가 있으면 얼굴만, 없으면 기본 아이콘(스킬은 파일, 그 밖은 발바닥) */
export function ItemFace({ cat, kind }: { cat: string | null; kind: "main" | "agent" | "skill" }) {
  return (
    <span className="ed-face" data-kind={kind} aria-hidden="true">
      {cat ? <CatFigure cat={cat} crop="face" /> : <Icon name={kind === "skill" ? "file" : "paw"} size={18} />}
    </span>
  );
}

// ── 저장 표시 ──

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export function failureText(failure: AutoSaveFailure): string {
  return failure.kind === "error" ? errorText(failure.error) : refuseText(failure.reason);
}

/** 글 칸 옆의 저장 중 · 저장됨 · 저장 안 됨 · 실패(다시 저장) */
export function SaveBadge({ api }: { api: AutoSave }) {
  const failure = api.status.kind === "failed" ? api.status.failure : null;
  if (failure)
    return (
      <span className="ws-ed__saved" data-state="failed" role="alert">
        <Icon name="alert" size={14} />
        <span>{tf("ws.editor.saveFailed", { reason: failureText(failure) })}</span>
        <button type="button" className="ws-btn ws-btn--small" onClick={api.saveNow}>
          {t("ws.editor.retry")}
        </button>
      </span>
    );
  if (api.status.kind === "saving")
    return (
      <span className="ws-ed__saved" data-state="saving" role="status">
        {t("variant.ws.editor.saving")}
      </span>
    );
  if (api.dirty)
    return (
      <span className="ws-ed__saved" data-state="unsaved" role="status">
        <span className="ws-ed__dot" aria-hidden="true" />
        {t("variant.ws.editor.unsaved")}
      </span>
    );
  // 아직 이 화면에서 저장한 적도 고친 적도 없으면 아무것도 보이지 않는다 (지금 글이 저장된 글이다)
  if (!api.savedAt) return null;
  return (
    <span className="ws-ed__saved" data-state="saved" role="status">
      <Icon name="check" size={14} />
      {tf("variant.ws.editor.savedAt", { at: clock(api.savedAt) })}
    </span>
  );
}

// ── 확인 대화상자 ──

interface ConfirmProps {
  titleId: string;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** 되돌릴 수 없는(글이 사라지는) 일 — 분홍 단추 · 취소에 먼저 포커스 */
  danger?: boolean;
  /** 일하는 중 — 단추 잠금, Esc 로 닫지 않음 */
  busy?: boolean;
  /** 이유 · 결과 줄 (대화상자 안에 띠로) */
  problem?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 확인 대화상자 — 포커스를 안에 가두고 Esc 로 닫는다 (작업 공간 `Dialog` 틀) */
export function ConfirmDialog({ titleId, title, children, confirmLabel, cancelLabel, danger = false, busy = false, problem, onConfirm, onCancel }: ConfirmProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  return (
    <Dialog titleId={titleId} onClose={onCancel} busy={busy} initialFocus={() => (danger ? cancel.current : confirm.current)}>
      <header className="ws-dlg__head">
        <h2 id={titleId} className="ws-dlg__title">
          {title}
        </h2>
      </header>
      <div className="ws-dlg__body ed-dlg__body">
        {children}
        {problem && (
          <p className="ws-dlg__error" role="alert">
            {problem}
          </p>
        )}
      </div>
      <footer className="ws-dlg__foot">
        <span className="ws-dlg__foot-note" />
        <button ref={cancel} type="button" className="ws-btn" disabled={busy} onClick={onCancel}>
          {cancelLabel ?? t("variant.ui.cancel")}
        </button>
        <button ref={confirm} type="button" className={`ws-btn ${danger ? "ws-btn--danger" : "ws-btn--primary"}`} disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </footer>
    </Dialog>
  );
}
