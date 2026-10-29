//! 세션 시작 계획 (P6-02) — 화면이 보낸 **프로젝트 번호**를 폴더로 바꾸고, 하네스 `planner` 설정에서 모델 · 수준을 읽어 `StartPlan` 을 만든다.
//!
//! D-47: 화면은 경로 · 모델 · 수준 · 실행 인자를 보내지 않는다. 폴더는 등록된 프로젝트에서 Rust 가 찾고(폴더가 없어졌거나 이제 고를 수 없는 폴더면 시작하지 않는다),
//! 모델 · 수준은 `<설정 폴더>/harness/config.local.json`(없으면 `config.example.json`)의 `planner` 에서 읽는다 (오케스트레이터 = Opus · high 기본, 하네스 설정을 따른다).
//!
//! 설정이 없거나 읽을 수 없거나 값이 이상하면 **그 값만 넘기지 않고** CLI 기본으로 띄우며 `Warning` 으로 알린다 (막지는 않는다).
//! 값 모양은 `session.rs` 의 `validate_model` · `validate_effort` 가 정한다 (인자로 들어가므로 이름 모양만).
//!
//! 이 파일의 함수는 모두 일반 함수다 — Tauri 없이 시험한다 (`commands.rs` 는 부르기만 한다).

use std::path::{Path, PathBuf};

use tauri_plugin_log::log;

use super::events::{StartInfo, StartRequest};
use super::exec::ClaudeCommand;
use super::session::{SessionManager, validate_effort, validate_model};
use crate::agents::config::{self, ConfigState, HarnessConfig};
use crate::db::AppDb;
use crate::error::AppError;
use crate::harness::locate;
use crate::projects::{self, Env};

/// `--effort` 가 받는 수준 이름 (`claude --help` 2.1.296: low, medium, high, xhigh, max)
pub const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// 시작하면서 화면에 알릴 것 — `SessionEvent::Warning` 이 된다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanWarning {
    pub code: &'static str,
    pub detail: Option<String>,
}

impl PlanWarning {
    fn new(code: &'static str, detail: &str) -> Self {
        Self {
            code,
            detail: Some(detail.to_string()),
        }
    }
}

/// 하네스 `planner` 설정에서 고른 모델 · 수준
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PlannerChoice {
    /// `--model` 로 넘길 값 (`None` = CLI 기본)
    pub model: Option<String>,
    /// `--effort` 로 넘길 값 (`None` = CLI 기본)
    pub effort: Option<String>,
    pub warnings: Vec<PlanWarning>,
}

/// 세션 하나를 띄우는 데 쓰는 것 전부 — Rust 가 만든다. 화면이 보낸 값은 `project_id` · `resume` · `use_api_key` 뿐이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartPlan {
    pub project_id: i64,
    /// 확인을 마친 폴더 (등록된 프로젝트의, 지금 있고, 고를 수 없는 폴더가 아님)
    pub project_dir: PathBuf,
    pub resume: bool,
    pub use_api_key: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub warnings: Vec<PlanWarning>,
}

/// 읽은 설정에서 모델 · 수준을 고른다. 설정이 있어도 값이 없는 칸은 "정하지 않음" 이라 조용히 CLI 기본이다.
pub fn choose_planner(state: ConfigState, config: &HarnessConfig) -> PlannerChoice {
    let mut choice = PlannerChoice::default();
    match state {
        ConfigState::None => {
            choice
                .warnings
                .push(PlanWarning::new("planner_config_missing", "none"));
            return choice;
        }
        ConfigState::Unreadable => {
            choice
                .warnings
                .push(PlanWarning::new("planner_config_unreadable", "unreadable"));
            return choice;
        }
        ConfigState::Local | ConfigState::Example => {}
    }
    if config.planner_model_odd {
        choice
            .warnings
            .push(PlanWarning::new("planner_model_unusable", "bad_shape"));
    } else if let Some(model) = &config.planner_model {
        match validate_model(model) {
            Ok(model) => choice.model = Some(model),
            Err(_) => choice
                .warnings
                .push(PlanWarning::new("planner_model_unusable", "bad_shape")),
        }
    }
    if config.planner_effort_odd {
        choice
            .warnings
            .push(PlanWarning::new("planner_effort_unusable", "bad_shape"));
    } else if let Some(effort) = &config.planner_effort {
        match validate_effort(effort) {
            Ok(effort) => choice.effort = Some(effort),
            Err(_) => choice
                .warnings
                .push(PlanWarning::new("planner_effort_unusable", "bad_shape")),
        }
    }
    choice
}

/// `<설정 폴더>`(`~/.claude`)의 하네스 설정에서 읽는다. 읽기만 한다.
pub fn read_planner(claude_dir: &Path) -> PlannerChoice {
    let (state, config) = config::read(&claude_dir.join("harness"));
    choose_planner(state, &config)
}

/// 이 프로세스의 환경(`CLAUDE_CONFIG_DIR` · 홈)으로 정한 위치에서 읽는다.
pub fn planner_here() -> PlannerChoice {
    match locate::locations_here() {
        Ok(locations) => read_planner(&locations.claude_dir),
        Err(_) => PlannerChoice {
            warnings: vec![PlanWarning::new(
                "planner_config_missing",
                "location_unusable",
            )],
            ..PlannerChoice::default()
        },
    }
}

/// 프로젝트 번호 → 시작 계획. 등록 안 된 번호 · 폴더 없어짐 · 고를 수 없는 폴더는 여기서 거절한다 (프로세스를 띄우기 전).
pub fn plan_start(
    db: &AppDb,
    env: &Env,
    planner: PlannerChoice,
    request: &StartRequest,
) -> Result<StartPlan, AppError> {
    let project_dir = projects::session_dir(db, env, request.project_id)?;
    Ok(StartPlan {
        project_id: request.project_id,
        project_dir,
        resume: request.resume,
        use_api_key: request.use_api_key,
        model: planner.model,
        effort: planner.effort,
        warnings: planner.warnings,
    })
}

/// 시작한 프로젝트를 "최근에 연" 으로 적는다. 못 적어도(읽기 전용 DB 등) 세션은 이미 떴으니 로그와 알림만 남긴다.
fn touch_started(db: &AppDb, manager: &SessionManager, project_id: i64) {
    if let Err(err) = projects::touch(db, project_id) {
        log::warn!("could not record the project as opened: {err}");
        manager.warn_current("project_touch_failed", Some(err.kind().to_string()));
    }
}

/// 세션을 시작한다 — 계획을 세우고, 띄우고, 프로젝트를 "최근에 연" 으로 적는다.
pub fn start_session(
    manager: &SessionManager,
    db: &AppDb,
    env: &Env,
    planner: PlannerChoice,
    request: &StartRequest,
    command: ClaudeCommand,
) -> Result<StartInfo, AppError> {
    let plan = plan_start(db, env, planner, request)?;
    let info = manager.start(plan, command)?;
    touch_started(db, manager, info.project_id);
    Ok(info)
}

/// 이 프로젝트의 마지막 세션 ID (이어 하기용). 폴더가 지금 있어야 한다 (`project_folder_missing`).
pub fn last_session(
    manager: &SessionManager,
    db: &AppDb,
    project_id: i64,
) -> Result<Option<String>, AppError> {
    let dir = projects::existing_dir(db, project_id)?;
    let text = dir
        .to_str()
        .ok_or_else(|| AppError::InvalidInput("project folder is not valid UTF-8".into()))?;
    manager.last_session(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;
    use std::fs;

    fn config_with(model: Option<&str>, effort: Option<&str>) -> HarnessConfig {
        HarnessConfig {
            planner_model: model.map(str::to_string),
            planner_effort: effort.map(str::to_string),
            ..HarnessConfig::default()
        }
    }

    fn codes(choice: &PlannerChoice) -> Vec<&'static str> {
        choice.warnings.iter().map(|w| w.code).collect()
    }

    #[test]
    fn a_normal_planner_setting_is_passed_through() {
        let choice = choose_planner(ConfigState::Local, &config_with(Some("opus"), Some("high")));
        assert_eq!(choice.model.as_deref(), Some("opus"));
        assert_eq!(choice.effort.as_deref(), Some("high"));
        assert!(choice.warnings.is_empty());
        // 예시 설정도 하네스의 기본값이라 같게 쓴다
        let example = choose_planner(
            ConfigState::Example,
            &config_with(Some("sonnet[1m]"), Some("XHIGH")),
        );
        assert_eq!(example.model.as_deref(), Some("sonnet[1m]"));
        assert_eq!(example.effort.as_deref(), Some("xhigh"));
        assert!(example.warnings.is_empty());
    }

    #[test]
    fn no_config_or_a_broken_config_starts_with_cli_defaults_and_a_warning() {
        let missing = choose_planner(ConfigState::None, &HarnessConfig::default());
        assert_eq!((missing.model, missing.effort), (None, None));
        assert_eq!(
            missing.warnings,
            vec![PlanWarning::new("planner_config_missing", "none")]
        );
        // 깨진 설정은 예시로 대신하지 않는다 — 값이 있어도 쓰지 않는다
        let broken = choose_planner(
            ConfigState::Unreadable,
            &config_with(Some("opus"), Some("high")),
        );
        assert_eq!((broken.model, broken.effort), (None, None));
        assert_eq!(
            broken.warnings,
            vec![PlanWarning::new("planner_config_unreadable", "unreadable")]
        );
    }

    #[test]
    fn a_readable_config_without_planner_values_is_quietly_the_cli_default() {
        let choice = choose_planner(ConfigState::Local, &HarnessConfig::default());
        assert_eq!((choice.model.clone(), choice.effort.clone()), (None, None));
        assert!(choice.warnings.is_empty());
        // 한쪽만 정해도 된다
        let model_only = choose_planner(ConfigState::Local, &config_with(Some("opus"), None));
        assert_eq!(model_only.model.as_deref(), Some("opus"));
        assert_eq!(model_only.effort, None);
        assert!(model_only.warnings.is_empty());
    }

    #[test]
    fn odd_values_are_dropped_one_by_one_with_a_warning_each() {
        for model in [
            "--dangerously-skip-permissions",
            "opus --max-turns 1",
            "a;b",
            "$(calc)",
            "오퍼스",
            "-x",
        ] {
            let choice =
                choose_planner(ConfigState::Local, &config_with(Some(model), Some("high")));
            assert_eq!(choice.model, None, "{model}");
            assert_eq!(choice.effort.as_deref(), Some("high"), "{model}");
            assert_eq!(codes(&choice), ["planner_model_unusable"], "{model}");
        }
        for effort in ["ultra", "--help", "high medium", "5", "높음"] {
            let choice =
                choose_planner(ConfigState::Local, &config_with(Some("opus"), Some(effort)));
            assert_eq!(choice.model.as_deref(), Some("opus"), "{effort}");
            assert_eq!(choice.effort, None, "{effort}");
            assert_eq!(codes(&choice), ["planner_effort_unusable"], "{effort}");
        }
        // 둘 다 이상하면 경고도 둘
        let both = choose_planner(ConfigState::Local, &config_with(Some("a b"), Some("nope")));
        assert_eq!(
            codes(&both),
            ["planner_model_unusable", "planner_effort_unusable"]
        );
    }

    #[test]
    fn a_value_flagged_odd_by_the_reader_is_never_used_even_if_its_cut_form_looks_fine() {
        // 글이 아니거나 너무 긴 값은 읽는 쪽이 앞부분만 남겨 두는데, 그 앞부분을 믿고 넘기지 않는다
        let config = HarnessConfig {
            planner_model: Some("m".repeat(64)),
            planner_model_odd: true,
            planner_effort: Some("high".into()),
            planner_effort_odd: true,
            ..HarnessConfig::default()
        };
        let choice = choose_planner(ConfigState::Local, &config);
        assert_eq!((choice.model.clone(), choice.effort.clone()), (None, None));
        assert_eq!(
            codes(&choice),
            ["planner_model_unusable", "planner_effort_unusable"]
        );
    }

    fn claude_dir_with_config(name: &str, config: Option<&str>) -> TempDir {
        let dir = TempDir::new(name);
        fs::create_dir_all(dir.join("harness")).unwrap();
        if let Some(config) = config {
            fs::write(dir.join("harness").join("config.local.json"), config).unwrap();
        }
        dir
    }

    #[test]
    fn the_planner_is_read_from_the_installed_harness_config() {
        let dir = claude_dir_with_config(
            "launch-real",
            Some(r#"{ "planner": { "model": "opus", "effort": "high" }, "agents": {} }"#),
        );
        let choice = read_planner(&dir);
        assert_eq!(choice.model.as_deref(), Some("opus"));
        assert_eq!(choice.effort.as_deref(), Some("high"));
        assert!(choice.warnings.is_empty());
    }

    #[test]
    fn reading_the_planner_from_disk_handles_missing_broken_and_odd_files() {
        // 설정 파일이 없다 (하네스 폴더만 있음 · 하네스 폴더도 없음)
        let none = claude_dir_with_config("launch-none", None);
        assert_eq!(codes(&read_planner(&none)), ["planner_config_missing"]);
        let empty = TempDir::new("launch-noharness");
        assert_eq!(codes(&read_planner(&empty)), ["planner_config_missing"]);
        // 깨진 JSON · 객체가 아닌 JSON
        for text in ["{ broken", "[1]", ""] {
            let dir = claude_dir_with_config("launch-broken", Some(text));
            let choice = read_planner(&dir);
            assert_eq!(codes(&choice), ["planner_config_unreadable"], "{text:?}");
            assert_eq!((choice.model, choice.effort), (None, None));
        }
        // 이상한 모양: 숫자 · 목록 · 너무 긴 글 · 옵션처럼 보이는 글
        let long = "x".repeat(200);
        let odd = claude_dir_with_config(
            "launch-odd",
            Some(&format!(
                r#"{{ "planner": {{ "model": 5, "effort": ["high"] }}, "x": "{long}" }}"#
            )),
        );
        let choice = read_planner(&odd);
        assert_eq!(
            codes(&choice),
            ["planner_model_unusable", "planner_effort_unusable"]
        );
        let long_model = claude_dir_with_config(
            "launch-long",
            Some(&format!(r#"{{ "planner": {{ "model": "{long}" }} }}"#)),
        );
        assert_eq!(
            codes(&read_planner(&long_model)),
            ["planner_model_unusable"]
        );
        let option_like = claude_dir_with_config(
            "launch-option",
            Some(
                r#"{ "planner": { "model": "--dangerously-skip-permissions", "effort": "low" } }"#,
            ),
        );
        let choice = read_planner(&option_like);
        assert_eq!(choice.model, None);
        assert_eq!(choice.effort.as_deref(), Some("low"));
        // 빈 글은 "정하지 않음"
        let blank = claude_dir_with_config(
            "launch-blank",
            Some(r#"{ "planner": { "model": "  ", "effort": "" } }"#),
        );
        let choice = read_planner(&blank);
        assert_eq!((choice.model.clone(), choice.effort.clone()), (None, None));
        assert!(choice.warnings.is_empty());
    }

    #[test]
    fn warnings_carry_only_short_codes_never_the_config_text() {
        let dir = claude_dir_with_config(
            "launch-secret",
            Some(
                r#"{ "vault": { "path": "/secret/place" }, "planner": { "model": "bad value with spaces" } }"#,
            ),
        );
        let choice = read_planner(&dir);
        let text = format!("{:?}", choice.warnings);
        assert!(
            !text.contains("secret") && !text.contains("spaces"),
            "{text}"
        );
    }
}
