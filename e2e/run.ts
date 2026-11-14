// `npm run e2e` — 빌드 → (시험 파일마다) 시험 폴더 준비 → tauri-driver 띄우기 → 시험 → 정리.
// 인자: 시험 파일 이름의 일부 (예: `npm run e2e -- permission`). `E2E_SKIP_BUILD=1` 이면 빌드를 건너뛴다 (고치며 돌릴 때).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { APP_EXE, EDGE_DRIVER, REPO, SPECS_DIR, TAURI_DRIVER } from "./lib/paths.ts";
import { createSandbox, removeSandbox, sandboxEnv } from "./lib/sandbox.ts";
import { diffSnapshots, realDataDirs, saveSnapshot, takeSnapshot } from "./lib/snapshot.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function step(title: string): void {
  console.log(`\n=== ${title}`);
}

function build(): void {
  step("빌드 — 개발 빌드 앱 (화면이 묶여 들어간다) · 가짜 CLI");
  const app = spawnSync("npm", ["run", "tauri", "build", "--", "--debug", "--no-bundle"], { cwd: REPO, stdio: "inherit", shell: true });
  if (app.status !== 0) throw new Error("앱 빌드 실패");
  const fake = spawnSync("cargo", ["build", "--manifest-path", path.join(REPO, "src-tauri", "Cargo.toml"), "--example", "fake_claude"], {
    cwd: REPO,
    stdio: "inherit",
    shell: true,
  });
  if (fake.status !== 0) throw new Error("가짜 CLI 빌드 실패");
}

async function freePort(start: number): Promise<number> {
  for (let port = start; port < start + 50; port += 2) {
    const free = await Promise.all([port, port + 1].map((p) => new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(p, "127.0.0.1", () => server.close(() => resolve(true)));
    })));
    if (free.every(Boolean)) return port;
  }
  throw new Error("빈 포트가 없다");
}

function killTree(child: ChildProcess | null): void {
  if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
}

async function waitForDriver(port: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.ok) return;
    } catch {
      // 아직 안 떴다
    }
    await sleep(200);
  }
  throw new Error("tauri-driver 가 뜨지 않았다");
}

/** 시험 파일 하나 — 새 시험 폴더 · 새 tauri-driver. 통과하면 true. */
async function runSpec(file: string): Promise<boolean> {
  const name = path.basename(file).replace(/\.e2e\.ts$/, "");
  step(`${name}`);
  const sandbox = createSandbox(name);
  const env = sandboxEnv(sandbox);
  saveSnapshot(path.join(sandbox.root, "real-baseline.json"), takeSnapshot()); // 시험이 앱을 띄운 뒤 실제 폴더와 견준다
  const port = await freePort(4474);
  env.E2E_DRIVER_PORT = String(port);
  let driver: ChildProcess | null = null;
  let ok: boolean;
  try {
    driver = spawn(TAURI_DRIVER, ["--port", String(port), "--native-port", String(port + 1), "--native-driver", EDGE_DRIVER], { env, stdio: "inherit" });
    fs.writeFileSync(path.join(sandbox.root, "driver.pid"), String(driver.pid)); // 시험이 이 드라이버의 자식 앱을 찾는 데 쓴다
    await waitForDriver(port);
    const wdio = path.join(REPO, "node_modules", "@wdio", "cli", "bin", "wdio.js");
    const result = spawnSync(process.execPath, [wdio, "run", path.join(REPO, "e2e", "wdio.conf.ts"), "--spec", file], { cwd: REPO, env, stdio: "inherit" });
    ok = result.status === 0;
  } finally {
    killTree(driver);
    await sleep(500);
    if (process.env.E2E_KEEP === "1") {
      console.log(`E2E_KEEP=1 — 시험 폴더를 남김: ${sandbox.root}`);
    } else {
      const removed = await removeSandbox(sandbox.root);
      console.log(removed ? `시험 폴더 지움: ${sandbox.root}` : `!! 시험 폴더를 지우지 못했다: ${sandbox.root}`);
      if (!removed) ok = false;
    }
  }
  return ok;
}

async function main(): Promise<void> {
  for (const needed of [TAURI_DRIVER, EDGE_DRIVER]) {
    if (!fs.existsSync(needed)) throw new Error(`없다: ${needed}`);
  }
  if (process.env.E2E_SKIP_BUILD !== "1") build();
  if (!fs.existsSync(APP_EXE)) throw new Error(`앱이 없다: ${APP_EXE}`);

  const filters = process.argv.slice(2);
  const specs = fs
    .readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith(".e2e.ts"))
    .filter((f) => filters.length === 0 || filters.some((q) => f.includes(q)))
    .sort()
    .map((f) => path.join(SPECS_DIR, f));
  if (specs.length === 0) throw new Error("돌릴 시험 파일이 없다");

  const before = takeSnapshot();
  const started = Date.now();
  const failed: string[] = [];
  for (const file of specs) {
    if (!(await runSpec(file))) failed.push(path.basename(file));
  }

  step("실제 데이터 폴더 확인");
  const changes = diffSnapshots(before, takeSnapshot());
  if (changes.length === 0) console.log(`그대로다 (${realDataDirs().join(" · ")})`);
  else {
    console.log("!! 실제 데이터 폴더가 바뀌었다 (고객 앱이 같이 돌았을 수도 있다):");
    for (const change of changes.slice(0, 40)) console.log(`  ${change}`);
    failed.push("real-data-changed");
  }
  console.log(`\n걸린 시간 ${Math.round((Date.now() - started) / 1000)}초 — ${failed.length === 0 ? "모두 통과" : `실패: ${failed.join(", ")}`}`);
  if (failed.length > 0) process.exitCode = 1;
}

process.on("SIGINT", () => process.exit(130));
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
