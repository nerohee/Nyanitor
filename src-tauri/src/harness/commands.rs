//! 하네스의 Tauri 명령 — 얇게: 위치를 정하고 블로킹 풀에서 `flow` 의 일반 함수를 부를 뿐이다
//! (한 번에 하나 잠금 · 본 것만 한다 규칙은 모두 `flow` 에 있다).
//!
//! 화면이 넘기는 값은 백업 번호 하나뿐이다 (그것도 `script` 가 모양과 목록을 다시 확인한다). 실행 파일 · 인자 · 경로 · URL 을
//! 받는 명령은 없고, 받는 주소는 `HARNESS_REPO_URL` 상수다. 무거운 일은 모두 `async` + 블로킹 풀에서 돈다 — 화면 스레드를 막지 않는다.

use tauri::State;

use super::git::GitResult;
use super::script::ScriptResult;
use super::status::{self, HarnessStatus};
use super::{Context, HarnessState, flow};
use crate::claude::commands::blocking;
use crate::error::AppError;

/// 위치를 정하지 못했으면 (상대 경로 환경 변수 · 홈 없음) 작업을 하지 않는다.
fn context() -> Result<Context, AppError> {
    Context::here().map_err(|error| {
        AppError::InvalidInput(format!("harness location is unusable: {}", error.code()))
    })
}

/// 위치를 정해 `work`(`flow` 의 함수 하나)를 블로킹 풀에서 돌린다. 잠금은 `flow` 가 잡는다.
async fn run<T, F>(state: State<'_, HarnessState>, work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&HarnessState, &Context) -> Result<T, AppError> + Send + 'static,
{
    let state = state.inner().clone();
    blocking(move || work(&state, &context()?))
        .await
        .map_err(AppError::logged)
}

/// 상태 — 위치 · 원본 · 개발자 모드 · git · Git Bash. 읽기만 하므로 잠그지 않는다.
#[tauri::command]
pub async fn harness_status() -> Result<HarnessStatus, AppError> {
    blocking(|| Ok(status::status_here())).await
}

/// 원본 받기 (`git clone`, `repo` 가 없을 때만)
#[tauri::command]
pub async fn harness_clone(state: State<'_, HarnessState>) -> Result<GitResult, AppError> {
    run(state, flow::clone_origin).await
}

/// 업데이트 확인 (`git fetch` → 받을 커밋 · 바뀔 파일 미리보기). 본 커밋을 앱이 기억한다.
#[tauri::command]
pub async fn harness_update_check(state: State<'_, HarnessState>) -> Result<GitResult, AppError> {
    run(state, flow::update_check).await
}

/// 업데이트 받기 (확인 때 본 커밋까지만 빨리 감기로 — 확인이 없으면 거절)
#[tauri::command]
pub async fn harness_update_pull(state: State<'_, HarnessState>) -> Result<GitResult, AppError> {
    run(state, flow::update_pull).await
}

/// 설치 미리보기 (`--plan --json`) — 아무것도 쓰지 않는다. 돌린 원본을 앱이 기억한다.
#[tauri::command]
pub async fn harness_install_plan(
    state: State<'_, HarnessState>,
) -> Result<ScriptResult, AppError> {
    run(state, flow::install_plan).await
}

/// 설치 (`--json`) — 미리보기를 돌린 그 원본일 때만. 성공하고 백업을 만들었으면 오래된 백업을 정리한다.
#[tauri::command]
pub async fn harness_install(state: State<'_, HarnessState>) -> Result<ScriptResult, AppError> {
    run(state, flow::install).await
}

/// 백업 목록 (`--backups --json`)
#[tauri::command]
pub async fn harness_backups(state: State<'_, HarnessState>) -> Result<ScriptResult, AppError> {
    run(state, flow::backups_list).await
}

/// 되돌리기 미리보기 (`--restore <번호> --plan --json`)
#[tauri::command]
pub async fn harness_restore_plan(
    state: State<'_, HarnessState>,
    backup_id: String,
) -> Result<ScriptResult, AppError> {
    run(state, move |state, ctx| {
        flow::restore_plan(state, ctx, &backup_id)
    })
    .await
}

/// 되돌리기 (`--restore <번호> --json`) — 같은 번호의 되돌리기 미리보기를 본 뒤에만
#[tauri::command]
pub async fn harness_restore(
    state: State<'_, HarnessState>,
    backup_id: String,
) -> Result<ScriptResult, AppError> {
    run(state, move |state, ctx| {
        flow::restore(state, ctx, &backup_id)
    })
    .await
}
