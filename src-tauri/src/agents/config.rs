//! 하네스 설정 읽기 — `<설정 폴더>/harness/config.local.json` (없으면 `config.example.json`)에서 오케스트레이터의 모델 · 수준(`planner`)과
//! 역할 ↔ 작업자 이름(`agents`)만 읽는다 (약속 문서 5절). 나머지 키(저장소 경로 · 문서 폴더 등)는 읽지도 남기지도 않는다.
//!
//! 읽기만 한다. 설정이 깨졌으면 "읽을 수 없음" 으로 알리고 **예시로 대신하지 않는다** — 사용자가 고친 이름 대응을 예시 값으로 덮어 말하지 않으려는 것이다.

use std::fs;
use std::io::{self, Read};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::AgentRole;

/// 설정 파일 하나의 최대 크기
const CONFIG_LIMIT: u64 = 256 * 1024;
/// 화면에 그대로 가는 짧은 이름의 최대 글자 수
const SHORT: usize = 64;

pub const LOCAL_FILE: &str = "config.local.json";
pub const EXAMPLE_FILE: &str = "config.example.json";

/// 어느 설정을 읽었는가
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfigState {
    /// `config.local.json`
    Local,
    /// `config.local.json` 이 없어서 `config.example.json`
    Example,
    /// 둘 다 없다
    None,
    /// 있는데 읽을 수 없다 (깨진 JSON · 너무 큼 · 읽기 실패 · 객체가 아님)
    Unreadable,
}

/// 읽은 설정 중 앱이 쓰는 것
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HarnessConfig {
    pub planner_model: Option<String>,
    pub planner_effort: Option<String>,
    /// 역할마다 작업자 이름 (모르는 역할 이름은 버렸다)
    pub workers: Vec<(AgentRole, String)>,
}

fn read_capped(path: &Path) -> io::Result<Option<String>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let mut bytes = Vec::new();
    file.take(CONFIG_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too large"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn short(value: &Value) -> Option<String> {
    let text = value.as_str()?.trim();
    (!text.is_empty()).then(|| text.chars().take(SHORT).collect())
}

/// JSON 글에서 쓰는 값만 뽑는다. 최상위가 객체가 아니면 `None`. 키가 없거나 모양이 달라도 그 값만 건너뛴다.
pub fn parse(text: &str) -> Option<HarnessConfig> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let root: Value = serde_json::from_str(text).ok()?;
    let root = root.as_object()?;
    let planner = root.get("planner").and_then(Value::as_object);
    let workers = root.get("agents").and_then(Value::as_object);
    Some(HarnessConfig {
        planner_model: planner.and_then(|p| p.get("model")).and_then(short),
        planner_effort: planner.and_then(|p| p.get("effort")).and_then(short),
        workers: AgentRole::WORKERS
            .iter()
            .filter_map(|role| {
                let name = workers?.get(role.key()).and_then(short)?;
                Some((*role, name))
            })
            .collect(),
    })
}

/// `<하네스 폴더>` 에서 설정을 읽는다 (없으면 예시). 읽을 수 없는 설정은 `Unreadable` 과 빈 값.
pub fn read(harness_dir: &Path) -> (ConfigState, HarnessConfig) {
    for (file, state) in [
        (LOCAL_FILE, ConfigState::Local),
        (EXAMPLE_FILE, ConfigState::Example),
    ] {
        match read_capped(&harness_dir.join(file)) {
            Ok(None) => continue,
            Ok(Some(text)) => {
                return match parse(&text) {
                    Some(config) => (state, config),
                    None => (ConfigState::Unreadable, HarnessConfig::default()),
                };
            }
            Err(_) => return (ConfigState::Unreadable, HarnessConfig::default()),
        }
    }
    (ConfigState::None, HarnessConfig::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    const FULL: &str = r#"{
        "language": "ko",
        "vault": { "path": "/secret/path" },
        "planner": { "model": "opus", "effort": "high" },
        "agents": { "designer": "harness-designer", "ui": "my-ui", "system": "harness-builder-system",
                    "tester": "t", "helper": "h", "reviewer": "r", "cook": "x" }
    }"#;

    #[test]
    fn reads_the_planner_and_role_names_only() {
        let config = parse(FULL).unwrap();
        assert_eq!(config.planner_model.as_deref(), Some("opus"));
        assert_eq!(config.planner_effort.as_deref(), Some("high"));
        assert_eq!(
            config.workers,
            vec![
                (AgentRole::Designer, "harness-designer".to_string()),
                (AgentRole::Ui, "my-ui".to_string()),
                (AgentRole::System, "harness-builder-system".to_string()),
                (AgentRole::Tester, "t".to_string()),
                (AgentRole::Helper, "h".to_string()),
                (AgentRole::Reviewer, "r".to_string()),
            ]
        );
        // 저장소 경로 같은 나머지는 구조체에 들어올 자리도 없다
        assert!(!format!("{config:?}").contains("secret"));
    }

    #[test]
    fn missing_or_oddly_typed_values_are_skipped_one_by_one() {
        let config = parse(
            r#"{ "planner": { "model": 5, "effort": "  " }, "agents": { "designer": 1, "ui": "", "system": "s" } }"#,
        )
        .unwrap();
        assert_eq!(config.planner_model, None);
        assert_eq!(config.planner_effort, None);
        assert_eq!(config.workers, vec![(AgentRole::System, "s".to_string())]);
        // 키 자체가 없거나 모양이 다른 최상위 값
        assert_eq!(parse("{}").unwrap(), HarnessConfig::default());
        assert_eq!(
            parse(r#"{ "planner": "opus", "agents": ["a"] }"#).unwrap(),
            HarnessConfig::default()
        );
    }

    #[test]
    fn not_an_object_or_broken_json_is_unreadable() {
        for text in [
            "",
            "{",
            "[1,2]",
            "null",
            "\"x\"",
            "{ \"planner\": ",
            "not json",
        ] {
            assert_eq!(parse(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_bom_in_front_is_tolerated() {
        assert!(parse("\u{feff}{\"planner\":{\"model\":\"m\"}}").is_some());
    }

    #[test]
    fn long_names_are_cut() {
        let long = "x".repeat(500);
        let config = parse(&format!(r#"{{ "planner": {{ "model": "{long}" }} }}"#)).unwrap();
        assert_eq!(config.planner_model.unwrap().chars().count(), SHORT);
    }

    #[test]
    fn local_wins_over_example_and_example_is_the_fallback() {
        let dir = TempDir::new("cfg-order");
        fs::write(dir.join(EXAMPLE_FILE), r#"{"planner":{"model":"example"}}"#).unwrap();
        let (state, config) = read(&dir);
        assert_eq!(state, ConfigState::Example);
        assert_eq!(config.planner_model.as_deref(), Some("example"));
        fs::write(dir.join(LOCAL_FILE), r#"{"planner":{"model":"local"}}"#).unwrap();
        let (state, config) = read(&dir);
        assert_eq!(state, ConfigState::Local);
        assert_eq!(config.planner_model.as_deref(), Some("local"));
    }

    #[test]
    fn neither_file_is_none() {
        let dir = TempDir::new("cfg-none");
        assert_eq!(read(&dir), (ConfigState::None, HarnessConfig::default()));
        // 폴더 자체가 없어도 같다
        assert_eq!(
            read(&dir.join("no-such-folder")),
            (ConfigState::None, HarnessConfig::default())
        );
    }

    #[test]
    fn a_broken_local_file_is_unreadable_and_is_not_replaced_by_the_example() {
        let dir = TempDir::new("cfg-broken");
        fs::write(dir.join(LOCAL_FILE), "{ broken").unwrap();
        fs::write(dir.join(EXAMPLE_FILE), r#"{"planner":{"model":"example"}}"#).unwrap();
        assert_eq!(
            read(&dir),
            (ConfigState::Unreadable, HarnessConfig::default())
        );
    }

    #[test]
    fn a_too_large_or_non_utf8_or_folder_config_is_unreadable() {
        let dir = TempDir::new("cfg-odd");
        let pad = " ".repeat(usize::try_from(CONFIG_LIMIT).unwrap() + 10);
        fs::write(dir.join(LOCAL_FILE), format!("{{}}{pad}")).unwrap();
        assert_eq!(read(&dir).0, ConfigState::Unreadable);
        fs::write(dir.join(LOCAL_FILE), [0xff, 0xfe, 0x00]).unwrap();
        assert_eq!(read(&dir).0, ConfigState::Unreadable);
        fs::remove_file(dir.join(LOCAL_FILE)).unwrap();
        fs::create_dir(dir.join(LOCAL_FILE)).unwrap();
        assert_eq!(read(&dir).0, ConfigState::Unreadable);
    }
}
