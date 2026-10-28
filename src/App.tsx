import { lazy, Suspense } from "react";
import Home from "./home/Home";
import { wantsHarnessLab, wantsSessionLab } from "./lab/query";
import { wantsVariantFrame } from "./variants/query";

// 시안 틀 (P2) — 주소에 ?variant= 나 ?screen= 이 있을 때만 불러온다. 시안을 고른 뒤 이 연결은 지운다.
const VariantFrame = lazy(() => import("./variants/VariantFrame"));

// Claude 연결 시험 화면 (P3-02) — 개발 빌드에서만. `import.meta.env.DEV` 가 출시 빌드에서 `false` 로 바뀌어
// 이 줄과 아래 분기가 통째로 지워진다 (출시 빌드에는 시험 화면 코드가 들어가지 않는다).
const SessionLab = import.meta.env.DEV ? lazy(() => import("./lab/SessionLab")) : null;
// 하네스 설치 시험 화면 (P4-02) — 같은 방식으로 개발 빌드에서만.
const HarnessLab = import.meta.env.DEV ? lazy(() => import("./lab/HarnessLab")) : null;

function App() {
  const search = window.location.search;
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
  return <Home />;
}

export default App;
