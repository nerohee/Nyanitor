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
    /// 다른 하네스 작업(받기 · 업데이트 · 설치 · 되돌리기)이 진행 중이다 (한 번에 하나).
    #[error("another harness task is in progress")]
    HarnessBusy,
    /// 앱 DB 를 쓸 수 없다 (열지 못했거나 읽고 쓰다 실패했다). 앱은 뜨지만 프로젝트 명령은 이 오류를 돌려준다.
    #[error("app database is unavailable: {0}")]
    DbUnavailable(String),
    /// 앱 DB 가 이 앱보다 새 버전이라 읽기만 한다 (쓰기는 거절).
    #[error("app database is newer than this app; it is read-only")]
    DbReadOnly,
    /// 등록된 프로젝트가 아니다 (이미 뺐거나 없는 번호).
    #[error("project not found: {0}")]
    ProjectNotFound(i64),
    /// 고른 폴더가 없는데 등록하려 했다 (폴더를 먼저 골라야 한다).
    #[error("no folder has been picked")]
    NoFolderPicked,
    /// 폴더 고르기 대화상자가 이미 떠 있다.
    #[error("a folder dialog is already open")]
    FolderDialogOpen,
    /// 등록된 프로젝트인데 폴더가 지금 없다 (옮겼거나 지웠거나 드라이브가 빠졌다). 세션을 시작하지 않는다.
    #[error("the project folder does not exist now: project {0}")]
    ProjectFolderMissing(i64),
    /// 등록된 프로젝트인데 폴더가 이제 고를 수 없는 폴더다 (설정이 바뀐 뒤). 세션을 시작하지 않는다.
    #[error("the project folder cannot be used as a project now: project {0}")]
    ProjectFolderForbidden(i64),
    /// 이 프로젝트 폴더의 Claude Code 설정(훅 · 허용 규칙 · MCP 등)을 사용자가 아직 확인하지 않았다 (D-54). 세션을 시작하지 않는다 — 화면은 `project_trust_check` 로 요약을 받아 보여 준다.
    #[error("the project folder settings need to be trusted first: project {0}")]
    TrustRequired(i64),
    /// 화면이 본 폴더 설정과 지금 폴더 설정이 다르다 (보고 있는 사이 바뀌었다). 신뢰로 적지 않는다 — 다시 `project_trust_check` 로 읽어 보여 준다.
    #[error("the project folder settings changed since they were shown: project {0}")]
    TrustChanged(i64),
    /// 파일을 쓰지 못했다 (디스크 · 권한 · 다른 프로그램이 쥐고 있음). 옛 파일은 그대로 남는다.
    #[error("could not write the file: {0}")]
    FileWriteFailed(String),
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
            AppError::HarnessBusy => "harness_busy",
            AppError::DbUnavailable(_) => "db_unavailable",
            AppError::DbReadOnly => "db_read_only",
            AppError::ProjectNotFound(_) => "project_not_found",
            AppError::NoFolderPicked => "no_folder_picked",
            AppError::FolderDialogOpen => "folder_dialog_open",
            AppError::ProjectFolderMissing(_) => "project_folder_missing",
            AppError::ProjectFolderForbidden(_) => "project_folder_forbidden",
            AppError::TrustRequired(_) => "trust_required",
            AppError::TrustChanged(_) => "trust_changed",
            AppError::FileWriteFailed(_) => "file_write_failed",
        }
    }
}

/// SQLite 오류는 "DB 를 쓸 수 없다" 로 알린다 (`?` 로 바로 올릴 수 있게). 메시지에는 SQLite 의 오류 글만 들어간다 (경로 없음).
impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::DbUnavailable(err.to_string())
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
    fn the_trust_errors_serialize_with_only_a_kind_and_a_message() {
        let value = serde_json::to_value(AppError::TrustRequired(7)).unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "kind": "trust_required",
                "message": "the project folder settings need to be trusted first: project 7"
            })
        );
        let value = serde_json::to_value(AppError::TrustChanged(7)).unwrap();
        assert_eq!(value["kind"], "trust_changed");
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
        assert_eq!(AppError::HarnessBusy.kind(), "harness_busy");
        assert_eq!(
            AppError::DbUnavailable(String::new()).kind(),
            "db_unavailable"
        );
        assert_eq!(AppError::DbReadOnly.kind(), "db_read_only");
        assert_eq!(AppError::ProjectNotFound(1).kind(), "project_not_found");
        assert_eq!(AppError::NoFolderPicked.kind(), "no_folder_picked");
        assert_eq!(AppError::FolderDialogOpen.kind(), "folder_dialog_open");
        assert_eq!(
            AppError::ProjectFolderMissing(1).kind(),
            "project_folder_missing"
        );
        assert_eq!(
            AppError::ProjectFolderForbidden(1).kind(),
            "project_folder_forbidden"
        );
        assert_eq!(AppError::TrustRequired(1).kind(), "trust_required");
        assert_eq!(AppError::TrustChanged(1).kind(), "trust_changed");
        assert_eq!(
            AppError::FileWriteFailed(String::new()).kind(),
            "file_write_failed"
        );
    }
}
