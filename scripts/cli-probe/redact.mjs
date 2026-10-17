/* global process */
// 녹화본에서 개인 정보를 가짜 값으로 바꾸고, 남았는지 검사한다.
// 가리는 것: 홈 경로 · 사용자 이름 · 호스트 이름 · 이메일 · 조직 이름/ID · 모든 UUID(세션 ID 포함) ·
//           임시 폴더 이름의 무작위 부분 · thinking 서명 · 사용량 수치 · 목록이 긴 필드(줄임)
// 모양(키 · 순서 · 형식)은 그대로 둔다.
import os from "node:os";
import { spawnSync } from "node:child_process";

export const FAKE_USER = "fake";
export const FAKE_EMAIL = "user@example.com";
export const FAKE_ORG = "Example Org";
export const FAKE_HOST = "fake-host";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const GENERIC_NAMES = new Set(["user", "users", "admin", "root", "public", "default", "claude"]);

// 목록이 길어서 개인 설정이 드러나는 필드 → 앞의 몇 개만 남긴다
const TRIM_KEYS = new Map([
  ["commands", 3],
  ["slash_commands", 5],
  ["skills", 5],
  ["agents", 3],
  ["models", 2],
  ["plugins", 2],
  ["mcp_servers", 2],
  ["available_output_styles", 5],
]);

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 이 PC 에서 가려야 할 값들. 인증 정보 파일은 읽지 않는다 — `claude auth status --json` 출력만 쓴다. */
export function discoverLiterals(bin, env) {
  const lit = {
    home: os.homedir(),
    username: safe(() => os.userInfo().username),
    hostname: os.hostname(),
    tmpdir: os.tmpdir(),
    email: null,
    orgId: null,
    orgName: null,
    extra: (process.env.CLI_PROBE_EXTRA_LITERALS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  try {
    const r = spawnSync(bin, ["auth", "status", "--json"], { env, encoding: "utf8", windowsHide: true });
    const j = JSON.parse(r.stdout);
    lit.email = j.email || null;
    lit.orgId = j.orgId || null;
    lit.orgName = j.orgName || null;
  } catch {
    /* 로그인 안 됨 등 — 있는 것만 가린다 */
  }
  return lit;
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export class Redactor {
  constructor(literals) {
    this.lit = literals;
    this.uuidMap = new Map();
    this.realUuids = new Set();
    this.literalPairs = this._buildLiteralPairs();
  }

  _buildLiteralPairs() {
    const l = this.lit;
    const pairs = [];
    const add = (real, fake) => {
      if (!real || real.length < 3) return;
      pairs.push([real, fake]);
    };
    // 홈 경로 (긴 것부터 바꾸도록 뒤에서 정렬)
    if (l.home) {
      const fakeHome = l.home.replace(l.username || "", FAKE_USER);
      add(l.home, fakeHome);
      add(l.home.replace(/\\/g, "/"), fakeHome.replace(/\\/g, "/"));
      add(l.home.replace(/[^A-Za-z0-9]/g, "-"), fakeHome.replace(/[^A-Za-z0-9]/g, "-"));
    }
    if (l.username && l.username.length >= 5 && !GENERIC_NAMES.has(l.username.toLowerCase())) {
      add(l.username, FAKE_USER);
    }
    add(l.hostname, FAKE_HOST);
    add(l.email, FAKE_EMAIL);
    add(l.orgName, FAKE_ORG);
    for (const x of l.extra) add(x, "redacted");
    return pairs.sort((a, b) => b[0].length - a[0].length);
  }

  fakeUuid(real) {
    const key = real.toLowerCase();
    if (!this.uuidMap.has(key)) {
      this.realUuids.add(key);
      const n = String(this.uuidMap.size + 1).padStart(12, "0");
      this.uuidMap.set(key, `00000000-0000-4000-8000-${n}`);
    }
    return this.uuidMap.get(key);
  }

  /** 문자열 하나. */
  text(s) {
    if (typeof s !== "string" || s === "") return s;
    // 이미 가짜 UUID 이면 그대로 (두 번 돌려도 같은 결과)
    let out = s.replace(UUID_RE, (m) => (/^00000000-0000-4000-8000-\d{12}$/.test(m) ? m : this.fakeUuid(m)));
    for (const [real, fake] of this.literalPairs) {
      out = out.replace(new RegExp(escapeRe(real), "gi"), fake);
    }
    // 이름이 다른 홈 폴더 (다른 사용자 · WSL · mac)
    out = out.replace(/(\b[A-Za-z]:[\\/]+Users[\\/]+)([^\\/"'\s:]+)/gi, (m, a, name) =>
      /^(fake|public|default)$/i.test(name) ? m : a + FAKE_USER,
    );
    out = out.replace(/(\/(?:Users|home)\/)([^/"'\s]+)/g, (m, a, name) => (name === FAKE_USER ? m : a + FAKE_USER));
    out = out.replace(/(C--Users-|-Users-|-home-)([A-Za-z0-9_.]+)(?=-AppData|-\.|-Documents|-Desktop|-nyanitor|-project)/g, (m, a, name) =>
      name === FAKE_USER ? m : a + FAKE_USER,
    );
    out = out.replace(EMAIL_RE, (m) => (/@example\.com$|^noreply@anthropic\.com$/i.test(m) ? m : FAKE_EMAIL));
    // 임시 폴더 이름 끝의 무작위 8자
    out = out.replace(/(nyanitor-probe-[A-Za-z0-9-]+?)-[0-9a-f]{8}(?![0-9A-Za-z])/g, "$1-00000000");
    out = out.replace(/cc-msg-[0-9a-f]{32}/g, "cc-msg-00000000000000000000000000000000");
    return out;
  }

  /** 값 전체를 훑으며 바꾼다. 새 객체를 돌려준다. */
  value(v, key = "") {
    if (typeof v === "string") {
      if (key === "signature" && v.length > 24) return "REDACTED-SIGNATURE";
      if (key === "subscriptionType") return "pro";
      return this.text(v);
    }
    if (Array.isArray(v)) {
      let arr = v;
      const keep = TRIM_KEYS.get(key);
      if (keep !== undefined && arr.length > keep) arr = arr.slice(0, keep);
      // 연결된 외부 서비스(MCP) 이름은 사용자 환경이라 가짜 이름 하나로
      if (key === "tools") {
        const first = arr.findIndex((t) => typeof t === "string" && t.startsWith("mcp__"));
        arr = arr.filter((t, i) => typeof t !== "string" || !t.startsWith("mcp__") || i === first).map((t) => (typeof t === "string" && t.startsWith("mcp__") ? "mcp__example__tool" : t));
      }
      return arr.map((x, i) => (key === "mcp_servers" && x && typeof x === "object" ? { ...this.value(x, key), name: `example server ${i + 1}` } : this.value(x, key)));
    }
    if (v && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        let nv = this.value(val, k);
        if (k === "utilization" && typeof val === "number") nv = 0.1;
        if (k === "pid" && typeof val === "number") nv = 4242;
        if (k === "description" && typeof nv === "string" && nv.length > 80 && key !== "" && TRIM_KEYS.has(key)) nv = nv.slice(0, 80);
        out[this.text(k)] = nv;
      }
      return out;
    }
    return v;
  }

  record(rec) {
    const out = { dir: rec.dir, t: rec.t };
    for (const [k, v] of Object.entries(rec)) {
      if (k === "dir" || k === "t") continue;
      out[k] = this.value(v, k);
    }
    return out;
  }

  /** 직렬화한 줄 하나에서 남은 개인 정보를 찾는다. 찾은 것 설명 목록. */
  findLeaks(line) {
    const found = [];
    const l = this.lit;
    const variants = (s) => {
      if (!s) return [];
      const json = JSON.stringify(s).slice(1, -1);
      return [s, json, s.replace(/\\/g, "/"), s.replace(/[^A-Za-z0-9]/g, "-")];
    };
    const lower = line.toLowerCase();
    const check = (name, value, { minLen = 3 } = {}) => {
      if (!value || value.length < minLen) return;
      for (const v of variants(value)) {
        if (v && lower.includes(v.toLowerCase())) {
          found.push(`${name}: ${name === "email" || name === "org" ? "(값)" : v}`);
          return;
        }
      }
    };
    check("home", l.home);
    check("hostname", l.hostname);
    check("email", l.email);
    check("org", l.orgName);
    check("orgId", l.orgId);
    if (l.username && l.username.length >= 5 && !GENERIC_NAMES.has(l.username.toLowerCase())) check("username", l.username);
    for (const x of l.extra) check("extra", x);
    // 이름이 'fake' 가 아닌 사용자 폴더
    for (const m of line.matchAll(/Users(?:\\\\|\\|\/)+([^\\/"\s]+)/g)) {
      if (!/^(fake|public|default)$/i.test(m[1])) found.push(`사용자 폴더: Users/${m[1]}`);
    }
    for (const m of line.matchAll(/(?:C--Users-|-Users-)([A-Za-z0-9_.]+)-AppData/g)) {
      if (m[1] !== FAKE_USER) found.push(`인코딩된 사용자 폴더: ${m[1]}`);
    }
    for (const m of line.matchAll(EMAIL_RE)) {
      if (!/@example\.com$|^noreply@anthropic\.com$/i.test(m[0])) found.push(`이메일 모양: ${m[0].replace(/^[^@]*/, "***")}`);
    }
    for (const m of line.matchAll(UUID_RE)) {
      if (!/^00000000-0000-4000-8000-\d{12}$/.test(m[0])) found.push("가리지 않은 UUID");
    }
    if (/sk-ant-(?!api03-FAKE)[A-Za-z0-9_-]{10,}/.test(line)) found.push("API 키 모양 (sk-ant-)");
    if (/eyJ[A-Za-z0-9_-]{20,}\./.test(line)) found.push("JWT 모양");
    if (/nyanitor-probe-[A-Za-z0-9-]+?-(?!00000000)[0-9a-f]{8}(?![0-9A-Za-z])/.test(line)) found.push("임시 폴더 무작위 이름");
    return found;
  }
}
