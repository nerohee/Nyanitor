// 브라우저(`npm run dev`) 가짜 모드의 작업자(서브에이전트) 설정 (P7-02). `fakeClaude.ts`(실시간 이벤트)와 `fakeHistory.ts`(채팅 기록)가 같이 쓴다.
// 주소 쿼리 `?workers=`:
//   one — 메시지를 보내면 작업자 하나가 앞에서 기다리며 일한다 (시작 → 하는 일 → 끝)
//   two — 작업자 둘이 한꺼번에 일한다 (끝나는 때가 다르다)
//   background — 작업자 하나가 백그라운드로 돈다: 부른 턴이 먼저 끝나고, 작업자는 그 뒤에 끝난다 (끝 알림 뒤 CLI 가 스스로 둘째 턴을 연다)
//   permission — 작업자가 권한이 필요한 도구를 쓴다: 권한 요청에 `worker` 가 붙는다
//   (없거나 모르는 값) — 작업자 없음 (기본)
// 하나라도 고르면 채팅 기록(`?history=full`)에도 작업자 항목(마침 · 실패 · 멈춤)이 나온다. 이름은 하네스 작업자 이름이다 (이름 → 고양이 연결은 화면이 한다).
import type { WorkerRef } from "./ipc-types";

export type FakeWorkersMode = "none" | "one" | "two" | "background" | "permission";
const WORKER_MODES: readonly FakeWorkersMode[] = ["none", "one", "two", "background", "permission"];

/** 주소 쿼리 → 가짜 작업자 설정. 모르는 값은 `none`. */
export function parseFakeWorkersQuery(search: string): FakeWorkersMode {
  const value = new URLSearchParams(search).get("workers");
  return WORKER_MODES.find((mode) => mode === value) ?? "none";
}

/** 가짜 작업자 하나의 정의 */
export interface FakeWorkerSpec {
  name: string;
  description: string;
  /** 하는 일 순서 — 도구 이름과 한 줄 설명 */
  steps: readonly { tool: string; summary: string }[];
}

export const FAKE_WORKERS: Readonly<Record<"tester" | "ui" | "system", FakeWorkerSpec>> = {
  tester: {
    name: "harness-tester",
    description: "채팅 화면 시험 쓰기",
    steps: [
      { tool: "Read", summary: "ChatPane.tsx 읽는 중" },
      { tool: "Write", summary: "ChatPane.test.tsx 쓰는 중" },
    ],
  },
  ui: {
    name: "harness-builder-ui",
    description: "사진 목록 화면 만들기",
    steps: [
      { tool: "Grep", summary: "카드 컴포넌트 찾는 중" },
      { tool: "Edit", summary: "Gallery.tsx 고치는 중" },
    ],
  },
  system: {
    name: "harness-builder-system",
    description: "사진 읽기 명령 만들기",
    steps: [
      { tool: "Read", summary: "photos.rs 읽는 중" },
      { tool: "Write", summary: "photos.rs 쓰는 중" },
    ],
  },
};

/** 권한 요청에 붙는 작업자 표시 */
export function workerRefOf(toolUseId: string, spec: FakeWorkerSpec): WorkerRef {
  return { agentId: `agent-${toolUseId}`, toolUseId, name: spec.name };
}
