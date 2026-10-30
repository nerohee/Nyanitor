// 작업 공간의 채팅 판 — 고른 프로젝트에서 오케스트레이터(먹물)와 대화한다 (P6-05).
// 머리(상태 · 모델 · 세션 츄르 · 세션 끝내기) · 목록(`ChatLog`) · 아래 한 칸(입력줄 · 다른 프로젝트에서 도는 중 · 준비 안 됨 · 폴더 없음).
// 모든 상태는 앱 전체 세션 저장소(`sessionStore.ts`)에 있다 — 이 판은 읽어 그리고, 조작을 저장소 함수로 부른다 (화면을 오가도 대화 · 카드가 그대로).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, tf } from "../../i18n/ko";
import { ipc } from "../../lib/ipc";
import type { ProjectEntry } from "../../lib/ipc-types";
import { Icon } from "../../variants/shared/icons";
import { ChatLog } from "./ChatLog";
import { Composer, type ComposerHandle } from "./Composer";
import { chatErrorText } from "./errors";
import { ORCH_CAT, orchName } from "./Lines";
import { pendingCount } from "./model";
import { interrupt, loadChat, loadOlder, newChat, refreshResumable, respond, sendMessage, startChat, stopSession, useSessionStore } from "./sessionStore";
import { useClaudeReady, useSkillList } from "./useChatEnv";
import "./chat.css";

interface Props {
  project: ProjectEntry;
  /** 이름을 보이려고 (다른 프로젝트에서 도는 중) */
  projects: readonly ProjectEntry[];
  /** 다른 프로젝트로 가기 (저장하지 않은 글을 묻는 일은 작업 공간이 한다) */
  onGoProject: (id: number) => void;
}

type Status = "idle" | "working" | "waiting" | "stopped";

/** 한 줄 확인 — 되돌리기 어려운 일 (세션 끝내기 · 다른 세션 끝내고 시작) */
function Confirm({ id, title, body, goLabel, keepLabel, onGo, onKeep }: { id: string; title: string; body: string; goLabel: string; keepLabel: string; onGo: () => void; onKeep: () => void }) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => go.current?.focus(), []);
  return (
    <div
      className="wc-stop wc-stop--head"
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onKeep();
        }
      }}
    >
      <p id={`${id}-title`} className="wc-stop__title">
        {title}
      </p>
      <p id={`${id}-body`} className="wc-stop__body">
        {body}
      </p>
      <div className="wc-stop__actions">
        <button ref={go} type="button" className="ws-btn ws-btn--danger" onClick={onGo}>
          {goLabel}
        </button>
        <button type="button" className="ws-btn" onClick={onKeep}>
          {keepLabel}
        </button>
      </div>
    </div>
  );
}

function modelText(model: string | null, effort: string | null): string {
  if (model === null && effort === null) return t("ws.chat.model.default");
  return `${model ?? t("ws.chat.model.default")} · ${effort ?? t("ws.chat.model.default")}`;
}

export function ChatPane({ project, projects, onGoProject }: Props) {
  const restored = useSessionStore((state) => state.restored);
  const session = useSessionStore((state) => state.session);
  const chat = useSessionStore((state) => state.chats[project.id]) ?? newChat();
  const churros = useSessionStore((state) => state.churros);
  const churrosStale = useSessionStore((state) => state.churrosStale);
  const { ready, recheck } = useClaudeReady();
  const skills = useSkillList();
  const composer = useRef<ComposerHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<null | "starting" | "swapping" | "ending">(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | "end" | "swap">(null);

  const isHere = session?.projectId === project.id;
  const otherId = session && !isHere ? session.projectId : null;
  const otherName = otherId === null ? null : (projects.find((entry) => entry.id === otherId)?.name ?? t("ws.chat.otherUnknown"));
  const lines = chat.data.lines;
  const pending = pendingCount(lines);
  const busy = isHere && session.busy;
  const status: Status = isHere ? (pending > 0 ? "waiting" : busy ? "working" : "idle") : chat.data.halted !== null ? "stopped" : "idle";
  const noSession = session === null;
  const resumable = chat.resumable === true;
  const folderMissing = project.folder === "missing";
  /** Claude 가 없거나 로그인이 안 돼 시작할 수 없다 (돌고 있는 세션이 없을 때) */
  const notReady = noSession && ready.state === "ready" && (!ready.status.found || ready.status.loggedIn === false);

  // 이 프로젝트의 기록 — 처음 상태를 읽은 뒤에 (읽는 동안 온 이벤트는 저장소가 모아 두었다가 잇는다)
  useEffect(() => {
    if (restored) void loadChat(project.id);
  }, [restored, project.id]);
  // 세션이 없을 때 이어 할 대화가 있는지 (세션이 끝날 때마다 다시)
  useEffect(() => {
    if (restored && noSession) void refreshResumable(project.id);
  }, [restored, noSession, project.id]);

  const guard = async (kind: "starting" | "swapping" | "ending", run: () => Promise<unknown>) => {
    setAction(kind);
    setActionError(null);
    try {
      await run();
    } catch (raw) {
      setActionError(chatErrorText(raw));
    } finally {
      setAction(null);
      setConfirm(null);
    }
  };

  const jump = () => {
    const card = root.current?.querySelector<HTMLElement>('[data-pending-card="true"]');
    card?.scrollIntoView?.({ block: "start" });
    card?.focus();
  };

  const startWithSkill = () => {
    if (!project.skill) return;
    void guard("starting", () => sendMessage(project.id, `${project.skill} requirements.md`));
  };

  const swap = () =>
    guard("swapping", async () => {
      await stopSession();
      await startChat(project.id, resumable);
    });

  const headBusy = action !== null;

  const logBody = (() => {
    if (chat.load === "failed") {
      return (
        <div className="wc-state" role="alert">
          <Icon name="alert" size={24} />
          <p>{t("ws.chat.loadFailed")}</p>
          <button type="button" className="ws-btn" onClick={() => void loadChat(project.id)}>
            {t("ws.proj.retry")}
          </button>
        </div>
      );
    }
    if (chat.load !== "ready") {
      return (
        <div className="wc-state" role="status">
          <p>{t("ws.chat.loading")}</p>
        </div>
      );
    }
    if (isHere) {
      return (
        <div className="wc-state">
          <p>{t("ws.chat.readyHint")}</p>
        </div>
      );
    }
    return (
      <div className="wc-empty">
        <p className="wc-empty__title">{t("ws.chat.empty.title")}</p>
        <p className="wc-empty__body">{t("ws.chat.empty.body")}</p>
        {project.skill ? (
          <button type="button" className="ws-btn ws-btn--primary" disabled={headBusy || otherId !== null || folderMissing} onClick={startWithSkill}>
            {tf("ws.chat.empty.start", { skill: project.skill })}
          </button>
        ) : (
          <button type="button" className="ws-btn ws-btn--primary" onClick={() => composer.current?.openSkills()} disabled={otherId !== null || folderMissing}>
            {t("ws.chat.empty.pickSkill")}
          </button>
        )}
      </div>
    );
  })();

  // 입력줄 자리
  let bottom: ReactNode;
  if (otherId !== null) {
    bottom = (
      <div className="wc-block" role="group" aria-label={t("ws.chat.block.label")}>
        <p className="wc-block__text">
          <Icon name="info" size={16} />
          {tf("ws.chat.block.text", { name: otherName ?? "" })}
        </p>
        {confirm === "swap" ? (
          <Confirm
            id="wc-swap"
            title={t("ws.chat.swap.title")}
            body={tf("ws.chat.swap.body", { name: otherName ?? "" })}
            goLabel={t("ws.chat.swap.go")}
            keepLabel={t("ws.chat.swap.keep")}
            onGo={() => void swap()}
            onKeep={() => setConfirm(null)}
          />
        ) : (
          <div className="wc-block__actions">
            <button type="button" className="ws-btn" onClick={() => onGoProject(otherId)}>
              {t("ws.chat.block.go")}
            </button>
            <button type="button" className="ws-btn ws-btn--danger" disabled={headBusy || folderMissing} onClick={() => setConfirm("swap")}>
              {t("ws.chat.block.swap")}
            </button>
          </div>
        )}
      </div>
    );
  } else if (folderMissing) {
    bottom = (
      <p className="wc-block__text wc-block__text--solo" role="status">
        <Icon name="alert" size={16} />
        {t("ws.chat.folderMissing")}
      </p>
    );
  } else if (noSession && ready.state === "ready" && !ready.status.found) {
    bottom = (
      <div className="wc-block" role="status">
        <p className="wc-block__text">
          <Icon name="alert" size={16} />
          {t("ws.chat.notFound")}
        </p>
        <div className="wc-block__actions">
          <button type="button" className="ws-btn" onClick={recheck}>
            {t("ws.chat.recheck")}
          </button>
        </div>
      </div>
    );
  } else if (noSession && ready.state === "ready" && ready.status.loggedIn === false) {
    bottom = (
      <div className="wc-block" role="status">
        <p className="wc-block__text">
          <Icon name="key" size={16} />
          {t("ws.chat.notLoggedIn")}
        </p>
        <div className="wc-block__actions">
          <button type="button" className="ws-btn ws-btn--primary" onClick={() => void ipc.claudeOpenLogin().catch((raw: unknown) => setActionError(chatErrorText(raw)))}>
            {t("ws.chat.login")}
          </button>
          <button type="button" className="ws-btn" onClick={recheck}>
            {t("ws.chat.recheck")}
          </button>
        </div>
      </div>
    );
  } else {
    bottom = (
      <Composer
        ref={composer}
        projectId={project.id}
        skills={skills}
        busy={busy}
        waiting={pending > 0}
        onSend={(text) => sendMessage(project.id, text)}
        onInterrupt={interrupt}
      />
    );
  }

  return (
    <div className="wc" ref={root} data-testid="chat-pane">
      <div className="wc-head" data-state={status}>
        <span className="wc-head__avatar" aria-hidden="true">
          <CatFigure cat={ORCH_CAT} crop="face" />
        </span>
        <b>{orchName()}</b>
        <span className="wc-head__pill" role="status">
          <span className="wc-dot" aria-hidden="true" />
          {t(`ws.chat.status.${status}`)}
        </span>
        <div className="wc-head__tools">
          {pending > 0 && (
            <button type="button" className="ws-btn ws-btn--small" onClick={jump}>
              <Icon name="arrow" size={14} />
              {tf("variant.ws.chat.jumpN", { n: pending })}
            </button>
          )}
          {isHere && session && (
            <span className="wc-head__chip wc-head__chip--mono" title={t("variant.ws.chat.modelHint")}>
              {modelText(chat.data.lastStart?.model ?? null, chat.data.lastStart?.effort ?? null)}
            </span>
          )}
          {isHere && churros && churros.projectId === project.id && (
            <span className="wc-head__chip" title={t(churrosStale ? "ws.chat.churros.stale" : "ws.chat.churros.hint")}>
              {tf("ws.chat.churros", { n: churros.totalTokens.toLocaleString("ko-KR") })}
              {churros.referenceOnly && <span className="wc-head__ref">{t("ws.chat.churros.ref")}</span>}
              {churrosStale && <span className="wc-head__ref">{t("ws.chat.churros.old")}</span>}
            </span>
          )}
          {isHere && (
            <button type="button" className="ws-btn ws-btn--small" disabled={headBusy} aria-expanded={confirm === "end"} onClick={() => setConfirm(confirm === "end" ? null : "end")}>
              {t("ws.chat.end")}
            </button>
          )}
          {noSession && resumable && lines.length > 0 && !folderMissing && !notReady && (
            <button type="button" className="ws-btn ws-btn--small" disabled={headBusy} onClick={() => void guard("starting", () => startChat(project.id, false))}>
              {t("ws.chat.fresh")}
            </button>
          )}
        </div>
        {confirm === "end" && isHere && (
          <Confirm
            id="wc-end"
            title={t("ws.chat.end.title")}
            body={t("ws.chat.end.body")}
            goLabel={t("ws.chat.end.go")}
            keepLabel={t("ws.chat.end.keep")}
            onGo={() => void guard("ending", stopSession)}
            onKeep={() => setConfirm(null)}
          />
        )}
      </div>
      {actionError && (
        <p className="wc-card__error wc-actionerr" role="alert">
          <Icon name="alert" size={16} />
          {actionError}
        </p>
      )}
      <ChatLog
        lines={lines}
        hasMore={chat.hasMore}
        loadingOlder={chat.loadingOlder}
        olderFailed={chat.olderFailed}
        onLoadOlder={() => void loadOlder(project.id)}
        onRespond={respond}
        empty={logBody}
      />
      {bottom}
    </div>
  );
}
