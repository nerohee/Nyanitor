// 판 번호를 한 번에 맞춘다.
//
//   npm run version:set -- 0.2.0          # 네 파일의 판을 0.2.0 으로
//   npm run version:set -- 0.2.0-beta.1
//   node scripts/set-version.mjs --check 0.2.0   # 바꾸지 않고 네 파일이 이 판인지만 본다 (출시 CI 가 씀)
//
// 바꾸는 곳 — 판이 적힌 줄 한 줄씩만 (다른 줄 · 줄바꿈 · 들여쓰기는 그대로):
//   package.json                `"version"`            (tauri.conf.json 은 이 파일을 따라간다)
//   package-lock.json           맨 위 `"version"` 과 `packages[""]` 의 `"version"`
//   src-tauri/Cargo.toml        `[package]` 의 `version`
//   src-tauri/Cargo.lock        `name = "nyanitor"` 패키지의 `version` (다른 패키지는 건드리지 않는다)
// 다 바꾸거나 하나도 안 바꾼다 — 한 곳이라도 줄을 못 찾거나 쓰다가 실패하면 되돌린다.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// SemVer 2.0.0 (semver.org 공식 식) 에서 빌드 메타데이터(`+...`)만 뺐다 — 태그 이름 `v<판>` 에 `+` 를 안 쓴다.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;

/** `0.2.0` · `0.2.0-beta.1` 이면 true. `v0.2.0` · 빈 값 · 앞뒤 공백 · `0.2` 는 false. */
export function isValidVersion(value) {
  return typeof value === "string" && value.length <= 64 && SEMVER.test(value);
}

// 각 패턴은 (앞)(판)(뒤) 세 묶음이고, 파일마다 정확히 한 번 맞아야 한다.
const TOP_LEVEL_VERSION = /^( {2}"version": ")([^"]*)(")/gm;
const LOCK_ROOT_VERSION =
  /("packages": \{\r?\n {4}"": \{\r?\n {6}"name": "nyanitor",\r?\n {6}"version": ")([^"]*)(")/g;
const CARGO_TOML_VERSION = /(^\[package\]\r?\n(?:(?!\[).*\r?\n)*?version = ")([^"]*)(")/gm;
const CARGO_LOCK_VERSION = /(\[\[package\]\]\r?\nname = "nyanitor"\r?\nversion = ")([^"]*)(")/g;

export const TARGETS = [
  { file: "package.json", patterns: [TOP_LEVEL_VERSION], json: true },
  { file: "package-lock.json", patterns: [TOP_LEVEL_VERSION, LOCK_ROOT_VERSION], json: true },
  { file: join("src-tauri", "Cargo.toml"), patterns: [CARGO_TOML_VERSION], json: false },
  { file: join("src-tauri", "Cargo.lock"), patterns: [CARGO_LOCK_VERSION], json: false },
];

const defaultIo = { readFileSync, writeFileSync };

function findOnce(target, text, pattern) {
  const found = [...text.matchAll(pattern)];
  if (found.length !== 1) {
    throw new Error(
      `${target.file}: 판 줄을 ${found.length === 0 ? "찾지 못했다" : `${found.length}곳에서 찾았다 (한 곳이어야 한다)`}`,
    );
  }
  return found[0];
}

/** 파일 글에서 지금 판을 읽는다 (패턴마다 하나). */
function currentVersions(target, text) {
  return target.patterns.map((pattern) => findOnce(target, text, pattern)[2]);
}

/** 판 줄만 바꾼 새 글. 줄을 못 찾으면 던진다. */
function replaced(target, text, version) {
  let next = text;
  for (const pattern of target.patterns) {
    findOnce(target, next, pattern);
    next = next.replace(pattern, (_all, head, _old, tail) => `${head}${version}${tail}`);
  }
  if (target.json) {
    // 바뀐 곳이 판 값뿐인지 — JSON 으로 읽어 판만 같게 맞춘 옛 글과 비교한다.
    const before = JSON.parse(text);
    const after = JSON.parse(next);
    before.version = version;
    if (before.packages?.[""]) before.packages[""].version = version;
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`${target.file}: 판 말고 다른 것이 바뀌어 중단했다`);
    }
  }
  return next;
}

/** 네 파일이 가진 판 (파일 → 판 목록). 줄을 못 찾으면 던진다. */
export function readVersions(root, io = defaultIo) {
  return Object.fromEntries(
    TARGETS.map((target) => [
      target.file,
      currentVersions(target, io.readFileSync(join(root, target.file), "utf8")),
    ]),
  );
}

/** 네 파일(패턴 다섯 곳)이 모두 `version` 이면 빈 목록, 아니면 어긋난 곳 설명. */
export function versionMismatches(root, version, io = defaultIo) {
  const out = [];
  for (const [file, versions] of Object.entries(readVersions(root, io))) {
    for (const found of versions) {
      if (found !== version) out.push(`${file}: ${found}`);
    }
  }
  return out;
}

/** 네 파일의 판을 `version` 으로 바꾼다. 다 바꾸거나 하나도 안 바꾼다. 바뀐 파일 목록을 돌려준다. */
export function setVersion(root, version, io = defaultIo) {
  if (!isValidVersion(version)) {
    throw new Error(
      `판 번호가 SemVer 가 아니다: ${JSON.stringify(version)} (예: 0.2.0 · 0.2.0-beta.1, 앞의 v 는 빼고)`,
    );
  }
  // 1) 읽고 전부 계산한다 — 여기서 실패하면 디스크는 그대로.
  const plan = TARGETS.map((target) => {
    const path = join(root, target.file);
    const before = io.readFileSync(path, "utf8");
    return { file: target.file, path, before, after: replaced(target, before, version) };
  });
  // 2) 쓴다 — 중간에 실패하면 이미 쓴 것을 옛 글로 되돌린다.
  const written = [];
  try {
    for (const item of plan) {
      io.writeFileSync(item.path, item.after);
      written.push(item);
    }
  } catch (error) {
    const stuck = [];
    for (const item of written) {
      try {
        io.writeFileSync(item.path, item.before);
      } catch {
        stuck.push(item.file);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}${stuck.length ? ` — 되돌리지 못한 파일: ${stuck.join(", ")} (git 으로 확인)` : " (모두 되돌렸다)"}`,
      { cause: error },
    );
  }
  return plan.map((item) => item.file);
}

const USAGE = "사용법: npm run version:set -- <판>   (예: 0.2.0 · 0.2.0-beta.1)\n        node scripts/set-version.mjs --check <판>";

/** 명령줄 진입. 끝 코드를 돌려준다 (0 성공 · 1 실패 · 2 쓰는 법 틀림). */
export function run(argv, root, out = process.stdout, err = process.stderr) {
  const check = argv[0] === "--check";
  const args = check ? argv.slice(1) : argv;
  if (args.length !== 1) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  const version = args[0];
  if (!isValidVersion(version)) {
    err.write(
      `판 번호가 SemVer 가 아니다: ${JSON.stringify(version)} (예: 0.2.0 · 0.2.0-beta.1, 앞의 v 는 빼고)\n`,
    );
    return 2;
  }
  try {
    if (check) {
      const bad = versionMismatches(root, version);
      if (bad.length > 0) {
        err.write(`판이 ${version} 과 다르다:\n${bad.map((line) => `  ${line}`).join("\n")}\n`);
        return 1;
      }
      out.write(`네 파일 모두 ${version}\n`);
      return 0;
    }
    const files = setVersion(root, version);
    out.write(`판을 ${version} 으로 바꿨다:\n${files.map((file) => `  ${file}`).join("\n")}\n`);
    return 0;
  } catch (error) {
    err.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
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
