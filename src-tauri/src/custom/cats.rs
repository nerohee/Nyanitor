//! 에이전트 ↔ 고양이 연결 — `custom/agent-cats.json` 읽기 · 한 에이전트의 값 쓰기 (D-51).
//!
//! 모양은 화면 쪽 기본 연결 파일(`src/assets/cats/agent-cats.json`)과 같다: `{ "version": 1, "agents": { "<에이전트 이름 | main>": "<고양이 id>" } }`.
//! 설치 스크립트는 이 파일을 읽지 않는다 (앱 전용) — 그래서 설치 없이 **그 파일만 바로 커밋한다** (`git commit -- agent-cats.json`, 종류 `cats`).
//! 다른 적용 안 한 것은 그대로 남는다. 모르는 키 · 순서는 그대로 두고 값 하나만 바꾼다 (`json_edit`). 어느 고양이가 있는지는 화면이 안다 — Rust 는 모양(`^[a-z][a-z0-9-]{0,31}$`)만 본다.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::error::AppError;
use crate::strings;

use super::Env;
use super::fsx::{self, FsError};
use super::history::{self, Access, describe};
use super::id::{valid_cat_id, valid_name};
use super::items::Piece;
use super::json_edit::{self, EditError};
use super::model::{CatsRead, CatsState, CatsWriteResult, CommitKind, CommitOutcome, WriteOutcome};

pub const CATS_FILE: &str = "agent-cats.json";
/// 파일이 아직 없을 때 쓰기의 바탕
const NEW_FILE: &str = "{\n  \"version\": 1\n}\n";

fn parse_agents(text: &str) -> Option<BTreeMap<String, String>> {
    let value: Value = serde_json::from_str(text).ok()?;
    let root = value.as_object()?;
    let mut out = BTreeMap::new();
    match root.get("agents") {
        None | Some(Value::Null) => {}
        Some(Value::Object(agents)) => {
            for (name, cat) in agents {
                if let Some(cat) = cat.as_str() {
                    out.insert(name.clone(), cat.to_string());
                }
            }
        }
        Some(_) => return None,
    }
    Some(out)
}

/// 고양이 연결 읽기 (읽기만 한다 — 잠그지 않는다). 파일에 적힌 것만 돌려준다.
pub fn read(env: &Env) -> CatsRead {
    let unreadable = || CatsRead {
        state: CatsState::Unreadable,
        agents: BTreeMap::new(),
    };
    match Piece::of(fsx::read_text(&env.custom, CATS_FILE)) {
        Piece::Absent => CatsRead {
            state: CatsState::Absent,
            agents: BTreeMap::new(),
        },
        Piece::Text(text) => match parse_agents(&text) {
            Some(agents) => CatsRead {
                state: CatsState::Ok,
                agents,
            },
            None => unreadable(),
        },
        Piece::TooLarge | Piece::Failed(_) => unreadable(),
    }
}

fn refused(reason: &str) -> CatsWriteResult {
    CatsWriteResult {
        outcome: WriteOutcome::Refused,
        reason: Some(reason.to_string()),
        changed: false,
        commit: CommitOutcome::Skipped,
        commit_short: None,
        detail: None,
    }
}

/// 한 에이전트의 고양이를 쓰고 (`None` = 지움) 그 파일만 커밋한다. 이름은 에이전트 이름 규칙 또는 `main`, 고양이 id 는 `^[a-z][a-z0-9-]{0,31}$` — 틀리면 `invalid_input`.
pub fn write(env: &Env, agent: &str, cat: Option<&str>) -> Result<CatsWriteResult, AppError> {
    if agent != "main" && !valid_name(agent) {
        return Err(AppError::InvalidInput(
            "agent name has the wrong shape".into(),
        ));
    }
    if cat.is_some_and(|cat| !valid_cat_id(cat)) {
        return Err(AppError::InvalidInput("cat id has the wrong shape".into()));
    }
    let existing = match Piece::of(fsx::read_text(&env.custom, CATS_FILE)) {
        Piece::Absent => None,
        Piece::Text(text) => {
            if parse_agents(&text).is_none() {
                return Ok(refused("unreadable"));
            }
            Some(text)
        }
        Piece::TooLarge => return Ok(refused("too_large")),
        Piece::Failed(super::model::UnreadableReason::LinkInCustom) => {
            return Ok(refused("link_in_path"));
        }
        Piece::Failed(_) => return Ok(refused("unreadable")),
    };
    let base = existing.clone().unwrap_or_else(|| NEW_FILE.to_string());
    let edited = match json_edit::set_string(&base, &["agents", agent], cat) {
        Ok(text) => text,
        Err(EditError::Malformed | EditError::NotAnObject) => return Ok(refused("unreadable")),
    };
    let unchanged = match &existing {
        Some(text) => fsx::normalize_text(text) == fsx::normalize_text(&edited),
        // 파일이 아직 없는데 지우라는 것 — 만들 이유가 없다
        None => cat.is_none(),
    };
    let mut result = CatsWriteResult {
        outcome: WriteOutcome::Saved,
        reason: None,
        changed: false,
        commit: CommitOutcome::Skipped,
        commit_short: None,
        detail: None,
    };
    if unchanged {
        return Ok(result);
    }
    history::ensure_started(env)?;
    match fsx::write_text(&env.custom, CATS_FILE, &edited) {
        Ok(()) => result.changed = true,
        Err(FsError::Link) => return Ok(refused("link_in_path")),
        Err(FsError::TooLarge) => return Ok(refused("too_large")),
        Err(other) => return Err(AppError::FileWriteFailed(format!("{other:?}"))),
    }
    match history::access(env) {
        Access::Ready(repo) => {
            match repo.commit_only(CATS_FILE, strings::CUSTOM_COMMIT_CATS, CommitKind::Cats) {
                Ok(Some(short)) => {
                    result.commit = CommitOutcome::Committed;
                    result.commit_short = Some(short);
                }
                Ok(None) => result.commit = CommitOutcome::Skipped,
                Err(error) => {
                    result.commit = CommitOutcome::Failed;
                    result.detail = Some(describe(&error));
                }
            }
        }
        Access::NoGit => result.commit = CommitOutcome::NoGit,
        Access::NotStarted | Access::Failed(_) => {
            result.commit = CommitOutcome::Failed;
            result.detail = Some("history is not available".into());
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_string_values_and_refuses_the_wrong_shape() {
        let agents =
            parse_agents("{\"version\":1,\"agents\":{\"main\":\"mukmul\",\"ui\":3}}").unwrap();
        assert_eq!(agents.get("main").map(String::as_str), Some("mukmul"));
        assert!(!agents.contains_key("ui"));
        assert_eq!(parse_agents("{\"version\":1}").unwrap().len(), 0);
        assert!(parse_agents("[]").is_none());
        assert!(parse_agents("{\"agents\": 3}").is_none());
        assert!(parse_agents("not json").is_none());
    }
}
