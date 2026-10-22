// 브라우저(`npm run dev`)에서 하네스 시험 화면이 돌도록 하는 가짜 하네스. Tauri 밖에서만 `fakeClaude.ts` 의 `fakeCall` 이 쓴다 (개발 빌드 전용).
// 진짜(`src-tauri/src/harness/`)와 같은 명령 · 결과 모양을 흉내 내고, 실제 폴더 · git · 설치 스크립트는 어디에도 건드리지 않는다.
// 흐름: 받기 → 업데이트 확인(받을 커밋 2개) → 받기 → 설치 미리보기 → 설치 → 다시 미리보기 = 같음 → 백업 → 되돌리기.
// 한 번에 하나(`harness_busy`)와 백업 번호 확인(`invalid_input`)도 진짜처럼 한다.
// 진짜처럼 본 것만 한다: 받기는 확인 뒤에만(`refused` · `check_first`), 설치 · 되돌리기는 미리보기 뒤에만(`refused` · `plan_first`) — 쓰는 일 뒤에는 기억을 지운다.
import { AppError, type GitResult, type HarnessBackupInfo, type HarnessChange, type HarnessReport, type HarnessStatus, type ScriptResult } from "./ipc-types";

type Handler = (args: Record<string, unknown>) => unknown;

/** 진짜 `backups::parse_backup_id` 와 같은 모양: `YYYY-MM-DD_HHMMSS` + 선택 `-2` 이상 */
const BACKUP_ID = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])_([01]\d|2[0-3])[0-5]\d[0-5]\d(-[2-9]|-[1-9]\d{1,5})?$/;
export const FAKE_KEEP_BACKUPS = 12;
const FAKE_CLAUDE_DIR = "C:\\fake-sandbox\\.claude";
const FAKE_HOME = "C:\\fake-sandbox\\.claude-harness";
const FAKE_DEV_ORIGIN = "C:\\fake-sandbox\\my-clone\\claude-harness";

export interface FakeHarnessOptions {
  /** 개발자 모드 — 다른 원본을 쓰는 중 (받기 · 업데이트 불가) */
  developer: boolean;
  /** 스크립트 출력이 깨진 것처럼 */
  unreadable: boolean;
  /** git 이 없는 PC 처럼 */
  gitMissing: boolean;
  /** Git Bash 가 없는 PC 처럼 */
  gitBashMissing: boolean;
  /** 이미 있는 백업 개수 (정리 시험용) */
  startBackups: number;
  /** 원본이 네트워크 공유에 있는 것처럼 (개발자 모드) */
  networkSource: boolean;
}

const DEFAULTS: FakeHarnessOptions = { developer: false, unreadable: false, gitMissing: false, gitBashMissing: false, startBackups: 0, networkSource: false };

/** 가짜 확인이 본 원격 커밋의 전체 해시 */
const FAKE_UPSTREAM_HASH = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b";

function emptyReport(command: string, dryRun: boolean): HarnessReport {
  return {
    contract: 1,
    command,
    ok: true,
    exitCode: 0,
    dryRun,
    claudeDir: FAKE_CLAUDE_DIR,
    harnessHome: FAKE_HOME,
    repo: `${FAKE_HOME}\\repo`,
    mode: command === "backups" ? null : "copy",
    developerMode: false,
    existingSource: null,
    restartNeeded: false,
    custom: { dir: `${FAKE_HOME}\\custom`, items: [] },
    changes: [],
    counts: { add: 0, change: 0, remove: 0, skip: 0, same: 0 },
    same: true,
    originChanged: [],
    problems: [],
    warnings: [],
    backup: null,
    backups: [],
    originHash: null,
    rolledBack: null,
    error: null,
  };
}

function scriptResult(report: HarnessReport): ScriptResult {
  return {
    outcome: "ran",
    exitCode: report.exitCode,
    report,
    raw: JSON.stringify(report),
    unreadable: null,
    restoreAdvised: false,
    script: `${FAKE_HOME}\\repo\\install.ps1`,
    prune: null,
    detail: null,
    reason: null,
  };
}

/** 출력을 읽을 수 없는 결과 (가짜는 미리보기만 이렇게 깨진다 — 미리보기가 깨지면 설치 · 되돌리기는 거절돼 거기까지 가지 않는다) */
function unreadableResult(): ScriptResult {
  return {
    outcome: "unreadable",
    exitCode: 0,
    report: null,
    raw: null,
    unreadable: { reason: "bad_json", contract: null, head: '{"contract":1,"command":"install","ok":tr', stderrHead: "" },
    restoreAdvised: false,
    script: `${FAKE_HOME}\\repo\\install.ps1`,
    prune: null,
    detail: null,
    reason: null,
  };
}

/** 원본을 아직 안 받아서 돌릴 스크립트가 없다 */
function noScript(): ScriptResult {
  return { outcome: "no_script", exitCode: null, report: null, raw: null, unreadable: null, restoreAdvised: false, script: null, prune: null, detail: null, reason: null };
}

/** 앱이 하지 않았다 (스크립트를 돌리지 않았다) — `plan_first` · `source_changed` */
function refusedResult(reason: string): ScriptResult {
  return { outcome: "refused", exitCode: null, report: null, raw: null, unreadable: null, restoreAdvised: false, script: null, prune: null, detail: null, reason };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function createFakeHarness() {
  let options: FakeHarnessOptions = { ...DEFAULTS };
  let repoPresent = false;
  let pulled = false;
  let installed = false;
  /** 설치된 것이 원본과 다르게 바뀐 상태 (다시 설치하면 백업이 생긴다) */
  let stale = false;
  let backups: HarnessBackupInfo[] = [];
  let tick = 0;
  let busy = false;
  const log: string[] = [];
  /** 앱이 기억하는 것 (진짜 `HarnessState`): 확인이 본 것 · 미리보기를 본 원본 · 되돌리기 미리보기를 본 번호 */
  let checked = false;
  let installPlanned = false;
  let restorePlanned: string | null = null;

  const forgetPlans = () => {
    installPlanned = false;
    restorePlanned = null;
  };
  /** 쓰는 일 뒤에는 본 것이 모두 낡았다 */
  const forgetAll = () => {
    checked = false;
    forgetPlans();
  };

  const nextId = () => {
    tick += 1;
    return `2026-10-${pad(Math.min(28, 1 + Math.floor(tick / 60)))}_${pad(9 + Math.floor((tick % 3600) / 60))}${pad(tick % 60)}00`;
  };

  function seedBackups(count: number) {
    backups = [];
    for (let i = 0; i < count; i += 1) {
      backups.unshift({
        id: `2026-09-${pad(i + 1)}_090000`,
        createdAt: `2026-09-${pad(i + 1)}T09:00:00+0900`,
        command: "install",
        added: 0,
        changed: 3,
        removed: 0,
        files: 3,
        bytes: 1200 + i,
        readable: true,
      });
    }
  }

  /** 한 번에 하나 — 다른 하네스 작업이 도는 중이면 진짜처럼 `harness_busy` */
  async function exclusive<T>(work: () => T): Promise<T> {
    if (busy) throw new AppError("harness_busy", "another harness task is in progress");
    busy = true;
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return work();
    } finally {
      busy = false;
    }
  }

  const git = () => options.gitMissing ? { found: false, path: null, version: null, problem: null } : { found: true, path: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.55.0.windows.3", problem: null };

  function status(): HarnessStatus {
    const gitBash = options.gitBashMissing
      ? { required: true, found: false, path: null, source: null, problem: null }
      : { required: true, found: true, path: "C:\\Program Files\\Git\\bin\\bash.exe", source: "git" as const, problem: null };
    const sourceDir = options.developer ? FAKE_DEV_ORIGIN : `${FAKE_HOME}\\repo`;
    return {
      claudeDir: FAKE_CLAUDE_DIR,
      harnessHome: FAKE_HOME,
      claudeDirFromEnv: true,
      harnessHomeFromEnv: true,
      claudeDirIsDefault: false,
      harnessHomeIsDefault: false,
      problem: null,
      repoDir: `${FAKE_HOME}\\repo`,
      repo: { present: repoPresent, usable: repoPresent && !options.gitMissing ? true : null, problem: null, remote: repoPresent ? "https://github.com/nerohee/claude-harness" : null, head: repoPresent ? (pulled ? "b2c3d4e" : "a1b2c3d") : null },
      origin: options.developer
        ? { kind: "developer", path: FAKE_DEV_ORIGIN, marker: "copy", reason: null }
        : installed
          ? { kind: "repo", path: `${FAKE_HOME}\\repo`, marker: "copy", reason: null }
          : { kind: "none", path: null, marker: null, reason: null },
      developerMode: options.developer,
      sourceDir,
      scriptPath: options.developer || repoPresent ? `${sourceDir}\\install.ps1` : null,
      sourceIsNetwork: options.developer && options.networkSource,
      git: git(),
      gitBash,
      keepBackups: FAKE_KEEP_BACKUPS,
    };
  }

  function gitResult(outcome: GitResult["outcome"], extra: Partial<GitResult> = {}): GitResult {
    return { outcome, reason: null, detail: null, head: repoPresent ? (pulled ? "b2c3d4e" : "a1b2c3d") : null, before: null, update: null, pulled: [], pulledTotal: 0, ...extra };
  }

  /** git 일의 공통 거절: 개발자 모드 · git 없음 */
  function gitGate(): GitResult | null {
    if (options.developer) return gitResult("developer_mode");
    if (options.gitMissing) return gitResult("git_missing");
    return null;
  }

  function planChanges(): HarnessChange[] {
    if (!installed) {
      return [
        { path: "agents/harness-designer.md", action: "add", type: "file", reason: null },
        { path: "agents/harness-builder-system.md", action: "add", type: "file", reason: null },
        { path: "skills/desktop-app/SKILL.md", action: "add", type: "file", reason: null },
      ];
    }
    if (stale || pulled) {
      return [{ path: "agents/harness-designer.md", action: "change", type: "file", reason: null }];
    }
    return [];
  }

  function installReport(dryRun: boolean): HarnessReport {
    const changes = planChanges();
    const report = emptyReport("install", dryRun);
    report.developerMode = options.developer;
    report.changes = changes;
    report.counts = {
      add: changes.filter((c) => c.action === "add").length,
      change: changes.filter((c) => c.action === "change").length,
      remove: 0,
      skip: 0,
      same: installed ? 3 - changes.length : 0,
    };
    report.same = changes.length === 0;
    report.restartNeeded = !installed && changes.length > 0;
    report.existingSource = installed ? `${FAKE_HOME}\\repo` : null;
    return report;
  }

  const handlers: Record<string, Handler> = {
    harness_status: () => status(),

    harness_clone: () =>
      exclusive(() => {
        log.push("clone");
        const gate = gitGate();
        if (gate) return gate;
        if (repoPresent) return gitResult("already_present");
        repoPresent = true;
        forgetAll();
        return gitResult("cloned");
      }),

    harness_update_check: () =>
      exclusive(() => {
        log.push("update_check");
        const gate = gitGate();
        if (gate) return gate;
        if (!repoPresent) return gitResult("repo_missing");
        const behind = pulled ? 0 : 2;
        checked = true; // 본 커밋을 기억한다
        return gitResult("checked", {
          update: {
            branch: "main",
            upstream: "origin/main",
            upstreamHash: FAKE_UPSTREAM_HASH,
            state: behind > 0 ? "behind" : "up_to_date",
            ahead: 0,
            behind,
            dirty: false,
            commits: behind > 0
              ? [
                  { hash: "b2c3d4e", date: "2026-10-21", subject: "fix: 설치 스크립트 안내 줄 다듬기" },
                  { hash: "9f8e7d6", date: "2026-10-20", subject: "feat: 작업자 공통 규칙 한 줄 추가" },
                ]
              : [],
            commitsTotal: behind,
            files: behind > 0
              ? [
                  { status: "M", path: "agents/harness-designer.md" },
                  { status: "A", path: "shared/notes.md" },
                  { status: "D", path: "shared/old.md" },
                ]
              : [],
            filesTotal: behind > 0 ? 3 : 0,
            canPull: behind > 0,
          },
        });
      }),

    harness_update_pull: () =>
      exclusive(() => {
        log.push("update_pull");
        const gate = gitGate();
        if (gate) return gate;
        if (!repoPresent) return gitResult("repo_missing");
        // 확인 때 본 커밋까지만 — 확인이 없으면 거절하고, 확인은 한 번 쓰면 없어진다
        if (!checked) return gitResult("refused", { reason: "check_first" });
        checked = false;
        if (pulled) return gitResult("up_to_date");
        const before = "a1b2c3d";
        pulled = true;
        forgetPlans();
        return gitResult("updated", {
          before,
          pulled: [
            { hash: "b2c3d4e", date: "2026-10-21", subject: "fix: 설치 스크립트 안내 줄 다듬기" },
            { hash: "9f8e7d6", date: "2026-10-20", subject: "feat: 작업자 공통 규칙 한 줄 추가" },
          ],
          pulledTotal: 2,
        });
      }),

    harness_install_plan: () =>
      exclusive(() => {
        log.push("plan");
        installPlanned = false;
        if (!options.developer && !repoPresent) return noScript();
        if (options.unreadable) return unreadableResult();
        installPlanned = true; // 읽을 수 있는 미리보기를 본 원본을 기억한다
        return scriptResult(installReport(true));
      }),

    harness_install: () =>
      exclusive(() => {
        log.push("install");
        // 미리보기를 본 뒤에만 — 화면이 막아도 받는 쪽에서 다시 막는다
        if (!installPlanned) return refusedResult("plan_first");
        if (!options.developer && !repoPresent) return refusedResult("source_changed");
        forgetAll();
        const report = installReport(false);
        let prune: ScriptResult["prune"] = null;
        if (report.changes.length > 0) {
          // 덮어쓰거나 지울 것이 있으면 백업이 생긴다 (처음 설치는 파일이 0 개인 백업)
          const id = nextId();
          const files = report.changes.filter((c) => c.action !== "add").length;
          report.backup = { id, dir: `${FAKE_HOME}\\backups\\${id}`, files };
          backups.unshift({ id, createdAt: "2026-10-22T10:00:00+0900", command: "install", added: report.counts.add, changed: report.counts.change, removed: 0, files, bytes: files * 1000, readable: true });
          installed = true;
          stale = false;
          const removedIds = backups.slice(FAKE_KEEP_BACKUPS).map((b) => b.id);
          backups = backups.slice(0, FAKE_KEEP_BACKUPS);
          prune = { removed: removedIds.length, kept: backups.length, removedIds, skippedEntries: [], failed: [], skipped: null };
        }
        return { ...scriptResult(report), prune };
      }),

    harness_backups: () =>
      exclusive(() => {
        log.push("backups");
        if (options.unreadable) return unreadableResult();
        const report = emptyReport("backups", false);
        report.backups = backups.map((b) => ({ ...b }));
        return scriptResult(report);
      }),

    harness_restore_plan: (args) => restore(args, true),
    harness_restore: (args) => restore(args, false),
  };

  function restore(args: Record<string, unknown>, dryRun: boolean): Promise<ScriptResult> {
    const id = typeof args.backupId === "string" ? args.backupId : "";
    return exclusive(() => {
      log.push(dryRun ? "restore_plan" : "restore");
      // 진짜처럼 받는 쪽에서 모양을 먼저 확인한다
      if (!BACKUP_ID.test(id)) throw new AppError("invalid_input", "backup id has the wrong shape");
      if (dryRun) restorePlanned = null;
      // 되돌리기는 같은 번호의 되돌리기 미리보기를 본 뒤에만 (그 다음에 목록을 다시 확인한다)
      if (!dryRun && restorePlanned !== id) return refusedResult("plan_first");
      if (options.unreadable) return unreadableResult(); // 미리보기만 여기까지 온다 (깨진 미리보기 뒤의 되돌리기는 위에서 거절)
      const found = backups.find((b) => b.id === id);
      if (!found) throw new AppError("invalid_input", "backup id is not in the backup list");
      const report = emptyReport("restore", dryRun);
      report.changes = found.changed + found.removed > 0
        ? [{ path: "agents/harness-designer.md", action: "change", type: "file", reason: null }]
        : [];
      report.counts = { add: 0, change: report.changes.length, remove: 0, skip: 0, same: 0 };
      report.same = report.changes.length === 0;
      report.backup = { id, dir: `${FAKE_HOME}\\backups\\${id}`, files: found.files };
      if (dryRun) {
        restorePlanned = id;
      } else {
        // 되돌리면 설치 전 모습으로 — 다시 미리보기를 하면 바뀔 것이 생긴다
        stale = found.changed + found.removed > 0;
        if (found.added > 0 && found.changed + found.removed === 0) installed = false;
        forgetAll();
      }
      return scriptResult(report);
    });
  }

  return {
    handlers,
    /** 시험용: 가짜 상태를 설정과 함께 처음으로 */
    reset(next: Partial<FakeHarnessOptions> = {}) {
      options = { ...DEFAULTS, ...next };
      repoPresent = false;
      pulled = false;
      installed = false;
      stale = false;
      tick = 0;
      busy = false;
      forgetAll();
      log.length = 0;
      seedBackups(options.startBackups);
    },
    /** 시험용: 지금까지 부른 명령 (읽기 전용 `harness_status` 는 뺀다) */
    calls: () => [...log],
  };
}

export const fakeHarness = createFakeHarness();
