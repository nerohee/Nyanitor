// 앱 업데이트 IPC (P11-01) — 명령 이름 · 인자(force 하나), Rust 가 돌려준 모양, 이벤트 듣기, 브라우저 가짜(주소 쿼리 · 한 번에 하나 · 진행 이벤트), 출시 빌드에서 가짜로 돌지 않음.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_UPDATE_RELEASE, fakeUpdate, parseFakeUpdateQuery } from "./fakeUpdate";
import { APP_UPDATE_EVENT, AppError, ipc, type AppUpdateStatus } from "./ipc";

beforeEach(() => {
  fakeUpdate.reset({ pace: 0 });
});

afterEach(() => {
  clearMocks();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
  fakeUpdate.reset();
});

describe("앱 업데이트 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 부른다 — 인자는 설치의 force 하나뿐", async () => {
    const handler = vi.fn((command: string) => (command === "app_update_install" ? { outcome: "no_update", warning: null, status: { state: "idle" } } : { state: "idle" }));
    mockIPC(handler);
    await ipc.appUpdateStatus();
    await ipc.appUpdateCheck();
    await ipc.appUpdateInstall();
    await ipc.appUpdateInstall(true);
    expect(handler.mock.calls).toEqual([
      ["app_update_status", {}],
      ["app_update_check", {}],
      ["app_update_install", { force: false }],
      ["app_update_install", { force: true }],
    ]);
  });

  it("Rust 가 돌려준 모양을 그대로 넘긴다 (새 판 · 경고 · 받는 중)", async () => {
    const available = { state: "available", release: { version: "0.2.0", date: "2026-11-20", notes: null, notesTruncated: false } };
    const warning = { outcome: "warning", warning: "harness_install", status: available };
    mockIPC((command) => (command === "app_update_install" ? warning : available));
    await expect(ipc.appUpdateCheck()).resolves.toEqual(available);
    await expect(ipc.appUpdateInstall()).resolves.toEqual(warning);
  });

  it("update_busy 는 같은 종류의 AppError 로 받는다 (internal 로 뭉개지 않는다)", async () => {
    mockIPC(() => {
      throw { kind: "update_busy", message: "an app update task is already in progress" };
    });
    await expect(ipc.appUpdateCheck()).rejects.toMatchObject({ kind: "update_busy" });
  });

  it("상태 이벤트를 듣고, 돌려준 함수를 부르면 그만 듣는다 (다른 이벤트는 섞이지 않는다)", async () => {
    mockIPC(() => null, { shouldMockEvents: true });
    const seen: AppUpdateStatus[] = [];
    const stop = await ipc.onAppUpdate((status) => seen.push(status));
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    const emit = (event: string, payload: unknown) => internals.invoke("plugin:event|emit", { event, payload });

    await emit(APP_UPDATE_EVENT, { state: "checking" });
    await emit(APP_UPDATE_EVENT, { state: "downloading", version: "0.2.0", received: 10, total: null });
    await emit("claude:session", { type: "text", text: "x" });
    expect(seen).toEqual([{ state: "checking" }, { state: "downloading", version: "0.2.0", received: 10, total: null }]);

    stop();
    await emit(APP_UPDATE_EVENT, { state: "latest" });
    expect(seen).toHaveLength(2);
  });
});

describe("앱 업데이트 ipc (브라우저 가짜 모드)", () => {
  it("주소 쿼리: new(기본) · latest · deb · fail · warn · download_fail, 모르는 값은 기본", () => {
    expect(parseFakeUpdateQuery("")).toBe("new");
    expect(parseFakeUpdateQuery("?update=latest")).toBe("latest");
    expect(parseFakeUpdateQuery("?update=deb")).toBe("deb");
    expect(parseFakeUpdateQuery("?update=fail")).toBe("fail");
    expect(parseFakeUpdateQuery("?update=warn")).toBe("warn");
    expect(parseFakeUpdateQuery("?update=download_fail")).toBe("download_fail");
    expect(parseFakeUpdateQuery("?update=nope")).toBe("new");
  });

  it("처음은 idle, 확인하면 checking 을 거쳐 새 판 (바뀐 점 포함)", async () => {
    const seen: AppUpdateStatus[] = [];
    const stop = await ipc.onAppUpdate((status) => seen.push(status));
    await expect(ipc.appUpdateStatus()).resolves.toEqual({ state: "idle" });
    const status = await ipc.appUpdateCheck();
    expect(status).toEqual({ state: "available", release: FAKE_UPDATE_RELEASE });
    expect(seen.map((s) => s.state)).toEqual(["checking", "available"]);
    await expect(ipc.appUpdateStatus()).resolves.toEqual(status);
    stop();
    await ipc.appUpdateCheck();
    expect(seen.length, "그만 들은 뒤에는 오지 않는다").toBe(2);
  });

  it("latest · deb · fail 결과", async () => {
    fakeUpdate.reset({ mode: "latest", pace: 0 });
    await expect(ipc.appUpdateCheck()).resolves.toEqual({ state: "latest" });
    fakeUpdate.reset({ mode: "deb", pace: 0 });
    await expect(ipc.appUpdateCheck()).resolves.toMatchObject({ state: "unsupported", reason: "not_app_image" });
    fakeUpdate.reset({ mode: "fail", pace: 0 });
    await expect(ipc.appUpdateCheck()).resolves.toMatchObject({ state: "failed", stage: "check" });
  });

  it("새 판이 없으면 설치는 no_update, 이 설치 방식으로는 안 되면 unsupported — 아무것도 바뀌지 않는다", async () => {
    await expect(ipc.appUpdateInstall(true)).resolves.toMatchObject({ outcome: "no_update", status: { state: "idle" } });
    fakeUpdate.reset({ mode: "deb", pace: 0 });
    await ipc.appUpdateCheck();
    await expect(ipc.appUpdateInstall(true)).resolves.toMatchObject({ outcome: "unsupported", status: { state: "unsupported" } });
  });

  it("설치: 받는 중(진행) → 설치 준비 끝 → restarting", async () => {
    await ipc.appUpdateCheck();
    const seen: AppUpdateStatus[] = [];
    await ipc.onAppUpdate((status) => seen.push(status));
    const result = await ipc.appUpdateInstall();
    expect(result).toMatchObject({ outcome: "restarting", warning: null, status: { state: "ready", version: "0.2.0" } });
    const states = seen.map((s) => s.state);
    expect(states[0]).toBe("downloading");
    expect(states[states.length - 1]).toBe("ready");
    const received = seen.flatMap((s) => (s.state === "downloading" ? [s.received] : []));
    expect(received).toEqual([...received].sort((a, b) => a - b));
    const downloading = seen.filter((s) => s.state === "downloading");
    const last = downloading[downloading.length - 1];
    expect(last).toMatchObject({ received: 24_000_000, total: 24_000_000 });
  });

  it("경고 모드: force 없이는 아무것도 하지 않고 warning, force 로 다시 부르면 설치", async () => {
    fakeUpdate.reset({ mode: "warn", pace: 0 });
    await ipc.appUpdateCheck();
    const warned = await ipc.appUpdateInstall();
    expect(warned).toMatchObject({ outcome: "warning", warning: "working", status: { state: "available" } });
    await expect(ipc.appUpdateInstall(false)).resolves.toMatchObject({ outcome: "warning" });
    await expect(ipc.appUpdateInstall(true)).resolves.toMatchObject({ outcome: "restarting", status: { state: "ready" } });
  });

  it("받기 실패: failed(download) 와 결과 failed, 새 판은 버려져 다시 확인해야 한다", async () => {
    fakeUpdate.reset({ mode: "download_fail", pace: 0 });
    await ipc.appUpdateCheck();
    const result = await ipc.appUpdateInstall(true);
    expect(result).toMatchObject({ outcome: "failed", status: { state: "failed", stage: "download" } });
    await expect(ipc.appUpdateInstall(true)).resolves.toMatchObject({ outcome: "no_update" });
  });

  it("한 번에 하나: 확인 중 · 받는 중에 또 부르면 update_busy", async () => {
    fakeUpdate.reset({ pace: 5 });
    const first = ipc.appUpdateCheck();
    await expect(ipc.appUpdateCheck()).rejects.toBeInstanceOf(AppError);
    await expect(ipc.appUpdateCheck()).rejects.toMatchObject({ kind: "update_busy" });
    await expect(ipc.appUpdateInstall(true)).rejects.toMatchObject({ kind: "update_busy" });
    await first;
    const install = ipc.appUpdateInstall(true);
    await expect(ipc.appUpdateCheck()).rejects.toMatchObject({ kind: "update_busy" });
    await expect(ipc.appUpdateInstall(true)).rejects.toMatchObject({ kind: "update_busy" });
    await install;
  });

  it("이미 받아 둔 새 판(ready)이 있으면 확인은 확인하지 않고 그 상태를 돌려준다 (받은 파일을 버리지 않는다)", async () => {
    await ipc.appUpdateCheck();
    await ipc.appUpdateInstall(true);
    const seen: AppUpdateStatus[] = [];
    await ipc.onAppUpdate((status) => seen.push(status));
    await expect(ipc.appUpdateCheck()).resolves.toEqual({ state: "ready", version: "0.2.0" });
    expect(seen).toEqual([]);
  });

  it("force 가 불리언이 아니면 invalid_input (받는 쪽에서 모양을 다시 확인한다)", async () => {
    await ipc.appUpdateCheck();
    const call = ipc.appUpdateInstall as unknown as (force: unknown) => Promise<unknown>;
    await expect(call("yes")).rejects.toMatchObject({ kind: "invalid_input" });
  });

  it("출시 빌드(DEV 아님)에서 Tauri 밖이면 가짜로 돌지 않고 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.appUpdateCheck()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.onAppUpdate(() => undefined)).rejects.toMatchObject({ kind: "internal" });
  });
});
