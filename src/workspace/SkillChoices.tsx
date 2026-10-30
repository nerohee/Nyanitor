// 프로젝트 스킬 고르기 (새 프로젝트 · 프로젝트 설정이 같이 쓴다) — 스킬 셋 + "나중에 고르기"(없음). 라디오 묶음.
import { t } from "../i18n/ko";
import type { ProjectSkill } from "../lib/ipc-types";
import { PROJECT_SKILLS, useSkillDescriptions } from "./useSkills";

interface Props {
  legend: string;
  name: string;
  value: ProjectSkill | null;
  onChange: (skill: ProjectSkill | null) => void;
  disabled?: boolean;
}

export function SkillChoices({ legend, name, value, onChange, disabled = false }: Props) {
  const describe = useSkillDescriptions();
  const choices: Array<ProjectSkill | null> = [...PROJECT_SKILLS, null];
  return (
    <fieldset className="ws-dlg__skills" disabled={disabled}>
      <legend>{legend}</legend>
      {choices.map((skill, index) => (
        <label key={skill ?? "none"} className="ws-dlg__skill" data-checked={value === skill ? "true" : undefined}>
          <input type="radio" name={name} checked={value === skill} onChange={() => onChange(skill)} />
          <span className="ws-dlg__skill-text">
            <span className="ws-dlg__skill-name">
              {skill ? <code>{skill}</code> : t("ws.skill.later")}
              {index === 0 && <span className="ws-chip">{t("variant.ws.card.recommended")}</span>}
            </span>
            <span className="ws-dlg__skill-desc">{skill ? describe(skill) : t("ws.skill.laterDesc")}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
