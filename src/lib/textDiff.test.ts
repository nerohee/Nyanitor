// 줄 차이 공용 모듈 (P9-02) — 「내 수정」 화면과 가짜 내 수정이 같이 쓴다. 꺼내기 전 동작 그대로인지 + 접기.
import { describe, expect, it } from "vitest";
import { diffLines, diffTooLarge, foldSameLines, splitLines } from "./textDiff";

describe("splitLines", () => {
  it("BOM 을 떼고 CRLF 를 LF 로 보고 끝의 빈 줄 하나는 세지 않는다", () => {
    expect(splitLines("﻿a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\n")).toEqual(["a", ""]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("diffLines", () => {
  it("같은 글은 바뀐 줄이 없다", () => {
    const { lines, added, removed } = diffLines("a\nb\n", "a\nb\n");
    expect(added).toBe(0);
    expect(removed).toBe(0);
    expect(lines.map((l) => l.sign)).toEqual(["@", " ", " "]);
  });

  it("바뀐 줄은 옛 줄 − 먼저, 새 줄 + 다음 (git 과 같게), 줄 번호가 옛 판 · 새 판대로 붙는다", () => {
    const { lines, added, removed } = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(added).toBe(2);
    expect(removed).toBe(1);
    expect(lines).toEqual([
      { sign: "@", text: "@@ -1,3 +1,4 @@" },
      { sign: " ", text: "a", old: 1, new: 1 },
      { sign: "-", text: "b", old: 2 },
      { sign: "+", text: "B", new: 2 },
      { sign: " ", text: "c", old: 3, new: 3 },
      { sign: "+", text: "d", new: 4 },
    ]);
  });

  it("null 은 빈 글 — 새 파일은 모두 +, 지운 파일은 모두 −", () => {
    expect(diffLines(null, "x\ny\n")).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines("x\ny\n", null)).toMatchObject({ added: 0, removed: 2 });
  });

  it("CRLF 와 LF 는 같은 글로 본다", () => {
    expect(diffLines("a\r\nb\r\n", "a\nb\n")).toMatchObject({ added: 0, removed: 0 });
  });
});

describe("diffTooLarge", () => {
  it("줄 수 곱이 상한을 넘으면 true", () => {
    const big = "x\n".repeat(3000);
    expect(diffTooLarge(big, big)).toBe(true);
    expect(diffTooLarge("a\n", "b\n")).toBe(false);
    expect(diffTooLarge(null, big)).toBe(false);
  });
});

describe("foldSameLines", () => {
  const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

  it("바뀐 곳 둘레만 남기고 나머지 같은 줄은 접는다", () => {
    const before = numbered(30);
    const after = before.replace("line15", "LINE15");
    const { lines } = diffLines(before, after);
    const folded = foldSameLines(lines, 2, (n) => `…${n}줄`);
    expect(folded.map((l) => l.text)).toEqual(["@@ -1,30 +1,30 @@", "…12줄", "line13", "line14", "line15", "LINE15", "line16", "line17", "…13줄"]);
  });

  it("바뀐 줄이 없으면 그대로", () => {
    const { lines } = diffLines("a\nb\n", "a\nb\n");
    expect(foldSameLines(lines, 1, () => "…")).toEqual(lines);
  });
});
