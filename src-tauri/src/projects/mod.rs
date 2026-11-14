//! 프로젝트 등록 (P6-01) — 앱 DB 의 프로젝트 목록 · 폴더 고르기 · 등록 · 고치기 · 빼기 · `requirements.md` 읽고 쓰기.
//!
//! 결정: D-11 (프로젝트 = 사용자가 고른 폴더) · D-20 (앱 DB) · D-42 (요구사항 저장) · D-47 (폴더 고르기는 Rust 가, 파일 명령은 프로젝트 번호로만).
//!
//! - `store` — 프로젝트 표의 SQL
//! - `folder` — 고를 수 없는 폴더 · 폴더 살펴보기(느린 폴더를 기다리지 않음) · 하네스 문서 폴더 이름
//! - `requirements` — 폴더 바로 아래 `requirements.md` 하나의 읽기 · 쓰기 · 바깥 변경 확인
//! - `docs` — `docsDir` 아래 `.md` 의 읽기 전용 목록 · 읽기 (P7-01, D-49)
//! - `progress` — 하네스 문서(단계 표 · 이어 하기 메모 · 지시서 진행률) 읽기 (P7-01, D-22 · D-49)
//! - `trust` — 폴더 신뢰: 폴더의 Claude Code 설정(훅 · 허용 규칙 · MCP 등)을 요약 · 해시하고, 확인하기 전에는 세션을 시작하지 못하게 한다 (P10-03, D-54)
//! - `commands` — Tauri 명령 (얇게)
//!
//! **화면은 경로 글자를 보내지 않는다.** 폴더는 Rust 가 대화상자로 받아 들고 있다가(`ProjectsState::picked`) "추가" 때 그것만 등록하고,
//! 파일 명령은 등록된 프로젝트 번호로만 부른다. 이 파일의 함수들은 일반 함수라 Tauri 없이 시험한다.

pub mod commands;
pub mod docs;
pub mod folder;
pub mod progress;
pub mod requirements;
pub mod store;
pub mod trust;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Deserializer, Serialize};

use crate::claude::session::SessionManager;
use crate::claude::store::{forget_legacy_entries, import_legacy_for_project, project_key};
use crate::db::{AppDb, DbStatus};
use crate::error::AppError;
use crate::harness::locate::strip_verbatim;

use folder::{FolderFinding, FolderState, ForbiddenReason, ForbiddenSet, Inspection};
use store::ProjectRow;

/// 프로젝트 이름의 최대 글자 수
pub const NAME_MAX_CHARS: usize = 80;

/// 폴더 경로의 최대 길이 (바이트)
const PATH_MAX_BYTES: usize = 4096;

/// 프로젝트에 붙이는 하네스 스킬 (없음도 된다)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Skill {
    #[serde(rename = "/desktop-app")]
    DesktopApp,
    #[serde(rename = "/web-full")]
    WebFull,
    #[serde(rename = "/web-lite")]
    WebLite,
}

impl Skill {
    pub const ALL: [Skill; 3] = [Skill::DesktopApp, Skill::WebFull, Skill::WebLite];

    /// DB 에 저장하는 글자 (화면으로 가는 글자와 같다)
    pub fn as_str(self) -> &'static str {
        match self {
            Skill::DesktopApp => "/desktop-app",
            Skill::WebFull => "/web-full",
            Skill::WebLite => "/web-lite",
        }
    }

    pub fn parse(text: &str) -> Option<Skill> {
        Skill::ALL.into_iter().find(|skill| skill.as_str() == text)
    }
}

/// 목록의 한 항목 — 표의 줄 + 지금 폴더 상태
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub skill: Option<Skill>,
    /// 유닉스 시각(초)
    pub created_at: i64,
    pub last_opened_at: i64,
    /// 폴더가 지금 있는가 (`ok` · `missing` · `unknown`)
    pub folder: FolderState,
    /// 폴더 안을 살펴본 결과 — 폴더가 `ok` 일 때만
    pub finding: Option<FolderFinding>,
}

impl ProjectEntry {
    fn new(row: ProjectRow, inspection: Inspection) -> Self {
        Self {
            id: row.id,
            path: row.path,
            name: row.name,
            skill: row.skill,
            created_at: row.created_at,
            last_opened_at: row.last_opened_at,
            folder: inspection.state,
            finding: inspection.finding,
        }
    }
}

/// DB 를 어떻게 쓰고 있는가 — 새 번호 DB 면 읽기만 한다는 것을 화면이 알린다
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DbMode {
    Ok,
    ReadOnly,
}

/// `projects_list` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectList {
    pub db: DbMode,
    /// 최근에 연 순서
    pub projects: Vec<ProjectEntry>,
}

/// 고른 폴더 (쓸 수 있는 폴더)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedOk {
    pub path: String,
    /// 기본 프로젝트 이름 (폴더 이름)
    pub name: String,
    /// 폴더를 살펴본 결과 (제때 못 봤으면 `null`)
    pub finding: Option<FolderFinding>,
    /// 이미 등록된 프로젝트면 그 번호
    pub existing_id: Option<i64>,
}

/// 고를 수 없는 폴더를 골랐다
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedForbidden {
    pub path: String,
    pub reason: ForbiddenReason,
}

/// `project_pick_folder` 의 결과 (취소는 `null` — 이 값이 아니다)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PickedFolder {
    Ok(PickedOk),
    Forbidden(PickedForbidden),
}

/// `project_add` 의 입력 — 폴더 경로는 없다 (고른 폴더만 등록한다)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddRequest {
    pub name: Option<String>,
    pub skill: Option<String>,
}

/// 값이 없는 것(`undefined`)과 `null` 을 구별한다 — `skill: null` 은 "스킬 없음으로", 아예 없으면 "그대로"
fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// `project_update` 의 입력 — 고칠 것만 담는다 (경로 · 폴더는 고칠 수 없다)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectPatch {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub skill: Option<Option<String>>,
}

fn invalid(message: &str) -> AppError {
    AppError::InvalidInput(message.to_string())
}

/// 이름: 앞뒤 공백을 떼고, 비어 있지 않고, `NAME_MAX_CHARS` 글자 이하, 제어 문자 없음.
pub fn validate_name(text: &str) -> Result<String, AppError> {
    let name = text.trim();
    if name.is_empty() {
        return Err(invalid("project name is empty"));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(invalid("project name is too long"));
    }
    if name.chars().any(char::is_control) {
        return Err(invalid("project name has control characters"));
    }
    Ok(name.to_string())
}

fn validate_skill(text: &str) -> Result<Skill, AppError> {
    Skill::parse(text).ok_or_else(|| invalid("unknown skill"))
}

/// 기본 이름 = 폴더 이름 (너무 길면 자르고, 제어 문자는 뺀다)
fn default_name(path: &Path) -> String {
    let name: String = folder::folder_name(path)
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_MAX_CHARS)
        .collect();
    let name = name.trim();
    if name.is_empty() {
        "project".to_string()
    } else {
        name.to_string()
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 폴더를 고를 때마다 새로 읽는 환경 — 고를 수 없는 위치들 · 하네스 문서 폴더 이름
#[derive(Debug, Clone)]
pub struct Env {
    pub forbidden: ForbiddenSet,
    pub docs_dir: String,
    /// 폴더 살펴보기를 기다리는 시간
    pub inspect_deadline: Duration,
}

impl Env {
    pub fn here(app_data: &Path) -> Self {
        Self {
            forbidden: ForbiddenSet::here(app_data),
            docs_dir: folder::docs_dir_here(),
            inspect_deadline: folder::INSPECT_DEADLINE,
        }
    }
}

/// 앱이 들고 있는 것 — 고른 폴더 하나 · 파일 쓰기 잠금 · 바깥 변경 확인의 기억. 복제하면 같은 것을 가리킨다.
#[derive(Clone)]
pub struct ProjectsState {
    inner: Arc<Inner>,
}

struct Inner {
    app_data: PathBuf,
    /// 마지막으로 고른 폴더 (하나만 — 새로 고르면 바뀐다)
    picked: Mutex<Option<PathBuf>>,
    /// 폴더 고르기 대화상자가 떠 있다
    picking: AtomicBool,
    /// `requirements.md` 쓰기를 한 번에 하나로 (지금 파일을 보고 쓰기까지)
    file_lock: Mutex<()>,
    /// 프로젝트 번호별로 마지막에 본 파일 (`project_requirements_version` 이 싸게 답하려고)
    versions: Mutex<HashMap<i64, requirements::VersionCache>>,
}

/// 대화상자가 떠 있는 동안 쥔다 — 버려지면 다시 열 수 있다
pub struct PickGuard {
    inner: Arc<Inner>,
}

impl Drop for PickGuard {
    fn drop(&mut self) {
        self.inner.picking.store(false, Ordering::SeqCst);
    }
}

impl ProjectsState {
    pub fn new(app_data: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                app_data,
                picked: Mutex::new(None),
                picking: AtomicBool::new(false),
                file_lock: Mutex::new(()),
                versions: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// 폴더를 고르거나 등록할 때의 환경 — 고를 수 없는 위치까지 읽는다
    pub fn env(&self) -> Env {
        Env::here(&self.inner.app_data)
    }

    /// 목록을 보이거나 고칠 때의 환경 — 폴더를 살펴보는 데 필요한 것만 (고를 수 없는 위치는 읽지 않는다. 홈 폴더가 느린 곳이어도 목록이 느려지지 않게)
    pub fn view_env(&self) -> Env {
        Env {
            forbidden: ForbiddenSet::new(),
            docs_dir: folder::docs_dir_here(),
            inspect_deadline: folder::INSPECT_DEADLINE,
        }
    }

    /// 대화상자를 열 자리를 잡는다. 이미 떠 있으면 `folder_dialog_open`.
    pub fn begin_pick(&self) -> Result<PickGuard, AppError> {
        if self.inner.picking.swap(true, Ordering::SeqCst) {
            return Err(AppError::FolderDialogOpen);
        }
        Ok(PickGuard {
            inner: Arc::clone(&self.inner),
        })
    }

    pub fn picked(&self) -> Option<PathBuf> {
        lock(&self.inner.picked).clone()
    }

    fn set_picked(&self, path: Option<PathBuf>) {
        *lock(&self.inner.picked) = path;
    }
}

// ───────────────────────── 목록 ─────────────────────────

/// 한 프로젝트의 폴더를 살펴본다 (시간을 건다)
fn inspect_one(path: &str, env: &Env) -> Inspection {
    folder::inspect_all(&[PathBuf::from(path)], &env.docs_dir, env.inspect_deadline)
        .into_iter()
        .next()
        .unwrap_or(Inspection {
            state: FolderState::Unknown,
            finding: None,
        })
}

fn entry_of(row: ProjectRow, env: &Env) -> ProjectEntry {
    let inspection = inspect_one(&row.path, env);
    ProjectEntry::new(row, inspection)
}

/// 목록 — 최근에 연 순서. 폴더 하나가 느리거나 깨져도 그 항목만 `unknown`/`missing` 이고 나머지는 그대로다.
/// DB 는 줄을 읽는 동안만 쥔다 (폴더 살펴보기는 DB 밖에서).
pub fn list(db: &AppDb, env: &Env) -> Result<ProjectList, AppError> {
    let mode = match db.status() {
        DbStatus::Ready => DbMode::Ok,
        DbStatus::ReadOnly { .. } => DbMode::ReadOnly,
        DbStatus::Unavailable(reason) => return Err(AppError::DbUnavailable(reason)),
    };
    let rows = db.read(store::list)?;
    let paths: Vec<PathBuf> = rows.iter().map(|row| PathBuf::from(&row.path)).collect();
    let inspections = folder::inspect_all(&paths, &env.docs_dir, env.inspect_deadline);
    let projects = rows
        .into_iter()
        .zip(inspections)
        .map(|(row, inspection)| ProjectEntry::new(row, inspection))
        .collect();
    Ok(ProjectList { db: mode, projects })
}

// ───────────────────────── 폴더 고르기 · 등록 ─────────────────────────

/// 고른 경로를 받아들일 수 있는 모양으로: `\\?\` 를 떼고, 절대 경로 · UTF-8 · 실제로 있는 폴더인지 본다.
fn normalize_folder(path: &Path) -> Result<PathBuf, AppError> {
    let path = strip_verbatim(path);
    let text = path
        .to_str()
        .ok_or_else(|| invalid("folder path is not valid UTF-8"))?;
    if text.is_empty() || text.len() > PATH_MAX_BYTES || text.contains('\0') {
        return Err(invalid("folder path is empty or too long"));
    }
    if !path.is_absolute() {
        return Err(invalid("folder path must be absolute"));
    }
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => Ok(path),
        Ok(_) => Err(invalid("the picked path is not a folder")),
        Err(_) => Err(invalid("the picked folder does not exist")),
    }
}

/// 대화상자가 돌려준 폴더를 확인하고 들고 있는다. 고를 수 없는 폴더면 이유를 돌려주고 **들고 있던 폴더도 비운다**
/// (화면이 "고를 수 없음" 을 보이는 중에 이전 폴더가 등록되는 일이 없게).
pub fn handle_picked(
    db: &AppDb,
    state: &ProjectsState,
    env: &Env,
    path: &Path,
) -> Result<PickedFolder, AppError> {
    let path = normalize_folder(path)?;
    let text = path.to_string_lossy().into_owned();
    if let Some(reason) = env.forbidden.reason(&path) {
        state.set_picked(None);
        return Ok(PickedFolder::Forbidden(PickedForbidden {
            path: text,
            reason,
        }));
    }
    let key = project_key(&path);
    let existing_id = db
        .read(|conn| store::find_by_key(conn, &key))?
        .map(|row| row.id);
    let finding = inspect_one(&text, env).finding;
    state.set_picked(Some(path.clone()));
    Ok(PickedFolder::Ok(PickedOk {
        name: default_name(&path),
        path: text,
        finding,
        existing_id,
    }))
}

/// 들고 있는 폴더를 등록한다. 이미 등록된 폴더(같은 폴더의 다른 글자 포함)면 새로 만들지 않고 그 프로젝트를 돌려준다.
pub fn add(
    db: &AppDb,
    state: &ProjectsState,
    env: &Env,
    request: AddRequest,
) -> Result<ProjectEntry, AppError> {
    let picked = state.picked().ok_or(AppError::NoFolderPicked)?;
    // 고른 뒤 폴더가 사라졌거나 위치 설정이 바뀌었을 수 있다 — 다시 확인한다
    let path = normalize_folder(&picked)?;
    if env.forbidden.reason(&path).is_some() {
        return Err(invalid("the picked folder cannot be a project"));
    }
    let name = match request.name.as_deref() {
        Some(name) => validate_name(name)?,
        None => default_name(&path),
    };
    let skill = request.skill.as_deref().map(validate_skill).transpose()?;
    let key = project_key(&path);
    // 이미 있으면 읽기만 한다 (읽기 전용 DB 에서도 그 프로젝트를 돌려줄 수 있게)
    let row = match db.read(|conn| store::find_by_key(conn, &key))? {
        Some(row) => row,
        None => {
            let text = path
                .to_str()
                .ok_or_else(|| invalid("folder path is not valid UTF-8"))?;
            let row = db.write(|conn| store::insert(conn, text, &key, &name, skill, now_secs()))?;
            // 옛 `claude-sessions.json` (또는 이미 이름을 바꾼 `.imported*`) 에 이 폴더의 세션 ID 가 있으면 가져온다 — 못 가져와도 등록은 된 것이다
            import_legacy_for_project(db, &state.inner.app_data, &key);
            row
        }
    };
    Ok(entry_of(row, env))
}

/// 이름 · 스킬 고치기
pub fn update(
    db: &AppDb,
    env: &Env,
    id: i64,
    patch: ProjectPatch,
) -> Result<ProjectEntry, AppError> {
    let name = patch.name.as_deref().map(validate_name).transpose()?;
    let skill = match &patch.skill {
        None => None,
        Some(None) => Some(None),
        Some(Some(text)) => Some(Some(validate_skill(text)?)),
    };
    let row = db.write(|conn| store::update(conn, id, name.as_deref(), skill))?;
    Ok(entry_of(row, env))
}

/// 이미 끝난 세션의 남은 채팅 기록 쓰기를 기다리는 최대 시간 (뺀 뒤에 쓰려다 버려지지 않게)
const REMOVE_FLUSH_WAIT: Duration = Duration::from_secs(2);

/// 등록만 지운다 — 폴더 · 파일은 건드리지 않는다. 그 프로젝트의 세션이 시작 중이거나 돌고 있으면 `session_running` 으로 거절한다
/// (돌고 있는 세션의 기록이 갈 곳을 없애지 않게 — 끝낸 뒤에 뺀다). 확인과 지우기는 세션 관리자의 자리 잠금 안에서 같이 해서,
/// 확인한 뒤 그 사이 세션이 시작되는 틈이 없다 (`SessionManager::while_project_idle` · 시작 쪽 `launch::start_session`).
pub fn remove(
    db: &AppDb,
    state: &ProjectsState,
    sessions: &SessionManager,
    id: i64,
) -> Result<(), AppError> {
    // 끝난 세션의 마지막 기록(세션 끝 알림 등)이 큐에 남아 있을 수 있다 — 지우기 전에 쓰이게 한다 (잠금 밖에서)
    sessions.flush_history(REMOVE_FLUSH_WAIT);
    sessions.while_project_idle(id, || {
        // DB 를 쓸 수 있는지 먼저 본다 — 못 쓰는데 옛 파일의 항목만 지우는 일이 없게
        db.write(|_| Ok(()))?;
        let key: String = db.read(|conn| {
            conn.query_row("SELECT path_key FROM projects WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(AppError::ProjectNotFound(id))
        })?;
        // 옛 세션 ID 파일(`claude-sessions.json` · `.imported*`)의 이 폴더 항목도 지운다 — 남기면 같은 폴더를 다시 등록할 때 옛 세션 ID 가 "이어 하기" 로 되살아난다 (D-48).
        // 못 지우면 프로젝트도 빼지 않고 알린다 (다시 시도할 수 있게).
        forget_legacy_entries(&state.inner.app_data, &key)?;
        db.write(|conn| store::remove(conn, id))
    })?;
    lock(&state.inner.versions).remove(&id);
    Ok(())
}

pub fn touch(db: &AppDb, id: i64) -> Result<(), AppError> {
    db.write(|conn| store::touch(conn, id, now_secs()))
}

// ───────────────────────── requirements.md ─────────────────────────

/// 등록된 프로젝트의 폴더 (등록 안 된 번호면 `project_not_found`)
pub fn project_dir(db: &AppDb, id: i64) -> Result<PathBuf, AppError> {
    db.read(|conn| store::get(conn, id))?
        .map(|row| PathBuf::from(row.path))
        .ok_or(AppError::ProjectNotFound(id))
}

/// 등록된 프로젝트의 폴더 중 **지금 있는** 폴더 — 등록 안 된 번호면 `project_not_found`, 폴더가 없어졌으면 `project_folder_missing`.
/// 등록할 때 받아들인 모양(절대 경로 · UTF-8 · 실제 폴더)을 다시 확인한다.
pub fn existing_dir(db: &AppDb, id: i64) -> Result<PathBuf, AppError> {
    let dir = project_dir(db, id)?;
    normalize_folder(&dir).map_err(|_| AppError::ProjectFolderMissing(id))
}

/// 고를 수 없는 폴더면 `project_folder_forbidden` — 등록한 뒤 폴더를 지우고 `~/.claude` 등으로 가는 정션으로 바꿨거나 위치 설정이 바뀌었을 수 있다.
fn refuse_forbidden(env: &Env, id: i64, dir: &Path) -> Result<(), AppError> {
    match env.forbidden.reason(dir) {
        Some(_) => Err(AppError::ProjectFolderForbidden(id)),
        None => Ok(()),
    }
}

/// 세션을 시작할 폴더 (D-47: 화면은 경로가 아니라 프로젝트 번호만 보낸다). 등록된 프로젝트이고, 폴더가 지금 있고,
/// 고를 수 없는 폴더가 아니어야 한다 — 등록한 뒤 폴더가 사라졌거나 위치 설정이 바뀌었을 수 있어 시작 때마다 다시 확인한다.
pub fn session_dir(db: &AppDb, env: &Env, id: i64) -> Result<PathBuf, AppError> {
    let dir = existing_dir(db, id)?;
    refuse_forbidden(env, id, &dir)?;
    Ok(dir)
}

/// `requirements.md` 를 읽고 쓸 폴더 — 등록된 프로젝트의 폴더이고 **고를 수 없는 폴더가 아니어야** 한다 (`session_dir` 와 같은 판별).
/// 폴더가 없어진 것은 여기서 거절하지 않는다 (`requirements` 가 "폴더 없음" 결과로 알린다 — 화면이 그 안내를 보인다).
fn requirements_dir(db: &AppDb, env: &Env, id: i64) -> Result<PathBuf, AppError> {
    let dir = project_dir(db, id)?;
    refuse_forbidden(env, id, &dir)?;
    Ok(dir)
}

pub fn requirements_read(
    db: &AppDb,
    env: &Env,
    id: i64,
) -> Result<requirements::ReadResult, AppError> {
    let dir = requirements_dir(db, env, id)?;
    Ok(requirements::read(&dir))
}

pub fn requirements_version(
    db: &AppDb,
    state: &ProjectsState,
    env: &Env,
    id: i64,
) -> Result<requirements::VersionResult, AppError> {
    let dir = requirements_dir(db, env, id)?;
    let mut cache = lock(&state.inner.versions).get(&id).cloned();
    let result = requirements::version(&dir, &mut cache, std::time::SystemTime::now());
    let mut versions = lock(&state.inner.versions);
    match cache {
        Some(entry) => versions.insert(id, entry),
        None => versions.remove(&id),
    };
    Ok(result)
}

pub fn requirements_write(
    db: &AppDb,
    state: &ProjectsState,
    env: &Env,
    id: i64,
    text: &str,
    base_version: Option<&str>,
) -> Result<requirements::WriteResult, AppError> {
    let dir = requirements_dir(db, env, id)?;
    // 지금 파일을 보고 쓰기까지 한 번에 하나 (앱 안에서 두 번 저장이 겹치지 않게)
    let _guard = lock(&state.inner.file_lock);
    let result = requirements::write(&dir, text, base_version);
    // 쓰든 못 쓰든 파일이 바뀌었을 수 있다 — 기억을 버린다
    lock(&state.inner.versions).remove(&id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::events::SessionEvent;
    use crate::claude::session::{EventSink, ManagerConfig};
    use crate::claude::store::{LEGACY_FILE, import_legacy, last_for_project};
    use crate::claude::test_util::TempDir;
    use crate::db::DB_FILE;
    use std::fs;

    /// 이벤트를 버리는 자리 — 세션을 띄우지 않는 시험의 세션 관리자용
    struct NullSink;

    impl EventSink for NullSink {
        fn emit(&self, _event: SessionEvent) {}
    }

    fn idle_sessions(db: &AppDb) -> SessionManager {
        SessionManager::new(Arc::new(NullSink), db.clone(), ManagerConfig::default())
    }

    struct Fixture {
        root: PathBuf,
        db: AppDb,
        sessions: SessionManager,
        state: ProjectsState,
        env: Env,
        /// 맨 끝 칸 — 필드는 적은 순서대로 버려지므로 DB · 세션 관리자가 먼저 닫힌 뒤에 폴더를 지운다 (열린 DB 파일이 있으면 Windows 는 지우지 못한다)
        _dir: TempDir,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let dir = TempDir::new(name);
            let root = dir.join("work");
            fs::create_dir_all(&root).unwrap();
            let data = dir.join("data");
            let db = AppDb::open(&data.join(DB_FILE));
            let state = ProjectsState::new(data.clone());
            let env = Env {
                forbidden: ForbiddenSet::new()
                    .with_inside(ForbiddenReason::AppData, &data)
                    .with_exact(ForbiddenReason::Home, &root.join("home")),
                docs_dir: "docs".into(),
                inspect_deadline: Duration::from_secs(5),
            };
            let sessions = idle_sessions(&db);
            Self {
                root,
                db,
                sessions,
                state,
                env,
                _dir: dir,
            }
        }

        /// 앱 데이터 폴더 (옛 세션 파일이 있는 곳)
        fn data_dir(&self) -> PathBuf {
            self._dir.join("data")
        }

        fn folder(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            fs::create_dir_all(&path).unwrap();
            path
        }

        fn pick(&self, path: &Path) -> PickedFolder {
            handle_picked(&self.db, &self.state, &self.env, path).unwrap()
        }

        fn add(&self, path: &Path) -> ProjectEntry {
            self.pick(path);
            add(&self.db, &self.state, &self.env, AddRequest::default()).unwrap()
        }

        fn list(&self) -> ProjectList {
            list(&self.db, &self.env).unwrap()
        }
    }

    fn ok(picked: PickedFolder) -> PickedOk {
        match picked {
            PickedFolder::Ok(ok) => ok,
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn no_projects_is_an_empty_list() {
        let fx = Fixture::new("proj-empty");
        let list = fx.list();
        assert_eq!(list.db, DbMode::Ok);
        assert!(list.projects.is_empty());
    }

    #[test]
    fn picking_a_folder_reports_what_is_in_it_and_holds_it() {
        let fx = Fixture::new("proj-pick");
        let fresh = fx.folder("fresh");
        let picked = ok(fx.pick(&fresh));
        assert_eq!(picked.name, "fresh");
        assert_eq!(picked.finding, Some(FolderFinding::Fresh));
        assert_eq!(picked.existing_id, None);
        assert_eq!(fx.state.picked(), Some(fresh));

        let with_req = fx.folder("with-req");
        fs::write(with_req.join("requirements.md"), "x").unwrap();
        assert_eq!(
            ok(fx.pick(&with_req)).finding,
            Some(FolderFinding::HasRequirements)
        );
        let with_harness = fx.folder("with-harness");
        fs::create_dir_all(with_harness.join("docs").join("02-development")).unwrap();
        fs::write(
            with_harness
                .join("docs")
                .join("02-development")
                .join("handoff.md"),
            "x",
        )
        .unwrap();
        assert_eq!(
            ok(fx.pick(&with_harness)).finding,
            Some(FolderFinding::HasHarness)
        );
        // 하나만 들고 있다 — 새로 고르면 바뀐다
        assert_eq!(fx.state.picked(), Some(with_harness));
    }

    #[test]
    fn a_forbidden_pick_reports_the_reason_and_drops_the_held_folder() {
        let fx = Fixture::new("proj-forbidden");
        let fine = fx.folder("fine");
        fx.pick(&fine);
        assert!(fx.state.picked().is_some());

        let home = fx.folder("home");
        match fx.pick(&home) {
            PickedFolder::Forbidden(forbidden) => {
                assert_eq!(forbidden.reason, ForbiddenReason::Home)
            }
            other => panic!("expected forbidden, got {other:?}"),
        }
        // 이전에 골라 둔 폴더가 남아서 등록되지 않는다
        assert_eq!(fx.state.picked(), None);
        let err = add(&fx.db, &fx.state, &fx.env, AddRequest::default()).unwrap_err();
        assert_eq!(err.kind(), "no_folder_picked");
        assert!(fx.list().projects.is_empty());
    }

    #[test]
    fn a_pick_that_is_not_an_existing_absolute_folder_is_an_error() {
        let fx = Fixture::new("proj-badpick");
        let file = fx.root.join("a-file");
        fs::write(&file, "x").unwrap();
        for bad in [
            fx.root.join("gone"),
            file,
            PathBuf::from("relative/path"),
            PathBuf::new(),
        ] {
            let err = handle_picked(&fx.db, &fx.state, &fx.env, &bad).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{}", bad.display());
        }
        assert_eq!(fx.state.picked(), None);
    }

    #[test]
    fn add_registers_only_the_picked_folder() {
        let fx = Fixture::new("proj-add");
        // 고른 것이 없으면 등록할 수 없다
        let err = add(&fx.db, &fx.state, &fx.env, AddRequest::default()).unwrap_err();
        assert_eq!(err.kind(), "no_folder_picked");

        let folder = fx.folder("cat-album");
        let entry = fx.add(&folder);
        assert_eq!(entry.name, "cat-album");
        assert_eq!(entry.skill, None);
        assert_eq!(entry.path, folder.to_string_lossy());
        assert_eq!(entry.folder, FolderState::Ok);
        assert_eq!(entry.finding, Some(FolderFinding::Fresh));
        assert_eq!(fx.list().projects, vec![entry]);
    }

    #[test]
    fn add_takes_a_name_and_a_skill_and_validates_them() {
        let fx = Fixture::new("proj-add-opts");
        let folder = fx.folder("shop");
        fx.pick(&folder);
        let request = |name: Option<&str>, skill: Option<&str>| AddRequest {
            name: name.map(str::to_string),
            skill: skill.map(str::to_string),
        };
        for bad in [
            request(Some(""), None),
            request(Some("   "), None),
            request(Some(&"x".repeat(NAME_MAX_CHARS + 1)), None),
            request(Some("tab\there"), None),
            request(None, Some("/nope")),
            request(None, Some("desktop-app")),
        ] {
            assert_eq!(
                add(&fx.db, &fx.state, &fx.env, bad).unwrap_err().kind(),
                "invalid_input"
            );
        }
        assert!(
            fx.list().projects.is_empty(),
            "a rejected add leaves nothing"
        );
        let entry = add(
            &fx.db,
            &fx.state,
            &fx.env,
            request(Some("  내 가게  "), Some("/web-full")),
        )
        .unwrap();
        assert_eq!(entry.name, "내 가게");
        assert_eq!(entry.skill, Some(Skill::WebFull));
    }

    #[test]
    fn the_same_folder_is_registered_once_however_it_is_spelled() {
        let fx = Fixture::new("proj-same");
        let folder = fx.folder("Same-Folder");
        let first = fx.add(&folder);
        // 끝 구분자
        let sep = std::path::MAIN_SEPARATOR;
        let trailing = PathBuf::from(format!("{}{sep}", folder.display()));
        let again = fx.add(&trailing);
        assert_eq!(again.id, first.id);
        // 안쪽 `.`
        let dotted = PathBuf::from(format!("{}{sep}.", folder.display()));
        assert_eq!(fx.add(&dotted).id, first.id);
        if cfg!(windows) {
            // 대소문자 · 슬래시
            let text = folder.display().to_string();
            assert_eq!(fx.add(Path::new(&text.to_lowercase())).id, first.id);
            assert_eq!(fx.add(Path::new(&text.replace('\\', "/"))).id, first.id);
            assert_eq!(fx.add(Path::new(&text.to_uppercase())).id, first.id);
        }
        // 고를 때도 이미 등록된 것을 알려 준다
        assert_eq!(ok(fx.pick(&folder)).existing_id, Some(first.id));
        assert_eq!(fx.list().projects.len(), 1);
        // 이름은 처음 그대로 (두 번째 등록이 덮어쓰지 않는다)
        assert_eq!(fx.list().projects[0].name, "Same-Folder");
    }

    #[test]
    fn adding_after_the_folder_vanished_or_became_forbidden_is_refused() {
        let fx = Fixture::new("proj-recheck");
        let gone = fx.folder("gone-soon");
        fx.pick(&gone);
        fs::remove_dir(&gone).unwrap();
        assert_eq!(
            add(&fx.db, &fx.state, &fx.env, AddRequest::default())
                .unwrap_err()
                .kind(),
            "invalid_input"
        );

        // 고를 때는 괜찮았는데 그 사이 위치 설정이 바뀌어 막힌 폴더가 됨
        let later = fx.folder("later-forbidden");
        fx.pick(&later);
        let strict = Env {
            forbidden: ForbiddenSet::new().with_inside(ForbiddenReason::ClaudeDir, &later),
            ..fx.env.clone()
        };
        assert_eq!(
            add(&fx.db, &fx.state, &strict, AddRequest::default())
                .unwrap_err()
                .kind(),
            "invalid_input"
        );
        assert!(fx.list().projects.is_empty());
    }

    #[test]
    fn list_is_most_recently_opened_first_and_marks_vanished_folders() {
        let fx = Fixture::new("proj-list");
        let a = fx.folder("a");
        let b = fx.folder("b");
        let c = fx.folder("c");
        let ea = fx.add(&a);
        let eb = fx.add(&b);
        let ec = fx.add(&c);
        // 같은 초에 만들었으면 나중 것이 먼저
        assert_eq!(
            fx.list().projects.iter().map(|p| p.id).collect::<Vec<_>>(),
            vec![ec.id, eb.id, ea.id]
        );
        // 열면 맨 위로
        fx.db
            .write(|conn| {
                conn.execute(
                    "UPDATE projects SET last_opened_at = 1 WHERE id != ?1",
                    [ea.id],
                )?;
                Ok(())
            })
            .unwrap();
        touch(&fx.db, ea.id).unwrap();
        assert_eq!(fx.list().projects[0].id, ea.id);

        // 폴더가 없어진 항목만 missing
        fs::remove_dir(&b).unwrap();
        let list = fx.list();
        let states: Vec<(String, FolderState)> = list
            .projects
            .iter()
            .map(|p| (p.name.clone(), p.folder))
            .collect();
        assert!(states.contains(&("a".into(), FolderState::Ok)));
        assert!(states.contains(&("b".into(), FolderState::Missing)));
        assert!(states.contains(&("c".into(), FolderState::Ok)));
        let missing = list.projects.iter().find(|p| p.name == "b").unwrap();
        assert_eq!(missing.finding, None);
    }

    #[test]
    fn a_project_whose_folder_cannot_even_be_looked_at_does_not_fail_the_list() {
        let fx = Fixture::new("proj-list-odd");
        let good = fx.add(&fx.folder("good"));
        // 경로가 이상한 줄 (NUL) 과 상대 경로 줄 — 직접 넣는다
        fx.db
            .write(|conn| {
                store::insert(conn, "bad\0path", "bad\0path", "weird", None, 5)?;
                store::insert(conn, "relative\\dir", "relative\\dir", "relative", None, 6)?;
                Ok(())
            })
            .unwrap();
        let list = fx.list();
        assert_eq!(list.projects.len(), 3);
        let by = |name: &str| list.projects.iter().find(|p| p.name == name).unwrap();
        assert_eq!(by("good").id, good.id);
        assert_eq!(by("good").folder, FolderState::Ok);
        assert_ne!(by("weird").folder, FolderState::Ok);
        assert_ne!(by("relative").folder, FolderState::Ok);
    }

    #[test]
    fn update_renames_and_sets_the_skill() {
        let fx = Fixture::new("proj-update");
        let entry = fx.add(&fx.folder("old-name"));
        let patch = |name: Option<&str>, skill: Option<Option<&str>>| ProjectPatch {
            name: name.map(str::to_string),
            skill: skill.map(|inner| inner.map(str::to_string)),
        };
        let updated = update(
            &fx.db,
            &fx.env,
            entry.id,
            patch(Some(" 새 이름 "), Some(Some("/desktop-app"))),
        )
        .unwrap();
        assert_eq!(updated.name, "새 이름");
        assert_eq!(updated.skill, Some(Skill::DesktopApp));
        // 스킬만 고치면 이름은 그대로, null 이면 스킬 없음
        let updated = update(&fx.db, &fx.env, entry.id, patch(None, Some(None))).unwrap();
        assert_eq!((updated.name.as_str(), updated.skill), ("새 이름", None));
        // 빈 이름 · 긴 이름 · 모르는 스킬은 거절하고 아무것도 바꾸지 않는다
        for bad in [
            patch(Some("  "), None),
            patch(Some(&"긴".repeat(NAME_MAX_CHARS + 1)), None),
            patch(Some("ok"), Some(Some("/unknown"))),
        ] {
            assert_eq!(
                update(&fx.db, &fx.env, entry.id, bad).unwrap_err().kind(),
                "invalid_input"
            );
        }
        assert_eq!(fx.list().projects[0].name, "새 이름");
        // 정확히 최대 글자는 된다
        assert!(
            update(
                &fx.db,
                &fx.env,
                entry.id,
                patch(Some(&"긴".repeat(NAME_MAX_CHARS)), None)
            )
            .is_ok()
        );
        // 등록 안 된 번호
        assert_eq!(
            update(&fx.db, &fx.env, 999, patch(Some("x"), None))
                .unwrap_err()
                .kind(),
            "project_not_found"
        );
    }

    #[test]
    fn the_patch_and_request_shapes_reject_anything_but_their_fields() {
        // 화면이 경로를 슬쩍 끼워 보내도 받지 않는다
        assert!(serde_json::from_str::<ProjectPatch>(r#"{"name":"a","path":"C:\\x"}"#).is_err());
        assert!(serde_json::from_str::<AddRequest>(r#"{"path":"C:\\x"}"#).is_err());
        // 없음과 null 을 구별한다
        let none: ProjectPatch = serde_json::from_str("{}").unwrap();
        assert_eq!((none.name, none.skill), (None, None));
        let null: ProjectPatch = serde_json::from_str(r#"{"skill":null}"#).unwrap();
        assert_eq!(null.skill, Some(None));
        let some: ProjectPatch = serde_json::from_str(r#"{"skill":"/web-lite"}"#).unwrap();
        assert_eq!(some.skill, Some(Some("/web-lite".to_string())));
        let add: AddRequest = serde_json::from_str("{}").unwrap();
        assert_eq!((add.name, add.skill), (None, None));
    }

    #[test]
    fn remove_unregisters_but_leaves_the_folder_and_its_files() {
        let fx = Fixture::new("proj-remove");
        let folder = fx.folder("keep-me");
        fs::write(folder.join("requirements.md"), "my requirements").unwrap();
        fs::write(folder.join("notes.txt"), "notes").unwrap();
        let entry = fx.add(&folder);
        remove(&fx.db, &fx.state, &fx.sessions, entry.id).unwrap();
        assert!(fx.list().projects.is_empty());
        assert_eq!(
            fs::read_to_string(folder.join("requirements.md")).unwrap(),
            "my requirements"
        );
        assert_eq!(
            fs::read_to_string(folder.join("notes.txt")).unwrap(),
            "notes"
        );
        assert_eq!(
            remove(&fx.db, &fx.state, &fx.sessions, entry.id)
                .unwrap_err()
                .kind(),
            "project_not_found"
        );
        // 다시 등록할 수 있고 번호는 새것
        let again = fx.add(&folder);
        assert_ne!(again.id, entry.id);
        // 빼고 난 번호로는 파일 명령도 안 된다
        assert_eq!(
            requirements_read(&fx.db, &fx.env, entry.id)
                .unwrap_err()
                .kind(),
            "project_not_found"
        );
    }

    #[test]
    fn touch_moves_a_project_to_the_top_and_unknown_ids_are_refused() {
        let fx = Fixture::new("proj-touch");
        let a = fx.add(&fx.folder("a"));
        let b = fx.add(&fx.folder("b"));
        fx.db
            .write(|conn| {
                conn.execute("UPDATE projects SET last_opened_at = 10", [])?;
                Ok(())
            })
            .unwrap();
        assert_eq!(fx.list().projects[0].id, b.id);
        touch(&fx.db, a.id).unwrap();
        let list = fx.list();
        assert_eq!(list.projects[0].id, a.id);
        assert!(list.projects[0].last_opened_at > 10);
        assert_eq!(touch(&fx.db, 999).unwrap_err().kind(), "project_not_found");
    }

    #[test]
    fn requirements_commands_only_work_for_registered_projects() {
        let fx = Fixture::new("proj-req-ids");
        for id in [0, 1, -5, i64::MAX] {
            assert_eq!(
                requirements_read(&fx.db, &fx.env, id).unwrap_err().kind(),
                "project_not_found"
            );
            assert_eq!(
                requirements_version(&fx.db, &fx.state, &fx.env, id)
                    .unwrap_err()
                    .kind(),
                "project_not_found"
            );
            assert_eq!(
                requirements_write(&fx.db, &fx.state, &fx.env, id, "x", None)
                    .unwrap_err()
                    .kind(),
                "project_not_found"
            );
        }
    }

    #[test]
    fn requirements_round_trip_through_a_project() {
        let fx = Fixture::new("proj-req");
        let folder = fx.folder("book");
        let id = fx.add(&folder).id;
        assert_eq!(
            requirements_read(&fx.db, &fx.env, id).unwrap(),
            requirements::ReadResult::Absent
        );
        assert_eq!(
            requirements_version(&fx.db, &fx.state, &fx.env, id).unwrap(),
            requirements::VersionResult::Absent
        );

        // 없던 파일 새로 쓰기
        let requirements::WriteResult::Ok(first) =
            requirements_write(&fx.db, &fx.state, &fx.env, id, "# 책\n", None).unwrap()
        else {
            panic!("expected ok");
        };
        assert_eq!(
            fs::read_to_string(folder.join("requirements.md")).unwrap(),
            "# 책\n"
        );
        assert_eq!(
            requirements_version(&fx.db, &fx.state, &fx.env, id).unwrap(),
            requirements::VersionResult::Ok(first.clone())
        );

        // 이어서 쓰기 → 새 version
        let requirements::WriteResult::Ok(second) = requirements_write(
            &fx.db,
            &fx.state,
            &fx.env,
            id,
            "# 책\n둘째\n",
            Some(&first.version),
        )
        .unwrap() else {
            panic!("expected ok");
        };
        assert_ne!(first.version, second.version);

        // 바깥(터미널)에서 바뀜 → version 이 바뀌고, 옛 version 으로 쓰면 충돌
        fs::write(folder.join("requirements.md"), "터미널에서 고침").unwrap();
        let requirements::VersionResult::Ok(outside) =
            requirements_version(&fx.db, &fx.state, &fx.env, id).unwrap()
        else {
            panic!("expected ok");
        };
        assert_ne!(outside.version, second.version);
        assert_eq!(
            requirements_write(
                &fx.db,
                &fx.state,
                &fx.env,
                id,
                "내 글",
                Some(&second.version)
            )
            .unwrap(),
            requirements::WriteResult::Conflict(requirements::ConflictInfo {
                version: Some(outside.version)
            })
        );
        assert_eq!(
            fs::read_to_string(folder.join("requirements.md")).unwrap(),
            "터미널에서 고침"
        );
    }

    #[test]
    fn requirements_in_a_vanished_project_folder_is_unreadable_not_created() {
        let fx = Fixture::new("proj-req-gone");
        let folder = fx.folder("temp");
        let id = fx.add(&folder).id;
        fs::remove_dir(&folder).unwrap();
        assert_eq!(
            requirements_read(&fx.db, &fx.env, id).unwrap(),
            requirements::ReadResult::Unreadable(requirements::ProblemInfo {
                reason: requirements::Problem::FolderMissing
            })
        );
        assert!(matches!(
            requirements_write(&fx.db, &fx.state, &fx.env, id, "x", None).unwrap(),
            requirements::WriteResult::Refused(_)
        ));
        assert!(!folder.exists(), "the folder is not recreated");
    }

    /// 폴더 링크를 만든다 — Windows 는 정션(관리자 권한이 필요 없다), 그 밖은 심볼릭 링크. 못 만들면 시험이 실패한다 (조용히 통과하지 않는다).
    fn link_dir(link: &Path, target: &Path) {
        #[cfg(windows)]
        let made = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .raw_arg(format!(
                    "/C mklink /J \"{}\" \"{}\"",
                    link.display(),
                    target.display()
                ))
                .output()
                .is_ok_and(|out| out.status.success())
        };
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        assert!(
            made,
            "could not create a directory link, so this test checked nothing"
        );
    }

    #[test]
    fn requirements_commands_refuse_a_folder_that_became_forbidden_after_registering() {
        let fx = Fixture::new("proj-req-forbidden");
        let folder = fx.folder("later-forbidden");
        fs::write(folder.join("requirements.md"), "mine").unwrap();
        let id = fx.add(&folder).id;
        let version = match requirements_version(&fx.db, &fx.state, &fx.env, id).unwrap() {
            requirements::VersionResult::Ok(info) => info.version,
            other => panic!("expected a version, got {other:?}"),
        };

        // 등록한 뒤 위치 설정이 바뀌어 이 폴더가 막힌 곳이 됐다 — 읽기 · 버전 · 쓰기 모두 거절하고 파일은 그대로
        let strict = Env {
            forbidden: ForbiddenSet::new().with_inside(ForbiddenReason::ClaudeDir, &folder),
            ..fx.env.clone()
        };
        assert_eq!(
            requirements_read(&fx.db, &strict, id).unwrap_err().kind(),
            "project_folder_forbidden"
        );
        assert_eq!(
            requirements_version(&fx.db, &fx.state, &strict, id)
                .unwrap_err()
                .kind(),
            "project_folder_forbidden"
        );
        assert_eq!(
            requirements_write(&fx.db, &fx.state, &strict, id, "changed", Some(&version))
                .unwrap_err()
                .kind(),
            "project_folder_forbidden"
        );
        assert_eq!(
            fs::read_to_string(folder.join("requirements.md")).unwrap(),
            "mine"
        );
        // 세션 시작과 같은 판별이다
        assert_eq!(
            session_dir(&fx.db, &strict, id).unwrap_err().kind(),
            "project_folder_forbidden"
        );
        // 막히지 않은 환경에서는 그대로 된다
        assert!(requirements_read(&fx.db, &fx.env, id).is_ok());
    }

    #[test]
    fn a_registered_folder_swapped_for_a_link_to_a_forbidden_place_is_refused_for_requirements() {
        let fx = Fixture::new("proj-req-junction");
        // 막힌 곳 (`~/.claude` 를 흉내) 에 이미 `requirements.md` 가 있다
        let claude = fx.folder("fake-claude-dir");
        fs::write(claude.join("requirements.md"), "do not touch").unwrap();
        let env = Env {
            forbidden: ForbiddenSet::new().with_inside(ForbiddenReason::ClaudeDir, &claude),
            ..fx.env.clone()
        };
        // 등록할 때는 평범한 폴더
        let folder = fx.folder("looks-fine");
        let id = fx.add(&folder).id;
        assert!(requirements_read(&fx.db, &env, id).is_ok());
        // 그 뒤 폴더를 지우고 같은 자리를 막힌 곳으로 가는 링크로 바꿨다
        fs::remove_dir(&folder).unwrap();
        link_dir(&folder, &claude);

        assert_eq!(
            requirements_read(&fx.db, &env, id).unwrap_err().kind(),
            "project_folder_forbidden"
        );
        assert_eq!(
            requirements_version(&fx.db, &fx.state, &env, id)
                .unwrap_err()
                .kind(),
            "project_folder_forbidden"
        );
        assert_eq!(
            requirements_write(&fx.db, &fx.state, &env, id, "overwrite", None)
                .unwrap_err()
                .kind(),
            "project_folder_forbidden"
        );
        assert_eq!(
            session_dir(&fx.db, &env, id).unwrap_err().kind(),
            "project_folder_forbidden"
        );
        // 막힌 곳의 파일은 읽히지도 고쳐지지도 않았다
        assert_eq!(
            fs::read_to_string(claude.join("requirements.md")).unwrap(),
            "do not touch"
        );
        assert_eq!(fs::read_dir(&claude).unwrap().count(), 1);
    }

    #[test]
    fn registering_a_folder_brings_in_its_old_session_id_from_a_renamed_file() {
        // 고객 PC 처럼: 앱을 처음 켠 때 프로젝트가 없어 옛 파일이 이미 `.imported` 로 바뀌었다
        let fx = Fixture::new("proj-legacy-renamed");
        let folder = fx.folder("old-project");
        let other = fx.folder("other-project");
        let (id_a, id_b) = (
            "00000000-0000-4000-8000-0000000000a1",
            "00000000-0000-4000-8000-0000000000b2",
        );
        let body = format!(
            r#"{{"version":1,"projects":{{{}:{{"sessionId":"{id_a}","updatedAt":1700000000}},{}:{{"sessionId":"{id_b}","updatedAt":1700000500}}}}}}"#,
            serde_json::to_string(&project_key(&folder)).unwrap(),
            serde_json::to_string(&project_key(&other)).unwrap(),
        );
        let renamed = fx.data_dir().join(format!("{LEGACY_FILE}.imported"));
        fs::write(&renamed, &body).unwrap();

        let entry = fx.add(&folder);
        // 이 폴더의 것만 들어오고, 다른 폴더의 것은 그 폴더를 등록할 때까지 그대로
        assert_eq!(
            fx.db
                .read(|conn| last_for_project(conn, entry.id))
                .unwrap()
                .as_deref(),
            Some(id_a)
        );
        let total: i64 = fx
            .db
            .read(|conn| Ok(conn.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(total, 1);
        // 옛 파일은 지우지도 고치지도 않았다
        assert_eq!(fs::read_to_string(&renamed).unwrap(), body);
        let other_entry = fx.add(&other);
        assert_eq!(
            fx.db
                .read(|conn| last_for_project(conn, other_entry.id))
                .unwrap()
                .as_deref(),
            Some(id_b)
        );
    }

    #[test]
    fn an_old_file_with_unmatched_folders_stays_until_every_folder_is_registered() {
        // 프로젝트가 0개일 때 앱을 켰다 (`lib.rs` 가 하는 일) — 옛 파일이 이름 바뀌지 않아야 한다
        let fx = Fixture::new("proj-legacy-pending");
        let (a, b) = (fx.folder("a"), fx.folder("b"));
        let (id_a, id_b) = (
            "00000000-0000-4000-8000-0000000000a1",
            "00000000-0000-4000-8000-0000000000b2",
        );
        let live = fx.data_dir().join(LEGACY_FILE);
        fs::write(
            &live,
            format!(
                r#"{{"version":1,"projects":{{{}:{{"sessionId":"{id_a}","updatedAt":1}},{}:{{"sessionId":"{id_b}","updatedAt":2}}}}}}"#,
                serde_json::to_string(&project_key(&a)).unwrap(),
                serde_json::to_string(&project_key(&b)).unwrap(),
            ),
        )
        .unwrap();
        assert!(matches!(
            import_legacy(&fx.db, &live),
            crate::claude::store::LegacyImport::Pending { unmatched: 2, .. }
        ));
        assert!(live.exists());

        let entry_a = fx.add(&a);
        assert_eq!(
            fx.db
                .read(|conn| last_for_project(conn, entry_a.id))
                .unwrap()
                .as_deref(),
            Some(id_a)
        );
        assert!(live.exists(), "b 는 아직 등록 안 됨 — 파일이 남는다");
        let entry_b = fx.add(&b);
        assert_eq!(
            fx.db
                .read(|conn| last_for_project(conn, entry_b.id))
                .unwrap()
                .as_deref(),
            Some(id_b)
        );
        // 이제 다 맞췄다 — 그때서야 이름이 바뀐다 (지우지 않는다)
        assert!(!live.exists());
        assert!(
            fx.data_dir()
                .join(format!("{LEGACY_FILE}.imported"))
                .exists()
        );
    }

    #[test]
    fn removing_a_project_and_registering_it_again_does_not_bring_back_its_old_session_id() {
        // D-48 "빼면 기록도 지운다" — 뺀 프로젝트의 옛 세션 ID 가 `.imported*` 에서 "이어 하기" 로 돌아오지 않는다
        let fx = Fixture::new("proj-legacy-removed");
        let folder = fx.folder("old-project");
        let other = fx.folder("other-project");
        let (id_a, id_b) = (
            "00000000-0000-4000-8000-0000000000a1",
            "00000000-0000-4000-8000-0000000000b2",
        );
        let body = format!(
            r#"{{"version":1,"projects":{{{}:{{"sessionId":"{id_a}","updatedAt":1700000000}},{}:{{"sessionId":"{id_b}","updatedAt":1700000500}}}}}}"#,
            serde_json::to_string(&project_key(&folder)).unwrap(),
            serde_json::to_string(&project_key(&other)).unwrap(),
        );
        let renamed = fx.data_dir().join(format!("{LEGACY_FILE}.imported"));
        fs::write(&renamed, &body).unwrap();
        let entry = fx.add(&folder);
        assert_eq!(
            fx.db
                .read(|conn| last_for_project(conn, entry.id))
                .unwrap()
                .as_deref(),
            Some(id_a),
            "처음 등록하면 가져온다"
        );

        remove(&fx.db, &fx.state, &fx.sessions, entry.id).unwrap();
        // 같은 폴더를 다시 등록해도 이어 하기 세션 ID 가 없다
        let again = fx.add(&folder);
        assert_ne!(again.id, entry.id);
        assert_eq!(
            fx.db.read(|conn| last_for_project(conn, again.id)).unwrap(),
            None
        );
        // 다른 폴더의 항목은 그대로라 그 폴더를 등록하면 가져온다
        let other_entry = fx.add(&other);
        assert_eq!(
            fx.db
                .read(|conn| last_for_project(conn, other_entry.id))
                .unwrap()
                .as_deref(),
            Some(id_b)
        );
    }

    #[test]
    fn a_project_whose_old_session_file_cannot_be_rewritten_is_not_removed() {
        let fx = Fixture::new("proj-legacy-remove-fails");
        let folder = fx.folder("p");
        let entry = fx.add(&folder);
        let renamed = fx.data_dir().join(format!("{LEGACY_FILE}.imported"));
        fs::write(
            &renamed,
            format!(
                r#"{{"version":1,"projects":{{{}:{{"sessionId":"00000000-0000-4000-8000-0000000000a1","updatedAt":1}}}}}}"#,
                serde_json::to_string(&project_key(&folder)).unwrap()
            ),
        )
        .unwrap();
        // 임시 파일 자리에 폴더가 있어 다시 쓸 수 없다
        fs::create_dir(fx.data_dir().join(format!("{LEGACY_FILE}.imported.tmp"))).unwrap();
        let err = remove(&fx.db, &fx.state, &fx.sessions, entry.id).unwrap_err();
        assert_eq!(err.kind(), "file_write_failed");
        // 프로젝트는 그대로 남아 있어 다시 시도할 수 있다
        assert_eq!(fx.list().projects.len(), 1);
        fs::remove_dir(fx.data_dir().join(format!("{LEGACY_FILE}.imported.tmp"))).unwrap();
        remove(&fx.db, &fx.state, &fx.sessions, entry.id).unwrap();
        assert!(fx.list().projects.is_empty());
    }

    #[test]
    fn registering_an_already_registered_folder_does_not_look_in_the_old_files() {
        let fx = Fixture::new("proj-legacy-twice");
        let folder = fx.folder("same");
        let entry = fx.add(&folder);
        // 등록한 뒤에 옛 파일이 생겼다 (또는 이름이 바뀐 파일을 누가 가져다 둠) — 이미 있는 프로젝트를 다시 "추가" 해도 읽지 않는다
        let renamed = fx.data_dir().join(format!("{LEGACY_FILE}.imported"));
        fs::write(
            &renamed,
            format!(
                r#"{{"version":1,"projects":{{{}:{{"sessionId":"00000000-0000-4000-8000-0000000000a1","updatedAt":1}}}}}}"#,
                serde_json::to_string(&project_key(&folder)).unwrap()
            ),
        )
        .unwrap();
        assert_eq!(fx.add(&folder).id, entry.id);
        assert_eq!(
            fx.db.read(|conn| last_for_project(conn, entry.id)).unwrap(),
            None
        );
    }

    #[test]
    fn a_read_only_database_lists_and_returns_existing_projects_but_registers_nothing() {
        let fx = Fixture::new("proj-readonly");
        let known = fx.add(&fx.folder("known"));
        // 새 번호 DB 로 다시 연다
        let path = fx._dir.join("data").join(DB_FILE);
        drop(fx.db.clone());
        let newer_db = {
            {
                let conn = rusqlite::Connection::open(&path).unwrap();
                conn.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION + 1)
                    .unwrap();
            }
            AppDb::open(&path)
        };
        assert!(matches!(newer_db.status(), DbStatus::ReadOnly { .. }));
        let listed = list(&newer_db, &fx.env).unwrap();
        assert_eq!(listed.db, DbMode::ReadOnly);
        assert_eq!(listed.projects.len(), 1);

        // 이미 있는 프로젝트는 돌려준다
        fx.state.set_picked(Some(PathBuf::from(&known.path)));
        assert_eq!(
            add(&newer_db, &fx.state, &fx.env, AddRequest::default())
                .unwrap()
                .id,
            known.id
        );
        // 새 폴더 · 고치기 · 빼기 · 열기는 거절
        let other = fx.folder("other");
        fx.state.set_picked(Some(other));
        assert_eq!(
            add(&newer_db, &fx.state, &fx.env, AddRequest::default())
                .unwrap_err()
                .kind(),
            "db_read_only"
        );
        assert_eq!(
            update(&newer_db, &fx.env, known.id, ProjectPatch::default())
                .unwrap_err()
                .kind(),
            "db_read_only"
        );
        assert_eq!(
            remove(&newer_db, &fx.state, &fx.sessions, known.id)
                .unwrap_err()
                .kind(),
            "db_read_only"
        );
        assert_eq!(
            touch(&newer_db, known.id).unwrap_err().kind(),
            "db_read_only"
        );
        // 파일 읽기는 된다
        assert!(requirements_read(&newer_db, &fx.env, known.id).is_ok());
    }

    #[test]
    fn an_unavailable_database_returns_a_recognizable_error_from_every_project_command() {
        let dir = TempDir::new("proj-unavailable");
        let blocker = dir.join("data");
        fs::write(&blocker, "a file where the data folder should be").unwrap();
        let db = AppDb::open(&blocker.join(DB_FILE));
        let state = ProjectsState::new(blocker.clone());
        let env = Env {
            forbidden: ForbiddenSet::new(),
            docs_dir: "docs".into(),
            inspect_deadline: Duration::from_secs(1),
        };
        let kind = |err: AppError| err.kind();
        assert_eq!(kind(list(&db, &env).unwrap_err()), "db_unavailable");
        let work = dir.join("work");
        fs::create_dir(&work).unwrap();
        assert_eq!(
            kind(handle_picked(&db, &state, &env, &work).unwrap_err()),
            "db_unavailable"
        );
        assert_eq!(
            state.picked(),
            None,
            "nothing is held when the pick could not be checked"
        );
        state.set_picked(Some(work));
        assert_eq!(
            kind(add(&db, &state, &env, AddRequest::default()).unwrap_err()),
            "db_unavailable"
        );
        assert_eq!(
            kind(update(&db, &env, 1, ProjectPatch::default()).unwrap_err()),
            "db_unavailable"
        );
        let sessions = idle_sessions(&db);
        assert_eq!(
            kind(remove(&db, &state, &sessions, 1).unwrap_err()),
            "db_unavailable"
        );
        assert_eq!(kind(touch(&db, 1).unwrap_err()), "db_unavailable");
        assert_eq!(
            kind(requirements_read(&db, &env, 1).unwrap_err()),
            "db_unavailable"
        );
        assert_eq!(
            kind(requirements_version(&db, &state, &env, 1).unwrap_err()),
            "db_unavailable"
        );
        assert_eq!(
            kind(requirements_write(&db, &state, &env, 1, "x", None).unwrap_err()),
            "db_unavailable"
        );
    }

    #[test]
    fn only_one_folder_dialog_at_a_time() {
        let state = ProjectsState::new(PathBuf::from("x"));
        let first = state.begin_pick().unwrap();
        assert_eq!(
            state.begin_pick().err().map(|e| e.kind()),
            Some("folder_dialog_open")
        );
        drop(first);
        assert!(state.begin_pick().is_ok());
    }

    #[test]
    fn default_names_are_clean_and_short() {
        assert_eq!(default_name(Path::new("/a/b/cat-album")), "cat-album");
        assert_eq!(default_name(Path::new("/a/b/ spaced ")), "spaced");
        let long = format!("/a/{}", "x".repeat(300));
        assert_eq!(
            default_name(Path::new(&long)).chars().count(),
            NAME_MAX_CHARS
        );
        // 이름이 될 것이 없으면 기본값
        assert_eq!(default_name(Path::new("")), "project");
    }

    #[test]
    fn skills_round_trip_through_their_names() {
        for skill in Skill::ALL {
            assert_eq!(Skill::parse(skill.as_str()), Some(skill));
            assert_eq!(serde_json::to_value(skill).unwrap(), skill.as_str());
        }
        assert_eq!(Skill::parse(""), None);
        assert_eq!(Skill::parse("/WEB-LITE"), None);
    }

    #[test]
    fn results_serialize_in_the_shape_the_screen_reads() {
        let entry = ProjectEntry {
            id: 3,
            path: "C:\\dev\\a".into(),
            name: "a".into(),
            skill: Some(Skill::WebLite),
            created_at: 1,
            last_opened_at: 2,
            folder: FolderState::Missing,
            finding: None,
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "id": 3, "path": "C:\\dev\\a", "name": "a", "skill": "/web-lite",
                "createdAt": 1, "lastOpenedAt": 2, "folder": "missing", "finding": null
            })
        );
        let picked = PickedFolder::Ok(PickedOk {
            path: "p".into(),
            name: "n".into(),
            finding: Some(FolderFinding::HasRequirements),
            existing_id: Some(4),
        });
        assert_eq!(
            serde_json::to_value(&picked).unwrap(),
            serde_json::json!({ "state": "ok", "path": "p", "name": "n", "finding": "hasRequirements", "existingId": 4 })
        );
        let forbidden = PickedFolder::Forbidden(PickedForbidden {
            path: "p".into(),
            reason: ForbiddenReason::DriveRoot,
        });
        assert_eq!(
            serde_json::to_value(&forbidden).unwrap(),
            serde_json::json!({ "state": "forbidden", "path": "p", "reason": "drive_root" })
        );
        assert_eq!(
            serde_json::to_value(requirements::ReadResult::Absent).unwrap(),
            serde_json::json!({ "state": "absent" })
        );
        assert_eq!(
            serde_json::to_value(requirements::WriteResult::Conflict(
                requirements::ConflictInfo { version: None }
            ))
            .unwrap(),
            serde_json::json!({ "state": "conflict", "version": null })
        );
        assert_eq!(
            serde_json::to_value(requirements::ReadResult::Ok(requirements::TextRead {
                text: "t".into(),
                version: "v".into(),
                has_bom: true
            }))
            .unwrap(),
            serde_json::json!({ "state": "ok", "text": "t", "version": "v", "hasBom": true })
        );
    }
}
