// 대화상자 틀 — 포커스를 안에 가두고, Esc 로 닫고, 닫으면 연 단추로 포커스를 돌려준다 (시제품 새 프로젝트 창과 같다).
// 연 단추가 그사이 사라졌으면(예: "프로젝트 없음" 의 새 프로젝트 단추) `fallbackFocus()` 가 돌려주는 곳으로.
// 키는 문서 전체에서 듣는다 — 안에서 포커스를 받은 단추가 사라져(예: 확인 단계로 바뀜) 포커스가 body 로 빠져도 Esc · Tab 이 듣는다.
import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  titleId: string;
  onClose: () => void;
  /** 열릴 때 포커스를 줄 칸 (없으면 안의 첫 조작 대상) */
  initialFocus?: () => HTMLElement | null;
  fallbackFocus?: () => HTMLElement | null;
  /** 일하는 중에는 Esc 로 닫지 않는다 */
  busy?: boolean;
  children: ReactNode;
}

export function Dialog({ titleId, onClose, initialFocus, fallbackFocus, busy = false, children }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const fallbackRef = useRef(fallbackFocus);
  const busyRef = useRef(busy);
  useEffect(() => {
    closeRef.current = onClose;
    fallbackRef.current = fallbackFocus;
    busyRef.current = busy;
  });

  // 열릴 때: 연 단추를 기억하고 안으로 포커스. 닫힐 때: 돌려준다
  useEffect(() => {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    const first = initialFocus?.() ?? box.current?.querySelector<HTMLElement>(FOCUSABLE) ?? box.current;
    first?.focus();
    return () => {
      const target = opener && opener.isConnected ? opener : fallbackRef.current?.();
      target?.focus();
    };
    // 열릴 때 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc 로 닫기 · Tab 은 안에서만 돈다
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const dialog = box.current;
      if (!dialog) return;
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busyRef.current) closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="ws-dlg__scrim">
      <div className="ws-dlg" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
