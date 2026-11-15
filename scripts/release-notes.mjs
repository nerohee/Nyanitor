// 한 판의 바뀐 점을 CHANGELOG.md 에서 꺼낸다 — 출시 CI 가 릴리스 본문 · latest.json 의 notes(앱 「바뀐 점」)로 쓴다.
//
//   node scripts/release-notes.mjs 0.2.0     # "## 0.2.0" 절의 본문을 표준 출력으로
//
// 절 제목은 `## 0.2.0`, `## v0.2.0`, `## [0.2.0]`, 뒤에 날짜 등이 붙어도 된다 (`## 0.2.0 — 2026-11-20`).
// 절이 없거나 본문이 비었으면 실패한다 — 빈 바뀐 점으로 출시하지 않게.

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** CHANGELOG 글에서 `version` 절의 본문 (앞뒤 빈 줄을 뗀 것). 없거나 비었으면 null. */
export function notesFor(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, "\n").split("\n");
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  let end = lines.findIndex((line, i) => i > start && /^##\s/.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body.length > 0 ? body : null;
}

/** 명령줄 — 0 정상 · 1 절 없음 · 비었음 · 파일 없음 · 2 인자 문제 */
export function run(argv, root, out = process.stdout, err = process.stderr) {
  if (argv.length !== 1 || !argv[0]) {
    err.write("쓰는 법: node scripts/release-notes.mjs <판>   (예: 0.2.0)\n");
    return 2;
  }
  const version = argv[0];
  let text;
  try {
    text = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  } catch (error) {
    err.write(`CHANGELOG.md 를 읽지 못했다: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const notes = notesFor(text, version);
  if (notes === null) {
    err.write(`CHANGELOG.md 에 "## ${version}" 절이 없거나 비었다 — 바뀐 점을 적은 뒤 출시한다.\n`);
    return 1;
  }
  out.write(`${notes}\n`);
  return 0;
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = run(process.argv.slice(2), root);
}
