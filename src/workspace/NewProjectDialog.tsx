// 새 프로젝트 — 폴더 고르기(Rust 가 대화상자를 띄운다, D-47) → 살펴본 결과 · 이름 · 스킬 → 추가. 경로 글자는 보내지 않는다.
// 고를 수 없는 폴더는 이유 한 줄 + 다시 고르기, 이미 등록된 폴더는 "이미 있어요 — 열기".
import { useId, useRef, useState } from "react";
import { t, tf, type TextKey } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import {
  PROJECT_NAME_MAX_CHARS,
  type ProjectEntry,
  type ProjectFolderFinding,
  type ProjectForbiddenReason,
  type ProjectPickedOk,
  type ProjectSkill,
} from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { Dialog } from "./Dialog";
import { errorKind, errorText } from "./errors";
import { SkillChoices } from "./SkillChoices";

const FINDING: Record<ProjectFolderFinding, { tone: "info" | "ok"; title: TextKey; body: TextKey }> = {
  fresh: { tone: "info", title: "ws.new.find.fresh", body: "ws.new.find.freshBody" },
  hasRequirements: { tone: "ok", title: "ws.new.find.req", body: "ws.new.find.reqBody" },
  hasHarness: { tone: "info", title: "ws.new.find.harness", body: "ws.new.find.harnessBody" },
};

const FORBIDDEN: Record<ProjectForbiddenReason, TextKey> = {
  drive_root: "ws.new.forbidden.drive_root",
  home: "ws.new.forbidden.home",
  claude_dir: "ws.new.forbidden.claude_dir",
  harness_home: "ws.new.forbidden.harness_home",
  app_data: "ws.new.forbidden.app_data",
};

type Pick = { state: "none" } | { state: "ok"; folder: ProjectPickedOk } | { state: "forbidden"; path: string; reason: ProjectForbiddenReason };

interface Props {
  onClose: () => void;
  /** 등록됐다 (이미 있던 프로젝트면 그것) — 화면이 그 프로젝트를 연다 */
  onAdded: (project: ProjectEntry) => void;
  /** 이미 등록된 폴더 — "열기" */
  onOpenExisting: (id: number) => void;
  fallbackFocus?: () => HTMLElement | null;
}

export function NewProjectDialog({ onClose, onAdded, onOpenExisting, fallbackFocus }: Props) {
  const titleId = useId();
  const nameId = useId();
  const pickButton = useRef<HTMLButtonElement>(null);
  const [pick, setPick] = useState<Pick>({ state: "none" });
  const [picking, setPicking] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [skill, setSkill] = useState<ProjectSkill | null>("/desktop-app");
  const [problem, setProblem] = useState<string | null>(null);

  const choose = async () => {
    setPicking(true);
    setProblem(null);
    setCancelled(false);
    try {
      const picked = await ipc.projectPickFolder();
      if (picked === null) {
        // 취소 — 앞서 고른 것은 그대로 (Rust 도 들고 있던 폴더를 그대로 둔다)
        setCancelled(true);
      } else if (picked.state === "forbidden") {
        setPick({ state: "forbidden", path: picked.path, reason: picked.reason });
      } else {
        setPick({ state: "ok", folder: picked });
        setName(picked.name);
        // 하던 프로젝트(하네스 문서가 있는 폴더)는 스킬을 새로 정하지 않는다 — 채팅에서 이어 하기
        setSkill(picked.finding === "hasHarness" ? null : "/desktop-app");
      }
    } catch (raw) {
      setProblem(errorText(errorKind(raw)));
    } finally {
      setPicking(false);
    }
  };

  const trimmed = name.trim();
  const nameProblem = trimmed === "" ? t("ws.new.nameEmpty") : null;
  const folder = pick.state === "ok" ? pick.folder : null;
  const canAdd = folder !== null && folder.existingId === null && nameProblem === null && !adding;

  const add = async () => {
    if (!canAdd) return;
    setAdding(true);
    setProblem(null);
    try {
      const entry = await ipc.projectAdd({ name: trimmed, skill });
      onAdded(entry);
    } catch (raw) {
      setProblem(errorText(errorKind(raw)));
      setAdding(false);
    }
  };

  const finding = folder?.finding ? FINDING[folder.finding] : null;

  return (
    <Dialog titleId={titleId} onClose={onClose} busy={adding} initialFocus={() => pickButton.current} fallbackFocus={fallbackFocus}>
      <header className="ws-dlg__head">
        <h2 id={titleId} className="ws-dlg__title">
          {t("ws.new.title")}
        </h2>
        <button type="button" className="ws-icon-btn" onClick={onClose} disabled={adding} aria-label={t("variant.ui.close")}>
          <Icon name="close" size={18} />
        </button>
      </header>

      <div className="ws-dlg__body">
        <div className="ws-dlg__field">
          <span id={`${titleId}-folder`}>{t("ws.new.folder")}</span>
          <div className="ws-dlg__row">
            <code className="ws-dlg__path" aria-labelledby={`${titleId}-folder`} data-empty={pick.state === "none" ? "true" : undefined}>
              {pick.state === "none" ? t("ws.new.noneYet") : pick.state === "ok" ? pick.folder.path : pick.path}
            </code>
            <button ref={pickButton} type="button" className="ws-btn" disabled={picking || adding} onClick={() => void choose()}>
              <Icon name="folder" size={16} />
              {picking ? t("ws.new.picking") : pick.state === "none" ? t("ws.new.pick") : t("ws.new.pickAgain")}
            </button>
          </div>
          <span className="ws-dlg__hint">{t("ws.new.pickHint")}</span>
          {cancelled && pick.state === "none" && (
            <p className="ws-dlg__hint" role="status">
              {t("ws.new.cancelled")}
            </p>
          )}
        </div>

        {pick.state === "forbidden" && (
          <div className="ws-dlg__find" data-tone="warn" role="alert">
            <Icon name="alert" size={16} />
            <div>
              <p className="ws-dlg__find-title">{t("ws.new.forbidden.title")}</p>
              <p>{t(FORBIDDEN[pick.reason])}</p>
            </div>
          </div>
        )}

        {folder && (
          <>
            {folder.existingId !== null && (
              <div className="ws-dlg__find" data-tone="ok" role="status">
                <Icon name="check" size={16} />
                <div>
                  <p className="ws-dlg__find-title">{t("ws.new.existing.title")}</p>
                  <p>{t("ws.new.existing.body")}</p>
                  <button type="button" className="ws-btn ws-btn--small" onClick={() => onOpenExisting(folder.existingId as number)}>
                    {t("ws.new.existing.open")}
                  </button>
                </div>
              </div>
            )}
            {finding ? (
              <div className="ws-dlg__find" data-tone={finding.tone} role="status">
                <Icon name={finding.tone === "ok" ? "check" : "info"} size={16} />
                <div>
                  <p className="ws-dlg__find-title">{t(finding.title)}</p>
                  <p>{t(finding.body)}</p>
                </div>
              </div>
            ) : (
              <p className="ws-dlg__hint" role="status">
                {t("ws.new.find.unknown")}
              </p>
            )}
            {folder.existingId === null && (
              <>
                <div className="ws-dlg__field">
                  <label htmlFor={nameId}>{t("ws.new.name")}</label>
                  <input
                    id={nameId}
                    className="ws-fld"
                    value={name}
                    maxLength={PROJECT_NAME_MAX_CHARS}
                    aria-invalid={nameProblem !== null}
                    aria-describedby={nameProblem ? `${nameId}-err` : undefined}
                    onChange={(event) => setName(event.target.value)}
                  />
                  {nameProblem ? (
                    <span id={`${nameId}-err`} className="ws-dlg__error">
                      {nameProblem}
                    </span>
                  ) : (
                    <span className="ws-dlg__hint">{tf("ws.new.nameHint", { max: PROJECT_NAME_MAX_CHARS })}</span>
                  )}
                </div>
                <SkillChoices legend={t("ws.skill.title")} value={skill} onChange={setSkill} name="ws-new-skill" />
              </>
            )}
          </>
        )}

        {problem && (
          <p className="ws-dlg__error" role="alert">
            <Icon name="alert" size={14} />
            {problem}
          </p>
        )}
      </div>

      <footer className="ws-dlg__foot">
        <span className="ws-dlg__foot-note" />
        <button type="button" className="ws-btn" onClick={onClose} disabled={adding}>
          {t("variant.ui.cancel")}
        </button>
        <button type="button" className="ws-btn ws-btn--primary" disabled={!canAdd} onClick={() => void add()}>
          {adding ? t("ws.new.adding") : t("ws.new.add")}
        </button>
      </footer>
    </Dialog>
  );
}
