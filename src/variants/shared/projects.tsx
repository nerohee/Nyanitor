// 프로젝트 (D-11 · D-12 · P6) — 목록(지금 · 최근 · 그 밖, 찾기), 좁은 창의 프로젝트 바꾸기, 새 프로젝트 창(폴더 → 스킬), 프로젝트 없음.
// 프로젝트 = 사용자가 고른 폴더 하나. 결과물 · docs/ 가 그 폴더에 남아 터미널에서 이어 해도 같다.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CatFigure } from "../../components/cat/CatFigure";
import { t, tf, type TextKey } from "../../i18n/ko";
import { ORCHESTRATOR } from "../fixtures";
import { NEW_PROJECT_FOLDERS, PROJECT_SKILLS, SKILLS, type FolderFinding, type OrchStatus, type ProjectRow } from "../fixtures-workspace";
import { Icon } from "./icons";

const RECENT_COUNT = 3;
const SEARCH_FROM = 6;

function StatusLine({ project }: { project: ProjectRow }) {
  if (project.missing)
    return (
      <span className="wproj__status" data-status="missing">
        <Icon name="alert" size={12} />
        {t("variant.ws.proj.missing")}
      </span>
    );
  if (project.status === "idle") return <span className="wproj__when">{t(project.openedKey)}</span>;
  return (
    <span className="wproj__status" data-status={project.status}>
      <span className="status-dot" aria-hidden="true" />
      {t(`variant.ws.status.${project.status}`)}
    </span>
  );
}

function ProjectItem({ project, current, onPick }: { project: ProjectRow; current: boolean; onPick?: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="wproj__item"
        aria-current={current ? "page" : undefined}
        data-missing={project.missing ? "true" : undefined}
        onClick={onPick}
      >
        <span className="wproj__name">{t(project.nameKey)}</span>
        <StatusLine project={project} />
        <span className="wproj__path">{project.path}</span>
      </button>
    </li>
  );
}

/** 프로젝트 목록 — 돌아가는 것(한 번에 하나, D-12)이 맨 위, 그다음 최근 3개, 그 밖. 많으면 찾기 칸 */
export function ProjectNavList({
  projects,
  selectedId,
  onNew,
  className,
  compact = false,
}: {
  projects: readonly ProjectRow[];
  selectedId: string | null;
  onNew: () => void;
  className?: string;
  /** 좁은 창 팝오버 안 — 제목 · 끝 메모 없이 */
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState(selectedId);
  const searchId = useId();
  const match = (p: ProjectRow) =>
    !query.trim() || t(p.nameKey).includes(query.trim()) || p.path.toLowerCase().includes(query.trim().toLowerCase());
  const active = projects.filter((p) => p.status !== "idle" && !p.missing);
  const rest = projects.filter((p) => !active.includes(p));
  const all: Array<{ key: TextKey; items: ProjectRow[] }> = [
    { key: "variant.ws.proj.group.now", items: active.filter(match) },
    { key: "variant.ws.proj.group.recent", items: rest.slice(0, RECENT_COUNT).filter(match) },
    { key: "variant.ws.proj.group.more", items: rest.slice(RECENT_COUNT).filter(match) },
  ];
  const groups = all.filter((g) => g.items.length > 0);

  return (
    <nav className={`wproj${compact ? " wproj--compact" : ""}${className ? ` ${className}` : ""}`} aria-label={t("variant.ws.projects")}>
      {!compact && (
        <h2 className="wproj__title">
          {t("variant.ws.projects")}
          <span className="wproj__count">{projects.length}</span>
        </h2>
      )}
      {projects.length >= SEARCH_FROM && (
        <label className="wproj__search" htmlFor={searchId}>
          <Icon name="search" size={14} />
          <input
            id={searchId}
            type="search"
            className="wproj__search-in"
            placeholder={t("variant.ws.proj.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <div className="wproj__groups">
        {groups.map((group) => (
          <section key={group.key} className="wproj__group" aria-label={t(group.key)}>
            {groups.length > 1 && <h3 className="wproj__group-title">{t(group.key)}</h3>}
            <ul>
              {group.items.map((project) => (
                <ProjectItem key={project.id} project={project} current={project.id === current} onPick={() => setCurrent(project.id)} />
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 && <p className="wproj__none">{t("variant.ws.proj.noMatch")}</p>}
      </div>
      <button type="button" className="hbtn hbtn--ghost wproj__new" onClick={onNew}>
        <Icon name="plus" size={16} />
        {t("variant.ws.newProject")}
      </button>
      {!compact && <p className="wproj__note">{t("variant.ws.oneAtATime")}</p>}
    </nav>
  );
}

/** 좁은 창 — 프로젝트 목록 대신 탭 줄 왼쪽의 "프로젝트 바꾸기" 단추 (누르면 목록이 내려온다) */
export function ProjectSwitcher({
  projects,
  selectedId,
  onNew,
}: {
  projects: readonly ProjectRow[];
  selectedId: string | null;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const popId = useId();
  const current = projects.find((p) => p.id === selectedId);
  const waiting = projects.filter((p) => p.status === "waiting" && p.id !== selectedId).length;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="wswitch" onKeyDown={(event: KeyboardEvent) => event.key === "Escape" && open && close()}>
      <button
        ref={button}
        type="button"
        className="wswitch__btn"
        aria-expanded={open}
        aria-controls={popId}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="folder" size={16} />
        <span className="wswitch__name">{current ? t(current.nameKey) : t("variant.ws.projects")}</span>
        {current && current.status !== "idle" && <span className="status-dot" data-status={current.status} aria-hidden="true" />}
        {waiting > 0 && <span className="wp__badge">{waiting}</span>}
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="wswitch__pop" id={popId}>
          <ProjectNavList
            projects={projects}
            selectedId={selectedId}
            compact
            onNew={() => {
              setOpen(false);
              onNew();
            }}
          />
        </div>
      )}
    </div>
  );
}

/** 프로젝트가 하나도 없을 때 — 종이 한가운데 */
export function NoProjects({ onNew }: { onNew: () => void }) {
  return (
    <div className="wnone">
      <div className="wnone__cat" aria-hidden="true">
        <CatFigure cat={ORCHESTRATOR} pose="sit" />
      </div>
      <h2 className="wnone__title">{t("variant.ws.none.title")}</h2>
      <p className="wnone__body">{t("variant.ws.none.body")}</p>
      <ol className="wnone__steps">
        <li>{t("variant.ws.none.step1")}</li>
        <li>{t("variant.ws.none.step2")}</li>
        <li>{t("variant.ws.none.step3")}</li>
      </ol>
      <div className="wnone__actions">
        <button type="button" className="hbtn hbtn--primary" onClick={onNew}>
          <Icon name="plus" size={18} />
          {t("variant.ws.newProject")}
        </button>
      </div>
      <p className="wnone__note">{t("variant.ws.none.note")}</p>
    </div>
  );
}

// ── 새 프로젝트 창 ──

const FINDING: Record<FolderFinding, { tone: "info" | "ok"; title: TextKey; body: TextKey }> = {
  fresh: { tone: "info", title: "variant.ws.new.find.fresh", body: "variant.ws.new.find.freshBody" },
  hasRequirements: { tone: "ok", title: "variant.ws.new.find.req", body: "variant.ws.new.find.reqBody" },
  hasHarness: { tone: "info", title: "variant.ws.new.find.harness", body: "variant.ws.new.find.harnessBody" },
};

type FolderMode = "create" | "existing";

/** 새 프로젝트 — ① 폴더(새로 만들기 · 있는 폴더) ② 스킬. 폴더를 고르면 안을 살펴 알린다. Esc 로 닫기 */
export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<0 | 1>(0);
  const [mode, setMode] = useState<FolderMode>("create");
  const [name, setName] = useState("cat-diary");
  const [picked, setPicked] = useState(0);
  const [skill, setSkill] = useState<string>(PROJECT_SKILLS[0]);
  const titleId = useId();
  const first = useRef<HTMLInputElement>(null);
  const folder = NEW_PROJECT_FOLDERS[picked];
  const finding: FolderFinding = mode === "create" ? "fresh" : folder.finding;
  const resume = finding === "hasHarness";
  const path = mode === "create" ? `C:\\dev\\${name || "…"}` : folder.path;

  // 열리면 첫 칸으로
  useEffect(() => {
    first.current?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="wdlg__scrim" onKeyDown={onKeyDown}>
      <div className="wdlg" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="wdlg__head">
          <h2 id={titleId} className="wdlg__title">
            {t("variant.ws.new.title")}
          </h2>
          <ol className="wdlg__steps" aria-label={t("variant.ws.new.steps")}>
            {(["variant.ws.new.step.folder", "variant.ws.new.step.skill"] as const).map((key, i) => (
              <li key={key} data-status={i < step ? "done" : i === step ? "now" : "todo"} aria-current={i === step ? "step" : undefined}>
                <span aria-hidden="true">{i < step ? <Icon name="check" size={12} /> : i + 1}</span>
                {t(key)}
              </li>
            ))}
          </ol>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("variant.ui.close")}>
            <Icon name="close" size={18} />
          </button>
        </header>

        {step === 0 ? (
          <div className="wdlg__body">
            <div className="wdlg__choice" role="radiogroup" aria-label={t("variant.ws.new.folderMode")}>
              {(["create", "existing"] as const).map((value) => (
                <label key={value} className="wdlg__card" data-checked={mode === value ? "true" : undefined}>
                  <input
                    ref={value === "create" ? first : undefined}
                    type="radio"
                    name="wdlg-mode"
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  <Icon name={value === "create" ? "plus" : "folder"} size={20} />
                  <span className="wdlg__card-title">{t(`variant.ws.new.mode.${value}`)}</span>
                  <span className="wdlg__card-desc">{t(`variant.ws.new.mode.${value}.desc`)}</span>
                </label>
              ))}
            </div>
            {mode === "create" ? (
              <div className="wdlg__fields">
                <label className="wdlg__field">
                  <span>{t("variant.ws.new.name")}</span>
                  <input
                    className="fld fld--mono"
                    value={name}
                    spellCheck={false}
                    onChange={(event) => setName(event.target.value.replace(/[\\/:*?"<>|]/g, ""))}
                  />
                </label>
                <div className="wdlg__field">
                  <span>{t("variant.ws.new.where")}</span>
                  <div className="wdlg__row">
                    <code className="wdlg__path">C:\dev\</code>
                    <button type="button" className="hbtn">
                      <Icon name="folder" size={16} />
                      {t("variant.ws.new.change")}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="wdlg__fields">
                <div className="wdlg__field">
                  <span>{t("variant.ws.new.folder")}</span>
                  <div className="wdlg__row">
                    <code className="wdlg__path">{folder.path}</code>
                    <button type="button" className="hbtn" onClick={() => setPicked((picked + 1) % NEW_PROJECT_FOLDERS.length)}>
                      <Icon name="folder" size={16} />
                      {t("variant.ws.new.pick")}
                    </button>
                  </div>
                  <span className="wdlg__hint">{t("variant.ws.new.pickHint")}</span>
                </div>
              </div>
            )}
            <div className="wdlg__find" data-tone={FINDING[finding].tone} role="status">
              <Icon name={FINDING[finding].tone === "ok" ? "check" : "info"} size={16} />
              <div>
                <p className="wdlg__find-title">{t(FINDING[finding].title)}</p>
                <p>{t(FINDING[finding].body)}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="wdlg__body">
            <p className="wdlg__lead">{resume ? t("variant.ws.new.skillResume") : t("variant.ws.new.skillLead")}</p>
            <div className="wdlg__skills" role="radiogroup" aria-label={t("variant.ws.new.step.skill")}>
              {(resume ? ["/harness-resume"] : [...PROJECT_SKILLS, "later"]).map((id, i) => {
                const info = SKILLS.find((s) => s.id === id);
                return (
                  <label key={id} className="wdlg__skill" data-checked={resume || skill === id ? "true" : undefined}>
                    <input type="radio" name="wdlg-skill" checked={resume || skill === id} onChange={() => setSkill(id)} />
                    <span className="wdlg__skill-text">
                      <span className="wdlg__skill-name">
                        {id === "later" ? t("variant.ws.new.skillLater") : <code>{id}</code>}
                        {i === 0 && <span className="wopt__rec">{t("variant.ws.card.recommended")}</span>}
                      </span>
                      <span className="wdlg__skill-desc">
                        {id === "later" ? t("variant.ws.new.skillLaterDesc") : info ? t(info.descKey) : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
            <dl className="wdlg__summary">
              <dt>{t("variant.ws.new.folder")}</dt>
              <dd>
                <code>{path}</code>
              </dd>
              <dt>{t("variant.ws.new.next")}</dt>
              <dd>{resume ? t("variant.ws.new.nextResume") : t("variant.ws.new.nextFresh")}</dd>
            </dl>
          </div>
        )}

        <footer className="wdlg__foot">
          <span className="wdlg__foot-note">{tf("variant.ws.new.stepOf", { n: step + 1, total: 2 })}</span>
          {step === 0 ? (
            <>
              <button type="button" className="hbtn" onClick={onClose}>
                {t("variant.ui.cancel")}
              </button>
              <button type="button" className="hbtn hbtn--primary" onClick={() => setStep(1)}>
                {t("variant.ws.new.toSkill")}
                <Icon name="arrow" size={16} />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="hbtn" onClick={() => setStep(0)}>
                {t("variant.ws.new.back")}
              </button>
              <button type="button" className="hbtn hbtn--primary" onClick={onClose}>
                {resume ? t("variant.ws.new.openResume") : t("variant.ws.new.create")}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

/** 프로젝트 줄 · 채팅 머리가 같이 쓰는 상태 이름 */
export function statusKey(status: OrchStatus): TextKey {
  return `variant.ws.status.${status}`;
}
