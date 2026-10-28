// 준비 상태 — Claude 찾음 · 로그인 · git · 하네스 설치. 시제품의 `READINESS` (4가지) 와 같다.
// 각각 따로 읽는다: 하나가 실패해도 나머지는 그대로, 실패한 것은 "아직 모름" 으로 센다.
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { ClaudeStatus, HarnessStatus } from "../lib/ipc-types";

export const READY_ITEMS = ["claude", "login", "git", "harness"] as const;
export type ReadyItem = (typeof READY_ITEMS)[number];

export type ReadyMark = "ok" | "missing" | "unknown";

export interface ReadinessState {
  /** 아직 답이 안 온 것이 있다 */
  loading: boolean;
  /** 둘 다 읽지 못했다 */
  failed: boolean;
  marks: Record<ReadyItem, ReadyMark>;
}

type Raw<T> = { status: "loading" } | { status: "failed" } | { status: "ok"; value: T };

function useRaw<T>(read: () => Promise<T>): Raw<T> {
  const [raw, setRaw] = useState<Raw<T>>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    read().then(
      (value) => {
        if (alive) setRaw({ status: "ok", value });
      },
      () => {
        if (alive) setRaw({ status: "failed" });
      },
    );
    return () => {
      alive = false;
    };
    // 처음 한 번만 읽는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return raw;
}

function mark(known: boolean | null | undefined): ReadyMark {
  if (known === true) return "ok";
  if (known === false) return "missing";
  return "unknown";
}

/**
 * `agentsFound` — 에이전트 목록에서 하네스가 보인다. 하네스 설치 상태를 못 읽어도 에이전트 파일이 실제로 있으면 설치된 것이다.
 */
export function useReadiness(agentsFound: boolean): ReadinessState {
  const claude = useRaw<ClaudeStatus>(ipc.claudeDiscover);
  const harness = useRaw<HarnessStatus>(ipc.harnessStatus);

  const c = claude.status === "ok" ? claude.value : null;
  const h = harness.status === "ok" ? harness.value : null;
  const installed = h ? h.origin.kind === "repo" || h.origin.kind === "developer" : null;

  return {
    loading: claude.status === "loading" || harness.status === "loading",
    failed: claude.status === "failed" && harness.status === "failed",
    marks: {
      claude: mark(c?.found),
      // Claude 를 못 찾으면 로그인은 확인할 수 없다 — 준비되지 않은 것으로 센다
      login: c?.found ? mark(c.loggedIn) : c ? "missing" : "unknown",
      git: mark(h?.git.found),
      harness: agentsFound || installed === true ? "ok" : mark(installed),
    },
  };
}
