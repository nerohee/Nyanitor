//! 설치 스크립트 실행 · 표준 출력 JSON 읽기 (약속 2절, D-22 · D-46, 정해 둔 것 7 · 8 · 9).
//!
//! 실행하는 것은 이 OS 의 인터프리터(Windows `System32` 의 PowerShell · 그 밖 `bash`) 하나이고, 스크립트는 Rust 가 정한 원본 폴더의
//! `install.ps1` / `install.sh` 뿐이다. 옵션은 [`Op`] 다섯 가지 조합만 — 화면에서 인자 · 경로를 받는 길은 없다.
//! 읽는 쪽 규칙은 하나다: **모르는 버전이거나 JSON 이 깨졌으면 죽지 않고 "읽을 수 없음"** 으로 돌려주고, 모르는 코드는 글 그대로 넘긴다.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_log::log;

use super::backups::{self, PruneResult, is_backup_id};
use super::locate::{CONFIG_DIR_VAR, HARNESS_HOME_VAR, resolve_source};
use super::{Context, KEEP_BACKUPS};
use crate::claude::exec::{Captured, ClaudeCommand};
use crate::error::AppError;

/// 앱이 아는 약속 문서 버전 (`shared/app-contract.md` 맨 위)
pub const CONTRACT_VERSION: u64 = 1;

/// 미리보기 · 백업 목록 (아무것도 쓰지 않는 명령)
const READ_TIMEOUT: Duration = Duration::from_secs(180);
/// 설치 · 되돌리기 (쓰는 명령 — 시간이 넘으면 중간에 끊기므로 넉넉히)
const WRITE_TIMEOUT: Duration = Duration::from_secs(900);

/// 화면에 보이는 원문 앞부분의 길이
const HEAD_MAX: usize = 400;

/// 앱이 부르는 명령 다섯 가지. 번호(`String`)는 [`restore`] · [`restore_plan`] 이 모양과 목록을 다시 확인한 것만 들어온다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// 설치 미리보기 (`--plan --json`)
    Plan,
    /// 설치 (`--json`)
    Install,
    /// 백업 목록 (`--backups --json`)
    Backups,
    /// 되돌리기 미리보기 (`--restore <번호> --plan --json`)
    RestorePlan(String),
    /// 되돌리기 (`--restore <번호> --json`)
    Restore(String),
}

impl Op {
    /// JSON 의 `command` 값으로 기대하는 것 (`--plan` 은 `install` 의 미리보기다)
    fn expected_command(&self) -> &'static str {
        match self {
            Op::Plan | Op::Install => "install",
            Op::Backups => "backups",
            Op::RestorePlan(_) | Op::Restore(_) => "restore",
        }
    }

    fn timeout(&self) -> Duration {
        match self {
            Op::Install | Op::Restore(_) => WRITE_TIMEOUT,
            _ => READ_TIMEOUT,
        }
    }
}

/// 스크립트 뒤에 붙는 옵션 (Windows 는 `-Plan`, 그 밖은 `--plan`)
pub fn script_options(op: &Op, windows: bool) -> Vec<OsString> {
    let (plan, json, backups, restore) = if windows {
        ("-Plan", "-Json", "-Backups", "-Restore")
    } else {
        ("--plan", "--json", "--backups", "--restore")
    };
    let mut out: Vec<OsString> = Vec::new();
    match op {
        Op::Plan => out.push(plan.into()),
        Op::Install => {}
        Op::Backups => out.push(backups.into()),
        Op::RestorePlan(id) => {
            out.push(restore.into());
            out.push(id.into());
            out.push(plan.into());
        }
        Op::Restore(id) => {
            out.push(restore.into());
            out.push(id.into());
        }
    }
    out.push(json.into());
    out
}

/// 인터프리터 뒤의 전체 인자: Windows 는 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File <스크립트> <옵션>`, 그 밖은 `<스크립트> <옵션>`.
pub fn build_args(op: &Op, script: &Path, windows: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = Vec::new();
    if windows {
        args.extend(
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ]
            .iter()
            .map(OsString::from),
        );
    }
    args.push(script.as_os_str().to_owned());
    args.extend(script_options(op, windows));
    args
}

/// `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe` — PATH 로 찾지 않는다 (쓰기 가능한 폴더의 가짜 `powershell.exe` 를 막는다).
pub fn system_powershell_exe(system_root: Option<&OsStr>) -> PathBuf {
    let root = system_root
        .filter(|root| !root.is_empty())
        .map_or_else(|| PathBuf::from("C:\\Windows"), PathBuf::from);
    root.join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

/// 이 OS 에서 스크립트를 돌릴 인터프리터의 절대 경로
fn interpreter() -> PathBuf {
    if cfg!(windows) {
        system_powershell_exe(std::env::var_os("SystemRoot").as_deref())
    } else {
        ["/bin/bash", "/usr/bin/bash"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from("/bin/bash"))
    }
}

// ───────────────────────────── JSON 모양 (약속 2-3절) ─────────────────────────────
// 모든 키가 없어도 읽는다 (해당 없는 것은 null · []). 모르는 키는 버리고 모르는 코드 값은 글 그대로 둔다.

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Report {
    pub contract: u32,
    pub command: String,
    pub ok: bool,
    pub exit_code: i32,
    pub dry_run: bool,
    pub claude_dir: Option<String>,
    pub harness_home: Option<String>,
    pub repo: Option<String>,
    pub mode: Option<String>,
    pub developer_mode: bool,
    pub existing_source: Option<String>,
    pub restart_needed: bool,
    pub custom: Option<CustomInfo>,
    pub changes: Vec<Change>,
    pub counts: Counts,
    pub same: bool,
    pub origin_changed: Vec<OriginChanged>,
    pub problems: Vec<Problem>,
    pub warnings: Vec<Warning>,
    pub backup: Option<BackupRef>,
    pub backups: Vec<BackupInfo>,
    pub origin_hash: Option<Value>,
    pub rolled_back: Option<bool>,
    pub error: Option<ErrorInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomInfo {
    pub dir: Option<String>,
    pub items: Vec<CustomItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomItem {
    pub path: String,
    /// `values` · `append` · `replace` · `new` · `config` (모르는 값은 글 그대로)
    pub kind: String,
    pub origin_changed: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// `add` · `change` · `remove` · `skip` (모르는 값은 글 그대로)
    pub action: String,
    /// `file` · `link`
    #[serde(rename = "type")]
    pub kind: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Counts {
    pub add: u32,
    pub change: u32,
    pub remove: u32,
    pub skip: u32,
    pub same: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct OriginChanged {
    pub path: String,
    pub recorded: Option<String>,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Problem {
    pub path: Option<String>,
    pub reason: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Warning {
    pub path: Option<String>,
    pub reason: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupRef {
    pub id: String,
    pub dir: Option<String>,
    pub files: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BackupInfo {
    pub id: String,
    pub created_at: Option<String>,
    pub command: Option<String>,
    pub added: u32,
    pub changed: u32,
    pub removed: u32,
    pub files: u32,
    pub bytes: u64,
    pub readable: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ErrorInfo {
    /// `badArgs` · `notFound` · `noBackup` · … (모르는 코드는 글 그대로)
    pub code: String,
    pub detail: Option<String>,
}

// ───────────────────────────── 출력 읽기 ─────────────────────────────

/// "읽을 수 없음" 의 이유 (진단용 짧은 이름 — 화면이 문구를 고른다)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnreadableReason {
    /// 표준 출력에 JSON 줄이 없다
    NoJson,
    /// JSON 이 깨졌다
    BadJson,
    /// `contract` 가 1 이 아니거나 없다
    UnknownContract,
    /// 약속 모양(키의 종류)과 다르다
    BadShape,
    /// 부른 명령과 `command` 가 다르다
    UnexpectedCommand,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    pub reason: UnreadableReason,
    /// JSON 의 `contract` 값 (있으면, 글로)
    pub contract: Option<String>,
    /// 표준 출력 앞부분
    pub head: String,
    /// 표준 오류 앞부분
    pub stderr_head: String,
}

/// 읽은 결과 (실행과 따로 시험하려고 나눈 순수한 값)
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Report { report: Box<Report>, raw: String },
    Unreadable(Unreadable),
}

fn head_of(text: &str) -> String {
    text.trim()
        .chars()
        .take(HEAD_MAX)
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect()
}

/// 표준 출력의 마지막 JSON 줄(`{` 로 시작하는 줄)을 읽는다. 종료 코드 1 · 2 · 3 도 JSON 이 있으면 정상 결과다.
pub fn parse_output(stdout: &str, stderr: &str, expected_command: &str) -> Parsed {
    let unreadable = |reason: UnreadableReason, contract: Option<String>| {
        Parsed::Unreadable(Unreadable {
            reason,
            contract,
            head: head_of(stdout),
            stderr_head: head_of(stderr),
        })
    };
    let text = stdout.trim_start_matches('\u{feff}');
    let Some(line) = text
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
    else {
        return unreadable(UnreadableReason::NoJson, None);
    };
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return unreadable(UnreadableReason::BadJson, None),
    };
    let found = value.get("contract").map(|v| match v {
        Value::String(s) => s.chars().take(32).collect::<String>(),
        other => other.to_string().chars().take(32).collect(),
    });
    if value.get("contract").and_then(Value::as_u64) != Some(CONTRACT_VERSION) {
        return unreadable(UnreadableReason::UnknownContract, found);
    }
    let report: Report = match serde_json::from_value(value) {
        Ok(report) => report,
        Err(_) => return unreadable(UnreadableReason::BadShape, found),
    };
    if report.command != expected_command {
        return unreadable(UnreadableReason::UnexpectedCommand, found);
    }
    Parsed::Report {
        report: Box::new(report),
        raw: line.to_string(),
    }
}

// ───────────────────────────── 실행 ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptOutcome {
    /// 스크립트가 돌았고 JSON 을 읽었다 (종료 코드가 0 이 아니어도 — `report` 와 `exitCode` 를 본다)
    Ran,
    /// 돌았지만 출력을 읽을 수 없다 (`unreadable`)
    Unreadable,
    /// 돌릴 설치 스크립트가 없다 (원본을 아직 안 받았거나 개발자 원본에 스크립트가 없다)
    NoScript,
    /// 앱이 하지 않았다 — 스크립트를 돌리지 않았다 (`reason`: `plan_first` 미리보기를 본 적 없음 · `source_changed` 미리보기 뒤 원본이 바뀜)
    Refused,
    /// 시간이 넘어 끝냈다 (설치 · 되돌리기였다면 중간에 끊겼을 수 있다 — 백업에서 되돌리기를 권한다)
    TimedOut,
    /// 인터프리터를 실행하지 못했다 (`detail`)
    SpawnFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptResult {
    pub outcome: ScriptOutcome,
    /// 프로세스 종료 코드
    pub exit_code: Option<i32>,
    pub report: Option<Report>,
    /// 읽은 JSON 한 줄 (원문 보기용)
    pub raw: Option<String>,
    pub unreadable: Option<Unreadable>,
    /// 쓰는 중 실패(종료 코드 3) · 시간 초과 · 결과를 알 수 없음(설치 · 되돌리기) — 백업에서 되돌리기를 권한다 (`report.rolledBack` 은 스스로 되돌렸는지)
    pub restore_advised: bool,
    /// 돌린 스크립트
    pub script: Option<String>,
    /// 설치 뒤 백업 정리 결과 (설치만)
    pub prune: Option<PruneResult>,
    pub detail: Option<String>,
    /// `Refused` 의 이유: `plan_first` · `source_changed`
    pub reason: Option<String>,
}

impl ScriptResult {
    fn bare(outcome: ScriptOutcome) -> Self {
        Self {
            outcome,
            exit_code: None,
            report: None,
            raw: None,
            unreadable: None,
            restore_advised: false,
            script: None,
            prune: None,
            detail: None,
            reason: None,
        }
    }

    /// 스크립트를 돌리지 않고 거절한 결과 (오류가 아니라 결과로 — 화면이 이유를 보인다)
    pub fn refused(reason: &str) -> Self {
        let mut result = Self::bare(ScriptOutcome::Refused);
        result.reason = Some(reason.to_string());
        result
    }
}

/// 지금 돌릴 설치 스크립트 (원본을 고르는 규칙은 `resolve_source`). 없으면 `None`.
pub fn current_script(ctx: &Context) -> Option<PathBuf> {
    resolve_source(&ctx.locations).script()
}

/// 스크립트를 한 번 돌려 결과를 읽는다. 어떤 실패도 죽지 않고 `ScriptResult` 로 돌려준다.
pub fn run_script(ctx: &Context, op: &Op) -> ScriptResult {
    match current_script(ctx) {
        Some(script) => run_script_at(ctx, op, &script),
        None => ScriptResult::bare(ScriptOutcome::NoScript),
    }
}

/// 이미 정한 스크립트로 한 번 돌린다 (미리보기 때 본 원본과 같은 것만 돌리려고, 고른 경로를 그대로 쓴다).
pub fn run_script_at(ctx: &Context, op: &Op, script: &Path) -> ScriptResult {
    let program = interpreter();
    let args = build_args(op, script, cfg!(windows));

    // 위치는 앱이 정한 값을 그대로 넘긴다 (환경에 있던 값이 있어도 이 값이 이긴다)
    let mut command = ClaudeCommand::new(&program)
        .with_extra_env(CONFIG_DIR_VAR, ctx.locations.claude_dir.as_os_str())
        .with_extra_env(HARNESS_HOME_VAR, ctx.locations.harness_home.as_os_str());
    for (name, value) in &ctx.extra_env {
        command = command.with_extra_env(name, value);
    }
    log::info!("harness: running {} ({:?})", script.display(), op_label(op));
    let captured = match command.run_capture(&args, ctx.timeout.unwrap_or_else(|| op.timeout())) {
        Ok(captured) => captured,
        Err(err) => {
            let mut result = ScriptResult::bare(ScriptOutcome::SpawnFailed);
            result.script = Some(script.display().to_string());
            result.detail = Some(format!("could not run the script interpreter: {err}"));
            return result;
        }
    };
    interpret(op, script, captured)
}

/// 파일을 쓰는 명령인가 (설치 · 되돌리기)
fn writes(op: &Op) -> bool {
    matches!(op, Op::Install | Op::Restore(_))
}

fn op_label(op: &Op) -> &'static str {
    match op {
        Op::Plan => "plan",
        Op::Install => "install",
        Op::Backups => "backups",
        Op::RestorePlan(_) => "restore-plan",
        Op::Restore(_) => "restore",
    }
}

/// 돌려받은 출력을 결과로 (프로세스 없이 시험하려고 나눔)
pub fn interpret(op: &Op, script: &Path, captured: Captured) -> ScriptResult {
    let mut result = ScriptResult::bare(ScriptOutcome::Ran);
    result.script = Some(script.display().to_string());
    result.exit_code = captured.code;
    if captured.timed_out {
        result.outcome = ScriptOutcome::TimedOut;
        result.restore_advised = writes(op);
        return result;
    }
    match parse_output(&captured.stdout, &captured.stderr, op.expected_command()) {
        Parsed::Report { report, raw } => {
            result.restore_advised = captured.code == Some(3);
            result.report = Some(*report);
            result.raw = Some(raw);
        }
        Parsed::Unreadable(why) => {
            result.outcome = ScriptOutcome::Unreadable;
            result.unreadable = Some(why);
            // 쓰는 일이 읽을 수 없는 결과로 끝났으면 어디까지 썼는지 모른다 — 시간 초과와 같게 되돌리기를 권한다
            result.restore_advised = writes(op);
        }
    }
    result
}

pub fn plan(ctx: &Context) -> ScriptResult {
    run_script(ctx, &Op::Plan)
}

pub fn backups_list(ctx: &Context) -> ScriptResult {
    run_script(ctx, &Op::Backups)
}

/// 이 결과가 "설치가 성공했고 백업을 만들었다" 인가 (백업 정리의 조건)
fn made_a_backup(result: &ScriptResult) -> Option<&str> {
    let report = result.report.as_ref()?;
    (result.outcome == ScriptOutcome::Ran
        && result.exit_code == Some(0)
        && report.ok
        && !report.dry_run
        && report.command == "install"
        && report.error.is_none()
        && report.problems.is_empty())
    .then_some(())?;
    report
        .backup
        .as_ref()
        .map(|b| b.id.as_str())
        .filter(|id| is_backup_id(id))
}

/// 설치. 성공하고 백업을 만들었으면 오래된 백업을 정리한다 (D-46).
pub fn install(ctx: &Context) -> ScriptResult {
    let result = run_script(ctx, &Op::Install);
    finish_install(ctx, result)
}

/// 미리보기 때 본 스크립트(`script`)로 설치한다 (`install` 과 같다).
pub fn install_at(ctx: &Context, script: &Path) -> ScriptResult {
    let result = run_script_at(ctx, &Op::Install, script);
    finish_install(ctx, result)
}

fn finish_install(ctx: &Context, mut result: ScriptResult) -> ScriptResult {
    let Some(id) = made_a_backup(&result) else {
        return result;
    };
    // 설치 스크립트의 잠금이 남아 있으면 다른 곳(터미널의 설치 · 되돌리기)이 백업을 쓰는 중일 수 있다 — 정리를 미룬다
    if fs::symlink_metadata(ctx.locations.install_lock()).is_ok() {
        result.prune = Some(PruneResult {
            skipped: Some("locked".into()),
            ..PruneResult::default()
        });
        return result;
    }
    let pruned = backups::prune(&ctx.locations.harness_home, KEEP_BACKUPS, Some(id));
    if pruned.removed > 0 || !pruned.failed.is_empty() {
        log::info!(
            "harness: pruned {} old backups ({} failed)",
            pruned.removed,
            pruned.failed.len()
        );
    }
    result.prune = Some(pruned);
    result
}

/// 번호 모양 확인 (스크립트를 돌리기 전에 — 화면이 넘긴 값은 믿지 않는다)
pub fn check_backup_id_shape(id: &str) -> Result<(), AppError> {
    if is_backup_id(id) {
        Ok(())
    } else {
        Err(AppError::InvalidInput(
            "backup id has the wrong shape".into(),
        ))
    }
}

/// 되돌리기에 쓸 번호를 확인한다: 번호 모양 + 지금 `--backups` 목록에 있는 것. 아니면 오류, 목록을 못 읽으면 그 결과를 돌려준다.
/// 목록도 `script` 로 부른다 (되돌리기와 같은 스크립트).
fn checked_backup_id(
    ctx: &Context,
    script: &Path,
    id: &str,
) -> Result<Result<String, ScriptResult>, AppError> {
    check_backup_id_shape(id)?;
    let listed = run_script_at(ctx, &Op::Backups, script);
    let Some(report) = listed
        .report
        .as_ref()
        .filter(|_| listed.outcome == ScriptOutcome::Ran)
    else {
        return Ok(Err(listed));
    };
    if !report.backups.iter().any(|b| b.id == id) {
        return Err(AppError::InvalidInput(
            "backup id is not in the backup list".into(),
        ));
    }
    Ok(Ok(id.to_string()))
}

/// 되돌리기 미리보기 (아무것도 쓰지 않는다)
pub fn restore_plan(ctx: &Context, id: &str) -> Result<ScriptResult, AppError> {
    check_backup_id_shape(id)?;
    match current_script(ctx) {
        Some(script) => restore_plan_at(ctx, id, &script),
        None => Ok(ScriptResult::bare(ScriptOutcome::NoScript)),
    }
}

pub fn restore_plan_at(ctx: &Context, id: &str, script: &Path) -> Result<ScriptResult, AppError> {
    Ok(match checked_backup_id(ctx, script, id)? {
        Ok(id) => run_script_at(ctx, &Op::RestorePlan(id), script),
        Err(unreadable_list) => unreadable_list,
    })
}

/// 되돌리기
pub fn restore(ctx: &Context, id: &str) -> Result<ScriptResult, AppError> {
    check_backup_id_shape(id)?;
    match current_script(ctx) {
        Some(script) => restore_at(ctx, id, &script),
        None => Ok(ScriptResult::bare(ScriptOutcome::NoScript)),
    }
}

/// 되돌리기 미리보기 때 본 스크립트(`script`)로 되돌린다 (`restore` 와 같다).
pub fn restore_at(ctx: &Context, id: &str, script: &Path) -> Result<ScriptResult, AppError> {
    Ok(match checked_backup_id(ctx, script, id)? {
        Ok(id) => run_script_at(ctx, &Op::Restore(id), script),
        Err(unreadable_list) => unreadable_list,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn windows_options_are_the_ps1_spellings() {
        let id = "2026-10-18_143205".to_string();
        assert_eq!(os(script_options(&Op::Plan, true)), ["-Plan", "-Json"]);
        assert_eq!(os(script_options(&Op::Install, true)), ["-Json"]);
        assert_eq!(
            os(script_options(&Op::Backups, true)),
            ["-Backups", "-Json"]
        );
        assert_eq!(
            os(script_options(&Op::RestorePlan(id.clone()), true)),
            ["-Restore", "2026-10-18_143205", "-Plan", "-Json"]
        );
        assert_eq!(
            os(script_options(&Op::Restore(id), true)),
            ["-Restore", "2026-10-18_143205", "-Json"]
        );
    }

    #[test]
    fn other_systems_use_the_sh_spellings() {
        let id = "2026-10-18_143205".to_string();
        assert_eq!(os(script_options(&Op::Plan, false)), ["--plan", "--json"]);
        assert_eq!(os(script_options(&Op::Install, false)), ["--json"]);
        assert_eq!(
            os(script_options(&Op::Backups, false)),
            ["--backups", "--json"]
        );
        assert_eq!(
            os(script_options(&Op::RestorePlan(id.clone()), false)),
            ["--restore", "2026-10-18_143205", "--plan", "--json"]
        );
        assert_eq!(
            os(script_options(&Op::Restore(id), false)),
            ["--restore", "2026-10-18_143205", "--json"]
        );
    }

    #[test]
    fn full_arguments_put_the_script_after_the_fixed_powershell_switches() {
        let script = Path::new("C:\\Users\\me\\.claude-harness\\repo\\install.ps1");
        let args = os(build_args(&Op::Plan, script, true));
        assert_eq!(
            args,
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                "C:\\Users\\me\\.claude-harness\\repo\\install.ps1",
                "-Plan",
                "-Json"
            ]
        );
        let sh = os(build_args(&Op::Install, Path::new("/x/install.sh"), false));
        assert_eq!(sh, ["/x/install.sh", "--json"]);
    }

    #[test]
    fn powershell_is_taken_from_system32_not_from_path() {
        assert_eq!(
            system_powershell_exe(Some(OsStr::new("D:\\WINNT"))),
            Path::new("D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        );
        assert_eq!(
            system_powershell_exe(None),
            Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        );
        assert_eq!(
            system_powershell_exe(Some(OsStr::new(""))),
            Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
        );
    }

    fn report_json(extra: &str) -> String {
        format!(
            "{{\"contract\":1,\"command\":\"install\",\"ok\":true,\"exitCode\":0,\"dryRun\":true{extra}}}"
        )
    }

    #[test]
    fn a_plain_report_is_read() {
        let json = report_json(
            ",\"counts\":{\"add\":1,\"change\":2,\"remove\":0,\"skip\":0,\"same\":3},\"same\":false",
        );
        let Parsed::Report { report, raw } = parse_output(&format!("{json}\n"), "", "install")
        else {
            panic!("should be readable");
        };
        assert_eq!(report.counts.change, 2);
        assert!(report.dry_run && report.ok);
        assert_eq!(raw, json);
    }

    #[test]
    fn a_bom_blank_lines_and_other_text_around_the_json_are_tolerated() {
        let json = report_json("");
        let out = format!("\u{feff}\r\n  some warning\r\n{json}\r\n\r\n");
        assert!(matches!(
            parse_output(&out, "", "install"),
            Parsed::Report { .. }
        ));
        // JSON 줄이 둘이면 마지막 줄을 읽는다
        let first = "{\"contract\":1,\"command\":\"install\",\"ok\":false,\"exitCode\":2}";
        let Parsed::Report { report, .. } =
            parse_output(&format!("{first}\n{json}\n"), "", "install")
        else {
            panic!()
        };
        assert!(report.ok);
    }

    #[test]
    fn no_json_or_broken_json_is_unreadable_with_the_head_of_the_text() {
        for (stdout, reason) in [
            ("", UnreadableReason::NoJson),
            ("hello\nworld\n", UnreadableReason::NoJson),
            ("[1,2,3]", UnreadableReason::NoJson),
            ("{\"contract\":1,\"command\":", UnreadableReason::BadJson),
            ("{not json}", UnreadableReason::BadJson),
        ] {
            let Parsed::Unreadable(why) = parse_output(stdout, "boom\u{7}err", "install") else {
                panic!("{stdout:?} should be unreadable");
            };
            assert_eq!(why.reason, reason, "{stdout:?}");
            assert_eq!(why.head, stdout.trim());
            assert_eq!(why.stderr_head, "boom err", "제어 글자는 공백으로");
        }
    }

    #[test]
    fn a_long_unreadable_text_is_cut_at_the_head_limit() {
        let Parsed::Unreadable(why) = parse_output(&"x".repeat(5000), "", "install") else {
            panic!()
        };
        assert_eq!(why.head.chars().count(), HEAD_MAX);
    }

    #[test]
    fn contract_other_than_one_is_unreadable_even_if_the_rest_looks_fine() {
        for contract in ["2", "0", "99", "\"1\"", "null", "1.5", "true"] {
            let json = format!(
                "{{\"contract\":{contract},\"command\":\"install\",\"ok\":true,\"exitCode\":0}}"
            );
            let Parsed::Unreadable(why) = parse_output(&json, "", "install") else {
                panic!("contract {contract} must be unreadable");
            };
            assert_eq!(why.reason, UnreadableReason::UnknownContract, "{contract}");
            assert_eq!(why.contract.as_deref().map(|c| c.is_empty()), Some(false));
        }
        // 키가 아예 없을 때
        let Parsed::Unreadable(why) = parse_output("{\"command\":\"install\"}", "", "install")
        else {
            panic!()
        };
        assert_eq!(why.reason, UnreadableReason::UnknownContract);
        assert_eq!(why.contract, None);
    }

    #[test]
    fn a_future_shape_under_a_newer_contract_is_not_even_parsed() {
        // contract 2 에서 counts 가 배열로 바뀌었다고 해도 BadShape 가 아니라 UnknownContract 다
        let json = "{\"contract\":2,\"command\":\"install\",\"counts\":[1,2]}";
        let Parsed::Unreadable(why) = parse_output(json, "", "install") else {
            panic!()
        };
        assert_eq!(why.reason, UnreadableReason::UnknownContract);
    }

    #[test]
    fn wrong_types_under_contract_one_are_a_bad_shape() {
        let head = "\"contract\":1,\"command\":\"install\"";
        for body in [
            format!("{{{head},\"ok\":true,\"counts\":\"many\"}}"),
            format!("{{{head},\"ok\":true,\"changes\":{{\"a\":1}}}}"),
            format!("{{{head},\"ok\":true,\"backups\":[1,2]}}"),
            format!("{{{head},\"ok\":true,\"problems\":\"none\"}}"),
            format!("{{{head},\"ok\":\"yes\"}}"),
            format!("{{{head},\"exitCode\":\"zero\"}}"),
        ] {
            let Parsed::Unreadable(why) = parse_output(&body, "", "install") else {
                panic!("{body} should be a bad shape");
            };
            assert_eq!(why.reason, UnreadableReason::BadShape, "{body}");
        }
    }

    #[test]
    fn the_command_must_be_the_one_we_asked_for() {
        let json = "{\"contract\":1,\"command\":\"uninstall\",\"ok\":true,\"exitCode\":0}";
        let Parsed::Unreadable(why) = parse_output(json, "", "install") else {
            panic!()
        };
        assert_eq!(why.reason, UnreadableReason::UnexpectedCommand);
        assert!(matches!(
            parse_output(json, "", "uninstall"),
            Parsed::Report { .. }
        ));
    }

    #[test]
    fn unknown_codes_and_keys_are_passed_through_as_text() {
        let json = report_json(
            ",\"future\":{\"x\":1},\"mode\":\"hologram\",\"changes\":[{\"path\":\"a\",\"action\":\"teleport\",\"type\":\"portal\",\"reason\":\"newReason\"}],\"problems\":[{\"path\":\"p\",\"reason\":\"brandNew\"}],\"warnings\":[{\"reason\":\"alsoNew\",\"detail\":\"d\"}],\"error\":{\"code\":\"neverSeen\",\"detail\":\"한국어 줄\"},\"custom\":{\"items\":[{\"path\":\"agents/x.md\",\"kind\":\"quantum\",\"originChanged\":null}]}",
        );
        let Parsed::Report { report, .. } = parse_output(&json, "", "install") else {
            panic!("must be readable");
        };
        assert_eq!(report.mode.as_deref(), Some("hologram"));
        assert_eq!(report.changes[0].action, "teleport");
        assert_eq!(report.changes[0].kind, "portal");
        assert_eq!(report.changes[0].reason.as_deref(), Some("newReason"));
        assert_eq!(report.problems[0].reason, "brandNew");
        assert_eq!(report.warnings[0].reason, "alsoNew");
        let error = report.error.unwrap();
        assert_eq!(
            (error.code.as_str(), error.detail.as_deref()),
            ("neverSeen", Some("한국어 줄"))
        );
        assert_eq!(report.custom.unwrap().items[0].kind, "quantum");
    }

    #[test]
    fn a_report_goes_back_out_in_the_contract_spelling() {
        let json = report_json(
            ",\"changes\":[{\"path\":\"a\",\"action\":\"add\",\"type\":\"file\",\"reason\":null}],\"rolledBack\":null",
        );
        let Parsed::Report { report, .. } = parse_output(&json, "", "install") else {
            panic!()
        };
        let value = serde_json::to_value(&*report).unwrap();
        assert_eq!(value["changes"][0]["type"], "file");
        assert_eq!(value["exitCode"], 0);
        assert_eq!(value["dryRun"], true);
        assert!(value["rolledBack"].is_null());
    }

    fn captured(code: Option<i32>, stdout: &str) -> Captured {
        Captured {
            code,
            stdout: stdout.to_string(),
            stderr: String::new(),
            timed_out: false,
        }
    }

    #[test]
    fn exit_codes_1_2_3_with_json_are_normal_results() {
        for code in [0, 1, 2, 3] {
            let result = interpret(
                &Op::Plan,
                Path::new("x"),
                captured(Some(code), &report_json("")),
            );
            assert_eq!(result.outcome, ScriptOutcome::Ran, "{code}");
            assert_eq!(result.exit_code, Some(code));
            assert!(result.report.is_some() && result.raw.is_some());
            assert_eq!(result.restore_advised, code == 3, "{code}");
        }
    }

    #[test]
    fn exit_3_advises_a_restore_and_keeps_rolled_back() {
        let json = "{\"contract\":1,\"command\":\"install\",\"ok\":false,\"exitCode\":3,\"rolledBack\":false,\"error\":{\"code\":\"writeFailed\",\"detail\":\"x\"}}";
        let result = interpret(&Op::Install, Path::new("x"), captured(Some(3), json));
        assert!(result.restore_advised);
        assert_eq!(result.report.unwrap().rolled_back, Some(false));
    }

    #[test]
    fn a_missing_exit_code_or_a_timeout_is_still_a_result() {
        let killed = interpret(&Op::Plan, Path::new("x"), captured(None, &report_json("")));
        assert_eq!(killed.outcome, ScriptOutcome::Ran);
        assert_eq!(killed.exit_code, None);
        let timed = interpret(
            &Op::Install,
            Path::new("x"),
            Captured {
                code: None,
                stdout: report_json(""),
                stderr: String::new(),
                timed_out: true,
            },
        );
        assert_eq!(timed.outcome, ScriptOutcome::TimedOut);
        assert!(timed.restore_advised, "설치가 중간에 끊겼을 수 있다");
        assert!(timed.report.is_none());
        let timed_plan = interpret(
            &Op::Plan,
            Path::new("x"),
            Captured {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                timed_out: true,
            },
        );
        assert!(
            !timed_plan.restore_advised,
            "미리보기는 아무것도 쓰지 않는다"
        );
    }

    #[test]
    fn garbage_output_becomes_unreadable_with_the_exit_code() {
        let result = interpret(
            &Op::Plan,
            Path::new("x"),
            captured(Some(7), "Segmentation fault"),
        );
        assert_eq!(result.outcome, ScriptOutcome::Unreadable);
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(result.unreadable.unwrap().head, "Segmentation fault");
        assert!(!result.restore_advised);
    }

    #[test]
    fn an_unreadable_result_of_a_writing_command_advises_a_restore_but_a_reading_one_does_not() {
        let id = "2026-10-18_143205".to_string();
        let other_command = "{\"contract\":1,\"command\":\"backups\",\"ok\":true,\"exitCode\":0}";
        // 쓰는 일(설치 · 되돌리기)이 읽을 수 없는 결과로 끝났다 = 어디까지 썼는지 모른다
        for op in [Op::Install, Op::Restore(id.clone())] {
            for (code, stdout) in [
                (Some(0), "Segmentation fault"),
                (Some(1), ""),
                (Some(5), "{\"contract\":1,\"command\":"),
                (None, "no json at all"),
                (Some(0), "{\"contract\":2,\"command\":\"install\"}"),
                (Some(0), other_command),
            ] {
                let result = interpret(&op, Path::new("x"), captured(code, stdout));
                assert_eq!(result.outcome, ScriptOutcome::Unreadable, "{op:?} {stdout}");
                assert!(result.restore_advised, "{op:?} {code:?} {stdout}");
            }
        }
        // 아무것도 쓰지 않는 일은 권하지 않는다
        for op in [Op::Plan, Op::Backups, Op::RestorePlan(id)] {
            let result = interpret(&op, Path::new("x"), captured(Some(5), "Segmentation fault"));
            assert_eq!(result.outcome, ScriptOutcome::Unreadable);
            assert!(!result.restore_advised, "{op:?}");
        }
    }

    fn backup_result(
        code: i32,
        ok: bool,
        dry_run: bool,
        id: Option<&str>,
        command: &str,
    ) -> ScriptResult {
        let backup = id.map_or("null".to_string(), |id| {
            format!("{{\"id\":\"{id}\",\"dir\":\"d\",\"files\":3}}")
        });
        let json = format!(
            "{{\"contract\":1,\"command\":\"{command}\",\"ok\":{ok},\"exitCode\":{code},\"dryRun\":{dry_run},\"backup\":{backup}}}"
        );
        interpret(&Op::Install, Path::new("x"), captured(Some(code), &json))
    }

    #[test]
    fn pruning_only_follows_a_successful_install_that_made_a_backup() {
        let id = "2026-10-18_143205";
        assert_eq!(
            made_a_backup(&backup_result(0, true, false, Some(id), "install")),
            Some(id)
        );
        // 미리보기 · 실패 · 백업 없음 · 다른 명령 · 번호가 이상함은 정리하지 않는다
        assert_eq!(
            made_a_backup(&backup_result(0, true, true, Some(id), "install")),
            None
        );
        assert_eq!(
            made_a_backup(&backup_result(3, false, false, Some(id), "install")),
            None
        );
        assert_eq!(
            made_a_backup(&backup_result(0, false, false, Some(id), "install")),
            None
        );
        assert_eq!(
            made_a_backup(&backup_result(2, true, false, Some(id), "install")),
            None
        );
        assert_eq!(
            made_a_backup(&backup_result(0, true, false, None, "install")),
            None
        );
        assert_eq!(
            made_a_backup(&backup_result(0, true, false, Some(id), "restore")),
            None
        );
        assert_eq!(
            made_a_backup(&backup_result(0, true, false, Some("../../etc"), "install")),
            None
        );
    }

    #[test]
    fn problems_or_an_error_in_the_report_block_pruning_even_when_ok_is_true() {
        let id = "2026-10-18_143205";
        let json = format!(
            "{{\"contract\":1,\"command\":\"install\",\"ok\":true,\"exitCode\":0,\"dryRun\":false,\"backup\":{{\"id\":\"{id}\"}},\"problems\":[{{\"reason\":\"badPath\"}}]}}"
        );
        let result = interpret(&Op::Install, Path::new("x"), captured(Some(0), &json));
        assert_eq!(made_a_backup(&result), None);
    }
}
