//! 항목 id (D-51) — 화면이 보내는 것은 항목 id 와 값 · 글뿐이다. 경로 · 파일 이름은 받지 않는다.
//!
//! - `main` (오케스트레이터 = 하네스 설정 `planner`), `agent:<이름>` (`agents/<이름>.md`), `skill:<이름>` (`skills/<이름>/SKILL.md`)
//! - `<이름>` 은 `^[a-z][a-z0-9-]{0,63}$`. 경로는 이 모듈이 이름에서 만든다 (`/` 로 이은 상대 경로 — 원본 폴더 · 내 수정 폴더 어느 쪽에나 붙인다).
//! - `agents/_common` 은 항목이 아니다 (이름 모양에 `_` 가 없다). `agent:main` 도 거절한다 (`main` 은 오케스트레이터의 이름이다 — 고양이 연결의 키).

use crate::error::AppError;

/// 이름의 최대 길이
pub const NAME_MAX: usize = 64;
/// 고양이 id 의 최대 길이 (`^[a-z][a-z0-9-]{0,31}$`)
pub const CAT_ID_MAX: usize = 32;

/// `^[a-z][a-z0-9-]{0,63}$`
pub fn valid_name(name: &str) -> bool {
    valid_slug(name, NAME_MAX)
}

/// 고양이 id — `^[a-z][a-z0-9-]{0,31}$`
pub fn valid_cat_id(id: &str) -> bool {
    valid_slug(id, CAT_ID_MAX)
}

fn valid_slug(text: &str, max: usize) -> bool {
    let bytes = text.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Main,
    Agent,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemId {
    Main,
    Agent(String),
    Skill(String),
}

impl ItemId {
    /// 화면이 보낸 글을 항목 id 로 — 모양이 틀리면 `invalid_input`
    pub fn parse(text: &str) -> Result<Self, AppError> {
        let bad = || AppError::InvalidInput("item id has the wrong shape".into());
        if text == "main" {
            return Ok(Self::Main);
        }
        if let Some(name) = text.strip_prefix("agent:") {
            return (valid_name(name) && name != "main")
                .then(|| Self::Agent(name.to_string()))
                .ok_or_else(bad);
        }
        if let Some(name) = text.strip_prefix("skill:") {
            return valid_name(name)
                .then(|| Self::Skill(name.to_string()))
                .ok_or_else(bad);
        }
        Err(bad())
    }

    pub fn agent(name: &str) -> Self {
        Self::Agent(name.to_string())
    }

    pub fn skill(name: &str) -> Self {
        Self::Skill(name.to_string())
    }

    pub fn kind(&self) -> ItemKind {
        match self {
            Self::Main => ItemKind::Main,
            Self::Agent(_) => ItemKind::Agent,
            Self::Skill(_) => ItemKind::Skill,
        }
    }

    /// 화면으로 가는 id 글
    pub fn text(&self) -> String {
        match self {
            Self::Main => "main".to_string(),
            Self::Agent(name) => format!("agent:{name}"),
            Self::Skill(name) => format!("skill:{name}"),
        }
    }

    /// 이름 (`main` 은 `main`)
    pub fn name(&self) -> &str {
        match self {
            Self::Main => "main",
            Self::Agent(name) | Self::Skill(name) => name,
        }
    }

    /// 글 파일 — 원본 폴더 · 내 수정 폴더에서 같은 상대 경로 (`agents/<이름>.md` · `skills/<이름>/SKILL.md`). `main` 은 글 파일이 없다.
    pub fn file(&self) -> Option<String> {
        match self {
            Self::Main => None,
            Self::Agent(name) => Some(format!("agents/{name}.md")),
            Self::Skill(name) => Some(format!("skills/{name}/SKILL.md")),
        }
    }

    /// 파일 이름에서 `.md` 를 뺀 앞부분 (값 · 덧붙임 파일 이름을 만든다)
    fn stem(&self) -> Option<String> {
        self.file()
            .map(|file| file.trim_end_matches(".md").to_string())
    }

    /// `*.values.yml` (값만 바꾸기)
    pub fn values_file(&self) -> Option<String> {
        self.stem().map(|stem| format!("{stem}.values.yml"))
    }

    /// `*.append.md` (원본 끝에 덧붙이기)
    pub fn append_file(&self) -> Option<String> {
        self.stem().map(|stem| format!("{stem}.append.md"))
    }

    /// `<글 파일>.origin` (통째 바꾼 파일의 만들 때 원본 해시)
    pub fn origin_file(&self) -> Option<String> {
        self.file().map(|file| format!("{file}.origin"))
    }

    /// 새로 만든 글이 든 폴더 (스킬은 폴더째 지운다)
    pub fn skill_dir(&self) -> Option<String> {
        match self {
            Self::Skill(name) => Some(format!("skills/{name}")),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_pattern() {
        for good in ["a", "harness-builder-ui", "a1", "x-", &"a".repeat(64)] {
            assert!(valid_name(good), "{good}");
        }
        for bad in [
            "",
            "A",
            "Abc",
            "a_b",
            "_common",
            "1a",
            "-a",
            "a b",
            "a/b",
            "a\\b",
            "..",
            "a.b",
            "한글",
            &"a".repeat(65),
        ] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn ids_parse_and_round_trip() {
        assert_eq!(ItemId::parse("main").unwrap(), ItemId::Main);
        assert_eq!(
            ItemId::parse("agent:harness-helper").unwrap(),
            ItemId::agent("harness-helper")
        );
        assert_eq!(
            ItemId::parse("skill:web-full").unwrap().text(),
            "skill:web-full"
        );
        for bad in [
            "",
            "agent:",
            "skill:",
            "agent:_common",
            "agent:../x",
            "agent:a/b",
            "agent:a\\b",
            "agent:A",
            "agent:main",
            "agents:x",
            "agent:x ",
            " agent:x",
            "main ",
            "Main",
            "agent:x\n",
            "agent:x:y",
        ] {
            assert!(ItemId::parse(bad).is_err(), "{bad:?}");
        }
        assert!(ItemId::parse(&format!("agent:{}", "a".repeat(65))).is_err());
        assert!(ItemId::parse(&format!("skill:{}", "a".repeat(64))).is_ok());
    }

    #[test]
    fn paths_are_built_from_the_name_only() {
        let agent = ItemId::agent("harness-designer");
        assert_eq!(agent.file().unwrap(), "agents/harness-designer.md");
        assert_eq!(
            agent.values_file().unwrap(),
            "agents/harness-designer.values.yml"
        );
        assert_eq!(
            agent.append_file().unwrap(),
            "agents/harness-designer.append.md"
        );
        assert_eq!(
            agent.origin_file().unwrap(),
            "agents/harness-designer.md.origin"
        );
        let skill = ItemId::skill("web-full");
        assert_eq!(skill.file().unwrap(), "skills/web-full/SKILL.md");
        assert_eq!(
            skill.values_file().unwrap(),
            "skills/web-full/SKILL.values.yml"
        );
        assert_eq!(
            skill.append_file().unwrap(),
            "skills/web-full/SKILL.append.md"
        );
        assert_eq!(
            skill.origin_file().unwrap(),
            "skills/web-full/SKILL.md.origin"
        );
        assert_eq!(skill.skill_dir().unwrap(), "skills/web-full");
        assert!(ItemId::Main.file().is_none());
    }

    #[test]
    fn cat_ids_follow_their_own_pattern() {
        assert!(valid_cat_id("mukmul"));
        assert!(valid_cat_id(&"a".repeat(32)));
        assert!(!valid_cat_id(&"a".repeat(33)));
        assert!(!valid_cat_id("Mukmul"));
        assert!(!valid_cat_id(""));
        assert!(!valid_cat_id("a/b"));
        assert!(!valid_cat_id("../x"));
    }
}
