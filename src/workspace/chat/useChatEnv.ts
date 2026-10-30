// 채팅이 읽는 바깥 상태 — Claude 준비 (`claudeDiscover`) · 입력줄의 스킬 목록 (`skillsList`).
import { useCallback, useEffect, useState } from "react";
import { ipc } from "../../lib/ipc";
import type { ClaudeStatus, SkillInfo, SkillsState } from "../../lib/ipc-types";

export type ClaudeReady = { state: "loading" } | { state: "unknown" } | { state: "ready"; status: ClaudeStatus };

/** Claude 가 있고 로그인돼 있는가. 확인을 못 했거나(오류) 로그인 여부를 모르면(`null`) 막지 않는다 — 보내 보면 알 수 있다 */
export function useClaudeReady(): { ready: ClaudeReady; recheck: () => void } {
  const [ready, setReady] = useState<ClaudeReady>({ state: "loading" });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let alive = true;
    ipc.claudeDiscover().then(
      (status) => {
        if (alive) setReady({ state: "ready", status });
      },
      () => {
        if (alive) setReady({ state: "unknown" });
      },
    );
    return () => {
      alive = false;
    };
  }, [round]);
  const recheck = useCallback(() => {
    setReady({ state: "loading" });
    setRound((n) => n + 1);
  }, []);
  return { ready, recheck };
}

export type SkillChoicesState = { state: "loading" } | { state: "failed" } | { state: "ready"; list: SkillsState; skills: SkillInfo[] };

/** 입력줄에서 고를 스킬 — 사용자가 부를 수 있는 것만 (깨진 것 · `user-invocable: false` 는 뺀다) */
export function useSkillList(): SkillChoicesState {
  const [found, setFound] = useState<SkillChoicesState>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    ipc.skillsList().then(
      (list) => {
        if (!alive) return;
        const skills: SkillInfo[] = [];
        for (const entry of list.skills) if (entry.state === "ok" && entry.userInvocable) skills.push(entry);
        setFound({ state: "ready", list: list.state, skills });
      },
      () => {
        if (alive) setFound({ state: "failed" });
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  return found;
}
