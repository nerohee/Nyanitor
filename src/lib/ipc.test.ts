import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, ipc } from "./ipc";

afterEach(() => {
  clearMocks();
});

describe("ipc (Tauri 안)", () => {
  it("app_info 명령을 불러 결과를 돌려준다", async () => {
    const handler = vi.fn(() => ({ name: "Nyanitor", version: "1.2.3" }));
    mockIPC(handler);

    await expect(ipc.appInfo()).resolves.toEqual({ name: "Nyanitor", version: "1.2.3" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("app_info", {});
  });

  it("명령이 { kind, message } 로 실패하면 AppError 로 던진다", async () => {
    mockIPC(() => {
      throw { kind: "internal", message: "internal error: boom" };
    });

    const error = await ipc.appInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: "internal", message: "internal error: boom" });
  });

  it("모르는 모양의 오류도 internal AppError 로 바꾼다", async () => {
    mockIPC(() => {
      throw "plain string failure";
    });

    const error = await ipc.appInfo().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ kind: "internal", message: "plain string failure" });
  });
});

describe("ipc (브라우저 가짜 모드)", () => {
  it("Tauri 가 없으면 가짜 앱 정보를 돌려준다", async () => {
    await expect(ipc.appInfo()).resolves.toEqual({ name: "Nyanitor", version: "0.0.0-browser" });
  });
});

describe("ipc (출시 빌드 · Tauri 밖)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("가짜로 돌지 않고 모든 명령 · 구독이 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.appInfo()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.claudeDiscover()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.claudeSessionStart({ projectDir: "C:\\p" })).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.claudeSessionState()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.onClaudeEvent(() => undefined)).rejects.toMatchObject({ kind: "internal" });
    // 개발 빌드(시험 환경 기본)에서는 같은 호출이 가짜로 돈다 (대조)
    vi.stubEnv("DEV", true);
    await expect(ipc.appInfo()).resolves.toMatchObject({ version: "0.0.0-browser" });
  });

  it("Tauri 안에서는 DEV 가 false 여도 실제 명령을 부른다", async () => {
    vi.stubEnv("DEV", false);
    const handler = vi.fn(() => ({ name: "Nyanitor", version: "9.9.9" }));
    mockIPC(handler);
    await expect(ipc.appInfo()).resolves.toEqual({ name: "Nyanitor", version: "9.9.9" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
