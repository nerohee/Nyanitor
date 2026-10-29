//! 채팅 기록 · 세션 츄르의 Tauri 명령 — 얇게: 입력 전달 · 블로킹 풀에서 `history` 의 일반 함수를 부를 뿐이다.
//!
//! 화면이 보내는 것은 프로젝트 번호와 쪽 나누기 값뿐이다 (경로 글자 없음 — D-47). 지금 살아 있는 세션 · 오늘의 자정은 Rust 가 안다.

use tauri::State;

use super::{ChatPage, UsageSummary, chat_history, usage_summary};
use crate::claude::commands::blocking;
use crate::claude::session::SessionManager;
use crate::db::AppDb;
use crate::error::AppError;

#[tauri::command]
pub async fn project_chat_history(
    db: State<'_, AppDb>,
    manager: State<'_, SessionManager>,
    id: i64,
    before: Option<i64>,
    limit: u32,
) -> Result<ChatPage, AppError> {
    let (db, manager) = (db.inner().clone(), manager.inner().clone());
    blocking(move || chat_history(&db, &manager, id, before, limit)).await
}

#[tauri::command]
pub async fn app_usage_summary(
    db: State<'_, AppDb>,
    manager: State<'_, SessionManager>,
) -> Result<UsageSummary, AppError> {
    let (db, manager) = (db.inner().clone(), manager.inner().clone());
    blocking(move || usage_summary(&db, &manager)).await
}
