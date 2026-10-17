/* global process, console, setTimeout, clearTimeout */
// 실험 도구 공용 부분 — claude 찾기 · 환경 정리 · stream-json 세션 · 녹화.
// Node 기본 모듈만 쓴다.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- 찾기

/** `claude` 실행 파일 위치. CLAUDE_PROBE_BIN > PATH 의 where/which > ~/.local/bin */
export function findClaude() {
  if (process.env.CLAUDE_PROBE_BIN) return process.env.CLAUDE_PROBE_BIN;
  const isWin = process.platform === "win32";
  const finder = spawnSync(isWin ? "where.exe" : "which", ["claude"], { encoding: "utf8" });
  if (finder.status === 0) {
    const first = finder.stdout.split(/\r?\n/).find((l) => l.trim());
    if (first) return first.trim();
  }
  const local = path.join(os.homedir(), ".local", "bin", isWin ? "claude.exe" : "claude");
  if (fs.existsSync(local)) return local;
  throw new Error("claude 실행 파일을 찾지 못했다 (PATH · ~/.local/bin). CLAUDE_PROBE_BIN 으로 지정할 수 있다.");
}

export function claudeVersion(bin) {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", windowsHide: true });
  return (r.stdout || "").trim();
}

// ---------------------------------------------------------------- 환경 정리

// Claude Code 안에서 이 도구를 돌릴 때 부모가 넣어 둔 변수들 — 실제 앱 환경에는 없을 값.
// 이름이 이 패턴이면 자식 환경에서 뺀다. (값은 어디에도 기록하지 않는다 — MESSAGING_TOKEN 등)
const STRIP_EXACT = new Set(["CLAUDECODE", "CLAUDE_PID", "MCP_CONNECTION_NONBLOCKING", "ANTHROPIC_API_KEY"]);
const STRIP_PREFIX = ["CLAUDE_CODE_", "CLAUDE_AGENT_SDK_"];
// CLAUDE_CODE_ 로 시작해도 사용자 설정이라 두는 것
const KEEP_EXACT = new Set(["CLAUDE_CODE_GIT_BASH_PATH"]);

export function cleanEnv(base = process.env, { keepApiKey = false } = {}) {
  const env = {};
  const stripped = [];
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    const hit =
      (STRIP_EXACT.has(upper) && !(keepApiKey && upper === "ANTHROPIC_API_KEY")) ||
      (!KEEP_EXACT.has(upper) && STRIP_PREFIX.some((p) => upper.startsWith(p)));
    if (hit) stripped.push(k);
    else env[k] = v;
  }
  return { env, stripped: stripped.sort() };
}

// ---------------------------------------------------------------- 임시 폴더

/** OS 임시 폴더 아래 새 폴더 (이 저장소 밖). */
export function makeScratch(label) {
  // 이름 끝은 무작위 16진수 8자 — 녹화본 가리기가 이 모양으로 알아본다 (redact.mjs)
  const dir = path.join(os.tmpdir(), `nyanitor-probe-${label}-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync(dir);
}

export function assertOutsideRepo(dir) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rel = path.relative(repo, path.resolve(dir));
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(`실험 폴더가 저장소 안이다: ${dir}`);
  }
}

// ---------------------------------------------------------------- 프로세스

const spawnedPids = new Set();
export function spawnedPidList() {
  return [...spawnedPids];
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pid 와 그 자식들을 모두 끈다. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* 이미 없음 */
      }
    }
  }
}

/** Windows: 자손 프로세스 (이름 · pid). 메모용. */
export function listDescendants(pid) {
  if (process.platform !== "win32") return [];
  const script = `
$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name
$out = @(); $queue = @(${Number(pid)})
while ($queue.Count) { $p = $queue[0]; $queue = $queue[1..($queue.Count)]
  foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $p }) { $out += "$($c.ProcessId) $($c.Name)"; $queue += $c.ProcessId } }
$out`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
  });
  return (r.stdout || "").split(/\r?\n/).filter(Boolean);
}

// ---------------------------------------------------------------- 세션

/**
 * claude 를 stream-json 으로 띄워 주고받는다. 모든 줄을 records 에 방향 표시와 함께 쌓는다.
 *  - dir "send"   : 우리가 stdin 으로 보낸 줄 (앱 → CLI)
 *  - dir "recv"   : stdout 에서 받은 줄 (CLI → 앱)
 *  - dir "stderr" : stderr 에서 받은 줄
 *  - dir "exit"   : 프로세스 종료 { code, signal }
 *  - dir "note"   : 도구가 남긴 메모 (CLI 가 한 것 아님)
 */
export class Session {
  constructor({ bin, args, cwd, env, label = "" }) {
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.label = label;
    this.records = [];
    this.recv = []; // 받은 JSON 메시지만
    this.cursor = 0;
    this.listeners = [];
    this.waiters = [];
    this.exited = null;
    this.t0 = Date.now();
    this.outBuf = "";
    this.errBuf = "";
  }

  start() {
    this.child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, // Windows 에서 콘솔 창이 뜨지 않게
    });
    this.pid = this.child.pid;
    spawnedPids.add(this.pid);
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (d) => this._onOut(d));
    this.child.stderr.on("data", (d) => this._onErr(d));
    this.child.stdin.on("error", (e) => this.note(`stdin 오류: ${e.code || e.message}`));
    this.child.on("exit", (code, signal) => {
      this._flush();
      this.exited = { code, signal };
      this._rec("exit", { code, signal });
      this._wake();
    });
    this.child.on("error", (e) => {
      this.note(`spawn 오류: ${e.message}`);
      this.exited = { code: null, signal: null, error: e.message };
      this._wake();
    });
    return this;
  }

  _rec(dir, body) {
    this.records.push({ dir, t: Date.now() - this.t0, ...body });
  }
  note(text) {
    this._rec("note", { text });
  }

  _onOut(chunk) {
    this.outBuf += chunk;
    let i;
    while ((i = this.outBuf.indexOf("\n")) >= 0) {
      const line = this.outBuf.slice(0, i).replace(/\r$/, "");
      this.outBuf = this.outBuf.slice(i + 1);
      if (line.trim()) this._line(line);
    }
  }
  _onErr(chunk) {
    this.errBuf += chunk;
    let i;
    while ((i = this.errBuf.indexOf("\n")) >= 0) {
      const line = this.errBuf.slice(0, i).replace(/\r$/, "");
      this.errBuf = this.errBuf.slice(i + 1);
      if (line.trim()) this._rec("stderr", { raw: line });
    }
  }
  _flush() {
    if (this.outBuf.trim()) this._line(this.outBuf.trim());
    if (this.errBuf.trim()) this._rec("stderr", { raw: this.errBuf.trim() });
    this.outBuf = "";
    this.errBuf = "";
  }
  _line(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this._rec("recv", { raw: line });
      return;
    }
    this._rec("recv", { msg });
    this.recv.push(msg);
    for (const fn of this.listeners) {
      try {
        fn(msg, this);
      } catch (e) {
        this.note(`listener 오류: ${e.message}`);
      }
    }
    this._wake();
  }

  /** 받은 메시지마다 불리는 함수 (자동 응답용). */
  on(fn) {
    this.listeners.push(fn);
  }

  send(obj) {
    this._rec("send", { msg: obj });
    if (!this.child || this.child.stdin.destroyed || !this.child.stdin.writable) {
      this.note("stdin 이 닫혀 있어 보내지 못함");
      return false;
    }
    this.child.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  /** 한 줄을 있는 그대로 보낸다 (이상한 입력 시험용). */
  sendRaw(text) {
    this._rec("send", { raw: text });
    this.child.stdin.write(text + "\n");
  }

  closeStdin() {
    this.note("stdin 닫음");
    this.child.stdin.end();
  }

  _wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  /** 아직 안 본 받은 메시지 중 pred 를 만족하는 첫 번째를 기다린다. 못 받으면 null. */
  async next(pred, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.recv.length) {
        const m = this.recv[this.cursor++];
        if (!pred || pred(m)) return m;
      }
      if (this.exited) return null;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** pred 를 만족할 때까지 모든 메시지를 읽는다 (건너뛴 것 포함 반환). */
  async until(pred, timeoutMs = 60000) {
    const seen = [];
    const hit = await this.next((m) => {
      seen.push(m);
      return pred(m);
    }, timeoutMs);
    return { hit, seen };
  }

  async waitExit(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.exited && Date.now() < deadline) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.exited;
  }

  /** 정상 종료 시도 → 안 되면 강제. */
  async shutdown() {
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        /* 이미 닫힘 */
      }
      await this.waitExit(8000);
    }
    if (!this.exited || pidAlive(this.pid)) {
      this.note("정상 종료 안 됨 → 강제 종료");
      killTree(this.pid);
      await this.waitExit(5000);
    }
  }
}

// ---------------------------------------------------------------- 메시지 모양 도우미

export const isType = (type, subtype) => (m) =>
  m && m.type === type && (subtype === undefined || m.subtype === subtype);

export const isResult = isType("result");
export const isControlRequest = (subtype) => (m) =>
  m && m.type === "control_request" && (subtype === undefined || (m.request && m.request.subtype === subtype));

/** 사용자 메시지 한 줄. */
export function userMessage(text) {
  return { type: "user", message: { role: "user", content: text } };
}

export function controlRequest(requestId, request) {
  return { type: "control_request", request_id: requestId, request };
}

export function controlResponse(requestId, response) {
  return { type: "control_response", response: { subtype: "success", request_id: requestId, response } };
}

export function controlError(requestId, error) {
  return { type: "control_response", response: { subtype: "error", request_id: requestId, error } };
}

/**
 * 모양 요약 — 키 이름과 값의 종류만 (값은 뺌). 녹화본 비교용.
 *  - maxDepth 보다 깊으면 "object" / "array" 로 접는다
 *  - opaque 에 든 키(도구마다 내용이 다른 input 등)는 내용을 보지 않는다
 *  - 키가 id 꼴(toolu_ · msg_ · UUID · 모델 이름)이면 "*" 하나로 합친다
 *  - 배열은 원소 모양의 합집합
 */
export function shapeOf(v, { maxDepth = 3, opaque = new Set() } = {}, depth = 0) {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (v.length === 0) return "array"; // 빈 배열과 채워진 배열을 같은 것으로
    if (depth >= maxDepth) return "array";
    const set = [...new Set(v.map((x) => shapeOf(x, { maxDepth, opaque }, depth + 1)))].sort();
    return `[${set.join("|")}]`;
  }
  if (typeof v === "object") {
    if (depth >= maxDepth) return "object";
    const idLike = (k) => /^(toolu_|msg_|req_|claude-)|^[0-9a-f]{8}-[0-9a-f]{4}-/.test(k);
    const parts = new Map();
    for (const k of Object.keys(v).sort()) {
      const name = idLike(k) ? "*" : k;
      parts.set(name, opaque.has(k) ? "opaque" : shapeOf(v[k], { maxDepth, opaque }, depth + 1));
    }
    return `{${[...parts].map(([k, sh]) => `${k}:${sh}`).join(",")}}`;
  }
  return typeof v;
}

export function log(...args) {
  console.error("[probe]", ...args);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
