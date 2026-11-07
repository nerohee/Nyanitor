// 프로젝트 문서 읽기 IPC (P7-01) — 명령 이름 · 보내는 값(프로젝트 번호와 문서 경로뿐), 브라우저 가짜(하네스 전 · 진행 중 · 답 기다림 · 읽을 수 없음, 문서 없음 · 여럿), 출시 빌드에서 가짜로 돌지 않음.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProgress, parseFakeProgressQuery } from "./fakeProgress";
import { fakeProjects } from "./fakeProjects";
import { ipc } from "./ipc";

function reset() {
  fakeProjects.reset();
  fakeProgress.reset();
}

beforeEach(reset);

afterEach(() => {
  clearMocks();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
  reset();
});

/** 폴더가 있는 첫 프로젝트 번호 */
async function projectId(): Promise<number> {
  const found = (await ipc.projectsList()).projects.find((project) => project.folder === "ok");
  if (!found) throw new Error("프로젝트가 있어야 한다");
  return found.id;
}

describe("문서 읽기 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 부르고, 프로젝트 번호 (와 문서 경로) 만 보낸다", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    await ipc.projectProgressRead(3);
    await ipc.projectProgressVersion(3);
    await ipc.projectDocsList(3);
    await ipc.projectDocRead(3, "02-development/dev-plan.md");
    expect(handler.mock.calls).toEqual([
      ["project_progress_read", { id: 3 }],
      ["project_progress_version", { id: 3 }],
      ["project_docs_list", { id: 3 }],
      ["project_doc_read", { id: 3, path: "02-development/dev-plan.md" }],
    ]);
  });

  it("Rust 가 돌려준 모양을 그대로 넘긴다 (읽을 수 없음 · 일부만 읽음 포함)", async () => {
    const read = {
      version: "951-abc",
      plan: { state: "unreadable", reason: "header_mismatch" },
      handoff: { state: "ok", skill: null, requirements: null, phase: null, updated: null, current: { state: "unreadable", reason: "no_item" }, tasks: { state: "ok", value: [] }, waiting: { state: "ok", value: [] }, next: { state: "unreadable", reason: "no_section" } },
    };
    mockIPC(() => read);
    await expect(ipc.projectProgressRead(1)).resolves.toEqual(read);
    mockIPC(() => "951-abc");
    await expect(ipc.projectProgressVersion(1)).resolves.toBe("951-abc");
    mockIPC(() => ({ state: "unreadable", reason: "outside_folder" }));
    await expect(ipc.projectDocRead(1, "a.md")).resolves.toEqual({ state: "unreadable", reason: "outside_folder" });
    mockIPC(() => ({ state: "absent" }));
    await expect(ipc.projectDocsList(1)).resolves.toEqual({ state: "absent" });
  });

  it("Rust 의 오류(경로 모양이 틀림 · 등록 안 된 번호 · 고를 수 없는 폴더)를 같은 종류의 AppError 로 받는다", async () => {
    for (const kind of ["invalid_input", "project_not_found", "project_folder_forbidden", "db_unavailable"]) {
      mockIPC(() => {
        throw { kind, message: "m" };
      });
      await expect(ipc.projectDocRead(1, "../x.md")).rejects.toMatchObject({ kind });
      await expect(ipc.projectProgressRead(1)).rejects.toMatchObject({ kind });
    }
  });
});

describe("진행 읽기 (브라우저 가짜 모드)", () => {
  it("기본은 진행 중 — 단계 12개 (P0 ~ P6 완료 · P7 진행 중), 작업 여럿에 진행률이 있다", async () => {
    const read = await ipc.projectProgressRead(await projectId());
    if (read.plan.state !== "ok") throw new Error("plan 이 읽혀야 한다");
    expect(read.plan.phases.map((phase) => phase.id)).toEqual(["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]);
    expect(read.plan.phases.map((phase) => phase.status)).toEqual([...Array<string>(7).fill("done"), "now", "todo", "todo", "todo", "todo"]);
    // 담당은 차례(→)와 함께(·)의 2차원 목록 + 원래 글
    const p3 = read.plan.phases[3];
    expect(p3?.owners).toEqual([["system"], ["tester"], ["reviewer"]]);
    expect(p3?.ownersText).toBe("system → tester → reviewer");
    expect(read.plan.phases[9]?.owners).toEqual([["system", "ui"], ["tester"]]);
    // 칸 안의 `|` 가 있던 상태 글은 이어 붙여 한 칸
    expect(read.plan.phases[6]?.statusText).toContain("[채팅 | 요구사항]");

    if (read.handoff.state !== "ok") throw new Error("handoff 가 읽혀야 한다");
    expect(read.handoff.current).toEqual({ state: "ok", value: expect.objectContaining({ state: "working" }) });
    if (read.handoff.tasks.state !== "ok") throw new Error("tasks 가 읽혀야 한다");
    const tasks = read.handoff.tasks.value;
    expect(tasks.some((task) => task.progress !== null && task.progress.total > 0)).toBe(true);
    // 끝난 작업은 진행률이 null, 경로가 없는 줄은 brief 도 id 도 null
    expect(tasks.find((task) => task.status === "passed")?.progress).toBeNull();
    const labelOnly = tasks.find((task) => task.brief === null);
    expect(labelOnly).toMatchObject({ id: null, phase: null });
    expect(new Set(tasks.map((task) => task.status))).toEqual(new Set(["assigned", "back", "redo", "passed", "unknown"]));
    expect(read.handoff.waiting).toEqual({ state: "ok", value: [] });
  });

  it("version: 같은 문서면 같은 값이고, 문서가 바뀌면 달라진다 (읽기가 준 값 = 물음의 값)", async () => {
    const id = await projectId();
    const read = await ipc.projectProgressRead(id);
    await expect(ipc.projectProgressVersion(id)).resolves.toBe(read.version);
    await expect(ipc.projectProgressVersion(id)).resolves.toBe(read.version);
    fakeProgress.touch();
    const changed = await ipc.projectProgressVersion(id);
    expect(changed).not.toBe(read.version);
    expect((await ipc.projectProgressRead(id)).version).toBe(changed);
  });

  it("?progress=none: 하네스 전 — 둘 다 absent", async () => {
    window.history.replaceState({}, "", "/?progress=none");
    const read = await ipc.projectProgressRead(await projectId());
    expect(read.plan).toEqual({ state: "absent" });
    expect(read.handoff).toEqual({ state: "absent" });
  });

  it("?progress=waiting: 사용자 답을 기다린다 — 기다리는 것이 있다", async () => {
    window.history.replaceState({}, "", "/?progress=waiting");
    const read = await ipc.projectProgressRead(await projectId());
    if (read.handoff.state !== "ok") throw new Error("handoff 가 읽혀야 한다");
    expect(read.handoff.current).toEqual({ state: "ok", value: expect.objectContaining({ state: "waiting_answer" }) });
    if (read.handoff.waiting.state !== "ok") throw new Error("waiting 이 읽혀야 한다");
    expect(read.handoff.waiting.value.length).toBeGreaterThan(0);
  });

  it("?progress=unreadable: 단계 표만 읽을 수 없다 (이유가 있다) — 메모는 읽힌다", async () => {
    window.history.replaceState({}, "", "/?progress=unreadable");
    const read = await ipc.projectProgressRead(await projectId());
    expect(read.plan).toEqual({ state: "unreadable", reason: "header_mismatch" });
    expect(read.handoff.state).toBe("ok");
  });

  it("?progress=memo_unreadable: 메모만 읽을 수 없다 — 단계 표는 읽힌다", async () => {
    window.history.replaceState({}, "", "/?progress=memo_unreadable");
    const read = await ipc.projectProgressRead(await projectId());
    expect(read.plan.state).toBe("ok");
    expect(read.handoff).toEqual({ state: "unreadable", reason: "no_section" });
  });

  it("폴더가 없어진 프로젝트는 둘 다 읽을 수 없음 (folder_missing) — 오류가 아니다", async () => {
    const missing = (await ipc.projectsList()).projects.find((project) => project.folder === "missing");
    if (!missing) throw new Error("폴더가 없는 프로젝트가 있어야 한다");
    const gone = { state: "unreadable", reason: "folder_missing" };
    await expect(ipc.projectProgressRead(missing.id)).resolves.toMatchObject({ plan: gone, handoff: gone });
    await expect(ipc.projectDocsList(missing.id)).resolves.toEqual(gone);
    await expect(ipc.projectDocRead(missing.id, "a.md")).resolves.toEqual(gone);
    await expect(ipc.projectProgressVersion(missing.id)).resolves.toEqual(expect.any(String));
  });

  it("등록 안 된 번호는 모든 명령이 project_not_found, DB 를 못 읽으면 db_unavailable", async () => {
    await expect(ipc.projectProgressRead(9999)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.projectProgressVersion(9999)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.projectDocsList(9999)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.projectDocRead(9999, "a.md")).rejects.toMatchObject({ kind: "project_not_found" });
    // 번호가 틀리면 경로 모양보다 먼저 거절 (진짜와 같은 차례)
    await expect(ipc.projectDocRead(9999, "../x")).rejects.toMatchObject({ kind: "project_not_found" });
    window.history.replaceState({}, "", "/?db=unavailable");
    await expect(ipc.projectProgressRead(1)).rejects.toMatchObject({ kind: "db_unavailable" });
    await expect(ipc.projectDocsList(1)).rejects.toMatchObject({ kind: "db_unavailable" });
  });
});

describe("문서 읽기 (브라우저 가짜 모드)", () => {
  it("기본은 여럿 — 폴더 깊이가 있고 경로 순이며, 읽을 수 없는 문서가 하나 있다", async () => {
    const list = await ipc.projectDocsList(await projectId());
    if (list.state !== "ok") throw new Error("목록이 나와야 한다");
    expect(list).toMatchObject({ docsDir: "docs", truncated: false });
    const paths = list.files.map((file) => file.path);
    expect(paths.length).toBeGreaterThanOrEqual(6);
    expect(paths).toEqual([...paths].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(paths.some((path) => path.split("/").length >= 3)).toBe(true); // 폴더 깊이
    expect(paths.every((path) => path.endsWith(".md") && !path.includes("\\") && !path.startsWith("/"))).toBe(true);
    for (const file of list.files) {
      expect(file.size).toBeGreaterThanOrEqual(0);
      expect(file.modified).toEqual(expect.any(Number));
    }
  });

  it("목록의 경로는 모두 읽힌다 — 읽을 수 없는 것 하나만 빼고 (not_utf8)", async () => {
    const id = await projectId();
    const list = await ipc.projectDocsList(id);
    if (list.state !== "ok") throw new Error("목록이 나와야 한다");
    const unreadable: string[] = [];
    for (const file of list.files) {
      const read = await ipc.projectDocRead(id, file.path);
      if (read.state === "ok") {
        expect(read.text.length).toBeGreaterThan(0);
        expect(read.version).not.toBe("");
      } else {
        expect(read).toEqual({ state: "unreadable", reason: "not_utf8" });
        unreadable.push(file.path);
      }
    }
    expect(unreadable).toHaveLength(1);
  });

  it("목록에 없는 (모양은 맞는) 경로는 absent", async () => {
    await expect(ipc.projectDocRead(await projectId(), "no-such/file.md")).resolves.toEqual({ state: "absent" });
  });

  it("경로 모양이 틀리면 invalid_input — 빈 값 · 절대 경로 · 드라이브 · .. · \\ · 숨은 이름 · .md 아님", async () => {
    const id = await projectId();
    for (const path of ["", "  ", "/a.md", "C:/a.md", "C:\\a.md", "../a.md", "sub/../a.md", "sub\\a.md", "a//b.md", ".hidden/a.md", "a.txt", "a.md.", "sub/"]) {
      await expect(ipc.projectDocRead(id, path), path).rejects.toMatchObject({ kind: "invalid_input" });
    }
  });

  it("?docs=none: docs 폴더가 없다 — 목록도 읽기도 absent", async () => {
    window.history.replaceState({}, "", "/?docs=none");
    const id = await projectId();
    await expect(ipc.projectDocsList(id)).resolves.toEqual({ state: "absent" });
    await expect(ipc.projectDocRead(id, "README.md")).resolves.toEqual({ state: "absent" });
  });
});

describe("가짜 설정", () => {
  it("쿼리 읽기: 모르는 값은 기본값", () => {
    expect(parseFakeProgressQuery("")).toEqual({ progress: "running", docs: "many" });
    expect(parseFakeProgressQuery("?progress=waiting&docs=none")).toEqual({ progress: "waiting", docs: "none" });
    for (const progress of ["running", "none", "waiting", "unreadable", "memo_unreadable"] as const) {
      expect(parseFakeProgressQuery(`?progress=${progress}`).progress).toBe(progress);
    }
    expect(parseFakeProgressQuery("?progress=x&docs=y")).toEqual({ progress: "running", docs: "many" });
  });

  it("reset 으로 정한 값이 쿼리보다 앞서고, 인자 없이 reset 하면 다시 쿼리를 읽는다", async () => {
    window.history.replaceState({}, "", "/?progress=none");
    fakeProgress.reset({ progress: "running" });
    const id = await projectId();
    expect((await ipc.projectProgressRead(id)).plan.state).toBe("ok");
    fakeProgress.reset();
    expect((await ipc.projectProgressRead(id)).plan.state).toBe("absent");
  });
});

describe("문서 읽기 ipc (출시 빌드 · Tauri 밖)", () => {
  it("가짜로 돌지 않고 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.projectProgressRead(1)).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.projectProgressVersion(1)).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.projectDocsList(1)).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.projectDocRead(1, "a.md")).rejects.toMatchObject({ kind: "internal" });
  });
});
