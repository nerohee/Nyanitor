// 프로젝트 설정 — 이름 고치기 · 스킬 바꾸기 · 목록에서 빼기 (확인 한 번). 등록만 지운다: 폴더와 파일은 그대로, 이 앱의 채팅 기록 · 츄르는 지워진다 (D-48).
// DB 가 읽기 전용이면 고치기 · 빼기를 끈다.
import { useEffect, useId, useRef, useState } from "react";
import { t, tf } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import { PROJECT_NAME_MAX_CHARS, type ProjectEntry, type ProjectPatch, type ProjectSkill } from "../lib/ipc-types";
import { Icon } from "../variants/shared/icons";
import { Dialog } from "./Dialog";
import { errorKind, errorText } from "./errors";
import { SkillChoices } from "./SkillChoices";

interface Props {
  project: ProjectEntry;
  readOnly: boolean;
  onClose: () => void;
  /** 이름 · 스킬을 고쳤다 */
  onChanged: () => void;
  /** 목록에서 뺐다 */
  onRemoved: (id: number) => void;
  fallbackFocus?: () => HTMLElement | null;
}

export function ProjectSettingsDialog({ project, readOnly, onClose, onChanged, onRemoved, fallbackFocus }: Props) {
  const titleId = useId();
  const nameId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(project.name);
  const [skill, setSkill] = useState<ProjectSkill | null>(project.skill);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const ask = useRef<HTMLButtonElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);

  // 확인 단계로 바뀌면 안전한 쪽(취소)으로, 돌아오면 처음 단추로 — 누른 단추가 사라져도 포커스가 body 로 빠지지 않게
  useEffect(() => {
    if (!asked.current) return;
    (confirming ? keep.current : ask.current)?.focus();
  }, [confirming]);

  const trimmed = name.trim();
  const nameProblem = trimmed === "" ? t("ws.new.nameEmpty") : null;
  const changed = trimmed !== project.name || skill !== project.skill;
  const canSave = !readOnly && changed && nameProblem === null && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setProblem(null);
    const patch: ProjectPatch = {};
    if (trimmed !== project.name) patch.name = trimmed;
    if (skill !== project.skill) patch.skill = skill;
    try {
      await ipc.projectUpdate(project.id, patch);
      onChanged();
      onClose();
    } catch (raw) {
      setProblem(errorText(errorKind(raw)));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await ipc.projectRemove(project.id);
      onRemoved(project.id);
    } catch (raw) {
      setProblem(errorText(errorKind(raw)));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <Dialog titleId={titleId} onClose={onClose} busy={busy} initialFocus={() => nameInput.current} fallbackFocus={fallbackFocus}>
      <header className="ws-dlg__head">
        <h2 id={titleId} className="ws-dlg__title">
          {t("ws.settings.title")}
        </h2>
        <button type="button" className="ws-icon-btn" onClick={onClose} disabled={busy} aria-label={t("variant.ui.close")}>
          <Icon name="close" size={18} />
        </button>
      </header>

      <div className="ws-dlg__body">
        {readOnly && (
          <p className="ws-note" role="status">
            <Icon name="info" size={14} />
            {t("ws.proj.readOnly")}
          </p>
        )}
        <div className="ws-dlg__field">
          <label htmlFor={nameId}>{t("ws.new.name")}</label>
          <input
            id={nameId}
            ref={nameInput}
            className="ws-fld"
            value={name}
            maxLength={PROJECT_NAME_MAX_CHARS}
            disabled={readOnly || busy}
            aria-invalid={nameProblem !== null}
            aria-describedby={nameProblem ? `${nameId}-err` : undefined}
            onChange={(event) => setName(event.target.value)}
          />
          {nameProblem && (
            <span id={`${nameId}-err`} className="ws-dlg__error">
              {nameProblem}
            </span>
          )}
        </div>
        <div className="ws-dlg__field">
          <span>{t("ws.new.folder")}</span>
          <code className="ws-dlg__path">{project.path}</code>
        </div>
        <SkillChoices legend={t("ws.skill.title")} value={skill} onChange={setSkill} name="ws-settings-skill" disabled={readOnly || busy} />

        <section className="ws-dlg__danger" aria-labelledby={`${titleId}-remove`}>
          <h3 id={`${titleId}-remove`}>{t("ws.settings.remove")}</h3>
          {confirming ? (
            <>
              <p role="alert">{tf("ws.settings.removeConfirm", { name: project.name })}</p>
              <div className="ws-dlg__row">
                <button type="button" className="ws-btn ws-btn--danger" disabled={busy} onClick={() => void remove()}>
                  {t("ws.settings.removeGo")}
                </button>
                <button ref={keep} type="button" className="ws-btn" disabled={busy} onClick={() => setConfirming(false)}>
                  {t("variant.ui.cancel")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>{t("ws.settings.removeBody")}</p>
              <button
                ref={ask}
                type="button"
                className="ws-btn"
                disabled={readOnly || busy}
                onClick={() => {
                  asked.current = true;
                  setConfirming(true);
                }}
              >
                <Icon name="minus" size={16} />
                {t("ws.settings.removeAsk")}
              </button>
            </>
          )}
        </section>

        {problem && (
          <p className="ws-dlg__error" role="alert">
            <Icon name="alert" size={14} />
            {problem}
          </p>
        )}
      </div>

      <footer className="ws-dlg__foot">
        <span className="ws-dlg__foot-note" />
        <button type="button" className="ws-btn" onClick={onClose} disabled={busy}>
          {t("variant.ui.cancel")}
        </button>
        <button type="button" className="ws-btn ws-btn--primary" disabled={!canSave} onClick={() => void save()}>
          {t("ws.settings.save")}
        </button>
      </footer>
    </Dialog>
  );
}
