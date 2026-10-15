import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screenHref } from "../query";
import { CatPickScreen } from "./CatPick";
import { HarnessScreen } from "./Harness";
import { SettingsScreen } from "./Settings";
import { SetupScreen } from "./Setup";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.motion;
  vi.useRealTimers();
});

const base = { search: "", time: "day" as const };

describe("첫 실행 · 준비", () => {
  it("기본(하나 빠짐)은 빠진 로그인 줄 하나만 펼치고, 앱이 로그인 정보를 다루지 않는다고 알린다", () => {
    render(<SetupScreen {...base} state="" />);
    const list = screen.getByRole("list", { name: "준비 목록" });
    const rows = within(list)
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("su-row"));
    expect(rows.map((row) => row.dataset.status)).toEqual(["ok", "missing", "ok", "ok"]);
    expect(rows.filter((row) => row.dataset.open === "true")).toHaveLength(1);
    expect(screen.getByText("3 / 4 준비됨")).toBeInTheDocument();
    expect(screen.getByText(/로그인 정보를 읽거나 저장하지 않아요/)).toBeInTheDocument();

    // 로그인 창 열기 → 기다림 안내 + 다시 확인
    fireEvent.click(screen.getByRole("button", { name: "로그인 창 열기" }));
    expect(screen.getByText(/터미널에서 로그인을 기다려요/)).toBeInTheDocument();
  });

  it("다시 확인을 누르면 잠시 확인 중으로 바뀌었다가 돌아온다", () => {
    vi.useFakeTimers();
    render(<SetupScreen {...base} state="git" />);
    fireEvent.click(screen.getByRole("button", { name: "모두 다시 확인" }));
    expect(screen.getAllByText("확인 중").length).toBeGreaterThan(0);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText("git 을 설치해요")).toBeInTheDocument();
  });

  it("모두 됨이면 고양이 집으로 가는 큰 단추, API 키가 있으면 값은 보이지 않고 있다는 것만 알린다", () => {
    const { unmount } = render(<SetupScreen {...base} state="ready" />);
    expect(screen.getByRole("link", { name: "고양이 집으로" }).getAttribute("href")).toContain("screen=house");
    unmount();

    render(<SetupScreen {...base} state="apikey" />);
    expect(screen.getByText("환경 변수에 ANTHROPIC_API_KEY 가 있어요")).toBeInTheDocument();
    expect(screen.getByText(/키 값은 읽지도 보이지도 않아요/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "알겠어요" }));
    expect(screen.queryByText("환경 변수에 ANTHROPIC_API_KEY 가 있어요")).not.toBeInTheDocument();
  });

  it("확인 실패는 원본 출력을 접어 두고, 하네스가 없으면 하네스 설치 화면으로 보낸다", () => {
    const { unmount } = render(<SetupScreen {...base} state="failed" />);
    expect(screen.getByText("로그인 상태를 확인하지 못했어요")).toBeInTheDocument();
    expect(screen.getByText("원본 출력").closest("details")).not.toHaveAttribute("open");
    unmount();

    render(<SetupScreen {...base} state="harness" />);
    expect(screen.getByRole("link", { name: /설치 미리보기/ }).getAttribute("href")).toContain("screen=harness");
  });
});

describe("설정", () => {
  it("테마 · 움직임 줄이기는 바로 :root 에 들어가고, 토글은 켬 · 끔을 글자로도 알린다", () => {
    render(<SettingsScreen {...base} state="" />);
    fireEvent.click(screen.getByRole("radio", { name: "어둡게" }));
    expect(document.documentElement.dataset.theme).toBe("dark");

    const motion = screen.getByRole("switch", { name: "움직임 줄이기" });
    expect(motion).toHaveAttribute("aria-checked", "false");
    expect(within(motion).getByText("끔")).toBeInTheDocument();
    fireEvent.click(motion);
    expect(motion).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.dataset.motion).toBe("reduced");
  });

  it("API 키가 있으면 '빼고 실행' 이 기본으로 골라져 있고, 직접 고르기를 고르면 경로 입력칸이 나온다", () => {
    render(<SettingsScreen {...base} state="apikey" />);
    expect(screen.getByRole("radio", { name: /빼고 실행/ })).toBeChecked();
    expect(screen.queryByRole("textbox", { name: "claude 실행 파일 경로" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /직접 고르기/ }));
    expect(screen.getByRole("textbox", { name: "claude 실행 파일 경로" })).toBeInTheDocument();
  });

  it("하네스 · 고양이 고르기로 가는 길이 있다", () => {
    render(<SettingsScreen {...base} state="update" />);
    expect(screen.getByRole("link", { name: /업데이트 확인/ }).getAttribute("href")).toContain("screen=harness");
    expect(screen.getByRole("link", { name: /고양이 고르기/ }).getAttribute("href")).toContain("screen=pick");
    expect(screen.getByText("새 버전 0.2.0 이 있어요")).toBeInTheDocument();
  });
});

describe("하네스", () => {
  it("설치 미리보기: 바뀌는 파일을 고르면 차이를 +/- 글자로도 보인다", () => {
    render(<HarnessScreen {...base} state="install" />);
    expect(screen.getByText("~/.claude-harness/repo/")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /CLAUDE\.md/ }));
    const diff = screen.getByRole("region", { name: /CLAUDE\.md/ });
    expect(within(diff).getAllByText("+").length).toBeGreaterThan(0);
    // 걸러 보기
    fireEvent.click(screen.getByRole("radio", { name: "새로" }));
    expect(screen.queryByRole("button", { name: /settings\.json/ })).not.toBeInTheDocument();
  });

  it("업데이트: 내 수정과 겹치는 파일을 알리고, 받기는 사용자가 누른다", () => {
    render(<HarnessScreen {...base} state="update" />);
    expect(screen.getByText("내 수정과 겹치는 파일이 1개 있어요")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /업데이트 받기/ })).toBeInTheDocument();
  });

  it("실패는 경고로 읽히고 되돌린 것을 알린다, 백업은 되돌리기 전에 한 번 더 묻는다", () => {
    const { unmount } = render(<HarnessScreen {...base} state="failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("설치하다 멈췄어요");
    expect(screen.getByRole("alert")).toHaveTextContent("백업에서 되돌렸어요");
    unmount();

    render(<HarnessScreen {...base} state="backups" />);
    const restore = screen.getAllByRole("button", { name: "되돌리기" })[0];
    fireEvent.click(restore);
    expect(restore).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/으로 되돌릴까요\?/)).toBeInTheDocument();
  });
});

describe("에이전트 고양이 고르기", () => {
  it("다른 에이전트가 쓰던 고양이를 고르면 서로 바꾸고, 되돌릴 수 있다", () => {
    render(<CatPickScreen {...base} state="" />);
    // 오케스트레이터(먹물)에서 물감을 고른다 — 물감은 디자이너가 쓰는 중
    expect(screen.getByRole("tab", { name: /오케스트레이터/ })).toHaveAttribute("aria-selected", "true");
    const mulgam = screen.getByRole("radio", { name: /물감/ });
    fireEvent.click(mulgam);
    expect(mulgam).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("오케스트레이터, 디자이너의 고양이를 서로 바꿨어요.");
    expect(screen.getByRole("tab", { name: /디자이너/ })).toHaveTextContent("먹물");

    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    expect(screen.getByRole("radio", { name: /먹물/ })).toBeChecked();
  });

  it("에이전트는 ↑/↓ 로 옮기고, 새 에이전트는 아직 고양이가 없다", () => {
    const { unmount } = render(<CatPickScreen {...base} state="" />);
    const main = screen.getByRole("tab", { name: /오케스트레이터/ });
    main.focus();
    fireEvent.keyDown(main, { key: "ArrowDown" });
    expect(screen.getByRole("tab", { name: /디자이너/ })).toHaveFocus();
    unmount();

    render(<CatPickScreen {...base} state="new" />);
    expect(screen.getByRole("tab", { name: /번역/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("새 에이전트 「번역」을 만들었어요")).toBeInTheDocument();
    expect(screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked)).toHaveLength(0);
  });
});

describe("화면 사이 주소", () => {
  it("다른 화면으로 갈 때 화면마다 뜻이 다른 쿼리는 떼고, 시안 · UI 판 · 테마는 남긴다", () => {
    const href = screenHref("?variant=a&skin=2&theme=dark&screen=setup&state=failed&cat=nabi", "harness", { state: "update" });
    const params = new URLSearchParams(href);
    expect(params.get("screen")).toBe("harness");
    expect(params.get("state")).toBe("update");
    expect(params.get("skin")).toBe("2");
    expect(params.get("theme")).toBe("dark");
    expect(params.has("cat")).toBe(false);
  });
});
