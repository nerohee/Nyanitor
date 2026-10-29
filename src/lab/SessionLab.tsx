// Claude 연결 시험 화면 (P3-02) — 개발 빌드 전용, 주소 `?lab=session`. 디자인 없음. 진짜 채팅 · 작업 공간 화면은 P6.
// 찾기 결과 · 등록된 프로젝트 고르기(P6-02 — 경로를 글자로 보내는 길은 없다, D-47) · 시작 / 보내기 / 중단 / 끝내기 / 이어 하기 ·
// 이벤트 목록 · 권한 카드 · 질문 카드 · 원본 로그. 화면은 `ipc.ts` 의 함수만 쓴다.
import { useCallback, useEffect, useReducer, useState, type FormEvent, type ReactNode } from "react";
import { t, tf } from "../i18n/ko";
import { AppError, ipc, toAppError, type ClaudeResponse, type ClaudeStatus, type ProjectEntry } from "../lib/ipc";
import { PermissionCardLab, QuestionCardLab } from "./LabCards";
import { initialLabState, labReducer } from "./state";
import "./lab.css";

/** 브라우저(Tauri 밖)인가 — 가짜 세션으로 돈다는 안내를 보인다 */
function isBrowserFake(): boolean {
  return typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function StatusPanel({
  status,
  checking,
  onRecheck,
  onLogin,
}: {
  status: ClaudeStatus | null;
  checking: boolean;
  onRecheck: () => void;
  onLogin: () => void;
}) {
  const yesNo = (value: boolean | null) =>
    value === null ? t("lab.status.unknown") : value ? t("lab.status.yes") : t("lab.status.no");
  return (
    <section aria-labelledby="lab-status">
      <h2 id="lab-status">{t("lab.status.title")}</h2>
      {status === null && <p>{t("lab.status.checking")}</p>}
      {status && !status.found && <p role="status">{t("lab.status.notFound")}</p>}
      {status?.found && (
        <dl className="lab-facts">
          <Fact label={t("lab.status.path")}>
            <code>{status.path}</code>
          </Fact>
          <Fact label={t("lab.status.version")}>
            {status.version ?? t("lab.status.versionFailed")}
            {status.versionMatches === true && <span className="lab-note"> — {t("lab.status.versionSame")}</span>}
            {status.versionMatches === false && (
              <span className="lab-note"> — {tf("lab.status.versionDiff", { known: status.knownVersion })}</span>
            )}
          </Fact>
          <Fact label={t("lab.status.loggedIn")}>{yesNo(status.loggedIn)}</Fact>
          <Fact label={t("lab.status.method")}>{status.authMethod ?? t("lab.none")}</Fact>
          <Fact label={t("lab.status.plan")}>{status.subscriptionType ?? t("lab.none")}</Fact>
          <Fact label={t("lab.status.apiKey")}>
            {status.apiKeyPresent ? t("lab.status.apiKeyYes") : t("lab.status.apiKeyNo")}
          </Fact>
          <Fact label={t("lab.status.otherBilling")}>
            {status.otherBilling.length > 0
              ? tf("lab.status.otherBillingYes", { names: status.otherBilling.join(", ") })
              : t("lab.status.otherBillingNo")}
          </Fact>
        </dl>
      )}
      <div className="lab-row">
        <button type="button" disabled={checking} onClick={onRecheck}>
          {t("lab.status.recheck")}
        </button>
        {status?.found && status.loggedIn === false && (
          <button type="button" onClick={onLogin}>
            {t("lab.status.login")}
          </button>
        )}
      </div>
    </section>
  );
}

export default function SessionLab() {
  const [state, dispatch] = useReducer(labReducer, initialLabState);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [checking, setChecking] = useState(true);
  /** 등록된 프로젝트 (아직 못 불렀으면 null) */
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [useApiKey, setUseApiKey] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<AppError | null>(null);

  /** 명령을 부르고, 실패하면 오류 종류에 맞는 문구를 보인다 */
  const run = useCallback(async (work: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await work();
      return true;
    } catch (raw) {
      setError(toAppError(raw));
      return false;
    }
  }, []);

  /** 등록된 프로젝트 목록을 다시 부른다. `select` 가 있으면 그 프로젝트를 고른다 (방금 등록한 것) */
  const loadProjects = useCallback(async (select?: number) => {
    const list = await ipc.projectsList();
    setProjects(list.projects);
    setProjectId((current) => select ?? (current !== null && list.projects.some((project) => project.id === current) ? current : null));
  }, []);

  const recheck = async () => {
    setChecking(true);
    await run(async () => setStatus(await ipc.claudeDiscover()));
    setChecking(false);
  };

  // 이벤트를 먼저 듣기 시작하고, 그다음 지금 상태를 가져와 맞춘다 (화면을 다시 열어도 카드가 살아난다)
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    void ipc.onClaudeEvent((event) => dispatch({ type: "event", event })).then(async (unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      stop = unlisten;
      try {
        const [current, raw] = await Promise.all([ipc.claudeSessionState(), ipc.claudeRawLog()]);
        if (cancelled) return;
        dispatch({ type: "restore", state: current });
        dispatch({ type: "raw", entries: raw });
        if (current.projectId !== null) setProjectId(current.projectId);
      } catch (raw) {
        if (!cancelled) setError(toAppError(raw));
      }
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // 등록된 프로젝트 목록 (고르기용)
  useEffect(() => {
    let cancelled = false;
    ipc.projectsList().then(
      (list) => {
        if (cancelled) return;
        setProjects(list.projects);
        setProjectId((current) => (current !== null && list.projects.some((project) => project.id === current) ? current : null));
      },
      (raw: unknown) => {
        if (cancelled) return;
        setProjects([]);
        setError(toAppError(raw));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // 화면이 처음 뜰 때 한 번 찾는다
  useEffect(() => {
    let cancelled = false;
    ipc.claudeDiscover().then(
      (found) => {
        if (cancelled) return;
        setStatus(found);
        setChecking(false);
      },
      (raw: unknown) => {
        if (cancelled) return;
        setError(toAppError(raw));
        setChecking(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // 고른 프로젝트가 바뀌면 그 프로젝트의 마지막 세션이 있는지 본다 (이어 하기 단추). 폴더가 없어진 프로젝트면 없음으로 둔다.
  useEffect(() => {
    let cancelled = false;
    const id = projectId;
    const timer = window.setTimeout(() => {
      if (id === null) {
        setSaved(null);
        return;
      }
      ipc.claudeLastSession(id).then(
        (id) => !cancelled && setSaved(id),
        () => !cancelled && setSaved(null),
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectId, state.running, state.sessionId]);

  /** 등록된 프로젝트 번호로만 시작한다 — 경로 · 모델 · 수준은 보내지 않는다 (Rust 가 정한다) */
  const start = (resume: boolean) => {
    if (projectId === null) return Promise.resolve(false);
    return run(() => ipc.claudeSessionStart({ projectId, resume, useApiKey }));
  };

  /** 폴더 고르기 창(Rust) → 고른 폴더 등록 → 목록에서 그 프로젝트를 고른다. 취소면 아무것도 안 한다 */
  const addProject = async () => {
    setPicking(true);
    setNotice(null);
    await run(async () => {
      const picked = await ipc.projectPickFolder();
      if (picked === null) return;
      if (picked.state === "forbidden") {
        setNotice(tf("lab.session.pickForbidden", { reason: picked.reason }));
        return;
      }
      const added = await ipc.projectAdd();
      await loadProjects(added.id);
    });
    setPicking(false);
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = message;
    if (await run(() => ipc.claudeSessionSend(text))) setMessage("");
  };

  const respond = async (requestId: string, response: ClaudeResponse) => {
    if (await run(() => ipc.claudeSessionRespond(requestId, response))) {
      dispatch({ type: "cardAnswered", requestId });
    } else {
      // 이미 답했거나 취소된 요청이면 카드를 닫는다
      const current = await ipc.claudeSessionState().catch(() => null);
      if (current) dispatch({ type: "restore", state: current });
    }
  };

  return (
    <main className="lab-session" data-testid="session-lab">
      <header>
        <p>
          <a href="./">{t("lab.back")}</a>
        </p>
        <h1>{t("lab.title")}</h1>
        <p className="lab-note">{t("lab.note")}</p>
        {isBrowserFake() && <p className="lab-note">{t("lab.fakeMode")}</p>}
      </header>

      {error && (
        <p role="alert" className="lab-error">
          {t(`error.${error.kind}`)}
        </p>
      )}

      <StatusPanel
        status={status}
        checking={checking}
        onRecheck={() => void recheck()}
        onLogin={() => void run(() => ipc.claudeOpenLogin())}
      />

      <section aria-labelledby="lab-session">
        <h2 id="lab-session">{t("lab.session.title")}</h2>
        <label className="lab-field">
          {t("lab.session.project")}
          <select
            value={projectId === null ? "" : String(projectId)}
            disabled={state.running || projects === null || projects.length === 0}
            onChange={(event) => setProjectId(event.target.value === "" ? null : Number(event.target.value))}
          >
            <option value="">{t("lab.session.projectPick")}</option>
            {(projects ?? []).map((project) => (
              <option key={project.id} value={String(project.id)}>
                {project.folder === "missing" ? tf("lab.session.projectGone", { name: project.name }) : project.name}
              </option>
            ))}
          </select>
        </label>
        {projects !== null && projects.length === 0 && (
          <p role="status" className="lab-note">
            {t("lab.session.noProjects")}
          </p>
        )}
        {notice && (
          <p role="status" className="lab-note">
            {notice}
          </p>
        )}
        <div className="lab-row">
          <button type="button" disabled={state.running || picking} onClick={() => void addProject()}>
            {t("lab.session.addProject")}
          </button>
        </div>
        <label className="lab-option">
          <input
            type="checkbox"
            checked={useApiKey}
            disabled={state.running}
            onChange={(event) => setUseApiKey(event.target.checked)}
          />
          {t("lab.session.useKey")}
        </label>
        <div className="lab-row">
          <button type="button" disabled={state.running || projectId === null} onClick={() => void start(false)}>
            {t("lab.session.start")}
          </button>
          <button
            type="button"
            disabled={state.running || projectId === null || saved === null}
            onClick={() => void start(true)}
          >
            {t("lab.session.resume")}
          </button>
          <button type="button" disabled={!state.running} onClick={() => void run(() => ipc.claudeSessionInterrupt())}>
            {t("lab.session.interrupt")}
          </button>
          <button type="button" disabled={!state.running} onClick={() => void run(() => ipc.claudeSessionStop())}>
            {t("lab.session.stop")}
          </button>
        </div>
        <dl className="lab-facts">
          <Fact label={t("lab.session.state")}>
            {state.running ? t("lab.session.running") : t("lab.session.stopped")}
            {state.running && <> · {state.busy ? t("lab.session.busy") : t("lab.session.idle")}</>}
          </Fact>
          <Fact label={t("lab.session.modelEffort")}>
            {state.running && state.planner
              ? `${state.planner.model ?? t("lab.session.cliDefault")} · ${state.planner.effort ?? t("lab.session.cliDefault")}`
              : t("lab.none")}
          </Fact>
          <Fact label={t("lab.session.id")}>{state.sessionId ?? t("lab.none")}</Fact>
          <Fact label={t("lab.session.saved")}>{saved ?? t("lab.session.none")}</Fact>
        </dl>
        {state.resumeNotFound && (
          <div role="alert" className="lab-row">
            <span>{t("lab.resumeMissing")}</span>
            <button
              type="button"
              disabled={state.running}
              onClick={() => {
                dispatch({ type: "dismissResumeNotFound" });
                void start(false);
              }}
            >
              {t("lab.resumeMissing.fresh")}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="lab-message">
        <h2 id="lab-message">{t("lab.message.title")}</h2>
        <form className="lab-row" onSubmit={(event) => void send(event)}>
          <input
            type="text"
            aria-label={t("lab.message.input")}
            value={message}
            disabled={!state.running}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button type="submit" disabled={!state.running || state.busy || message.trim() === ""}>
            {t("lab.message.send")}
          </button>
        </form>
        {isBrowserFake() && <p className="lab-note">{t("lab.message.hint")}</p>}
      </section>

      <section aria-labelledby="lab-cards">
        <h2 id="lab-cards">{t("lab.cards.title")}</h2>
        {state.cards.length === 0 && <p className="lab-note">{t("lab.cards.empty")}</p>}
        {state.cards.map((card) =>
          card.kind === "permission" ? (
            <PermissionCardLab key={card.info.requestId} info={card.info} onRespond={respond} />
          ) : (
            <QuestionCardLab key={card.info.requestId} info={card.info} onRespond={respond} />
          ),
        )}
      </section>

      <section aria-labelledby="lab-events">
        <h2 id="lab-events">{t("lab.events.title")}</h2>
        {state.lines.length === 0 ? (
          <p className="lab-note">{t("lab.events.empty")}</p>
        ) : (
          <ol className="lab-events">
            {state.lines.map((line) => (
              <li key={line.id} data-type={line.type}>
                {line.text}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="lab-raw">
        <details>
          <summary id="lab-raw">{t("lab.raw.title")}</summary>
          {state.raw.length === 0 ? (
            <p className="lab-note">{t("lab.raw.empty")}</p>
          ) : (
            <div className="lab-raw">
              {state.raw.map((entry) => (
                <div key={entry.seq}>
                  <strong>{tf("lab.raw.line", { dir: entry.dir, seq: entry.seq, cut: entry.truncated ? " …" : "" })}</strong> {entry.text}
                </div>
              ))}
            </div>
          )}
        </details>
      </section>
    </main>
  );
}
