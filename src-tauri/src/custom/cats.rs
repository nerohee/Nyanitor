//! 에이전트 ↔ 고양이 연결 — `custom/agent-cats.json` 읽기 · 한 에이전트 또는 여러 에이전트의 값 쓰기 (D-51).
//!
//! 모양은 화면 쪽 기본 연결 파일(`src/assets/cats/agent-cats.json`)과 같다: `{ "version": 1, "agents": { "<에이전트 이름 | main>": "<고양이 id>" } }`.
//! 설치 스크립트는 이 파일을 읽지 않는다 (앱 전용) — 그래서 설치 없이 **그 파일만 바로 커밋한다** (`git commit -- agent-cats.json`, 종류 `cats`).
//! 다른 적용 안 한 것은 그대로 남는다. 모르는 키 · 순서는 그대로 두고 값만 바꾼다 (`json_edit`). 어느 고양이가 있는지는 화면이 안다 — Rust 는 모양(`^[a-z][a-z0-9-]{0,31}$`)만 본다.
//! 고양이 맞바꿈 같은 "여러 줄 한 번에"(`write_many`, D-41)는 파일을 한 번 쓰고 커밋 하나를 남긴다.
//! 파일 읽기 · 쓰기 · 커밋(`read_file` · `write_edits`)은 같은 모양의 앱 전용 파일 `agent-labels.json`(`labels.rs`)과 함께 쓴다.

use std::collections::BTreeMap;

use serde::Deserialize;
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
/// 한 번에 쓸 수 있는 줄 수의 상한 (`write_many`)
pub const CHANGES_MAX: usize = 64;
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
    read_file(env, CATS_FILE)
}

/// `{ "agents": { 이름: 글 } }` 모양의 파일 읽기 (`agent-cats.json` · `agent-labels.json` 이 같이 쓴다)
pub(super) fn read_file(env: &Env, file: &str) -> CatsRead {
    let unreadable = || CatsRead {
        state: CatsState::Unreadable,
        agents: BTreeMap::new(),
    };
    match Piece::of(fsx::read_text(&env.custom, file)) {
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

pub(super) fn refused(reason: &str) -> CatsWriteResult {
    CatsWriteResult {
        outcome: WriteOutcome::Refused,
        reason: Some(reason.to_string()),
        changed: false,
        commit: CommitOutcome::Skipped,
        commit_short: None,
        detail: None,
    }
}

/// 화면이 보내는 한 줄 — `cat` 은 꼭 적어야 하고 (`null` = 지움), 빠뜨리거나 모르는 필드가 있으면 거절한다 (빠뜨린 것이 지움으로 읽히지 않게).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatChange {
    pub agent: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub cat: Option<String>,
}

fn check_agent(agent: &str) -> Result<(), AppError> {
    if agent != "main" && !valid_name(agent) {
        return Err(AppError::InvalidInput(
            "agent name has the wrong shape".into(),
        ));
    }
    Ok(())
}

fn check_cat(cat: Option<&str>) -> Result<(), AppError> {
    if cat.is_some_and(|cat| !valid_cat_id(cat)) {
        return Err(AppError::InvalidInput("cat id has the wrong shape".into()));
    }
    Ok(())
}

/// 한 에이전트의 고양이를 쓰고 (`None` = 지움) 그 파일만 커밋한다. 이름은 에이전트 이름 규칙 또는 `main`, 고양이 id 는 `^[a-z][a-z0-9-]{0,31}$` — 틀리면 `invalid_input`.
pub fn write(env: &Env, agent: &str, cat: Option<&str>) -> Result<CatsWriteResult, AppError> {
    check_agent(agent)?;
    check_cat(cat)?;
    write_edits(
        env,
        CATS_FILE,
        strings::CUSTOM_COMMIT_CATS,
        CommitKind::Cats,
        &[(agent, cat)],
    )
}

/// `write_many` 의 모양 확인 — 1~`CHANGES_MAX` 줄 · 같은 에이전트는 한 번 · 이름과 고양이 id 모양. 하나라도 틀리면 `invalid_input` (파일은 아직 읽지도 않는다).
fn edits_of(changes: &[CatChange]) -> Result<Vec<(&str, Option<&str>)>, AppError> {
    if changes.is_empty() || changes.len() > CHANGES_MAX {
        return Err(AppError::InvalidInput(
            "the number of changes is out of range".into(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut edits = Vec::with_capacity(changes.len());
    for change in changes {
        check_agent(&change.agent)?;
        check_cat(change.cat.as_deref())?;
        if !seen.insert(change.agent.as_str()) {
            return Err(AppError::InvalidInput(
                "the same agent appears twice".into(),
            ));
        }
        edits.push((change.agent.as_str(), change.cat.as_deref()));
    }
    Ok(edits)
}

/// 여러 에이전트의 고양이를 한 번에 쓰고 (고양이 맞바꿈 · 모두 기본값으로) 커밋 하나를 남긴다.
/// 1~`CHANGES_MAX` 줄, 같은 에이전트가 두 번 나오면 `invalid_input`. 하나라도 모양이 틀리면 아무것도 쓰지 않는다 (파일을 읽기 전에 모두 확인한다).
pub fn write_many(env: &Env, changes: &[CatChange]) -> Result<CatsWriteResult, AppError> {
    let edits = edits_of(changes)?;
    write_edits(
        env,
        CATS_FILE,
        strings::CUSTOM_COMMIT_CATS,
        CommitKind::Cats,
        &edits,
    )
}

/// `{ "agents": { 이름: 글 } }` 파일에 `edits`(이름, 글 — `None` = 지움)를 모두 적용해 **한 번** 쓰고 그 파일만 커밋한다. 이름 · 글 모양은 부르는 쪽이 이미 확인했다.
/// 고치는 도중 길을 잃으면(깨진 파일) 아무것도 쓰지 않는다 — 글은 메모리에서 다 고친 뒤에 한 번에 쓴다.
pub(super) fn write_edits(
    env: &Env,
    file: &str,
    subject: &str,
    kind: CommitKind,
    edits: &[(&str, Option<&str>)],
) -> Result<CatsWriteResult, AppError> {
    let existing = match Piece::of(fsx::read_text(&env.custom, file)) {
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
    let mut edited = existing.clone().unwrap_or_else(|| NEW_FILE.to_string());
    for (agent, value) in edits {
        edited = match json_edit::set_string(&edited, &["agents", agent], *value) {
            Ok(text) => text,
            Err(EditError::Malformed | EditError::NotAnObject) => {
                return Ok(refused("unreadable"));
            }
        };
    }
    let unchanged = match &existing {
        Some(text) => fsx::normalize_text(text) == fsx::normalize_text(&edited),
        // 파일이 아직 없는데 모두 지우라는 것 — 만들 이유가 없다
        None => edits.iter().all(|(_, value)| value.is_none()),
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
    match fsx::write_text(&env.custom, file, &edited) {
        Ok(()) => result.changed = true,
        Err(FsError::Link) => return Ok(refused("link_in_path")),
        Err(FsError::TooLarge) => return Ok(refused("too_large")),
        Err(other) => return Err(AppError::FileWriteFailed(format!("{other:?}"))),
    }
    match history::access(env) {
        Access::Ready(repo) => match repo.commit_only(file, subject, kind) {
            Ok(Some(short)) => {
                result.commit = CommitOutcome::Committed;
                result.commit_short = Some(short);
            }
            Ok(None) => result.commit = CommitOutcome::Skipped,
            Err(error) => {
                result.commit = CommitOutcome::Failed;
                result.detail = Some(describe(&error));
            }
        },
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

    fn change(agent: &str, cat: Option<&str>) -> CatChange {
        CatChange {
            agent: agent.to_string(),
            cat: cat.map(str::to_string),
        }
    }

    #[test]
    fn many_changes_keep_their_order_and_allow_a_swap_with_a_removal() {
        let changes = [
            change("ui", Some("nabi")),
            change("system", Some("danchu")),
            change("main", None),
        ];
        assert_eq!(
            edits_of(&changes).unwrap(),
            [
                ("ui", Some("nabi")),
                ("system", Some("danchu")),
                ("main", None)
            ]
        );
    }

    #[test]
    fn many_changes_refuse_a_wrong_count_a_repeated_agent_and_any_wrong_shape() {
        let kind = |changes: &[CatChange]| edits_of(changes).unwrap_err().kind();
        assert_eq!(kind(&[]), "invalid_input");
        let many: Vec<CatChange> = (0..=CHANGES_MAX)
            .map(|i| change(&format!("agent-{i}"), Some("nabi")))
            .collect();
        assert_eq!(kind(&many), "invalid_input");
        assert!(edits_of(&many[..CHANGES_MAX]).is_ok());
        assert_eq!(
            kind(&[change("ui", Some("nabi")), change("ui", None)]),
            "invalid_input"
        );
        // 하나만 틀려도 전체가 거절된다 (맨 뒤의 틀린 줄까지 본다)
        for bad in [
            change("Bad", Some("nabi")),
            change("a/b", None),
            change("", None),
            change("ui", Some("Bad Cat")),
            change("ui", Some("../x")),
            change("ui", Some("")),
        ] {
            assert_eq!(
                kind(&[change("system", Some("nabi")), bad.clone()]),
                "invalid_input",
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_change_needs_both_fields_and_refuses_unknown_ones() {
        let ok: CatChange = serde_json::from_str("{\"agent\":\"ui\",\"cat\":null}").unwrap();
        assert_eq!(ok, change("ui", None));
        let ok: CatChange = serde_json::from_str("{\"agent\":\"ui\",\"cat\":\"nabi\"}").unwrap();
        assert_eq!(ok, change("ui", Some("nabi")));
        // `cat` 을 빠뜨린 것이 지움으로 읽히면 안 된다
        assert!(serde_json::from_str::<CatChange>("{\"agent\":\"ui\"}").is_err());
        assert!(
            serde_json::from_str::<CatChange>("{\"agent\":\"ui\",\"cat\":null,\"x\":1}").is_err()
        );
        assert!(serde_json::from_str::<CatChange>("{\"cat\":\"nabi\"}").is_err());
    }
}
