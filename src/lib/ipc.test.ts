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
