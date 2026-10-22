// 하네스 IPC (P4-02) — 명령 이름 · 인자, 브라우저 가짜 하네스(진짜와 같은 규칙), 출시 빌드에서 가짜로 돌지 않음.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeHarness } from "./fakeHarness";
import { AppError, ipc } from "./ipc";

beforeEach(() => {
  fakeHarness.reset();
});

afterEach(() => {
  clearMocks();
  vi.unstubAllEnvs();
});

describe("하네스 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 부르고, 넘기는 인자는 백업 번호 하나뿐이다", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    await ipc.harnessStatus();
    await ipc.harnessClone();
    await ipc.harnessUpdateCheck();
    await ipc.harnessUpdatePull();
    await ipc.harnessInstallPlan();
    await ipc.harnessInstall();
    await ipc.harnessBackups();
    await ipc.harnessRestorePlan("2026-10-18_143205");
    await ipc.harnessRestore("2026-10-18_143205");
    expect(handler.mock.calls).toEqual([
      ["harness_status", {}],
      ["harness_clone", {}],
      ["harness_update_check", {}],
      ["harness_update_pull", {}],
      ["harness_install_plan", {}],
      ["harness_install", {}],
      ["harness_backups", {}],
      ["harness_restore_plan", { backupId: "2026-10-18_143205" }],
      ["harness_restore", { backupId: "2026-10-18_143205" }],
    ]);
  });

  it("Rust 의 { kind: 'harness_busy' } 오류를 같은 종류의 AppError 로 받는다", async () => {
    mockIPC(() => {
      throw { kind: "harness_busy", message: "another harness task is in progress" };
    });
    const error = await ipc.harnessInstall().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: "harness_busy" });
  });

  it("모르는 값이 섞인 결과도 그대로 돌려준다 (화면이 글 그대로 보인다)", async () => {
    const odd = { outcome: "teleported", reason: "newReason", detail: null, head: null, before: null, update: null };
    mockIPC(() => odd);
    await expect(ipc.harnessClone()).resolves.toEqual(odd);
  });
});

describe("하네스 ipc (브라우저 가짜 하네스)", () => {
  it("받기 → 설치 미리보기 → 설치 → 다시 미리보기는 같음 → 백업 → 되돌리기 흐름이 진짜 계약대로 돈다", async () => {
    expect((await ipc.harnessInstallPlan()).outcome).toBe("no_script"); // 원본을 받기 전
    expect((await ipc.harnessClone()).outcome).toBe("cloned");
    expect((await ipc.harnessClone()).outcome).toBe("already_present");

    const plan = await ipc.harnessInstallPlan();
    expect(plan.outcome).toBe("ran");
    expect(plan.report?.dryRun).toBe(true);
    expect(plan.report?.counts.add).toBe(3);
    expect(plan.report?.contract).toBe(1);
    expect(JSON.parse(plan.raw ?? "{}")).toMatchObject({ command: "install", dryRun: true });

    const done = await ipc.harnessInstall();
    expect(done.report?.dryRun).toBe(false);
    expect(done.report?.backup?.id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{6}$/);

    const again = await ipc.harnessInstallPlan();
    expect(again.report?.same).toBe(true);

    const list = await ipc.harnessBackups();
    const id = list.report?.backups[0]?.id ?? "";
    expect(id).toBe(done.report?.backup?.id);
    const preview = await ipc.harnessRestorePlan(id);
    expect(preview.report?.dryRun).toBe(true);
    expect((await ipc.harnessRestore(id)).report?.dryRun).toBe(false);
  });

  it("개발자 모드에서는 받기 · 업데이트를 하지 않고 알리기만 한다", async () => {
    fakeHarness.reset({ developer: true });
    for (const call of [ipc.harnessClone, ipc.harnessUpdateCheck, ipc.harnessUpdatePull]) {
      expect((await call()).outcome).toBe("developer_mode");
    }
    expect((await ipc.harnessStatus()).developerMode).toBe(true);
  });

  it("git 이 없으면 git_missing, 원본이 없으면 repo_missing", async () => {
    fakeHarness.reset({ gitMissing: true });
    expect((await ipc.harnessClone()).outcome).toBe("git_missing");
    fakeHarness.reset();
    expect((await ipc.harnessUpdateCheck()).outcome).toBe("repo_missing");
    expect((await ipc.harnessUpdatePull()).outcome).toBe("repo_missing");
  });

  it("잘못된 백업 번호와 목록에 없는 번호는 invalid_input 으로 거절한다 (진짜와 같은 규칙)", async () => {
    await ipc.harnessClone();
    await ipc.harnessInstallPlan();
    await ipc.harnessInstall();
    for (const bad of ["", "..", "..\\x", "../x", "2026-10-18_143205; calc", "latest", "2026-13-01_000000"]) {
      await expect(ipc.harnessRestore(bad), bad).rejects.toMatchObject({ kind: "invalid_input" });
      await expect(ipc.harnessRestorePlan(bad), bad).rejects.toMatchObject({ kind: "invalid_input" });
    }
    // 모양은 맞지만 목록에 없다 — 미리보기는 오류, 되돌리기는 (진짜처럼) 미리보기를 본 적이 없다는 거절이 먼저다
    await expect(ipc.harnessRestorePlan("2026-01-01_000000")).rejects.toMatchObject({ kind: "invalid_input" });
    expect(await ipc.harnessRestore("2026-01-01_000000")).toMatchObject({ outcome: "refused", reason: "plan_first" });
  });

  it("한 번에 하나: 도는 중에 다른 하네스 일을 시키면 harness_busy", async () => {
    const results = await Promise.allSettled([ipc.harnessClone(), ipc.harnessBackups()]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ kind: "harness_busy" });
    // 끝난 뒤에는 다시 된다
    await expect(ipc.harnessBackups()).resolves.toMatchObject({ outcome: "ran" });
    // 읽기만 하는 상태는 잠그지 않는다
    const during = Promise.allSettled([ipc.harnessUpdateCheck(), ipc.harnessStatus()]);
    expect((await during)[1]?.status).toBe("fulfilled");
  });

  it("스크립트 출력이 깨진 경우를 흉내 낸 결과는 '읽을 수 없음' 모양이다", async () => {
    fakeHarness.reset({ developer: true, unreadable: true });
    const plan = await ipc.harnessInstallPlan();
    expect(plan.outcome).toBe("unreadable");
    expect(plan.report).toBeNull();
    expect(plan.unreadable?.reason).toBe("bad_json");
  });

  it("12개를 넘으면 설치 결과에 정리한 수가 들어간다", async () => {
    fakeHarness.reset({ startBackups: 12 });
    await ipc.harnessClone();
    await ipc.harnessInstallPlan();
    const done = await ipc.harnessInstall();
    expect(done.prune).toMatchObject({ removed: 1, kept: 12 });
    expect((await ipc.harnessBackups()).report?.backups).toHaveLength(12);
  });
});

describe("하네스 ipc (브라우저 가짜 하네스) — 본 것만 한다", () => {
  it("받기는 확인 뒤에만, 확인은 한 번 쓰면 없어지고, 받으면 실제로 받은 커밋이 온다", async () => {
    await ipc.harnessClone();
    // 확인 없이 받기
    expect(await ipc.harnessUpdatePull()).toMatchObject({ outcome: "refused", reason: "check_first" });

    const check = await ipc.harnessUpdateCheck();
    expect(check.update?.upstreamHash).toMatch(/^[0-9a-f]{40}$/);
    const pulled = await ipc.harnessUpdatePull();
    expect(pulled.outcome).toBe("updated");
    expect(pulled.pulledTotal).toBe(2);
    expect(pulled.pulled.map((c) => c.hash)).toEqual(["b2c3d4e", "9f8e7d6"]);

    // 받은 뒤 다시 받기는 거절
    expect(await ipc.harnessUpdatePull()).toMatchObject({ outcome: "refused", reason: "check_first" });
    // 새로 확인하면 최신 — 그때의 받기는 할 일이 없다
    await ipc.harnessUpdateCheck();
    expect(await ipc.harnessUpdatePull()).toMatchObject({ outcome: "up_to_date", pulled: [], pulledTotal: 0 });
  });

  it("설치는 미리보기 뒤에만 한 번, 미리보기를 읽을 수 없었으면 그것도 본 것이 아니다", async () => {
    await ipc.harnessClone();
    expect(await ipc.harnessInstall()).toMatchObject({ outcome: "refused", reason: "plan_first", report: null });
    await ipc.harnessInstallPlan();
    expect((await ipc.harnessInstall()).outcome).toBe("ran");
    expect(await ipc.harnessInstall()).toMatchObject({ outcome: "refused", reason: "plan_first" });

    fakeHarness.reset({ developer: true, unreadable: true });
    expect((await ipc.harnessInstallPlan()).outcome).toBe("unreadable");
    expect(await ipc.harnessInstall()).toMatchObject({ outcome: "refused", reason: "plan_first" });
  });

  it("업데이트를 받으면 앞서 본 설치 미리보기도 낡는다", async () => {
    await ipc.harnessClone();
    await ipc.harnessUpdateCheck();
    await ipc.harnessInstallPlan();
    expect((await ipc.harnessUpdatePull()).outcome).toBe("updated");
    expect(await ipc.harnessInstall()).toMatchObject({ outcome: "refused", reason: "plan_first" });
  });

  it("설치하면 앞서 한 업데이트 확인도 낡는다", async () => {
    await ipc.harnessClone();
    await ipc.harnessUpdateCheck();
    await ipc.harnessInstallPlan();
    await ipc.harnessInstall();
    expect(await ipc.harnessUpdatePull()).toMatchObject({ outcome: "refused", reason: "check_first" });
  });

  it("되돌리기는 같은 번호의 되돌리기 미리보기 뒤에만 한 번", async () => {
    fakeHarness.reset({ startBackups: 2 });
    await ipc.harnessClone();
    const ids = ((await ipc.harnessBackups()).report?.backups ?? []).map((b) => b.id);
    const [first, second] = ids;
    expect(first && second).toBeTruthy();
    expect(await ipc.harnessRestore(first as string)).toMatchObject({ outcome: "refused", reason: "plan_first" });
    await ipc.harnessRestorePlan(first as string);
    // 다른 번호는 안 된다
    expect(await ipc.harnessRestore(second as string)).toMatchObject({ outcome: "refused", reason: "plan_first" });
    expect((await ipc.harnessRestore(first as string)).outcome).toBe("ran");
    expect(await ipc.harnessRestore(first as string)).toMatchObject({ outcome: "refused", reason: "plan_first" });
  });
});

describe("하네스 ipc (출시 빌드 · Tauri 밖)", () => {
  it("가짜로 돌지 않고 모든 하네스 명령이 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    const calls = [
      () => ipc.harnessStatus(),
      () => ipc.harnessClone(),
      () => ipc.harnessUpdateCheck(),
      () => ipc.harnessUpdatePull(),
      () => ipc.harnessInstallPlan(),
      () => ipc.harnessInstall(),
      () => ipc.harnessBackups(),
      () => ipc.harnessRestorePlan("2026-10-18_143205"),
      () => ipc.harnessRestore("2026-10-18_143205"),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ kind: "internal" });
    }
    expect(fakeHarness.calls()).toEqual([]);
  });

  it("Tauri 안에서는 DEV 가 false 여도 실제 명령을 부른다", async () => {
    vi.stubEnv("DEV", false);
    const handler = vi.fn(() => ({ outcome: "up_to_date", reason: null, detail: null, head: "abc1234", before: null, update: null }));
    mockIPC(handler);
    await expect(ipc.harnessUpdatePull()).resolves.toMatchObject({ outcome: "up_to_date" });
    expect(handler).toHaveBeenCalledWith("harness_update_pull", {});
  });
});
