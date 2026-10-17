use serde::{Serialize, Serializer, ser::SerializeStruct};
use tauri_plugin_log::log;
use thiserror::Error;

/// 명령이 화면에 돌려주는 오류. 화면에는 `{ kind, message }` 로 간다.
/// `kind` 는 화면이 문구를 고르는 열쇠(바꾸면 `src/lib/ipc.ts` 의 `AppErrorKind` 도 같이),
/// `message` 는 기록 · 진단용 영어 문장이라 사용자에게 그대로 보이지 않는다.
#[derive(Debug, Error)]
pub enum AppError {
    /// 받은 값이 규칙에 맞지 않는다.
    #[error("invalid input: {0}")]
    InvalidInput(String),
    /// 앱 안쪽 문제 (설정이 깨졌거나 예상 못 한 상태).
    #[error("internal error: {0}")]
    Internal(String),
    /// 이 PC 에서 `claude` 실행 파일을 찾지 못했다.
    #[error("claude executable not found")]
    ClaudeNotFound,
    /// 돌아가는 세션이 이미 있다 (한 번에 하나 — D-12).
    #[error("a session is already running")]
    SessionRunning,
    /// 돌아가는 세션이 없다.
    #[error("no session is running")]
    NoSession,
    /// 이어 할 세션 기록이 없다.
    #[error("no saved session for this project")]
    NoSavedSession,
    /// 그 요청 ID 를 기다리는 중이 아니다 (이미 답했거나 취소됐다).
    #[error("request not found: {0}")]
    RequestNotFound(String),
    /// 지금 턴이 도는 중이라 새 메시지를 보낼 수 없다.
    #[error("a turn is already in progress")]
    TurnInProgress,
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::InvalidInput(_) => "invalid_input",
            AppError::Internal(_) => "internal",
            AppError::ClaudeNotFound => "claude_not_found",
            AppError::SessionRunning => "session_running",
            AppError::NoSession => "no_session",
            AppError::NoSavedSession => "no_saved_session",
            AppError::RequestNotFound(_) => "request_not_found",
            AppError::TurnInProgress => "turn_in_progress",
        }
    }
}

impl AppError {
    /// 화면으로 돌려주기 전에 로그에 남기고 그대로 돌려준다 (`.map_err(AppError::logged)`).
    pub fn logged(self) -> Self {
        log::error!("[{}] {}", self.kind(), self);
        self
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("kind", self.kind())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_kind_and_message() {
        let value = serde_json::to_value(AppError::InvalidInput("name is empty".into())).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "kind": "invalid_input", "message": "invalid input: name is empty" })
        );
    }

    #[test]
    fn logged_returns_the_same_error() {
        let err = AppError::Internal("boom".into()).logged();
        assert_eq!(err.kind(), "internal");
        assert_eq!(err.to_string(), "internal error: boom");
    }

    #[test]
    fn each_variant_has_its_own_kind() {
        assert_eq!(
            AppError::InvalidInput(String::new()).kind(),
            "invalid_input"
        );
        assert_eq!(AppError::Internal(String::new()).kind(), "internal");
        assert_eq!(AppError::ClaudeNotFound.kind(), "claude_not_found");
        assert_eq!(AppError::SessionRunning.kind(), "session_running");
        assert_eq!(AppError::NoSession.kind(), "no_session");
        assert_eq!(AppError::NoSavedSession.kind(), "no_saved_session");
        assert_eq!(
            AppError::RequestNotFound(String::new()).kind(),
            "request_not_found"
        );
        assert_eq!(AppError::TurnInProgress.kind(), "turn_in_progress");
    }
}
