import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screenHref } from "../query";
import { CatPickScreen } from "./CatPick";
import { EditScreen } from "./Edit";
import { HarnessScreen } from "./Harness";
import { SettingsScreen } from "./Settings";
import { SetupScreen } from "./Setup";
import { TrayScreen } from "./Tray";

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

  it("업데이트: 내 수정과 겹치는 파일을 알리고(내 수정의 원본 바뀜으로 가는 길), 받기는 사용자가 누른다", () => {
    render(<HarnessScreen {...base} state="update" />);
    expect(screen.getByText("내 수정과 겹치는 파일이 1개 있어요")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /내 수정에서 보기/ }).getAttribute("href")).toMatch(/screen=edit.*state=conflict/);
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

describe("내 수정", () => {
  it("모델 · 수준은 값만 — 바꾸면 원본 값과 '적용하면 바뀌는 것'이 보이고, 되돌리기 · 적용", () => {
    render(<EditScreen {...base} state="" />);
    expect(screen.getByRole("heading", { level: 2, name: /화면 구현/ })).toBeInTheDocument();
    const model = screen.getByRole("combobox", { name: "모델" });
    expect(screen.getByText("모두 적용됨")).toBeInTheDocument();
    fireEvent.change(model, { target: { value: "opus" } });
    expect(screen.getByText("원본: Sonnet")).toBeInTheDocument();
    expect(screen.getByText("적용 안 한 것 1개")).toBeInTheDocument();
    const diff = screen.getByRole("region", { name: "적용하면 바뀌는 것" });
    expect(within(diff).getByText("model: opus")).toBeInTheDocument();
    // 되돌리기 → 원래대로, 다시 바꿔 적용 → 기록 알림
    fireEvent.click(screen.getByRole("button", { name: "되돌리기" }));
    expect(screen.getByText("모두 적용됨")).toBeInTheDocument();
    fireEvent.change(model, { target: { value: "opus" } });
    fireEvent.click(screen.getByRole("button", { name: "적용" }));
    expect(screen.getByRole("status")).toHaveTextContent("적용했어요");
    expect(screen.getByText("모두 적용됨")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "적용" })).toBeDisabled();
  });

  it("통째로 바꾼 파일은 경고와 함께 파일 전체를 고치고, 원본이 바뀌었으면 고르러 가는 길이 있다", () => {
    render(<EditScreen {...base} state="replace" />);
    expect(screen.getByText("이 파일은 통째로 바꿨어요")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "골라 보기" }).getAttribute("href")).toContain("state=conflict");
    fireEvent.click(screen.getByRole("button", { name: /덧붙이기로 돌아가기/ }));
    expect(screen.getByRole("heading", { name: "덧붙일 지시" })).toBeInTheDocument();
  });

  it("원본 바뀜: 고르기 전엔 내 것을 쓰고, 비교를 두 가지로 보고, 내 것 유지 / 원본으로 를 고른다", () => {
    render(<EditScreen {...base} state="conflict" />);
    expect(screen.getByText("고르기 전까지는 내 것을 그대로 써요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "내 것과 다른 점" }));
    expect(screen.getByRole("region", { name: "내 것과 다른 점" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /원본으로 바꾸기/ }));
    expect(screen.getByRole("status")).toHaveTextContent("원본으로 바꿨어요");
    expect(screen.getByRole("button", { name: /다시 고르기/ })).toBeInTheDocument();
  });

  it("기록은 되돌리기 전에 한 번 더 묻고, 새 에이전트는 고양이 고르기로 이어진다", () => {
    const { unmount } = render(<EditScreen {...base} state="history" />);
    // 가장 최근 기록은 '지금' — 되돌릴 수 없다
    expect(screen.getByRole("button", { name: /이때로 되돌리기/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /시험 — 지시 덧붙임/ }));
    fireEvent.click(screen.getByRole("button", { name: /이때로 되돌리기/ }));
    expect(screen.getByText("0b7e215 때로 되돌릴까요?")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "되돌리기" })[0]);
    expect(screen.getByRole("status")).toHaveTextContent("새 기록이 생겼어요");
    unmount();

    render(<EditScreen {...base} state="new" />);
    expect(screen.getByRole("link", { name: /만들고 고양이 고르기/ }).getAttribute("href")).toMatch(/screen=pick.*state=new/);
    fireEvent.click(screen.getByRole("radio", { name: "스킬" }));
    expect(screen.getByText("~/.claude-harness/custom/skills/translator/SKILL.md")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /고양이 고르기/ })).not.toBeInTheDocument();
  });
});

describe("트레이 · 알림 견본", () => {
  it("상태 4가지 메뉴 — 첫 줄은 상태, 기다릴 때는 '기다리는 카드로 가기'가 맨 위, 일하는 중 종료는 한 번 더 묻는다(…)", () => {
    render(<TrayScreen {...base} state="" />);
    const menus = screen.getAllByRole("list", { name: "트레이 메뉴 견본" });
    expect(menus).toHaveLength(4);
    const waiting = within(menus[2]).getAllByRole("listitem");
    expect(waiting[0]).toHaveTextContent("답을 기다려요");
    expect(waiting[1]).toHaveTextContent("기다리는 카드로 가기");
    expect(within(menus[1]).getByText(/종료…/)).toBeInTheDocument();
    expect(within(menus[0]).queryByText(/종료…/)).not.toBeInTheDocument();
  });

  it("알림은 내가 할 일이 있을 때만 — 누르면 그 카드로, 알림 안에서 답하지 않는다", () => {
    render(<TrayScreen {...base} state="notify" />);
    expect(screen.getAllByRole("listitem").filter((li) => li.classList.contains("tr-toast"))).toHaveLength(9);
    expect(screen.getAllByText("누르면: 창을 열고 그 카드로").length).toBeGreaterThan(0);
    expect(screen.getByText(/알림 안에서 바로 답하지 않아요/)).toBeInTheDocument();
  });
});
