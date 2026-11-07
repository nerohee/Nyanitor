// 문서 목록 묶기 — 폴더별, 폴더 · 문서 모두 이름 순 (숫자는 크기 순), docs 바로 아래가 맨 위.
import { describe, expect, it } from "vitest";
import { groupDocs } from "./group";

const file = (path: string) => ({ path, size: 1, modified: null });

describe("groupDocs", () => {
  it("바로 아래 문서가 맨 위, 폴더는 이름 순, 문서도 이름 순", () => {
    const groups = groupDocs([
      file("02-development/briefs/P7-01-a.md"),
      file("README.md"),
      file("01-planning/decisions.md"),
      file("01-planning/design/tokens.md"),
      file("02-development/dev-plan.md"),
      file("01-planning/brief.md"),
      file("00.md"),
    ]);
    expect(groups.map((group) => group.dir)).toEqual(["", "01-planning", "01-planning/design", "02-development", "02-development/briefs"]);
    expect(groups[0]?.files.map((item) => item.name)).toEqual(["00.md", "README.md"]);
    expect(groups[1]?.files.map((item) => item.name)).toEqual(["brief.md", "decisions.md"]);
    expect(groups[4]?.files[0]).toMatchObject({ name: "P7-01-a.md", path: "02-development/briefs/P7-01-a.md" });
  });

  it("숫자는 크기 순 (P2 가 P10 앞), 한글 이름도 문제없다", () => {
    const groups = groupDocs([file("n/P10.md"), file("n/P2.md"), file("n/한글 메모.md"), file("n/가나다.md")]);
    const names = groups[0]?.files.map((item) => item.name) ?? [];
    expect(names).toHaveLength(4);
    expect(names.indexOf("P2.md")).toBeLessThan(names.indexOf("P10.md"));
    expect(names.indexOf("가나다.md")).toBeLessThan(names.indexOf("한글 메모.md"));
  });

  it("목록이 비면 묶음도 없다", () => {
    expect(groupDocs([])).toEqual([]);
  });
});
