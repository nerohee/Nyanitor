// 에이전트 목록 → 집에 있는 고양이. 역할(`main` · `ui` 등)이 있는 에이전트마다 고양이 한 마리 (`agent-cats.json`).
// 역할이 없는 에이전트(하네스 밖)는 이번엔 집에 나오지 않는다 (고양이 고르기는 P9).
import { useEffect, useMemo, useState } from "react";
import { catForAgent, FALLBACK_CAT, type CatId } from "../components/cat/catalog";
import { ipc } from "../lib/ipc";
import type { AgentEntry, AgentsList } from "../lib/ipc-types";

/** 집의 고양이 한 마리와 그 에이전트. `entry` 가 없으면 아직 읽지 못했다 (먹물만 있는 경우) */
export interface HomeCat {
  cat: CatId;
  entry: AgentEntry | null;
}

export type AgentsState = { status: "loading" } | { status: "failed" } | { status: "ready"; list: AgentsList };

/** 목록 → 고양이. 같은 고양이를 가리키는 에이전트가 둘이면 앞의 것 (오케스트레이터가 맨 앞) */
export function catsOf(list: AgentsList): HomeCat[] {
  const cats: HomeCat[] = [];
  for (const entry of list.agents) {
    if (entry.role === null) continue;
    const cat = catForAgent(entry.role) as CatId;
    if (cats.some((c) => c.cat === cat)) continue;
    cats.push({ cat, entry });
  }
  return cats;
}

/** 하네스가 없거나 목록을 못 읽어도 먹물은 집에 있다 (D-37) */
const ORCHESTRATOR_ONLY: HomeCat[] = [{ cat: FALLBACK_CAT, entry: null }];

export function useAgents(): { state: AgentsState; cats: HomeCat[] } {
  const [state, setState] = useState<AgentsState>({ status: "loading" });

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
    if (state.status !== "ready") return ORCHESTRATOR_ONLY;
    const found = catsOf(state.list);
    return found.length > 0 ? found : ORCHESTRATOR_ONLY;
  }, [state]);

  return { state, cats };
}
