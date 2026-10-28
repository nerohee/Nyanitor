//! 설치된 에이전트 읽기 (P5-01) — 고양이 집이 쓰는 목록: 오케스트레이터 1 + `<설정 폴더>/agents/*.md` 의 앞머리.
//!
//! 약속 문서: 하네스 저장소 `shared/app-contract.md` 1절(위치 `CLAUDE_CONFIG_DIR`) · 5절(앞머리 필드 · "읽을 수 없음" 규칙). 읽기만 한다 (파일을 고치지 않는다).
//!
//! - `frontmatter` — 앞머리 글 읽기 (순수 함수)
//! - `config` — `harness/config.local.json` (없으면 `config.example.json`)의 `planner` · `agents`
//! - `commands` — Tauri 명령 `agents_list` (얇게)
//!
//! 규칙:
//! - 보는 파일: `<설정 폴더>/agents/` 바로 아래의 `*.md` 파일만 (하위 폴더 없음). 링크는 따라가되 그 폴더 밖을 가리키면 건너뛴다. 파일 하나 64KB 까지.
//! - 필수 필드는 `name`(파일 이름과 같아야 한다) · `description` 이고, `model` · `effort` · `color` 는 없으면 `None` 이다 (하네스 밖의 에이전트에는 흔히 없다).
//! - 깨진 파일은 그 항목만 `unreadable`, 나머지는 그대로. 하네스(`<설정 폴더>/harness`)가 없으면 빈 목록과 `no_harness` — 오류가 아니다.
//! - 역할: 오케스트레이터는 설정의 `planner`, 작업자는 설정 `agents` 의 이름 대응. 설정이 없거나 깨졌으면 작업자 역할을 짐작하지 않는다 (이름으로 추측하지 않음).
//! - 화면으로 가는 값에 경로는 없다 (파일 이름만). 화면에서 경로 · 이름을 받는 길은 없다 — 위치는 환경 변수 `CLAUDE_CONFIG_DIR` 로만 바뀐다.

pub mod commands;
pub mod config;
pub mod frontmatter;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::claude::protocol::truncate_chars;
use crate::harness::locate;
use config::ConfigState;

/// 파일 하나의 최대 크기 (넘으면 `too_large`)
pub const MAX_FILE_BYTES: u64 = 64 * 1024;
/// 읽는 에이전트 파일의 최대 개수 (폴더가 비정상으로 클 때 일을 막아 둔다)
const MAX_FILES: usize = 300;
/// 화면에 그대로 가는 짧은 이름(`model` · `effort` · `color`)의 최대 글자 수
const SHORT: usize = 64;
/// 소개 글의 최대 글자 수
const DESCRIPTION_CHARS: usize = 1000;
/// 읽기 전용으로 보는 조건: 이 두 도구를 모두 못 쓰게 했다 (감사관은 `Write, Edit, MultiEdit, NotebookEdit`)
const READ_ONLY_TOOLS: [&str; 2] = ["Write", "Edit"];

/// 역할 — Rust 는 고양이를 모른다 (고양이 ↔ 역할 대응은 화면 쪽 `agent-cats.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    /// 오케스트레이터 (메인 대화) — 파일이 없고 설정의 `planner` 로 정해진다
    Main,
    Designer,
    Ui,
    System,
    Tester,
    Helper,
    Reviewer,
}

impl AgentRole {
    /// 작업자 역할 (설정 `agents` 의 키 순서)
    pub const WORKERS: [AgentRole; 6] = [
        AgentRole::Designer,
        AgentRole::Ui,
        AgentRole::System,
        AgentRole::Tester,
        AgentRole::Helper,
        AgentRole::Reviewer,
    ];

    /// 설정 `agents` 의 키 (약속 문서 5절)
    pub fn key(self) -> &'static str {
        match self {
            AgentRole::Main => "main",
            AgentRole::Designer => "designer",
            AgentRole::Ui => "ui",
            AgentRole::System => "system",
            AgentRole::Tester => "tester",
            AgentRole::Helper => "helper",
            AgentRole::Reviewer => "reviewer",
        }
    }
}

/// 읽은 에이전트 한 명
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    /// 하네스 역할 (하네스 작업자가 아니면 `None`)
    pub role: Option<AgentRole>,
    /// 파일 이름 (경로 아님). 오케스트레이터는 파일이 없어 `None`
    pub file: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub color: Option<String>,
    /// `disallowedTools` 로 `Write` · `Edit` 를 모두 못 쓰게 했다 (감사관)
    pub read_only: bool,
}

/// 읽을 수 없는 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnreadableReason {
    /// 64KB 를 넘는다
    TooLarge,
    /// 열 수 없거나 읽다가 실패했다
    ReadFailed,
    NotUtf8,
    /// 첫 줄이 `---` 가 아니다
    NoFrontmatter,
    /// 닫는 `---` 가 없다
    UnclosedFrontmatter,
    MissingName,
    /// `name` 이 파일 이름(확장자 뺀 것)과 다르다
    NameMismatch,
    MissingDescription,
}

/// 읽을 수 없는 에이전트 파일 (나머지 에이전트에는 영향이 없다)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUnreadable {
    /// 설정이 이 파일을 작업자로 가리키면 그 역할 (이름이 파일 이름으로 정해지므로 깨진 파일도 알 수 있다)
    pub role: Option<AgentRole>,
    pub file: String,
    pub reason: UnreadableReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum AgentEntry {
    Ok(AgentInfo),
    Unreadable(AgentUnreadable),
}

/// 목록 전체의 상태
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentsState {
    Ok,
    /// `<설정 폴더>/harness` 가 없다 — 하네스가 설치되지 않았다. 목록은 비었다
    NoHarness,
    /// 설정 폴더 위치를 정할 수 없다 (홈 폴더 없음 · `CLAUDE_CONFIG_DIR` 가 상대 경로)
    LocationUnusable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsList {
    pub state: AgentsState,
    /// 어느 설정을 읽었나 (`unreadable` 이면 오케스트레이터의 모델 · 수준과 작업자 역할을 알 수 없다)
    pub config: ConfigState,
    /// 오케스트레이터(`role: main`)가 맨 앞, 그 뒤는 파일 이름 순
    pub agents: Vec<AgentEntry>,
    /// 설정이 작업자로 정했는데 파일이 없는(또는 건너뛴) 역할
    pub missing_roles: Vec<AgentRole>,
}

impl AgentsList {
    fn empty(state: AgentsState) -> Self {
        Self {
            state,
            config: ConfigState::None,
            agents: Vec::new(),
            missing_roles: Vec::new(),
        }
    }
}

/// 이 프로세스의 환경(`CLAUDE_CONFIG_DIR` · 홈)으로 정한 위치에서 읽는다.
pub fn list_here() -> AgentsList {
    match locate::locations_here() {
        Ok(locations) => list(&locations.claude_dir),
        Err(_) => AgentsList::empty(AgentsState::LocationUnusable),
    }
}

/// `claude_dir`(`~/.claude`)에서 읽는다. 어떤 실패도 오류로 돌려주지 않는다 — 읽을 수 없는 것은 그 항목의 상태로 남는다.
pub fn list(claude_dir: &Path) -> AgentsList {
    let harness_dir = claude_dir.join("harness");
    // 링크 · 정션이면 대상을 본다 (설치가 링크일 수 있다)
    if !harness_dir.is_dir() {
        return AgentsList::empty(AgentsState::NoHarness);
    }
    let (config_state, config) = config::read(&harness_dir);

    let files = scan_agent_files(&claude_dir.join("agents"));
    let role_of = |stem: &str| {
        config
            .workers
            .iter()
            .find(|(_, name)| name == stem)
            .map(|(role, _)| *role)
    };

    let mut agents = vec![AgentEntry::Ok(AgentInfo {
        role: Some(AgentRole::Main),
        file: None,
        name: "main".to_string(),
        description: None,
        model: config.planner_model.clone(),
        effort: config.planner_effort.clone(),
        color: None,
        read_only: false,
    })];
    for file in &files {
        agents.push(read_agent(file, role_of(&file.stem)));
    }
    let missing_roles = config
        .workers
        .iter()
        .filter(|(_, name)| !files.iter().any(|file| &file.stem == name))
        .map(|(role, _)| *role)
        .collect();
    AgentsList {
        state: AgentsState::Ok,
        config: config_state,
        agents,
        missing_roles,
    }
}

/// 폴더 안의 에이전트 파일 하나
struct AgentFile {
    /// 파일 이름 (`harness-helper.md`)
    name: String,
    /// 확장자를 뺀 이름
    stem: String,
    /// 읽을 곳 (링크를 푼 실제 경로)
    path: PathBuf,
}

/// `agents/` 바로 아래의 `*.md` 파일. 하위 폴더 · 폴더 밖을 가리키는 링크 · 끊어진 링크 · 숨은 이름은 건너뛴다. 파일 이름 순.
fn scan_agent_files(agents_dir: &Path) -> Vec<AgentFile> {
    let Ok(base) = fs::canonicalize(agents_dir) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let path = Path::new(&name);
        let is_md = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"));
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_md || stem.is_empty() || name.starts_with('.') {
            continue;
        }
        let Ok(real) = fs::canonicalize(entry.path()) else {
            continue; // 끊어진 링크
        };
        // 링크가 폴더 밖을 가리키면 쓰지 않는다 (다른 곳의 파일을 읽게 되지 않도록)
        if !real.starts_with(&base) || !real.is_file() {
            continue;
        }
        files.push(AgentFile {
            stem: stem.to_string(),
            name,
            path: real,
        });
        if files.len() >= MAX_FILES {
            break;
        }
    }
    files.sort_by_cached_key(|file| file.name.to_lowercase());
    files
}

fn read_limited(path: &Path) -> Result<String, UnreadableReason> {
    let file = fs::File::open(path).map_err(|_| UnreadableReason::ReadFailed)?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UnreadableReason::ReadFailed)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(UnreadableReason::TooLarge);
    }
    String::from_utf8(bytes).map_err(|_| UnreadableReason::NotUtf8)
}

fn short(text: &str) -> String {
    text.chars().take(SHORT).collect()
}

/// `disallowedTools` 값(쉼표로 나눈 이름, `[A, B]` · 따옴표 · `Bash(rm *)` 같은 꼬리 허용)에서 이름들
fn tool_names(value: &str) -> Vec<String> {
    value
        .trim_matches(['[', ']'])
        .split(',')
        .map(|item| {
            let item = item.trim().trim_matches(['"', '\'']);
            item.split('(').next().unwrap_or("").trim().to_string()
        })
        .filter(|item| !item.is_empty())
        .collect()
}

fn read_agent(file: &AgentFile, role: Option<AgentRole>) -> AgentEntry {
    let unreadable = |reason| {
        AgentEntry::Unreadable(AgentUnreadable {
            role,
            file: file.name.clone(),
            reason,
        })
    };
    let text = match read_limited(&file.path) {
        Ok(text) => text,
        Err(reason) => return unreadable(reason),
    };
    let fields = match frontmatter::parse(&text) {
        Ok(fields) => fields,
        Err(frontmatter::FrontmatterError::Missing) => {
            return unreadable(UnreadableReason::NoFrontmatter);
        }
        Err(frontmatter::FrontmatterError::Unclosed) => {
            return unreadable(UnreadableReason::UnclosedFrontmatter);
        }
    };
    let Some(name) = fields.non_empty("name") else {
        return unreadable(UnreadableReason::MissingName);
    };
    if name != file.stem {
        return unreadable(UnreadableReason::NameMismatch);
    }
    let Some(description) = fields.non_empty("description") else {
        return unreadable(UnreadableReason::MissingDescription);
    };
    let blocked = fields
        .get("disallowedTools")
        .map(tool_names)
        .unwrap_or_default();
    let read_only = READ_ONLY_TOOLS
        .iter()
        .all(|tool| blocked.iter().any(|b| b.eq_ignore_ascii_case(tool)));
    AgentEntry::Ok(AgentInfo {
        role,
        file: Some(file.name.clone()),
        name: name.to_string(),
        description: Some(truncate_chars(description, DESCRIPTION_CHARS)),
        model: fields.non_empty("model").map(short),
        effort: fields.non_empty("effort").map(short),
        color: fields.non_empty("color").map(short),
        read_only,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    const CONFIG: &str = r#"{
        "planner": { "model": "opus", "effort": "high" },
        "agents": { "designer": "harness-designer", "ui": "harness-builder-ui", "system": "harness-builder-system",
                    "tester": "harness-tester", "helper": "harness-helper", "reviewer": "harness-reviewer" }
    }"#;

    /// 설정 폴더 하나 (`harness/` 와 `agents/` 가 있다)
    fn claude_dir(name: &str, config: Option<&str>) -> TempDir {
        let dir = TempDir::new(name);
        fs::create_dir_all(dir.join("harness")).unwrap();
        fs::create_dir_all(dir.join("agents")).unwrap();
        if let Some(config) = config {
            fs::write(dir.join("harness").join("config.local.json"), config).unwrap();
        }
        dir
    }

    fn agent_file(dir: &TempDir, name: &str, text: &str) {
        fs::write(dir.join("agents").join(name), text).unwrap();
    }

    fn worker_text(name: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: {name} 소개\nmodel: sonnet\neffort: medium\ncolor: blue\nhooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n---\n\n본문\n"
        )
    }

    fn entries(list: &AgentsList) -> Vec<&AgentEntry> {
        list.agents.iter().collect()
    }

    fn info<'a>(list: &'a AgentsList, file: &str) -> &'a AgentInfo {
        list.agents
            .iter()
            .find_map(|entry| match entry {
                AgentEntry::Ok(info) if info.file.as_deref() == Some(file) => Some(info),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no ok entry for {file}: {list:?}"))
    }

    fn unreadable<'a>(list: &'a AgentsList, file: &str) -> &'a AgentUnreadable {
        list.agents
            .iter()
            .find_map(|entry| match entry {
                AgentEntry::Unreadable(u) if u.file == file => Some(u),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no unreadable entry for {file}: {list:?}"))
    }

    #[test]
    fn a_full_install_gives_the_orchestrator_first_then_each_worker_with_its_role() {
        let dir = claude_dir("full", Some(CONFIG));
        for name in [
            "harness-designer",
            "harness-builder-ui",
            "harness-builder-system",
            "harness-tester",
            "harness-helper",
            "harness-reviewer",
        ] {
            agent_file(&dir, &format!("{name}.md"), &worker_text(name));
        }
        let list = list(&dir);
        assert_eq!(list.state, AgentsState::Ok);
        assert_eq!(list.config, ConfigState::Local);
        assert_eq!(list.agents.len(), 7);
        let AgentEntry::Ok(main) = &list.agents[0] else {
            panic!("main first")
        };
        assert_eq!(main.role, Some(AgentRole::Main));
        assert_eq!(main.file, None);
        assert_eq!(main.model.as_deref(), Some("opus"));
        assert_eq!(main.effort.as_deref(), Some("high"));
        let roles: Vec<_> = list
            .agents
            .iter()
            .skip(1)
            .map(|entry| match entry {
                AgentEntry::Ok(info) => (info.file.clone().unwrap(), info.role),
                AgentEntry::Unreadable(_) => panic!("all readable"),
            })
            .collect();
        // 파일 이름 순
        assert_eq!(
            roles,
            vec![
                (
                    "harness-builder-system.md".to_string(),
                    Some(AgentRole::System)
                ),
                ("harness-builder-ui.md".to_string(), Some(AgentRole::Ui)),
                ("harness-designer.md".to_string(), Some(AgentRole::Designer)),
                ("harness-helper.md".to_string(), Some(AgentRole::Helper)),
                ("harness-reviewer.md".to_string(), Some(AgentRole::Reviewer)),
                ("harness-tester.md".to_string(), Some(AgentRole::Tester)),
            ]
        );
        assert!(list.missing_roles.is_empty());
        let helper = info(&list, "harness-helper.md");
        assert_eq!(helper.description.as_deref(), Some("harness-helper 소개"));
        assert_eq!(helper.model.as_deref(), Some("sonnet"));
        assert_eq!(helper.effort.as_deref(), Some("medium"));
        assert_eq!(helper.color.as_deref(), Some("blue"));
        assert!(!helper.read_only);
    }

    #[test]
    fn the_serialized_shape_has_camel_case_keys_a_state_tag_and_no_paths() {
        let dir = claude_dir("shape", Some(CONFIG));
        agent_file(&dir, "harness-helper.md", &worker_text("harness-helper"));
        agent_file(&dir, "broken.md", "no frontmatter");
        let json = serde_json::to_value(list(&dir)).unwrap();
        assert_eq!(json["state"], "ok");
        assert_eq!(json["config"], "local");
        assert_eq!(json["agents"][0]["state"], "ok");
        assert_eq!(json["agents"][0]["role"], "main");
        assert_eq!(json["agents"][0]["file"], serde_json::Value::Null);
        let broken = &json["agents"][1];
        assert_eq!(broken["state"], "unreadable");
        assert_eq!(broken["file"], "broken.md");
        assert_eq!(broken["reason"], "no_frontmatter");
        assert_eq!(json["agents"][2]["readOnly"], false);
        assert_eq!(json["agents"][2]["role"], "helper");
        assert_eq!(json["missingRoles"][0], "designer");
        let text = json.to_string();
        let dir_text = dir.display().to_string().replace('\\', "\\\\");
        assert!(!text.contains(&dir_text), "경로가 화면으로 간다: {text}");
    }

    #[test]
    fn reviewer_is_read_only_only_when_write_and_edit_are_both_blocked() {
        let dir = claude_dir("readonly", Some(CONFIG));
        let with = |name: &str, tools: &str| {
            agent_file(
                &dir,
                &format!("{name}.md"),
                &format!("---\nname: {name}\ndescription: d\ndisallowedTools: {tools}\n---\n"),
            );
        };
        with("a", "Write, Edit, MultiEdit, NotebookEdit");
        with("b", "Write");
        with("c", "[\"Write\", 'Edit']");
        with("d", "write,EDIT");
        with("e", "Bash(rm *), Write, Edit(src/**)");
        with("f", "");
        let list = list(&dir);
        assert!(info(&list, "a.md").read_only);
        assert!(
            !info(&list, "b.md").read_only,
            "Write 만 막으면 읽기 전용이 아니다"
        );
        assert!(info(&list, "c.md").read_only);
        assert!(info(&list, "d.md").read_only);
        assert!(info(&list, "e.md").read_only);
        assert!(!info(&list, "f.md").read_only);
    }

    #[test]
    fn agents_outside_the_harness_are_listed_without_a_role() {
        let dir = claude_dir("nonharness", Some(CONFIG));
        agent_file(
            &dir,
            "translator.md",
            "---\nname: translator\ndescription: 번역\n---\n",
        );
        let list = list(&dir);
        let translator = info(&list, "translator.md");
        assert_eq!(translator.role, None);
        assert_eq!(translator.model, None);
        assert_eq!(translator.effort, None);
        assert_eq!(translator.color, None);
    }

    #[test]
    fn a_broken_file_is_unreadable_and_the_rest_are_unaffected() {
        let dir = claude_dir("broken-one", Some(CONFIG));
        agent_file(&dir, "harness-helper.md", &worker_text("harness-helper"));
        agent_file(&dir, "harness-tester.md", "이건 앞머리가 없다\n");
        let list = list(&dir);
        assert_eq!(list.state, AgentsState::Ok);
        assert!(info(&list, "harness-helper.md").role == Some(AgentRole::Helper));
        let tester = unreadable(&list, "harness-tester.md");
        assert_eq!(tester.reason, UnreadableReason::NoFrontmatter);
        // 깨진 파일도 설정이 가리키면 역할을 안다 (그 고양이를 "읽을 수 없음" 으로 보이려고)
        assert_eq!(tester.role, Some(AgentRole::Tester));
    }

    #[test]
    fn each_unreadable_reason_is_reported() {
        let dir = claude_dir("reasons", None);
        agent_file(&dir, "nofm.md", "name: x\n");
        agent_file(&dir, "unclosed.md", "---\nname: unclosed\ndescription: d\n");
        agent_file(&dir, "noname.md", "---\ndescription: d\n---\n");
        agent_file(&dir, "emptyname.md", "---\nname:\ndescription: d\n---\n");
        agent_file(
            &dir,
            "other.md",
            "---\nname: another\ndescription: d\n---\n",
        );
        agent_file(&dir, "nodesc.md", "---\nname: nodesc\n---\n");
        agent_file(
            &dir,
            "emptydesc.md",
            "---\nname: emptydesc\ndescription:  \n---\n",
        );
        fs::write(
            dir.join("agents").join("binary.md"),
            [0xff, 0xfe, 0x00, 0x80],
        )
        .unwrap();
        let big = format!(
            "---\nname: big\ndescription: d\n---\n{}",
            "x".repeat(usize::try_from(MAX_FILE_BYTES).unwrap())
        );
        agent_file(&dir, "big.md", &big);
        let list = list(&dir);
        let reason = |file: &str| unreadable(&list, file).reason;
        assert_eq!(reason("nofm.md"), UnreadableReason::NoFrontmatter);
        assert_eq!(reason("unclosed.md"), UnreadableReason::UnclosedFrontmatter);
        assert_eq!(reason("noname.md"), UnreadableReason::MissingName);
        assert_eq!(reason("emptyname.md"), UnreadableReason::MissingName);
        assert_eq!(reason("other.md"), UnreadableReason::NameMismatch);
        assert_eq!(reason("nodesc.md"), UnreadableReason::MissingDescription);
        assert_eq!(reason("emptydesc.md"), UnreadableReason::MissingDescription);
        assert_eq!(reason("binary.md"), UnreadableReason::NotUtf8);
        assert_eq!(reason("big.md"), UnreadableReason::TooLarge);
    }

    #[test]
    fn a_file_of_exactly_the_limit_is_read_and_one_byte_more_is_not() {
        let dir = claude_dir("limit", None);
        let sized = |name: &str, total: u64| {
            let head = format!("---\nname: {name}\ndescription: d\n---\n");
            let fill = usize::try_from(total).unwrap() - head.len();
            format!("{head}{}", "x".repeat(fill))
        };
        agent_file(&dir, "exact.md", &sized("exact", MAX_FILE_BYTES));
        agent_file(&dir, "over.md", &sized("over", MAX_FILE_BYTES + 1));
        assert_eq!(
            fs::metadata(dir.join("agents").join("over.md"))
                .unwrap()
                .len(),
            MAX_FILE_BYTES + 1
        );
        let list = list(&dir);
        assert_eq!(info(&list, "exact.md").name, "exact");
        assert_eq!(
            unreadable(&list, "over.md").reason,
            UnreadableReason::TooLarge
        );
    }

    #[test]
    fn bom_crlf_and_quoted_values_in_a_real_file() {
        let dir = claude_dir("odd-text", None);
        agent_file(
            &dir,
            "quoted.md",
            "\u{feff}---\r\nname: \"quoted\"\r\ndescription: 'it''s fine: really'\r\nmodel: \"opus\"\r\n---\r\n본문\r\n",
        );
        let list = list(&dir);
        let quoted = info(&list, "quoted.md");
        assert_eq!(quoted.name, "quoted");
        assert_eq!(quoted.description.as_deref(), Some("it's fine: really"));
        assert_eq!(quoted.model.as_deref(), Some("opus"));
    }

    #[test]
    fn empty_optional_fields_are_none_and_long_ones_are_cut() {
        let dir = claude_dir("optional", None);
        let long = "가".repeat(DESCRIPTION_CHARS + 50);
        agent_file(
            &dir,
            "opt.md",
            &format!(
                "---\nname: opt\ndescription: {long}\nmodel:\neffort: \"\"\ncolor: {}\n---\n",
                "c".repeat(200)
            ),
        );
        let list = list(&dir);
        let opt = info(&list, "opt.md");
        assert_eq!(opt.model, None);
        assert_eq!(opt.effort, None);
        assert_eq!(opt.color.as_deref().map(|c| c.chars().count()), Some(SHORT));
        let description = opt.description.as_deref().unwrap();
        assert_eq!(description.chars().count(), DESCRIPTION_CHARS + 1); // 끝의 …
        assert!(description.ends_with('…'));
    }

    #[test]
    fn only_markdown_files_directly_inside_agents_count() {
        let dir = claude_dir("which-files", None);
        agent_file(&dir, "good.md", "---\nname: good\ndescription: d\n---\n");
        agent_file(&dir, "UPPER.MD", "---\nname: UPPER\ndescription: d\n---\n");
        agent_file(&dir, "notes.txt", "---\nname: notes\ndescription: d\n---\n");
        agent_file(
            &dir,
            ".hidden.md",
            "---\nname: .hidden\ndescription: d\n---\n",
        );
        agent_file(&dir, ".md", "---\nname: x\ndescription: d\n---\n");
        // 하위 폴더 (설치가 만드는 `_common/rules.md` 포함)
        fs::create_dir_all(dir.join("agents").join("_common")).unwrap();
        fs::write(
            dir.join("agents").join("_common").join("rules.md"),
            "---\nname: rules\ndescription: d\n---\n",
        )
        .unwrap();
        // `.md` 로 끝나는 폴더
        fs::create_dir_all(dir.join("agents").join("folder.md")).unwrap();
        let list = list(&dir);
        let files: Vec<_> = list
            .agents
            .iter()
            .filter_map(|e| match e {
                AgentEntry::Ok(i) => i.file.clone(),
                AgentEntry::Unreadable(u) => Some(u.file.clone()),
            })
            .collect();
        assert_eq!(files, vec!["good.md", "UPPER.MD"]);
    }

    #[test]
    fn no_harness_folder_is_an_empty_list_with_a_state_not_an_error() {
        let dir = TempDir::new("no-harness");
        fs::create_dir_all(dir.join("agents")).unwrap();
        fs::write(
            dir.join("agents").join("a.md"),
            "---\nname: a\ndescription: d\n---\n",
        )
        .unwrap();
        let list = list(&dir);
        assert_eq!(list.state, AgentsState::NoHarness);
        assert!(list.agents.is_empty() && list.missing_roles.is_empty());
        // 폴더 자체가 없어도 같다
        let missing = dir.join("nothing-here");
        assert_eq!(super::list(&missing).state, AgentsState::NoHarness);
        // `harness` 가 폴더가 아닌 파일이어도
        fs::write(dir.join("harness"), "x").unwrap();
        assert_eq!(super::list(&dir).state, AgentsState::NoHarness);
    }

    #[test]
    fn harness_without_an_agents_folder_has_only_the_orchestrator_and_the_missing_roles() {
        let dir = TempDir::new("no-agents-dir");
        fs::create_dir_all(dir.join("harness")).unwrap();
        fs::write(dir.join("harness").join("config.local.json"), CONFIG).unwrap();
        let list = list(&dir);
        assert_eq!(list.state, AgentsState::Ok);
        assert_eq!(entries(&list).len(), 1);
        assert_eq!(list.missing_roles, AgentRole::WORKERS.to_vec());
    }

    #[test]
    fn missing_config_means_no_roles_and_an_orchestrator_without_a_model() {
        let dir = claude_dir("no-config", None);
        agent_file(&dir, "harness-helper.md", &worker_text("harness-helper"));
        let list = list(&dir);
        assert_eq!(list.config, ConfigState::None);
        let AgentEntry::Ok(main) = &list.agents[0] else {
            panic!()
        };
        assert_eq!(
            (main.model.as_deref(), main.effort.as_deref()),
            (None, None)
        );
        // 이름으로 역할을 짐작하지 않는다
        assert_eq!(info(&list, "harness-helper.md").role, None);
        assert!(list.missing_roles.is_empty());
    }

    #[test]
    fn the_example_config_is_used_when_there_is_no_local_one() {
        let dir = claude_dir("example", None);
        fs::write(
            dir.join("harness").join("config.example.json"),
            r#"{"planner":{"model":"sonnet"},"agents":{"helper":"harness-helper"}}"#,
        )
        .unwrap();
        agent_file(&dir, "harness-helper.md", &worker_text("harness-helper"));
        let list = list(&dir);
        assert_eq!(list.config, ConfigState::Example);
        assert_eq!(
            info(&list, "harness-helper.md").role,
            Some(AgentRole::Helper)
        );
    }

    #[test]
    fn a_broken_config_keeps_the_files_but_loses_roles_and_says_so() {
        let dir = claude_dir("broken-config", Some("{ not json"));
        agent_file(&dir, "harness-helper.md", &worker_text("harness-helper"));
        let list = list(&dir);
        assert_eq!(list.state, AgentsState::Ok);
        assert_eq!(list.config, ConfigState::Unreadable);
        assert_eq!(info(&list, "harness-helper.md").role, None);
        let AgentEntry::Ok(main) = &list.agents[0] else {
            panic!()
        };
        assert_eq!(main.model, None);
    }

    #[test]
    fn a_role_whose_file_is_missing_is_reported() {
        let dir = claude_dir("missing-role", Some(CONFIG));
        agent_file(
            &dir,
            "harness-designer.md",
            &worker_text("harness-designer"),
        );
        let list = list(&dir);
        assert_eq!(
            list.missing_roles,
            vec![
                AgentRole::Ui,
                AgentRole::System,
                AgentRole::Tester,
                AgentRole::Helper,
                AgentRole::Reviewer
            ]
        );
    }

    #[test]
    fn two_roles_pointing_at_one_file_give_the_file_the_first_role_only() {
        let dir = claude_dir(
            "dup-role",
            Some(r#"{"agents":{"designer":"shared","ui":"shared"}}"#),
        );
        agent_file(&dir, "shared.md", &worker_text("shared"));
        let list = list(&dir);
        assert_eq!(info(&list, "shared.md").role, Some(AgentRole::Designer));
        assert!(list.missing_roles.is_empty());
    }

    #[test]
    fn unicode_and_spaces_in_file_names_work() {
        let dir = claude_dir("unicode-name", None);
        agent_file(
            &dir,
            "번역 도우미.md",
            "---\nname: 번역 도우미\ndescription: d\n---\n",
        );
        let list = list(&dir);
        assert_eq!(info(&list, "번역 도우미.md").name, "번역 도우미");
    }

    #[test]
    fn the_name_must_match_the_file_name_exactly_including_case() {
        let dir = claude_dir("name-case", None);
        agent_file(
            &dir,
            "Helper.md",
            "---\nname: helper\ndescription: d\n---\n",
        );
        let list = list(&dir);
        assert_eq!(
            unreadable(&list, "Helper.md").reason,
            UnreadableReason::NameMismatch
        );
    }

    #[test]
    fn a_huge_folder_is_capped() {
        let dir = claude_dir("many", None);
        for i in 0..(MAX_FILES + 20) {
            agent_file(
                &dir,
                &format!("a{i:04}.md"),
                &format!("---\nname: a{i:04}\ndescription: d\n---\n"),
            );
        }
        let list = list(&dir);
        assert_eq!(list.agents.len(), 1 + MAX_FILES);
    }

    /// 링크를 만들 수 있는 PC 에서만 (Windows 는 권한이 없으면 건너뛴다)
    fn try_symlink(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        let result = std::os::windows::fs::symlink_file(target, link);
        #[cfg(unix)]
        let result = std::os::unix::fs::symlink(target, link);
        result.is_ok()
    }

    #[test]
    fn a_link_inside_the_folder_is_followed_but_one_pointing_outside_is_skipped() {
        let dir = claude_dir("links", None);
        let outside = TempDir::new("links-outside");
        fs::write(
            outside.join("outside.md"),
            "---\nname: outside\ndescription: d\n---\n",
        )
        .unwrap();
        agent_file(&dir, "real.md", "---\nname: alias\ndescription: d\n---\n");
        let ok_link = try_symlink(
            &dir.join("agents").join("real.md"),
            &dir.join("agents").join("alias.md"),
        );
        let out_link = try_symlink(
            &outside.join("outside.md"),
            &dir.join("agents").join("outside.md"),
        );
        if !ok_link || !out_link {
            eprintln!("링크를 만들 수 없는 PC — 링크 시험을 건너뛴다");
            return;
        }
        let list = list(&dir);
        let files: Vec<_> = list
            .agents
            .iter()
            .filter_map(|e| match e {
                AgentEntry::Ok(i) => i.file.clone(),
                AgentEntry::Unreadable(u) => Some(u.file.clone()),
            })
            .collect();
        // 폴더 안의 링크는 따라가되 (이름은 링크 이름), 밖을 가리키는 `outside.md` 는 없다
        assert!(files.contains(&"alias.md".to_string()), "{files:?}");
        assert!(files.contains(&"real.md".to_string()), "{files:?}");
        assert!(!files.contains(&"outside.md".to_string()), "{files:?}");
    }

    #[test]
    fn a_broken_link_is_skipped_without_trouble() {
        let dir = claude_dir("dangling", None);
        let gone = dir.join("agents").join("gone-target.md");
        if !try_symlink(&gone, &dir.join("agents").join("dangling.md")) {
            return;
        }
        agent_file(&dir, "ok.md", "---\nname: ok\ndescription: d\n---\n");
        let list = list(&dir);
        assert_eq!(list.agents.len(), 2); // 오케스트레이터 + ok
    }

    #[test]
    fn the_folder_itself_may_be_a_link_to_another_folder() {
        let real = TempDir::new("agents-real");
        fs::write(real.join("x.md"), "---\nname: x\ndescription: d\n---\n").unwrap();
        let dir = TempDir::new("agents-linked");
        fs::create_dir_all(dir.join("harness")).unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(real.path(), dir.join("agents")).is_ok();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(real.path(), dir.join("agents")).is_ok();
        if !linked {
            return;
        }
        let list = list(&dir);
        assert_eq!(info(&list, "x.md").name, "x");
    }
}
