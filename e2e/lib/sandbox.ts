// 시험 폴더 — 앱의 모든 쓰기 위치 · 하네스 폴더 · 가짜 CLI 를 한 곳에 모은다. 시험마다 새로 만들고 끝나면 지운다 (저장소 밖 `%TEMP%\nyanitor-e2e-*`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_FIXTURES, FAKE_CLAUDE_EXE } from "./paths.ts";
import { writeScenarios } from "./scenarios.ts";

export interface Sandbox {
  /** 시험 폴더 뿌리 = `NYANITOR_E2E_DIR` (앱이 `data` · `local` · `logs` 를 만든다) */
  root: string;
  /** 앱 데이터 폴더 (`<root>/data`) — DB 가 있다 */
  data: string;
  logs: string;
  /** 프로젝트 폴더를 둘 곳 */
  projects: string;
  /** 가짜 CLI 가 어떤 녹화를 재생할지 적는 파일 — 시험이 바꾼다 (`claude.cmd` 가 세션을 띄울 때 읽는다) */
  replayFile: string;
  claudeConfig: string;
  harnessHome: string;
}

/** 이 이름이 환경에 있으면 CLI 가 구독이 아닌 곳으로 과금한다 — 시험 앱에는 넘기지 않는다 (진짜 토큰 방지). */
const BILLING_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
];

/**
 * 가짜 `claude.cmd` — 가짜 CLI 하나로 두 가지 세션을 가른다.
 * `/usage` 읽기(권한 질문 도구 인자 없음)는 `usage` 녹화, 작업 세션은 `replay.txt` 의 녹화.
 * 변수는 이 프로세스 안에서만 바뀐다 (`setlocal`).
 */
function claudeCmd(): string {
  return [
    "@echo off",
    "setlocal",
    'if "%~1"=="--version" goto run',
    'if "%~1"=="auth" goto run',
    "echo %* | findstr /C:\"--permission-prompt-tool\" >nul",
    "if errorlevel 1 (",
    "  set NYANITOR_FAKE_REPLAY=usage",
    ") else (",
    '  set /p NYANITOR_FAKE_REPLAY=<"%NYANITOR_E2E_DIR%\\replay.txt"',
    ")",
    ":run",
    '"%~dp0fake_claude.exe" %*',
    "exit /b %errorlevel%",
    "",
  ].join("\r\n");
}

export function createSandbox(name: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `nyanitor-e2e-${name}-`));
  const tools = path.join(root, "tools");
  const fixtures = path.join(root, "fixtures");
  for (const dir of [tools, fixtures, path.join(root, "projects"), path.join(root, "claude-config"), path.join(root, "harness-home")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(FAKE_CLAUDE_EXE)) throw new Error(`가짜 CLI 가 없다: ${FAKE_CLAUDE_EXE} — cargo build --example fake_claude`);
  fs.copyFileSync(FAKE_CLAUDE_EXE, path.join(tools, "fake_claude.exe"));
  fs.writeFileSync(path.join(tools, "claude.cmd"), claudeCmd());
  for (const file of ["usage.jsonl", "start.jsonl"]) fs.copyFileSync(path.join(CLI_FIXTURES, file), path.join(fixtures, file));
  writeScenarios(fixtures);
  fs.writeFileSync(path.join(root, "replay.txt"), "start");
  return {
    root,
    data: path.join(root, "data"),
    logs: path.join(root, "logs"),
    projects: path.join(root, "projects"),
    replayFile: path.join(root, "replay.txt"),
    claudeConfig: path.join(root, "claude-config"),
    harnessHome: path.join(root, "harness-home"),
  };
}

/** 앱 (tauri-driver 의 자식) 이 물려받을 환경 */
export function sandboxEnv(sandbox: Sandbox, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (BILLING_NAMES.includes(name.toUpperCase())) continue;
    env[name] = value;
  }
  const pathKey = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  env[pathKey] = `${path.join(sandbox.root, "tools")}${path.delimiter}${env[pathKey] ?? ""}`;
  env.NYANITOR_E2E_DIR = sandbox.root;
  env.CLAUDE_CONFIG_DIR = sandbox.claudeConfig;
  env.CLAUDE_HARNESS_HOME = sandbox.harnessHome;
  env.NYANITOR_FAKE_FIXTURES = path.join(sandbox.root, "fixtures");
  env.NYANITOR_FAKE_LOG = path.join(sandbox.root, "fake-claude.log");
  env.E2E_SANDBOX = sandbox.root;
  return env;
}

/** 폴더를 지운다 — 끝난 프로세스가 아직 파일을 쥐고 있을 수 있어 잠깐 기다리며 다시 한다. 지웠으면 true. */
export async function removeSandbox(root: string): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 잠겨 있다 — 다시
    }
    if (!fs.existsSync(root)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** 시험 쪽 (워커) 에서 환경 변수로 받은 시험 폴더 */
export function sandboxFromEnv(): Sandbox {
  const root = process.env.E2E_SANDBOX;
  if (!root) throw new Error("E2E_SANDBOX 가 없다 — `npm run e2e` 로 돌린다");
  return {
    root,
    data: path.join(root, "data"),
    logs: path.join(root, "logs"),
    projects: path.join(root, "projects"),
    replayFile: path.join(root, "replay.txt"),
    claudeConfig: path.join(root, "claude-config"),
    harnessHome: path.join(root, "harness-home"),
  };
}
