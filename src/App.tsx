import { lazy, Suspense, useEffect, useState } from "react";
import { AppError, ipc, toAppError, type AppInfo } from "./lib/ipc";
import { t } from "./i18n/ko";
import { wantsSessionLab } from "./lab/query";
import { wantsVariantFrame } from "./variants/query";

// 시안 틀 (P2) — 주소에 ?variant= 나 ?screen= 이 있을 때만 불러온다. 시안을 고른 뒤 이 연결은 지운다.
const VariantFrame = lazy(() => import("./variants/VariantFrame"));

// Claude 연결 시험 화면 (P3-02) — 개발 빌드에서만. `import.meta.env.DEV` 가 출시 빌드에서 `false` 로 바뀌어
// 이 줄과 아래 분기가 통째로 지워진다 (출시 빌드에는 시험 화면 코드가 들어가지 않는다).
const SessionLab = import.meta.env.DEV ? lazy(() => import("./lab/SessionLab")) : null;

type State =
  | { status: "loading" }
  | { status: "ready"; info: AppInfo }
  | { status: "error"; error: AppError };

function MainScreen() {
  const [state, setState] = useState<State>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    ipc.appInfo().then(
      (info) => {
        if (!cancelled) setState({ status: "ready", info });
      },
      (raw: unknown) => {
        if (!cancelled) setState({ status: "error", error: toAppError(raw) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <p>{t("app.placeholder")}</p>
      {/* 개발 빌드에서만: Tauri 창에는 주소창이 없으니 시험 화면으로 가는 링크 (출시 빌드에서는 지워진다) */}
      {import.meta.env.DEV && (
        <p>
          <a href="?lab=session">{t("lab.open")}</a>
        </p>
      )}
      {state.status === "loading" && <p>{t("app.loading")}</p>}
      {state.status === "error" && <p role="alert">{t(`error.${state.error.kind}`)}</p>}
      {state.status === "ready" && (
        <dl>
          <dt>{t("app.nameLabel")}</dt>
          <dd>{state.info.name}</dd>
          <dt>{t("app.versionLabel")}</dt>
          <dd>{state.info.version}</dd>
        </dl>
      )}
    </main>
  );
}

function App() {
  const search = window.location.search;
  if (SessionLab && wantsSessionLab(search)) {
    return (
      <Suspense fallback={null}>
        <SessionLab />
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
  return <MainScreen />;
}

export default App;
