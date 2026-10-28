//! 사용량의 Tauri 명령 — 얇게: 블로킹 풀에서 기억 · 한 번에 하나 규칙(`UsageState`)을 거쳐 `fetch::read_here` 를 부를 뿐이다.
//!
//! 화면이 넘기는 값은 없다 (실행 파일 · 인자 · 경로를 받는 길이 없다). 못 받아도 오류가 아니라 `unavailable` 과 이유를 돌려준다.

use tauri::State;

use super::{UsageResult, UsageState, fetch};
use crate::claude::commands::blocking;
use crate::error::AppError;

#[tauri::command]
pub async fn usage_read(state: State<'_, UsageState>) -> Result<UsageResult, AppError> {
    let state = state.inner().clone();
    blocking(move || Ok(state.read(fetch::read_here))).await
}
