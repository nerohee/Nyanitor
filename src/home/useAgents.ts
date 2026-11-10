// 에이전트 목록 → 집에 있는 고양이. 에이전트마다 고양이 한 마리 — 내 연결(`custom/agent-cats.json`, 에이전트 이름) → 기본 연결(역할, `agent-cats.json`).
// 역할이 없는 에이전트(직접 만든 · 하네스 밖)는 내 연결이 있을 때만 집에 나온다 (D-52).
import { useEffect, useMemo, useState } from "react";
import type { CatId } from "../components/cat/catalog";
import { ipc } from "../lib/ipc";
import type { AgentEntry, AgentsList } from "../lib/ipc-types";
import { mineCat, NO_MINE, orchCat, useMine, type Mine } from "../lib/mine";

/** 집의 고양이 한 마리와 그 에이전트. `entry` 가 없으면 아직 읽지 못했다 (먹물만 있는 경우) */
export interface HomeCat {
  cat: CatId;
  entry: AgentEntry | null;
}

export type AgentsState = { status: "loading" } | { status: "failed" } | { status: "ready"; list: AgentsList };

/** 에이전트의 열쇠 — 내 연결 · 보이는 이름 파일의 키. 오케스트레이터는 `main`, 나머지는 에이전트 이름(파일 이름에서 `.md` 뺀 것) */
export function agentKeyOf(entry: AgentEntry): string {
  if (entry.role === "main") return "main";
  return entry.state === "ok" ? (entry.file?.replace(/\.md$/i, "") ?? entry.name) : entry.file.replace(/\.md$/i, "");
}

/** 목록 → 고양이. 같은 고양이를 가리키는 에이전트가 둘이면 앞의 것 (오케스트레이터가 맨 앞) */
export function catsOf(list: AgentsList, mine: Mine = NO_MINE): HomeCat[] {
  const cats: HomeCat[] = [];
  for (const entry of list.agents) {
    const cat = mineCat(agentKeyOf(entry), entry.role, mine);
    if (cat === null || cats.some((c) => c.cat === cat)) continue;
    cats.push({ cat, entry });
  }
  return cats;
}

/** 하네스가 없거나 목록을 못 읽어도 오케스트레이터(내 연결의 `main`, 없으면 먹물)는 집에 있다 (D-37) */
const orchestratorOnly = (mine: Mine): HomeCat[] => [{ cat: orchCat(mine), entry: null }];

export function useAgents(): { state: AgentsState; cats: HomeCat[] } {
  const [state, setState] = useState<AgentsState>({ status: "loading" });
  const mine = useMine();

  useEffect(() => {
    let alive = true;
    ipc.agentsList().then(
      (list) => {
        if (alive) setState({ status: "ready", list });
      },
      () => {
        if (alive) setState({ status: "failed" });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const cats = useMemo(() => {
    if (state.status !== "ready") return orchestratorOnly(mine);
    const found = catsOf(state.list, mine);
    return found.length > 0 ? found : orchestratorOnly(mine);
  }, [state, mine]);

  return { state, cats };
}
