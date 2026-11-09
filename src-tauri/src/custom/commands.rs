//! 내 수정의 Tauri 명령 — 얇게: 위치를 정하고 블로킹 풀에서 일반 함수(`items` · `history` · `cats` · `flow`)를 부를 뿐이다.
//! 쓰는 명령은 모두 `flow` 를 거친다 (한 번에 하나 잠금은 `flow` 에 있다). 읽는 명령은 잠그지 않는다.
//!
//! **화면이 넘기는 값은 항목 id · 값 · 글 · 새 항목 요청(종류 · 이름 · 소개 · 모델 · 수준) · 커밋 번호 · 에이전트 이름 · 고양이 id 뿐이다.**
//! 경로 · 파일 이름 · 실행 파일 · 인자를 받는 명령은 없다 — 모두 Rust 에서 모양을 다시 확인한다 (`ItemId::parse` · 이름 · 고양이 id · 커밋 번호 모양 · 값 목록).
//! 무거운 일(git · 설치)은 모두 `async` + 블로킹 풀에서 돈다 — 화면 스레드를 막지 않는다.

use tauri::State;

use super::Env;
use super::cats;
use super::flow;
use super::history;
use super::items;
use super::model::{
    ApplyResult, CatsRead, CatsWriteResult, ChangesList, CommitDiff, CustomList, DiscardResult,
    HistoryList, ItemRead, RestoreResult, WriteResult,
};
use super::values::Values;
use super::write::NewItem;
use crate::claude::commands::blocking;
use crate::error::AppError;
use crate::harness::{Context, HarnessState};

/// 위치를 정하지 못했으면 (상대 경로 환경 변수 · 홈 없음) 일을 하지 않는다.
fn context() -> Result<Context, AppError> {
    Context::here().map_err(|error| {
        AppError::InvalidInput(format!("harness location is unusable: {}", error.code()))
    })
}

/// 잠그지 않는 읽기 — 위치를 정해 `work` 를 블로킹 풀에서 돌린다.
async fn read<T, F>(work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce(&Env) -> Result<T, AppError> + Send + 'static,
{
    blocking(move || {
        let ctx = context()?;
        work(&Env::new(&ctx))
    })
    .await
    .map_err(AppError::logged)
}

/// 쓰는 일 — 위치를 정해 `work`(`flow` 의 함수 하나)를 블로킹 풀에서 돌린다. 잠금은 `flow` 가 잡는다.
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

/// 목록 — 오케스트레이터 · 에이전트 · 스킬, 기록 상태, 적용 안 한 것 개수 · 파일 목록. 하네스가 없으면 `available: false`
#[tauri::command]
pub async fn custom_list() -> Result<CustomList, AppError> {
    read(|env| Ok(items::list(env))).await
}

/// 항목 하나 읽기 — 원본 글 · 덧붙임 글 · 통째 글 · 값
#[tauri::command]
pub async fn custom_item_read(item_id: String) -> Result<ItemRead, AppError> {
    read(move |env| items::read_item(env, &item_id)).await
}

/// 값 바꾸기 — 바라는 값 전체 (`null` = 원본 값으로)
#[tauri::command]
pub async fn custom_values_save(
    state: State<'_, HarnessState>,
    item_id: String,
    values: Values,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::save_values(state, ctx, &item_id, &values)
    })
    .await
}

/// 덧붙임 글 저장 (빈 글 = 지움)
#[tauri::command]
pub async fn custom_append_save(
    state: State<'_, HarnessState>,
    item_id: String,
    text: String,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::save_append(state, ctx, &item_id, &text)
    })
    .await
}

/// 통째 시작 — 지금 원본 글을 내 수정으로 복사하고 원본 해시를 남긴다
#[tauri::command]
pub async fn custom_replace_start(
    state: State<'_, HarnessState>,
    item_id: String,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::replace_start(state, ctx, &item_id)
    })
    .await
}

/// 통째 글 저장 — 통째로 바꾼 것 · 내가 만든 것의 글
#[tauri::command]
pub async fn custom_text_save(
    state: State<'_, HarnessState>,
    item_id: String,
    text: String,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::save_text(state, ctx, &item_id, &text)
    })
    .await
}

/// 통째 그만 (= 원본으로) — 통째 글과 원본 해시를 지운다. 값 · 덧붙임은 그대로
#[tauri::command]
pub async fn custom_replace_stop(
    state: State<'_, HarnessState>,
    item_id: String,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::replace_stop(state, ctx, &item_id)
    })
    .await
}

/// 원본 바뀜 — 내 것 유지 (원본 해시를 지금 것으로 다시 쓴다)
#[tauri::command]
pub async fn custom_origin_keep(
    state: State<'_, HarnessState>,
    item_id: String,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::origin_keep(state, ctx, &item_id)
    })
    .await
}

/// 새 에이전트 · 스킬 만들기
#[tauri::command]
pub async fn custom_new(
    state: State<'_, HarnessState>,
    request: NewItem,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| flow::create(state, ctx, &request)).await
}

/// 내가 만든 것 지우기 (스킬은 폴더째)
#[tauri::command]
pub async fn custom_mine_delete(
    state: State<'_, HarnessState>,
    item_id: String,
) -> Result<WriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::delete_mine(state, ctx, &item_id)
    })
    .await
}

/// 적용하면 바뀌는 것 — 적용 안 한 것의 줄 단위 차이
#[tauri::command]
pub async fn custom_changes() -> Result<ChangesList, AppError> {
    read(|env| Ok(history::changes(env))).await
}

/// 적용 안 한 것 버리기 (새 파일도 지운다)
#[tauri::command]
pub async fn custom_discard(state: State<'_, HarnessState>) -> Result<DiscardResult, AppError> {
    run(state, flow::discard).await
}

/// 적용 — 설치 + 성공하면 커밋. `summary` 는 한 줄 요약 (없으면 기본 문구)
#[tauri::command]
pub async fn custom_apply(
    state: State<'_, HarnessState>,
    summary: Option<String>,
) -> Result<ApplyResult, AppError> {
    run(state, move |state, ctx| {
        flow::apply(state, ctx, summary.as_deref())
    })
    .await
}

/// 기록 목록 (최근 커밋 · 종류 · 바뀐 파일)
#[tauri::command]
pub async fn custom_history() -> Result<HistoryList, AppError> {
    read(|env| Ok(history::list(env))).await
}

/// 커밋 하나의 차이
#[tauri::command]
pub async fn custom_commit_diff(commit: String) -> Result<CommitDiff, AppError> {
    read(move |env| history::commit_diff(env, &commit)).await
}

/// 어느 때로 되돌리기 — 적용 안 한 것이 있으면 거절, 그때 모습 + 설치 + 새 커밋
#[tauri::command]
pub async fn custom_restore(
    state: State<'_, HarnessState>,
    commit: String,
) -> Result<RestoreResult, AppError> {
    run(state, move |state, ctx| {
        flow::restore_to(state, ctx, &commit)
    })
    .await
}

/// 고양이 연결 읽기
#[tauri::command]
pub async fn custom_cats_read() -> Result<CatsRead, AppError> {
    read(|env| Ok(cats::read(env))).await
}

/// 한 에이전트의 고양이 쓰기 (`null` = 지움) — 그 파일만 바로 커밋
#[tauri::command]
pub async fn custom_cat_save(
    state: State<'_, HarnessState>,
    agent: String,
    cat: Option<String>,
) -> Result<CatsWriteResult, AppError> {
    run(state, move |state, ctx| {
        flow::cats_write(state, ctx, &agent, cat.as_deref())
    })
    .await
}
