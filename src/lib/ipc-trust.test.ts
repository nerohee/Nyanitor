// 프로젝트 폴더 신뢰 IPC (P10-03, D-54) — 명령 이름 · 보내는 값(번호 · 해시뿐), Rust 모양 그대로, 브라우저 가짜(확인 전 시작 거절 · 확인 뒤 시작 · 바뀐 설정 · 주소 쿼리).
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClaude } from "./fakeClaude";
import { fakeProjects, parseFakeProjectsQuery } from "./fakeProjects";
import { AppError, ipc, type TrustCheck } from "./ipc";

const TRUST_PROJECT = 4;

beforeEach(() => {
  fakeClaude.reset();
  fakeProjects.reset();
});

afterEach(() => {
  clearMocks();
  window.history.replaceState({}, "", "/");
  fakeClaude.reset();
  fakeProjects.reset();
});

describe("폴더 신뢰 ipc (Tauri 안)", () => {
  it("정해진 명령을 부르고 프로젝트 번호와 해시만 보낸다 (경로 · 설정 글 없음)", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    const hash = "a".repeat(64);
    await ipc.projectTrustCheck(4);
    await ipc.projectTrustGrant(4, hash);
    expect(handler.mock.calls).toEqual([
      ["project_trust_check", { id: 4 }],
      ["project_trust_grant", { id: 4, hash }],
    ]);
  });

  it("Rust 가 돌려준 모양을 그대로 넘긴다", async () => {
    const check: TrustCheck = {
      required: true,
      hash: "c".repeat(64),
      summary: {
        files: [
          {
            scope: "repo_root",
            folder: "C:\\dev\\repo",
            path: ".claude/settings.local.json",
            unreadable: null,
            hooks: { items: [{ event: "Stop", matcher: "Bash", kind: "command", text: "echo hi" }], more: 0 },
            commands: { items: [], more: 0 },
            allow: { items: ["Bash(*)"], more: 12 },
            permissionModes: [{ key: "permissions.defaultMode", value: "bypassPermissions" }],
            additionalDirectories: { items: [], more: 0 },
            mcpServers: { items: [], more: 0 },
            plugins: { items: [], more: 0 },
            marketplaces: { items: [], more: 0 },
            switches: { items: [], more: 0 },
            envNames: { items: ["HTTPS_PROXY"], more: 0 },
            oddKeys: [],
          },
        ],
      },
    };
    mockIPC(() => check);
    await expect(ipc.projectTrustCheck(1)).resolves.toEqual(check);
  });

  it("새 오류 종류(trust_required · trust_changed)를 internal 로 뭉개지 않고 같은 종류의 AppError 로 받는다", async () => {
    for (const kind of ["trust_required", "trust_changed", "invalid_input", "project_folder_forbidden", "db_read_only"]) {
      mockIPC(() => {
        throw { kind, message: "m" };
      });
      await expect(ipc.projectTrustGrant(1, "a".repeat(64))).rejects.toMatchObject({ kind });
      await expect(ipc.claudeSessionStart({ projectId: 1 })).rejects.toMatchObject({ kind });
    }
  });
});

describe("폴더 신뢰 가짜 (브라우저)", () => {
  it("기본: 4번 프로젝트는 확인이 필요하고, 요약에 훅 · 허용 규칙 · 권한 모드 · env 이름 · MCP 서버가 있다 (env 값은 없다)", async () => {
    const check = await ipc.projectTrustCheck(TRUST_PROJECT);
    expect(check.required).toBe(true);
    expect(check.hash).toMatch(/^[0-9a-f]{64}$/);
    const [settings, mcp, top] = check.summary.files;
    expect(settings?.scope).toBe("project");
    expect(settings?.folder).toBeNull();
    // 저장소 맨 위의 settings.local.json 은 프로젝트 밖 파일로 구분된다
    expect(top).toMatchObject({ scope: "repo_root", path: ".claude/settings.local.json" });
    expect(top?.folder).toEqual(expect.any(String));
    expect(settings?.path).toBe(".claude/settings.json");
    expect(settings?.hooks.items[0]).toMatchObject({ event: "SessionStart", matcher: null, kind: "command" });
    expect(settings?.allow.items.length).toBeGreaterThan(0);
    expect(settings?.permissionModes[0]?.key).toBe("permissions.defaultMode");
    expect(settings?.envNames.items).toContain("ANTHROPIC_BASE_URL");
    expect(mcp?.path).toBe(".mcp.json");
    expect(mcp?.mcpServers.items[0]?.name).toBe("files");
    // 다른 프로젝트는 확인할 것이 없다 (요약도 비어 있다)
    const plain = await ipc.projectTrustCheck(1);
    expect(plain).toEqual({ required: false, hash: "0".repeat(64), summary: { files: [] } });
  });

  it("확인 전에는 세션을 시작할 수 없고(trust_required), 확인하면 시작한다 — 이어 하기도 같다", async () => {
    await expect(ipc.claudeSessionStart({ projectId: TRUST_PROJECT })).rejects.toMatchObject({ kind: "trust_required" });
    await expect(ipc.claudeSessionStart({ projectId: TRUST_PROJECT, resume: true })).rejects.toMatchObject({ kind: "trust_required" });
    // 확인이 필요 없는 프로젝트는 그대로 시작한다
    const first = await ipc.claudeSessionStart({ projectId: 1 });
    expect(first.projectId).toBe(1);
    await ipc.claudeSessionStop();

    const check = await ipc.projectTrustCheck(TRUST_PROJECT);
    await ipc.projectTrustGrant(TRUST_PROJECT, check.hash);
    expect((await ipc.projectTrustCheck(TRUST_PROJECT)).required).toBe(false);
    const info = await ipc.claudeSessionStart({ projectId: TRUST_PROJECT });
    expect(info.projectId).toBe(TRUST_PROJECT);
  });

  it("해시가 지금과 다르면 거절한다 (trust_changed) — 모양이 틀린 해시는 invalid_input", async () => {
    for (const bad of ["", "abc", "A".repeat(64), "../x"]) {
      await expect(ipc.projectTrustGrant(TRUST_PROJECT, bad), bad).rejects.toMatchObject({ kind: "invalid_input" });
    }
    await expect(ipc.projectTrustGrant(TRUST_PROJECT, "0".repeat(64))).rejects.toMatchObject({ kind: "trust_changed" });
    expect((await ipc.projectTrustCheck(TRUST_PROJECT)).required).toBe(true);
  });

  it("화면이 본 뒤에 설정이 바뀌면 옛 해시의 확인은 거절되고, 새로 읽으면 다시 확인할 수 있다", async () => {
    const seen = await ipc.projectTrustCheck(TRUST_PROJECT);
    await ipc.projectTrustGrant(TRUST_PROJECT, seen.hash);
    fakeProjects.changeTrustedSettings();
    // 바뀌었으니 다시 확인이 필요하다
    await expect(ipc.claudeSessionStart({ projectId: TRUST_PROJECT })).rejects.toMatchObject({ kind: "trust_required" });
    await expect(ipc.projectTrustGrant(TRUST_PROJECT, seen.hash)).rejects.toMatchObject({ kind: "trust_changed" });
    const fresh = await ipc.projectTrustCheck(TRUST_PROJECT);
    expect(fresh.hash).not.toBe(seen.hash);
    await ipc.projectTrustGrant(TRUST_PROJECT, fresh.hash);
    await expect(ipc.claudeSessionStart({ projectId: TRUST_PROJECT })).resolves.toMatchObject({ projectId: TRUST_PROJECT });
  });

  it("진짜처럼 등록 안 된 번호 · 폴더 없어짐 · DB 읽기 전용을 가른다", async () => {
    await expect(ipc.projectTrustCheck(9999)).rejects.toMatchObject({ kind: "project_not_found" });
    await expect(ipc.projectTrustGrant(9999, "a".repeat(64))).rejects.toMatchObject({ kind: "project_not_found" });
    // 폴더가 없어진 3번
    await expect(ipc.projectTrustCheck(3)).rejects.toMatchObject({ kind: "project_folder_missing" });
    // DB 가 읽기 전용이면 확인은 저장하지 못한다
    fakeProjects.reset({ db: "read_only" });
    const check = await ipc.projectTrustCheck(TRUST_PROJECT);
    await expect(ipc.projectTrustGrant(TRUST_PROJECT, check.hash)).rejects.toMatchObject({ kind: "db_read_only" });
    fakeProjects.reset({ db: "unavailable" });
    await expect(ipc.projectTrustCheck(TRUST_PROJECT)).rejects.toMatchObject({ kind: "db_unavailable" });
  });

  it("?trust=none 이면 확인이 필요한 폴더가 없다 (쿼리를 모르는 값이면 기본)", async () => {
    expect(parseFakeProjectsQuery("?trust=none").trust).toBe("none");
    expect(parseFakeProjectsQuery("?trust=nope").trust).toBe("required");
    expect(parseFakeProjectsQuery("").trust).toBe("required");
    fakeProjects.reset({ trust: "none" });
    expect((await ipc.projectTrustCheck(TRUST_PROJECT)).required).toBe(false);
    await expect(ipc.claudeSessionStart({ projectId: TRUST_PROJECT })).resolves.toMatchObject({ projectId: TRUST_PROJECT });
  });

  it("출시 빌드(가짜 없음)에서는 Tauri 밖에서 AppError 가 난다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.projectTrustCheck(1)).rejects.toBeInstanceOf(AppError);
    vi.unstubAllEnvs();
  });
});
