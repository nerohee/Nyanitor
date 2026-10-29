// 세션을 등록된 프로젝트로 시작하는 길 · 스킬 목록 (P6-02) — Tauri 안(`mockIPC`)과 브라우저 가짜 모드
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude, parseFakePlannerQuery } from "./fakeClaude";
import { fakeProjects } from "./fakeProjects";
import { fakeSkills, parseFakeSkillsQuery } from "./fakeSkills";
import { ipc, type ClaudeEvent, type SkillsList } from "./ipc";

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fakeClaude.reset();
  fakeProjects.reset();
  fakeSkills.reset();
});

async function collect() {
  const events: ClaudeEvent[] = [];
  await ipc.onClaudeEvent((event) => events.push(event));
  return events;
}

describe("ipc — 스킬 목록 (Tauri 안)", () => {
  it("skills_list 는 인자 없이 부르고 결과를 그대로 돌려준다", async () => {
    const list: SkillsList = {
      state: "ok",
      skills: [
        { state: "ok", name: "web-full", command: "/web-full", description: "d", argumentHint: "[경로]", origin: "harness", userInvocable: true },
        { state: "unreadable", folder: "broken", origin: "mine", reason: "no_frontmatter" },
      ],
    };
    const handler = vi.fn(() => list);
    mockIPC(handler);
    await expect(ipc.skillsList()).resolves.toEqual(list);
    expect(handler).toHaveBeenCalledWith("skills_list", {});
  });
});

describe("ipc — 세션 시작 (Tauri 안)", () => {
  it("새 오류 종류(폴더 없어짐 · 고를 수 없는 폴더)도 같은 종류의 AppError 로 받는다", async () => {
    for (const kind of ["project_folder_missing", "project_folder_forbidden", "project_not_found"] as const) {
      mockIPC(() => {
        throw { kind, message: "x" };
      });
      await expect(ipc.claudeSessionStart({ projectId: 3 })).rejects.toMatchObject({ kind });
      clearMocks();
    }
  });
});

describe("가짜 세션 — 등록된 프로젝트로만 시작 (브라우저 가짜 모드)", () => {
  it("시작하면 프로젝트 번호 · 폴더 · 쓴 모델 · 수준이 돌아오고 같은 값이 session_started 로 간다", async () => {
    const events = await collect();
    const info = await ipc.claudeSessionStart({ projectId: 1 });
    expect(info).toMatchObject({ projectId: 1, projectDir: "C:\\dev\\cat-album", model: "opus", effort: "high", resumed: false });
    expect(events[0]).toMatchObject({ type: "session_started", projectId: 1, model: "opus", effort: "high" });
    expect(await ipc.claudeSessionState()).toMatchObject({ running: true, projectId: 1, projectDir: "C:\\dev\\cat-album" });
  });

  it("등록 안 된 번호는 project_not_found, 폴더가 없어진 프로젝트는 project_folder_missing 이고 세션이 열리지 않는다", async () => {
    await expect(ipc.claudeSessionStart({ projectId: 99 })).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.claudeSessionStart({ projectId: 0 })).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.claudeSessionStart({ projectId: 3 })).rejects.toMatchObject({ kind: "project_folder_missing" });
    expect((await ipc.claudeSessionState()).running).toBe(false);
    await expect(ipc.claudeLastSession(99)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.claudeLastSession(3)).rejects.toMatchObject({ kind: "project_folder_missing" });
  });

  it("경로 · 모델 · 수준 칸을 끼워 보내면 거절한다 (진짜는 모르는 필드를 받지 않는다)", async () => {
    for (const extra of [{ projectDir: "C:\\evil" }, { model: "haiku" }, { effort: "low" }, { args: ["--dangerously-skip-permissions"] }]) {
      await expect(ipc.claudeSessionStart({ projectId: 1, ...extra } as never)).rejects.toMatchObject({ kind: "invalid_input" });
    }
    expect((await ipc.claudeSessionState()).running).toBe(false);
  });

  it("돌아가는 세션이 있으면 다른 프로젝트도 session_running", async () => {
    await ipc.claudeSessionStart({ projectId: 1 });
    await expect(ipc.claudeSessionStart({ projectId: 2 })).rejects.toMatchObject({ kind: "session_running" });
    expect((await ipc.claudeSessionState()).projectId).toBe(1);
  });

  it("시작하면 그 프로젝트가 '최근에 연' 으로 올라간다 (시작이 실패하면 그대로)", async () => {
    const before = (await ipc.projectsList()).projects.find((project) => project.id === 2)?.lastOpenedAt ?? 0;
    await expect(ipc.claudeSessionStart({ projectId: 2, resume: true })).rejects.toMatchObject({ kind: "no_saved_session" });
    expect((await ipc.projectsList()).projects.find((project) => project.id === 2)?.lastOpenedAt).toBe(before);
    await ipc.claudeSessionStart({ projectId: 2 });
    expect((await ipc.projectsList()).projects[0]?.id).toBe(2);
  });

  it("DB 가 읽기 전용이면 세션은 뜨고 project_touch_failed 알림이 온다", async () => {
    fakeProjects.reset({ db: "read_only" });
    const events = await collect();
    await ipc.claudeSessionStart({ projectId: 1 });
    expect(events).toContainEqual({ type: "warning", code: "project_touch_failed", detail: "db_read_only" });
    expect((await ipc.claudeSessionState()).running).toBe(true);
  });

  it("DB 를 못 쓰면 시작 자체가 db_unavailable (폴더를 짐작하지 않는다)", async () => {
    fakeProjects.reset({ db: "unavailable" });
    await expect(ipc.claudeSessionStart({ projectId: 1 })).rejects.toMatchObject({ kind: "db_unavailable" });
  });

  it("이어 하기는 프로젝트 번호로 — 끝낸 뒤 같은 번호만 이어 하고, 이어 해도 모델 · 수준이 같다", async () => {
    const events = await collect();
    await ipc.claudeSessionStart({ projectId: 1 });
    await ipc.claudeSessionSend("hello");
    await vi.waitFor(() => expect(events.some((e) => e.type === "permission_request")).toBe(true));
    await ipc.claudeSessionStop();
    const saved = await ipc.claudeLastSession(1);
    expect(saved).not.toBeNull();
    expect(await ipc.claudeLastSession(2)).toBeNull();
    await expect(ipc.claudeSessionStart({ projectId: 2, resume: true })).rejects.toMatchObject({ kind: "no_saved_session" });
    const info = await ipc.claudeSessionStart({ projectId: 1, resume: true });
    expect(info).toMatchObject({ resumed: true, resumeSessionId: saved, model: "opus", effort: "high" });
  });
});

describe("가짜 세션 — planner 설정 경계", () => {
  it("쿼리를 읽는다: 모르는 값은 ok", () => {
    expect(parseFakePlannerQuery("?planner=missing")).toBe("missing");
    expect(parseFakePlannerQuery("?planner=odd")).toBe("odd");
    expect(parseFakePlannerQuery("?planner=weird")).toBe("ok");
    expect(parseFakePlannerQuery("")).toBe("ok");
  });

  it("설정이 없으면 모델 · 수준 없이 시작하고 planner_config_missing 알림이 시작 알림 바로 뒤에 온다", async () => {
    fakeClaude.reset({ planner: "missing" });
    const events = await collect();
    const info = await ipc.claudeSessionStart({ projectId: 1 });
    expect(info).toMatchObject({ model: null, effort: null });
    expect(events.map((e) => e.type)).toEqual(["session_started", "warning"]);
    expect(events[1]).toMatchObject({ code: "planner_config_missing" });
  });

  it("값이 이상하면 그 값만 빼고 시작하고 알린다", async () => {
    fakeClaude.reset({ planner: "odd" });
    const events = await collect();
    const info = await ipc.claudeSessionStart({ projectId: 1 });
    expect(info).toMatchObject({ model: null, effort: "high" });
    expect(events[1]).toMatchObject({ type: "warning", code: "planner_model_unusable" });
  });
});

describe("가짜 스킬 목록", () => {
  it("기본은 시제품과 같은 여섯 줄 (하네스 다섯 + 내 것 하나), 이름 순, 명령은 /이름", async () => {
    const list = await ipc.skillsList();
    expect(list.state).toBe("ok");
    const rows = list.skills.map((entry) => (entry.state === "ok" ? [entry.command, entry.origin] : ["?", "?"]));
    expect(rows).toEqual([
      ["/desktop-app", "harness"],
      ["/harness-resume", "harness"],
      ["/harness-setup", "harness"],
      ["/translate-docs", "mine"],
      ["/web-full", "harness"],
      ["/web-lite", "harness"],
    ]);
    for (const entry of list.skills) {
      if (entry.state === "ok") {
        expect(entry.command).toBe(`/${entry.name}`);
        expect(entry.userInvocable).toBe(true);
        expect(entry.description).toBeTruthy();
      }
    }
  });

  it("쿼리: 하네스 없음은 빈 목록과 상태, broken 은 부를 수 없는 것 · 읽을 수 없는 것이 섞인다", async () => {
    expect(parseFakeSkillsQuery("?skills=no_harness")).toBe("no_harness");
    expect(parseFakeSkillsQuery("?skills=nope")).toBe("full");
    fakeSkills.reset("no_harness");
    expect(await ipc.skillsList()).toEqual({ state: "no_harness", skills: [] });
    fakeSkills.reset("broken");
    const broken = await ipc.skillsList();
    expect(broken.skills.some((entry) => entry.state === "unreadable")).toBe(true);
    expect(broken.skills.some((entry) => entry.state === "ok" && !entry.userInvocable)).toBe(true);
  });
});
