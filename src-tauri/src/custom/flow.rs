//! 한 번에 하나 — 내 수정을 **쓰는** 일(저장 · 지움 · 새로 만들기 · 버리기 · 적용 · 되돌리기 · 원본 바뀜 · 고양이)은 모두 하네스 잠금(`HarnessState::begin`)을 잡고 한다
//! (받기 · 업데이트 · 설치와 겹치지 않게 — 잠겨 있으면 `harness_busy`). Tauri 명령(`commands`)이 부르는 일반 함수다 — 시험은 이 함수들로 한다.
//!
//! 읽기(목록 · 항목 읽기 · 적용 안 한 것의 차이 · 기록 목록 · 커밋 차이 · 고양이 읽기)는 잠그지 않는다 (`items` · `history` · `cats` 를 바로 부른다).
//! 모든 함수는 맨 앞에서 잠금을 잡는다.

use crate::error::AppError;
use crate::harness::{Context, HarnessState};

use super::Env;
use super::apply;
use super::cats;
use super::model::{ApplyResult, CatsWriteResult, DiscardResult, RestoreResult, WriteResult};
use super::values::Values;
use super::write::{self, NewItem};

/// 값 바꾸기 (`None` = 원본 값으로)
pub fn save_values(
    state: &HarnessState,
    ctx: &Context,
    id: &str,
    wanted: &Values,
) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::save_values(&Env::new(ctx), id, wanted)
}

/// 덧붙임 글 저장 (빈 글 = 지움)
pub fn save_append(
    state: &HarnessState,
    ctx: &Context,
    id: &str,
    text: &str,
) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::save_append(&Env::new(ctx), id, text)
}

/// 통째 시작
pub fn replace_start(
    state: &HarnessState,
    ctx: &Context,
    id: &str,
) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::replace_start(&Env::new(ctx), id)
}

/// 통째 글 · 내가 만든 것의 글 저장
pub fn save_text(
    state: &HarnessState,
    ctx: &Context,
    id: &str,
    text: &str,
) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::save_text(&Env::new(ctx), id, text)
}

/// 통째 그만 (= 원본으로)
pub fn replace_stop(
    state: &HarnessState,
    ctx: &Context,
    id: &str,
) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::replace_stop(&Env::new(ctx), id)
}

/// 원본 바뀜 — 내 것 유지
pub fn origin_keep(state: &HarnessState, ctx: &Context, id: &str) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::origin_keep(&Env::new(ctx), id)
}

/// 새 에이전트 · 스킬 만들기
pub fn create(
    state: &HarnessState,
    ctx: &Context,
    request: &NewItem,
) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::create(&Env::new(ctx), request)
}

/// 내가 만든 것 지우기
pub fn delete_mine(state: &HarnessState, ctx: &Context, id: &str) -> Result<WriteResult, AppError> {
    let _guard = state.begin()?;
    write::delete_mine(&Env::new(ctx), id)
}

/// 적용 안 한 것 버리기
pub fn discard(state: &HarnessState, ctx: &Context) -> Result<DiscardResult, AppError> {
    let _guard = state.begin()?;
    apply::discard(&Env::new(ctx))
}

/// 적용 (설치 + 성공하면 커밋)
pub fn apply(
    state: &HarnessState,
    ctx: &Context,
    summary: Option<&str>,
) -> Result<ApplyResult, AppError> {
    let guard = state.begin()?;
    apply::apply(&Env::new(ctx), &guard, summary)
}

/// 어느 때로 되돌리기
pub fn restore_to(
    state: &HarnessState,
    ctx: &Context,
    hash: &str,
) -> Result<RestoreResult, AppError> {
    let guard = state.begin()?;
    apply::restore_to(&Env::new(ctx), &guard, hash)
}

/// 고양이 연결 쓰기 (`None` = 지움) — 그 파일만 바로 커밋
pub fn cats_write(
    state: &HarnessState,
    ctx: &Context,
    agent: &str,
    cat: Option<&str>,
) -> Result<CatsWriteResult, AppError> {
    let _guard = state.begin()?;
    cats::write(&Env::new(ctx), agent, cat)
}
