import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App (브라우저 가짜 모드)", () => {
  it("앱 이름과 버전을 보여 준다", async () => {
    render(<App />);

    expect(await screen.findByText("Nyanitor")).toBeInTheDocument();
    expect(screen.getByText("0.0.0-browser")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
