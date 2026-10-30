import { lazy, Suspense, useState } from "react";
import type { NavPlace } from "./components/nav/AppNav";
import Home from "./home/Home";
import { wantsHarnessLab, wantsSessionLab } from "./lab/query";
import { wantsVariantFrame } from "./variants/query";

// 작업 공간 — 편집기(CodeMirror) · 미리보기가 무거워 따로 불러온다. 첫 화면(고양이 집)은 그만큼 가볍게 뜬다.
const Workspace = lazy(() => import("./workspace/Workspace"));

// 시안 틀 (P2) — 주소에 ?variant= 나 ?screen= 이 있을 때만 불러온다. 시안을 고른 뒤 이 연결은 지운다.
const VariantFrame = lazy(() => import("./variants/VariantFrame"));

// Claude 연결 시험 화면 (P3-02) — 개발 빌드에서만. `import.meta.env.DEV` 가 출시 빌드에서 `false` 로 바뀌어
// 이 줄과 아래 분기가 통째로 지워진다 (출시 빌드에는 시험 화면 코드가 들어가지 않는다).
const SessionLab = import.meta.env.DEV ? lazy(() => import("./lab/SessionLab")) : null;
// 하네스 설치 시험 화면 (P4-02) — 같은 방식으로 개발 빌드에서만.
const HarnessLab = import.meta.env.DEV ? lazy(() => import("./lab/HarnessLab")) : null;

/**
 * 실제 화면 둘(고양이 집 · 작업 공간)은 주소가 아니라 앱 상태로 바꾼다 — Tauri 창에는 주소창이 없다. 라우터 라이브러리는 쓰지 않는다.
 * 고른 프로젝트(`projectId`)는 화면을 오가도 남는다. `openNew` 는 고양이 집의 새 프로젝트 단추로 들어왔을 때 새 프로젝트 창을 바로 연다.
 */
interface View {
  place: NavPlace;
  projectId: number | null;
  openNew: boolean;
}

function App() {
  const search = window.location.search;
  const [view, setView] = useState<View>({ place: "house", projectId: null, openNew: false });
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
  if (wantsVariantFrame(search)) {
    return (
      <Suspense fallback={null}>
        <VariantFrame search={search} />
      </Suspense>
    );
  }
  if (view.place === "workspace") {
    return (
      <Suspense fallback={null}>
        <Workspace
          projectId={view.projectId}
          openNew={view.openNew}
          onSelect={(projectId) => setView((prev) => ({ ...prev, projectId, openNew: false }))}
          onGo={(place) => setView((prev) => ({ ...prev, place, openNew: false }))}
        />
      </Suspense>
    );
  }
  return (
    <Home
      onGo={(place) => setView((prev) => ({ ...prev, place, openNew: false }))}
      onOpenProject={(projectId) => setView({ place: "workspace", projectId, openNew: false })}
      onNewProject={() => setView((prev) => ({ ...prev, place: "workspace", openNew: true }))}
    />
  );
}

export default App;
