import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { fakeHarness, type FakeHarnessOptions } from "../lib/fakeHarness";
import { AppError, ipc, type HarnessStatus, type ScriptResult } from "../lib/ipc";
import HarnessLab from "./HarnessLab";
import { describeGit } from "./harnessDescribe";

function reset(options: Partial<FakeHarnessOptions> = {}) {
  fakeHarness.reset(options);
}

/** 가짜 하네스가 지금 돌려줄 상태 (실제 위치 경고 시험의 바탕) */
const baseStatus = () => fakeHarness.handlers.harness_status({}) as HarnessStatus;
const click = (element: HTMLElement) => fireEvent.click(element);
const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  reset();
  window.history.pushState({}, "", "/");
});

afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
});

async function ready() {
  render(<HarnessLab />);
  await screen.findByTestId("harness-where");
  await screen.findByText(/Git for Windows|2\.55\.0/);
}

describe("하네스 시험 화면 — 위치 · 상태", () => {
  it("맨 위에 지금 쓰는 ~/.claude · 하네스 폴더 · 원본을 크게 보인다", async () => {
    await ready();
    const where = screen.getByTestId("harness-where");
    expect(within(where).getByText("C:\\fake-sandbox\\.claude")).toBeInTheDocument();
    expect(within(where).getByText("C:\\fake-sandbox\\.claude-harness")).toBeInTheDocument();
    expect(within(where).getByText(/아직 없어요 — 먼저 받아요/)).toBeInTheDocument();
    expect(within(where).getByText(/환경 변수로 정한 위치예요/)).toBeInTheDocument();
    expect(within(where).queryByRole("alert")).toBeNull();
  });

  it("상태에 git · Git Bash · 개발자 모드 · 받은 원본 · 돌릴 스크립트가 보인다", async () => {
    await ready();
    expect(screen.getByText(/2\.55\.0\.windows\.3 — C:\\Program Files\\Git\\cmd\\git\.exe/)).toBeInTheDocument();
    expect(screen.getByText("C:\\Program Files\\Git\\bin\\bash.exe")).toBeInTheDocument();
    expect(screen.getByText(/아니요 — 앱이 받은 원본을 써요/)).toBeInTheDocument();
    expect(screen.getByText(/아직 설치한 적이 없어요/)).toBeInTheDocument();
    expect(screen.getByText("아직 없어요")).toBeInTheDocument(); // 받은 원본
    expect(screen.getByText(/없어요 — 원본을 먼저 받아요/)).toBeInTheDocument(); // 스크립트
    expect(screen.getByText(/12개만 남기고/)).toBeInTheDocument();
  });

  it("개발자 모드: 원본 경로와 개발자 모드가 보이고, 받기 · 업데이트는 꺼지고, 미리보기는 켜진다", async () => {
    reset({ developer: true });
    await ready();
    const where = screen.getByTestId("harness-where");
    expect(within(where).getByText("C:\\fake-sandbox\\my-clone\\claude-harness")).toBeInTheDocument();
    expect(screen.getByText(/예 — 개발자가 직접 관리하는 원본을 써요/)).toBeInTheDocument();
    expect(screen.getByText(/다른 원본을 가리켜요 \(복사\)/)).toBeInTheDocument();
    expect(button("원본 받기")).toBeDisabled();
    expect(button("업데이트 확인")).toBeDisabled();
    expect(button("미리보기")).toBeEnabled();
  });

  it("git 이 없으면 무엇을 설치하면 되는지 보이고 받기가 꺼진다", async () => {
    reset({ gitMissing: true, gitBashMissing: true });
    render(<HarnessLab />);
    expect(await screen.findByText(/git 을 설치하면 하네스를 받고 업데이트할 수 있어요/)).toBeInTheDocument();
    expect(screen.getByText(/작업자 가드\(hook\)가 돌지 않아요/)).toBeInTheDocument();
    expect(button("원본 받기")).toBeDisabled();
  });

  it("실제 폴더(환경 변수가 아닌 기본 위치)를 가리키면 붉은 경고가 뜨고, 쓰는 단추는 '알고 있어요' 를 눌러야 켜진다", async () => {
    const real: HarnessStatus = {
      ...baseStatus(),
      claudeDir: "C:\\Users\\me\\.claude",
      harnessHome: "C:\\Users\\me\\.claude-harness",
      claudeDirFromEnv: false,
      harnessHomeFromEnv: false,
    };
    // Tauri 안인 것처럼 (가짜 모드 안내가 아닌 실제 위치 경고가 보이게)
    mockIPC((command) => (command === "harness_status" ? real : undefined));
    render(<HarnessLab />);
    const where = await screen.findByTestId("harness-where");
    await within(where).findByText("C:\\Users\\me\\.claude");
    expect(within(where).getByText(/기본 위치예요 — 이 PC 의 실제 폴더예요/)).toBeInTheDocument();
    expect(within(where).getByRole("alert")).toHaveTextContent(/실제 파일을 바꿔요/);
    expect(button("원본 받기")).toBeDisabled();
    expect(button("설치")).toBeDisabled();
    // 읽기만 하는 단추는 그대로 쓸 수 있다
    expect(button("다시 확인")).toBeEnabled();
    click(within(where).getByRole("checkbox"));
    // 켜진 뒤에도 조건(원본 없음 · git 있음)이 맞아야 켜진다 — 여기서는 받기가 켜진다
    await waitFor(() => expect(button("원본 받기")).toBeEnabled());
    expect(button("설치")).toBeDisabled(); // 미리보기를 안 봤다
  });
});

/** Tauri 안인 것처럼 — 상태와 명령은 가짜 하네스가 답하되 `override` 가 고른 명령만 바꿔 답한다 */
function mockTauri(override: Record<string, unknown> = {}) {
  mockIPC((command, args) => {
    if (command in override) return override[command];
    const handler = fakeHarness.handlers[command];
    return handler ? handler((args ?? {}) as Record<string, unknown>) : undefined;
  });
}

describe("하네스 시험 화면 — 실제 폴더 판별 · 네트워크 원본", () => {
  const sandboxStatus = (): HarnessStatus => ({ ...baseStatus(), claudeDir: "C:\\box\\.claude", harnessHome: "C:\\box\\.claude-harness" });

  it("환경 변수로 정했어도 기본 위치를 가리키면 실제 폴더라서 경고가 뜨고 '알고 있어요' 를 눌러야 쓰는 단추가 켜진다", async () => {
    const pointsAtReal: HarnessStatus = { ...sandboxStatus(), claudeDirFromEnv: true, harnessHomeFromEnv: true, claudeDirIsDefault: true, harnessHomeIsDefault: true };
    mockTauri({ harness_status: pointsAtReal });
    render(<HarnessLab />);
    const where = await screen.findByTestId("harness-where");
    await within(where).findByText("C:\\box\\.claude");
    expect(within(where).getByText(/환경 변수로 정했지만 기본 위치와 같은 폴더예요/)).toBeInTheDocument();
    expect(within(where).queryByText(/환경 변수로 정한 위치예요 \(시험 폴더\)/)).toBeNull();
    expect(within(where).getByRole("alert")).toHaveTextContent(/실제 파일을 바꿔요/);
    expect(button("원본 받기")).toBeDisabled();
    click(within(where).getByRole("checkbox"));
    await waitFor(() => expect(button("원본 받기")).toBeEnabled());
  });

  it("한쪽만 기본 위치를 가리켜도 실제 폴더다", async () => {
    mockTauri({ harness_status: { ...sandboxStatus(), harnessHomeIsDefault: true } });
    render(<HarnessLab />);
    const where = await screen.findByTestId("harness-where");
    await within(where).findByText("C:\\box\\.claude");
    expect(within(where).getByRole("alert")).toHaveTextContent(/실제 파일을 바꿔요/);
    expect(button("원본 받기")).toBeDisabled();
  });

  it("환경 변수로 정했고 기본 위치와 다른 시험 폴더면 경고 없이 바로 쓸 수 있다", async () => {
    mockTauri({ harness_status: sandboxStatus() });
    render(<HarnessLab />);
    const where = await screen.findByTestId("harness-where");
    await within(where).findByText("C:\\box\\.claude");
    expect(within(where).getByText(/환경 변수로 정한 위치예요 \(시험 폴더\)/)).toBeInTheDocument();
    expect(within(where).queryByRole("alert")).toBeNull();
    await waitFor(() => expect(button("원본 받기")).toBeEnabled());
  });

  it("원본이 네트워크 경로면 경고 한 줄이 보이지만 막지는 않는다", async () => {
    mockTauri({
      harness_status: { ...sandboxStatus(), developerMode: true, sourceIsNetwork: true, sourceDir: "\\\\server\\share\\harness", scriptPath: "\\\\server\\share\\harness\\install.ps1" },
    });
    render(<HarnessLab />);
    const where = await screen.findByTestId("harness-where");
    expect(await within(where).findByRole("alert")).toHaveTextContent(/원본이 네트워크 경로\(공유 폴더\)에 있어요/);
    expect(button("미리보기")).toBeEnabled();
  });

  it("네트워크 경로가 아니면 그 경고는 없다", async () => {
    await ready();
    expect(screen.queryByText(/원본이 네트워크 경로/)).toBeNull();
  });
});

describe("하네스 시험 화면 — 받기 · 업데이트", () => {
  it("받기 → 업데이트 확인(받을 커밋 · 바뀔 파일) → 받기 → 다시 확인하면 최신", async () => {
    await ready();
    expect(button("업데이트 확인")).toBeDisabled(); // 원본을 받기 전
    expect(button("업데이트 받기")).toBeDisabled();
    click(button("원본 받기"));
    await screen.findByText(/받았어요 — a1b2c3d/);
    expect(button("원본 받기")).toBeDisabled(); // 이미 있다
    expect(await screen.findByText(/있어요 — a1b2c3d/)).toBeInTheDocument();

    click(button("업데이트 확인"));
    expect(await screen.findByText("받을 커밋 2개가 있어요")).toBeInTheDocument();
    expect(screen.getByText(/fix: 설치 스크립트 안내 줄 다듬기/)).toBeInTheDocument();
    expect(screen.getByText("바뀔 파일 3개")).toBeInTheDocument();
    expect(screen.getByText(/agents\/harness-designer\.md/, { selector: "code" })).toBeInTheDocument();
    expect(button("업데이트 받기")).toBeEnabled();

    click(button("업데이트 받기"));
    await screen.findByText(/업데이트를 받았어요 — a1b2c3d → b2c3d4e/);
    // 받은 뒤에는 다시 확인하기 전까지 받기가 꺼진다
    expect(button("업데이트 받기")).toBeDisabled();
    click(button("업데이트 확인"));
    expect(await screen.findByText("최신이에요 — 받을 것이 없어요")).toBeInTheDocument();
    expect(button("업데이트 받기")).toBeDisabled();
  });

  it("업데이트를 받으면 실제로 받은 커밋 목록이 보인다", async () => {
    await ready();
    click(button("원본 받기"));
    await screen.findByText(/받았어요 — a1b2c3d/);
    click(button("업데이트 확인"));
    await screen.findByText("받을 커밋 2개가 있어요");
    click(button("업데이트 받기"));
    expect(await screen.findByText("실제로 받은 커밋 2개 (최신이 위)")).toBeInTheDocument();
    expect(screen.getAllByText(/fix: 설치 스크립트 안내 줄 다듬기/).length).toBeGreaterThan(0);
  });

  it("확인 없이 받기가 명령으로 오면 앱이 거절하고 그 이유가 문구로 보인다", async () => {
    await ready();
    click(button("원본 받기"));
    await screen.findByText(/받았어요/);
    // 화면은 확인 뒤에만 받기 단추를 켜지만, 명령 자체도 확인 없이는 받지 않는다 — 그 거절의 문구
    expect(await ipc.harnessUpdatePull()).toMatchObject({ outcome: "refused", reason: "check_first" });
    expect(describeGit(await ipc.harnessUpdatePull())[0]).toBe("받지 않았어요 — 먼저 업데이트를 확인해야 해요 — 확인한 커밋까지만 받아요");
  });

  it("이미 받은 원본이 있을 때 받기가 눌러져도 아무것도 안 바꾼다고 알린다 (단추는 꺼져 있지만 명령은 안전하다)", async () => {
    await ready();
    click(button("원본 받기"));
    await screen.findByText(/받았어요/);
    const again = await ipc.harnessClone();
    expect(again.outcome).toBe("already_present");
  });

  it("다른 하네스 작업이 진행 중이면 알림이 뜬다", async () => {
    await ready();
    vi.spyOn(ipc, "harnessClone").mockRejectedValueOnce(new AppError("harness_busy", "another harness task is in progress"));
    click(button("원본 받기"));
    expect(await screen.findByRole("alert")).toHaveTextContent("다른 하네스 작업이 진행 중이에요");
    // 알림이 뜬 뒤에도 단추는 다시 눌린다 (도는 중 표시가 풀린다)
    await waitFor(() => expect(button("원본 받기")).toBeEnabled());
  });
});

async function cloneFirst() {
  click(button("원본 받기"));
  await screen.findByText(/받았어요/);
}

describe("하네스 시험 화면 — 미리보기 → 설치", () => {
  it("미리보기를 보기 전에는 설치 단추가 꺼져 있고 이유가 보인다", async () => {
    await ready();
    await cloneFirst();
    expect(button("설치")).toBeDisabled();
    expect(screen.getByText("미리보기를 본 뒤에 설치할 수 있어요")).toBeInTheDocument();
  });

  it("미리보기 → 설치 → 다시 미리보기는 같음, 설치 뒤에는 미리보기를 다시 봐야 한다", async () => {
    await ready();
    await cloneFirst();
    click(button("미리보기"));
    await screen.findByText("새로 3 · 바뀜 0 · 지워짐 0 · 건너뜀 0 · 같음 0");
    expect(screen.getByText(/열려 있는 Claude Code 를 다시 시작해야 해요/)).toBeInTheDocument();
    expect(screen.getByText(/새로 — agents\/harness-designer\.md/)).toBeInTheDocument();
    expect(button("설치")).toBeEnabled();

    click(button("설치"));
    await screen.findByText("설치가 끝났어요");
    expect(screen.getByText(/백업: 2026-10-\d\d_\d{6} \(0개 파일\)/)).toBeInTheDocument();
    // 설치한 뒤에는 낡은 미리보기로 또 설치할 수 없다
    expect(button("설치")).toBeDisabled();
    expect(screen.getByText("미리보기 뒤에 다른 일이 있었어요 — 다시 미리보기를 해 주세요")).toBeInTheDocument();

    click(button("미리보기"));
    await waitFor(() => expect(screen.getAllByText("바뀔 것이 없어요 (같음)").length).toBeGreaterThan(0));
    expect(button("설치")).toBeDisabled();
    expect(screen.getByText("바뀔 것이 없어요 — 설치할 필요가 없어요")).toBeInTheDocument();
  });

  it("미리보기 결과의 원문 JSON 을 펼쳐 볼 수 있다", async () => {
    await ready();
    await cloneFirst();
    click(button("미리보기"));
    await screen.findByText(/새로 3/);
    const summary = screen.getByText("원문 JSON 보기");
    click(summary);
    const raw = summary.closest("details")?.querySelector("pre");
    expect(raw?.textContent).toContain('"contract": 1');
    expect(raw?.textContent).toContain('"command": "install"');
  });

  it("스크립트 출력이 깨졌으면 죽지 않고 '출력을 읽을 수 없어요' 와 앞부분을 보이고 설치는 막힌다", async () => {
    reset({ developer: true, unreadable: true });
    await ready();
    click(button("미리보기"));
    const alert = await screen.findByText("JSON 이 깨졌어요");
    expect(alert.closest("[role=alert]")).toBeInTheDocument();
    expect(screen.getByText(/출력을 읽을 수 없어요 \(종료 코드 0\)/)).toBeInTheDocument();
    expect(screen.getByText(/"contract":1,"command":"install","ok":tr/)).toBeInTheDocument();
    expect(button("설치")).toBeDisabled();
    expect(screen.getByText("막는 문제가 있어서 설치할 수 없어요")).toBeInTheDocument();
    expect(screen.getByText("읽은 JSON 이 없어요")).toBeInTheDocument();
  });

  it("원본을 받기 전(스크립트 없음)에는 미리보기가 꺼져 있다", async () => {
    await ready();
    expect(button("미리보기")).toBeDisabled();
  });

  it("설치 뒤 백업이 12개를 넘으면 오래된 것을 정리했다고 알린다", async () => {
    reset({ startBackups: 12 });
    await ready();
    await cloneFirst();
    click(button("미리보기"));
    await screen.findByText(/새로 3/);
    click(button("설치"));
    await screen.findByText("오래된 백업 1개를 정리했어요 (남은 것 12개)");
  });
});

describe("하네스 시험 화면 — 결과 카드", () => {
  /** 미리보기까지 본 뒤 설치 단추를 누르게 하는 공통 단계 (`install` 은 설치 명령이 돌려줄 값) */
  async function planThenInstall(install: unknown) {
    mockTauri({ harness_install: install });
    render(<HarnessLab />);
    await screen.findByTestId("harness-where");
    click(await screen.findByRole("button", { name: "원본 받기" }));
    await screen.findByText(/받았어요/);
    click(button("미리보기"));
    await screen.findByText(/새로 3/);
    click(button("설치"));
  }

  const result = (patch: Partial<ScriptResult>): ScriptResult => ({
    outcome: "ran",
    exitCode: 0,
    report: null,
    raw: null,
    unreadable: null,
    restoreAdvised: false,
    script: null,
    prune: null,
    detail: null,
    reason: null,
    ...patch,
  });

  it("미리보기 결과 카드에 실제로 돌린 스크립트와 스크립트가 본 원본(report.repo)이 보인다", async () => {
    mockTauri();
    render(<HarnessLab />);
    await screen.findByTestId("harness-where");
    click(await screen.findByRole("button", { name: "원본 받기" }));
    await screen.findByText(/받았어요/);
    click(button("미리보기"));
    await screen.findByText(/새로 3/);
    // 상태 칸에도 같은 경로가 있으니 미리보기 결과 카드 안에서만 본다
    const card = screen.getAllByLabelText("방금 결과").find((element) => element.textContent?.includes("돌린 스크립트"));
    expect(card).toBeDefined();
    const inCard = within(card as HTMLElement);
    expect(inCard.getByText("돌린 스크립트")).toBeInTheDocument();
    expect(inCard.getByText("C:\\fake-sandbox\\.claude-harness\\repo\\install.ps1", { selector: "code" })).toBeInTheDocument();
    expect(inCard.getByText("스크립트가 본 원본 (report.repo)")).toBeInTheDocument();
    expect(inCard.getByText("C:\\fake-sandbox\\.claude-harness\\repo", { selector: "code" })).toBeInTheDocument();
  });

  it("앱이 미리보기를 본 적이 없다고 거절하면 그 이유가 보인다", async () => {
    await planThenInstall(result({ outcome: "refused", exitCode: null, reason: "plan_first" }));
    expect(await screen.findByText("하지 않았어요 — 미리보기를 본 적이 없어요 — 먼저 미리보기를 해 주세요")).toBeInTheDocument();
    // 스크립트가 돌지 않았으니 설치 결과 문구는 없다
    expect(screen.queryByText("설치가 끝났어요")).toBeNull();
    expect(screen.queryByText("설치가 끝나지 못했어요")).toBeNull();
  });

  it("미리보기 뒤에 원본이 바뀌었다고 거절하면 다시 미리보기를 하라고 보인다", async () => {
    await planThenInstall(result({ outcome: "refused", exitCode: null, reason: "source_changed" }));
    expect(await screen.findByText(/미리보기를 본 뒤에 원본이 바뀌었어요/)).toBeInTheDocument();
    expect(button("설치")).toBeDisabled();
    expect(screen.getByText("미리보기 뒤에 다른 일이 있었어요 — 다시 미리보기를 해 주세요")).toBeInTheDocument();
  });

  it("설치가 읽을 수 없는 결과로 끝나면 '결과를 알 수 없어요 — 백업에서 되돌리기를 권해요' 가 보인다", async () => {
    await planThenInstall(
      result({
        outcome: "unreadable",
        exitCode: 5,
        restoreAdvised: true,
        unreadable: { reason: "bad_json", contract: null, head: "Segmentation fault", stderrHead: "" },
      }),
    );
    expect(await screen.findByText("결과를 알 수 없어요 — 백업에서 되돌리기를 권해요")).toBeInTheDocument();
    expect(screen.getByText("Segmentation fault")).toBeInTheDocument();
  });

  it("시간이 넘어 끊긴 설치는 기존 문구로 되돌리기를 권한다", async () => {
    await planThenInstall(result({ outcome: "timed_out", exitCode: null, restoreAdvised: true }));
    expect(await screen.findByText("아래 백업에서 되돌리기를 권해요")).toBeInTheDocument();
    expect(screen.queryByText(/결과를 알 수 없어요/)).toBeNull();
  });

  it("백업 정리를 잠금 때문에 미룬 것이 문구로 보인다", async () => {
    await planThenInstall(result({ prune: { removed: 0, kept: 0, removedIds: [], skippedEntries: [], failed: [], skipped: "locked" } }));
    expect(await screen.findByText(/설치 스크립트의 잠금이 남아 있어요/)).toBeInTheDocument();
  });
});

describe("하네스 시험 화면 — 백업 · 되돌리기", () => {
  async function installOnce() {
    click(button("원본 받기"));
    await screen.findByText(/받았어요/);
    click(button("미리보기"));
    await screen.findByText(/새로 3/);
    click(button("설치"));
    await screen.findByText("설치가 끝났어요");
  }

  it("백업이 없으면 없다고 알린다", async () => {
    await ready();
    await cloneFirst();
    click(button("백업 목록 보기"));
    expect(await screen.findByText("백업이 없어요")).toBeInTheDocument();
    expect(button("되돌리기 미리보기")).toBeDisabled();
    expect(button("되돌리기")).toBeDisabled();
  });

  it("목록에서 고르고 → 되돌리기 미리보기를 본 뒤에야 되돌릴 수 있고, 다른 백업을 고르면 다시 미리보기를 해야 한다", async () => {
    reset({ startBackups: 2 });
    await ready();
    await installOnce();
    click(button("백업 목록 보기"));
    const radios = await screen.findAllByRole("radio");
    expect(radios.length).toBe(3);
    expect(button("되돌리기")).toBeDisabled();
    const first = radios[0] as HTMLElement;
    click(first);
    expect(button("되돌리기")).toBeDisabled(); // 미리보기 전
    expect(screen.getByText("되돌리기 미리보기를 본 뒤에 되돌릴 수 있어요")).toBeInTheDocument();
    click(button("되돌리기 미리보기"));
    await waitFor(() => expect(button("되돌리기")).toBeEnabled());

    // 다른 백업을 고르면 그 번호의 미리보기가 아니므로 다시 꺼진다
    click(radios[1] as HTMLElement);
    expect(button("되돌리기")).toBeDisabled();
    click(first);
    expect(button("되돌리기")).toBeDisabled();
    click(button("되돌리기 미리보기"));
    await waitFor(() => expect(button("되돌리기")).toBeEnabled());
    click(button("되돌리기"));
    await screen.findByText("되돌렸어요");
    // 되돌린 뒤에는 목록을 다시 불러오게 비운다
    expect(screen.queryAllByRole("radio").length).toBe(0);
    expect(fakeHarness.calls().slice(-2)).toEqual(["restore_plan", "restore"]);
  });
});

describe("하네스 시험 화면 — 주소로 여는 길", () => {
  it("개발 빌드에서 ?lab=harness 면 App 이 하네스 시험 화면을 보인다", async () => {
    window.history.pushState({}, "", "/?lab=harness");
    render(<App />);
    expect(await screen.findByTestId("harness-lab")).toBeInTheDocument();
    expect(screen.queryByTestId("session-lab")).toBeNull();
  });

  it("기본 화면에 하네스 시험 화면으로 가는 링크가 있고 Claude 시험 화면 링크는 그대로 하나다", async () => {
    render(<App />);
    expect(await screen.findByRole("link", { name: /하네스 설치 점검 열기/ })).toHaveAttribute("href", "?lab=harness");
    expect(screen.getByRole("link", { name: /Claude 연결 시험 화면 열기/ })).toHaveAttribute("href", "?lab=session");
  });
});
