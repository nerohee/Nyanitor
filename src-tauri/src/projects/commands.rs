//! 프로젝트의 Tauri 명령 — 얇게: 입력 전달 · 블로킹 풀에서 `projects` 의 일반 함수를 부를 뿐이다.
//!
//! **화면이 경로 글자를 보내는 명령은 없다** (D-47):
//! - 폴더는 `project_pick_folder` 가 Rust 에서 대화상자(`tauri-plugin-dialog` 의 Rust API — 화면에는 `dialog` 권한이 없다)로 받아 들고 있고,
//!   `project_add` 는 그 폴더만 등록한다.
//! - 나머지는 모두 등록된 프로젝트 번호(`id`)로만 받는다. 파일 명령이 다루는 파일은 그 폴더 바로 아래 `requirements.md` 하나다.
//! - 문서 읽기(P7-01)는 읽기 전용이다 — 하네스 문서(`progress_*`)는 고정된 이름의 파일만, 문서 보기(`docs_list` · `doc_read`)는 `docsDir` 안 `.md` 만
//!   (`doc_read` 는 `docsDir` 안 상대 경로를 받고 Rust 가 다시 확인한다). 쓰기 명령은 없다.
//!
//! 모두 `async` + 블로킹 풀: DB 잠금 · 파일 · 폴더 살펴보기 · 대화상자가 화면 스레드를 막지 않는다.

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use super::docs::{self, DocReadResult, ListResult};
use super::progress::{self, ProgressResult};
use super::requirements::{ReadResult, VersionResult, WriteResult};
use super::trust::{self, TrustCheck};
use super::{
    AddRequest, PickedFolder, ProjectEntry, ProjectList, ProjectPatch, ProjectsState, add,
    handle_picked, list, remove, requirements_read, requirements_version, requirements_write,
    touch, update,
};
use crate::claude::commands::blocking;
use crate::claude::session::SessionManager;
use crate::db::AppDb;
use crate::error::AppError;
use crate::strings;

#[tauri::command]
pub async fn projects_list(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
) -> Result<ProjectList, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || list(&db, &state.view_env())).await
}

/// 폴더 고르기 대화상자를 메인 창 위에 띄운다. 취소면 `null`. 고르면 확인한 결과를 돌려주고, 쓸 수 있는 폴더는 Rust 가 들고 있는다.
#[tauri::command]
pub async fn project_pick_folder(
    app: AppHandle,
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
) -> Result<Option<PickedFolder>, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    // 대화상자는 하나만 (두 번 눌러도 하나)
    let guard = state.begin_pick()?;
    blocking(move || {
        let _guard = guard;
        let mut dialog = app.dialog().file().set_title(strings::PICK_FOLDER_TITLE);
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let Some(chosen) = dialog.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = chosen
            .into_path()
            .map_err(|err| AppError::Internal(format!("the picked folder is not a path: {err}")))?;
        handle_picked(&db, &state, &state.env(), &path).map(Some)
    })
    .await
    .map_err(AppError::logged)
}

#[tauri::command]
pub async fn project_add(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    request: AddRequest,
) -> Result<ProjectEntry, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || add(&db, &state, &state.env(), request))
        .await
        .map_err(AppError::logged)
}

#[tauri::command]
pub async fn project_update(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
    patch: ProjectPatch,
) -> Result<ProjectEntry, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || update(&db, &state.view_env(), id, patch)).await
}

/// 등록만 지운다. 그 프로젝트의 세션이 시작 중이거나 돌고 있으면 `session_running` (끝낸 뒤에 뺀다).
#[tauri::command]
pub async fn project_remove(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    sessions: State<'_, SessionManager>,
    id: i64,
) -> Result<(), AppError> {
    let (db, state, sessions) = (
        db.inner().clone(),
        state.inner().clone(),
        sessions.inner().clone(),
    );
    blocking(move || remove(&db, &state, &sessions, id)).await
}

#[tauri::command]
pub async fn project_touch(db: State<'_, AppDb>, id: i64) -> Result<(), AppError> {
    let db = db.inner().clone();
    blocking(move || touch(&db, id)).await
}

#[tauri::command]
pub async fn project_requirements_read(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
) -> Result<ReadResult, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || requirements_read(&db, &state.env(), id)).await
}

#[tauri::command]
pub async fn project_requirements_version(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
) -> Result<VersionResult, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || requirements_version(&db, &state, &state.env(), id)).await
}

#[tauri::command]
pub async fn project_requirements_write(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
    text: String,
    base_version: Option<String>,
) -> Result<WriteResult, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || {
        requirements_write(
            &db,
            &state,
            &state.env(),
            id,
            &text,
            base_version.as_deref(),
        )
    })
    .await
    .map_err(AppError::logged)
}

/// 하네스 문서(단계 표 · 이어 하기 메모 · 지시서 진행률)를 읽는다. 못 읽는 곳은 오류가 아니라 결과의 `unreadable`(이유 포함)
#[tauri::command]
pub async fn project_progress_read(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
) -> Result<ProgressResult, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || progress::read(&db, &state.env(), id)).await
}

/// 하네스 문서가 바뀌었는지 싸게 묻는 값 (내용을 읽지 않는다 — 화면이 몇 초마다 부른다)
#[tauri::command]
pub async fn project_progress_version(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
) -> Result<String, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || progress::version(&db, &state.env(), id)).await
}

/// 그 프로젝트 `docsDir` 아래 `.md` 목록 (읽기 전용)
#[tauri::command]
pub async fn project_docs_list(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
) -> Result<ListResult, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || docs::list(&db, &state.env(), id)).await
}

/// 문서 하나 읽기. `path` 는 목록이 준 `docsDir` 안 상대 경로 — 모양이 틀리면 `invalid_input`, 실제 경로가 `docsDir` 밖이면 `outside_folder`
#[tauri::command]
pub async fn project_doc_read(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
    path: String,
) -> Result<DocReadResult, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || docs::read(&db, &state.env(), id, &path))
        .await
        .map_err(AppError::logged)
}

/// 이 프로젝트 폴더의 Claude Code 설정(훅 · 허용 규칙 · MCP 등)을 읽어 사용자 확인이 필요한지 알려 준다 (D-54).
/// 필요 없는 폴더(위험한 내용이 없거나 이미 확인한 그대로)는 `required: false`. 요약은 확인 화면이 그대로 보인다.
#[tauri::command]
pub async fn project_trust_check(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
) -> Result<TrustCheck, AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || trust::check(&db, &state.env(), id))
        .await
        .map_err(AppError::logged)
}

/// 화면이 본 설정(`hash`)을 신뢰로 적는다. 지금 폴더에서 다시 읽은 해시와 다르면 `trust_changed` — 적지 않는다.
#[tauri::command]
pub async fn project_trust_grant(
    db: State<'_, AppDb>,
    state: State<'_, ProjectsState>,
    id: i64,
    hash: String,
) -> Result<(), AppError> {
    let (db, state) = (db.inner().clone(), state.inner().clone());
    blocking(move || trust::grant(&db, &state.env(), id, &hash))
        .await
        .map_err(AppError::logged)
}
