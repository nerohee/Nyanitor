// 실제 작업 공간 — 시안 a 「들여다보는 창」 (D-30 · ③ 스티커 수첩, D-43). 뒤로 물러난 마당 장면 위 종이(`ws-paper`)에
// 넓은 창은 프로젝트 목록 | 탭 판, 좁은 창은 프로젝트 바꾸기 단추 + 탭 판. 탭은 [채팅] [진행] [문서] [요구사항] (처음 채팅, P6-08 · P7-04) + 탭 줄 오른쪽 작은 둥근 창문(누르면 진행 탭).
// 프로젝트 · 새 프로젝트 · 프로젝트 설정 · 요구사항 편집기 (P6-04) + 채팅 (P6-05, `chat/`) + 진행 보기 · 일하는 고양이 · 둥근 창문 (P7-04, `progress/`) + 문서 보기 (`docs/`).
// 고른 프로젝트(`projectId`)는 앱(App)이 들고 있다 — 고양이 집에서 프로젝트를 눌러 들어와도 같다. 고른 것이 없으면 가장 최근에 연 프로젝트.
import { useEffect, useMemo, useRef, useState } from "react";
import { AppNav, type NavPlace } from "../components/nav/AppNav";
import { HouseScene } from "../components/house/HouseScene";
import { timeOfDay } from "../components/house/time";
import { t, tf } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { ProjectEntry } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { useClock } from "../home/useClock";
import { errorText } from "./errors";
import { NewProjectDialog } from "./NewProjectDialog";
import { NoProjects, ProjectNavList, ProjectSwitcher } from "./ProjectList";
import { ProjectSettingsDialog } from "./ProjectSettings";
import { Dialog as DialogBox } from "./Dialog";
import { RequirementsEditor, type EditorGuard } from "./RequirementsEditor";
import { DocsPane } from "./docs/DocsPane";
import { MiniWindow } from "./progress/RoomWindow";
import { ProgressPane } from "./progress/ProgressPane";
import { windowScene } from "./progress/placement";
import { useWorkerRoles } from "./progress/workerCat";
import { workingWorkers } from "./progress/workers";
import { useProjects } from "./useProjects";
import { useWide, WorkPanels } from "./WorkPanels";
import { PendingAnnouncer } from "./chat/Announcer";
import { ChatPane } from "./chat/ChatPane";
import { selectPending, selectWaitingAsker, selectWorkers, startSessionStore, useSessionStore } from "./chat/sessionStore";
import "./workspace.css";

interface Props {
  /** 고른 프로젝트 번호 (없으면 가장 최근) */
  projectId: number | null;
  onSelect: (id: number | null) => void;
  onGo: (place: NavPlace) => void;
  /** 열자마자 새 프로젝트 창을 띄운다 (고양이 집의 새 프로젝트 단추) */
  openNew?: boolean;
  /** 열자마자 보일 탭 (고양이 집 정보 패널의 "진행 보기" 등) — 없으면 채팅 */
  openTab?: "progress" | "chat";
  /** 시험에서 PC 시각을 바꿔 넣는다 */
  clock?: () => Date;
}

type Dialog = null | "new" | "settings";

/** 폴더가 없어진 프로젝트 — 편집기 대신 안내 + 목록에서 빼기 */
function FolderMissing({ project, onSettings }: { project: ProjectEntry; onSettings: () => void }) {
  return (
    <div className="ws-state" role="alert">
      <Icon name="alert" size={24} />
      <h3 className="ws-state__title">{t("ws.proj.missing")}</h3>
      <p>{t("ws.missing.body")}</p>
      <code className="ws-state__path">{project.path}</code>
      <button type="button" className="ws-btn" onClick={onSettings}>
        {t("ws.missing.remove")}
      </button>
    </div>
  );
}

/** 충돌 띠로 저장을 멈춘 채 떠나려 할 때 — 여기서 쓴 글을 남길지 묻는다 */
function LeaveDialog({ onStay, onDiscard, onKeep }: { onStay: () => void; onDiscard: () => void; onKeep: () => void }) {
  const stay = useRef<HTMLButtonElement>(null);
  return (
    <DialogBox titleId="ws-leave-title" onClose={onStay} initialFocus={() => stay.current}>
      <header className="ws-dlg__head">
        <h2 id="ws-leave-title" className="ws-dlg__title">
          {t("ws.leave.title")}
        </h2>
      </header>
      <div className="ws-dlg__body">
        <p>{t("ws.leave.body")}</p>
      </div>
      <footer className="ws-dlg__foot">
        <span className="ws-dlg__foot-note" />
        <button ref={stay} type="button" className="ws-btn" onClick={onStay}>
          {t("ws.leave.stay")}
        </button>
        <button type="button" className="ws-btn ws-btn--danger" onClick={onDiscard}>
          {t("ws.leave.discard")}
        </button>
        <button type="button" className="ws-btn ws-btn--primary" onClick={onKeep}>
          {t("ws.leave.keep")}
        </button>
      </footer>
    </DialogBox>
  );
}

function ProjectHead({ project, onSettings }: { project: ProjectEntry; onSettings: () => void }) {
  return (
    <header className="ws-phead">
      <Icon name="folder" size={16} />
      <h2 className="ws-phead__name">{project.name}</h2>
      {project.skill && <code className="ws-phead__skill">{project.skill}</code>}
      <span className="ws-phead__path" title={project.path}>
        {project.path}
      </span>
      <button type="button" className="ws-icon-btn" onClick={onSettings} aria-label={t("ws.settings.open")} title={t("ws.settings.open")}>
        <Icon name="settings" size={16} />
      </button>
    </header>
  );
}

export default function Workspace({ projectId, onSelect, onGo, openNew = false, openTab = "chat", clock }: Props) {
  const now = useClock(clock);
  const time = timeOfDay(now);
  const wide = useWide();
  const { state, reload } = useProjects();
  const [dialog, setDialog] = useState<Dialog>(openNew ? "new" : null);
  const [active, setActive] = useState<string>(openTab);
  const paper = useRef<HTMLDivElement>(null);
  /** 편집기가 충돌 띠로 저장을 멈춘 동안만 채워진다 */
  const guard = useRef<EditorGuard | null>(null);
  /** 떠나기를 묻는 중 — 고르면 할 일 */
  const [leaving, setLeaving] = useState<null | { go: () => void }>(null);

  const ready = state.status === "ready";
  const projects = ready ? state.projects : [];
  const readOnly = ready && state.db === "read_only";
  const selected = projects.find((project) => project.id === projectId) ?? projects[0] ?? null;
  const selectedId = selected?.id ?? null;
  /** 요구사항 탭에 붙는 "충돌" 표시 — 저장을 멈춘 채 다른 탭에 있어도 알 수 있게 */
  const [editorConflict, setEditorConflict] = useState(false);
  /** 채팅 탭에 붙는, 답을 기다리는 카드 수 */
  const waitingCards = useSessionStore(selectPending(selectedId));
  const waiting = useSessionStore(selectWaitingAsker(selectedId));
  /** 작은 창문 — 지금 일하는 고양이 (먼저 시작한 순) */
  const workers = useSessionStore(selectWorkers(selectedId));
  const roles = useWorkerRoles(selectedId !== null);
  const working = useMemo(() => workingWorkers(workers), [workers]);
  const mini = useMemo(() => windowScene(working, waiting, roles), [working, waiting, roles]);

  // 세션 저장소는 앱이 켜질 때 한 번 시작한다 (`App.tsx`) — 여기서 한 번 더 불러도 같은 것 (작업 공간만 따로 열어 본 시험)
  useEffect(() => {
    void startSessionStore();
  }, []);

  // 프로젝트를 열 때 "최근에 연" 으로 (못 적어도 — 읽기 전용 DB 등 — 열기는 막지 않는다)
  useEffect(() => {
    if (selectedId !== null) ipc.projectTouch(selectedId).catch(() => undefined);
  }, [selectedId]);

  // 대화상자를 연 단추가 그사이 사라졌으면(좁은 창의 프로젝트 바꾸기 팝오버 · 프로젝트 없음의 단추) 프로젝트 바꾸기 단추, 없으면 종이로
  const fallbackFocus = () => paper.current?.querySelector<HTMLElement>(".ws-switch__btn") ?? paper.current;
  const closeDialog = () => setDialog(null);
  /** 다른 프로젝트 · 화면으로 — 저장을 멈춘 글이 있으면 먼저 묻는다 */
  const leave = (go: () => void) => {
    if (guard.current) setLeaving({ go });
    else go();
  };
  const pick = (id: number) => {
    if (id === selectedId) {
      setActive("chat");
      return;
    }
    leave(() => {
      onSelect(id);
      setActive("chat");
    });
  };
  const go = (place: NavPlace) => {
    if (place === "workspace") onGo(place);
    else leave(() => onGo(place));
  };

  const none = ready && projects.length === 0;
  const showList = wide && ready && !none;

  return (
    <div className="ws" data-testid="workspace" data-skin="3" data-time={time}>
      <AppNav current="workspace" onGo={go} />
      <main className="ws-stage">
        <h1 className="ws-sr">{t("variant.nav.workspace")}</h1>
        <PendingAnnouncer />
        {/* 뒤로 물러난 장면 — 같은 마당이 종이 뒤에 비친다 */}
        <HouseScene className="ws-backdrop" time={time} placements={[]} />
        <div
          ref={paper}
          tabIndex={-1}
          className="ws-paper"
          data-wide={showList ? "true" : undefined}
          data-none={none ? "true" : undefined}
        >
          {none ? (
            <NoProjects onNew={() => setDialog("new")} disabled={readOnly} />
          ) : !selected ? (
            <div className="ws-state" role={state.status === "failed" ? "alert" : "status"}>
              {state.status === "failed" ? (
                <>
                  <Icon name="alert" size={24} />
                  <p>{tf("ws.proj.failed", { reason: errorText(state.kind) })}</p>
                  <button type="button" className="ws-btn" onClick={() => void reload()}>
                    {t("ws.proj.retry")}
                  </button>
                </>
              ) : (
                <p>{t("ws.proj.loading")}</p>
              )}
            </div>
          ) : (
            <>
              {showList && (
                <ProjectNavList
                  state={state}
                  selectedId={selectedId}
                  onPick={pick}
                  onNew={() => setDialog("new")}
                  onRetry={() => void reload()}
                  className="ws-projects"
                />
              )}
              <div className="ws-work">
                <ProjectHead project={selected} onSettings={() => setDialog("settings")} />
                <WorkPanels
                  active={active}
                  onActive={setActive}
                  className="ws-panels"
                  tabStart={
                    wide ? undefined : (
                      <ProjectSwitcher
                        state={state}
                        selectedId={selectedId}
                        onPick={pick}
                        onNew={() => setDialog("new")}
                        onRetry={() => void reload()}
                      />
                    )
                  }
                  tabEnd={<MiniWindow cat={mini.focus} count={mini.all.length} onOpen={() => setActive("progress")} />}
                  panels={[
                    {
                      id: "chat",
                      label: t("variant.ws.tab.chat"),
                      badge: waitingCards,
                      content: <ChatPane key={selected.id} project={selected} projects={projects} onGoProject={pick} />,
                    },
                    {
                      id: "progress",
                      label: t("ws.tab.progress"),
                      content: <ProgressPane key={selected.id} projectId={selected.id} visible={active === "progress"} time={time} now={now} roles={roles} />,
                    },
                    {
                      id: "docs",
                      label: t("ws.tab.docs"),
                      content: <DocsPane key={selected.id} projectId={selected.id} visible={active === "docs"} />,
                    },
                    {
                      id: "editor",
                      label: t("variant.ws.tab.editor"),
                      flag: editorConflict ? t("ws.tab.conflict") : undefined,
                      content:
                        selected.folder === "missing" ? (
                          <FolderMissing project={selected} onSettings={() => setDialog("settings")} />
                        ) : (
                          <RequirementsEditor key={selected.id} projectId={selected.id} guardRef={guard} onConflict={setEditorConflict} />
                        ),
                    },
                  ]}
                />
              </div>
            </>
          )}
        </div>
        {dialog === "new" && (
          <NewProjectDialog
            onClose={closeDialog}
            fallbackFocus={fallbackFocus}
            onAdded={(entry) => {
              void reload().then(() => {
                closeDialog();
                leave(() => onSelect(entry.id));
              });
            }}
            onOpenExisting={(id) => {
              closeDialog();
              pick(id);
            }}
          />
        )}
        {dialog === "settings" && selected && (
          <ProjectSettingsDialog
            project={selected}
            readOnly={readOnly}
            onClose={closeDialog}
            fallbackFocus={fallbackFocus}
            onChanged={() => void reload()}
            onRemoved={(id) => {
              if (id === projectId) onSelect(null);
              void reload().then(closeDialog);
            }}
          />
        )}
        {leaving && (
          <LeaveDialog
            onStay={() => setLeaving(null)}
            onDiscard={() => {
              setLeaving(null);
              leaving.go();
            }}
            onKeep={() => {
              guard.current?.keepMine();
              setLeaving(null);
              leaving.go();
            }}
          />
        )}
      </main>
    </div>
  );
}
