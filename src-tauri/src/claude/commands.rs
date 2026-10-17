//! Claude 연결의 Tauri 명령 — 얇게: 입력 확인 · 전달만, 로직은 `discover` · `session` 의 일반 함수.
//!
//! 실행하는 것은 `discover::locate_here` 가 찾은 `claude` 하나뿐이고 인자는 `session::build_args` 가 만든다.
//! 화면에서 실행 파일 · 인자 · 환경 · 권한 규칙을 받는 명령은 없다.
//! 세션 관리자는 짧게 잠그는 일이 있으므로(시작할 때 버전 확인 동안 등) 모두 `async` + 블로킹 풀에서 돈다 — 화면 스레드를 막지 않는다.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tauri_plugin_log::log;

use super::discover::{self, ClaudeStatus};
use super::events::{
    RawLogEntry, Response, SessionEvent, SessionState, StartInfo, StartRequest, StopInfo,
};
use super::exec::ClaudeCommand;
use super::session::{EventSink, SessionManager};
use crate::error::AppError;

/// 화면이 듣는 이벤트 이름 (`src/lib/ipc.ts` 와 같이 바꾼다).
pub const SESSION_EVENT: &str = "claude:session";

/// 세션 이벤트를 Tauri 이벤트로 내보낸다.
pub struct TauriSink {
    app: AppHandle,
}

impl TauriSink {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

impl EventSink for TauriSink {
    fn emit(&self, event: SessionEvent) {
        if let Err(err) = self.app.emit(SESSION_EVENT, &event) {
            log::warn!("could not emit a session event: {err}");
        }
    }
}

async fn blocking<T, F>(work: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|err| AppError::Internal(format!("background task failed: {err}")))?
}

#[tauri::command]
pub async fn claude_discover() -> Result<ClaudeStatus, AppError> {
    blocking(|| Ok(discover::status_here())).await
}

#[tauri::command]
pub async fn claude_open_login() -> Result<(), AppError> {
    blocking(|| {
        let program = discover::locate_here(None).ok_or(AppError::ClaudeNotFound)?;
        discover::open_login_window(&program)
    })
    .await
    .map_err(AppError::logged)
}

#[tauri::command]
pub async fn claude_session_start(
    manager: State<'_, SessionManager>,
    request: StartRequest,
) -> Result<StartInfo, AppError> {
    let manager = manager.inner().clone();
    blocking(move || {
        let program = discover::locate_here(None).ok_or(AppError::ClaudeNotFound)?;
        manager.start(request, ClaudeCommand::new(program))
    })
    .await
    .map_err(AppError::logged)
}

#[tauri::command]
pub async fn claude_session_send(
    manager: State<'_, SessionManager>,
    text: String,
) -> Result<(), AppError> {
    let manager = manager.inner().clone();
    blocking(move || manager.send_message(&text)).await
}

#[tauri::command]
pub async fn claude_session_respond(
    manager: State<'_, SessionManager>,
    request_id: String,
    response: Response,
) -> Result<(), AppError> {
    let manager = manager.inner().clone();
    blocking(move || manager.respond(&request_id, response)).await
}

#[tauri::command]
pub async fn claude_session_interrupt(manager: State<'_, SessionManager>) -> Result<(), AppError> {
    let manager = manager.inner().clone();
    blocking(move || manager.interrupt()).await
}

#[tauri::command]
pub async fn claude_session_stop(manager: State<'_, SessionManager>) -> Result<StopInfo, AppError> {
    let manager = manager.inner().clone();
    blocking(move || manager.stop())
        .await
        .map_err(AppError::logged)
}

#[tauri::command]
pub async fn claude_session_state(
    manager: State<'_, SessionManager>,
) -> Result<SessionState, AppError> {
    let manager = manager.inner().clone();
    blocking(move || Ok(manager.state())).await
}

#[tauri::command]
pub async fn claude_last_session(
    manager: State<'_, SessionManager>,
    project_dir: String,
) -> Result<Option<String>, AppError> {
    let manager = manager.inner().clone();
    blocking(move || manager.last_session(&project_dir)).await
}

#[tauri::command]
pub async fn claude_raw_log(
    manager: State<'_, SessionManager>,
) -> Result<Vec<RawLogEntry>, AppError> {
    let manager = manager.inner().clone();
    blocking(move || Ok(manager.raw_log())).await
}
