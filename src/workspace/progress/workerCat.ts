// 작업자 이름 → 고양이. 이벤트의 `name` 은 에이전트 이름(`harness-builder-ui` 등)이고, 고양이는 역할(`ui`)이 가리킨다 (`agent-cats.json`).
// 역할 찾는 순서: ① 에이전트 목록(`ipc.agentsList`)의 이름 → 역할 ② `harness-<역할>` · `harness-builder-<역할>` 모양으로 짐작 ③ 모르면 정리 담당(`helper`)의 고양이.
// (`general-purpose` · `Explore` 처럼 하네스 밖 작업자는 ③ — 먹물로 두면 "먹물에게 맡김" 이 되어 헷갈린다.)
import { useEffect, useState } from "react";
import { catForAgent, type CatId } from "../../components/cat/catalog";
import { isTextKey, t } from "../../i18n/ko";
import { ipc } from "../../lib/ipc";
import type { AgentRole, AgentsList } from "../../lib/ipc-types";

/** 목록에 없고 짐작도 못 한 작업자의 역할 — 정리 담당(두부) */
export const UNKNOWN_WORKER_ROLE: AgentRole = "helper";

const GUESS_ROLES: readonly AgentRole[] = ["main", "designer", "ui", "system", "tester", "helper", "reviewer"];

/** 에이전트 이름 → 역할 */
export type WorkerRoles = ReadonlyMap<string, AgentRole>;

/** 에이전트 목록 → 이름 · 역할. 읽을 수 없는 파일은 파일 이름(`.md` 뺀 것)으로 */
export function rolesOfAgents(list: AgentsList | null | undefined): WorkerRoles {
  const roles = new Map<string, AgentRole>();
  for (const entry of list?.agents ?? []) {
    if (entry.role === null) continue;
    if (entry.state === "ok") roles.set(entry.name, entry.role);
    else roles.set(entry.file.replace(/\.md$/i, ""), entry.role);
  }
  return roles;
}

/** 이 이름의 역할 — 목록에서, 없으면 이름 모양으로 짐작, 그래도 모르면 `null` */
export function roleOfWorker(name: string, roles?: WorkerRoles): AgentRole | null {
  const listed = roles?.get(name);
  if (listed) return listed;
  const guess = /^harness-(?:builder-)?([a-z]+)$/.exec(name)?.[1];
  return GUESS_ROLES.find((role) => role === guess) ?? null;
}

/** 작업자 이름 → 고양이. 사용자가 고친 연결(`user`)이 있으면 그것이 먼저 (D-31) */
export function catForWorker(name: string, options: { roles?: WorkerRoles; user?: Readonly<Record<string, string>> } = {}): CatId {
  const role = roleOfWorker(name, options.roles) ?? UNKNOWN_WORKER_ROLE;
  return catForAgent(role, { user: options.user }) as CatId;
}

/** 고양이 이름 ("단추") */
export function catName(cat: CatId): string {
  const key = `cat.${cat}.name`;
  return isTextKey(key) ? t(key) : "";
}

// ── 목록 읽기 (앱이 켜져 있는 동안 한 번만 — 하네스를 새로 설치하면 앱을 다시 켜야 반영된다) ──

let cached: WorkerRoles | null = null;
let loading: Promise<WorkerRoles | null> | null = null;

function loadRoles(): Promise<WorkerRoles | null> {
  loading ??= ipc.agentsList().then(
    (list) => {
      cached = rolesOfAgents(list);
      return cached;
    },
    () => {
      // 못 읽으면 다음에 다시 — 그동안은 이름 모양으로 짐작한다
      loading = null;
      return null;
    },
  );
  return loading;
}

/** 시험용 — 읽어 둔 목록을 버린다 */
export function resetWorkerRoles(): void {
  cached = null;
  loading = null;
}

/** 이름 → 역할 목록 (아직 못 읽었으면 `undefined` — `catForWorker` 가 이름 모양으로 짐작한다). `enabled` 가 false 면 읽지 않는다 */
export function useWorkerRoles(enabled = true): WorkerRoles | undefined {
  const [roles, setRoles] = useState<WorkerRoles | null>(cached);
  useEffect(() => {
    if (!enabled) return;
    if (cached) return;
    let alive = true;
    void loadRoles().then((loaded) => {
      if (alive && loaded) setRoles(loaded);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return roles ?? undefined;
}
