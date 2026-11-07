// 미리보기의 GFM — 표 · 체크 목록 · 지운 글 · 맨 주소 (P7, 2026-11-07 고객: 하네스 문서는 표가 많다).
// 안전 규칙(HTML · 이미지 · 링크)은 `RequirementsEditor.test.tsx` 가 지키고, 여기서는 GFM 이 그 규칙을 깨지 않는지도 본다.
import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

const TABLE = [
  "| 단계 | 내용 | 상태 |",
  "|---|---|---|",
  "| P6 | 작업 공간 | 완료 |",
  "| P7 | 진행 보기 | 진행 중 |",
].join("\n");

describe("GFM 미리보기", () => {
  it("표를 표로 그리고, 가로로 밀 수 있는 칸(키보드 포커스 · 이름)으로 감싼다", () => {
    const { container } = render(<MarkdownPreview text={TABLE} />);
    const region = within(container).getByRole("region", { name: "표" });
    expect(region).toHaveAttribute("tabindex", "0");
    const table = within(region).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["단계", "내용", "상태"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText("진행 중")).toBeInTheDocument();
  });

  it("체크 목록은 고칠 수 없는 체크 칸으로 보인다", () => {
    const { container } = render(<MarkdownPreview text={"- [x] 끝난 일\n- [ ] 남은 일"} />);
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[1].checked).toBe(false);
    for (const box of boxes) expect(box.disabled).toBe(true);
  });

  it("지운 글은 del 로", () => {
    const { container } = render(<MarkdownPreview text={"~~옛 안~~ 새 안"} />);
    expect(container.querySelector("del")?.textContent).toBe("옛 안");
  });

  it("맨 주소 · 표 칸 안의 링크 · HTML 도 링크 · 태그를 만들지 않는다", () => {
    const text = ["https://evil.example/login 을 보세요", "", "| 칸 |", "|---|", "| [링크](javascript:alert(1)) <script>x()</script> |"].join("\n");
    const { container } = render(<MarkdownPreview text={text} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(within(container).getByText("https://evil.example/login")).toHaveAttribute("title", "https://evil.example/login");
    expect(container.textContent).toContain("<script>x()</script>");
  });
});
