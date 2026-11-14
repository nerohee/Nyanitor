// 입력줄 — 여러 줄 글 칸 (Enter 보내기 · Shift+Enter 줄바꿈 · 한글 조합 중 Enter 는 보내지 않는다), 빈 칸에서 `/` 로 스킬 고르기,
// 일하는 중이면 중단 단추(확인 한 번 → `claudeSessionInterrupt`). 일하는 중에 보낸 말은 이번 턴이 끝난 뒤 전해진다 ("다음 차례에 전해져요" 표시).
import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { t } from "../../i18n/ko";
import { Icon } from "../../variants/shared/icons";
import { chatErrorKindText, chatErrorText } from "./errors";
import { SkillPicker, withSkill } from "./SkillPicker";
import { cancelQueued, isTrustDeclined, takeDraftBack, useSessionStore } from "./sessionStore";
import type { SkillChoicesState } from "./useChatEnv";

export interface ComposerHandle {
  /** 스킬 고르기를 연다 (빈 상태의 "스킬 고르기" 단추) */
  openSkills: () => void;
  /** 글 칸에 포커스 (카드에 답한 뒤 기다리는 카드가 없을 때) */
  focus: () => void;
}

interface Props {
  ref?: Ref<ComposerHandle>;
  projectId: number;
  skills: SkillChoicesState;
  /** 턴이 도는 중 (일하는 중 · 답을 기다리는 중) */
  busy: boolean;
  /** 답을 기다리는 카드가 있다 */
  waiting: boolean;
  onSend: (text: string) => Promise<"sent" | "queued">;
  onInterrupt: () => Promise<void>;
}

const QUEUED_SHOWN_MAX = 80;

export function Composer({ ref, projectId, skills, busy, waiting, onSend, onInterrupt }: Props) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ open: boolean; by: "input" | "button" }>({ open: false, by: "button" });
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const composing = useRef(false);
  const queued = useSessionStore((state) => (state.queued && state.queued.projectId === projectId ? state.queued.text : null));
  const queueError = useSessionStore((state) => state.queueError);
  const draftBack = useSessionStore((state) => (state.draftBack && state.draftBack.projectId === projectId ? state.draftBack.text : null));

  useImperativeHandle(
    ref,
    () => ({
      openSkills: () => setPicker({ open: true, by: "button" }),
      focus: () => input.current?.focus({ preventScroll: true }),
    }),
    [],
  );

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  // 세션이 끝나 못 보낸 말은 글 칸으로 돌려받는다 (칸이 비어 있을 때만 — 쓰던 글을 덮지 않는다)
  useEffect(() => {
    if (draftBack === null) return;
    const id = setTimeout(() => {
      const back = takeDraftBack(projectId);
      if (back !== null) setText((now) => (now.trim() === "" ? back : `${back}\n\n${now}`));
    }, 0);
    return () => clearTimeout(id);
  }, [draftBack, projectId]);
  // 일이 끝나면 중단 확인은 닫는다 (렌더 중에 맞춘다)
  if (!busy && confirming) setConfirming(false);

  const focusInput = () => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  const send = async () => {
    const value = text.trim();
    if (value === "" || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(value);
      setText("");
    } catch (raw) {
      // 폴더 설정 확인에서 취소 — 오류가 아니다 (쓴 글은 그대로)
      if (!isTrustDeclined(raw)) setError(chatErrorText(raw));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 한글 조합 중 Enter 는 글자를 확정하는 것이지 보내는 것이 아니다 (keyCode 229 = 조합 중 키)
    const isComposing = composing.current || event.nativeEvent.isComposing || event.keyCode === 229;
    if (event.key === "/" && text === "" && !isComposing) {
      event.preventDefault();
      setPicker({ open: true, by: "input" });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !isComposing) {
      event.preventDefault();
      void send();
    }
  };

  const takeBack = () => {
    const back = cancelQueued();
    if (back) setText((now) => (now.trim() === "" ? back.text : `${back.text}\n\n${now}`));
    focusInput();
  };

  const placeholder = t(busy ? (waiting ? "ws.chat.placeholderWaiting" : "variant.ws.chat.placeholderWorking") : "variant.ws.chat.placeholder");

  return (
    <form className="wc-composer" onSubmit={(event) => (event.preventDefault(), void send())}>
      {confirming && (
        <div
          className="wc-stop"
          role="alertdialog"
          aria-labelledby="wc-stop-title"
          aria-describedby="wc-stop-body"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setConfirming(false);
              stopRef.current?.focus();
            }
          }}
        >
          <p id="wc-stop-title" className="wc-stop__title">
            {t("variant.ws.stop.title")}
          </p>
          <p id="wc-stop-body" className="wc-stop__body">
            {t("ws.chat.stop.body")}
          </p>
          <div className="wc-stop__actions">
            <button
              ref={confirmRef}
              type="button"
              className="ws-btn ws-btn--danger"
              onClick={() => {
                setConfirming(false);
                void onInterrupt().catch((raw: unknown) => setError(chatErrorText(raw)));
                stopRef.current?.focus();
              }}
            >
              <Icon name="stop" size={16} />
              {t("variant.ws.stop.go")}
            </button>
            <button
              type="button"
              className="ws-btn"
              onClick={() => {
                setConfirming(false);
                stopRef.current?.focus();
              }}
            >
              {t("variant.ws.stop.keep")}
            </button>
          </div>
        </div>
      )}
      {queued !== null && (
        <p className="wc-queued" role="status">
          <Icon name="clock" size={14} />
          <span className="wc-queued__text">
            {t("ws.chat.queued")} <q>{queued.length > QUEUED_SHOWN_MAX ? `${queued.slice(0, QUEUED_SHOWN_MAX)}…` : queued}</q>
          </span>
          <button type="button" className="ws-btn ws-btn--small ws-btn--ghost" onClick={takeBack}>
            {t("ws.chat.queued.cancel")}
          </button>
        </p>
      )}
      {queueError && (
        <p className="wc-card__error" role="alert">
          <Icon name="alert" size={16} />
          {t("ws.chat.queued.failed")} {chatErrorKindText(queueError)}
        </p>
      )}
      <textarea
        ref={input}
        className="wc-composer__input"
        rows={2}
        value={text}
        aria-label={t("variant.ws.chat.input")}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
      />
      {error && (
        <p className="wc-card__error" role="alert">
          <Icon name="alert" size={16} />
          {t("ws.chat.sendFailed")} {error}
        </p>
      )}
      <div className="wc-composer__row">
        <SkillPicker
          skills={skills}
          open={picker.open}
          openedBy={picker.by}
          onOpenChange={(open, by) => setPicker((now) => ({ open, by: by ?? now.by }))}
          onPick={(skill) => {
            setText((now) => withSkill(now, skill.command));
            // 글 칸이 다시 그려진 뒤 초점
            setTimeout(focusInput, 0);
          }}
          onClosed={focusInput}
        />
        <span className="wc-composer__keys" aria-hidden="true">
          {t("variant.ws.chat.keys")}
        </span>
        <span className="wc-composer__spacer" />
        {busy && (
          <button ref={stopRef} type="button" className="ws-btn wc-composer__stop" aria-expanded={confirming} onClick={() => setConfirming(true)}>
            <Icon name="stop" size={16} />
            {t("variant.ws.chat.stop")}
          </button>
        )}
        <button type="submit" className="ws-btn ws-btn--primary wc-composer__send" disabled={text.trim() === "" || sending}>
          <Icon name="send" size={16} />
          {t("variant.ws.chat.send")}
        </button>
      </div>
    </form>
  );
}
