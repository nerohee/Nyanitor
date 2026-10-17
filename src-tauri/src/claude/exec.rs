//! `claude` 를 띄우는 한 곳 — 환경 정리 · 창 숨기기 · 짧은 명령 돌려 결과 받기.
//!
//! 실행 파일은 찾은 `claude`(또는 시험에서 가짜 CLI)뿐이고 인자는 이 모듈을 쓰는 Rust 코드가 만든다.
//! 화면(IPC)에서 실행 파일 · 인자 · 환경을 받는 길은 없다.

use std::ffi::{OsStr, OsString};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use super::process_tree::{self, ProcessTree};

/// 환경에 있으면 CLI 가 구독 대신 이 키로 과금한다 (D-19). 값은 읽지도 남기지도 않는다.
pub const API_KEY_VAR: &str = "ANTHROPIC_API_KEY";

/// Claude Code 가 부모일 때 자기 자식에게 넣는 변수 (`notes/P3-01-cli-protocol.md` §2, D-44).
/// 사용자가 직접 정한 다른 `CLAUDE_CODE_*` (Bedrock · 프록시 · Git Bash 위치 등)는 그대로 넘긴다.
const PARENT_ONLY_NAMES: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_PID",
    "MCP_CONNECTION_NONBLOCKING",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_EMIT_STARTUP_TIMING",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_ENABLE_TASKS",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
];
const PARENT_ONLY_PREFIXES: &[&str] = &[
    "CLAUDE_AGENT_SDK_",
    "CLAUDE_CODE_MESSAGING_",
    "CLAUDE_CODE_SESSION_",
    "CLAUDE_CODE_CHILD_",
];

/// 이 이름의 환경 변수를 자식에게 넘기지 않는가. 이름 비교는 대소문자를 가리지 않는다 (Windows).
pub fn is_stripped_name(name: &str, keep_api_key: bool) -> bool {
    let upper = name.to_ascii_uppercase();
    if upper == API_KEY_VAR {
        return !keep_api_key;
    }
    PARENT_ONLY_NAMES.contains(&upper.as_str())
        || PARENT_ONLY_PREFIXES.iter().any(|p| upper.starts_with(p))
}

/// 부모 환경에서 자식에게 넘길 것만 남긴다.
pub fn clean_env(
    base: impl IntoIterator<Item = (OsString, OsString)>,
    keep_api_key: bool,
) -> Vec<(OsString, OsString)> {
    base.into_iter()
        .filter(|(name, _)| !is_stripped_name(&name.to_string_lossy(), keep_api_key))
        .collect()
}

/// 환경에 `ANTHROPIC_API_KEY` 가 있는가 — 있음/없음만 본다.
pub fn api_key_present() -> bool {
    std::env::var_os(API_KEY_VAR).is_some()
}

/// 있으면 Claude Code 가 구독이 아닌 곳으로 인증 · 과금할 수 있는 변수 (공식 문서 env-vars 의 인증 · 제공자 선택 변수, D-45).
/// 값은 읽지 않고 이름이 있는지만 본다. `ANTHROPIC_API_KEY` 는 D-19 대로 따로 (기본으로 자식에게 넘기지 않는다).
/// 이 변수들은 자식에게 **그대로 넘어간다** (사용자가 일부러 정한 설정) — 알리기만 한다.
const OTHER_BILLING_TOKENS: &[&str] = &[
    "ANTHROPIC_AUTH_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ANTHROPIC_AWS_API_KEY",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_FEDERATION_RULE_ID",
];

/// 제공자를 고르는 켜고 끄는 변수. 문서: 빈 값은 설정하지 않은 것으로 본다 → 빈 값이면 치지 않는다 (값이 아닌 켜짐 여부만).
const OTHER_BILLING_SWITCHES: &[&str] = &[
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
];

/// `lookup` 이 돌려주는 환경으로 다른 과금 변수 이름을 찾는다 (시험에서 환경을 바꿔 끼우려고 나눔).
pub fn other_billing_vars_in(lookup: impl Fn(&str) -> Option<OsString>) -> Vec<String> {
    let tokens = OTHER_BILLING_TOKENS
        .iter()
        .filter(|name| lookup(name).is_some());
    let switches = OTHER_BILLING_SWITCHES
        .iter()
        .filter(|name| lookup(name).is_some_and(|value| !value.is_empty()));
    tokens
        .chain(switches)
        .map(|name| (*name).to_string())
        .collect()
}

/// 이 프로세스의 환경에서 다른 과금 변수 이름 목록.
pub fn other_billing_vars() -> Vec<String> {
    other_billing_vars_in(|name| std::env::var_os(name))
}

/// `.cmd` · `.bat` 인가 — Windows 에서 `cmd.exe` 가 대신 실행하는 스크립트.
pub fn is_batch_script(program: &Path) -> bool {
    program
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// `cmd.exe` 가 이 변수가 1 이면 실행 파일을 찾을 때 현재 폴더를 보지 않는다. npm 설치의 `claude.cmd` 는 `node` 를 이름으로 불러서
/// 현재 폴더(프로젝트 폴더 · 임시 폴더)의 가짜 `node.exe/.cmd` 가 먼저 실행될 수 있다 (D-45).
pub const NO_CURRENT_DIR_VAR: &str = "NoDefaultCurrentDirectoryInExePath";

/// 스크립트를 띄우는 자식에게 현재 폴더 탐색을 끄는 변수를 더한다 (스크립트가 아니면 아무 일도 안 한다).
pub fn guard_script_search(command: &mut Command, program: &Path) {
    if is_batch_script(program) {
        command.env(NO_CURRENT_DIR_VAR, "1");
    }
}

/// 짧은 명령(`--version`, `auth status`)이 돌려준 것.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Captured {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// 읽어 둘 출력의 최대 크기 (넘는 부분은 버린다).
const CAPTURE_LIMIT: usize = 1 << 20;

/// 실행할 `claude` 한 개와 그 환경 규칙.
#[derive(Debug, Clone)]
pub struct ClaudeCommand {
    program: PathBuf,
    keep_api_key: bool,
    /// 시험용: 자식에게 더 넘길 변수 (정리한 뒤에 얹는다). 화면에서는 채울 수 없다.
    extra_env: Vec<(OsString, OsString)>,
    /// 시험용: 부모 환경 대신 쓸 값. `None` 이면 이 프로세스의 환경.
    base_env: Option<Vec<(OsString, OsString)>>,
}

impl ClaudeCommand {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            keep_api_key: false,
            extra_env: Vec::new(),
            base_env: None,
        }
    }

    /// 설정에서 "키 사용" 을 골랐을 때만 `ANTHROPIC_API_KEY` 를 넘긴다 (D-19).
    pub fn keep_api_key(mut self, keep: bool) -> Self {
        self.keep_api_key = keep;
        self
    }

    pub fn with_extra_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.extra_env.push((name.into(), value.into()));
        self
    }

    pub fn with_base_env(mut self, base: Vec<(OsString, OsString)>) -> Self {
        self.base_env = Some(base);
        self
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    /// 환경을 정리하고 창이 뜨지 않게(Windows) 만든 `Command`. 입출력 · 작업 폴더는 부르는 쪽이 정한다.
    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new(&self.program);
        command.args(args);
        let base = self
            .base_env
            .clone()
            .unwrap_or_else(|| std::env::vars_os().collect());
        command.env_clear();
        command.envs(clean_env(base, self.keep_api_key));
        command.envs(self.extra_env.iter().map(|(k, v)| (k, v)));
        guard_script_search(&mut command, &self.program);
        hide_window(&mut command);
        process_tree::prepare_command(&mut command);
        command
    }

    /// 짧은 명령을 돌려 결과를 받는다. 시간이 넘으면 트리를 끄고 `timed_out` 으로 돌려준다.
    pub fn run_capture<I, S>(&self, args: I, timeout: Duration) -> io::Result<Captured>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = self.command(args);
        command
            .current_dir(std::env::temp_dir())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let tree = ProcessTree::attach(&child);
        let stdout = child.stdout.take().map(read_capped);
        let stderr = child.stderr.take().map(read_capped);

        let deadline = Instant::now() + timeout;
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                tree.kill();
                break child.wait()?;
            }
            thread::sleep(Duration::from_millis(10));
        };
        // 끝난 뒤 남은 손자 프로세스가 출력 파이프를 쥐고 있어도 읽기가 끝나게 한다.
        tree.kill();
        let join = |handle: Option<thread::JoinHandle<String>>| {
            handle.and_then(|h| h.join().ok()).unwrap_or_default()
        };
        Ok(Captured {
            code: status.code(),
            stdout: join(stdout),
            stderr: join(stderr),
            timed_out,
        })
    }
}

fn read_capped<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = CAPTURE_LIMIT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..n.min(room)]);
                }
            }
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

/// Windows 에서 콘솔 창이 뜨지 않게 한다 (`CREATE_NO_WINDOW`).
pub fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn names(vars: &[(OsString, OsString)]) -> Vec<String> {
        vars.iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn strips_what_claude_code_puts_in_its_children() {
        let base = env(&[
            ("PATH", "x"),
            ("CLAUDECODE", "1"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_CODE_SESSION_ID", "abc"),
            ("CLAUDE_CODE_MESSAGING_TOKEN", "secret"),
            ("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT", "markdown"),
            ("CLAUDE_AGENT_SDK_VERSION", "1"),
            ("CLAUDE_PID", "42"),
            ("MCP_CONNECTION_NONBLOCKING", "1"),
            ("HOME", "h"),
        ]);
        assert_eq!(names(&clean_env(base, false)), ["PATH", "HOME"]);
    }

    #[test]
    fn keeps_what_the_user_set_on_purpose() {
        let base = env(&[
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("CLAUDE_CODE_GIT_BASH_PATH", "C:\\Git\\bash.exe"),
            ("ANTHROPIC_BASE_URL", "http://proxy"),
            ("ANTHROPIC_AUTH_TOKEN", "t"),
        ]);
        assert_eq!(clean_env(base.clone(), false), base);
    }

    #[test]
    fn api_key_is_dropped_unless_asked_for() {
        let base = env(&[("ANTHROPIC_API_KEY", "sk-fake"), ("PATH", "x")]);
        assert_eq!(names(&clean_env(base.clone(), false)), ["PATH"]);
        assert_eq!(names(&clean_env(base, true)), ["ANTHROPIC_API_KEY", "PATH"]);
    }

    #[test]
    fn name_matching_ignores_case_like_windows_does() {
        assert!(is_stripped_name("claudecode", false));
        assert!(is_stripped_name("Anthropic_Api_Key", false));
        assert!(!is_stripped_name("Anthropic_Api_Key", true));
        assert!(is_stripped_name("claude_code_session_whatever", false));
        assert!(!is_stripped_name("CLAUDE_CONFIG_DIR", false));
    }

    #[test]
    fn command_gets_the_cleaned_env_plus_extras_only() {
        let cmd = ClaudeCommand::new("claude")
            .with_base_env(env(&[
                ("PATH", "x"),
                ("CLAUDECODE", "1"),
                ("ANTHROPIC_API_KEY", "sk-fake"),
            ]))
            .with_extra_env("EXTRA", "1");
        let built = cmd.command(["--version"]);
        let envs: Vec<_> = built
            .get_envs()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.is_some()))
            .collect();
        assert!(envs.contains(&("PATH".to_string(), true)));
        assert!(envs.contains(&("EXTRA".to_string(), true)));
        assert!(!envs.iter().any(|(k, _)| k == "CLAUDECODE"));
        assert!(!envs.iter().any(|(k, _)| k == "ANTHROPIC_API_KEY"));
    }
}

/// P3-03 — 환경 정리 경계 시험 (이름의 대소문자 · 접두사만 같은 사용자 변수 · 빈 값).
#[cfg(test)]
mod edge_tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn kept(pairs: &[(&str, &str)], keep_key: bool) -> Vec<String> {
        clean_env(env(pairs), keep_key)
            .into_iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn the_api_key_is_dropped_whatever_the_case_of_its_name() {
        for name in [
            "ANTHROPIC_API_KEY",
            "anthropic_api_key",
            "AnThRoPiC_api_key",
            "Anthropic_Api_Key",
            "ANTHROPIC_api_KEY",
        ] {
            assert!(
                kept(&[(name, "sk-fake"), ("PATH", "x")], false) == ["PATH"],
                "{name}"
            );
            // 허용하면 원래 이름 그대로 넘어간다
            assert!(kept(&[(name, "sk-fake")], true) == [name], "{name}");
        }
    }

    #[test]
    fn an_empty_api_key_value_is_dropped_too_and_an_empty_value_elsewhere_is_kept() {
        assert_eq!(
            kept(&[("ANTHROPIC_API_KEY", ""), ("EMPTY", "")], false),
            ["EMPTY"]
        );
    }

    #[test]
    fn user_variables_that_only_share_a_prefix_or_suffix_with_a_stripped_name_survive() {
        let survivors = [
            "ANTHROPIC_API_KEY_2",
            "ANTHROPIC_API_KEYS",
            "ANTHROPIC_API_KEY_FILE",
            "MY_ANTHROPIC_API_KEY",
            "X_ANTHROPIC_API_KEY",
            "ANTHROPIC_API",
            "ANTHROPIC_API_KE",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_MODEL",
            "CLAUDECODE_HOME",
            "CLAUDECODEX",
            "X_CLAUDECODE",
            "CLAUDE_PIDS",
            "CLAUDE_PID_FILE",
            "CLAUDE_CODE_ENTRYPOINT_X",
            "CLAUDE_CODE_SESSIONS",
            "CLAUDE_CODE_SESSION",
            "CLAUDE_CODE_MESSAGING",
            "CLAUDE_CODE_CHILD",
            "CLAUDE_AGENT_SDK",
            "CLAUDE_AGENT",
            "MCP_CONNECTION_NONBLOCKING_X",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_GIT_BASH_PATH",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
            "HTTPS_PROXY",
        ];
        let pairs: Vec<(&str, &str)> = survivors.iter().map(|n| (*n, "v")).collect();
        assert_eq!(kept(&pairs, false), survivors);
    }

    #[test]
    fn every_listed_parent_only_name_and_prefix_is_stripped_in_any_case() {
        for name in PARENT_ONLY_NAMES {
            assert_eq!(kept(&[(name, "1")], false), Vec::<String>::new(), "{name}");
            assert_eq!(
                kept(&[(&name.to_ascii_lowercase(), "1")], false),
                Vec::<String>::new(),
                "{name} (소문자)"
            );
        }
        for prefix in PARENT_ONLY_PREFIXES {
            for suffix in ["X", "VERSION", "a_b_c", "1"] {
                let name = format!("{prefix}{suffix}");
                assert_eq!(kept(&[(&name, "1")], false), Vec::<String>::new(), "{name}");
                let mixed = name
                    .chars()
                    .enumerate()
                    .map(|(i, c)| {
                        if i % 2 == 0 {
                            c.to_ascii_lowercase()
                        } else {
                            c
                        }
                    })
                    .collect::<String>();
                assert_eq!(
                    kept(&[(&mixed, "1")], false),
                    Vec::<String>::new(),
                    "{mixed}"
                );
            }
        }
    }

    #[test]
    fn the_api_key_flag_changes_nothing_else() {
        let pairs = [
            ("CLAUDECODE", "1"),
            ("ANTHROPIC_API_KEY", "k"),
            ("PATH", "p"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ];
        assert_eq!(
            kept(&pairs, true),
            ["ANTHROPIC_API_KEY", "PATH", "CLAUDE_CODE_USE_BEDROCK"]
        );
        assert_eq!(kept(&pairs, false), ["PATH", "CLAUDE_CODE_USE_BEDROCK"]);
    }

    #[test]
    fn order_values_and_duplicates_that_survive_are_kept_as_they_were() {
        let base = env(&[("B", "2"), ("A", "1"), ("A", "again"), ("", "empty-name")]);
        assert_eq!(clean_env(base.clone(), false), base);
    }

    #[test]
    fn non_ascii_names_and_values_pass_through() {
        let base = env(&[("내_변수", "한글 값"), ("PATH", "C:\\내 도구")]);
        assert_eq!(clean_env(base.clone(), false), base);
        // 대문자 변환이 한글 이름을 망가뜨려 잘못 걸러내지 않는다
        assert!(!is_stripped_name("내_변수", false));
        assert!(!is_stripped_name("ǅ_ß_İ", false));
    }

    #[test]
    fn extra_env_for_tests_is_added_after_cleaning_so_it_is_the_only_way_to_add_back() {
        let cmd = ClaudeCommand::new("claude")
            .with_base_env(env(&[("CLAUDECODE", "1"), ("PATH", "x")]))
            .with_extra_env("CLAUDECODE", "tests-only");
        let built = cmd.command(["--version"]);
        let value = built
            .get_envs()
            .find(|(k, _)| *k == OsStr::new("CLAUDECODE"))
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()));
        assert_eq!(value.as_deref(), Some("tests-only"));
    }

    #[test]
    fn a_fresh_command_does_not_inherit_the_api_key_flag_from_the_environment() {
        let cmd = ClaudeCommand::new("claude").with_base_env(env(&[("ANTHROPIC_API_KEY", "k")]));
        let built = cmd.command(["x"]);
        assert!(
            !built
                .get_envs()
                .any(|(k, _)| k == OsStr::new("ANTHROPIC_API_KEY"))
        );
        let built = cmd.keep_api_key(true).command(["x"]);
        assert!(
            built
                .get_envs()
                .any(|(k, _)| k == OsStr::new("ANTHROPIC_API_KEY"))
        );
    }
}

/// P3-05 — `.cmd` · `.bat` 의 현재 폴더 탐색 막기 (D-45) · 다른 과금 변수 알림.
#[cfg(test)]
mod fix_tests {
    use super::*;

    fn guard_value(program: &str, base: Vec<(OsString, OsString)>) -> Option<String> {
        let built = ClaudeCommand::new(program)
            .with_base_env(base)
            .command(["--version"]);
        built
            .get_envs()
            .find(|(k, _)| *k == OsStr::new(NO_CURRENT_DIR_VAR))
            .and_then(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn batch_scripts_are_started_with_the_current_folder_search_turned_off() {
        for program in [
            "C:\\npm\\claude.cmd",
            "C:\\npm\\CLAUDE.CMD",
            "C:\\x\\claude.bat",
            "claude.Bat",
        ] {
            assert_eq!(
                guard_value(program, Vec::new()).as_deref(),
                Some("1"),
                "{program}"
            );
        }
    }

    #[test]
    fn executables_and_lookalikes_do_not_get_the_variable() {
        for program in [
            "C:\\x\\claude.exe",
            "/usr/bin/claude",
            "claude",
            "C:\\x\\claude.cmd.exe",
            "C:\\x\\cmd",
            "C:\\x\\claude.cmdx",
        ] {
            assert_eq!(guard_value(program, Vec::new()), None, "{program}");
        }
    }

    #[test]
    fn a_user_value_in_the_environment_cannot_turn_the_guard_off() {
        let base = vec![(
            OsString::from("NoDefaultCurrentDirectoryInExePath"),
            OsString::from("0"),
        )];
        assert_eq!(
            guard_value("C:\\npm\\claude.cmd", base).as_deref(),
            Some("1")
        );
    }

    #[test]
    fn other_billing_names_are_listed_without_reading_values() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| OsString::from(v))
            }
        };
        assert!(other_billing_vars_in(env(&[])).is_empty());
        // 인증 변수는 값이 비어 있어도 "있음" 이다 (값은 보지 않는다)
        assert_eq!(
            other_billing_vars_in(env(&[
                ("ANTHROPIC_AUTH_TOKEN", ""),
                ("AWS_BEARER_TOKEN_BEDROCK", "x"),
            ])),
            ["ANTHROPIC_AUTH_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]
        );
        // 제공자를 켜는 변수는 빈 값이면 안 켜진 것 (문서: 빈 값은 설정 안 한 것으로 본다)
        assert_eq!(
            other_billing_vars_in(env(&[
                ("CLAUDE_CODE_USE_BEDROCK", "1"),
                ("CLAUDE_CODE_USE_VERTEX", ""),
                ("CLAUDE_CODE_USE_FOUNDRY", "true"),
            ])),
            ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY"]
        );
        // `ANTHROPIC_API_KEY` · 프록시 주소 · 관계없는 변수는 여기 없다 (API 키는 D-19 로 따로)
        assert!(
            other_billing_vars_in(env(&[
                ("ANTHROPIC_API_KEY", "k"),
                ("ANTHROPIC_BASE_URL", "http://proxy"),
                ("PATH", "x"),
            ]))
            .is_empty()
        );
    }

    #[test]
    fn other_billing_variables_are_passed_on_to_the_child_unchanged() {
        let base = vec![
            (OsString::from("ANTHROPIC_AUTH_TOKEN"), OsString::from("t")),
            (
                OsString::from("CLAUDE_CODE_USE_BEDROCK"),
                OsString::from("1"),
            ),
        ];
        let built = ClaudeCommand::new("claude")
            .with_base_env(base)
            .command(["x"]);
        for name in ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"] {
            assert!(
                built.get_envs().any(|(k, _)| k == OsStr::new(name)),
                "{name}"
            );
        }
    }
}
