// 고양이 집 IPC (P5-01) — 명령 이름 · 인자 없음, 브라우저 가짜(고양이 7마리 · 사용량 ok / unavailable · 주소 쿼리), 출시 빌드에서 가짜로 돌지 않음.
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import agentCats from "../assets/cats/agent-cats.json";
import { fakeHouse, parseFakeHouseQuery } from "./fakeHouse";
import { ipc, type AgentRole } from "./ipc";

beforeEach(() => {
  fakeHouse.reset();
});

afterEach(() => {
  clearMocks();
  vi.unstubAllEnvs();
  window.history.replaceState({}, "", "/");
  fakeHouse.reset();
});

describe("고양이 집 ipc (Tauri 안)", () => {
  it("함수마다 정해진 명령을 인자 없이 부른다", async () => {
    const handler = vi.fn(() => null);
    mockIPC(handler);
    await ipc.agentsList();
    await ipc.usageRead();
    expect(handler.mock.calls).toEqual([
      ["agents_list", {}],
      ["usage_read", {}],
    ]);
  });

  it("Rust 가 돌려준 모양을 그대로 넘긴다 (읽을 수 없는 항목 · 못 받은 사용량 포함)", async () => {
    const list = {
      state: "ok",
      config: "local",
      agents: [{ state: "unreadable", role: "tester", file: "harness-tester.md", reason: "no_frontmatter" }],
      missingRoles: [],
    };
    mockIPC((command) => (command === "agents_list" ? list : { state: "unavailable", reason: "timeout" }));
    await expect(ipc.agentsList()).resolves.toEqual(list);
    await expect(ipc.usageRead()).resolves.toEqual({ state: "unavailable", reason: "timeout" });
  });
});

describe("고양이 집 ipc (브라우저 가짜 모드)", () => {
  it("기본 가짜 목록에는 시제품 a 의 고양이 7마리가 모두 나온다 (역할마다 하나, 오케스트레이터가 맨 앞)", async () => {
    const list = await ipc.agentsList();
    expect(list.state).toBe("ok");
    expect(list.config).toBe("local");
    expect(list.missingRoles).toEqual([]);
    const roles = list.agents.map((entry) => entry.role);
    expect(roles[0]).toBe("main");
    // 화면 쪽 고양이 대응(`agent-cats.json`)의 역할 이름은 Rust 역할 이름과 같다
    const catRoles = Object.keys(agentCats.agents);
    expect(roles.slice().sort()).toEqual(catRoles.slice().sort());
    expect(new Set(roles).size).toBe(7);
    for (const entry of list.agents) expect(entry.state).toBe("ok");
  });

  it("가짜 목록의 오케스트레이터는 모델 · 수준이 있고 파일이 없으며, 감사관만 읽기 전용이다", async () => {
    const { agents } = await ipc.agentsList();
    const main = agents[0];
    expect(main).toMatchObject({ state: "ok", role: "main", file: null, model: "opus", effort: "high" });
    const readOnly = agents.flatMap((entry) => (entry.state === "ok" && entry.readOnly ? [entry.role] : []));
    expect(readOnly).toEqual<AgentRole[]>(["reviewer"]);
    for (const entry of agents.slice(1)) {
      expect(entry.state === "ok" && entry.file).toMatch(/\.md$/);
    }
  });

  it("가짜 값에는 경로가 없다 (파일 이름만)", async () => {
    const text = JSON.stringify(await ipc.agentsList());
    expect(text).not.toMatch(/[\\/]/);
  });

  it("사용량은 기본으로 ok — 사용률은 0~1, 초기화 시각은 지금보다 뒤의 유닉스 초", async () => {
    const usage = await ipc.usageRead();
    if (usage.state !== "ok") throw new Error("ok 여야 한다");
    const now = Math.floor(Date.now() / 1000);
    for (const window of [usage.fiveHour, usage.sevenDay]) {
      expect(window).not.toBeNull();
      expect(window?.utilization).toBeGreaterThanOrEqual(0);
      expect(window?.utilization).toBeLessThanOrEqual(1);
      expect(window?.resetsAt).toBeGreaterThan(now);
    }
    expect(usage.readAt).toBeLessThanOrEqual(now + 1);
  });

  it("주소 쿼리 ?usage=unavailable 이면 못 받은 상태 (not_supported), ?usage=<이유> 이면 그 이유", async () => {
    window.history.replaceState({}, "", "/?usage=unavailable");
    await expect(ipc.usageRead()).resolves.toEqual({ state: "unavailable", reason: "not_supported" });
    window.history.replaceState({}, "", "/?usage=not_subscription");
    await expect(ipc.usageRead()).resolves.toEqual({ state: "unavailable", reason: "not_subscription" });
    window.history.replaceState({}, "", "/?usage=nonsense");
    await expect(ipc.usageRead()).resolves.toMatchObject({ state: "ok" });
  });

  it("주소 쿼리 ?agents=no_harness 는 빈 목록 + 상태, ?agents=broken 은 읽을 수 없는 항목과 깨진 설정", async () => {
    window.history.replaceState({}, "", "/?agents=no_harness");
    await expect(ipc.agentsList()).resolves.toEqual({ state: "no_harness", config: "none", agents: [], missingRoles: [] });
    window.history.replaceState({}, "", "/?agents=broken");
    const broken = await ipc.agentsList();
    expect(broken.state).toBe("ok");
    expect(broken.config).toBe("unreadable");
    expect(broken.agents.some((entry) => entry.state === "unreadable")).toBe(true);
    // 깨진 설정이면 작업자 역할을 모른다 (오케스트레이터만 역할이 있다)
    expect(broken.agents.filter((entry) => entry.role !== null).map((entry) => entry.role)).toEqual(["main"]);
    window.history.replaceState({}, "", "/?agents=weird");
    await expect(ipc.agentsList()).resolves.toMatchObject({ state: "ok", config: "local" });
  });

  it("reset 으로 정한 값이 쿼리보다 앞서고, 인자 없이 reset 하면 다시 쿼리를 읽는다", async () => {
    window.history.replaceState({}, "", "/?usage=timeout");
    fakeHouse.reset({ usage: "ok" });
    await expect(ipc.usageRead()).resolves.toMatchObject({ state: "ok" });
    fakeHouse.reset();
    await expect(ipc.usageRead()).resolves.toEqual({ state: "unavailable", reason: "timeout" });
  });

  it("쿼리 읽기: 모르는 값은 기본값, unavailable 은 not_supported", () => {
    expect(parseFakeHouseQuery("")).toEqual({ usage: "ok", agents: "full" });
    expect(parseFakeHouseQuery("?usage=unavailable&agents=broken")).toEqual({ usage: "not_supported", agents: "broken" });
    expect(parseFakeHouseQuery("?usage=failed")).toEqual({ usage: "failed", agents: "full" });
    expect(parseFakeHouseQuery("?usage=&agents=")).toEqual({ usage: "ok", agents: "full" });
  });
});

describe("고양이 집 ipc (출시 빌드 · Tauri 밖)", () => {
  it("가짜로 돌지 않고 internal 오류를 낸다", async () => {
    vi.stubEnv("DEV", false);
    await expect(ipc.agentsList()).rejects.toMatchObject({ kind: "internal" });
    await expect(ipc.usageRead()).rejects.toMatchObject({ kind: "internal" });
  });
});
