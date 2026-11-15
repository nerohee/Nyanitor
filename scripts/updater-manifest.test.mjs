// scripts/updater-manifest.mjs 시험 — `node --test scripts/updater-manifest.test.mjs`
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

import { assetUrl, buildManifest, isSafeAssetName, parseSignature, PLATFORMS, run } from "./updater-manifest.mjs";

const VERSION = "0.2.0";
const REPO = "nerohee/Nyanitor";
const PUB_DATE = "2026-11-20T00:00:00.000Z";

// 진짜 서명처럼 "untrusted comment: …" 글을 base64 한 줄로 만든 가짜 (키 없이 만든 것 — 서명 값 자체는 가짜).
function fakeSig(tag) {
  const text = `untrusted comment: signature from tauri secret key\nRUQfake${tag}\ntrusted comment: timestamp:1\tfile:${tag}\nfakeglobal${tag}\n`;
  return Buffer.from(text).toString("base64");
}

const FILES = {
  windows: `Nyanitor_${VERSION}_x64-setup.exe`,
  arm: `Nyanitor_${VERSION}_aarch64.app.tar.gz`,
  intel: `Nyanitor_${VERSION}_x64.app.tar.gz`,
  linux: `Nyanitor_${VERSION}_amd64.AppImage`,
};

const dirs = [];
function makeDir(files = FILES, { skipSig = [], skipFile = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "updater-manifest-"));
  dirs.push(dir);
  for (const [key, name] of Object.entries(files)) {
    if (!skipFile.includes(key)) writeFileSync(join(dir, name), "bytes");
    if (!skipSig.includes(key)) writeFileSync(join(dir, `${name}.sig`), `${fakeSig(key)}\n`);
  }
  // 설치 파일(서명 없는 것)이 같이 있어도 된다.
  writeFileSync(join(dir, `Nyanitor_${VERSION}_amd64.deb`), "deb");
  writeFileSync(join(dir, `Nyanitor_${VERSION}_aarch64.dmg`), "dmg");
  return dir;
}
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function build(dir, extra = {}) {
  return buildManifest({ version: VERSION, notes: "- 새 고양이\n- 채팅이 빨라짐\n", repo: REPO, dir, pubDate: PUB_DATE, ...extra });
}

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join("") };
}

describe("buildManifest", () => {
  test("네 플랫폼 · {os}-{arch} 와 {os}-{arch}-{설치 방식} 둘 다 · 서명은 .sig 글 그대로(앞뒤 공백만 뗌)", () => {
    const manifest = build(makeDir());
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.pub_date, PUB_DATE);
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "darwin-aarch64-app",
      "darwin-x86_64",
      "darwin-x86_64-app",
      "linux-x86_64",
      "linux-x86_64-appimage",
      "windows-x86_64",
      "windows-x86_64-nsis",
    ]);
    assert.deepEqual(manifest.platforms["windows-x86_64-nsis"], {
      signature: fakeSig("windows"),
      url: `https://github.com/${REPO}/releases/download/v${VERSION}/${FILES.windows}`,
    });
    assert.deepEqual(manifest.platforms["windows-x86_64"], manifest.platforms["windows-x86_64-nsis"]);
    assert.equal(manifest.platforms["darwin-aarch64"].signature, fakeSig("arm"));
    assert.equal(manifest.platforms["darwin-x86_64"].signature, fakeSig("intel"));
    assert.equal(manifest.platforms["linux-x86_64"].url.endsWith(`/${FILES.linux}`), true);
    // 서명 글에 줄바꿈이 남지 않는다.
    for (const platform of Object.values(manifest.platforms)) assert.doesNotMatch(platform.signature, /\s/);
  });

  test("노트 — 줄바꿈은 그대로 · CRLF 는 LF · 앞뒤 빈 줄은 뗀다", () => {
    const manifest = build(makeDir(), { notes: "\r\n- 하나\r\n\r\n- 둘 \"따옴표\"\r\n\r\n" });
    assert.equal(manifest.notes, '- 하나\n\n- 둘 "따옴표"');
    // JSON 으로 쓰고 다시 읽어도 같다.
    assert.equal(JSON.parse(JSON.stringify(manifest)).notes, manifest.notes);
  });

  test("빠진 플랫폼이 있으면 실패 — 어느 플랫폼인지 이름이 나온다", () => {
    assert.throws(() => build(makeDir(FILES, { skipFile: ["intel"], skipSig: ["intel"] })), /darwin-x86_64: 업데이트 파일/);
    assert.throws(() => build(makeDir(FILES, { skipFile: ["linux"], skipSig: ["linux"] })), /linux-x86_64: 업데이트 파일/);
  });

  test("파일은 있는데 .sig 가 없으면 실패", () => {
    assert.throws(() => build(makeDir(FILES, { skipSig: ["windows"] })), /windows-x86_64: .*-setup\.exe\.sig 가 없다/);
  });

  test("짝 없는 .sig 도 실패", () => {
    assert.throws(() => build(makeDir(FILES, { skipFile: ["linux"] })), /AppImage\.sig: 짝이 되는 파일이 없다/);
  });

  test("같은 플랫폼 파일이 둘 이상이면 실패", () => {
    const dir = makeDir();
    writeFileSync(join(dir, "Other_setup-setup.exe"), "x");
    assert.throws(() => build(dir), /windows-x86_64: 업데이트 파일이 둘 이상/);
  });

  test("서명 글이 틀리면 실패 — 빈 글 · 여러 줄 · base64 아님 · 서명 글이 아닌 base64", () => {
    for (const bad of ["", "   \n", "not base64!!", `${fakeSig("a")}\n${fakeSig("b")}`, Buffer.from("hello world").toString("base64")]) {
      const dir = makeDir();
      writeFileSync(join(dir, `${FILES.windows}.sig`), bad);
      assert.throws(() => build(dir), /Nyanitor_0\.2\.0_x64-setup\.exe\.sig/, JSON.stringify(bad));
    }
  });

  test("한 번에 여러 문제를 모아서 보인다", () => {
    const dir = makeDir(FILES, { skipFile: ["intel", "linux"], skipSig: ["intel", "linux"] });
    assert.throws(
      () => build(dir),
      (error) => /darwin-x86_64/.test(error.message) && /linux-x86_64/.test(error.message),
    );
  });

  test("다른 판의 파일 이름이 섞이면 실패", () => {
    const dir = makeDir({ ...FILES, windows: "Nyanitor_0.1.0_x64-setup.exe" });
    assert.throws(() => build(dir), /windows-x86_64: 파일 이름 .* "_0\.2\.0_" 이 없다/);
  });

  test("GitHub 가 바꿀 수 있는 이름(공백 · 특수 글자)이면 실패 — url 이 자산 이름과 어긋나지 않게", () => {
    for (const name of ["Nyanitor 0.2.0 x64-setup.exe", "Nyanitor_0.2.0_x64 (1)-setup.exe", "냐니터_0.2.0_x64-setup.exe", "Nyanitor_0.2.0_x64+1-setup.exe"]) {
      const dir = makeDir({ ...FILES, windows: name });
      assert.throws(() => build(dir), /windows-x86_64: 파일 이름 .* GitHub 가 바꿀 수 있는 글자/, name);
    }
  });

  test("판 · 저장소 · 노트 · 날짜 입력도 확인", () => {
    const dir = makeDir();
    assert.throws(() => build(dir, { version: "v0.2.0" }), /SemVer/);
    assert.throws(() => build(dir, { version: "0.2" }), /SemVer/);
    assert.throws(() => build(dir, { repo: "nerohee" }), /owner\/name/);
    assert.throws(() => build(dir, { repo: "a/b c" }), /owner\/name/);
    assert.throws(() => build(dir, { notes: " \n\r\n " }), /바뀐 점 글이 비었다/);
    assert.throws(() => build(dir, { pubDate: "어제" }), /pub_date/);
  });

  test("미리 보기 판(0.2.0-beta.1)도 만든다 — 태그 v0.2.0-beta.1", () => {
    const names = Object.fromEntries(Object.entries(FILES).map(([key, name]) => [key, name.replace(VERSION, "0.2.0-beta.1")]));
    const manifest = build(makeDir(names), { version: "0.2.0-beta.1" });
    assert.equal(manifest.platforms["linux-x86_64"].url, `https://github.com/${REPO}/releases/download/v0.2.0-beta.1/${names.linux}`);
  });
});

describe("assetUrl · isSafeAssetName", () => {
  test("태그 · 파일 이름은 주소 조각으로 이스케이프한다", () => {
    assert.equal(assetUrl("o/r", "1.0.0", "a b#c%.exe"), "https://github.com/o/r/releases/download/v1.0.0/a%20b%23c%25.exe");
    assert.equal(assetUrl("o/r", "1.0.0-rc.1", "x_1.0.0-rc.1_x64-setup.exe"), "https://github.com/o/r/releases/download/v1.0.0-rc.1/x_1.0.0-rc.1_x64-setup.exe");
  });
  test("안전한 이름만 통과 — 앞뒤 점 · 슬래시 · 공백 · 빈 이름은 아니다", () => {
    assert.equal(isSafeAssetName("Nyanitor_0.2.0_x64-setup.exe"), true);
    for (const bad of ["", ".hidden.exe", "trailing.", "a/b.exe", "a b.exe", "a\\b.exe", "..", "한글.exe", "x".repeat(201)]) {
      assert.equal(isSafeAssetName(bad), false, bad);
    }
  });
});

describe("parseSignature", () => {
  test("앞뒤 공백 · 줄바꿈은 뗀다", () => {
    assert.equal(parseSignature(`\n${fakeSig("x")}\r\n`, "x.sig"), fakeSig("x"));
  });
});

describe("run (명령줄)", () => {
  const notesDir = mkdtempSync(join(tmpdir(), "updater-manifest-notes-"));
  dirs.push(notesDir);
  const notesFile = join(notesDir, "notes.md");
  writeFileSync(notesFile, "- 새 고양이\n");

  test("정상 — latest.json 을 쓰고 0", () => {
    const dir = makeDir();
    const outFile = join(notesDir, "latest.json");
    const out = sink();
    const code = run(["--version", VERSION, "--dir", dir, "--notes-file", notesFile, "--repo", REPO, "--out", outFile, "--pub-date", PUB_DATE], out, sink());
    assert.equal(code, 0);
    const written = readFileSync(outFile, "utf8");
    assert.equal(written.endsWith("}\n"), true);
    assert.equal(JSON.parse(written).platforms["darwin-aarch64-app"].url.endsWith(`/${FILES.arm}`), true);
    assert.match(out.text(), /latest\.json/);
  });

  test("빠진 플랫폼 — 1 · 파일을 만들지 않는다", () => {
    const dir = makeDir(FILES, { skipFile: ["windows"], skipSig: ["windows"] });
    const outFile = join(notesDir, "none.json");
    const err = sink();
    const code = run(["--version", VERSION, "--dir", dir, "--notes-file", notesFile, "--repo", REPO, "--out", outFile], sink(), err);
    assert.equal(code, 1);
    assert.match(err.text(), /windows-x86_64/);
    assert.throws(() => readFileSync(outFile), /ENOENT/);
  });

  test("노트 파일이 없으면 1", () => {
    const err = sink();
    const code = run(["--version", VERSION, "--dir", makeDir(), "--notes-file", join(notesDir, "없음.md"), "--repo", REPO, "--out", join(notesDir, "x.json")], sink(), err);
    assert.equal(code, 1);
    assert.match(err.text(), /latest\.json 을 만들지 못했다/);
  });

  test("인자 문제 — 모르는 옵션 · 값 없음 · 중복 · 빠진 필수는 2", () => {
    const base = ["--version", VERSION, "--dir", "d", "--notes-file", notesFile, "--repo", REPO, "--out", "o"];
    assert.equal(run([], sink(), sink()), 2);
    assert.equal(run([...base, "--bogus", "1"], sink(), sink()), 2);
    assert.equal(run([...base, "--version"], sink(), sink()), 2);
    assert.equal(run([...base, "--version", "1.0.0"], sink(), sink()), 2);
    assert.equal(run(base.slice(2), sink(), sink()), 2);
  });

  test("PLATFORMS 는 업데이터가 읽는 네 키", () => {
    assert.deepEqual(
      PLATFORMS.map((p) => `${p.os}-${p.arch}-${p.installer}`),
      ["windows-x86_64-nsis", "darwin-aarch64-app", "darwin-x86_64-app", "linux-x86_64-appimage"],
    );
  });
});

// ── release.yml 짜임새 — 키 · 쓰기 권한이 있어야 할 곳에만 있는지 (글 기준 · YAML 파서 없이) ─────────────
describe("release.yml 짜임새", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const yaml = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const jobsAt = yaml.indexOf("\njobs:\n");
  // 작업마다 글 — `  이름:` 줄(들여쓰기 두 칸)부터 다음 작업 전까지.
  const jobs = Object.fromEntries(
    [...yaml.slice(jobsAt).matchAll(/^ {2}([a-z]+):\n([\s\S]*?)(?=^ {2}[a-z]+:\n|(?![\s\S]))/gm)].map((m) => [m[1], m[2]]),
  );

  test("작업은 verify · build · sign · manifest · publish", () => {
    assert.deepEqual(Object.keys(jobs), ["verify", "build", "sign", "manifest", "publish"]);
  });

  test("서명 Secrets 는 sign 작업에만 (두 개 모두)", () => {
    assert.equal(yaml.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\b/g).length, 2);
    assert.equal(jobs.sign.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\b/g).length, 2);
    // 그 외 어떤 Secrets 도 sign · publish 의 GITHUB_TOKEN 하나뿐
    assert.deepEqual([...yaml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]).sort(), ["GITHUB_TOKEN", "TAURI_SIGNING_PRIVATE_KEY", "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"]);
    assert.match(jobs.publish, /secrets\.GITHUB_TOKEN/);
  });

  test("contents: write 는 publish 작업에만, 나머지는 읽기", () => {
    assert.equal(yaml.match(/contents: write/g).length, 1);
    assert.match(jobs.publish, /contents: write/);
    for (const name of ["build", "sign", "manifest"]) assert.match(jobs[name], /contents: read/, name);
  });

  test("의존성을 부르는 일(npm ci · npm run · cargo)은 build 작업에서만", () => {
    for (const name of ["verify", "sign", "manifest", "publish"]) {
      assert.doesNotMatch(jobs[name], /npm (ci|install|run)|cargo |tauri-action/, name);
    }
    assert.match(jobs.build, /npm ci --ignore-scripts/);
    assert.doesNotMatch(jobs.build, /npm ci(?! --ignore-scripts)/);
  });

  test("sign · publish 는 저장소를 받지 않는다 · build 에는 서명 끔(updater 키 없음)", () => {
    assert.doesNotMatch(jobs.sign, /actions\/checkout/);
    assert.doesNotMatch(jobs.publish, /actions\/checkout/);
    assert.doesNotMatch(jobs.build, /TAURI_SIGNING|GITHUB_TOKEN/);
  });

  test("서명 CLI 판은 package-lock.json 의 @tauri-apps/cli 판과 같다", () => {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const locked = lock.packages["node_modules/@tauri-apps/cli"].version;
    assert.ok(jobs.sign.includes(`TAURI_CLI_VERSION: ${locked}\n`), `release.yml 의 TAURI_CLI_VERSION 이 package-lock 의 ${locked} 이 아니다`);
  });

  test("태그 이름은 env 로만 — run 글에 ${{ }} 로 끼우지 않는다", () => {
    for (const m of yaml.matchAll(/^.*github\.ref_name.*$/gm)) {
      assert.match(m[0], /^\s+(TAG: |group: ).*$/, m[0]);
    }
    const runBlocks = [...yaml.matchAll(/^ +run: \|\n((?: {10,}.*\n|\n)+)/gm)].map((m) => m[1]);
    assert.ok(runBlocks.length >= 8);
    for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/);
  });

  test("서드파티 액션은 전부 SHA 로 고정", () => {
    const uses = [...yaml.matchAll(/^\s+- uses: (\S+)/gm)].map((m) => m[1]);
    assert.ok(uses.length >= 8);
    for (const use of uses) assert.match(use, /@[0-9a-f]{40}$/, use);
  });
});
