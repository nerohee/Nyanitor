//! 설치된 스킬 읽기 (P6-02) — 채팅 입력줄이 고를 목록: `<설정 폴더>/skills/*/SKILL.md` 의 앞머리.
//!
//! 스킬은 채팅의 첫 메시지로 보낸다 (예: `/desktop-app requirements.md`) — stream-json 세션에 슬래시 스킬을 보내면 실행된다 (`scripts/cli-probe` 의 `skill` 시나리오).
//! 읽기만 한다 (파일을 고치지도 만들지도 않는다). 앞머리 읽기는 에이전트와 같다 (`agents::frontmatter`).
//!
//! 규칙 (에이전트 목록과 같은 결):
//! - 보는 것: `<설정 폴더>/skills/` 바로 아래의 폴더 중 `SKILL.md` 가 있는 것. `SKILL.md` 없는 폴더 · 파일 · 숨은 이름(`.`)은 스킬이 아니라서 건너뛴다.
//!   링크는 따라가되 가리키는 곳이 `skills/` 밖이면 건너뛴다. 하네스를 링크로 설치하면 스킬 폴더가 하네스 폴더의 `skills/` 로 이어지므로 그곳은 안으로 본다.
//! - 필수 필드 없음: `name` 이 없으면 폴더 이름이 이름이다. 있으면 폴더 이름과 같아야 한다 (다르면 부르는 이름을 알 수 없어 "읽을 수 없음").
//!   `description` · `argument-hint` 는 없으면 `None`. `user-invocable: false` 는 사용자가 부를 수 없는 스킬이라 `userInvocable: false` 로 내려보낸다 (화면이 고른다).
//! - 깨진 파일은 그 항목만 `unreadable`, 나머지는 그대로. 하네스(`<설정 폴더>/harness`)가 없으면 빈 목록과 `no_harness` — 오류가 아니다.
//! - 파일은 앞 64KB 만 읽는다 (앞머리만 필요하다 — 본문이 긴 스킬이 "읽을 수 없음" 이 되지 않게). 앞머리가 64KB 안에 안 닫히면 `too_large`.
//! - 하네스 것(`harness`) · 내 것(`mine`): `<설정 폴더>/harness/skills/` 에 같은 이름의 폴더가 있으면 하네스 것이다 (그 폴더가 지금 설치돼 쓰이는 원본이다 —
//!   원본 저장소가 WSL 경로여도 그 경로를 읽지 않는다).
//! - 화면으로 가는 값에 경로는 없다 (폴더 이름만). 화면에서 경로 · 이름을 받는 길은 없다 — 위치는 환경 변수 `CLAUDE_CONFIG_DIR` 로만 바뀐다.

pub mod commands;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::agents::frontmatter;
use crate::claude::protocol::truncate_chars;
use crate::harness::locate;

/// 앞머리를 읽는 크기 (넘으면 앞부분만 본다)
pub const MAX_FILE_BYTES: u64 = 64 * 1024;
/// 읽는 스킬 폴더의 최대 개수
const MAX_SKILLS: usize = 300;
/// 소개 글의 최대 글자 수
const DESCRIPTION_CHARS: usize = 1000;
/// 인자 안내 글의 최대 글자 수
const HINT_CHARS: usize = 200;
/// 스킬 이름(= 폴더 이름)의 최대 길이
const NAME_MAX: usize = 64;
const SKILL_FILE: &str = "SKILL.md";

/// 누가 설치한 스킬인가
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    /// 하네스가 설치한 것 (`<설정 폴더>/harness/skills/` 에 같은 이름이 있다)
    Harness,
    /// 내가 만든 것 · 다른 곳에서 받은 것
    Mine,
}

/// 읽은 스킬 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    /// 폴더 이름 = `name`
    pub name: String,
    /// 채팅 첫 메시지에 쓰는 글 (`/<name>`)
    pub command: String,
    pub description: Option<String>,
    /// 인자 안내 (예: `[요구사항.md 경로]`)
    pub argument_hint: Option<String>,
    pub origin: SkillOrigin,
    /// 사용자가 부를 수 있는가 (`user-invocable: false` 면 `false`)
    pub user_invocable: bool,
}

/// 읽을 수 없는 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnreadableReason {
    /// 앞머리가 앞 64KB 안에 닫히지 않는다
    TooLarge,
    /// 열 수 없거나 읽다가 실패했다
    ReadFailed,
    NotUtf8,
    /// 첫 줄이 `---` 가 아니다
    NoFrontmatter,
    /// 닫는 `---` 가 없다
    UnclosedFrontmatter,
    /// `name` 이 폴더 이름과 다르다
    NameMismatch,
    /// 폴더 이름이 스킬 이름으로 쓸 수 없는 모양이다 (`/` 뒤에 그대로 붙으므로 영문 · 숫자 · `-` `_` `.` 만)
    InvalidName,
}

/// 읽을 수 없는 스킬 폴더 (나머지 스킬에는 영향이 없다)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUnreadable {
    /// 폴더 이름 (경로 아님)
    pub folder: String,
    pub origin: SkillOrigin,
    pub reason: UnreadableReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum SkillEntry {
    Ok(SkillInfo),
    Unreadable(SkillUnreadable),
}

/// 목록 전체의 상태
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillsState {
    Ok,
    /// `<설정 폴더>/harness` 가 없다 — 하네스가 설치되지 않았다. 목록은 비었다
    NoHarness,
    /// 설정 폴더 위치를 정할 수 없다 (홈 폴더 없음 · `CLAUDE_CONFIG_DIR` 가 상대 경로)
    LocationUnusable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsList {
    pub state: SkillsState,
    /// 폴더 이름 순
    pub skills: Vec<SkillEntry>,
}

impl SkillsList {
    fn empty(state: SkillsState) -> Self {
        Self {
            state,
            skills: Vec::new(),
        }
    }
}

/// 이 프로세스의 환경(`CLAUDE_CONFIG_DIR` · 홈)으로 정한 위치에서 읽는다.
pub fn list_here() -> SkillsList {
    match locate::locations_here() {
        Ok(locations) => list(&locations.claude_dir),
        Err(_) => SkillsList::empty(SkillsState::LocationUnusable),
    }
}

/// `claude_dir`(`~/.claude`)에서 읽는다. 어떤 실패도 오류로 돌려주지 않는다 — 읽을 수 없는 것은 그 항목의 상태로 남는다.
pub fn list(claude_dir: &Path) -> SkillsList {
    let harness_dir = claude_dir.join("harness");
    // 링크 · 정션이면 대상을 본다 (설치가 링크일 수 있다)
    if !harness_dir.is_dir() {
        return SkillsList::empty(SkillsState::NoHarness);
    }
    let harness_skills = harness_dir.join("skills");
    let folders = scan_skill_folders(&claude_dir.join("skills"), &harness_skills);
    let skills = folders
        .iter()
        .map(|folder| {
            let origin = if harness_skills.join(&folder.name).is_dir() {
                SkillOrigin::Harness
            } else {
                SkillOrigin::Mine
            };
            read_skill(folder, origin)
        })
        .collect();
    SkillsList {
        state: SkillsState::Ok,
        skills,
    }
}

/// 폴더 안의 스킬 하나
struct SkillFolder {
    /// 폴더 이름
    name: String,
    /// `SKILL.md` 를 읽을 곳 (링크를 푼 실제 경로). 읽을 수 없는 이유를 이미 알면 그 이유
    file: Result<PathBuf, UnreadableReason>,
}

fn is_skill_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && name.len() <= NAME_MAX
}

/// `skills/` 바로 아래의 스킬 폴더들. `SKILL.md` 없는 폴더 · 파일 · 숨은 이름 · 끊어진 링크 · 밖을 가리키는 링크는 건너뛴다. 폴더 이름 순.
/// "안" 으로 보는 곳은 `skills/` 자신과 하네스의 `skills/` (링크로 설치한 스킬이 거기로 이어진다).
fn scan_skill_folders(skills_dir: &Path, harness_skills: &Path) -> Vec<SkillFolder> {
    let Ok(base) = fs::canonicalize(skills_dir) else {
        return Vec::new();
    };
    let mut roots = vec![base.clone()];
    if let Ok(real) = fs::canonicalize(harness_skills) {
        roots.push(real);
    }
    let inside = |path: &Path| roots.iter().any(|root| path.starts_with(root));
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut folders = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if name.starts_with('.') {
            continue;
        }
        let Ok(real) = fs::canonicalize(entry.path()) else {
            continue; // 끊어진 링크
        };
        // 링크가 밖을 가리키면 쓰지 않는다 (다른 곳의 파일을 읽게 되지 않도록)
        if !inside(&real) || !real.is_dir() {
            continue;
        }
        let skill_file = real.join(SKILL_FILE);
        let file = match fs::symlink_metadata(&skill_file) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue, // 스킬이 아닌 폴더
            Err(_) => Err(UnreadableReason::ReadFailed),
            Ok(_) => match fs::canonicalize(&skill_file) {
                Err(_) => Err(UnreadableReason::ReadFailed), // 끊어진 링크 파일
                Ok(real_file) if !inside(&real_file) || !real_file.is_file() => continue,
                Ok(real_file) => Ok(real_file),
            },
        };
        folders.push(SkillFolder { name, file });
        if folders.len() >= MAX_SKILLS {
            break;
        }
    }
    folders.sort_by_cached_key(|folder| folder.name.to_lowercase());
    folders
}

/// 앞 `MAX_FILE_BYTES` 만 읽는다. 돌려주는 `bool` 은 더 있어서 잘랐는가.
fn read_head(path: &Path) -> Result<(String, bool), UnreadableReason> {
    let file = fs::File::open(path).map_err(|_| UnreadableReason::ReadFailed)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UnreadableReason::ReadFailed)?;
    let cut = bytes.len() as u64 > MAX_FILE_BYTES;
    if cut {
        bytes.truncate(usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, cut)),
        // 자른 자리가 글자 한가운데면 그 글자만 버린다 (앞부분은 멀쩡하다)
        Err(err) if cut && err.utf8_error().error_len().is_none() => {
            let valid = err.utf8_error().valid_up_to();
            let bytes = err.into_bytes();
            String::from_utf8(bytes[..valid].to_vec())
                .map(|text| (text, true))
                .map_err(|_| UnreadableReason::NotUtf8)
        }
        Err(_) => Err(UnreadableReason::NotUtf8),
    }
}

/// `user-invocable` 값: `false`(대소문자 · 따옴표 가리지 않음)만 "부를 수 없음", 나머지는 부를 수 있다
fn user_invocable(value: Option<&str>) -> bool {
    !value.is_some_and(|text| text.trim().eq_ignore_ascii_case("false"))
}

fn read_skill(folder: &SkillFolder, origin: SkillOrigin) -> SkillEntry {
    let unreadable = |reason| {
        SkillEntry::Unreadable(SkillUnreadable {
            folder: folder.name.clone(),
            origin,
            reason,
        })
    };
    if !is_skill_name(&folder.name) {
        return unreadable(UnreadableReason::InvalidName);
    }
    let path = match &folder.file {
        Ok(path) => path,
        Err(reason) => return unreadable(*reason),
    };
    let (text, cut) = match read_head(path) {
        Ok(read) => read,
        Err(reason) => return unreadable(reason),
    };
    let fields = match frontmatter::parse(&text) {
        Ok(fields) => fields,
        Err(frontmatter::FrontmatterError::Missing) => {
            return unreadable(UnreadableReason::NoFrontmatter);
        }
        // 앞 64KB 안에 안 닫혔는데 파일이 더 있다 = 너무 큰 앞머리
        Err(frontmatter::FrontmatterError::Unclosed) if cut => {
            return unreadable(UnreadableReason::TooLarge);
        }
        Err(frontmatter::FrontmatterError::Unclosed) => {
            return unreadable(UnreadableReason::UnclosedFrontmatter);
        }
    };
    if fields
        .non_empty("name")
        .is_some_and(|name| name != folder.name)
    {
        return unreadable(UnreadableReason::NameMismatch);
    }
    SkillEntry::Ok(SkillInfo {
        command: format!("/{}", folder.name),
        name: folder.name.clone(),
        description: fields
            .non_empty("description")
            .map(|text| truncate_chars(text, DESCRIPTION_CHARS)),
        argument_hint: fields
            .non_empty("argument-hint")
            .map(|text| truncate_chars(text, HINT_CHARS)),
        origin,
        user_invocable: user_invocable(fields.get("user-invocable")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    /// 설정 폴더 하나 (`harness/` 와 `skills/` 가 있다)
    fn claude_dir(name: &str) -> TempDir {
        let dir = TempDir::new(name);
        fs::create_dir_all(dir.join("harness").join("skills")).unwrap();
        fs::create_dir_all(dir.join("skills")).unwrap();
        dir
    }

    fn skill_file(dir: &TempDir, name: &str, text: &str) {
        let folder = dir.join("skills").join(name);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(SKILL_FILE), text).unwrap();
    }

    /// 하네스가 설치한 것으로 보이게 `harness/skills/<name>` 폴더도 둔다
    fn harness_skill(dir: &TempDir, name: &str, text: &str) {
        skill_file(dir, name, text);
        fs::create_dir_all(dir.join("harness").join("skills").join(name)).unwrap();
    }

    fn plain(name: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: {name} 소개\nargument-hint: \"[인자]\"\ndisable-model-invocation: true\nmodel: opus\n---\n\n# 본문\n$ARGUMENTS\n"
        )
    }

    fn infos(list: &SkillsList) -> Vec<&SkillInfo> {
        list.skills
            .iter()
            .filter_map(|entry| match entry {
                SkillEntry::Ok(info) => Some(info),
                SkillEntry::Unreadable(_) => None,
            })
            .collect()
    }

    fn info<'a>(list: &'a SkillsList, name: &str) -> &'a SkillInfo {
        infos(list)
            .into_iter()
            .find(|info| info.name == name)
            .unwrap_or_else(|| panic!("no ok skill {name}: {list:?}"))
    }

    fn unreadable<'a>(list: &'a SkillsList, folder: &str) -> &'a SkillUnreadable {
        list.skills
            .iter()
            .find_map(|entry| match entry {
                SkillEntry::Unreadable(u) if u.folder == folder => Some(u),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no unreadable skill {folder}: {list:?}"))
    }

    #[test]
    fn a_skill_is_read_with_its_command_description_and_argument_hint() {
        let dir = claude_dir("skills-basic");
        skill_file(&dir, "desktop-app", &plain("desktop-app"));
        let list = list(&dir);
        assert_eq!(list.state, SkillsState::Ok);
        let skill = info(&list, "desktop-app");
        assert_eq!(skill.command, "/desktop-app");
        assert_eq!(skill.description.as_deref(), Some("desktop-app 소개"));
        assert_eq!(skill.argument_hint.as_deref(), Some("[인자]"));
        assert!(skill.user_invocable);
        assert_eq!(skill.origin, SkillOrigin::Mine);
    }

    #[test]
    fn harness_skills_and_my_own_are_told_apart_by_the_harness_skills_folder() {
        let dir = claude_dir("skills-origin");
        harness_skill(&dir, "web-full", &plain("web-full"));
        harness_skill(&dir, "web-lite", &plain("web-lite"));
        skill_file(&dir, "thread-draft", &plain("thread-draft"));
        // 같은 이름이 하네스 쪽에는 파일로만 있으면 폴더가 아니라서 내 것이다
        fs::write(dir.join("harness").join("skills").join("only-a-file"), "x").unwrap();
        skill_file(&dir, "only-a-file", &plain("only-a-file"));
        let list = list(&dir);
        assert_eq!(info(&list, "web-full").origin, SkillOrigin::Harness);
        assert_eq!(info(&list, "web-lite").origin, SkillOrigin::Harness);
        assert_eq!(info(&list, "thread-draft").origin, SkillOrigin::Mine);
        assert_eq!(info(&list, "only-a-file").origin, SkillOrigin::Mine);
        // 하네스에만 있고 `skills/` 에 안 깔린 것은 목록에 없다 (설치되지 않은 것)
        fs::create_dir_all(dir.join("harness").join("skills").join("not-installed")).unwrap();
        assert!(
            infos(&super::list(&dir))
                .iter()
                .all(|s| s.name != "not-installed")
        );
    }

    #[test]
    fn the_name_defaults_to_the_folder_and_must_match_when_given() {
        let dir = claude_dir("skills-name");
        skill_file(&dir, "no-name", "---\ndescription: d\n---\n");
        skill_file(&dir, "mismatch", "---\nname: other\ndescription: d\n---\n");
        skill_file(&dir, "Case", "---\nname: case\ndescription: d\n---\n");
        skill_file(&dir, "blank-name", "---\nname:\ndescription: d\n---\n");
        let list = list(&dir);
        assert_eq!(info(&list, "no-name").command, "/no-name");
        assert_eq!(info(&list, "blank-name").command, "/blank-name");
        assert_eq!(
            unreadable(&list, "mismatch").reason,
            UnreadableReason::NameMismatch
        );
        assert_eq!(
            unreadable(&list, "Case").reason,
            UnreadableReason::NameMismatch,
            "대소문자도 가린다"
        );
    }

    #[test]
    fn folder_names_that_cannot_follow_a_slash_are_unreadable() {
        let dir = claude_dir("skills-badname");
        for bad in ["has space", "-dash-first", "한글", "a(b)", "x;y"] {
            skill_file(&dir, bad, "---\ndescription: d\n---\n");
        }
        skill_file(
            &dir,
            &"n".repeat(NAME_MAX + 1),
            "---\ndescription: d\n---\n",
        );
        skill_file(&dir, &"m".repeat(NAME_MAX), "---\ndescription: d\n---\n");
        skill_file(&dir, "dotted.name_ok-1", "---\ndescription: d\n---\n");
        let list = list(&dir);
        assert_eq!(list.skills.len(), 8);
        for bad in ["has space", "-dash-first", "한글", "a(b)", "x;y"] {
            assert_eq!(
                unreadable(&list, bad).reason,
                UnreadableReason::InvalidName,
                "{bad}"
            );
        }
        assert_eq!(
            unreadable(&list, &"n".repeat(NAME_MAX + 1)).reason,
            UnreadableReason::InvalidName
        );
        assert_eq!(infos(&list).len(), 2);
    }

    #[test]
    fn user_invocable_false_is_reported_and_everything_else_can_be_called() {
        let dir = claude_dir("skills-invocable");
        for (name, value) in [
            ("a-false", "user-invocable: false"),
            ("b-upper", "user-invocable: False"),
            ("c-quoted", "user-invocable: \"false\""),
            ("d-true", "user-invocable: true"),
            ("e-odd", "user-invocable: maybe"),
            ("f-empty", "user-invocable:"),
        ] {
            skill_file(&dir, name, &format!("---\n{value}\n---\n"));
        }
        skill_file(&dir, "g-absent", "---\ndescription: d\n---\n");
        let list = list(&dir);
        let called = |name: &str| info(&list, name).user_invocable;
        assert!(!called("a-false") && !called("b-upper") && !called("c-quoted"));
        assert!(called("d-true") && called("e-odd") && called("f-empty") && called("g-absent"));
    }

    #[test]
    fn every_unreadable_reason_is_reported_for_its_own_folder_only() {
        let dir = claude_dir("skills-reasons");
        skill_file(&dir, "good", &plain("good"));
        skill_file(&dir, "no-front", "just text\n");
        skill_file(&dir, "unclosed", "---\nname: unclosed\ndescription: d\n");
        skill_file(&dir, "empty", "");
        let folder = dir.join("skills").join("not-utf8");
        fs::create_dir_all(&folder).unwrap();
        fs::write(
            folder.join(SKILL_FILE),
            [b'-', b'-', b'-', b'\n', 0xff, 0xfe],
        )
        .unwrap();
        let list = list(&dir);
        assert_eq!(list.skills.len(), 5);
        assert_eq!(
            info(&list, "good").description.as_deref(),
            Some("good 소개")
        );
        assert_eq!(
            unreadable(&list, "no-front").reason,
            UnreadableReason::NoFrontmatter
        );
        assert_eq!(
            unreadable(&list, "unclosed").reason,
            UnreadableReason::UnclosedFrontmatter
        );
        assert_eq!(
            unreadable(&list, "empty").reason,
            UnreadableReason::NoFrontmatter
        );
        assert_eq!(
            unreadable(&list, "not-utf8").reason,
            UnreadableReason::NotUtf8
        );
    }

    #[test]
    fn only_the_front_of_a_big_file_is_read_so_a_long_body_is_fine() {
        let dir = claude_dir("skills-big");
        let body = "본문 줄\n".repeat(30_000); // 약 300KB
        skill_file(
            &dir,
            "long-body",
            &format!("---\nname: long-body\ndescription: 긴 본문\n---\n{body}"),
        );
        let list = list(&dir);
        assert_eq!(
            info(&list, "long-body").description.as_deref(),
            Some("긴 본문")
        );
        // 앞머리 자체가 앞 64KB 안에 안 닫히면 너무 큰 것
        let huge = "x".repeat(usize::try_from(MAX_FILE_BYTES).unwrap() + 10);
        skill_file(
            &dir,
            "huge-front",
            &format!("---\nname: huge-front\ndescription: {huge}\n---\n"),
        );
        let list = super::list(&dir);
        assert_eq!(
            unreadable(&list, "huge-front").reason,
            UnreadableReason::TooLarge
        );
    }

    #[test]
    fn a_file_of_exactly_the_limit_and_one_byte_more_are_both_fine_when_the_front_is_closed() {
        let dir = claude_dir("skills-limit");
        let head = "---\ndescription: d\n---\n";
        let limit = usize::try_from(MAX_FILE_BYTES).unwrap();
        skill_file(
            &dir,
            "exact",
            &format!("{head}{}", "a".repeat(limit - head.len())),
        );
        skill_file(
            &dir,
            "plus-one",
            &format!("{head}{}", "a".repeat(limit - head.len() + 1)),
        );
        let list = list(&dir);
        assert!(info(&list, "exact").description.is_some());
        assert!(info(&list, "plus-one").description.is_some());
    }

    #[test]
    fn a_multibyte_character_cut_at_the_limit_does_not_make_the_file_unreadable() {
        let dir = claude_dir("skills-cut");
        let head = "---\ndescription: d\n---\n";
        let limit = usize::try_from(MAX_FILE_BYTES).unwrap();
        // 한글(3바이트)이 한도 한가운데에 걸리게 채운다
        let filler = "a".repeat(limit - head.len() - 1);
        skill_file(&dir, "cut", &format!("{head}{filler}가나다라마"));
        let list = list(&dir);
        assert_eq!(info(&list, "cut").description.as_deref(), Some("d"));
    }

    #[test]
    fn bom_crlf_block_descriptions_and_long_text_are_handled() {
        let dir = claude_dir("skills-forms");
        skill_file(
            &dir,
            "bom-crlf",
            "\u{feff}---\r\nname: bom-crlf\r\ndescription: 윈도우 줄바꿈\r\nargument-hint: [a b]\r\n---\r\n본문\r\n",
        );
        skill_file(
            &dir,
            "block",
            "---\nname: block\ndescription: >\n  첫 줄\n  둘째 줄\nargument-hint: |\n  [경로]\n---\n",
        );
        skill_file(
            &dir,
            "long",
            &format!(
                "---\ndescription: {}\nargument-hint: {}\n---\n",
                "가".repeat(DESCRIPTION_CHARS + 50),
                "나".repeat(HINT_CHARS + 50)
            ),
        );
        skill_file(
            &dir,
            "empty-fields",
            "---\ndescription:\nargument-hint: \"\"\n---\n",
        );
        let list = list(&dir);
        let crlf = info(&list, "bom-crlf");
        assert_eq!(crlf.description.as_deref(), Some("윈도우 줄바꿈"));
        assert_eq!(crlf.argument_hint.as_deref(), Some("[a b]"));
        let block = info(&list, "block");
        assert_eq!(block.description.as_deref(), Some("첫 줄 둘째 줄"));
        assert_eq!(block.argument_hint.as_deref(), Some("[경로]"));
        let long = info(&list, "long");
        assert!(long.description.as_ref().unwrap().chars().count() <= DESCRIPTION_CHARS + 1);
        assert!(long.argument_hint.as_ref().unwrap().chars().count() <= HINT_CHARS + 1);
        let empty = info(&list, "empty-fields");
        assert_eq!(
            (empty.description.clone(), empty.argument_hint.clone()),
            (None, None)
        );
    }

    #[test]
    fn folders_without_a_skill_file_plain_files_and_hidden_names_are_not_skills() {
        let dir = claude_dir("skills-skip");
        skill_file(&dir, "real", &plain("real"));
        fs::create_dir_all(dir.join("skills").join("synced")).unwrap();
        fs::write(dir.join("skills").join("synced").join("notes.md"), "x").unwrap();
        fs::write(dir.join("skills").join("loose.md"), "---\n---\n").unwrap();
        skill_file(&dir, ".hidden", &plain(".hidden"));
        // `SKILL.md` 가 폴더인 것도 스킬이 아니다
        fs::create_dir_all(dir.join("skills").join("dir-skill").join(SKILL_FILE)).unwrap();
        let list = list(&dir);
        assert_eq!(list.skills.len(), 1);
        assert_eq!(info(&list, "real").name, "real");
    }

    #[test]
    fn the_list_is_sorted_by_folder_name_ignoring_case() {
        let dir = claude_dir("skills-order");
        for name in ["zeta", "Alpha", "beta", "alpha-2"] {
            skill_file(&dir, name, "---\ndescription: d\n---\n");
        }
        let list = list(&dir);
        let names: Vec<_> = list
            .skills
            .iter()
            .map(|entry| match entry {
                SkillEntry::Ok(info) => info.name.clone(),
                SkillEntry::Unreadable(u) => u.folder.clone(),
            })
            .collect();
        assert_eq!(names, ["Alpha", "alpha-2", "beta", "zeta"]);
    }

    #[test]
    fn no_harness_is_an_empty_list_with_a_state_even_when_skills_exist() {
        let dir = TempDir::new("skills-noharness");
        fs::create_dir_all(dir.join("skills").join("mine")).unwrap();
        fs::write(
            dir.join("skills").join("mine").join(SKILL_FILE),
            "---\ndescription: d\n---\n",
        )
        .unwrap();
        let result = list(&dir);
        assert_eq!(result, SkillsList::empty(SkillsState::NoHarness));
        // 폴더 자체가 없어도 같다
        assert_eq!(
            list(&dir.join("no-such-folder")),
            SkillsList::empty(SkillsState::NoHarness)
        );
    }

    #[test]
    fn a_harness_without_a_skills_folder_is_an_empty_ok_list() {
        let dir = TempDir::new("skills-none");
        fs::create_dir_all(dir.join("harness")).unwrap();
        assert_eq!(list(&dir), SkillsList::empty(SkillsState::Ok));
    }

    #[test]
    fn a_huge_folder_is_capped() {
        let dir = claude_dir("skills-cap");
        for i in 0..MAX_SKILLS + 20 {
            skill_file(&dir, &format!("s{i:04}"), "---\ndescription: d\n---\n");
        }
        assert_eq!(list(&dir).skills.len(), MAX_SKILLS);
    }

    #[test]
    fn the_serialized_shape_has_camel_case_keys_a_state_tag_and_no_paths() {
        let dir = claude_dir("skills-shape");
        harness_skill(&dir, "web-full", &plain("web-full"));
        skill_file(&dir, "broken", "no frontmatter");
        let json = serde_json::to_value(list(&dir)).unwrap();
        assert_eq!(json["state"], "ok");
        let broken = &json["skills"][0];
        assert_eq!(broken["state"], "unreadable");
        assert_eq!(broken["folder"], "broken");
        assert_eq!(broken["reason"], "no_frontmatter");
        assert_eq!(broken["origin"], "mine");
        let ok = &json["skills"][1];
        assert_eq!(ok["state"], "ok");
        assert_eq!(ok["name"], "web-full");
        assert_eq!(ok["command"], "/web-full");
        assert_eq!(ok["argumentHint"], "[인자]");
        assert_eq!(ok["origin"], "harness");
        assert_eq!(ok["userInvocable"], true);
        let text = json.to_string();
        let dir_text = dir.display().to_string().replace('\\', "\\\\");
        assert!(!text.contains(&dir_text), "경로가 화면으로 간다: {text}");
    }

    fn try_symlink_dir(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_dir(target, link);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        result.is_ok()
    }

    #[test]
    fn a_link_to_a_folder_outside_is_skipped_but_one_into_the_harness_skills_is_followed() {
        let dir = claude_dir("skills-links");
        let outside = TempDir::new("skills-links-outside");
        fs::create_dir_all(outside.join("evil")).unwrap();
        fs::write(
            outside.join("evil").join(SKILL_FILE),
            "---\ndescription: from outside\n---\n",
        )
        .unwrap();
        // 하네스 폴더 안의 스킬 (링크 설치처럼 `skills/<이름>` 이 하네스 `skills/<이름>` 으로 이어진다)
        let installed = dir.join("harness").join("skills").join("linked-ok");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join(SKILL_FILE), "---\ndescription: ok\n---\n").unwrap();
        let ok_link = try_symlink_dir(&installed, &dir.join("skills").join("linked-ok"));
        let out_link = try_symlink_dir(&outside.join("evil"), &dir.join("skills").join("evil"));
        if !ok_link || !out_link {
            eprintln!("폴더 심볼릭 링크를 만들 수 없는 PC — 건너뜀");
            return;
        }
        let list = list(&dir);
        assert_eq!(list.skills.len(), 1, "{list:?}");
        assert_eq!(info(&list, "linked-ok").origin, SkillOrigin::Harness);
    }

    #[test]
    fn a_broken_link_is_skipped_without_trouble() {
        let dir = claude_dir("skills-dangling");
        let gone = TempDir::new("skills-dangling-target");
        fs::create_dir_all(gone.join("t")).unwrap();
        if !try_symlink_dir(&gone.join("t"), &dir.join("skills").join("dangling")) {
            return;
        }
        fs::remove_dir_all(gone.join("t")).unwrap();
        skill_file(&dir, "fine", &plain("fine"));
        assert_eq!(list(&dir).skills.len(), 1);
    }

    #[test]
    fn the_skills_folder_itself_may_be_a_link_to_another_folder() {
        let dir = TempDir::new("skills-folder-link");
        fs::create_dir_all(dir.join("harness")).unwrap();
        let real = TempDir::new("skills-folder-link-real");
        fs::create_dir_all(real.join("mine")).unwrap();
        fs::write(
            real.join("mine").join(SKILL_FILE),
            "---\ndescription: d\n---\n",
        )
        .unwrap();
        if !try_symlink_dir(real.path(), &dir.join("skills")) {
            return;
        }
        let list = list(&dir);
        assert_eq!(info(&list, "mine").origin, SkillOrigin::Mine);
    }
}
