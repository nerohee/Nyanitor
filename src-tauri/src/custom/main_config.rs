//! 오케스트레이터(`main`)의 모델 · 수준 — 하네스 설정 `config.local.json` 의 `planner` (약속 5절). 앞머리가 아니라 설정 파일이다.
//!
//! - 원본 값 = 원본 폴더의 `config.example.json` 의 `planner`.
//! - 지금 값 = 설치 스크립트와 같은 순서(약속 2-4절)로 처음 찾은 설정의 `planner`: `custom/config.local.json` → 원본의 `config.local.json` → `~/.claude/harness/config.local.json`
//!   (셋 다 없으면 예시).
//! - 저장은 `custom/config.local.json` 의 `planner.model` · `planner.effort` 만 바꾼다. 파일이 없으면 위 순서로 찾은 설정을 바탕으로 만든다 —
//!   모르는 키 · 키 순서 · 들여쓰기는 그대로 (`json_edit`). `None` = 원본 값(예시의 값)으로.

use crate::agents::config as agent_config;
use crate::error::AppError;

use super::Env;
use super::fsx::{self, FsError};
use super::history;
use super::json_edit::{self, EditError};
use super::model::{UnreadableReason, WriteResult};
use super::values::Values;

pub const CONFIG_FILE: &str = "config.local.json";
const EXAMPLE_FILE: &str = "config.example.json";

/// 설정 파일 하나를 읽은 것
enum Cfg {
    Absent,
    Text(String),
    Failed(UnreadableReason),
}

fn cfg_of(result: Result<Option<String>, FsError>) -> Cfg {
    match result {
        Ok(None) => Cfg::Absent,
        Ok(Some(text)) => Cfg::Text(text),
        Err(FsError::TooLarge) => Cfg::Failed(UnreadableReason::TooLarge),
        Err(FsError::Link) => Cfg::Failed(UnreadableReason::LinkInCustom),
        Err(FsError::NotUtf8) => Cfg::Failed(UnreadableReason::NotUtf8),
        Err(FsError::Io(_)) => Cfg::Failed(UnreadableReason::ReadFailed),
    }
}

/// 글의 `planner` 값 (JSON 객체가 아니면 `None`)
fn planner_of(text: &str) -> Option<Values> {
    agent_config::parse(text).map(|config| Values {
        model: config.planner_model,
        effort: config.planner_effort,
    })
}

/// 오케스트레이터의 읽은 값
pub struct MainView {
    pub origin: Values,
    /// 내 값 — `custom/config.local.json` 의 `planner` 중 원본 값과 다른 것
    pub mine: Values,
    pub current: Values,
    pub unreadable: Option<UnreadableReason>,
}

struct Sources {
    example: Cfg,
    custom: Cfg,
    source_local: Cfg,
    installed_local: Cfg,
}

fn read_sources(env: &Env) -> Sources {
    Sources {
        example: cfg_of(fsx::read_source(&env.source, EXAMPLE_FILE)),
        custom: cfg_of(fsx::read_text(&env.custom, CONFIG_FILE)),
        source_local: cfg_of(fsx::read_source(&env.source, CONFIG_FILE)),
        installed_local: cfg_of(fsx::read_source(
            &env.ctx.locations.installed_harness(),
            CONFIG_FILE,
        )),
    }
}

fn view_of(sources: &Sources) -> MainView {
    let origin = match &sources.example {
        Cfg::Text(text) => planner_of(text).unwrap_or_default(),
        _ => Values::default(),
    };
    let mut unreadable = None;
    let mut mine = Values::default();
    match &sources.custom {
        Cfg::Failed(reason) => unreadable = Some(*reason),
        Cfg::Text(text) => match planner_of(text) {
            Some(custom) => {
                mine.model = custom.model.filter(|v| origin.model.as_ref() != Some(v));
                mine.effort = custom.effort.filter(|v| origin.effort.as_ref() != Some(v));
            }
            None => unreadable = Some(UnreadableReason::BadConfig),
        },
        Cfg::Absent => {}
    }
    // 설치 스크립트와 같은 순서로 처음 찾은 설정 (찾은 것이 깨졌으면 지금 값은 모른다)
    let current = [
        &sources.custom,
        &sources.source_local,
        &sources.installed_local,
    ]
    .into_iter()
    .find_map(|cfg| match cfg {
        Cfg::Text(text) => Some(planner_of(text).unwrap_or_default()),
        Cfg::Failed(_) => Some(Values::default()),
        Cfg::Absent => None,
    })
    .unwrap_or_else(|| origin.clone());
    MainView {
        origin,
        mine,
        current,
        unreadable,
    }
}

/// 오케스트레이터의 값 (읽기만 한다)
pub fn view(env: &Env) -> MainView {
    view_of(&read_sources(env))
}

fn edit_refusal(error: EditError) -> WriteResult {
    WriteResult::refused_with(
        "bad_config",
        match error {
            EditError::Malformed => "the config file could not be read",
            EditError::NotAnObject => "`planner` is not an object",
        },
    )
}

/// 오케스트레이터의 모델 · 수준을 저장한다 (`None` = 원본 값으로). 쓰기 전에 기록이 없으면 시작한다.
/// 이미 그 모양이면 쓰지 않는다 (`changed: false`) — 설정이 없는데 지금 설정 그대로라면 `custom/config.local.json` 을 새로 만들지도 않는다.
pub fn save(env: &Env, wanted: &Values) -> Result<WriteResult, AppError> {
    let sources = read_sources(env);
    let view = view_of(&sources);
    let custom_text = match &sources.custom {
        Cfg::Failed(UnreadableReason::TooLarge) => return Ok(WriteResult::refused("too_large")),
        Cfg::Failed(UnreadableReason::LinkInCustom) => {
            return Ok(WriteResult::refused("link_in_path"));
        }
        Cfg::Failed(_) => return Ok(WriteResult::refused("bad_config")),
        Cfg::Text(text) => {
            if planner_of(text).is_none() {
                return Ok(WriteResult::refused("bad_config"));
            }
            Some(text.clone())
        }
        Cfg::Absent => None,
    };
    // 바탕 글 — 내 설정, 없으면 설치 스크립트와 같은 순서로 처음 찾은 JSON 객체
    let base = match &custom_text {
        Some(text) => text.clone(),
        None => [
            &sources.source_local,
            &sources.installed_local,
            &sources.example,
        ]
        .into_iter()
        .find_map(|cfg| match cfg {
            Cfg::Text(text) if planner_of(text).is_some() => Some(text.clone()),
            _ => None,
        })
        .unwrap_or_else(|| "{}\n".to_string()),
    };
    let mut edited = base.clone();
    for (key, wanted_value, origin_value) in [
        ("model", &wanted.model, &view.origin.model),
        ("effort", &wanted.effort, &view.origin.effort),
    ] {
        // `None` = 원본 값으로 (예시에 값이 없으면 그 키를 지운다)
        let target = wanted_value.as_ref().or(origin_value.as_ref());
        edited = match json_edit::set_string(&edited, &["planner", key], target.map(String::as_str))
        {
            Ok(text) => text,
            Err(error) => return Ok(edit_refusal(error)),
        };
    }
    let unchanged = match &custom_text {
        Some(text) => fsx::normalize_text(text) == fsx::normalize_text(&edited),
        // 설정이 아직 없다 — 바탕의 값이 이미 원하는 값이면 새로 만들 이유가 없다
        None => planner_of(&base) == planner_of(&edited),
    };
    if unchanged {
        return Ok(WriteResult::saved(false));
    }
    history::ensure_started(env)?;
    match fsx::write_text(&env.custom, CONFIG_FILE, &edited) {
        Ok(()) => Ok(WriteResult::saved(true)),
        Err(FsError::Link) => Ok(WriteResult::refused("link_in_path")),
        Err(FsError::TooLarge) => Ok(WriteResult::refused("too_large")),
        Err(other) => Err(AppError::FileWriteFailed(format!("{other:?}"))),
    }
}
