import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App (브라우저 가짜 모드)", () => {
  it("첫 화면은 고양이 집이다 — 에이전트 7마리가 고양이로 있고 사용량이 보인다", async () => {
    render(<App />);

    expect(await screen.findByTestId("home")).toBeInTheDocument();
    const scene = screen.getByRole("region", { name: "고양이들" });
    await screen.findByRole("meter", { name: "5시간 츄르" });
    expect(await within(scene).findAllByRole("button")).toHaveLength(7);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
