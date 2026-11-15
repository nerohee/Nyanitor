// 브라우저(`npm run dev`)에서 앱 업데이트 화면이 돌도록 하는 가짜 업데이터. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/update/`)와 같은 명령 · 상태 · 이벤트 모양을 흉내 낸다. 네트워크 · 파일은 어디에도 건드리지 않고 앱도 다시 시작하지 않는다.
// 처음 상태는 `idle` (진짜는 앱을 연 뒤 열 번째 초쯤 자동 확인하고, 화면이 "지금 확인" 을 누를 수도 있다). 확인하면 주소 쿼리가 고른 결과가 나온다:
//   ?update=new (기본) 새 판 있음 · ?update=latest 최신 · ?update=deb 새 판은 있지만 이 설치 방식으로는 설치 못 함 (Linux deb) · ?update=fail 확인 실패
//   ?update=warn 새 판 있음 + 설치하려면 "일하는 중" 경고가 먼저 (`force` 로 다시 부르면 설치) · ?update=download_fail 새 판 있음 + 받다가 실패
// 한 번에 하나(`update_busy`) · 받는 진행 이벤트 · 받은 뒤의 `ready` · 새 판이 없으면 `no_update` 도 진짜처럼 한다.
// 시험은 `reset(...)` 로 쿼리 대신 값을 정하고 걸음 길이(`pace`)를 줄인다.
import { AppError, type AppUpdateInstallResult, type AppUpdateRelease, type AppUpdateStatus } from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

export type FakeUpdateMode = "new" | "latest" | "deb" | "fail" | "warn" | "download_fail";

const MODES: readonly FakeUpdateMode[] = ["new", "latest", "deb", "fail", "warn", "download_fail"];

/** 주소 쿼리 → 가짜 결과. 모르는 값은 기본값. */
export function parseFakeUpdateQuery(search: string): FakeUpdateMode {
  const value = new URLSearchParams(search).get("update");
  return MODES.find((mode) => mode === value) ?? "new";
}

/** 걸음 하나의 길이(ms) — 확인 · 받기 진행이 눈에 보이게 */
export const FAKE_UPDATE_PACE_MS = 400;
/** 받기를 몇 걸음으로 나누나 */
const DOWNLOAD_STEPS = 5;
const FAKE_TOTAL_BYTES = 24_000_000;

export const FAKE_UPDATE_RELEASE: AppUpdateRelease = {
  version: "0.2.0",
  date: "2026-11-20",
  notes: "## 바뀐 점\n\n- 새 고양이가 집에 들어왔어요\n- 채팅 입력줄이 더 빨라졌어요\n- 몇 가지 오류를 고쳤어요",
  notesTruncated: false,
};

export interface FakeUpdateOptions {
  mode: FakeUpdateMode;
  /** 걸음 길이(ms) */
  pace: number;
}

export function createFakeUpdate() {
  const listeners = new Set<(status: AppUpdateStatus) => void>();
  /** 시험이 정한 값. 없으면 부를 때마다 주소 쿼리를 읽는다 */
  let override: Partial<FakeUpdateOptions> | null = null;
  let status: AppUpdateStatus = { state: "idle" };
  /** 확인 · 받기가 돌고 있다 (한 번에 하나) */
  let working = false;
  /** 받은 파일이 있다 (`ready`) */
  let downloaded = false;

  const options = (): FakeUpdateOptions => ({
    mode: override?.mode ?? parseFakeUpdateQuery(typeof window === "undefined" ? "" : window.location.search),
    pace: override?.pace ?? FAKE_UPDATE_PACE_MS,
  });

  const set = (next: AppUpdateStatus) => {
    status = next;
    for (const listener of [...listeners]) {
      // 한 구독자의 오류가 뒤 구독자를 막지 않게 한다 (실제 Tauri 이벤트도 구독자마다 따로 불린다).
      try {
        listener(next);
      } catch (error) {
        console.error("fake update: a listener threw", error);
      }
    }
  };

  const wait = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

  const result = (outcome: AppUpdateInstallResult["outcome"], warning: AppUpdateInstallResult["warning"] = null): AppUpdateInstallResult => ({
    outcome,
    warning,
    status,
  });

  const handlers: Record<string, Handler> = {
    app_update_status: (): AppUpdateStatus => status,

    app_update_check: async (): Promise<AppUpdateStatus> => {
      if (working) throw new AppError("update_busy", "an app update task is already in progress");
      // 이미 받아 둔 새 판이 있으면 확인하지 않는다 (받은 파일을 버리지 않으려고)
      if (status.state === "ready") return status;
      const { mode, pace } = options();
      working = true;
      try {
        set({ state: "checking" });
        await wait(pace);
        downloaded = false;
        if (mode === "fail") {
          set({ state: "failed", stage: "check", message: "error sending request for url (https://github.com/nerohee/Nyanitor/releases/latest/download/latest.json)" });
        } else if (mode === "latest") {
          set({ state: "latest" });
        } else if (mode === "deb") {
          set({ state: "unsupported", reason: "not_app_image", release: { ...FAKE_UPDATE_RELEASE } });
        } else {
          set({ state: "available", release: { ...FAKE_UPDATE_RELEASE } });
        }
        return status;
      } finally {
        working = false;
      }
    },

    app_update_install: async (args): Promise<AppUpdateInstallResult> => {
      // 진짜처럼 받는 쪽에서 모양을 먼저 확인한다 (`force: bool`)
      if (typeof args.force !== "boolean") throw new AppError("invalid_input", "force must be a boolean");
      if (working) throw new AppError("update_busy", "an app update task is already in progress");
      if (status.state === "unsupported") return result("unsupported");
      if (status.state !== "available" && status.state !== "ready") return result("no_update");
      const { mode, pace } = options();
      // 경고가 있으면 `force` 없이는 아무것도 바꾸지 않는다
      if (mode === "warn" && !args.force) return result("warning", "working");
      if (!downloaded) {
        const version = status.state === "available" ? status.release.version : status.version;
        working = true;
        try {
          set({ state: "downloading", version, received: 0, total: null });
          for (let step = 1; step <= DOWNLOAD_STEPS; step += 1) {
            await wait(pace);
            if (mode === "download_fail" && step === 3) {
              set({ state: "failed", stage: "download", message: "connection reset" });
              return result("failed");
            }
            set({ state: "downloading", version, received: Math.round((FAKE_TOTAL_BYTES * step) / DOWNLOAD_STEPS), total: FAKE_TOTAL_BYTES });
          }
          downloaded = true;
          set({ state: "ready", version });
        } finally {
          working = false;
        }
      }
      // 설치 — 진짜는 여기서 앱이 다시 시작한다 (브라우저에서는 시작하지 않는다)
      return result("restarting");
    },
  };

  return {
    handlers,
    /** 상태가 바뀔 때마다 듣는다 (`ipc.onAppUpdate` 의 브라우저 가짜 — 진짜는 Rust 가 이벤트로 보낸다) */
    subscribe(handler: (next: AppUpdateStatus) => void): () => void {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
    /** 시험용: 모든 상태를 처음으로 (`mode` · `pace` 를 주면 쿼리 대신 그 값) */
    reset(next?: Partial<FakeUpdateOptions>) {
      override = next ?? null;
      status = { state: "idle" };
      working = false;
      downloaded = false;
      listeners.clear();
    },
  };
}

export const fakeUpdate = createFakeUpdate();
