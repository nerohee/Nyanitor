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
import { useOrchestrator } from "./Lines";
import { pendingCount } from "./model";
import { declineTrust, grantTrust, interrupt, isTrustDeclined, loadChat, loadOlder, newChat, refreshResumable, respond, sendMessage, startChat, stopSession, useSessionStore } from "./sessionStore";
import { TrustDialog } from "./TrustDialog";
import { useClaudeReady, useSkillList } from "./useChatEnv";
import "./chat.css";

interface Props {
  project: ProjectEntry;
  /** 이름을 보이려고 (다른 프로젝트에서 도는 중) */
  projects: readonly ProjectEntry[];
  /** 다른 프로젝트로 가기 (저장하지 않은 글을 묻는 일은 작업 공간이 한다) */
  onGoProject: (id: number) => void;
  /** 바깥에서 "기다리는 카드로" 를 시킨다 (창을 다시 열었을 때, D-25) — 값이 바뀔 때마다 한 번, 카드가 그려진 뒤에 옮긴다 */
  focusCard?: number;
  /** `focusCard` 요청을 처리했다 (옮겼거나, 카드가 없어 버렸다) — 작업 공간이 기억해 다시 넘기지 않는다 */
  onCardHandled?: (request: number) => void;
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

export function ChatPane({ project, projects, onGoProject, focusCard = 0, onCardHandled }: Props) {
  const orch = useOrchestrator();
  const restored = useSessionStore((state) => state.restored);
  const session = useSessionStore((state) => state.session);
  const chat = useSessionStore((state) => state.chats[project.id]) ?? newChat();
  const churros = useSessionStore((state) => state.churros);
  const churrosStale = useSessionStore((state) => state.churrosStale);
  const trustAsk = useSessionStore((state) => state.trustAsk);
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

  // 폴더 설정 확인 화면을 거쳤나 (시작이 끝난 뒤 포커스를 정하려고)
  const trustAsked = useRef(false);
  useEffect(() => {
    if (trustAsk) trustAsked.current = true;
  }, [trustAsk]);

  const guard = async (kind: "starting" | "swapping" | "ending", run: () => Promise<unknown>) => {
    setAction(kind);
    setActionError(null);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let asked = false;
    try {
      await run();
      asked = trustAsked.current;
    } catch (raw) {
      // 폴더 설정 확인에서 취소 — 오류가 아니다. 시작 단추로 포커스를 돌려준다
      if (isTrustDeclined(raw)) {
        window.setTimeout(() => {
          if (opener?.isConnected) opener.focus();
        }, 0);
      } else setActionError(chatErrorText(raw));
    } finally {
      trustAsked.current = false;
      setAction(null);
      setConfirm(null);
    }
    // 확인을 거쳐 시작됐으면 입력줄로 (확인 화면을 연 단추는 사라졌거나 쓸 수 없다)
    if (asked && kind === "starting") composer.current?.focus();
  };

  const jump = () => {
    const card = root.current?.querySelector<HTMLElement>('[data-pending-card="true"]');
    card?.scrollIntoView?.({ block: "start" });
    card?.focus();
  };

  // 기다리던 카드에 답하면 그 카드가 접혀 포커스가 body 로 빠진다 — 다음 기다리는 카드로, 없으면 입력줄로 (D-55).
  // 새 카드 · 답함을 읽어 주는 것은 `PendingAnnouncer` 가 이미 하니 여기서는 포커스만 옮긴다.
  const inCard = useRef(false);
  const lastPending = useRef(pending);
  // 기다리는 카드가 있으면 채팅 안의 첫 Tab (또는 Tab 으로 채팅에 들어올 때) 은 카드로 간다 (2026-11-14 고객).
  // 한 번만 — 그 뒤엔 보통 순서라 Tab 으로 채팅을 빠져나갈 수 있다. 새 카드가 오거나 포커스가 채팅 밖으로 나가면 다시.
  const tabbedToCard = useRef(false);
  const lastTabAt = useRef(0);
  useEffect(() => {
    const note = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Tab" && !event.shiftKey) lastTabAt.current = Date.now();
    };
    document.addEventListener("keydown", note, true);
    return () => document.removeEventListener("keydown", note, true);
  }, []);
  const tabToCard = (target: EventTarget | null): boolean => {
    if (tabbedToCard.current || pending === 0) return false;
    if (target instanceof Element && (target.closest('[data-pending="true"]') || target.closest('[role="dialog"]'))) return false;
    const card = root.current?.querySelector<HTMLElement>('[data-pending-card="true"]');
    if (!card) return false;
    tabbedToCard.current = true;
    card.scrollIntoView?.({ block: "nearest" });
    card.focus({ preventScroll: true });
    return true;
  };
  useEffect(() => {
    if (pending > lastPending.current) tabbedToCard.current = false;
    const dropped = pending < lastPending.current;
    lastPending.current = pending;
    if (!dropped || !inCard.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    inCard.current = false;
    const next = root.current?.querySelector<HTMLElement>('[data-pending-card="true"]');
    if (next) {
      next.scrollIntoView?.({ block: "nearest" });
      next.focus({ preventScroll: true });
    } else composer.current?.focus();
  }, [pending]);

  // 바깥 요청 — 목록을 읽고 카드가 그려진 뒤에 옮긴다. 읽기를 마쳤는데도 카드가 없으면 그 요청은 버린다 (나중에 온 카드로 뜬금없이 옮기지 않게)
  const handledFocus = useRef(0);
  useEffect(() => {
    if (focusCard === 0 || handledFocus.current === focusCard) return;
    const found = root.current?.querySelector('[data-pending-card="true"]');
    if (found) {
      handledFocus.current = focusCard;
      jump();
      onCardHandled?.(focusCard);
    } else if (chat.load === "ready" || chat.load === "failed") {
      handledFocus.current = focusCard;
      onCardHandled?.(focusCard);
    }
  });

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
    <div
      className="wc"
      ref={root}
      data-testid="chat-pane"
      onFocus={(event) => {
        // Tab 으로 채팅 밖에서 들어왔으면 기다리는 카드부터 (마우스로 누른 것은 그대로)
        const fromOutside = !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));
        if (fromOutside && Date.now() - lastTabAt.current < 200 && tabToCard(event.target)) return;
        inCard.current = event.target instanceof Element && event.target.closest('[data-pending="true"]') !== null;
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
        if (tabToCard(event.target)) event.preventDefault();
      }}
      onBlur={(event) => {
        // 다른 곳(채팅 밖)으로 옮겨 갔으면 잊는다 — 카드가 사라져서 빠지는 것(받는 곳 없음)과 구별
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          inCard.current = false;
          tabbedToCard.current = false;
        }
      }}
    >
      <div className="wc-head" data-state={status}>
        <span className="wc-head__avatar" aria-hidden="true">
          <CatFigure cat={orch.cat} crop="face" />
        </span>
        <b>{orch.name}</b>
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
          {isHere && (session || (churros && churros.projectId === project.id)) && (
            <span className="wc-head__meta">
              {session && (
                <span className="wc-head__chip wc-head__chip--mono" title={t("variant.ws.chat.modelHint")}>
                  {modelText(chat.data.lastStart?.model ?? null, chat.data.lastStart?.effort ?? null)}
                </span>
              )}
              {churros && churros.projectId === project.id && (
                <span className="wc-head__chip" title={t(churrosStale ? "ws.chat.churros.stale" : "ws.chat.churros.hint")}>
                  {tf("ws.chat.churros", { n: churros.totalTokens.toLocaleString("ko-KR") })}
                  {churros.referenceOnly && <span className="wc-head__ref">{t("ws.chat.churros.ref")}</span>}
                  {churrosStale && <span className="wc-head__ref">{t("ws.chat.churros.old")}</span>}
                </span>
              )}
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
      {trustAsk && trustAsk.projectId === project.id && (
        <TrustDialog ask={trustAsk} onGrant={() => void grantTrust()} onCancel={declineTrust} fallbackFocus={() => root.current?.querySelector<HTMLElement>("textarea") ?? null} />
      )}
    </div>
  );
}
