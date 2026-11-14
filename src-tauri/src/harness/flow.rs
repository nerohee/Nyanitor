//! 한 번에 하나 + 본 것만 한다 — Tauri 명령이 부르는 하네스 일의 순서를 Rust 에서 지킨다.
//!
//! 화면이 "미리보기를 본 뒤에만 설치" 를 지켜도 화면은 믿지 않는다. 앱이 기억해 둔 것(`HarnessState`)으로 다시 막는다:
//! - 업데이트 받기는 **확인 때 본 커밋까지만**, 그 확인이 없으면 `refused` + `check_first` (다시 fetch 하지 않는다).
//! - 설치는 **미리보기를 돌린 그 원본(스크립트)으로만**, 되돌리기는 **같은 번호의 되돌리기 미리보기 뒤에만** — 아니면
//!   오류가 아니라 결과로 `refused` + `plan_first` · `source_changed`.
//! - 받기 · 업데이트 받기 · 설치 · 되돌리기 뒤에는 본 것이 낡았으니 기억을 지운다.
//!
//! 모든 함수는 맨 앞에서 잠금(`HarnessState::begin` · `begin_task`)을 잡는다 — 다른 하네스 일이 도는 중이면 `harness_busy`.
//! 받기 · 업데이트 확인 · 업데이트 받기는 `Fetch`, 설치 · 되돌리기는 `Install` 로 밝힌다 — 앱을 끄려 할 때 물어야 하는 일이다 (`attention::quit_needs_warning`).
//! 미리보기 · 백업 목록은 읽기뿐이라 `Light` (`begin`).
//! 잠금 · 기억을 시험하려고 명령 함수에서 따로 뺀 일반 함수다 (명령은 이 함수를 부르기만 한다).

use std::path::PathBuf;

use super::git::{self, CheckedUpdate, GitOutcome, GitResult};
use super::locate::same_path;
use super::script::{self, ScriptOutcome, ScriptResult};
use super::{Context, HarnessState, HarnessTask};
use crate::error::AppError;

/// 원본 받기. 새로 받았을 때만 본 것을 지운다 (이미 있거나 쓸 수 없어 아무것도 안 했으면 그대로).
pub fn clone_origin(state: &HarnessState, ctx: &Context) -> Result<GitResult, AppError> {
    let guard = state.begin_task(HarnessTask::Fetch)?;
    let result = git::clone_origin(ctx);
    if result.outcome == GitOutcome::Cloned {
        guard.forget_all();
    }
    Ok(result)
}

/// 업데이트 확인. 본 커밋을 기억한다 (확인이 끝나지 못했으면 기억을 지운다).
pub fn update_check(state: &HarnessState, ctx: &Context) -> Result<GitResult, AppError> {
    let guard = state.begin_task(HarnessTask::Fetch)?;
    let result = git::update_check(ctx);
    guard.remember_check(CheckedUpdate::from_result(&result));
    Ok(result)
}

/// 업데이트 받기. 기억한 확인을 꺼내 (한 번 쓰면 없어진다) 그 커밋까지만 받는다.
pub fn update_pull(state: &HarnessState, ctx: &Context) -> Result<GitResult, AppError> {
    let guard = state.begin_task(HarnessTask::Fetch)?;
    let checked = guard.take_check();
    let result = git::update_pull(ctx, checked.as_ref());
    // 받기에 성공해 원본이 바뀌었고 내 수정 기록이 시작돼 있으면 "원본 업데이트 받음" 빈 커밋 하나 (P9-01 — 실패해도 업데이트 결과는 그대로, 로그만)
    if result.outcome == GitOutcome::Updated
        && let Some(head) = result.head.as_deref()
    {
        crate::custom::history::record_origin_update(ctx, head);
    }
    // 받았거나 받다가 실패했으면 원본이 달라졌을 수 있다 — 미리보기를 다시 보게 한다
    if matches!(
        result.outcome,
        GitOutcome::Updated | GitOutcome::Failed | GitOutcome::TimedOut
    ) {
        guard.forget_all();
    }
    Ok(result)
}

/// 미리보기를 돌린 스크립트 (읽은 결과가 있을 때만 — 읽을 수 없는 미리보기는 본 것이 아니다)
fn planned_script(result: &ScriptResult) -> Option<PathBuf> {
    (result.outcome == ScriptOutcome::Ran && result.report.is_some())
        .then(|| result.script.as_ref().map(PathBuf::from))
        .flatten()
}

/// 설치 미리보기. 돌린 원본(스크립트 경로)을 기억한다.
pub fn install_plan(state: &HarnessState, ctx: &Context) -> Result<ScriptResult, AppError> {
    let guard = state.begin()?;
    let result = script::plan(ctx);
    guard.remember_install_plan(planned_script(&result));
    Ok(result)
}

/// 기억한 미리보기의 원본이 지금 돌릴 원본과 같은가. 같으면 그 스크립트를, 아니면 거절 결과를 돌려준다.
fn same_source(ctx: &Context, planned: Option<PathBuf>) -> Result<PathBuf, Box<ScriptResult>> {
    let Some(planned) = planned else {
        return Err(Box::new(ScriptResult::refused("plan_first")));
    };
    match script::current_script(ctx) {
        Some(current) if same_path(&planned, &current) => Ok(current),
        _ => Err(Box::new(ScriptResult::refused("source_changed"))),
    }
}

/// 설치. 미리보기를 돌린 그 원본일 때만 돈다. 끝나면 기억을 지운다.
pub fn install(state: &HarnessState, ctx: &Context) -> Result<ScriptResult, AppError> {
    let guard = state.begin_task(HarnessTask::Install)?;
    let script = match same_source(ctx, guard.install_plan()) {
        Ok(script) => script,
        Err(refused) => return Ok(*refused),
    };
    let result = script::install_at(ctx, &script);
    guard.forget_all();
    Ok(result)
}

/// 백업 목록 (읽기만 한다 — 기억은 그대로)
pub fn backups_list(state: &HarnessState, ctx: &Context) -> Result<ScriptResult, AppError> {
    let _guard = state.begin()?;
    Ok(script::backups_list(ctx))
}

/// 되돌리기 미리보기. 번호와 돌린 원본을 기억한다 (새 미리보기가 앞의 것을 대신한다).
pub fn restore_plan(
    state: &HarnessState,
    ctx: &Context,
    backup_id: &str,
) -> Result<ScriptResult, AppError> {
    let guard = state.begin()?;
    guard.remember_restore_plan(None);
    let result = script::restore_plan(ctx, backup_id)?;
    guard.remember_restore_plan(planned_script(&result).map(|path| (backup_id.to_string(), path)));
    Ok(result)
}

/// 되돌리기. 같은 번호의 되돌리기 미리보기를 본 그 원본일 때만 돈다. 끝나면 기억을 지운다.
pub fn restore(
    state: &HarnessState,
    ctx: &Context,
    backup_id: &str,
) -> Result<ScriptResult, AppError> {
    let guard = state.begin_task(HarnessTask::Install)?;
    script::check_backup_id_shape(backup_id)?;
    let planned = guard
        .restore_plan()
        .filter(|(id, _)| id == backup_id)
        .map(|(_, path)| path);
    let script = match same_source(ctx, planned) {
        Ok(script) => script,
        Err(refused) => return Ok(*refused),
    };
    let result = script::restore_at(ctx, backup_id, &script);
    guard.forget_all();
    result
}
