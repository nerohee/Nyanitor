//! 저장 — 값 · 덧붙임 · 통째 시작 · 저장 · 그만 · 새로 만들기 · 내가 만든 것 지우기 · 원본 바뀜 고르기. `custom/` 에만 쓴다 (약속 3절).
//!
//! 모든 함수는 잠금 안에서 부른다 (`flow`). 쓰기 전에 검사를 모두 하고, 첫 파일을 쓰기 직전에 기록이 없으면 시작한다 (`history::ensure_started`).
//! 화면이 보낸 값의 모양이 틀리면 `invalid_input` 오류, 상태 때문에 못 하는 일(이미 있는 이름 · 통째가 아님 · 둘째 줄 `name` 이 다름 …)은 오류가 아니라
//! `WriteResult::refused(이유)` 로 돌려준다. 파일을 쓰지 못하면 `file_write_failed` (옛 파일은 그대로 — 임시 파일에 쓰고 바꿔 넣는다).

use std::fs;

use serde::Deserialize;

use crate::agents::frontmatter;
use crate::error::AppError;

use super::Env;
use super::fsx::{self, FsError};
use super::history;
use super::id::{ItemId, ItemKind, valid_name};
use super::items::{self, Piece};
use super::main_config;
use super::model::WriteResult;
use super::template;
use super::values::{self, BadValues, EFFORTS, FrontError, MODELS, Values};

/// 새로 만들 때의 소개 글 최대 글자 수
pub const DESCRIPTION_MAX_CHARS: usize = 300;

/// 화면이 보내는 새로 만들기 요청 — 종류 · 이름 · 소개 · 모델 · 수준뿐이다 (경로 없음)
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewItem {
    /// `agent` · `skill`
    pub kind: String,
    pub name: String,
    /// 소개 한 줄
    pub description: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

/// 파일 입출력 오류를 거절 또는 오류로 — 링크 · 너무 큼은 거절 결과, 나머지는 `file_write_failed`
fn fs_refusal(error: FsError) -> Result<WriteResult, AppError> {
    match error {
        FsError::Link => Ok(WriteResult::refused("link_in_path")),
        FsError::TooLarge => Ok(WriteResult::refused("too_large")),
        FsError::NotUtf8 => Ok(WriteResult::refused("not_utf8")),
        FsError::Io(text) => Err(AppError::FileWriteFailed(text)),
    }
}

/// 읽은 조각이 읽을 수 있는 상태가 아니면 거절 결과
fn piece_refusal(piece: &Piece) -> Option<WriteResult> {
    match piece {
        Piece::TooLarge => Some(WriteResult::refused("too_large")),
        Piece::Failed(super::model::UnreadableReason::LinkInCustom) => {
            Some(WriteResult::refused("link_in_path"))
        }
        Piece::Failed(_) => Some(WriteResult::refused("unreadable")),
        _ => None,
    }
}

fn parse_id(text: &str) -> Result<ItemId, AppError> {
    ItemId::parse(text)
}

/// `model` · `effort` 의 모양 확인 — 목록 안의 값만 (이미 그 값이 들어 있는 것은 그대로 두도록 받는다: 목록에 없는 옛 값이 든 파일도 다른 값만 바꿔 저장할 수 있다)
fn check_values(wanted: &Values, already: &[&Values]) -> Result<(), AppError> {
    let ok = |value: &Option<String>, list: &[&str], current: Vec<&Option<String>>| match value {
        None => true,
        Some(v) => {
            list.contains(&v.as_str()) || current.iter().any(|c| c.as_deref() == Some(v.as_str()))
        }
    };
    if !ok(
        &wanted.model,
        &MODELS,
        already.iter().map(|v| &v.model).collect(),
    ) || !ok(
        &wanted.effort,
        &EFFORTS,
        already.iter().map(|v| &v.effort).collect(),
    ) {
        return Err(AppError::InvalidInput(
            "model or effort is not one of the allowed values".into(),
        ));
    }
    Ok(())
}

/// 글 항목 id 인가 (`main` 이 아닌 것)
fn text_item(id: &ItemId) -> bool {
    id.kind() != ItemKind::Main
}

// ───────────────────────────── 값 ─────────────────────────────

/// 값 바꾸기 — `wanted` 가 바라는 값 전체다 (`None` = 원본 값으로 = 그 키를 지운다). 에이전트 · 스킬은 `*.values.yml`,
/// 내가 만든 것은 그 파일 앞머리의 줄을, `main` 은 `custom/config.local.json` 의 `planner` 를 고친다.
pub fn save_values(env: &Env, id_text: &str, wanted: &Values) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if id == ItemId::Main {
        let view = main_config::view(env);
        check_values(wanted, &[&view.mine, &view.current])?;
        return main_config::save(env, wanted);
    }
    let parts = items::load(env, &id);
    for piece in [&parts.source, &parts.mine, &parts.values] {
        if let Some(refused) = piece_refusal(piece) {
            return Ok(refused);
        }
    }
    let source_present = parts.source.text().is_some();
    let file = id.file().unwrap_or_default();
    // 내가 만든 것 (원본에 없음) — 값 파일은 고칠 원본이 없어 설치가 거절하므로 그 파일의 앞머리를 직접 고친다
    if !source_present {
        let Some(text) = parts.mine.text() else {
            return Ok(WriteResult::refused("not_found"));
        };
        let current = match frontmatter::parse(text) {
            Ok(fields) => Values {
                model: fields.non_empty("model").map(str::to_string),
                effort: fields.non_empty("effort").map(str::to_string),
            },
            Err(_) => return Ok(WriteResult::refused("bad_frontmatter")),
        };
        check_values(wanted, &[&current])?;
        let mut edited = text.to_string();
        for (key, value) in [("model", &wanted.model), ("effort", &wanted.effort)] {
            edited = match values::set_front_value(&edited, key, value.as_deref()) {
                Ok(text) => text,
                Err(FrontError::MultiLine) => {
                    return Ok(WriteResult::refused_with(
                        "bad_frontmatter",
                        format!("{key} spans several lines"),
                    ));
                }
                Err(_) => return Ok(WriteResult::refused("bad_frontmatter")),
            };
        }
        if let ItemId::Agent(name) = &id
            && let Some(problem) = template::agent_problem(name, &edited)
        {
            return Ok(WriteResult::refused_with("invalid_agent", problem));
        }
        if fsx::normalize_text(text) == edited {
            return Ok(WriteResult::saved(false));
        }
        history::ensure_started(env)?;
        return match fsx::write_text(&env.custom, &file, &edited) {
            Ok(()) => Ok(WriteResult::saved(true)),
            Err(error) => fs_refusal(error),
        };
    }

    let values_file = id.values_file().unwrap_or_default();
    let existing = parts.values.text();
    let already = items::values_of(&parts);
    check_values(wanted, &[&already])?;
    let rendered = match values::render_values(existing, wanted) {
        Ok(rendered) => rendered,
        Err(BadValues(detail)) => return Ok(WriteResult::refused_with("bad_values", detail)),
    };
    match rendered {
        Some(text) => {
            if existing.map(fsx::normalize_text).as_deref() == Some(text.as_str()) {
                return Ok(WriteResult::saved(false));
            }
            history::ensure_started(env)?;
            match fsx::write_text(&env.custom, &values_file, &text) {
                Ok(()) => Ok(WriteResult::saved(true)),
                Err(error) => fs_refusal(error),
            }
        }
        None => {
            // 남은 키가 없다 — 값 파일을 지운다
            if !parts.values.exists() {
                return Ok(WriteResult::saved(false));
            }
            history::ensure_started(env)?;
            remove_sidecar(env, &id, &values_file)
        }
    }
}

/// 값 · 덧붙임 · `.origin` 파일 하나를 지운다 (스킬 폴더가 비면 폴더도)
fn remove_sidecar(env: &Env, id: &ItemId, rel: &str) -> Result<WriteResult, AppError> {
    if let Err(error) = fsx::remove_file(&env.custom, rel) {
        return fs_refusal(error);
    }
    prune_skill_dir(env, id);
    Ok(WriteResult::saved(true))
}

/// 스킬 폴더가 비었으면 지운다 (빈 폴더를 설치가 어떻게 볼지 알 수 없어 남기지 않는다)
fn prune_skill_dir(env: &Env, id: &ItemId) {
    if let Some(dir) = id.skill_dir() {
        let _ = fsx::remove_dir_if_empty(&env.custom, &dir);
    }
}

// ───────────────────────────── 덧붙임 ─────────────────────────────

/// 덧붙임 글 저장 — 글을 LF 로 맞춰 `*.append.md` 로. 빈 글(공백뿐 포함) = 파일을 지운다. 원본이 있는 에이전트 · 스킬만 (내가 만든 것은 글을 직접 고친다).
pub fn save_append(env: &Env, id_text: &str, text: &str) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if !text_item(&id) {
        return Ok(WriteResult::refused("not_supported"));
    }
    let parts = items::load(env, &id);
    for piece in [&parts.source, &parts.mine] {
        if let Some(refused) = piece_refusal(piece) {
            return Ok(refused);
        }
    }
    // 덧붙임이 크기만 넘는 옛 글은 새 글로 바꾸거나 지울 수 있다
    if let Some(refused) = piece_refusal(&parts.append)
        && !matches!(parts.append, Piece::TooLarge)
    {
        return Ok(refused);
    }
    if parts.source.text().is_none() {
        // 고칠 원본이 없다: 내가 만든 것이면 지원하지 않고, 아무것도 없으면 없는 항목
        return Ok(WriteResult::refused(if parts.mine.exists() {
            "not_supported"
        } else {
            "not_found"
        }));
    }
    let append_file = id.append_file().unwrap_or_default();
    if text.trim().is_empty() {
        if !parts.append.exists() {
            return Ok(WriteResult::saved(false));
        }
        history::ensure_started(env)?;
        return remove_sidecar(env, &id, &append_file);
    }
    let normalized = fsx::normalize_text(text);
    if normalized.len() as u64 > fsx::TEXT_MAX_BYTES {
        return Ok(WriteResult::refused("too_large"));
    }
    if parts.append.text().map(fsx::normalize_text).as_deref() == Some(normalized.as_str()) {
        return Ok(WriteResult::saved(false));
    }
    history::ensure_started(env)?;
    match fsx::write_text(&env.custom, &append_file, &normalized) {
        Ok(()) => Ok(WriteResult::saved(true)),
        Err(error) => fs_refusal(error),
    }
}

// ───────────────────────────── 통째 ─────────────────────────────

/// 통째 시작 — 지금 원본 글을 `custom/` 같은 경로로 복사하고 `.origin` 에 지금 원본 해시를 남긴다 (3-5절). 원본에 있는 것만.
pub fn replace_start(env: &Env, id_text: &str) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if !text_item(&id) {
        return Ok(WriteResult::refused("not_supported"));
    }
    let parts = items::load(env, &id);
    for piece in [&parts.source, &parts.mine, &parts.origin] {
        if let Some(refused) = piece_refusal(piece) {
            return Ok(refused);
        }
    }
    let (Some(source_text), Some(source_hash)) = (parts.source.text(), parts.source_hash.as_ref())
    else {
        return Ok(WriteResult::refused("not_found"));
    };
    if parts.mine.exists() {
        return Ok(WriteResult::refused("already_replaced"));
    }
    // 에이전트는 틀을 지켜야 설치가 받아들인다 — 원본이 틀을 못 지키면 복사해 봐야 쓸 수 없다
    if let ItemId::Agent(name) = &id
        && let Some(problem) = template::agent_problem(name, source_text)
    {
        return Ok(WriteResult::refused_with("invalid_agent", problem));
    }
    let file = id.file().unwrap_or_default();
    let origin_file = id.origin_file().unwrap_or_default();
    history::ensure_started(env)?;
    if let Err(error) = fsx::write_text(&env.custom, &file, source_text) {
        return fs_refusal(error);
    }
    if let Err(error) = fsx::write_text(&env.custom, &origin_file, &format!("{source_hash}\n")) {
        // 글만 남으면 "원본 해시 없음" 알림이 생기므로 되돌려 놓는다
        let _ = fsx::remove_file(&env.custom, &file);
        return fs_refusal(error);
    }
    Ok(WriteResult::saved(true))
}

/// 글 쓸 수 있는 모양인가 — 앞머리 · (에이전트면) 둘째 줄 `name` · `hooks` 없음 · (스킬이면) `name` 이 있으면 폴더 이름과 같음
fn text_problem(id: &ItemId, text: &str) -> Option<WriteResult> {
    let fields = match frontmatter::parse(text) {
        Ok(fields) => fields,
        Err(_) => return Some(WriteResult::refused("bad_frontmatter")),
    };
    match id {
        ItemId::Agent(name) => template::agent_problem(name, text)
            .map(|problem| WriteResult::refused_with("invalid_agent", problem)),
        ItemId::Skill(name) => fields
            .non_empty("name")
            .filter(|n| *n != name)
            .map(|_| WriteResult::refused_with("invalid_agent", format!("`name` must be {name}"))),
        ItemId::Main => None,
    }
}

/// 통째 글 저장 — 통째로 바꾼 것 · 내가 만든 것의 글을 쓴다 (`.origin` 은 그대로). 아니면 `not_replaced`.
pub fn save_text(env: &Env, id_text: &str, text: &str) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if !text_item(&id) {
        return Ok(WriteResult::refused("not_supported"));
    }
    let parts = items::load(env, &id);
    if let Some(refused) = piece_refusal(&parts.mine) {
        // 크기만 넘는 옛 글은 새 글로 바꿀 수 있다
        if !matches!(parts.mine, Piece::TooLarge) {
            return Ok(refused);
        }
    }
    if !parts.mine.exists() {
        return Ok(WriteResult::refused("not_replaced"));
    }
    let normalized = fsx::normalize_text(text);
    if normalized.len() as u64 > fsx::TEXT_MAX_BYTES {
        return Ok(WriteResult::refused("too_large"));
    }
    if let Some(refused) = text_problem(&id, &normalized) {
        return Ok(refused);
    }
    // 메모장이 CRLF · BOM 으로 둔 파일도 같은 글이면 다시 쓰지 않는다 (P9-06 버그 2)
    if parts.mine.text().map(fsx::normalize_text).as_deref() == Some(normalized.as_str()) {
        return Ok(WriteResult::saved(false));
    }
    history::ensure_started(env)?;
    match fsx::write_text(&env.custom, &id.file().unwrap_or_default(), &normalized) {
        Ok(()) => Ok(WriteResult::saved(true)),
        Err(error) => fs_refusal(error),
    }
}

/// 통째 그만 (= 원본으로) — 그 파일과 `.origin` 을 지운다. 값 · 덧붙임은 그대로. 원본에 있는 것만 (원본에서 사라진 것은 `no_origin` — "내 것 유지" 나 지우기로).
pub fn replace_stop(env: &Env, id_text: &str) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if !text_item(&id) {
        return Ok(WriteResult::refused("not_supported"));
    }
    let parts = items::load(env, &id);
    // 크기만 넘는 통째 글 · 모양이 틀린 `.origin` 도 지우는 것은 할 수 있어야 한다 (링크만 막는다 — 지우는 함수가 다시 확인한다)
    if let Some(refused) = piece_refusal(&parts.source) {
        return Ok(refused);
    }
    if !parts.mine.exists() {
        return Ok(WriteResult::refused("not_replaced"));
    }
    if parts.source.text().is_none() {
        return Ok(WriteResult::refused("no_origin"));
    }
    history::ensure_started(env)?;
    if let Err(error) = fsx::remove_file(&env.custom, &id.file().unwrap_or_default()) {
        return fs_refusal(error);
    }
    if let Err(error) = fsx::remove_file(&env.custom, &id.origin_file().unwrap_or_default()) {
        return fs_refusal(error);
    }
    prune_skill_dir(env, &id);
    Ok(WriteResult::saved(true))
}

// ───────────────────────────── 원본 바뀜 ─────────────────────────────

/// 원본 바뀜 — 내 것 유지: `.origin` 을 지금 원본 해시로 다시 쓴다 (원본에서 사라졌으면 `.origin` 만 지운다 — 그 파일은 새 파일처럼 남는다).
/// 고른 뒤는 적용 안 한 것이 된다.
pub fn origin_keep(env: &Env, id_text: &str) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if !text_item(&id) {
        return Ok(WriteResult::refused("not_supported"));
    }
    let parts = items::load(env, &id);
    // 모양이 틀린 `.origin` 은 새로 써서 고칠 수 있어야 하므로 원본 · 내 글만 본다
    for piece in [&parts.source, &parts.mine] {
        if let Some(refused) = piece_refusal(piece) {
            return Ok(refused);
        }
    }
    if !parts.mine.exists() {
        return Ok(WriteResult::refused("not_replaced"));
    }
    let origin_file = id.origin_file().unwrap_or_default();
    match (&parts.source_hash, parts.source.text()) {
        (Some(current), Some(_)) => {
            let line = format!("{current}\n");
            if parts.origin.text().map(fsx::normalize_text).as_deref() == Some(line.as_str()) {
                return Ok(WriteResult::saved(false));
            }
            history::ensure_started(env)?;
            match fsx::write_text(&env.custom, &origin_file, &line) {
                Ok(()) => Ok(WriteResult::saved(true)),
                Err(error) => fs_refusal(error),
            }
        }
        _ => {
            // 원본에서 사라졌다 — `.origin` 만 지운다
            if !parts.origin.exists() {
                return Ok(WriteResult::saved(false));
            }
            history::ensure_started(env)?;
            remove_sidecar(env, &id, &origin_file)
        }
    }
}

// ───────────────────────────── 새로 만들기 · 지우기 ─────────────────────────────

/// 줄바꿈 · 제어 문자가 없는 한 줄인가
fn one_line(text: &str) -> bool {
    !text.chars().any(char::is_control)
}

/// `~/.claude` 에 사용자 자신의 같은 이름 파일이 이미 있는가 — 있으면 설치가 `skip notOurs` 한다 (`.harness-installed` 에 적힌 것은 우리 것)
fn user_owned_exists(env: &Env, id: &ItemId) -> bool {
    let claude = &env.ctx.locations.claude_dir;
    let (path, line) = match id {
        ItemId::Agent(name) => (
            claude.join("agents").join(format!("{name}.md")),
            format!("agent {name}.md"),
        ),
        ItemId::Skill(name) => (claude.join("skills").join(name), format!("skill {name}")),
        ItemId::Main => return false,
    };
    if fs::symlink_metadata(&path).is_err() {
        return false;
    }
    let ours = fs::read_to_string(claude.join(".harness-installed"))
        .map(|text| text.lines().any(|l| l.trim() == line))
        .unwrap_or(false);
    !ours
}

/// 새 에이전트 · 스킬 만들기 — 틀 파일 하나 (`custom/agents/<이름>.md` · `custom/skills/<이름>/SKILL.md`).
/// 거절: 원본에 같은 이름 (`name_in_source`), 내 수정에 이미 있음 (`name_taken`). `~/.claude` 에 사용자 자신의 같은 이름 파일이 있으면 만들되 `notOurs` 로 알린다.
pub fn create(env: &Env, request: &NewItem) -> Result<WriteResult, AppError> {
    let bad = |what: &str| AppError::InvalidInput(format!("new item: {what}"));
    if !valid_name(&request.name) || request.name == "main" {
        return Err(bad("name has the wrong shape"));
    }
    let id = match request.kind.as_str() {
        "agent" => ItemId::agent(&request.name),
        "skill" => ItemId::skill(&request.name),
        _ => return Err(bad("kind must be agent or skill")),
    };
    let description = request.description.trim();
    if description.is_empty()
        || description.chars().count() > DESCRIPTION_MAX_CHARS
        || !one_line(description)
    {
        return Err(bad("description must be one short line"));
    }
    let wanted = Values {
        model: request.model.clone(),
        effort: request.effort.clone(),
    };
    check_values(&wanted, &[])?;
    if !env.source_present() {
        // 원본을 모르면 이름이 겹치는지 알 수 없다
        return Ok(WriteResult::refused("no_source"));
    }
    let file = id.file().unwrap_or_default();
    match fsx::read_source_bytes(&env.source, &file) {
        Ok(None) => {}
        Ok(Some(_)) | Err(FsError::TooLarge | FsError::NotUtf8) => {
            return Ok(WriteResult::refused("name_in_source"));
        }
        Err(error) => return fs_refusal(error),
    }
    // 내 수정에 같은 이름의 것이 하나라도 있으면 (글 · 값 · 덧붙임 · `.origin` · 스킬 폴더) 만들지 않는다
    let taken = [
        Some(file.clone()),
        id.values_file(),
        id.append_file(),
        id.origin_file(),
        id.skill_dir(),
    ]
    .into_iter()
    .flatten()
    .try_fold(false, |taken, rel| {
        fsx::exists(&env.custom, &rel).map(|exists| taken || exists)
    });
    match taken {
        Ok(false) => {}
        Ok(true) => return Ok(WriteResult::refused("name_taken")),
        Err(error) => return fs_refusal(error),
    }
    let text = match &id {
        ItemId::Agent(name) => template::new_agent_text(
            name,
            description,
            wanted.model.as_deref(),
            wanted.effort.as_deref(),
        ),
        _ => template::new_skill_text(
            &request.name,
            description,
            wanted.model.as_deref(),
            wanted.effort.as_deref(),
        ),
    };
    let not_ours = user_owned_exists(env, &id);
    history::ensure_started(env)?;
    if let Err(error) = fsx::write_text(&env.custom, &file, &text) {
        return fs_refusal(error);
    }
    let mut result = WriteResult::saved(true);
    result.not_ours = not_ours;
    Ok(result)
}

/// 내가 만든 것 지우기 — 원본에 없는 에이전트 · 스킬의 글과 딸린 파일(스킬은 폴더째). 원본에 있는 것은 `not_mine` (그만두려면 "원본으로").
/// 원본에서 사라진 통째 파일(`.origin` 이 남은 것)도 이렇게 지운다.
pub fn delete_mine(env: &Env, id_text: &str) -> Result<WriteResult, AppError> {
    let id = parse_id(id_text)?;
    if !text_item(&id) {
        return Ok(WriteResult::refused("not_supported"));
    }
    let parts = items::load(env, &id);
    // 읽을 수 없는 파일(크기 · 글자 · 모양)이어도 지울 수는 있어야 한다 — 링크만 막는다
    for piece in [
        &parts.source,
        &parts.mine,
        &parts.values,
        &parts.append,
        &parts.origin,
    ] {
        if matches!(
            piece,
            Piece::Failed(super::model::UnreadableReason::LinkInCustom)
        ) {
            return Ok(WriteResult::refused("link_in_path"));
        }
    }
    if parts.source.exists() {
        return Ok(WriteResult::refused("not_mine"));
    }
    let any = [&parts.mine, &parts.values, &parts.append, &parts.origin]
        .iter()
        .any(|piece| piece.exists());
    if !any {
        return Ok(WriteResult::refused("not_found"));
    }
    history::ensure_started(env)?;
    let removed = match &id {
        ItemId::Skill(_) => fsx::remove_dir_all(&env.custom, &id.skill_dir().unwrap_or_default()),
        _ => [
            id.file(),
            id.values_file(),
            id.append_file(),
            id.origin_file(),
        ]
        .into_iter()
        .flatten()
        .try_for_each(|rel| fsx::remove_file(&env.custom, &rel)),
    };
    match removed {
        Ok(()) => Ok(WriteResult::saved(true)),
        Err(error) => fs_refusal(error),
    }
}
