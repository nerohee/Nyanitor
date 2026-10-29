// 프로젝트 등록 · requirements.md IPC (P6-01) — 명령 이름 · 보내는 값(경로 없음), 브라우저 가짜(프로젝트 없음 · 여럿 · 살펴보기 · 편집기 저장 · 충돌 · 주소 쿼리), 출시 빌드에서 가짜로 돌지 않음.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeProjects, parseFakeProjectsQuery } from "./fakeProjects";
import { AppError, PROJECT_NAME_MAX_CHARS, ipc } from "./ipc";

beforeEach(() => {
  fakeProjects.reset();
});

afterEach(() => {
  clearMocks();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
  fakeProjects.reset();
});

describe("프로젝트 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 부르고, 프로젝트 번호 · 이름 · 스킬 · 글 · 버전만 보낸다 (경로 없음)", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    await ipc.projectsList();
    await ipc.projectPickFolder();
    await ipc.projectAdd({ name: "새 이름", skill: "/web-lite" });
    await ipc.projectAdd();
    await ipc.projectUpdate(3, { name: "고침", skill: null });
    await ipc.projectRemove(3);
    await ipc.projectTouch(3);
    await ipc.projectRequirementsRead(3);
    await ipc.projectRequirementsVersion(3);
    await ipc.projectRequirementsWrite(3, "글", "v1");
    await ipc.projectRequirementsWrite(3, "새 파일", null);
    expect(handler.mock.calls).toEqual([
      ["projects_list", {}],
      ["project_pick_folder", {}],
      ["project_add", { request: { name: "새 이름", skill: "/web-lite" } }],
      ["project_add", { request: {} }],
      ["project_update", { id: 3, patch: { name: "고침", skill: null } }],
      ["project_remove", { id: 3 }],
      ["project_touch", { id: 3 }],
      ["project_requirements_read", { id: 3 }],
      ["project_requirements_version", { id: 3 }],
      ["project_requirements_write", { id: 3, text: "글", baseVersion: "v1" }],
      ["project_requirements_write", { id: 3, text: "새 파일", baseVersion: null }],
    ]);
  });

  it("Rust 가 돌려준 모양을 그대로 넘긴다 (고를 수 없는 폴더 · 충돌 · 읽을 수 없음 포함)", async () => {
    const forbidden = { state: "forbidden", path: "C:\\Users\\me", reason: "home" };
    mockIPC(() => forbidden);
    await expect(ipc.projectPickFolder()).resolves.toEqual(forbidden);
    mockIPC(() => ({ state: "conflict", version: null }));
    await expect(ipc.projectRequirementsWrite(1, "x", "v")).resolves.toEqual({ state: "conflict", version: null });
    mockIPC(() => ({ state: "unreadable", reason: "not_utf8" }));
    await expect(ipc.projectRequirementsRead(1)).resolves.toEqual({ state: "unreadable", reason: "not_utf8" });
    mockIPC(() => null);
    await expect(ipc.projectPickFolder()).resolves.toBeNull(); // 취소
  });

  it("새로 생긴 오류 종류를 internal 로 뭉개지 않고 같은 종류의 AppError 로 받는다", async () => {
    for (const kind of ["db_unavailable", "db_read_only", "project_not_found", "no_folder_picked", "folder_dialog_open", "file_write_failed"]) {
      mockIPC(() => {
        throw { kind, message: "m" };
      });
      const error = await ipc.projectsList().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ kind });
    }
  });
});

describe("프로젝트 ipc (브라우저 가짜 모드)", () => {
  it("기본은 여러 프로젝트 — 최근에 연 순서이고, 폴더가 없어진 것이 하나 있다", async () => {
    const list = await ipc.projectsList();
    expect(list.db).toBe("ok");
    expect(list.projects.length).toBeGreaterThanOrEqual(3);
    const opened = list.projects.map((project) => project.lastOpenedAt);
    expect(opened).toEqual([...opened].sort((a, b) => b - a));
    const missing = list.projects.filter((project) => project.folder === "missing");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.finding).toBeNull();
    for (const project of list.projects.filter((p) => p.folder === "ok")) expect(project.finding).not.toBeNull();
    // 살펴보기 세 가지가 모두 나온다
    expect(new Set(list.projects.map((project) => project.finding))).toEqual(new Set(["hasHarness", "hasRequirements", "fresh", null]));
  });

  it("?projects=none 이면 프로젝트가 없다", async () => {
    window.history.replaceState({}, "", "/?projects=none");
    await expect(ipc.projectsList()).resolves.toEqual({ db: "ok", projects: [] });
  });

  it("폴더 고르기는 정해진 가짜 경로를 돌려주고 살펴보기 세 가지를 고를 수 있다", async () => {
    for (const [pick, finding] of [
      ["fresh", "fresh"],
      ["requirements", "hasRequirements"],
      ["harness", "hasHarness"],
    ] as const) {
      fakeProjects.reset({ pick, projects: "none" });
      const picked = await ipc.projectPickFolder();
      expect(picked).toMatchObject({ state: "ok", finding, existingId: null });
      expect(picked && "path" in picked && picked.path).toMatch(/^[A-Z]:\\/);
    }
    // 이미 등록된 폴더를 고르면 그 번호를 알려 준다
    fakeProjects.reset({ pick: "requirements" });
    const existing = await ipc.projectPickFolder();
    expect(existing).toMatchObject({ state: "ok", finding: "hasRequirements" });
    const list = await ipc.projectsList();
    const registered = list.projects.find((project) => project.finding === "hasRequirements");
    expect(existing && "existingId" in existing && existing.existingId).toBe(registered?.id);
  });

  it("취소는 null 이고, 고를 수 없는 폴더는 이유와 함께 돌아온다", async () => {
    fakeProjects.reset({ pick: "cancel" });
    await expect(ipc.projectPickFolder()).resolves.toBeNull();
    for (const reason of ["drive_root", "home", "claude_dir", "harness_home", "app_data"] as const) {
      fakeProjects.reset({ pick: reason });
      await expect(ipc.projectPickFolder()).resolves.toMatchObject({ state: "forbidden", reason });
    }
  });

  it("고른 폴더가 없으면 등록할 수 없고(no_folder_picked), 고르면 그 폴더만 등록한다", async () => {
    fakeProjects.reset({ pick: "fresh", projects: "none" });
    await expect(ipc.projectAdd()).rejects.toMatchObject({ kind: "no_folder_picked" });
    await ipc.projectPickFolder();
    const added = await ipc.projectAdd({ skill: "/desktop-app" });
    expect(added).toMatchObject({ name: "cat-diary", skill: "/desktop-app", folder: "ok", finding: "fresh" });
    // 두 번 눌러도 하나 (이미 있으면 그 프로젝트)
    const again = await ipc.projectAdd();
    expect(again.id).toBe(added.id);
    expect((await ipc.projectsList()).projects).toHaveLength(1);
  });

  it("고를 수 없는 폴더를 고르면 들고 있던 폴더가 비워져 등록되지 않는다", async () => {
    window.history.replaceState({}, "", "/?projects=none&pick=fresh");
    await ipc.projectPickFolder();
    window.history.replaceState({}, "", "/?projects=none&pick=home");
    await expect(ipc.projectPickFolder()).resolves.toMatchObject({ state: "forbidden", reason: "home" });
    await expect(ipc.projectAdd()).rejects.toMatchObject({ kind: "no_folder_picked" });
    expect((await ipc.projectsList()).projects).toEqual([]);
    // 취소는 들고 있는 폴더를 그대로 둔다
    window.history.replaceState({}, "", "/?projects=none&pick=fresh");
    await ipc.projectPickFolder();
    window.history.replaceState({}, "", "/?projects=none&pick=cancel");
    await expect(ipc.projectPickFolder()).resolves.toBeNull();
    await expect(ipc.projectAdd()).resolves.toMatchObject({ name: "cat-diary" });
  });

  it("이미 등록된 폴더를 다시 고르고 등록해도 새로 만들지 않고 그 프로젝트를 돌려준다", async () => {
    fakeProjects.reset({ pick: "requirements" });
    const before = (await ipc.projectsList()).projects;
    await ipc.projectPickFolder();
    const added = await ipc.projectAdd();
    expect(added.path).toBe("C:\\dev\\recipe-box");
    expect(before.some((project) => project.id === added.id)).toBe(true);
    expect((await ipc.projectsList()).projects).toHaveLength(before.length);
  });

  it("이름 · 스킬을 고치고, 규칙에 맞지 않으면 invalid_input", async () => {
    const [first] = (await ipc.projectsList()).projects;
    if (!first) throw new Error("프로젝트가 있어야 한다");
    await expect(ipc.projectUpdate(first.id, { name: "  새 이름  " })).resolves.toMatchObject({ name: "새 이름", skill: first.skill });
    await expect(ipc.projectUpdate(first.id, { skill: null })).resolves.toMatchObject({ name: "새 이름", skill: null });
    await expect(ipc.projectUpdate(first.id, { skill: "/web-full" })).resolves.toMatchObject({ skill: "/web-full" });
    await expect(ipc.projectUpdate(first.id, { name: "   " })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.projectUpdate(first.id, { name: "가".repeat(PROJECT_NAME_MAX_CHARS + 1) })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.projectUpdate(first.id, { name: "가".repeat(PROJECT_NAME_MAX_CHARS) })).resolves.toMatchObject({ skill: "/web-full" });
    await expect(ipc.projectUpdate(first.id, { skill: "/nope" as never })).rejects.toMatchObject({ kind: "invalid_input" });
    await expect(ipc.projectUpdate(9999, { name: "x" })).rejects.toMatchObject({ kind: "project_not_found" });
  });

  it("열면 맨 위로 오고, 빼면 목록에서만 사라진다 (빼고 나면 그 번호는 없는 프로젝트)", async () => {
    const list = (await ipc.projectsList()).projects;
    const last = list[list.length - 1];
    if (!last) throw new Error("프로젝트가 있어야 한다");
    await ipc.projectTouch(last.id);
    expect((await ipc.projectsList()).projects[0]?.id).toBe(last.id);
    await ipc.projectRemove(last.id);
    expect((await ipc.projectsList()).projects.some((project) => project.id === last.id)).toBe(false);
    await expect(ipc.projectRemove(last.id)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.projectTouch(last.id)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.projectRequirementsRead(last.id)).rejects.toMatchObject({ kind: "project_not_found" });
  });

  it("requirements: 읽고 → 저장하면 새 version, 같은 글이면 같은 version, 옛 version 으로 쓰면 충돌", async () => {
    const [first] = (await ipc.projectsList()).projects;
    if (!first) throw new Error("프로젝트가 있어야 한다");
    const read = await ipc.projectRequirementsRead(first.id);
    if (read.state !== "ok") throw new Error("ok 여야 한다");
    expect(read.hasBom).toBe(false);
    expect(read.text.length).toBeGreaterThan(0);
    await expect(ipc.projectRequirementsVersion(first.id)).resolves.toEqual({ state: "ok", version: read.version });

    const same = await ipc.projectRequirementsWrite(first.id, read.text, read.version);
    expect(same).toEqual({ state: "ok", version: read.version });
    const saved = await ipc.projectRequirementsWrite(first.id, `${read.text}\n- 하나 더\n`, read.version);
    if (saved.state !== "ok") throw new Error("ok 여야 한다");
    expect(saved.version).not.toBe(read.version);
    await expect(ipc.projectRequirementsVersion(first.id)).resolves.toEqual({ state: "ok", version: saved.version });
    // 옛 version 으로 쓰면 충돌 — 지금 version 을 알려 준다
    await expect(ipc.projectRequirementsWrite(first.id, "덮어쓰기", read.version)).resolves.toEqual({ state: "conflict", version: saved.version });
    await expect(ipc.projectRequirementsRead(first.id)).resolves.toMatchObject({ state: "ok", text: `${read.text}\n- 하나 더\n` });
  });

  it("?requirements=absent: 파일이 없고, baseVersion 없이 쓰면 새로 만든다 (있다고 알고 쓰면 충돌)", async () => {
    window.history.replaceState({}, "", "/?requirements=absent");
    const [first] = (await ipc.projectsList()).projects;
    if (!first) throw new Error("프로젝트가 있어야 한다");
    await expect(ipc.projectRequirementsRead(first.id)).resolves.toEqual({ state: "absent" });
    await expect(ipc.projectRequirementsVersion(first.id)).resolves.toEqual({ state: "absent" });
    await expect(ipc.projectRequirementsWrite(first.id, "x", "v1")).resolves.toEqual({ state: "conflict", version: null });
    const created = await ipc.projectRequirementsWrite(first.id, "# 처음\n", null);
    expect(created).toMatchObject({ state: "ok" });
    await expect(ipc.projectRequirementsRead(first.id)).resolves.toMatchObject({ state: "ok", text: "# 처음\n" });
    // 이제는 있으므로 baseVersion 없이 쓰면 충돌
    await expect(ipc.projectRequirementsWrite(first.id, "또", null)).resolves.toMatchObject({ state: "conflict" });
  });

  it("?requirements=conflict: 읽은 뒤 바깥에서 바뀌어 version 이 달라지고, 저장하면 충돌", async () => {
    window.history.replaceState({}, "", "/?requirements=conflict");
    const [first] = (await ipc.projectsList()).projects;
    if (!first) throw new Error("프로젝트가 있어야 한다");
    const read = await ipc.projectRequirementsRead(first.id);
    if (read.state !== "ok") throw new Error("ok 여야 한다");
    const polled = await ipc.projectRequirementsVersion(first.id);
    if (polled.state !== "ok") throw new Error("ok 여야 한다");
    expect(polled.version).not.toBe(read.version);
    await expect(ipc.projectRequirementsWrite(first.id, "내 글", read.version)).resolves.toEqual({ state: "conflict", version: polled.version });
    // 바뀐 것을 다시 읽으면 그 version 으로 쓸 수 있다
    const again = await ipc.projectRequirementsRead(first.id);
    expect(again).toMatchObject({ state: "ok", version: polled.version });
    await expect(ipc.projectRequirementsWrite(first.id, "내 글", polled.version)).resolves.toMatchObject({ state: "ok" });
  });

  it("?requirements=unreadable · too_large: 읽을 수 없고 덮어쓰지도 않는다", async () => {
    for (const [mode, reason] of [
      ["unreadable", "not_utf8"],
      ["too_large", "too_large"],
    ] as const) {
      fakeProjects.reset({ requirements: mode });
      const [first] = (await ipc.projectsList()).projects;
      if (!first) throw new Error("프로젝트가 있어야 한다");
      await expect(ipc.projectRequirementsRead(first.id)).resolves.toEqual({ state: "unreadable", reason });
      await expect(ipc.projectRequirementsWrite(first.id, "x", "any")).resolves.toEqual({ state: "refused", reason });
    }
  });

  it("폴더가 없어진 프로젝트의 요구사항은 읽을 수도 쓸 수도 없다 (folder_missing)", async () => {
    const missing = (await ipc.projectsList()).projects.find((project) => project.folder === "missing");
    if (!missing) throw new Error("폴더가 없는 프로젝트가 있어야 한다");
    await expect(ipc.projectRequirementsRead(missing.id)).resolves.toEqual({ state: "unreadable", reason: "folder_missing" });
    await expect(ipc.projectRequirementsVersion(missing.id)).resolves.toEqual({ state: "unreadable", reason: "folder_missing" });
    await expect(ipc.projectRequirementsWrite(missing.id, "x", null)).resolves.toEqual({ state: "refused", reason: "folder_missing" });
  });

  it("?db=read_only: 목록은 되고 알려 주며, 등록 · 고치기 · 빼기 · 열기는 db_read_only", async () => {
    window.history.replaceState({}, "", "/?db=read_only");
    const list = await ipc.projectsList();
    expect(list.db).toBe("read_only");
    const [first] = list.projects;
    if (!first) throw new Error("프로젝트가 있어야 한다");
    await expect(ipc.projectUpdate(first.id, { name: "x" })).rejects.toMatchObject({ kind: "db_read_only" });
    await expect(ipc.projectRemove(first.id)).rejects.toMatchObject({ kind: "db_read_only" });
    await expect(ipc.projectTouch(first.id)).rejects.toMatchObject({ kind: "db_read_only" });
    await ipc.projectPickFolder();
    await expect(ipc.projectAdd()).rejects.toMatchObject({ kind: "db_read_only" });
    // 파일 읽기는 된다
    await expect(ipc.projectRequirementsRead(first.id)).resolves.toMatchObject({ state: "ok" });
  });

  it("?db=unavailable: 모든 프로젝트 명령이 db_unavailable", async () => {
    window.history.replaceState({}, "", "/?db=unavailable");
    await expect(ipc.projectsList()).rejects.toMatchObject({ kind: "db_unavailable" });
    await expect(ipc.projectPickFolder()).rejects.toMatchObject({ kind: "db_unavailable" });
    await expect(ipc.projectRequirementsRead(1)).rejects.toMatchObject({ kind: "db_unavailable" });
  });

  it("reset 으로 정한 값이 쿼리보다 앞서고, 인자 없이 reset 하면 다시 쿼리를 읽는다", async () => {
    window.history.replaceState({}, "", "/?projects=none");
    fakeProjects.reset({ projects: "many" });
    expect((await ipc.projectsList()).projects.length).toBeGreaterThan(0);
    fakeProjects.reset();
    expect((await ipc.projectsList()).projects).toEqual([]);
  });

  it("쿼리 읽기: 모르는 값은 기본값", () => {
    expect(parseFakeProjectsQuery("")).toEqual({ projects: "many", pick: "fresh", requirements: "saved", db: "ok" });
    expect(parseFakeProjectsQuery("?projects=none&pick=harness&requirements=conflict&db=read_only")).toEqual({
      projects: "none",
      pick: "harness",
      requirements: "conflict",
      db: "read_only",
    });
    expect(parseFakeProjectsQuery("?pick=home")).toMatchObject({ pick: "home" });
    expect(parseFakeProjectsQuery("?projects=x&pick=y&requirements=z&db=w")).toEqual({ projects: "many", pick: "fresh", requirements: "saved", db: "ok" });
  });
});

describe("프로젝트 ipc (출시 빌드 · Tauri 밖)", () => {
  it("가짜로 돌지 않고 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.projectsList()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.projectPickFolder()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.projectRequirementsRead(1)).rejects.toMatchObject({ kind: "internal" });
  });
});
