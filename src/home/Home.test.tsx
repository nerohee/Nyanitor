// 실제 메인 화면(고양이 집) 시험 — 가짜 데이터 기본 · 사용량 못 받음(이유별) · 에이전트 깨짐 · 하네스 없음 ·
// 읽는 중 · 다시 읽기 · 패널 키보드 흐름 · 시간대 바뀜(가짜 시계) · 움직임 끔 · 창 숨김 · 실패 · 언마운트 ·
// 아래 판(최근 프로젝트 · 새 프로젝트 단추 · 없음 · 읽는 중 · 못 읽음 · 읽기 전용) · 왼쪽 메뉴.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TAB_ORDER } from "../components/house/schedule";
import { fakeHouse } from "../lib/fakeHouse";
import { fakeProjects } from "../lib/fakeProjects";
import { ipc } from "../lib/ipc";
import { AppError, type UsageSummary, type AgentsList, type UsageResult, type UsageUnavailableReason } from "../lib/ipc-types";
import { spotHitBox } from "../components/house/blocked";
import { SPOTS } from "../components/house/spots";
import { resetSessionStore, useSessionStore } from "../workspace/chat/sessionStore";
import Home from "./Home";

const NAV = { onGo: () => undefined, onOpenProject: () => undefined, onNewProject: () => undefined };

const OK_USAGE: UsageResult = {
  state: "ok",
  fiveHour: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 7200, severity: "normal" },
  sevenDay: { utilization: 1.05, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400, severity: "warning" },
  scoped: [{ label: "Opus", utilization: 0.9, resetsAt: null, severity: null }],
  extraUsageEnabled: false,
  readAt: Math.floor(Date.now() / 1000),
};

beforeEach(() => {
  fakeHouse.reset();
  fakeProjects.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fakeHouse.reset();
  fakeProjects.reset();
  window.history.replaceState({}, "", "/");
  delete document.documentElement.dataset.motion;
  delete document.documentElement.dataset.hidden;
});

function catButtons() {
  return within(screen.getByRole("region", { name: "고양이들" })).getAllByRole("button");
}

function catName(button: HTMLElement): string | undefined {
  return button.getAttribute("aria-label")?.split(",")[0];
}

/** 가짜 데이터가 다 들어올 때까지 */
async function loaded() {
  await screen.findByRole("meter", { name: "5시간 츄르" });
  await screen.findByText(/준비 완료/);
  await vi.waitFor(() => expect(catButtons()).toHaveLength(7));
}

describe("고양이 집 — 아래 판 (프로젝트)", () => {
  function slab() {
    return screen.getByRole("region", { name: /최근 프로젝트|아직 프로젝트가 없어요|프로젝트/ });
  }

  it("최근 프로젝트 세 개를 눌러 열 수 있고 새 프로젝트 단추는 작업 공간으로 보낸다", async () => {
    const onOpenProject = vi.fn();
    const onNewProject = vi.fn();
    const onGo = vi.fn();
    // 가짜 목록의 시각(fakeProjects.ts 의 NOW)에 맞춘 가짜 시계
    const clock = () => new Date(1_800_000_000 * 1000);
    render(<Home onGo={onGo} onOpenProject={onOpenProject} onNewProject={onNewProject} clock={clock} />);

    await screen.findByText("고양이 앨범");
    const items = within(slab()).getAllByRole("button");
    // 가짜 목록은 최근 연 순 — 고양이 앨범 · 레시피 상자 · 쇼핑몰 관리자 (폴더가 없어진 것은 시간 대신 안내)
    expect(items.map((b) => b.textContent)).toEqual(["고양이 앨범1시간 전", "레시피 상자1일 전", "쇼핑몰 관리자폴더를 찾을 수 없어요"]);
    expect(screen.queryByText("빵집 예약")).not.toBeInTheDocument();

    fireEvent.click(items[1]);
    expect(onOpenProject).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "새 프로젝트 시작" }));
    expect(onNewProject).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "작업 공간" }));
    expect(onGo).toHaveBeenCalledWith("workspace");
    // 지금 있는 곳(집)을 다시 눌러도 아무 일 없다
    fireEvent.click(screen.getByRole("button", { name: "집" }));
    expect(onGo).toHaveBeenCalledTimes(1);
  });

  it("프로젝트가 없으면 안내 한 줄과 새 프로젝트 단추", async () => {
    fakeProjects.reset({ projects: "none" });
    render(<Home {...NAV} />);
    expect(await screen.findByRole("heading", { name: "아직 프로젝트가 없어요" })).toBeInTheDocument();
    expect(screen.getByText(/새 프로젝트를 시작하면/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 프로젝트 시작" })).toBeEnabled();
  });

  it("읽는 중에는 한 줄, 새 프로젝트 단추는 아직 꺼져 있다", async () => {
    vi.spyOn(ipc, "projectsList").mockReturnValue(new Promise(() => undefined));
    render(<Home {...NAV} />);
    expect(await screen.findByText("프로젝트를 불러오는 중…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 프로젝트 시작" })).toBeDisabled();
  });

  it("못 읽으면 이유 한 줄과 다시 읽기 — 다시 읽으면 목록이 나온다", async () => {
    const spy = vi.spyOn(ipc, "projectsList").mockRejectedValueOnce(new AppError("db_unavailable", "x"));
    render(<Home {...NAV} />);
    expect(await screen.findByText(/프로젝트 목록을 읽지 못했어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 프로젝트 시작" })).toBeDisabled();

    fireEvent.click(within(slab()).getByRole("button", { name: "다시 읽기" }));
    expect(await screen.findByText("고양이 앨범")).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("DB 가 읽기 전용이면 목록은 보이고 새 프로젝트 단추만 끈다", async () => {
    fakeProjects.reset({ db: "read_only" });
    render(<Home {...NAV} />);
    expect(await screen.findByText("고양이 앨범", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/읽기만 할 수 있어요/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 프로젝트 시작" })).toBeDisabled();
  });
});

describe("고양이 집 — 가짜 데이터 기본", () => {
  it("고양이 7마리가 Tab 순서대로 있고, 사용량 · 준비 상태 · 최근 프로젝트 판이 보인다", async () => {
    render(<Home {...NAV} />);
    await loaded();

    expect(catButtons().map(catName)).toEqual(TAB_ORDER.map((cat) => ({ danchu: "단추", kkaebi: "깨비", nabi: "나비", mulgam: "물감", mukmul: "먹물", dubu: "두부", gureum: "구름" })[cat]));
    expect(screen.getByTestId("home")).toHaveAttribute("data-skin", "3");
    expect(screen.getByRole("heading", { level: 1, name: "Nyanitor" })).toBeInTheDocument();

    expect(screen.getByRole("meter", { name: "5시간 츄르" })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("meter", { name: "주간 츄르" })).toHaveAttribute("aria-valuenow", "18");
    expect(screen.getByText("42% 먹음")).toBeInTheDocument();
    expect(screen.getByText(/오늘 .*다시 채워짐/)).toBeInTheDocument();
    expect(screen.getByText("준비 완료 4/4")).toBeInTheDocument();
    expect(screen.getByText(/방금 읽음/)).toBeInTheDocument();

    // 아래 판 — 새 프로젝트 단추 + 최근 프로젝트 (가짜 목록의 앞 세 개)
    expect(await screen.findByRole("heading", { name: "최근 프로젝트" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "새 프로젝트 시작" })).toBeEnabled();
    const nav = screen.getByRole("navigation", { name: "탐색" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["집", "작업 공간"]);
    // 모델별 한도는 보이지 않는다
    expect(screen.queryByText(/Opus/)).not.toBeInTheDocument();
  });

  it("사용률이 100% 를 넘으면 글자는 그대로, 막대 값은 100 에서 멈춘다 (모델별 한도 scoped 는 안 보인다)", async () => {
    vi.spyOn(ipc, "usageRead").mockResolvedValue(OK_USAGE);
    render(<Home {...NAV} />);
    await screen.findByRole("meter", { name: "주간 츄르" });
    expect(screen.getByText("105% 먹음")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "주간 츄르" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.queryByText("Opus")).not.toBeInTheDocument();
  });

  it("한도 창이 하나뿐이면 있는 것만 보이고, 둘 다 없으면 '확인할 수 없음'", async () => {
    const spy = vi.spyOn(ipc, "usageRead").mockResolvedValue({ ...OK_USAGE, sevenDay: null });
    const { unmount } = render(<Home {...NAV} />);
    await screen.findByRole("meter", { name: "5시간 츄르" });
    expect(screen.queryByRole("meter", { name: "주간 츄르" })).not.toBeInTheDocument();
    unmount();

    spy.mockResolvedValue({ ...OK_USAGE, fiveHour: null, sevenDay: null });
    render(<Home {...NAV} />);
    expect(await screen.findByText("확인할 수 없음")).toBeInTheDocument();
    expect(screen.getByText("받은 츄르 정보가 비어 있어요.")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
  });
});

describe("고양이 집 — 사용량을 못 받을 때", () => {
  const REASONS: Record<UsageUnavailableReason, string> = {
    not_subscription: "구독 계정이 아니라서 츄르를 볼 수 없어요.",
    not_logged_in: "Claude 에 로그인하면 사용량을 볼 수 있어요.",
    no_claude: "Claude Code 를 찾지 못했어요.",
    not_supported: "이 Claude Code 는 사용량을 알려 주지 않아요.",
    timeout: "응답이 늦어 사용량을 받지 못했어요.",
    failed: "사용량을 읽지 못했어요.",
  };

  for (const [reason, text] of Object.entries(REASONS)) {
    it(`${reason} — '확인할 수 없음' 과 이유 한 줄, 고양이 · 준비 상태는 그대로`, async () => {
      fakeHouse.reset({ usage: reason as UsageUnavailableReason });
      render(<Home {...NAV} />);
      expect(await screen.findByText("확인할 수 없음")).toBeInTheDocument();
      expect(screen.getByText(text)).toBeInTheDocument();
      expect(screen.getByText("앱 기능에는 영향이 없어요.")).toBeInTheDocument();
      expect(screen.queryByRole("meter")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "다시 읽기" })).toBeEnabled();
      await vi.waitFor(() => expect(catButtons()).toHaveLength(7));
      expect(screen.getByText("준비 완료 4/4")).toBeInTheDocument();
    });
  }

  it("사용량 명령이 오류를 내도(앱 오류) 화면은 '읽지 못함' 으로 — 깨지지 않는다", async () => {
    vi.spyOn(ipc, "usageRead").mockRejectedValue(new Error("boom"));
    render(<Home {...NAV} />);
    expect(await screen.findByText("사용량을 읽지 못했어요.")).toBeInTheDocument();
    await vi.waitFor(() => expect(catButtons()).toHaveLength(7));
  });
});

describe("고양이 집 — 읽는 중 · 다시 읽기", () => {
  it("처음 읽는 중에는 막대 자리를 그대로 두고 '읽는 중…', 다시 읽기는 못 누른다", async () => {
    let finish: (value: UsageResult) => void = () => undefined;
    vi.spyOn(ipc, "usageRead").mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(<Home {...NAV} />);

    expect(screen.getByText("읽는 중…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 읽기" })).toBeDisabled();
    expect(screen.queryByText("확인할 수 없음")).not.toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();

    await act(async () => finish(OK_USAGE));
    expect(screen.getByRole("meter", { name: "5시간 츄르" })).toBeInTheDocument();
    expect(screen.queryByText("읽는 중…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 읽기" })).toBeEnabled();
  });

  it("다시 읽기를 누르면 이전 값을 두고 읽는 중 표시만, 끝나면 새 값. 읽는 동안 또 눌러도 한 번만 읽는다", async () => {
    const first: UsageResult = { ...OK_USAGE, fiveHour: { utilization: 0.1, resetsAt: null, severity: null } };
    const second: UsageResult = { ...OK_USAGE, fiveHour: { utilization: 0.77, resetsAt: null, severity: null } };
    const resolvers: ((value: UsageResult) => void)[] = [];
    const read = vi.spyOn(ipc, "usageRead").mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    render(<Home {...NAV} />);
    await act(async () => resolvers[0](first));
    expect(screen.getByText("10% 먹음")).toBeInTheDocument();

    const refresh = screen.getByRole("button", { name: "다시 읽기" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    expect(read).toHaveBeenCalledTimes(2);
    expect(refresh).toBeDisabled();
    // 이전 값과 그 값을 읽은 때는 그대로
    expect(screen.getByText("읽는 중… · 방금 기준")).toBeInTheDocument();
    expect(screen.getByText("10% 먹음")).toBeInTheDocument();

    await act(async () => resolvers[1](second));
    expect(screen.getByText("77% 먹음")).toBeInTheDocument();
    expect(refresh).toBeEnabled();
  });

  const tenMinutesAgo = () => ({ ...OK_USAGE, readAt: Math.floor(Date.now() / 1000) - 10 * 60 });
  const transient: [string, () => Promise<UsageResult>][] = [
    ["시간 초과", async () => ({ state: "unavailable", reason: "timeout" })],
    ["실패", async () => ({ state: "unavailable", reason: "failed" })],
    ["빈 응답", async () => ({ ...OK_USAGE, fiveHour: null, sevenDay: null })],
    ["앱 오류", () => Promise.reject(new Error("boom"))],
  ];
  for (const [name, fail] of transient) {
    it(`받은 뒤 잠깐 못 받으면(${name}) 마지막 숫자를 남기고 '갱신 실패 · n분 전 기준', 다시 받으면 새 값`, async () => {
      const read = vi.spyOn(ipc, "usageRead").mockResolvedValue(tenMinutesAgo());
      render(<Home {...NAV} />);
      expect(await screen.findByText("10분 전 읽음")).toBeInTheDocument();

      read.mockImplementation(fail);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "다시 읽기" })));
      expect(screen.getByText("갱신 실패 · 10분 전 기준")).toBeInTheDocument();
      expect(screen.getByText("42% 먹음")).toBeInTheDocument();
      expect(screen.queryByText("확인할 수 없음")).not.toBeInTheDocument();

      read.mockResolvedValue({ ...OK_USAGE, readAt: Math.floor(Date.now() / 1000) });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "다시 읽기" })));
      expect(screen.getByText("방금 읽음")).toBeInTheDocument();
      expect(screen.queryByText(/갱신 실패/)).not.toBeInTheDocument();
    });
  }

  it("받은 뒤 이유가 분명하면(로그인 풀림) 숫자를 지우고 이유를 보인다", async () => {
    const read = vi.spyOn(ipc, "usageRead").mockResolvedValue(tenMinutesAgo());
    render(<Home {...NAV} />);
    await screen.findByText("10분 전 읽음");

    read.mockResolvedValue({ state: "unavailable", reason: "not_logged_in" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "다시 읽기" })));
    expect(screen.getByText("Claude 에 로그인하면 사용량을 볼 수 있어요.")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(screen.queryByText(/기준|읽음/)).not.toBeInTheDocument();
  });

  it("못 받은 뒤 다시 읽어서 받으면 막대가 나온다", async () => {
    fakeHouse.reset({ usage: "timeout" });
    render(<Home {...NAV} />);
    expect(await screen.findByText("확인할 수 없음")).toBeInTheDocument();
    fakeHouse.reset({ usage: "ok" });
    fireEvent.click(screen.getByRole("button", { name: "다시 읽기" }));
    expect(await screen.findByRole("meter", { name: "5시간 츄르" })).toBeInTheDocument();
    expect(screen.queryByText("확인할 수 없음")).not.toBeInTheDocument();
  });

  it("화면이 다시 보일 때 5분이 지났으면 다시 읽고, 안 지났으면 읽지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const read = vi.spyOn(ipc, "usageRead").mockResolvedValue(OK_USAGE);
    render(<Home {...NAV} />);
    await act(async () => undefined);
    expect(read).toHaveBeenCalledTimes(1);

    const show = () => document.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(Date.now() + 4 * 60_000);
    act(show);
    expect(read).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await act(async () => show());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("창이 숨어 있는 동안에는 다시 읽지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const read = vi.spyOn(ipc, "usageRead").mockResolvedValue(OK_USAGE);
    render(<Home {...NAV} />);
    await act(async () => undefined);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("고양이 집 — 에이전트가 깨지거나 없을 때", () => {
  it("하네스 없음 — 먹물만 집에 있고 카드에 안내 한 줄, 준비 상태에는 하네스가 빠졌다고", async () => {
    fakeHouse.reset({ agents: "no_harness" });
    render(<Home {...NAV} />);
    expect(await screen.findByText("하네스를 설치하면 고양이들이 와요")).toBeInTheDocument();
    await screen.findByRole("meter", { name: "5시간 츄르" });
    expect(catButtons().map(catName)).toEqual(["먹물"]);
    expect(await screen.findByText("준비 중 3/4")).toBeInTheDocument();
    expect(screen.getByText("필요한 것: 하네스")).toBeInTheDocument();

    // 먹물 패널 — 에이전트 파일 정보가 없어도 열린다
    fireEvent.click(catButtons()[0]);
    const panel = screen.getByRole("region", { name: "먹물" });
    expect(within(panel).getByText("오케스트레이터", { selector: "code" })).toBeInTheDocument();
    expect(within(panel).getByText(/사용자와 이야기하고 계획을 세운 뒤/)).toBeInTheDocument();
  });

  it("설정이 깨졌다(역할을 모름) — 먹물만, 안내 한 줄", async () => {
    fakeHouse.reset({ agents: "broken" });
    render(<Home {...NAV} />);
    expect(await screen.findByText("하네스 설정을 읽지 못해 먹물만 있어요")).toBeInTheDocument();
    expect(catButtons().map(catName)).toEqual(["먹물"]);
  });

  it("읽을 수 없는 에이전트 파일 — 그 고양이는 집에 있고, 패널에 '읽을 수 없어요' + 파일 이름 + 이유. 나머지는 그대로", async () => {
    const list: AgentsList = {
      state: "ok",
      config: "local",
      missingRoles: [],
      agents: [
        { state: "ok", role: "main", file: null, name: "main", description: null, model: "opus", effort: "high", color: null, readOnly: false },
        { state: "unreadable", role: "tester", file: "harness-tester.md", reason: "no_frontmatter" },
        { state: "ok", role: "reviewer", file: "harness-reviewer.md", name: "harness-reviewer", description: "감사관.", model: "opus", effort: "xhigh", color: null, readOnly: true },
        // 역할이 없는 에이전트(하네스 밖)는 이번엔 집에 나오지 않는다
        { state: "ok", role: null, file: "translator.md", name: "translator", description: "번역.", model: "haiku", effort: "low", color: null, readOnly: false },
      ],
    };
    vi.spyOn(ipc, "agentsList").mockResolvedValue(list);
    render(<Home {...NAV} />);
    await vi.waitFor(() => expect(catButtons().map(catName).sort()).toEqual(["구름", "깨비", "먹물"]));

    fireEvent.click(screen.getByRole("button", { name: /^깨비,/ }));
    const panel = screen.getByRole("region", { name: "깨비" });
    expect(within(panel).getByText("에이전트 파일을 읽을 수 없어요")).toBeInTheDocument();
    expect(within(panel).getByText("harness-tester.md")).toBeInTheDocument();
    expect(within(panel).getByText("맨 앞의 설정 부분(---)이 없어요.")).toBeInTheDocument();
    expect(within(panel).queryByText("모델")).not.toBeInTheDocument();

    // 읽을 수 있는 쪽은 그대로 — 읽기 전용 표시, 모르는 수준 이름은 글 그대로가 아니라 풀어서
    fireEvent.click(screen.getByRole("button", { name: /^구름,/ }));
    const reviewer = screen.getByRole("region", { name: "구름" });
    expect(within(reviewer).getByText("읽기 전용")).toBeInTheDocument();
    expect(within(reviewer).getByText("아주 높음")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "깨비" })).not.toBeInTheDocument();
  });

  it("목록 명령이 오류를 내도 먹물은 집에 있고 안내 한 줄 — 앱이 죽지 않는다", async () => {
    vi.spyOn(ipc, "agentsList").mockRejectedValue(new Error("boom"));
    render(<Home {...NAV} />);
    expect(await screen.findByText("에이전트 목록을 읽지 못했어요")).toBeInTheDocument();
    expect(catButtons().map(catName)).toEqual(["먹물"]);
  });

  it("설정 폴더 위치를 정할 수 없으면 그렇다고 알린다", async () => {
    vi.spyOn(ipc, "agentsList").mockResolvedValue({ state: "location_unusable", config: "none", agents: [], missingRoles: [] });
    render(<Home {...NAV} />);
    expect(await screen.findByText("Claude 설정 폴더를 찾지 못했어요")).toBeInTheDocument();
  });

  it("준비 상태 명령이 모두 실패하면 '확인하지 못했어요' — 나머지 화면은 그대로", async () => {
    vi.spyOn(ipc, "claudeDiscover").mockRejectedValue(new Error("boom"));
    vi.spyOn(ipc, "harnessStatus").mockRejectedValue(new Error("boom"));
    fakeHouse.reset({ agents: "no_harness" });
    render(<Home {...NAV} />);
    expect(await screen.findByText("준비 상태를 확인하지 못했어요.")).toBeInTheDocument();
    expect(screen.getByText("준비 중 0/4")).toBeInTheDocument();
    await screen.findByRole("meter", { name: "5시간 츄르" });
  });

  it("Claude 를 못 찾으면 Claude Code · 로그인이 빠졌다고 센다", async () => {
    vi.spyOn(ipc, "claudeDiscover").mockResolvedValue({
      found: false,
      path: null,
      version: null,
      knownVersion: "2.1.296",
      versionMatches: null,
      loggedIn: null,
      authMethod: null,
      subscriptionType: null,
      apiKeyPresent: false,
      otherBilling: [],
      problem: null,
    });
    render(<Home {...NAV} />);
    expect(await screen.findByText("준비 중 2/4")).toBeInTheDocument();
    expect(screen.getByText("필요한 것: Claude Code · 로그인")).toBeInTheDocument();
  });
});

describe("고양이 집 — 정보 패널 키보드 흐름", () => {
  it("Enter(클릭) 로 열면 제목으로 포커스, 실제 필드가 나오고, Esc 로 닫으면 그 고양이로 포커스가 돌아온다", async () => {
    render(<Home {...NAV} />);
    await loaded();

    const nabi = screen.getByRole("button", { name: /^나비,/ });
    nabi.focus();
    expect(nabi).toHaveFocus();
    // jsdom 은 Enter 로 단추를 누르지 않으므로, 브라우저가 Enter 에 하는 일(click)을 보낸다
    fireEvent.click(nabi);

    const panel = screen.getByRole("region", { name: "나비" });
    expect(nabi).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByRole("heading", { name: "나비" })).toHaveFocus();
    expect(within(panel).getByText("시스템 구현")).toBeInTheDocument();
    expect(within(panel).getByText("harness-builder-system", { selector: "code" })).toBeInTheDocument();
    expect(within(panel).getByText(/쉬는 중/)).toBeInTheDocument();
    expect(within(panel).getByText("Sonnet")).toBeInTheDocument();
    expect(within(panel).getByText("높음")).toBeInTheDocument();
    expect(within(panel).getByText(/의심이 많아요/)).toBeInTheDocument();
    expect(within(panel).getByText(/틀리면 비용이 큰 구현을 지시서대로 한다/)).toBeInTheDocument();
    // 고치기 · 고양이 바꾸기는 없다
    expect(within(panel).queryByRole("link")).not.toBeInTheDocument();
    expect(within(panel).queryByText(/고치기|고양이 바꾸기/)).not.toBeInTheDocument();
    // 닫기 단추만 있다
    expect(within(panel).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["닫기"]);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "나비" })).not.toBeInTheDocument();
    expect(nabi).toHaveAttribute("aria-expanded", "false");
    expect(nabi).toHaveFocus();
  });

  it("닫기 단추로 닫아도 그 고양이로 포커스가 돌아온다", async () => {
    render(<Home {...NAV} />);
    await loaded();
    const mukmul = screen.getByRole("button", { name: /^먹물,/ });
    fireEvent.click(mukmul);
    const panel = screen.getByRole("region", { name: "먹물" });
    // 오케스트레이터 — 이름은 '오케스트레이터', 모델 · 수준은 에이전트 목록에서
    expect(within(panel).getByText("오케스트레이터", { selector: "code" })).toBeInTheDocument();
    expect(within(panel).getByText("Opus")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("region", { name: "먹물" })).not.toBeInTheDocument();
    expect(mukmul).toHaveFocus();
  });

  it("맡는 일 = 에이전트 description. 긴 글은 접어 두고 '더 보기' 로 펼친다. 짧으면 단추가 없다", async () => {
    const long = "아주 긴 설명. ".repeat(30).trim();
    const list: AgentsList = {
      state: "ok",
      config: "local",
      missingRoles: [],
      agents: [
        { state: "ok", role: "main", file: null, name: "main", description: null, model: "opus", effort: "high", color: null, readOnly: false },
        { state: "ok", role: "designer", file: "harness-designer.md", name: "harness-designer", description: long, model: "opus", effort: "high", color: null, readOnly: false },
        { state: "ok", role: "helper", file: "harness-helper.md", name: "harness-helper", description: "짧은 설명.", model: null, effort: null, color: null, readOnly: false },
      ],
    };
    vi.spyOn(ipc, "agentsList").mockResolvedValue(list);
    render(<Home {...NAV} />);
    await vi.waitFor(() => expect(catButtons()).toHaveLength(3));

    fireEvent.click(screen.getByRole("button", { name: /^물감,/ }));
    let panel = screen.getByRole("region", { name: "물감" });
    const more = within(panel).getByRole("button", { name: "더 보기" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(panel).getByText(long)).toHaveAttribute("data-folded", "true");
    fireEvent.click(more);
    const less = within(panel).getByRole("button", { name: "접기" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    expect(within(panel).getByText(long)).not.toHaveAttribute("data-folded");

    fireEvent.click(screen.getByRole("button", { name: /^두부,/ }));
    panel = screen.getByRole("region", { name: "두부" });
    expect(within(panel).getByText("짧은 설명.")).not.toHaveAttribute("data-folded");
    expect(within(panel).queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
    // 모델 · 수준을 모르면 '알 수 없음'
    expect(within(panel).getAllByText("알 수 없음")).toHaveLength(2);
  });

  it("고양이를 다시 누르면 패널이 닫힌다", async () => {
    render(<Home {...NAV} />);
    await loaded();
    const gureum = screen.getByRole("button", { name: /^구름,/ });
    fireEvent.click(gureum);
    expect(within(screen.getByRole("region", { name: "구름" })).getByText("읽기 전용")).toBeInTheDocument();
    fireEvent.click(gureum);
    expect(screen.queryByRole("region", { name: "구름" })).not.toBeInTheDocument();
  });
});

describe("고양이 집 — 시간대 · 움직임", () => {
  it("PC 시각을 1분마다 다시 보고 시간대(data-time)가 바뀐다 (가짜 시계)", async () => {
    vi.useFakeTimers();
    let hour = 9;
    const clock = () => new Date(2026, 9, 28, hour, 30);
    render(<Home {...NAV} clock={clock} />);
    await act(async () => undefined);
    expect(screen.getByTestId("home")).toHaveAttribute("data-time", "morning");
    expect(screen.getByRole("region", { name: "고양이들" })).toHaveAttribute("data-time", "morning");

    hour = 18;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("home")).toHaveAttribute("data-time", "evening");
    expect(screen.getByRole("region", { name: "고양이들" })).toHaveAttribute("data-time", "evening");

    hour = 23;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByTestId("home")).toHaveAttribute("data-time", "night");
  });

  it("초기화 시각 · '읽은 지 n분' 도 시계를 따라간다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 28, 13, 0));
    vi.spyOn(ipc, "usageRead").mockResolvedValue({ ...OK_USAGE, readAt: Math.floor(Date.now() / 1000) });
    render(<Home {...NAV} />);
    await act(async () => undefined);
    expect(screen.getByText("방금 읽음")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(screen.getByText("5분 전 읽음")).toBeInTheDocument();
  });

  it("움직임 끔이면 걷지도 사라지지도 않는다", async () => {
    document.documentElement.dataset.motion = "reduced";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    render(<Home {...NAV} />);
    await act(async () => undefined);
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });
      for (const cat of document.querySelectorAll(".hs-cat")) {
        expect(cat).not.toHaveAttribute("data-walking");
        expect(cat).not.toHaveAttribute("data-fade");
      }
    }
  });

  it("창이 숨으면 :root 에 data-hidden 이 붙고 고양이가 자리를 바꾸지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    render(<Home {...NAV} />);
    await act(async () => undefined);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(document.documentElement.dataset.hidden).toBe("true");
    const spots = () => [...document.querySelectorAll(".hs-cat")].map((cat) => cat.getAttribute("data-spot"));
    const before = spots();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(spots()).toEqual(before);
  });

  it("고양이는 쉬는 자리에만 있다 — 캣휠 · 캣타워 · 댓돌(일 · 기다림 자리)은 비어 있다", async () => {
    render(<Home {...NAV} />);
    await loaded();
    const spots = [...document.querySelectorAll(".hs-cat")].map((cat) => cat.getAttribute("data-spot"));
    expect(spots).toHaveLength(7);
    for (const spot of ["wheel", "tower", "stone"]) expect(spots).not.toContain(spot);
  });
});

describe("고양이 집 — 개발 빌드 시험 화면 링크 · 정리", () => {
  it("개발 빌드에서는 구석에 시험 화면 링크가 있다", async () => {
    render(<Home {...NAV} />);
    const nav = screen.getByRole("navigation", { name: "개발 빌드 전용 화면" });
    expect(within(nav).getByRole("link", { name: /Claude 연결 시험 화면/ })).toHaveAttribute("href", "?lab=session");
    expect(within(nav).getByRole("link", { name: /하네스 설치 점검/ })).toHaveAttribute("href", "?lab=harness");
    await loaded();
  });

  it("답이 오기 전에 화면을 닫아도 상태 갱신 경고가 없다", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const resolvers: (() => void)[] = [];
    const slow = <T,>(value: T) => new Promise<T>((resolve) => resolvers.push(() => resolve(value)));
    vi.spyOn(ipc, "agentsList").mockImplementation(() => slow({ state: "no_harness", config: "none", agents: [], missingRoles: [] } as AgentsList));
    vi.spyOn(ipc, "usageRead").mockImplementation(() => slow(OK_USAGE));
    const { unmount } = render(<Home {...NAV} />);
    unmount();
    await act(async () => {
      resolvers.forEach((resolve) => resolve());
    });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("고양이 집 — 오늘 앱 세션 츄르 줄", () => {
  const FIXED_FAKE = 225_531; // 가짜 목록의 오늘 합 (fakeHistory.ts)

  async function summary(override: Partial<UsageSummary["today"]> = {}): Promise<UsageSummary> {
    const real = await ipc.appUsageSummary();
    return { ...real, today: { ...real.today, ...override } };
  }

  afterEach(() => resetSessionStore());

  it("오늘 합을 '약 n' 과 '추정' 표로 보인다 (숫자는 세 자리마다 쉼표)", async () => {
    render(<Home {...NAV} />);
    await loaded();
    const line = await screen.findByText(/오늘 앱 세션 츄르 약/);
    expect(line).toHaveTextContent(`오늘 앱 세션 츄르 약 ${FIXED_FAKE.toLocaleString("ko-KR")}추정`);
    expect(within(line).getByText("추정")).toBeInTheDocument();
  });

  it("오늘 턴이 없으면 '아직 없음'", async () => {
    vi.spyOn(ipc, "appUsageSummary").mockResolvedValue(await summary({ turns: 0, totalTokens: 0 }));
    render(<Home {...NAV} />);
    expect(await screen.findByText("오늘 앱 세션 츄르 아직 없음")).toBeInTheDocument();
    expect(screen.queryByText("추정")).not.toBeInTheDocument();
  });

  it("한도를 못 읽어도 이 줄은 따로 보인다", async () => {
    vi.spyOn(ipc, "usageRead").mockResolvedValue({ state: "unavailable", reason: "not_logged_in" });
    render(<Home {...NAV} />);
    expect(await screen.findByText("확인할 수 없음")).toBeInTheDocument();
    expect(await screen.findByText(/오늘 앱 세션 츄르 약/)).toBeInTheDocument();
  });

  it("집이 보이는 동안 세션 저장소가 츄르를 새로 읽으면(턴이 끝나면) 다시 읽어 숫자가 바뀐다", async () => {
    const first = await summary({ turns: 6, totalTokens: 1000 });
    const second = await summary({ turns: 7, totalTokens: 2500 });
    const read = vi.spyOn(ipc, "appUsageSummary").mockResolvedValueOnce(first).mockResolvedValue(second);
    render(<Home {...NAV} />);
    expect(await screen.findByText(/약 1,000/)).toBeInTheDocument();
    await act(async () => {
      useSessionStore.setState({ churros: { projectId: 1, totalTokens: 42, referenceOnly: true } });
    });
    expect(await screen.findByText(/약 2,500/)).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("다시 읽다 실패하면 지난 숫자를 그대로 둔다", async () => {
    const first = await summary({ turns: 6, totalTokens: 1000 });
    vi.spyOn(ipc, "appUsageSummary").mockResolvedValueOnce(first).mockRejectedValue(new AppError("db_unavailable", "x"));
    render(<Home {...NAV} />);
    expect(await screen.findByText(/약 1,000/)).toBeInTheDocument();
    await act(async () => {
      useSessionStore.setState({ churros: { projectId: 1, totalTokens: 42, referenceOnly: true } });
    });
    expect(screen.getByText(/약 1,000/)).toBeInTheDocument();
  });

  it("한 번도 못 읽었으면 줄을 감춘다 (앱은 그대로)", async () => {
    vi.spyOn(ipc, "appUsageSummary").mockRejectedValue(new AppError("db_unavailable", "x"));
    render(<Home {...NAV} />);
    await loaded();
    expect(screen.queryByText(/오늘 앱 세션 츄르/)).not.toBeInTheDocument();
  });

  it("집을 닫은 뒤에는 저장소가 바뀌어도 읽지 않는다", async () => {
    const read = vi.spyOn(ipc, "appUsageSummary");
    const { unmount } = render(<Home {...NAV} />);
    await loaded();
    const count = read.mock.calls.length;
    unmount();
    await act(async () => {
      useSessionStore.setState({ churros: { projectId: 1, totalTokens: 7, referenceOnly: true } });
    });
    expect(read.mock.calls.length).toBe(count);
  });
});

describe("고양이 집 — 카드에 덮인 자리", () => {
  it("카드가 덮은 자리의 고양이는 다른 자리로 옮겨져 있다 (고양이는 7마리 그대로)", async () => {
    const hit = spotHitBox("sun");
    const rect = (left: number, top: number, right: number, bottom: number) =>
      ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    // 장면 1536 × 1024 (배경 1px = 화면 1px), 위 카드가 볕 자리를 덮는다
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.classList.contains("hm-scene")) return rect(0, 0, 1536, 1024);
      if (this.classList.contains("hm-status")) return rect(hit.left - 5, hit.top - 5, hit.right + 5, hit.bottom + 5);
      return rect(0, 0, 0, 0);
    });
    render(<Home {...NAV} />);
    await loaded();
    const spots = [...document.querySelectorAll(".hs-cat")].map((cat) => cat.getAttribute("data-spot"));
    expect(spots).toHaveLength(7);
    expect(spots).not.toContain("sun");
    // 덮이지 않은 자리 — 나비의 상자는 그대로
    expect(SPOTS.box.kind).toBe("rest");
    expect(spots).toContain("box");
  });
});
