//! 적용 · 어느 때로 되돌리기 · 적용 안 한 것 버리기 (D-51). 모두 하네스 잠금 안에서 부른다 (`flow`).
//!
//! - **적용** — 적용 안 한 것이 있을 때만: ① 설치 (`install --json`, 기존 `script` 경로 그대로) ② 성공(`ok`)이면 `git add -A` + 커밋
//!   (메시지는 화면이 준 한 줄, 없으면 기본 문구) ③ 실패(`problems` · `error` · 실행 실패)면 커밋하지 않고 결과(`ScriptResult` 그대로)를 돌려준다 —
//!   적용 안 한 것으로 남는다. ④ 설치를 돌렸으면 하네스 기억(설치 미리보기 등)을 지운다 (`flow` 와 같게).
//! - **어느 때로 되돌리기** — 적용 안 한 것이 있으면 거절(`has_unapplied`). 아니면 작업 트리를 그 커밋의 모습으로 → 같은 설치 → 성공하면 새 커밋
//!   (`<짧은 번호> 때로 되돌림`, 종류 `restore`). 설치가 실패하면 작업 트리를 처음(HEAD) 모습으로 되돌려 놓고 결과를 돌려준다. 이력은 지우지 않는다 (`reset` 으로 HEAD 를 옮기지 않는다).
//! - git 이 없으면 저장 · 적용은 되고 (적용은 설치만) 기록 관련은 `no_git` — 오류가 아니다.

use tauri_plugin_log::log;

use crate::error::AppError;
use crate::harness::BusyGuard;
use crate::harness::script::{self, ScriptOutcome, ScriptResult};
use crate::strings;

use super::Env;
use super::history::{self, Access, Repo, clean_message, describe, valid_commit_ref};
use super::model::{
    ApplyOutcome, ApplyResult, CommitKind, CommitOutcome, DiscardOutcome, DiscardResult,
    RestoreOutcome, RestoreResult,
};

/// 설치가 성공했는가 — 끝까지 돌았고(종료 코드 0) `ok` 이며 문제 · 오류가 없다 (미리보기가 아니다)
pub fn install_succeeded(result: &ScriptResult) -> bool {
    let Some(report) = result.report.as_ref() else {
        return false;
    };
    result.outcome == ScriptOutcome::Ran
        && result.exit_code == Some(0)
        && report.ok
        && !report.dry_run
        && report.command == "install"
        && report.error.is_none()
        && report.problems.is_empty()
}

fn internal(error: &crate::harness::git::GitError) -> AppError {
    AppError::Internal(format!("custom history: {}", describe(error)))
}

/// 커밋을 만들고 결과를 요약한다 (실패는 오류로 올리지 않는다 — 설치는 이미 됐다)
fn commit_all(
    repo: &Repo,
    subject: &str,
    kind: CommitKind,
) -> (CommitOutcome, Option<String>, Option<String>) {
    let made = repo
        .stage_all()
        .and_then(|()| repo.commit(subject, kind, true, None));
    match made {
        Ok(short) => (CommitOutcome::Committed, Some(short), None),
        Err(error) => {
            log::warn!(
                "custom: the install worked but the commit failed: {}",
                describe(&error)
            );
            (CommitOutcome::Failed, None, Some(describe(&error)))
        }
    }
}

/// 적용 — 적용 안 한 것이 있을 때만 설치하고, 성공하면 커밋한다. `summary` 는 화면이 준 한 줄 요약 (없으면 기본 문구).
pub fn apply(env: &Env, guard: &BusyGuard, summary: Option<&str>) -> Result<ApplyResult, AppError> {
    let access = history::access(env);
    let files = match &access {
        Access::Ready(repo) => {
            let unapplied = repo.unapplied().map_err(|e| internal(&e))?;
            if unapplied.count == 0 {
                return Ok(nothing());
            }
            unapplied.count
        }
        // 기록이 아직 없다 = 저장한 것이 없다
        Access::NotStarted => return Ok(nothing()),
        // git 이 없으면 적용 안 한 것을 알 수 없다 — 설치만 한다
        Access::NoGit => 0,
        Access::Failed(detail) => {
            return Err(AppError::Internal(format!(
                "custom history is unusable: {detail}"
            )));
        }
    };
    let result = script::install(env.ctx);
    // 설치를 돌렸으니 본 것(설치 미리보기 등)은 낡았다
    guard.forget_all();
    if !install_succeeded(&result) {
        return Ok(ApplyResult {
            outcome: ApplyOutcome::Failed,
            script: Some(result),
            commit: CommitOutcome::Skipped,
            commit_short: None,
            files,
            detail: None,
        });
    }
    let (commit, commit_short, detail) = match &access {
        Access::Ready(repo) => {
            let in_source = |path: &str| env.source.join(path).is_file();
            // 새 에이전트 · 스킬이 든 적용은 `new`
            let kind = match repo.adds_new_item(&in_source) {
                Ok(true) => CommitKind::New,
                _ => CommitKind::Apply,
            };
            let subject = summary
                .and_then(clean_message)
                .unwrap_or_else(|| strings::custom_commit_apply(files as usize));
            commit_all(repo, &subject, kind)
        }
        _ => (CommitOutcome::NoGit, None, None),
    };
    Ok(ApplyResult {
        outcome: ApplyOutcome::Applied,
        script: Some(result),
        commit,
        commit_short,
        files,
        detail,
    })
}

fn nothing() -> ApplyResult {
    ApplyResult {
        outcome: ApplyOutcome::Nothing,
        script: None,
        commit: CommitOutcome::Skipped,
        commit_short: None,
        files: 0,
        detail: None,
    }
}

/// 어느 때로 되돌리기 — 위 설명 그대로. `hash` 는 기록 목록의 번호 (7~40글자 16진수, 모양이 틀리면 `invalid_input`).
pub fn restore_to(env: &Env, guard: &BusyGuard, hash: &str) -> Result<RestoreResult, AppError> {
    if !valid_commit_ref(hash) {
        return Err(AppError::InvalidInput(
            "commit id has the wrong shape".into(),
        ));
    }
    let bare = |outcome: RestoreOutcome| RestoreResult {
        outcome,
        script: None,
        commit: CommitOutcome::Skipped,
        commit_short: None,
        detail: None,
    };
    let repo = match history::access(env) {
        Access::Ready(repo) => repo,
        Access::NoGit => return Ok(bare(RestoreOutcome::NoGit)),
        Access::NotStarted => return Ok(bare(RestoreOutcome::NotStarted)),
        Access::Failed(detail) => {
            return Err(AppError::Internal(format!(
                "custom history is unusable: {detail}"
            )));
        }
    };
    let Some(full) = repo.resolve(hash).map_err(|e| internal(&e))? else {
        return Ok(bare(RestoreOutcome::UnknownCommit));
    };
    if repo.unapplied().map_err(|e| internal(&e))?.count > 0 {
        return Ok(bare(RestoreOutcome::HasUnapplied));
    }
    if repo.same_as_head(&full).map_err(|e| internal(&e))? {
        return Ok(bare(RestoreOutcome::SameAsNow));
    }
    if let Err(error) = repo.checkout_tree(&full) {
        // 반쯤 바뀐 채 두지 않는다
        let _ = repo.reset_to_head();
        return Err(internal(&error));
    }
    let result = script::install(env.ctx);
    guard.forget_all();
    if !install_succeeded(&result) {
        return Ok(match repo.reset_to_head() {
            Ok(()) => RestoreResult {
                script: Some(result),
                ..bare(RestoreOutcome::Failed)
            },
            Err(error) => RestoreResult {
                script: Some(result),
                detail: Some(describe(&error)),
                ..bare(RestoreOutcome::RollbackFailed)
            },
        });
    }
    let subject = strings::custom_commit_restore(&repo.short_of(&full));
    let (commit, commit_short, detail) = commit_all(&repo, &subject, CommitKind::Restore);
    Ok(RestoreResult {
        outcome: RestoreOutcome::Restored,
        script: Some(result),
        commit,
        commit_short,
        detail,
    })
}

/// 적용 안 한 것 버리기 — 작업 트리를 HEAD 로 (새 파일 지움 포함, `.git` 은 그대로)
pub fn discard(env: &Env) -> Result<DiscardResult, AppError> {
    let result = |outcome, files| DiscardResult { outcome, files };
    match history::access(env) {
        Access::NoGit => Ok(result(DiscardOutcome::NoGit, 0)),
        Access::NotStarted => Ok(result(DiscardOutcome::NotStarted, 0)),
        Access::Failed(detail) => Err(AppError::Internal(format!(
            "custom history is unusable: {detail}"
        ))),
        Access::Ready(repo) => {
            let files = repo.discard().map_err(|e| internal(&e))?;
            Ok(result(
                if files == 0 {
                    DiscardOutcome::Nothing
                } else {
                    DiscardOutcome::Discarded
                },
                files,
            ))
        }
    }
}
