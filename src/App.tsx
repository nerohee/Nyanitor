import { useEffect, useState } from "react";
import { AppError, ipc, toAppError, type AppInfo } from "./lib/ipc";
import { t } from "./i18n/ko";

type State =
  | { status: "loading" }
  | { status: "ready"; info: AppInfo }
  | { status: "error"; error: AppError };

function App() {
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

export default App;
