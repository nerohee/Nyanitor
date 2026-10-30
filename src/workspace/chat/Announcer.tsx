// 새 카드가 와서 답을 기다리면 화면 읽기 프로그램에 알린다 (포커스는 옮기지 않는다). 좁은 창에서 채팅 탭이 숨어 있어도 들리도록 작업 공간 맨 위에 둔다.
import { useEffect, useRef, useState } from "react";
import { tf } from "../../i18n/ko";
import { selectPending, useSessionStore } from "./sessionStore";

export function PendingAnnouncer() {
  const count = useSessionStore((state) => (state.session ? selectPending(state.session.projectId)(state) : 0));
  const [text, setText] = useState("");
  const before = useRef(0);
  useEffect(() => {
    setText(count > before.current ? tf("ws.chat.announce", { n: count }) : "");
    before.current = count;
  }, [count]);
  return (
    <p className="ws-sr" role="status">
      {text}
    </p>
  );
}
