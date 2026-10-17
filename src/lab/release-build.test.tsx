// 시험 화면은 출시 빌드(`import.meta.env.DEV === false`)에서 링크도 화면도 보이지 않아야 한다 (P3-03).
import { render, screen } from "@testing-library/react";
import { t } from "../i18n/ko";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  window.history.pushState({}, "", "/");
});

async function renderApp(dev: boolean, search: string) {
  vi.stubEnv("DEV", dev);
  window.history.pushState({}, "", `/${search}`);
  // 모듈을 새로 불러와야 `App.tsx` 맨 위의 `import.meta.env.DEV ? lazy(...) : null` 이 다시 계산된다.
  const { default: App } = await import("../App");
  return render(<App />);
}

describe("시험 화면의 출시 빌드 숨김", () => {
  it("출시 빌드에서는 ?lab=session 이어도 시험 화면 대신 기본 화면이고, 시험 화면 링크도 없다", async () => {
    await renderApp(false, "?lab=session");
    expect(await screen.findByText(t("app.placeholder"))).toBeInTheDocument();
    // Tauri 밖의 출시 빌드는 가짜 앱 정보로 돌지 않고 오류를 보인다
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Nyanitor")).toBeNull();
    expect(screen.queryByRole("link", { name: /시험 화면/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Claude/ })).toBeNull();
    expect(document.querySelector("a[href*='lab=']")).toBeNull();
  });

  it("출시 빌드에서는 쿼리가 다르거나 대소문자가 달라도 시험 화면이 안 열린다", async () => {
    for (const search of ["?lab=Session", "?lab=", "?lab=session%00", "?LAB=session", "?x=1&lab=other"]) {
      const { unmount } = await renderApp(false, search);
      expect(await screen.findByText(t("app.placeholder")), search).toBeInTheDocument();
      unmount();
      vi.resetModules();
    }
  });

  it("개발 빌드에서는 같은 주소에서 시험 화면 링크가 기본 화면에 있다 (대조)", async () => {
    await renderApp(true, "");
    expect(await screen.findByRole("link", { name: /시험 화면/ })).toHaveAttribute("href", "?lab=session");
  });

  it("개발 빌드에서는 ?lab=session 이 시험 화면을 연다 (위 '안 보임' 확인이 헛돌지 않는다는 대조)", async () => {
    await renderApp(true, "?lab=session");
    expect(await screen.findByText(/Claude 연결 시험 화면/)).toBeInTheDocument();
  });
});
