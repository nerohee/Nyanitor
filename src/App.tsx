import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { NavPlace } from "./components/nav/AppNav";
import Home from "./home/Home";
import { ipc } from "./lib/ipc";
import { selectPending, startSessionStore, useSessionStore } from "./workspace/chat/sessionStore";
import { wantsHarnessLab, wantsSessionLab } from "./lab/query";
import { wantsVariantFrame } from "./variants/query";

// 작업 공간 — 편집기(CodeMirror) · 미리보기가 무거워 따로 불러온다. 첫 화면(고양이 집)은 그만큼 가볍게 뜬다.
const Workspace = lazy(() => import("./workspace/Workspace"));

// 내 수정 (P9-02) — 편집기(CodeMirror)를 쓰므로 같은 이유로 따로 불러온다.
const EditScreen = lazy(() => import("./edit/EditScreen"));

// 시안 틀 (P2) — 주소에 ?variant= 나 ?screen= 이 있을 때만 불러온다. 개발 빌드에서만 (D-55) — 출시 빌드에서는 아래 시험 화면처럼 통째로 지워진다.
const VariantFrame = import.meta.env.DEV ? lazy(() => import("./variants/VariantFrame")) : null;

// Claude 연결 시험 화면 (P3-02) — 개발 빌드에서만. `import.meta.env.DEV` 가 출시 빌드에서 `false` 로 바뀌어
// 이 줄과 아래 분기가 통째로 지워진다 (출시 빌드에는 시험 화면 코드가 들어가지 않는다).
const SessionLab = import.meta.env.DEV ? lazy(() => import("./lab/SessionLab")) : null;
// 하네스 설치 시험 화면 (P4-02) — 같은 방식으로 개발 빌드에서만.
const HarnessLab = import.meta.env.DEV ? lazy(() => import("./lab/HarnessLab")) : null;

/**
 * 실제 화면 셋(고양이 집 · 작업 공간 · 내 수정)은 주소가 아니라 앱 상태로 바꾼다 — Tauri 창에는 주소창이 없다. 라우터 라이브러리는 쓰지 않는다.
 * 고른 프로젝트(`projectId`)는 화면을 오가도 남는다. `openNew` 는 고양이 집의 새 프로젝트 단추로 들어왔을 때 새 프로젝트 창을 바로 연다.
 */
interface View {
  place: NavPlace;
  projectId: number | null;
  openNew: boolean;
  /** 작업 공간을 열 때 먼저 보일 탭 (집의 정보 패널 단추) — 없으면 채팅 */
  tab: "progress" | "chat" | null;
  /** 숨었던 창이 다시 열려 기다리는 카드로 가는 요청 (`n` 이 바뀔 때마다) — 다른 곳으로 가면 잊는다 */
  reopen: { n: number; projectId: number } | null;
  /** 「내 수정」을 고양이 고르기로 열 때 고를 에이전트 (집의 정보 패널 「고양이 바꾸기」) — 다른 곳으로 가면 잊는다 */
  pick: string | null;
}

function App() {
  const search = window.location.search;
  const [view, setView] = useState<View>({ place: "house", projectId: null, openNew: false, tab: null, reopen: null, pick: null });
  // 세션 이벤트는 앱이 켜질 때 한 번만 듣는다 — 고양이 집 · 작업 공간을 오가도 끊기지 않고 대화 · 기다리는 카드가 쌓인다
  useEffect(() => {
    void startSessionStore();
  }, []);
  // 숨었던(트레이 · 최소화) 창이 다시 열리면 — 답을 기다리는 카드가 있는 프로젝트의 채팅 탭으로 (D-25 · D-50). 카드가 없으면 그대로.
  // 시안 틀 · 시험 화면에서는 듣지 않는다. 해제가 늦게 와도(StrictMode) 두 번 붙지 않게 한다.
  useEffect(() => {
    if (wantsSessionLab(search) || wantsHarnessLab(search) || wantsVariantFrame(search)) return;
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void ipc
      .onWindowShown(() => {
        const state = useSessionStore.getState();
        if (!state.session || selectPending(state.session.projectId)(state) === 0) return;
        const projectId = state.session.projectId;
        setView((prev) => {
          const reopen = { n: (prev.reopen?.n ?? 0) + 1, projectId };
          return prev.place === "workspace" ? { ...prev, reopen } : { place: "workspace", projectId, openNew: false, tab: "chat", reopen, pick: null };
        });
      })
      .then((off) => {
        if (stopped) off();
        else unlisten = off;
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [search]);
  // 화면(집 · 작업 공간 · 내 수정)을 바꾸면 뿌리가 통째로 바뀌어 포커스가 body 로 빠진다 — 새 화면의 제목으로 옮겨 화면 읽기가 바뀐 것을 알게 한다.
  // 처음 켤 때 · 창을 다시 열어 카드로 옮겨질 때(D-25, 카드가 포커스를 가져간다)는 건드리지 않고, 이미 다른 곳에 포커스가 있으면(대화상자 등) 빼앗지 않는다.
  const shownPlace = useRef(view.place);
  useEffect(() => {
    if (shownPlace.current === view.place) return;
    shownPlace.current = view.place;
    if (view.reopen) return;
    let tries = 0;
    let frame = 0;
    // 새 덩이를 불러오는 동안 React 가 옛 화면을 display:none 으로 숨겨 둔다 — 숨은 곳의 포커스 · 제목은 없는 것으로 본다
    const hidden = (el: Element) => el.closest('[style*="display: none"]') !== null;
    const attempt = () => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected && !hidden(active)) return;
      const heading = Array.from(document.querySelectorAll<HTMLElement>("h1")).find((el) => !hidden(el));
      if (heading) {
        heading.focus();
        return;
      }
      // 작업 공간 · 내 수정은 따로 불러오는 덩이라 제목이 늦게 나온다
      if (++tries < 120) frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [view.place, view.reopen]);
  if (SessionLab && wantsSessionLab(search)) {
    return (
      <Suspense fallback={null}>
        <SessionLab />
      </Suspense>
    );
  }
  if (HarnessLab && wantsHarnessLab(search)) {
    return (
      <Suspense fallback={null}>
        <HarnessLab />
      </Suspense>
    );
  }
  if (VariantFrame && wantsVariantFrame(search)) {
    return (
      <Suspense fallback={null}>
        <VariantFrame search={search} />
      </Suspense>
    );
  }
  if (view.place === "edit") {
    return (
      <Suspense fallback={null}>
        <EditScreen startPick={view.pick ?? undefined} onGo={(place) => setView((prev) => ({ ...prev, place, openNew: false, tab: null, reopen: null, pick: null }))} />
      </Suspense>
    );
  }
  if (view.place === "workspace") {
    return (
      <Suspense fallback={null}>
        <Workspace
          projectId={view.projectId}
          openNew={view.openNew}
          openTab={view.tab ?? undefined}
          reopen={view.reopen}
          onSelect={(projectId) => setView((prev) => ({ ...prev, projectId, openNew: false }))}
          onGo={(place) => setView((prev) => ({ ...prev, place, openNew: false, tab: null, reopen: null, pick: null }))}
        />
      </Suspense>
    );
  }
  return (
    <Home
      onGo={(place) => setView((prev) => ({ ...prev, place, openNew: false, tab: null, reopen: null, pick: null }))}
      onOpenProject={(projectId) => setView({ place: "workspace", projectId, openNew: false, tab: null, reopen: null, pick: null })}
      onOpenWork={(projectId, tab) => setView({ place: "workspace", projectId, openNew: false, tab, reopen: null, pick: null })}
      onNewProject={() => setView((prev) => ({ ...prev, place: "workspace", openNew: true, tab: null, reopen: null, pick: null }))}
      onChangeCat={(agent) => setView((prev) => ({ ...prev, place: "edit", openNew: false, tab: null, reopen: null, pick: agent }))}
    />
  );
}

export default App;
