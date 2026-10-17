#!/usr/bin/env node
/* global process, console, setTimeout, clearTimeout */
// 실제 `claude` CLI 를 stream-json 으로 띄워 시나리오를 돌리고, 가려서 녹화한다.
//
//   node scripts/cli-probe/probe.mjs list
//   node scripts/cli-probe/probe.mjs run <시나리오...|all> [--model haiku] [--out <폴더>] [--keep]
//   node scripts/cli-probe/probe.mjs compare <옛 녹화 폴더> <새 녹화 폴더>
//   node scripts/cli-probe/probe.mjs scan <녹화 폴더>
//
// 자세한 설명 · 비용 주의는 README.md.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Session,
  assertOutsideRepo,
  claudeVersion,
  cleanEnv,
  findClaude,
  killTree,
  log,
  makeScratch,
  pidAlive,
  shapeOf,
  spawnedPidList,
} from "./lib.mjs";
import { Redactor, discoverLiterals } from "./redact.mjs";
import { scenarioNames, scenarios } from "./scenarios.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FIXTURES = path.join(REPO, "src-tauri", "tests", "fixtures", "cli");
const RECORD_FORMAT = "nyanitor-cli-record/1";
const SCENARIO_TIMEOUT_MS = 6 * 60 * 1000;

// ---------------------------------------------------------------- 실행 맥락

class RunContext {
  constructor({ bin, baseEnv, strippedEnv, model, scenarioName, cliVersion, redactor, keep }) {
    this.bin = bin;
    this.baseEnv = baseEnv;
    this.strippedEnv = strippedEnv;
    this.model = model;
    this.scenarioName = scenarioName;
    this.cliVersion = cliVersion;
    this.redactor = redactor;
    this.keep = keep;
    this.binPath = bin;
    this.sessions = [];
    this.scratchDirs = [];
    this.checks = [];
    this.infos = [];
  }

  scratch(label) {
    const dir = makeScratch(`${this.scenarioName}-${label}`.slice(0, 40));
    assertOutsideRepo(dir);
    this.scratchDirs.push(dir);
    return dir;
  }

  /** 실험 폴더에서 stream-json 세션을 하나 띄운다. 모든 줄이 녹화된다. */
  newSession({ label = "", extra = [], maxTurns = 4, persist = false, stdioTool = true, cwd, env, model } = {}) {
    const dir = cwd ?? this.scratch(label || "main");
    assertOutsideRepo(dir);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      model ?? this.model,
      "--max-turns",
      String(maxTurns),
      ...(stdioTool ? ["--permission-prompt-tool", "stdio"] : []),
      ...(persist ? [] : ["--no-session-persistence"]),
      ...extra,
    ];
    const s = new Session({ bin: this.bin, args, cwd: dir, env: { ...this.baseEnv, ...(env || {}) }, label });
    s.start();
    this.sessions.push(s);
    return s;
  }

  /** `claude <args>` 를 한 번 돌려 결과를 받는다 (auth status 등). 정리한 환경으로. */
  run(args, envExtra = {}) {
    const r = spawnSync(this.bin, args, {
      env: { ...this.baseEnv, ...envExtra },
      encoding: "utf8",
      windowsHide: true,
      cwd: this.scratch("run"),
    });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  check(name, ok, detail = "") {
    this.checks.push({ name, ok: !!ok, detail: String(detail ?? "") });
    log(`${ok ? "  ok  " : " FAIL "} ${name}${detail && !ok ? `  [${detail}]` : ""}`);
  }

  info(name, value) {
    this.infos.push({ name, value: String(value ?? "") });
    log(`  info  ${name}: ${String(value ?? "").slice(0, 300)}`);
  }
}

// ---------------------------------------------------------------- 녹화 저장

function recordingFileName(scenario, label) {
  return label ? `${scenario}.${label}.jsonl` : `${scenario}.jsonl`;
}

/** 세션 하나를 가려서 줄 목록으로. 개인 정보가 남았는지 검사하고 있으면 오류. */
function toRecordedLines(ctx, s) {
  const red = ctx.redactor;
  const meta = {
    dir: "meta",
    format: RECORD_FORMAT,
    scenario: ctx.scenarioName,
    label: s.label,
    cliVersion: ctx.cliVersion,
    model: s.args[s.args.indexOf("--model") + 1],
    args: s.args,
    strippedEnv: ctx.strippedEnv,
    note: "dir: send=앱→CLI(stdin), recv=CLI→앱(stdout), stderr, exit, note(도구 메모). t=시작 뒤 ms",
  };
  const lines = [meta, ...s.records].map((r) => JSON.stringify(red.record(r)));
  const leaks = [];
  lines.forEach((line, i) => {
    for (const f of red.findLeaks(line)) leaks.push(`줄 ${i + 1}: ${f}`);
  });
  return { lines, leaks };
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n", { encoding: "utf8" });
}

// ---------------------------------------------------------------- run

async function runScenario(name, opts) {
  const sc = scenarios[name];
  const { bin, baseEnv, strippedEnv, model, cliVersion, literals, outDir, keep } = opts;
  const redactor = new Redactor(literals);
  const ctx = new RunContext({ bin, baseEnv, strippedEnv, model, scenarioName: name, cliVersion, redactor, keep });
  log(`=== ${name} — ${sc.describe}  (사용량: ${sc.cost})`);
  const started = Date.now();
  let extra = null;
  let error = null;
  let timer;
  try {
    extra = await Promise.race([
      sc.run(ctx),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`시나리오 시간 초과 (${SCENARIO_TIMEOUT_MS / 1000}초)`)), SCENARIO_TIMEOUT_MS);
      }),
    ]);
  } catch (e) {
    error = e;
    ctx.check("시나리오가 끝까지 돎", false, e.stack || e.message);
  } finally {
    clearTimeout(timer); // 안 지우면 끝난 뒤에도 프로세스가 타이머를 기다린다
    for (const s of ctx.sessions) {
      try {
        await s.shutdown();
      } catch (e) {
        log("shutdown 오류", e.message);
      }
    }
  }

  // 남은 프로세스 확인
  const alive = ctx.sessions.map((s) => s.pid).filter((pid) => pid && pidAlive(pid));
  for (const pid of alive) killTree(pid);
  ctx.check("띄운 claude 프로세스가 모두 꺼짐", alive.length === 0, alive.join(","));

  // 녹화 저장 (개인 정보가 남으면 그 파일은 쓰지 않는다)
  const written = [];
  let leakCount = 0;
  for (const s of ctx.sessions) {
    const { lines, leaks } = toRecordedLines(ctx, s);
    const file = path.join(outDir, recordingFileName(name, s.label));
    if (leaks.length) {
      leakCount += leaks.length;
      ctx.check(`개인 정보가 남지 않음: ${path.basename(file)}`, false, leaks.slice(0, 5).join(" / "));
      continue;
    }
    writeLines(file, lines);
    written.push(path.basename(file));
  }
  if (extra?.files) {
    for (const [fname, obj] of Object.entries(extra.files)) {
      const text = JSON.stringify(redactor.value(obj), null, 2) + "\n";
      const leaks = redactor.findLeaks(text.replace(/\n\s*/g, " "));
      if (leaks.length) {
        leakCount += leaks.length;
        ctx.check(`개인 정보가 남지 않음: ${fname}`, false, leaks.slice(0, 5).join(" / "));
        continue;
      }
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, fname), text, { encoding: "utf8" });
      written.push(fname);
    }
  }
  if (!leakCount) ctx.check("녹화본에 개인 정보가 남지 않음 (이 PC 의 값 기준 검사)", true);

  if (!keep) {
    for (const d of ctx.scratchDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (e) {
        log("실험 폴더 지우기 실패", e.message);
      }
    }
  }
  const failed = ctx.checks.filter((c) => !c.ok);
  return { name, ctx, written, failed, error, seconds: Math.round((Date.now() - started) / 1000), turns: countTurns(ctx) };
}

function countTurns(ctx) {
  return ctx.sessions.reduce((n, s) => n + s.recv.filter((m) => m.type === "result").length, 0);
}

async function cmdRun(args) {
  const flags = parseFlags(args);
  const names = flags._.includes("all") ? scenarioNames : flags._;
  if (!names.length) die("돌릴 시나리오 이름이 없다. `list` 로 목록을 본다. 전부는 `run all`.");
  for (const n of names) if (!scenarios[n]) die(`모르는 시나리오: ${n}`);
  const model = flags.model || "haiku";
  const outDir = path.resolve(flags.out || path.join(HERE, "out", new Date().toISOString().replace(/[:.]/g, "-")));
  if (path.resolve(outDir) === path.resolve(FIXTURES) && !flags.fixtures) die("녹화본 폴더에 바로 쓰려면 --fixtures 를 붙인다 (옛 녹화를 덮어쓴다).");
  const bin = findClaude();
  const cliVersion = claudeVersion(bin);
  const { env: baseEnv, stripped } = cleanEnv(process.env, { keepApiKey: false });
  const literals = discoverLiterals(bin, baseEnv);
  log(`claude: ${bin}`);
  log(`버전: ${cliVersion} · 모델: ${model} · 저장: ${outDir}`);
  log(`자식 환경에서 뺀 변수: ${stripped.join(", ") || "(없음)"}`);
  log("주의: 실제 Claude 구독 사용량이 쓰인다 (짧은 haiku 턴).");

  const results = [];
  for (const n of names) {
    results.push(await runScenario(n, { bin, baseEnv, strippedEnv: stripped, model, cliVersion, literals, outDir, keep: !!flags.keep }));
  }

  // 요약
  const lines = [];
  lines.push(`claude ${cliVersion} · 모델 ${model} · ${new Date().toISOString()}`);
  let totalTurns = 0;
  let failedTotal = 0;
  for (const r of results) {
    totalTurns += r.turns;
    failedTotal += r.failed.length;
    lines.push(`${r.failed.length ? "FAIL" : "ok  "} ${r.name} — 확인 ${r.ctx.checks.length - r.failed.length}/${r.ctx.checks.length}, result ${r.turns}개, ${r.seconds}초`);
    for (const c of r.failed) lines.push(`       - ${c.name}${c.detail ? `  [${c.detail.slice(0, 200)}]` : ""}`);
    for (const i of r.ctx.infos) lines.push(`       · ${i.name}: ${i.value.slice(0, 400)}`);
    lines.push(`       녹화: ${r.written.join(", ") || "(없음)"}`);
  }
  lines.push(`합계: result(턴) ${totalTurns}개 · 실패한 확인 ${failedTotal}개 · 띄운 claude 프로세스 ${spawnedPidList().length}개`);
  const red = new Redactor(literals);
  const text = red.text(lines.join("\n")) + "\n";
  console.log("\n" + text);
  if (path.resolve(outDir) !== path.resolve(FIXTURES)) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "summary.txt"), text, { encoding: "utf8" }); // 녹화본 폴더에는 녹화만 둔다
  }
  process.exitCode = failedTotal ? 1 : 0;
}

// ---------------------------------------------------------------- compare

const NOISE = new Set(["system/thinking_tokens", "rate_limit_event/"]);
const OPAQUE = new Set(["input", "updatedInput", "permission_suggestions", "updatedPermissions", "response"]);

/** 녹화 파일 하나의 "메시지 종류" 집합: 방향 + type/subtype + 필드 모양. 값 · 개수 · 순서는 보지 않는다. */
function kindsOf(file) {
  const kinds = new Set();
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    const rec = JSON.parse(raw);
    if (rec.dir !== "send" && rec.dir !== "recv") continue;
    if (!rec.msg) {
      kinds.add(`${rec.dir} (JSON 아님)`);
      continue;
    }
    const m = rec.msg;
    const tag = `${m.type}/${m.subtype || m.request?.subtype || m.response?.subtype || ""}`;
    if (NOISE.has(tag)) continue;
    // 큰 메시지(assistant · user · result · system)는 맨 위 필드만, control 메시지는 더 깊이 — 도구 input 의 내용은 보지 않는다
    const deep = m.type === "control_request" || m.type === "control_response" || m.type === "control_cancel_request";
    kinds.add(`${rec.dir} ${tag} ${shapeOf(m, { maxDepth: deep ? 4 : 1, opaque: OPAQUE })}`);
  }
  return kinds;
}

function cmdCompare(args) {
  const [a, b] = args;
  if (!a || !b) die("compare <옛 폴더> <새 폴더>");
  const filesA = fs.readdirSync(a).filter((f) => f.endsWith(".jsonl"));
  const filesB = fs.readdirSync(b).filter((f) => f.endsWith(".jsonl"));
  let diffs = 0;
  for (const f of filesA) {
    if (!filesB.includes(f)) {
      console.log(`새 녹화에 없음: ${f}`);
      diffs++;
      continue;
    }
    const ka = kindsOf(path.join(a, f));
    const kb = kindsOf(path.join(b, f));
    const onlyA = [...ka].filter((k) => !kb.has(k));
    const onlyB = [...kb].filter((k) => !ka.has(k));
    if (onlyA.length || onlyB.length) {
      diffs++;
      console.log(`다름: ${f}`);
      for (const k of onlyA) console.log(`  - (옛 녹화에만) ${k.slice(0, 260)}`);
      for (const k of onlyB) console.log(`  + (새 녹화에만) ${k.slice(0, 260)}`);
    }
  }
  for (const f of filesB) if (!filesA.includes(f)) console.log(`옛 녹화에 없음(새로 생김): ${f}`);
  console.log(diffs ? `\n다른 파일 ${diffs}개` : "\n메시지 종류 · 필드 모양이 모두 같다 (값 · 개수 · 순서는 비교하지 않음)");
  process.exitCode = diffs ? 1 : 0;
}

// ---------------------------------------------------------------- scan

function cmdScan(args) {
  const dir = args[0] || FIXTURES;
  const bin = findClaude();
  const { env } = cleanEnv(process.env);
  const red = new Redactor(discoverLiterals(bin, env));
  let bad = 0;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(jsonl|json|txt)$/.test(f)) continue;
    n++;
    fs.readFileSync(path.join(dir, f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const leak of red.findLeaks(line)) {
          bad++;
          console.log(`${f}:${i + 1}: ${leak}`);
        }
      });
  }
  console.log(bad ? `\n남은 개인 정보 ${bad}건 (${n}개 파일)` : `\n개인 정보 없음 (${n}개 파일, 이 PC 의 값 기준)`);
  process.exitCode = bad ? 1 : 0;
}

// ---------------------------------------------------------------- 공통

function parseFlags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--keep") out.keep = true;
    else if (a === "--fixtures") {
      out.fixtures = true;
      out.out = FIXTURES;
    } else if (a === "--model" || a === "--out") out[a.slice(2)] = args[++i];
    else out._.push(a);
  }
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "list") {
  for (const n of scenarioNames) console.log(`${n.padEnd(24)} ${scenarios[n].describe}  (사용량: ${scenarios[n].cost})`);
} else if (cmd === "run") {
  await cmdRun(rest);
} else if (cmd === "compare") {
  cmdCompare(rest);
} else if (cmd === "scan") {
  cmdScan(rest);
} else {
  console.log("사용법: node scripts/cli-probe/probe.mjs <list | run <시나리오...|all> | compare <옛> <새> | scan [폴더]>");
  process.exitCode = cmd ? 2 : 0;
}
