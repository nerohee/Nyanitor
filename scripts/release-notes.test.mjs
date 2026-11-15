// scripts/release-notes.mjs 시험 — `node --test scripts/release-notes.test.mjs`
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { notesFor, run } from "./release-notes.mjs";

const LOG = `# 바뀐 점

## 0.2.0 — 2026-11-20

- 새 고양이
- 채팅이 빨라짐

## 0.1.10

- 다른 판

## [0.1.1]

## v0.1.0

- 첫 공개
`;

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
}

describe("notesFor", () => {
  test("제목 뒤 날짜가 붙어도 그 절 본문만 (앞뒤 빈 줄 없이)", () => {
    assert.equal(notesFor(LOG, "0.2.0"), "- 새 고양이\n- 채팅이 빨라짐");
  });
  test("0.1.1 이 0.1.10 에 걸리지 않는다 · 빈 절은 null", () => {
    assert.equal(notesFor(LOG, "0.1.1"), null);
    assert.equal(notesFor(LOG, "0.1.10"), "- 다른 판");
  });
  test("v 접두 제목 · 마지막 절", () => {
    assert.equal(notesFor(LOG, "0.1.0"), "- 첫 공개");
  });
  test("없는 판은 null, 판의 점은 아무 글자가 아니다", () => {
    assert.equal(notesFor(LOG, "0.3.0"), null);
    assert.equal(notesFor("## 0x1y0\n\n- 아님\n", "0.1.0"), null);
  });
  test("CRLF 글도 LF 로", () => {
    assert.equal(notesFor(LOG.replace(/\n/g, "\r\n"), "0.2.0"), "- 새 고양이\n- 채팅이 빨라짐");
  });
  test("### 소제목은 절을 끊지 않는다", () => {
    assert.equal(notesFor("## 1.0.0\n\n### 새것\n- a\n\n## 0.9.0\n- b\n", "1.0.0"), "### 새것\n- a");
  });
});

describe("run", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  writeFileSync(join(dir, "CHANGELOG.md"), LOG);
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("있으면 0 과 본문", () => {
    const out = sink();
    const err = sink();
    assert.equal(run(["0.2.0"], dir, out, err), 0);
    assert.equal(out.text(), "- 새 고양이\n- 채팅이 빨라짐\n");
    assert.equal(err.text(), "");
  });
  test("없거나 비면 1", () => {
    assert.equal(run(["0.3.0"], dir, sink(), sink()), 1);
    assert.equal(run(["0.1.1"], dir, sink(), sink()), 1);
  });
  test("인자 문제는 2, 파일이 없으면 1", () => {
    assert.equal(run([], dir, sink(), sink()), 2);
    assert.equal(run(["0.2.0", "x"], dir, sink(), sink()), 2);
    assert.equal(run(["0.2.0"], join(dir, "없음"), sink(), sink()), 1);
  });
});
