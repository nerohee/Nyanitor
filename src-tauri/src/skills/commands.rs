//! 스킬 목록의 Tauri 명령 — 얇게: 블로킹 풀에서 `skills::list_here` 를 부를 뿐이다.
//!
//! 화면이 넘기는 값은 없다 (경로 · 폴더 이름을 받는 길이 없다 — 위치는 환경 변수 `CLAUDE_CONFIG_DIR` 로만 바뀐다).
//! 읽을 수 없는 파일 · 하네스 없음은 오류가 아니라 결과의 상태다.

use super::{SkillsList, list_here};
use crate::claude::commands::blocking;
use crate::error::AppError;

#[tauri::command]
pub async fn skills_list() -> Result<SkillsList, AppError> {
    blocking(|| Ok(list_here())).await
}
