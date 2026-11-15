// 업데이트 안내 파일(latest.json)을 만든다 — 출시 CI 의 manifest 작업이 쓴다. Node 내장만 쓴다 (의존성 없음).
//
//   node scripts/updater-manifest.mjs --version 0.2.0 --dir <파일 폴더> --notes-file <노트 글> \
//        --repo nerohee/Nyanitor --out <latest.json 경로> [--pub-date 2026-11-20T00:00:00.000Z]
//
// <파일 폴더> 에는 빌드가 만든 업데이트 파일과 sign 작업이 만든 `.sig` 가 함께 있어야 한다:
//   Windows  `*-setup.exe`            (NSIS 설치 파일 그대로)       → windows-x86_64 · windows-x86_64-nsis
//   macOS    `*_aarch64.app.tar.gz`   (.app 을 묶은 것)             → darwin-aarch64 · darwin-aarch64-app
//   macOS    `*_x64.app.tar.gz`                                      → darwin-x86_64  · darwin-x86_64-app
//   Linux    `*.AppImage`             (AppImage 그대로)             → linux-x86_64   · linux-x86_64-appimage
// 키 이름은 tauri-plugin-updater 가 `{os}-{arch}-{설치 방식}` 을 먼저, 없으면 `{os}-{arch}` 를 찾는 규칙 그대로이고,
// tauri-action 이 만들던 latest.json 과 같이 둘 다 넣는다.
//
// 어느 한 플랫폼이라도 파일이 없거나 둘 이상이거나 `.sig` 가 없거나 모양이 틀리면 실패한다 — 반쪽짜리 latest.json 으로 출시하지 않게.

import { Buffer } from "node:buffer";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// 판은 set-version.mjs 와 같은 SemVer (빌드 메타데이터 `+` 없음).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// GitHub 는 올린 파일 이름의 공백 · 특수 글자 · 앞뒤 점을 바꿔 버린다 (규칙이 문서에 다 나와 있지 않다).
// 바뀌지 않는 글자만 허용해서 url 의 이름이 실제 자산 이름과 어긋날 수 없게 한다.
const SAFE_ASSET_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*[A-Za-z0-9_-]$/;
// `.sig` 는 minisign 서명 글(`untrusted comment: …`)을 base64 로 한 줄에 담은 것이다.
const BASE64_LINE = /^[A-Za-z0-9+/]+={0,2}$/;
const SIGNATURE_PREFIX = "untrusted comment:";

export const PLATFORMS = [
  { os: "windows", arch: "x86_64", installer: "nsis", file: /-setup\.exe$/ },
  { os: "darwin", arch: "aarch64", installer: "app", file: /_aarch64\.app\.tar\.gz$/ },
  { os: "darwin", arch: "x86_64", installer: "app", file: /_x64\.app\.tar\.gz$/ },
  { os: "linux", arch: "x86_64", installer: "appimage", file: /\.AppImage$/ },
];

/** GitHub 가 이름을 바꾸지 않는 파일 이름이면 true. */
export function isSafeAssetName(name) {
  return typeof name === "string" && name.length <= 200 && SAFE_ASSET_NAME.test(name);
}

/** 초안이 공개된 뒤의 내려받기 주소. 태그 · 파일 이름은 주소 조각으로 이스케이프한다. */
export function assetUrl(repo, version, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(`v${version}`)}/${encodeURIComponent(name)}`;
}

/** `.sig` 글 → 서명 한 줄. 모양이 틀리면 던진다. */
export function parseSignature(text, label) {
  const signature = text.trim();
  if (!BASE64_LINE.test(signature)) {
    throw new Error(`${label}: 서명 글이 한 줄 base64 가 아니다`);
  }
  if (!Buffer.from(signature, "base64").toString("utf8").startsWith(SIGNATURE_PREFIX)) {
    throw new Error(`${label}: minisign 서명 글(${SIGNATURE_PREFIX} …)이 아니다`);
  }
  return signature;
}

/**
 * 폴더의 파일 · .sig 로 latest.json 내용을 만든다. 문제가 있으면 모아서 한 번에 던진다.
 * @param {{ version: string, notes: string, repo: string, dir: string, pubDate?: string }} input
 */
export function buildManifest({ version, notes, repo, dir, pubDate = new Date().toISOString() }) {
  const problems = [];
  if (!SEMVER.test(version) || version.length > 64) problems.push(`판 "${version}" 이 SemVer 가 아니다`);
  if (!REPO.test(repo)) problems.push(`저장소 "${repo}" 는 owner/name 모양이 아니다`);
  const body = notes.replace(/\r\n?/g, "\n").trim();
  if (body.length === 0) problems.push("바뀐 점 글이 비었다");
  if (Number.isNaN(Date.parse(pubDate))) problems.push(`pub_date "${pubDate}" 를 읽을 수 없다`);
  if (problems.length > 0) throw new Error(problems.join("\n"));

  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const sigNames = names.filter((name) => name.endsWith(".sig"));
  const fileNames = names.filter((name) => !name.endsWith(".sig"));

  // 짝이 없는 .sig — 어느 파일의 서명인지 모르면 올리지 않는다.
  for (const sig of sigNames) {
    if (!fileNames.includes(sig.slice(0, -".sig".length))) problems.push(`${sig}: 짝이 되는 파일이 없다`);
  }

  const platforms = {};
  for (const platform of PLATFORMS) {
    const key = `${platform.os}-${platform.arch}`;
    const matches = fileNames.filter((name) => platform.file.test(name));
    if (matches.length === 0) {
      problems.push(`${key}: 업데이트 파일(${platform.file.source})이 없다`);
      continue;
    }
    if (matches.length > 1) {
      problems.push(`${key}: 업데이트 파일이 둘 이상이다 (${matches.join(", ")})`);
      continue;
    }
    const name = matches[0];
    if (!isSafeAssetName(name)) {
      problems.push(`${key}: 파일 이름 "${name}" 에 GitHub 가 바꿀 수 있는 글자가 있다 (영문 · 숫자 · _ - . 만)`);
      continue;
    }
    if (!name.includes(`_${version}_`)) {
      problems.push(`${key}: 파일 이름 "${name}" 에 판 "_${version}_" 이 없다 — 다른 판의 파일이 섞였나`);
      continue;
    }
    if (!sigNames.includes(`${name}.sig`)) {
      problems.push(`${key}: ${name}.sig 가 없다`);
      continue;
    }
    let signature;
    try {
      signature = parseSignature(readFileSync(resolve(dir, `${name}.sig`), "utf8"), `${name}.sig`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const entry = { signature, url: assetUrl(repo, version, name) };
    platforms[key] = entry;
    platforms[`${key}-${platform.installer}`] = { ...entry };
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));

  return { version, notes: body, pub_date: pubDate, platforms };
}

/** 명령줄 — 0 정상 · 1 파일 · 서명 문제 · 2 인자 문제 */
export function run(argv, out = process.stdout, err = process.stderr) {
  const options = {};
  const known = new Set(["--version", "--dir", "--notes-file", "--repo", "--out", "--pub-date"]);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!known.has(flag) || value === undefined || value.startsWith("--") || flag in options) {
      err.write(`인자가 틀렸다: ${flag}\n`);
      err.write("쓰는 법: node scripts/updater-manifest.mjs --version <판> --dir <폴더> --notes-file <파일> --repo <owner/name> --out <파일> [--pub-date <ISO 시각>]\n");
      return 2;
    }
    options[flag] = value;
  }
  for (const required of ["--version", "--dir", "--notes-file", "--repo", "--out"]) {
    if (!options[required]) {
      err.write(`${required} 가 필요하다\n`);
      return 2;
    }
  }
  try {
    const manifest = buildManifest({
      version: options["--version"],
      notes: readFileSync(options["--notes-file"], "utf8"),
      repo: options["--repo"],
      dir: options["--dir"],
      pubDate: options["--pub-date"],
    });
    writeFileSync(options["--out"], `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    err.write(`latest.json 을 만들지 못했다:\n${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  out.write(`latest.json 을 만들었다: ${options["--out"]} (${PLATFORMS.length}개 플랫폼)\n`);
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
  process.exitCode = run(process.argv.slice(2));
}
