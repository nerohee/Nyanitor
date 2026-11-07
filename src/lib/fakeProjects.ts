// 브라우저(`npm run dev`)에서 작업 공간 화면이 돌도록 하는 가짜 프로젝트 등록 · requirements.md. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/projects/`)와 같은 명령 · 결과 모양 · 오류 종류를 흉내 낸다. 실제 폴더 · DB 는 건드리지 않는다.
// 폴더 고르기는 대화상자 대신 정해진 가짜 경로를 돌려준다. 고르는 법은 기존 가짜(`fakeHouse.ts`)처럼 주소 쿼리:
//   ?projects=many (기본, 폴더가 없어진 것 하나 포함) · ?projects=none (프로젝트 없음)
//   ?pick=fresh (기본) · ?pick=requirements · ?pick=harness (살펴보기 세 가지) · ?pick=cancel (취소) · ?pick=<이유> (고를 수 없는 폴더: drive_root · home · claude_dir · harness_home · app_data)
//   ?requirements=saved (기본, 파일이 있고 저장이 된다) · ?requirements=absent (파일 없음) · ?requirements=conflict (읽은 뒤 바깥에서 바뀜 → 저장하면 충돌)
//     · ?requirements=unreadable (UTF-8 이 아님) · ?requirements=too_large (너무 큼)
//   ?db=ok (기본) · ?db=read_only (새 버전 DB — 등록 · 고치기 · 빼기는 db_read_only) · ?db=unavailable (모든 프로젝트 명령이 db_unavailable)
// 시험은 `reset({...})` 로 쿼리 대신 값을 정한다.
import {
  AppError,
  PROJECT_NAME_MAX_CHARS,
  type ProjectEntry,
  type ProjectFolderFinding,
  type ProjectForbiddenReason,
  type ProjectList,
  type ProjectPickedFolder,
  type ProjectSkill,
  type RequirementsRead,
  type RequirementsVersion,
  type RequirementsWrite,
} from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

export type FakeProjectsMode = "many" | "none";
export type FakePickMode = "fresh" | "requirements" | "harness" | "cancel" | ProjectForbiddenReason;
export type FakeRequirementsMode = "saved" | "absent" | "conflict" | "unreadable" | "too_large";
export type FakeDbMode = "ok" | "read_only" | "unavailable";

export interface FakeProjectsOptions {
  projects: FakeProjectsMode;
  pick: FakePickMode;
  requirements: FakeRequirementsMode;
  db: FakeDbMode;
}

const DEFAULTS: FakeProjectsOptions = { projects: "many", pick: "fresh", requirements: "saved", db: "ok" };

const PROJECTS_MODES: readonly FakeProjectsMode[] = ["many", "none"];
const FORBIDDEN_REASONS: readonly ProjectForbiddenReason[] = ["drive_root", "home", "claude_dir", "harness_home", "app_data"];
const PICK_MODES: readonly FakePickMode[] = ["fresh", "requirements", "harness", "cancel", ...FORBIDDEN_REASONS];
const REQUIREMENTS_MODES: readonly FakeRequirementsMode[] = ["saved", "absent", "conflict", "unreadable", "too_large"];
const DB_MODES: readonly FakeDbMode[] = ["ok", "read_only", "unavailable"];

/** 주소 쿼리 → 가짜 설정. 모르는 값은 기본값. */
export function parseFakeProjectsQuery(search: string): FakeProjectsOptions {
  const params = new URLSearchParams(search);
  return {
    projects: PROJECTS_MODES.find((mode) => mode === params.get("projects")) ?? DEFAULTS.projects,
    pick: PICK_MODES.find((mode) => mode === params.get("pick")) ?? DEFAULTS.pick,
    requirements: REQUIREMENTS_MODES.find((mode) => mode === params.get("requirements")) ?? DEFAULTS.requirements,
    db: DB_MODES.find((mode) => mode === params.get("db")) ?? DEFAULTS.db,
  };
}

const SKILLS: readonly ProjectSkill[] = ["/desktop-app", "/web-full", "/web-lite"];

/** 진짜 `project_key` 가 하는 일을 흉내: Windows 경로는 대소문자 · `/` · 끝 구분자를 가리지 않는다 */
function pathKey(path: string): string {
  const unified = path.replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/\\$/, "");
  return unified.toLowerCase();
}

function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 진짜 `validate_name` 과 같은 규칙: 앞뒤 공백 제거 · 비면 거절 · 80글자 · 제어 문자 없음 */
function validateName(text: string): string {
  const name = text.trim();
  if (name === "") throw new AppError("invalid_input", "invalid input: project name is empty");
  if ([...name].length > PROJECT_NAME_MAX_CHARS) throw new AppError("invalid_input", "invalid input: project name is too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new AppError("invalid_input", "invalid input: project name has control characters");
  return name;
}

function validateSkill(value: unknown): ProjectSkill {
  const skill = SKILLS.find((candidate) => candidate === value);
  if (!skill) throw new AppError("invalid_input", "invalid input: unknown skill");
  return skill;
}

interface FakeFolder {
  path: string;
  finding: ProjectFolderFinding;
}

/** 가짜 폴더 고르기가 돌려주는 경로 (살펴보기 세 가지). 시제품(`variants/fixtures-workspace.ts`)의 새 프로젝트 창과 같은 경로 */
const PICK_FOLDERS: Record<"fresh" | "requirements" | "harness", FakeFolder> = {
  fresh: { path: "C:\\dev\\cat-diary", finding: "fresh" },
  requirements: { path: "C:\\dev\\recipe-box", finding: "hasRequirements" },
  harness: { path: "C:\\dev\\bakery-booking", finding: "hasHarness" },
};

/** 고를 수 없는 폴더의 가짜 경로 */
const FORBIDDEN_PATHS: Record<ProjectForbiddenReason, string> = {
  drive_root: "C:\\",
  home: "C:\\Users\\me",
  claude_dir: "C:\\Users\\me\\.claude\\agents",
  harness_home: "C:\\Users\\me\\.claude-harness",
  app_data: "C:\\Users\\me\\AppData\\Roaming\\io.github.nerohee.nyanitor",
};

const NOW = 1_800_000_000;

function manyProjects(): ProjectEntry[] {
  const row = (id: number, name: string, path: string, skill: ProjectSkill | null, ageHours: number, folder: ProjectEntry["folder"], finding: ProjectFolderFinding | null): ProjectEntry => ({
    id,
    path,
    name,
    skill,
    createdAt: NOW - 86_400 * 30,
    lastOpenedAt: NOW - 3600 * ageHours,
    folder,
    finding,
  });
  return [
    row(1, "고양이 앨범", "C:\\dev\\cat-album", "/desktop-app", 1, "ok", "hasHarness"),
    row(2, "레시피 상자", "C:\\dev\\recipe-box", "/web-lite", 26, "ok", "hasRequirements"),
    row(3, "쇼핑몰 관리자", "D:\\work\\shop-admin", "/web-full", 96, "missing", null),
    row(4, "빵집 예약", "C:\\dev\\bakery-booking", null, 200, "ok", "fresh"),
  ];
}

const SAMPLE_TEXT = "# 고양이 앨범\n\n우리 집 고양이 사진을 모아 보는 앱.\n\n## 꼭 필요한 것\n- 사진 올리기\n- 날짜별로 보기\n";
const OUTSIDE_TEXT = "# 고양이 앨범\n\n터미널에서 고친 글.\n";

interface FakeFile {
  text: string;
  hasBom: boolean;
  version: number;
  /** `unreadable` 모드의 파일은 UTF-8 이 아니다 */
  state: "ok" | "not_utf8" | "too_large";
  /** `conflict` 모드: 화면이 읽은 뒤 한 번 바깥에서 바뀐다 */
  outsideChangePending: boolean;
}

export function createFakeProjects() {
  /** 시험이 정한 값. 없으면 부를 때마다 주소 쿼리를 읽는다 (화면에서 쿼리를 바꿔 다시 열면 바뀐 값). */
  let override: FakeProjectsOptions | null = null;
  const options = (): FakeProjectsOptions => override ?? parseFakeProjectsQuery(typeof window === "undefined" ? "" : window.location.search);

  let projects: ProjectEntry[] | null = null;
  let nextId = 5;
  let held: FakeFolder | null = null;
  let clock = 0;
  const files = new Map<number, FakeFile>();
  /** 지금 가짜 세션이 돌고 있는 프로젝트 번호 (없으면 null). 가짜 세션(`fakeClaude.ts`)이 `bindSession` 으로 알려 준다 — 서로를 가져오면 돌고 도는 import 라 이쪽에서 받는다 */
  let runningProject: () => number | null = () => null;

  /** 처음 부를 때(또는 `reset` 뒤) 쿼리의 모드로 목록을 채운다 */
  function state(): ProjectEntry[] {
    projects ??= options().projects === "none" ? [] : manyProjects();
    return projects;
  }

  /** 같은 초에 일어난 일도 순서가 보이게 하나씩 늘리는 가짜 시계 */
  function now(): number {
    clock += 1;
    return NOW + clock;
  }

  function checkDb(write: boolean): void {
    const db = options().db;
    if (db === "unavailable") throw new AppError("db_unavailable", "app database is unavailable: fake");
    if (db === "read_only" && write) throw new AppError("db_read_only", "app database is newer than this app; it is read-only");
  }

  function find(id: unknown): ProjectEntry {
    const project = state().find((candidate) => candidate.id === id);
    if (!project) throw new AppError("project_not_found", `project not found: ${String(id)}`);
    return project;
  }

  function fileOf(project: ProjectEntry): FakeFile | null {
    let file = files.get(project.id);
    if (!file) {
      const mode = options().requirements;
      if (mode === "absent" || project.folder === "missing") return null;
      file = {
        text: SAMPLE_TEXT,
        hasBom: false,
        version: 1,
        state: mode === "unreadable" ? "not_utf8" : mode === "too_large" ? "too_large" : "ok",
        outsideChangePending: mode === "conflict",
      };
      files.set(project.id, file);
    }
    return file;
  }

  const versionText = (file: FakeFile) => `fake-${file.version}`;

  /** 폴더가 없어진 프로젝트는 진짜처럼 읽을 수 없음 */
  function missingFolder(project: ProjectEntry): { state: "unreadable"; reason: "folder_missing" } | null {
    return project.folder === "missing" ? { state: "unreadable", reason: "folder_missing" } : null;
  }

  const handlers: Record<string, Handler> = {
    projects_list: (): ProjectList => {
      checkDb(false);
      const sorted = [...state()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt || b.id - a.id);
      return { db: options().db === "read_only" ? "read_only" : "ok", projects: sorted.map((project) => ({ ...project })) };
    },

    project_pick_folder: (): ProjectPickedFolder | null => {
      checkDb(false);
      const mode = options().pick;
      if (mode === "cancel") return null; // 취소는 들고 있는 폴더를 그대로 둔다 (진짜와 같다)
      const reason = FORBIDDEN_REASONS.find((candidate) => candidate === mode);
      if (reason) {
        held = null; // 고를 수 없는 폴더를 고르면 들고 있던 폴더도 비운다
        return { state: "forbidden", path: FORBIDDEN_PATHS[reason], reason };
      }
      const folder = PICK_FOLDERS[mode as "fresh" | "requirements" | "harness"];
      held = folder;
      const existing = state().find((project) => pathKey(project.path) === pathKey(folder.path));
      return { state: "ok", path: folder.path, name: folderName(folder.path), finding: folder.finding, existingId: existing?.id ?? null };
    },

    project_add: (args): ProjectEntry => {
      checkDb(false);
      if (!held) throw new AppError("no_folder_picked", "no folder has been picked");
      const request = (args.request ?? {}) as { name?: string | null; skill?: unknown };
      const name = request.name == null ? folderName(held.path) : validateName(request.name);
      const skill = request.skill == null ? null : validateSkill(request.skill);
      const existing = state().find((project) => pathKey(project.path) === pathKey(held?.path ?? ""));
      if (existing) return { ...existing };
      checkDb(true);
      const created: ProjectEntry = {
        id: nextId++,
        path: held.path,
        name,
        skill,
        createdAt: now(),
        lastOpenedAt: now(),
        folder: "ok",
        finding: held.finding,
      };
      state().push(created);
      return { ...created };
    },

    project_update: (args): ProjectEntry => {
      checkDb(true);
      const patch = (args.patch ?? {}) as { name?: string | null; skill?: unknown };
      const project = find(args.id);
      const name = patch.name == null ? null : validateName(patch.name);
      const skill = patch.skill === undefined ? undefined : patch.skill === null ? null : validateSkill(patch.skill);
      if (name !== null) project.name = name;
      if (skill !== undefined) project.skill = skill;
      return { ...project };
    },

    project_remove: (args): null => {
      // 진짜처럼 그 프로젝트의 세션이 돌고 있으면 (또는 시작 중이면) 맨 먼저 거절 — 아무것도 지우지 않는다
      if (typeof args.id === "number" && runningProject() === args.id) throw new AppError("session_running", "a session is running in this project");
      checkDb(true);
      const project = find(args.id);
      projects = state().filter((candidate) => candidate !== project);
      files.delete(project.id);
      return null;
    },

    project_touch: (args): null => {
      checkDb(true);
      find(args.id).lastOpenedAt = now();
      return null;
    },

    project_requirements_read: (args): RequirementsRead => {
      checkDb(false);
      const project = find(args.id);
      const gone = missingFolder(project);
      if (gone) return gone;
      const file = fileOf(project);
      if (!file) return { state: "absent" };
      if (file.state !== "ok") return { state: "unreadable", reason: file.state };
      const read: RequirementsRead = { state: "ok", text: file.text, version: versionText(file), hasBom: file.hasBom };
      // `conflict` 모드: 읽은 뒤 터미널에서 한 번 바뀐다 → 이 뒤의 `version` 은 바뀐 값, 쓰면 충돌
      if (file.outsideChangePending) {
        file.outsideChangePending = false;
        file.text = OUTSIDE_TEXT;
        file.version += 1;
      }
      return read;
    },

    project_requirements_version: (args): RequirementsVersion => {
      checkDb(false);
      const project = find(args.id);
      const gone = missingFolder(project);
      if (gone) return gone;
      const file = fileOf(project);
      if (!file) return { state: "absent" };
      if (file.state === "too_large") return { state: "unreadable", reason: "too_large" };
      return { state: "ok", version: versionText(file) };
    },

    project_requirements_write: (args): RequirementsWrite => {
      checkDb(false);
      const project = find(args.id);
      if (project.folder === "missing") return { state: "refused", reason: "folder_missing" };
      const text = typeof args.text === "string" ? args.text : "";
      const base = typeof args.baseVersion === "string" ? args.baseVersion : null;
      const file = fileOf(project);
      if (!file) {
        if (base !== null) return { state: "conflict", version: null };
        const created: FakeFile = { text, hasBom: false, version: 1, state: "ok", outsideChangePending: false };
        files.set(project.id, created);
        return { state: "ok", version: versionText(created) };
      }
      if (file.state !== "ok") return { state: "refused", reason: file.state };
      if (base !== versionText(file)) return { state: "conflict", version: versionText(file) };
      if (new TextEncoder().encode(text).length > 1024 * 1024) return { state: "refused", reason: "too_large" };
      // 내용이 같으면 `version` 도 같다 (진짜는 내용 해시)
      if (text !== file.text) {
        file.text = text;
        file.version += 1;
      }
      return { state: "ok", version: versionText(file) };
    },
  };

  return {
    handlers,
    /**
     * 진짜 `projects::existing_dir` 를 흉내: 등록된 프로젝트의 폴더 중 지금 있는 것 (등록 안 된 번호면 `project_not_found`, 폴더가 없어졌으면 `project_folder_missing`).
     * 세션 시작 · 이어 하기가 쓴다 (`fakeClaude.ts`). 세션은 폴더 경로가 아니라 이 번호로만 시작한다 (D-47).
     */
    existingDir(id: unknown): string {
      checkDb(false);
      const project = find(id);
      if (project.folder === "missing") throw new AppError("project_folder_missing", `the project folder does not exist now: project ${project.id}`);
      return project.path;
    },
    /** 진짜 DB 읽기를 흉내: DB 를 못 읽으면(`?db=unavailable`) `db_unavailable`. 채팅 기록 · 츄르 요약이 쓴다 (`fakeHistory.ts`) */
    checkReadable(): void {
      checkDb(false);
    },
    /** 진짜 `projects_store::get` 를 흉내: DB 를 읽을 수 있고 등록된 프로젝트여야 한다 (아니면 `db_unavailable` · `project_not_found`). 채팅 기록이 쓴다 */
    requireRegistered(id: unknown): void {
      checkDb(false);
      find(id);
    },
    /** 폴더가 없어진 프로젝트인가 (등록 안 된 번호면 `project_not_found`). 문서 읽기 가짜가 "읽을 수 없음(folder_missing)" 으로 답하려고 묻는다 (`fakeProgress.ts`) */
    isFolderMissing(id: unknown): boolean {
      return find(id).folder === "missing";
    },
    /** 등록된 프로젝트인가 (던지지 않는다) */
    isRegistered(id: number): boolean {
      return state().some((candidate) => candidate.id === id);
    },
    /** 시작한 프로젝트를 "최근에 연" 으로 적는다 — 진짜처럼 못 적어도 던지지 않고 오류 종류를 돌려준다 (세션은 이미 떴다). 적었으면 null */
    touchQuiet(id: unknown): string | null {
      try {
        checkDb(true);
        find(id).lastOpenedAt = now();
        return null;
      } catch (raw) {
        return raw instanceof AppError ? raw.kind : "internal";
      }
    },
    /** 가짜 세션이 지금 어느 프로젝트에서 돌고 있는지 묻는 길을 이어 준다 (`project_remove` 가 `session_running` 으로 거절하려고). `reset` 으로 끊기지 않는다 */
    bindSession(probe: () => number | null): void {
      runningProject = probe;
    },
    /** 시험용: 쿼리 대신 값을 정하고 모든 가짜 기억(프로젝트 · 고른 폴더 · 파일)을 처음으로 되돌린다 (인자 없이 부르면 다시 쿼리를 읽는다) */
    reset(next?: Partial<FakeProjectsOptions>) {
      override = next ? { ...DEFAULTS, ...next } : null;
      projects = null;
      nextId = 5;
      held = null;
      clock = 0;
      files.clear();
    },
  };
}

export const fakeProjects = createFakeProjects();
