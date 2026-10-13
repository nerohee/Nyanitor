import { lazy, Suspense, useEffect, useState } from "react";
import { AppError, ipc, toAppError, type AppInfo } from "./lib/ipc";
import { t } from "./i18n/ko";
import { wantsVariantFrame } from "./variants/query";

// 시안 틀 (P2) — 주소에 ?variant= 나 ?screen= 이 있을 때만 불러온다. 시안을 고른 뒤 이 연결은 지운다.
const VariantFrame = lazy(() => import("./variants/VariantFrame"));

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
