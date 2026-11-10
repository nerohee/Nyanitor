//! 목록 · 항목 하나 읽기 (읽기만, 잠금 없음) — 원본(쓸 원본 폴더)의 `agents/*.md` · `skills/*/SKILL.md` + 내 수정에만 있는 새 에이전트 · 스킬 + `main`.
//!
//! 읽는 규칙은 에이전트 · 스킬 목록(`agents` · `skills`)과 같다: 파일 하나 256KB 까지, 링크가 폴더 밖을 가리키면 건너뛴다, 읽을 수 없는 파일은 **그 항목만**
//! `unreadable` + 이유 (D-22). 하네스가 없으면(원본 폴더 없음) `available: false` + 이유 — 오류가 아니다.
//! 항목마다 원본 글 · 값 파일 · 덧붙임 · 통째 글 · `.origin` 을 읽어 합친다 (`resolve`) — 쓰기(`write`)도 같은 읽기를 쓴다.

use std::collections::BTreeSet;
use std::fs;

use crate::agents::frontmatter::{self, Fields, FrontmatterError};
use crate::claude::protocol::truncate_chars;
use crate::error::AppError;

use super::Env;
use super::fsx::{self, FsError};
use super::hash;
use super::history;
use super::id::{ItemId, ItemKind, valid_name};
use super::main_config;
use super::model::{
    CustomList, ItemDetail, ItemInfo, ItemRead, ItemUnreadable, ListEntry, Mark, TextPart,
    UnreadableReason,
};
use super::template;
use super::values::{self, Values};

/// 소개 글의 최대 글자 수 (에이전트 목록과 같다)
const DESCRIPTION_CHARS: usize = 1000;
/// 목록이 읽는 이름 수 상한 (폴더가 비정상으로 클 때 일을 막아 둔다)
const NAMES_MAX: usize = 300;

/// 파일 하나를 읽은 결과
#[derive(Debug, Clone)]
pub enum Piece {
    Absent,
    Text(String),
    TooLarge,
    Failed(UnreadableReason),
}

impl Piece {
    pub fn of(result: Result<Option<String>, FsError>) -> Self {
        match result {
            Ok(None) => Piece::Absent,
            Ok(Some(text)) => Piece::Text(text),
            Err(FsError::TooLarge) => Piece::TooLarge,
            Err(FsError::NotUtf8) => Piece::Failed(UnreadableReason::NotUtf8),
            Err(FsError::Link) => Piece::Failed(UnreadableReason::LinkInCustom),
            Err(FsError::Io(_)) => Piece::Failed(UnreadableReason::ReadFailed),
        }
    }

    pub fn text(&self) -> Option<&str> {
        match self {
            Piece::Text(text) => Some(text),
            _ => None,
        }
    }

    /// 파일이 있는가 (읽지 못했거나 커도 있는 것이다)
    pub fn exists(&self) -> bool {
        !matches!(self, Piece::Absent)
    }

    fn part(&self) -> TextPart {
        match self {
            Piece::Absent => TextPart::Absent,
            Piece::Text(text) => TextPart::Text { text: text.clone() },
            Piece::TooLarge => TextPart::TooLarge,
            Piece::Failed(reason) => TextPart::Unreadable { reason: *reason },
        }
    }
}

/// 항목 하나의 파일들 (글 항목 — 에이전트 · 스킬)
pub struct Parts {
    /// 원본의 글 파일
    pub source: Piece,
    /// 원본 글 파일의 해시 (바이트 그대로 · `.md` 는 LF 로 맞춰) — 원본이 있고 읽을 수 있을 때만
    pub source_hash: Option<String>,
    /// 내 수정의 같은 경로 글 파일 (통째 바꿈 · 내가 만든 것)
    pub mine: Piece,
    pub values: Piece,
    pub append: Piece,
    pub origin: Piece,
}

/// 글 항목의 파일들을 읽는다 (`id` 는 에이전트 · 스킬)
pub fn load(env: &Env, id: &ItemId) -> Parts {
    let file = id.file().unwrap_or_default();
    let sidecar =
        |rel: Option<String>| Piece::of(fsx::read_text(&env.custom, &rel.unwrap_or_default()));
    let (source, source_hash) = if env.source_present() {
        match fsx::read_source_bytes(&env.source, &file) {
            Ok(None) => (Piece::Absent, None),
            Ok(Some(bytes)) => {
                let hash = hash::origin_hash(&file, &bytes);
                (Piece::of(fsx::utf8(bytes).map(Some)), Some(hash))
            }
            Err(error) => (Piece::of(Err(error)), None),
        }
    } else {
        (Piece::Absent, None)
    };
    Parts {
        source,
        source_hash,
        mine: Piece::of(fsx::read_text(&env.custom, &file)),
        values: sidecar(id.values_file()),
        append: sidecar(id.append_file()),
        origin: sidecar(id.origin_file()),
    }
}

/// 글 항목을 읽어 합친 것
pub struct Resolved {
    pub info: ItemInfo,
    pub parts: Parts,
    pub origin_gone: bool,
}

pub enum Loaded {
    /// 원본에도 내 수정에도 없다
    Missing,
    Unreadable(UnreadableReason),
    Ok(Box<Resolved>),
}

fn front_error(error: FrontmatterError) -> UnreadableReason {
    match error {
        FrontmatterError::Missing => UnreadableReason::NoFrontmatter,
        FrontmatterError::Unclosed => UnreadableReason::UnclosedFrontmatter,
    }
}

fn piece_problem(piece: &Piece) -> Option<UnreadableReason> {
    match piece {
        Piece::TooLarge => Some(UnreadableReason::TooLarge),
        Piece::Failed(reason) => Some(*reason),
        _ => None,
    }
}

fn short(fields: &Fields, key: &str) -> Option<String> {
    fields.non_empty(key).map(|v| v.chars().take(64).collect())
}

/// 글 항목(에이전트 · 스킬) 하나를 읽어 합친다
pub fn resolve(env: &Env, id: &ItemId) -> Loaded {
    let parts = load(env, id);
    // 읽을 수 없는 파일이 하나라도 있으면 그 항목은 "읽을 수 없음" (덧붙임이 크기만 넘는 것은 글 보기에서 알린다)
    for piece in [&parts.mine, &parts.source] {
        if let Some(reason) = piece_problem(piece) {
            return Loaded::Unreadable(reason);
        }
    }
    if let Piece::Failed(reason) = &parts.append {
        return Loaded::Unreadable(*reason);
    }
    if let Some(reason) = piece_problem(&parts.values) {
        return Loaded::Unreadable(reason);
    }
    let my_values = match &parts.values {
        Piece::Text(text) => match values::parse_values(text) {
            Ok(values) => Some(values),
            Err(_) => return Loaded::Unreadable(UnreadableReason::BadValues),
        },
        _ => None,
    };
    let recorded = match &parts.origin {
        Piece::Absent => None,
        Piece::Text(text) => match hash::parse_recorded(text) {
            Some(recorded) => Some(recorded),
            None => return Loaded::Unreadable(UnreadableReason::BadOrigin),
        },
        Piece::TooLarge => return Loaded::Unreadable(UnreadableReason::BadOrigin),
        Piece::Failed(reason) => return Loaded::Unreadable(*reason),
    };

    let source_text = parts.source.text();
    let mine_text = parts.mine.text();
    if source_text.is_none() && mine_text.is_none() {
        let sidecars = parts.values.exists() || parts.append.exists() || parts.origin.exists();
        return if sidecars {
            Loaded::Unreadable(UnreadableReason::TargetGone)
        } else {
            Loaded::Missing
        };
    }
    // 앞머리: 원본 값은 원본 글에서(없으면 내 글에서), 소개는 지금 쓰이는 글에서
    let effective = mine_text.or(source_text).unwrap_or_default();
    let effective_fields = match frontmatter::parse(effective) {
        Ok(fields) => fields,
        Err(error) => return Loaded::Unreadable(front_error(error)),
    };
    let origin_fields = match source_text {
        Some(text) => match frontmatter::parse(text) {
            Ok(fields) => fields,
            Err(error) => return Loaded::Unreadable(front_error(error)),
        },
        None => effective_fields.clone(),
    };
    // 내가 만든 에이전트의 틀 (설치가 `invalidAgent` 로 멈추지 않게)
    if let (ItemId::Agent(name), Some(text), None) = (id, mine_text, source_text)
        && template::agent_problem(name, text).is_some()
    {
        return Loaded::Unreadable(UnreadableReason::NameMismatch);
    }

    let mut marks = Vec::new();
    if parts.values.exists() {
        marks.push(Mark::Values);
    }
    if parts.append.text().is_some_and(|t| !t.trim().is_empty())
        || matches!(parts.append, Piece::TooLarge)
    {
        marks.push(Mark::Append);
    }
    match (source_text.is_some(), mine_text.is_some()) {
        (true, true) => marks.push(Mark::Replace),
        (false, true) => marks.push(Mark::Mine),
        _ => {}
    }
    // 통째 바꾼(`.origin` 이 있는) 것만 — 해시가 다르거나 원본에서 사라졌으면 `true`
    let origin_changed = match (&recorded, mine_text.is_some()) {
        (Some(recorded), true) => Some(parts.source_hash.as_ref() != Some(recorded)),
        _ => None,
    };
    let origin_gone = recorded.is_some() && mine_text.is_some() && source_text.is_none();

    let my = my_values.unwrap_or_default();
    let model = short(&origin_fields, "model");
    let effort = short(&origin_fields, "effort");
    let info = ItemInfo {
        id: id.text(),
        kind: id.kind(),
        name: id.name().to_string(),
        description: effective_fields
            .non_empty("description")
            .map(|d| truncate_chars(d, DESCRIPTION_CHARS)),
        file: id.file().unwrap_or_default(),
        current_model: my
            .model
            .clone()
            .or_else(|| short(&effective_fields, "model")),
        current_effort: my
            .effort
            .clone()
            .or_else(|| short(&effective_fields, "effort")),
        model,
        effort,
        my_model: my.model,
        my_effort: my.effort,
        marks,
        origin_changed,
    };
    Loaded::Ok(Box::new(Resolved {
        info,
        parts,
        origin_gone,
    }))
}

fn unreadable_item(id: &ItemId, reason: UnreadableReason) -> ItemUnreadable {
    ItemUnreadable {
        id: id.text(),
        kind: id.kind(),
        name: id.name().to_string(),
        file: id
            .file()
            .unwrap_or_else(|| main_config::CONFIG_FILE.to_string()),
        reason,
    }
}

/// 오케스트레이터 한 줄
fn main_entry(env: &Env) -> ListEntry {
    let view = main_config::view(env);
    if let Some(reason) = view.unreadable {
        return ListEntry::Unreadable(unreadable_item(&ItemId::Main, reason));
    }
    ListEntry::Ok(main_info(&view))
}

fn main_info(view: &main_config::MainView) -> ItemInfo {
    let mut marks = Vec::new();
    if !view.mine.is_empty() {
        marks.push(Mark::Values);
    }
    ItemInfo {
        id: ItemId::Main.text(),
        kind: ItemKind::Main,
        name: "main".to_string(),
        description: None,
        file: main_config::CONFIG_FILE.to_string(),
        model: view.origin.model.clone(),
        effort: view.origin.effort.clone(),
        my_model: view.mine.model.clone(),
        my_effort: view.mine.effort.clone(),
        current_model: view.current.model.clone(),
        current_effort: view.current.effort.clone(),
        marks,
        origin_changed: None,
    }
}

/// 폴더의 `.md` 파일 이름에서 항목 이름들 (원본 폴더의 `agents/`)
fn source_agent_names(env: &Env) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Ok(entries) = fs::read_dir(env.source.join("agents")) else {
        return names;
    };
    for entry in entries.flatten().take(NAMES_MAX * 2) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(stem) = name.strip_suffix(".md")
            && valid_name(stem)
            && stem != "main"
            && !entry.path().is_dir()
        {
            names.insert(stem.to_string());
        }
    }
    names
}

fn source_skill_names(env: &Env) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let Ok(entries) = fs::read_dir(env.source.join("skills")) else {
        return names;
    };
    for entry in entries.flatten().take(NAMES_MAX * 2) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_name(&name) && entry.path().join("SKILL.md").is_file() {
            names.insert(name);
        }
    }
    names
}

/// 내 수정 폴더의 `agents/` 에서 이름들 — `<이름>.md` · `.append.md` · `.values.yml` · `.md.origin` 어느 것이든 그 이름을 낸다
/// (링크가 낀 폴더는 읽지 않는다 — 그 항목은 파일을 읽을 때 `link_in_custom` 이 된다)
fn custom_agent_names(env: &Env) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    if fsx::check_plain(&env.custom, "agents").is_err() {
        return names;
    }
    let Ok(entries) = fs::read_dir(env.custom.join("agents")) else {
        return names;
    };
    for entry in entries.flatten().take(NAMES_MAX * 4) {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stem = name
            .strip_suffix(".append.md")
            .or_else(|| name.strip_suffix(".values.yml"))
            .or_else(|| name.strip_suffix(".md.origin"))
            .or_else(|| name.strip_suffix(".md"));
        if let Some(stem) = stem
            && valid_name(stem)
            && stem != "main"
        {
            names.insert(stem.to_string());
        }
    }
    names
}

fn custom_skill_names(env: &Env) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    if fsx::check_plain(&env.custom, "skills").is_err() {
        return names;
    }
    let Ok(entries) = fs::read_dir(env.custom.join("skills")) else {
        return names;
    };
    for entry in entries.flatten().take(NAMES_MAX * 2) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_name(&name) {
            names.insert(name);
        }
    }
    names
}

/// 목록 전체 (읽기만 한다 — 잠그지 않는다)
pub fn list(env: &Env) -> CustomList {
    let access = history::access(env);
    let history = history::info(&access);
    let unapplied = history::unapplied_of(&access);
    let available = env.source_present();
    let mut items = Vec::new();
    if available {
        items.push(main_entry(env));
    }
    let mut ids: Vec<ItemId> = Vec::new();
    // 이름 순 — 원본에 있는 것 + 내 수정에만 있는 것
    let agents: BTreeSet<String> = source_agent_names(env)
        .into_iter()
        .chain(custom_agent_names(env))
        .collect();
    let skills: BTreeSet<String> = source_skill_names(env)
        .into_iter()
        .chain(custom_skill_names(env))
        .collect();
    ids.extend(agents.iter().map(|name| ItemId::agent(name)));
    ids.extend(skills.iter().map(|name| ItemId::skill(name)));
    for id in ids {
        match resolve(env, &id) {
            Loaded::Missing => {}
            Loaded::Unreadable(reason) => {
                items.push(ListEntry::Unreadable(unreadable_item(&id, reason)));
            }
            Loaded::Ok(resolved) => items.push(ListEntry::Ok(resolved.info)),
        }
    }
    CustomList {
        available,
        reason: (!available).then(|| "no_source".to_string()),
        developer_mode: env.developer,
        history,
        unapplied,
        items,
        roles: if available {
            main_config::roles(env)
        } else {
            Default::default()
        },
    }
}

/// 항목 하나 읽기 — 원본 글(읽기 전용) · 덧붙임 글 · 통째 글 · 값. 화면이 보낸 id 의 모양이 틀리면 `invalid_input`.
pub fn read_item(env: &Env, id_text: &str) -> Result<ItemRead, AppError> {
    let id = ItemId::parse(id_text)?;
    if id == ItemId::Main {
        let view = main_config::view(env);
        if let Some(reason) = view.unreadable {
            return Ok(ItemRead::Unreadable(unreadable_item(&id, reason)));
        }
        return Ok(ItemRead::Ok(Box::new(ItemDetail {
            info: main_info(&view),
            origin_text: TextPart::Absent,
            append_text: TextPart::Absent,
            replace_text: TextPart::Absent,
            origin_gone: false,
        })));
    }
    Ok(match resolve(env, &id) {
        Loaded::Missing => ItemRead::NotFound,
        // 파일 하나가 256KB 를 넘으면 목록에서는 그 항목이 "읽을 수 없음" 이지만, 항목 하나 읽기는 그 부분만 `too_large` 로 알리고 나머지 글은 보여 준다
        Loaded::Unreadable(UnreadableReason::TooLarge) => {
            let parts = load(env, &id);
            let mut marks = Vec::new();
            if parts.values.exists() {
                marks.push(Mark::Values);
            }
            if parts.append.exists() {
                marks.push(Mark::Append);
            }
            match (parts.source.exists(), parts.mine.exists()) {
                (true, true) => marks.push(Mark::Replace),
                (false, true) => marks.push(Mark::Mine),
                _ => {}
            }
            let my = values_of(&parts);
            ItemRead::Ok(Box::new(ItemDetail {
                info: ItemInfo {
                    id: id.text(),
                    kind: id.kind(),
                    name: id.name().to_string(),
                    description: None,
                    file: id.file().unwrap_or_default(),
                    model: None,
                    effort: None,
                    my_model: my.model,
                    my_effort: my.effort,
                    current_model: None,
                    current_effort: None,
                    marks,
                    origin_changed: None,
                },
                origin_text: parts.source.part(),
                append_text: parts.append.part(),
                replace_text: parts.mine.part(),
                origin_gone: false,
            }))
        }
        Loaded::Unreadable(reason) => ItemRead::Unreadable(unreadable_item(&id, reason)),
        Loaded::Ok(resolved) => ItemRead::Ok(Box::new(ItemDetail {
            origin_text: resolved.parts.source.part(),
            append_text: resolved.parts.append.part(),
            replace_text: resolved.parts.mine.part(),
            origin_gone: resolved.origin_gone,
            info: resolved.info,
        })),
    })
}

/// 값 파일의 값 두 개 (읽을 수 없으면 없는 것으로)
pub fn values_of(parts: &Parts) -> Values {
    parts
        .values
        .text()
        .and_then(|text| values::parse_values(text).ok())
        .unwrap_or_default()
}
