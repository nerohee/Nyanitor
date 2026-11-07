// 브라우저(`npm run dev`)에서 진행 · 문서 화면이 돌도록 하는 가짜 프로젝트 문서 읽기. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/projects/progress.rs` · `docs.rs`)와 같은 명령 · 결과 모양 · 오류 종류를 흉내 낸다. 실제 폴더는 건드리지 않는다.
// 프로젝트 번호 확인(등록 안 된 번호 · DB · 폴더 없어짐)은 가짜 프로젝트 등록(`fakeProjects.ts`)에 묻는다. 고르는 법은 기존 가짜(`fakeProjects.ts` · `fakeHouse.ts`)처럼 주소 쿼리:
//   ?progress=running (기본, 작업 여럿 · 진행률 있음) · ?progress=none (하네스 전 — 둘 다 absent) · ?progress=waiting (사용자 답 기다림)
//     · ?progress=unreadable (단계 표를 읽을 수 없음 — 머리 줄이 다름) · ?progress=memo_unreadable (이어 하기 메모만 읽을 수 없음)
//   ?docs=many (기본, 폴더 깊이가 있는 문서 여럿 + 읽을 수 없는 문서 하나) · ?docs=none (docs 폴더 없음)
// 시험은 `reset({...})` 로 쿼리 대신 값을 정한다.
import { fakeProjects } from "./fakeProjects";
import {
  AppError,
  type DocRead,
  type DocsList,
  type HandoffInfo,
  type HandoffRead,
  type HandoffTask,
  type PlanPhase,
  type PlanRead,
  type ProgressRead,
} from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

export type FakeProgressMode = "running" | "none" | "waiting" | "unreadable" | "memo_unreadable";
export type FakeDocsMode = "many" | "none";

export interface FakeProgressOptions {
  progress: FakeProgressMode;
  docs: FakeDocsMode;
}

const DEFAULTS: FakeProgressOptions = { progress: "running", docs: "many" };

const PROGRESS_MODES: readonly FakeProgressMode[] = ["running", "none", "waiting", "unreadable", "memo_unreadable"];
const DOCS_MODES: readonly FakeDocsMode[] = ["many", "none"];

/** 주소 쿼리 → 가짜 설정. 모르는 값은 기본값. */
export function parseFakeProgressQuery(search: string): FakeProgressOptions {
  const params = new URLSearchParams(search);
  return {
    progress: PROGRESS_MODES.find((mode) => mode === params.get("progress")) ?? DEFAULTS.progress,
    docs: DOCS_MODES.find((mode) => mode === params.get("docs")) ?? DEFAULTS.docs,
  };
}

// ── 진행 ──

function phase(id: string, status: PlanPhase["status"], statusText: string, summary: string, owners: string[][], gate: string, name: string, goal: string): PlanPhase {
  return { id, summary, owners, ownersText: owners.map((group) => group.join(" · ")).join(" → "), gate, status, statusText, name, goal };
}

/** 이 저장소의 `dev-plan.md` 와 같은 모양 — 단계 12개, P0 ~ P6 완료, P7 진행 중 */
function plan(): PlanRead {
  const done = (date: string, note = "") => `완료 (${date})${note}`;
  const phases: PlanPhase[] = [
    phase("P0", "done", done("2026-10-13"), "셋업 · 기획 확정", [["직접"]], "기획 승인", "셋업 · 기획 확정", "프로젝트 틀과 기획을 확정한다."),
    phase("P1", "done", done("2026-10-13"), "앱 뼈대", [["system"]], "실행 확인 (빈 창 · 트레이)", "앱 뼈대", "빈 앱이 뜨고, 앞으로 모든 작업이 기댈 구조가 갖춰진다."),
    phase("P2", "done", done("2026-10-16", " — 시안 a, 테마 ③ 스티커 수첩"), "디자인 방향 · 시안", [["designer"]], "시안 고르기 · 그림 확인", "디자인 방향 · 시안", "고양이 집과 작업 공간의 모양을 고객이 고른다."),
    phase("P3", "done", done("2026-10-18", " — stream-json 연결"), "Claude 연결", [["system"], ["tester"], ["reviewer"]], "실행 확인", "Claude 연결", "앱이 사용자 PC 의 claude 로 대화 세션을 연다."),
    phase("P4", "done", done("2026-10-22"), "하네스 설치 · 업데이트", [["system"], ["tester"], ["reviewer"]], "실행 확인", "하네스 설치 · 업데이트", "앱에서 하네스를 받아 설치한다."),
    phase("P5", "done", done("2026-10-28"), "메인 — 고양이 집", [["designer"], ["ui", "system"], ["designer"]], "실행 확인", "메인 — 고양이 집", "고양이들이 사는 집, 에이전트 정보, 사용량이 보인다."),
    phase("P6", "done", done("2026-11-07", " — 작업 공간 [채팅 | 요구사항] 탭"), "작업 공간", [["ui", "system"]], "실행 확인", "작업 공간", "프로젝트를 고르고 요구사항을 쓰고 대화한다."),
    phase("P7", "now", "진행 중 (2026-11-07) — 탭 + 둥근 창문 (D-49)", "진행 보기", [["system"], ["ui"], ["designer"]], "실행 확인", "진행 보기", "지금 무엇이 진행 중인지 한눈에 (D-13)."),
    phase("P8", "todo", "", "알림 · 트레이 마무리", [["system"], ["reviewer"]], "실행 확인 (창 닫고 알림 받기)", "알림 · 트레이 마무리", "창을 닫아도 일이 계속된다."),
    phase("P9", "todo", "", "내 수정", [["system", "ui"], ["tester"]], "실행 확인", "내 수정", "에이전트 · 스킬을 앱에서 고친다."),
    phase("P10", "todo", "", "마감 점검", [["reviewer", "tester"], ["고침은 담당별"]], "점검 결과 승인", "마감 점검", "공개 전에 위험을 찾아 고친다."),
    phase("P11", "todo", "", "출시", [["system"], ["reviewer"]], "설치본 확인", "출시", "세 OS 설치본을 낸다."),
  ];
  return { state: "ok", phases };
}

function task(label: string, owner: string, status: HandoffTask["status"], statusText: string, progress: HandoffTask["progress"]): HandoffTask {
  const brief = /^briefs\/[^/]+\.md$/.test(label) ? label : null;
  const id = brief ? (/^briefs\/(P\d+-\d+)/.exec(brief)?.[1] ?? null) : null;
  return { label, brief, id, phase: id ? id.split("-")[0]! : null, owner, status, statusText, progress };
}

function handoff(mode: "running" | "waiting"): HandoffRead {
  const waiting = mode === "waiting";
  const info: HandoffInfo = {
    skill: "desktop-app",
    requirements: "requirements.md (프로젝트 루트, 고치지 않음)",
    phase: "P7 진행 보기 — 진행 중 (2026-11-07 승인), 배치 탭 + 둥근 창문 (D-49)",
    updated: "2026-11-07",
    current: {
      state: "ok",
      value: waiting
        ? { state: "waiting_answer", text: "사용자 답 기다림 — P7 배치 확인 (2026-11-07)" }
        : { state: "working", text: "작업자 일하는 중 — P7-01 (system, 2026-11-07)" },
    },
    tasks: {
      state: "ok",
      value: [
        task("briefs/P7-01-project-docs.md", "system", "assigned", "맡김 (2026-11-07)", { done: 5, total: 7 }),
        task("briefs/P7-02-session-events.md", "system", "back", "돌아옴 (2026-11-08)", { done: 4, total: 4 }),
        task("briefs/P7-03-progress-tab.md", "ui", "redo", "다시 맡김", { done: 1, total: 6 }),
        task("briefs/P6-12-cards-one-at-a-time.md", "ui", "passed", "검수 통과 · 고객 확인 · 커밋 `641fd73` — 지시서 끝", null),
        task("briefs/P6-11-review-fixes-ui.md", "ui", "passed", "2차 검수 통과 — 지시서 끝", null),
        task("briefs/P6-09-review.md", "reviewer", "unknown", "끝 — 고객 고름", { done: 0, total: 0 }),
        task("(P2-01 ~ P2-03 검수 통과 — 지시서 끝)", "", "unknown", "", null),
        task("briefs/P9-01-missing-file.md", "system", "assigned", "맡김", null),
      ],
    },
    waiting: { state: "ok", value: waiting ? ["P7 배치 — 탭 + 둥근 창문으로 갈지 골라 주세요", "실행 확인 — 진행 탭이 맞게 보이는지"] : [] },
    next: { state: "ok", value: ["P7-01 검수 → P7-02 지시서", "P7-03 · P7-04 (ui) → P7-05 designer → 고객 써 보기"] },
  };
  return { state: "ok", ...info };
}

function progressFor(mode: FakeProgressMode, version: string): ProgressRead {
  switch (mode) {
    case "none":
      return { version, plan: { state: "absent" }, handoff: { state: "absent" } };
    case "unreadable":
      return { version, plan: { state: "unreadable", reason: "header_mismatch" }, handoff: handoff("running") };
    case "memo_unreadable":
      return { version, plan: plan(), handoff: { state: "unreadable", reason: "no_section" } };
    case "waiting":
      return { version, plan: plan(), handoff: handoff("waiting") };
    case "running":
      return { version, plan: plan(), handoff: handoff("running") };
  }
}

// ── 문서 ──

interface FakeDoc {
  path: string;
  text: string;
  modified: number;
  /** 읽을 수 없는 문서 (UTF-8 이 아님) */
  broken?: true;
}

const NOW = 1_800_000_000;

function manyDocs(): FakeDoc[] {
  const doc = (path: string, text: string, ageHours: number, broken?: true): FakeDoc => ({ path, text, modified: NOW - 3600 * ageHours, broken });
  return [
    doc("README.md", "# 고양이 앨범\n\n문서 모음.\n", 300),
    doc("01-planning/decisions.md", "# 결정\n\n## D-01. 시작\n\n- 앱으로 만든다.\n", 120),
    doc("01-planning/design/tokens.md", "# 디자인 토큰\n\n| 이름 | 값 |\n|---|---|\n| 배경 | #faf3e0 |\n", 90),
    doc("01-planning/design/refs/cats.md", "# 레퍼런스\n\n- 네코 아츠메\n", 80),
    doc("02-development/dev-plan.md", "# 개발 계획\n\n## 단계 개요\n\n| 단계 | 내용 |\n|---|---|\n| P0 | 셋업 |\n", 2),
    doc("02-development/handoff.md", "# 이어 하기 메모\n\n## 지금 상태\n\n작업자 일하는 중\n", 1),
    doc("02-development/briefs/P7-01-project-docs.md", "# P7-01 문서 읽기\n\n- [x] 단계 표\n- [ ] 시험\n", 1),
    doc("03-notes/한글 메모.md", "# 메모\n\n한글 이름의 문서.\n", 40),
    doc("03-notes/옛 노트.md", "", 500, true),
  ];
}

const sizeOf = (doc: FakeDoc) => (doc.broken ? 4 : new TextEncoder().encode(doc.text).length);

/** 진짜 `docs::parse_path` 의 규칙을 줄여 흉내: 빈 값 · 절대 경로 · 드라이브 · `..` · `\` · 숨은 이름 · `.md` 아님 → invalid_input */
function checkPath(path: unknown): string {
  const invalid = (why: string) => new AppError("invalid_input", `invalid input: doc path ${why}`);
  if (typeof path !== "string" || path.trim() === "") throw invalid("is empty");
  const parts = path.split("/");
  // eslint-disable-next-line no-control-regex
  if (parts.length > 9 || parts.some((part) => part === "" || part.startsWith(".") || /[\\:*?"<>|\u0000-\u001f]/.test(part) || /[. ]$/.test(part))) {
    throw invalid("has a part that is not allowed");
  }
  if (!/.\.md$/i.test(parts[parts.length - 1]!)) throw invalid("is not a .md file");
  return path;
}

export function createFakeProgress() {
  /** 시험이 정한 값. 없으면 부를 때마다 주소 쿼리를 읽는다 (화면에서 쿼리를 바꿔 다시 열면 바뀐 값). */
  let override: FakeProgressOptions | null = null;
  const options = (): FakeProgressOptions => override ?? parseFakeProgressQuery(typeof window === "undefined" ? "" : window.location.search);

  /** 문서가 바뀐 척하려고 올리는 번호 (`touch`) */
  let revision = 0;
  const versionText = () => `fake-progress-${options().progress}-${revision}`;

  /** 진짜처럼 등록 안 된 번호 · DB 를 못 읽음은 오류, 폴더가 없어졌으면 읽을 수 없음 결과 (`true`) */
  function folderMissing(id: unknown): boolean {
    fakeProjects.requireRegistered(id);
    return fakeProjects.isFolderMissing(id);
  }

  const handlers: Record<string, Handler> = {
    project_progress_read: (args): ProgressRead => {
      if (folderMissing(args.id)) {
        const gone = { state: "unreadable", reason: "folder_missing" } as const;
        return { version: versionText(), plan: gone, handoff: gone };
      }
      return progressFor(options().progress, versionText());
    },

    project_progress_version: (args): string => {
      folderMissing(args.id);
      return versionText();
    },

    project_docs_list: (args): DocsList => {
      if (folderMissing(args.id)) return { state: "unreadable", reason: "folder_missing" };
      if (options().docs === "none") return { state: "absent" };
      const files = manyDocs()
        .map((doc) => ({ path: doc.path, size: sizeOf(doc), modified: doc.modified }))
        .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
      return { state: "ok", docsDir: "docs", files, truncated: false };
    },

    project_doc_read: (args): DocRead => {
      // 진짜와 같은 차례: 등록된 프로젝트인지 → 경로 모양 → 폴더 있는지
      const missing = folderMissing(args.id);
      const path = checkPath(args.path);
      if (missing) return { state: "unreadable", reason: "folder_missing" };
      if (options().docs === "none") return { state: "absent" };
      const doc = manyDocs().find((candidate) => candidate.path === path);
      if (!doc) return { state: "absent" };
      if (doc.broken) return { state: "unreadable", reason: "not_utf8" };
      return { state: "ok", text: doc.text, version: `fake-doc-${doc.text.length}-${doc.modified}` };
    },
  };

  return {
    handlers,
    /** 시험용: 쿼리 대신 값을 정한다 (인자 없이 부르면 다시 쿼리를 읽는다). 바뀜 번호도 처음으로 */
    reset(next?: Partial<FakeProgressOptions>) {
      override = next ? { ...DEFAULTS, ...next } : null;
      revision = 0;
    },
    /** 문서가 바뀐 척한다 — `project_progress_version` 의 값이 달라진다 (화면이 다시 읽는지 볼 때) */
    touch() {
      revision += 1;
    },
  };
}

export const fakeProgress = createFakeProgress();
