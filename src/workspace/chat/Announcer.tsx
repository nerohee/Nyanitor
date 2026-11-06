// 새 카드가 와서 답을 기다리거나 턴이 끝나 먹물이 답하면 화면 읽기 프로그램에 알린다 (포커스는 옮기지 않는다). 좁은 창에서 채팅 탭이 숨어 있어도 들리도록 작업 공간 맨 위에 둔다.
import { useEffect, useRef, useState } from "react";
import { t, tf } from "../../i18n/ko";
import { selectPending, useSessionStore } from "./sessionStore";

export function PendingAnnouncer() {
  const count = useSessionStore((state) => (state.session ? selectPending(state.session.projectId)(state) : 0));
  const answered = useSessionStore((state) => state.answeredTurns);
  const [text, setText] = useState("");
  const before = useRef(0);
  const answeredBefore = useRef(answered);
  useEffect(() => {
    setText(count > before.current ? tf("ws.chat.announce", { n: count }) : "");
    before.current = count;
  }, [count]);
  // 턴이 끝나 먹물이 답했다 — 기록을 불러올 때는 오르지 않는다
  useEffect(() => {
    if (answered > answeredBefore.current) setText(t("ws.chat.answered"));
    answeredBefore.current = answered;
  }, [answered]);
  return (
    <p className="ws-sr" role="status">
      {text}
    </p>
  );
}
