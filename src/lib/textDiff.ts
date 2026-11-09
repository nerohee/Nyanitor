// 글 두 덩이의 줄 단위 차이 — 「내 수정」 화면의 "내 것과 원본 다른 점" 과 브라우저 가짜 내 수정(`fakeCustom.ts`)이 같이 쓴다.
// 진짜 "적용하면 바뀌는 것" · 커밋 차이는 Rust 가 git 으로 만들어 주고, 이 계산은 화면이 두 글을 직접 비교할 때만 쓴다.
import type { CustomDiffLine } from "./ipc-types";

/** 줄로 나눈다 — BOM 을 떼고, CRLF 는 LF 로 보고, 끝의 빈 줄 하나는 줄로 세지 않는다 */
export function splitLines(text: string): string[] {
  const out = text
    .replace(/^\u{FEFF}/u, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

export interface TextDiff {
  lines: CustomDiffLine[];
  added: number;
  removed: number;
}

/** 줄 수 곱이 이보다 크면 `diffTooLarge` — 비교표(가장 긴 공통 부분열)가 메모리를 너무 쓴다 */
export const DIFF_CELLS_MAX = 4_000_000;

/** 두 글이 너무 커서 `diffLines` 로 비교하지 않는 편이 낫다 */
export function diffTooLarge(oldText: string | null, newText: string | null): boolean {
  return (oldText === null ? 0 : splitLines(oldText).length) * (newText === null ? 0 : splitLines(newText).length) > DIFF_CELLS_MAX;
}

/** 옛 글 → 새 글의 줄 차이. 첫 줄은 `@` 위치 표시 하나 */
export function diffLines(oldText: string | null, newTextValue: string | null): TextDiff {
  const a = oldText === null ? [] : splitLines(oldText);
  const b = newTextValue === null ? [] : splitLines(newTextValue);
  // 가장 긴 공통 부분열
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: CustomDiffLine[] = [{ sign: "@", text: `@@ -${a.length === 0 ? 0 : 1},${a.length} +${b.length === 0 ? 0 : 1},${b.length} @@` }];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ sign: " ", text: a[i]!, old: i + 1, new: j + 1 });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // 바뀐 자리는 git 처럼 지운 줄(−)을 먼저
      out.push({ sign: "-", text: a[i]!, old: i + 1 });
      removed += 1;
      i += 1;
    } else {
      out.push({ sign: "+", text: b[j]!, new: j + 1 });
      added += 1;
      j += 1;
    }
  }
  return { lines: out, added, removed };
}

/**
 * 바뀐 곳 둘레 `context` 줄만 남기고 나머지 같은 줄은 접는다 — 긴 글의 차이를 한눈에. 접은 자리는 `@` 줄 하나(`fold(n)` 이 글을 만든다).
 * 맨 앞 `@@` 줄은 그대로 둔다. 바뀐 줄이 없으면 `diff` 를 그대로 돌려준다.
 */
export function foldSameLines(diff: readonly CustomDiffLine[], context: number, fold: (hidden: number) => string): CustomDiffLine[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((line, index) => {
    if (line.sign === "@") keep[index] = true;
    if (line.sign !== "+" && line.sign !== "-") return;
    for (let k = Math.max(0, index - context); k <= Math.min(diff.length - 1, index + context); k += 1) keep[k] = true;
  });
  if (!diff.some((line) => line.sign === "+" || line.sign === "-")) return [...diff];
  const out: CustomDiffLine[] = [];
  let hidden = 0;
  diff.forEach((line, index) => {
    if (keep[index]) {
      if (hidden > 0) out.push({ sign: "@", text: fold(hidden) });
      hidden = 0;
      out.push(line);
    } else hidden += 1;
  });
  if (hidden > 0) out.push({ sign: "@", text: fold(hidden) });
  return out;
}
