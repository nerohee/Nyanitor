// 가짜 CLI 녹화 — 저장소의 시험 자료 (`src-tauri/tests/fixtures/cli`) 를 바탕으로 E2E 에 필요한 모양을 만든다.
// 하나의 앱 실행에서 가짜 CLI 는 `replay.txt` 에 적힌 녹화 하나만 재생한다 (시험이 이름을 바꿔 쓴다).
import fs from "node:fs";
import path from "node:path";
import { CLI_FIXTURES } from "./paths.ts";

type Line = Record<string, unknown>;

function readLines(name: string): Line[] {
  return fs
    .readFileSync(path.join(CLI_FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Line);
}

function write(dir: string, name: string, lines: Line[]): void {
  fs.writeFileSync(path.join(dir, `${name}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

const msgOf = (line: Line): Record<string, unknown> => (line.msg ?? {}) as Record<string, unknown>;

/** `Write` 도구 권한 요청이 동시에 둘 (같은 차례에 쌓인다) — 권한 카드 둘을 차례로 눌러 보는 시험 */
function twoPermissions(): Line[] {
  const base = readLines("permission-allow");
  const toolUse = base.findIndex((line) => msgOf(line).type === "assistant" && JSON.stringify(line).includes('"tool_use"'));
  const request = base.findIndex((line) => msgOf(line).type === "control_request");
  const response = base.findIndex((line) => line.dir === "send" && msgOf(line).type === "control_response");
  if (toolUse < 0 || request < 0 || response < 0) throw new Error("permission-allow 녹화의 모양이 바뀌었다");

  const second = (line: Line): Line =>
    JSON.parse(
      JSON.stringify(line)
        .replaceAll("00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000044")
        .replaceAll("toolu_01ABcynzinmfcuGgrgP3C59U", "toolu_01SECONDcynzinmfcuGgrgP3C")
        .replaceAll("hello.txt", "hello2.txt"),
    ) as Line;

  return [
    ...base.slice(0, response),
    second(base[toolUse]),
    second(base[request]),
    base[response],
    second(base[response]),
    ...base.slice(response + 1),
  ];
}

/** 권한 요청 하나 — 허용하면 "done" 으로 끝나는 `permission-allow` 그대로 (이름만 e2e 쪽에서 쓰려고 복사) */
export function writeScenarios(fixturesDir: string): void {
  write(fixturesDir, "e2e-permission-two", twoPermissions());
  write(fixturesDir, "e2e-permission-one", readLines("permission-allow"));
}
