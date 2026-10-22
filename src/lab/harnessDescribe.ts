// 하네스 시험 화면의 결과 설명. 문구는 `ko.ts` 의 `lab.harness.*` (D-08).
// Rust 가 보낸 코드(`outcome` · `reason` · `action` …)가 화면이 아직 모르는 값이어도 죽지 않고 그 글 그대로 보인다 (약속 문서: 모르는 코드는 글 그대로).
import { isTextKey, t, tf } from "../i18n/ko";
import type {
  GitResult,
  HarnessBackupInfo,
  HarnessChange,
  HarnessOrigin,
  HarnessStatus,
  ScriptResult,
  UpdatePreview,
} from "../lib/ipc";

/** `<접두사>.<코드>` 문구가 있으면 그 문구, 없으면 코드 그대로 */
export function codeText(prefix: string, code: string): string {
  const key = `${prefix}.${code}`;
  return isTextKey(key) ? t(key) : code;
}

/** `<접두사>.<코드>` 문구에 값을 채운다. 문구가 없으면 코드 그대로. */
function codeTextWith(prefix: string, code: string, vars: Record<string, string | number>): string {
  const key = `${prefix}.${code}`;
  return isTextKey(key) ? tf(key, vars) : code;
}

const dash = () => t("lab.none");

/** 받기 · 업데이트 확인 · 업데이트 받기 결과 한 줄 + 덧붙임 줄들 */
export function describeGit(result: GitResult): string[] {
  const lines: string[] = [];
  const reason = result.reason ? codeText("lab.harness.reason", result.reason) : "";
  lines.push(
    codeTextWith("lab.harness.git", result.outcome, {
      head: result.head ?? dash(),
      before: result.before ?? dash(),
      reason,
    }),
  );
  if (result.outcome === "repo_unusable" && result.reason === "remote_mismatch") {
    lines.push(result.detail ? tf("lab.harness.git.remoteIs", { remote: result.detail }) : "");
  } else if (result.detail) {
    lines.push(tf("lab.harness.git.detail", { detail: result.detail }));
  }
  return lines.filter((line) => line !== "");
}

/** 업데이트 확인의 상태 문장 */
export function describeUpdateState(update: UpdatePreview): string {
  return codeTextWith("lab.harness.update.state", update.state, { ahead: update.ahead, behind: update.behind });
}

export function describeFileStatus(status: string): string {
  return codeText("lab.harness.fileStatus", status);
}

/** `~/.claude/harness` 가 가리키는 곳 */
export function describeOrigin(origin: HarnessOrigin): string {
  const marker = origin.marker ? codeText("lab.harness.marker", origin.marker) : dash();
  return codeTextWith("lab.harness.origin", origin.kind, {
    marker,
    path: origin.path ?? dash(),
    reason: origin.reason ? codeText("lab.harness.originReason", origin.reason) : dash(),
  });
}

/** 위치를 정하지 못한 이유 */
export function describeLocationProblem(problem: string): string {
  return tf("lab.harness.where.unknown", { problem: codeText("lab.harness.locProblem", problem) });
}

/** 받은 원본(repo) 한 줄 */
export function describeRepo(status: HarnessStatus): string {
  const repo = status.repo;
  if (!repo || !repo.present) return t("lab.harness.status.repoNone");
  if (repo.problem) {
    const text = codeText("lab.harness.repoProblem", repo.problem);
    return repo.remote ? `${text} (${repo.remote})` : text;
  }
  if (repo.usable === true) return tf("lab.harness.status.repoOk", { head: repo.head ?? dash() });
  return t("lab.harness.status.repoUnchecked");
}

export function describeGitInfo(status: HarnessStatus): string {
  const { git } = status;
  if (!git.found) return t("lab.harness.status.gitMissing");
  if (!git.version) return tf("lab.harness.status.gitNoVersion", { path: git.path ?? dash() });
  return tf("lab.harness.status.gitFound", { version: git.version, path: git.path ?? dash() });
}

export function describeGitBash(status: HarnessStatus): string {
  const bash = status.gitBash;
  if (!bash.required) return t("lab.harness.status.gitBashNotNeeded");
  if (bash.found) return tf("lab.harness.status.gitBashFound", { path: bash.path ?? dash() });
  if (bash.problem === "env_path_missing") return t("lab.harness.status.gitBashEnvMissing");
  return t("lab.harness.status.gitBashMissing");
}

/** 바뀌는 목록의 한 줄 */
export function describeChange(change: HarnessChange): string {
  const action = codeText("lab.harness.action", change.action);
  const note = change.reason ? ` (${change.reason})` : "";
  return `${action} — ${change.path}${note}`;
}

/** 백업 목록의 한 줄 */
export function describeBackup(backup: HarnessBackupInfo): string {
  if (!backup.readable) return `${backup.id} · ${t("lab.harness.backups.unreadable")}`;
  return tf("lab.harness.backups.row", {
    id: backup.id,
    when: backup.createdAt ?? dash(),
    added: backup.added,
    changed: backup.changed,
    removed: backup.removed,
    files: backup.files,
  });
}

/** 스크립트를 돌린 결과 머리 한 줄 (앱이 돌리지 않고 거절했으면 그 이유까지) */
export function describeScriptHeadline(result: ScriptResult): string {
  return codeTextWith("lab.harness.script", result.outcome, {
    code: result.exitCode ?? dash(),
    reason: result.reason ? codeText("lab.harness.refused", result.reason) : dash(),
  });
}

/** 설치 뒤 백업 정리를 건너뛴 이유 */
export function describePruneSkipped(reason: string): string {
  return codeText("lab.harness.pruneSkipped", reason);
}

/** 이 위치가 시험 폴더인가 — 환경 변수로 정했고 **기본 위치와 다를 때만** 그렇다. 환경 변수가 기본 위치를 가리키면 실제 폴더다 (이름이 아니라 Rust 가 같은 폴더인지 비교한 값을 쓴다). */
export function isSandbox(status: HarnessStatus): boolean {
  return (
    status.claudeDir !== null &&
    status.harnessHome !== null &&
    status.claudeDirFromEnv &&
    !status.claudeDirIsDefault &&
    status.harnessHomeFromEnv &&
    !status.harnessHomeIsDefault
  );
}

/** 위치가 어떻게 정해졌는지 한 줄 */
export function describeLocationSource(status: HarnessStatus): string {
  if (isSandbox(status)) return t("lab.harness.where.fromEnv");
  const envButDefault = (status.claudeDirFromEnv && status.claudeDirIsDefault) || (status.harnessHomeFromEnv && status.harnessHomeIsDefault);
  return t(envButDefault ? "lab.harness.where.envIsDefault" : "lab.harness.where.fromDefault");
}

/** 읽을 수 없는 이유 */
export function describeUnreadable(result: ScriptResult): string | null {
  const why = result.unreadable;
  if (!why) return null;
  return codeTextWith("lab.harness.unreadable", why.reason, { contract: why.contract ?? dash() });
}

/** 설치 결과가 "설치 성공" 인가 (정리 · 안내 문구를 고르는 기준) */
export function installSucceeded(result: ScriptResult): boolean {
  const report = result.report;
  return result.outcome === "ran" && result.exitCode === 0 && report !== null && report.ok && !report.dryRun;
}

/** 미리보기 결과로 설치를 눌러도 되는가: 읽혔고 · 막는 문제가 없고 · 바뀔 것이 있다. 아니면 이유 문구 (눌러도 되면 null). */
export function planBlocker(result: ScriptResult | null, fresh: boolean): string | null {
  if (result === null) return t("lab.harness.install.needPlan");
  if (!fresh) return t("lab.harness.install.planStale");
  const report = result.report;
  if (result.outcome !== "ran" || report === null || !report.ok || result.exitCode !== 0 || report.problems.length > 0) {
    return t("lab.harness.install.planBlocked");
  }
  if (report.same) return t("lab.harness.install.planSame");
  return null;
}
