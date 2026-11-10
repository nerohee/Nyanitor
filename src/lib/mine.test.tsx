// 내 고양이 연결 · 보이는 이름 공용 모듈 — 순수 함수(찾는 순서) · 읽기(못 읽음 · ok 아님은 빈 것) · 알림 · 구독 훅.
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "./ipc";
import { ensureMine, getMine, mineCat, mineLabel, NO_MINE, orchCat, reloadMine, resetMine, setMine, useMine, type Mine } from "./mine";

const mine = (cats: Record<string, string> = {}, labels: Record<string, string> = {}): Mine => ({ cats, labels });

beforeEach(() => resetMine());
afterEach(() => {
  vi.restoreAllMocks();
  resetMine();
});

describe("mineCat — 고양이 찾는 순서", () => {
  it("내 연결(에이전트 이름)이 기본 연결(역할)보다 먼저", () => {
    expect(mineCat("harness-builder-ui", "ui", mine({ "harness-builder-ui": "gureum" }))).toBe("gureum");
    expect(mineCat("harness-builder-ui", "ui", NO_MINE)).toBe("danchu");
  });

  it("내 연결의 고양이가 카탈로그에 없으면 건너뛴다", () => {
    expect(mineCat("harness-builder-ui", "ui", mine({ "harness-builder-ui": "ghost" }))).toBe("danchu");
    expect(mineCat("main", "main", mine({ main: "ghost" }))).toBe("mukmul");
  });

  it("키는 에이전트 이름이다 — 역할 이름(ui)으로 적은 것은 보지 않는다", () => {
    expect(mineCat("harness-builder-ui", "ui", mine({ ui: "gureum" }))).toBe("danchu");
  });

  it("역할이 없는 에이전트는 내 연결이 있어야 나온다, 없으면 null", () => {
    expect(mineCat("translator", null, mine({ translator: "dubu" }))).toBe("dubu");
    expect(mineCat("translator", null, NO_MINE)).toBeNull();
  });

  it("오케스트레이터는 `main` — 내 연결 → 먹물", () => {
    expect(orchCat(mine({ main: "nabi" }))).toBe("nabi");
    expect(orchCat(NO_MINE)).toBe("mukmul");
  });
});

describe("mineLabel — 이름 찾는 순서", () => {
  it("보이는 이름 → 역할 이름 → 에이전트 이름", () => {
    expect(mineLabel("translator", null, mine({}, { translator: "번역" }))).toBe("번역");
    expect(mineLabel("harness-builder-ui", "ui", NO_MINE)).toBe("화면 구현");
    expect(mineLabel("translator", null, NO_MINE)).toBe("translator");
  });

  it("빈 보이는 이름은 없는 것으로 · 오케스트레이터는 보이는 이름이 없다", () => {
    expect(mineLabel("harness-builder-ui", "ui", mine({}, { "harness-builder-ui": "" }))).toBe("화면 구현");
    expect(mineLabel("main", "main", mine({}, { main: "대장" }))).toBe("메인 대화");
  });
});

describe("읽기 · 알림", () => {
  it("처음 쓰일 때 두 파일을 같이 읽어 들고 있는다", async () => {
    const cats = vi.spyOn(ipc, "customCatsRead").mockResolvedValue({ state: "ok", agents: { translator: "dubu" } });
    const labels = vi.spyOn(ipc, "customLabelsRead").mockResolvedValue({ state: "ok", agents: { translator: "번역" } });
    expect(getMine()).toBe(NO_MINE);
    await ensureMine();
    await ensureMine();
    expect(getMine()).toEqual({ cats: { translator: "dubu" }, labels: { translator: "번역" } });
    expect(cats).toHaveBeenCalledTimes(1);
    expect(labels).toHaveBeenCalledTimes(1);
  });

  it("읽지 못한 쪽 · state 가 ok 가 아닌 쪽은 빈 것 (다른 쪽은 그대로)", async () => {
    vi.spyOn(ipc, "customCatsRead").mockResolvedValue({ state: "unreadable", agents: { translator: "dubu" } } as Awaited<ReturnType<typeof ipc.customCatsRead>>);
    vi.spyOn(ipc, "customLabelsRead").mockRejectedValue(new Error("x"));
    await ensureMine();
    expect(getMine()).toEqual({ cats: {}, labels: {} });
    resetMine();
    vi.spyOn(ipc, "customCatsRead").mockRejectedValue(new Error("x"));
    vi.spyOn(ipc, "customLabelsRead").mockResolvedValue({ state: "ok", agents: { translator: "번역" } });
    await ensureMine();
    expect(getMine()).toEqual({ cats: {}, labels: { translator: "번역" } });
  });

  it("둘 다 명령이 실패하면 빈 것으로 그리고, 다음에 다시 읽는다", async () => {
    const cats = vi.spyOn(ipc, "customCatsRead").mockRejectedValue(new Error("x"));
    vi.spyOn(ipc, "customLabelsRead").mockRejectedValue(new Error("x"));
    await ensureMine();
    expect(getMine()).toBe(NO_MINE);
    cats.mockResolvedValue({ state: "ok", agents: { main: "nabi" } });
    vi.spyOn(ipc, "customLabelsRead").mockResolvedValue({ state: "ok", agents: {} });
    await ensureMine();
    expect(getMine().cats).toEqual({ main: "nabi" });
  });

  it("reloadMine 은 다시 읽고, 읽지 못하면 들고 있던 것을 그대로 둔다", async () => {
    setMine(mine({ main: "nabi" }));
    vi.spyOn(ipc, "customCatsRead").mockRejectedValue(new Error("x"));
    vi.spyOn(ipc, "customLabelsRead").mockRejectedValue(new Error("x"));
    await reloadMine();
    expect(getMine().cats).toEqual({ main: "nabi" });
    vi.spyOn(ipc, "customCatsRead").mockResolvedValue({ state: "ok", agents: {} });
    vi.spyOn(ipc, "customLabelsRead").mockResolvedValue({ state: "ok", agents: {} });
    await reloadMine();
    expect(getMine().cats).toEqual({});
  });
});

describe("useMine — 구독", () => {
  function Show() {
    const { cats } = useMine();
    return <p data-testid="out">{cats.main ?? "없음"}</p>;
  }

  it("처음 쓰일 때 읽고, 알리면 다시 그린다", async () => {
    vi.spyOn(ipc, "customCatsRead").mockResolvedValue({ state: "ok", agents: { main: "nabi" } });
    vi.spyOn(ipc, "customLabelsRead").mockResolvedValue({ state: "ok", agents: {} });
    render(<Show />);
    expect(screen.getByTestId("out")).toHaveTextContent("없음");
    await vi.waitFor(() => expect(screen.getByTestId("out")).toHaveTextContent("nabi"));
    act(() => setMine(mine({ main: "dubu" })));
    expect(screen.getByTestId("out")).toHaveTextContent("dubu");
  });

  it("같은 내용을 알리면 다시 그리지 않는다", () => {
    setMine(mine({ main: "nabi" }));
    const first = getMine();
    setMine(mine({ main: "nabi" }));
    expect(getMine()).toBe(first);
  });
});
