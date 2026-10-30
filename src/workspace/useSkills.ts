// 프로젝트에 붙일 스킬의 설명 — `ipc.skillsList()` 의 `description` 이 있으면 그것, 없으면 짧은 기본 문구 (못 읽어도 기본 문구).
import { useEffect, useState } from "react";
import { t, type TextKey } from "../i18n/ko";
import { ipc } from "../lib/ipc";
import type { ProjectSkill } from "../lib/ipc-types";

export const PROJECT_SKILLS: readonly ProjectSkill[] = ["/desktop-app", "/web-full", "/web-lite"];

const DEFAULT_DESC: Record<ProjectSkill, TextKey> = {
  "/desktop-app": "ws.skill.desc.desktopApp",
  "/web-full": "ws.skill.desc.webFull",
  "/web-lite": "ws.skill.desc.webLite",
};

/** 스킬 명령(`/desktop-app`) → 설명. 아직 못 읽었으면 기본 문구 */
export function useSkillDescriptions(): (skill: ProjectSkill) => string {
  const [found, setFound] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    ipc.skillsList().then(
      (list) => {
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const entry of list.skills) {
          if (entry.state === "ok" && entry.description) next[entry.command] = entry.description;
        }
        setFound(next);
      },
      () => {
        // 설명은 꾸밈이다 — 못 읽으면 기본 문구
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  return (skill) => found[skill] ?? t(DEFAULT_DESC[skill]);
}
