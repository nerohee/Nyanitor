//! `claude` 찾기 · 버전 · 로그인 상태 (D-19, D-44).
//!
//! 읽는 것: 실행 파일 위치, `claude --version`, `claude auth status --json` 의 `loggedIn` · `authMethod` ·
//! `subscriptionType` 세 개, 환경에 `ANTHROPIC_API_KEY` 가 있는지(있음/없음).
//! 읽지 않는 것: 이메일 · 조직 같은 나머지 필드(받은 글에서 버리고 저장 · 로그 모두 하지 않는다), 토큰 파일, 키체인.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri_plugin_log::log;

use super::KNOWN_CLI_VERSION;
use super::exec::{self, ClaudeCommand};
use crate::error::AppError;

/// 짧은 명령 하나를 기다리는 최대 시간.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
/// `auth status` 출력에서 JSON 시작 자리로 시험해 볼 `{` 의 최대 개수.
const MAX_JSON_STARTS: usize = 32;

/// "찾기" 결과 — 화면의 첫 실행 준비 목록이 쓴다 (D-44: Claude Code 있음 · 로그인됨 · API 키 있음).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub known_version: &'static str,
    /// 확인된 CLI 버전과 같은가 (버전을 못 읽었으면 `None`).
    pub version_matches: Option<bool>,
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
    pub subscription_type: Option<String>,
    pub api_key_present: bool,
    /// 구독이 아닌 곳으로 인증 · 과금할 수 있는 다른 환경 변수의 **이름** (`ANTHROPIC_AUTH_TOKEN`, Bedrock · Vertex 등을 켜는 변수).
    /// 값은 읽지 않고 설정은 그대로 CLI 에 넘긴다 — 알리기만 한다 (D-45).
    pub other_billing: Vec<String>,
    /// 확인 중 막힌 곳 (진단용 짧은 이름, 화면 문구 아님): `version_failed` · `auth_failed`
    pub problem: Option<String>,
}

/// `claude auth status --json` 에서 쓰는 세 필드만.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthInfo {
    pub logged_in: bool,
    pub auth_method: Option<String>,
    pub subscription_type: Option<String>,
}

/// 이 PC 에서 `claude` 실행 파일을 찾는다. 순서: 설정에서 준 경로 → PATH → `~/.local/bin`.
/// PATH 의 상대 경로 칸(`.` 등)은 보지 않는다 (작업 폴더의 파일을 잘못 실행하지 않게).
pub fn locate(
    user_path: Option<&Path>,
    path_var: Option<&OsStr>,
    home: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = user_path
        && path.is_absolute()
        && path.is_file()
    {
        return Some(path.to_path_buf());
    }
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd", "claude.bat"]
    } else {
        &["claude"]
    };
    if let Some(path_var) = path_var {
        for dir in std::env::split_paths(path_var) {
            if !dir.is_absolute() {
                continue;
            }
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    let home = home?;
    let local = home.join(".local").join("bin");
    names
        .iter()
        .map(|name| local.join(name))
        .find(|candidate| candidate.is_file())
}

/// 이 프로세스의 환경(PATH · 홈)으로 찾는다.
pub fn locate_here(user_path: Option<&Path>) -> Option<PathBuf> {
    locate(
        user_path,
        std::env::var_os("PATH").as_deref(),
        std::env::home_dir().as_deref(),
    )
}

/// `claude --version` 의 첫 줄에서 버전 숫자만 (예: `2.1.296 (Claude Code)` → `2.1.296`).
pub fn parse_version(output: &str) -> Option<String> {
    let token = output.lines().next()?.split_whitespace().next()?;
    let is_version = token.starts_with(|c: char| c.is_ascii_digit())
        && token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+');
    is_version.then(|| token.to_string())
}

pub fn read_version(cmd: &ClaudeCommand) -> Result<String, AppError> {
    let out = cmd
        .run_capture(["--version"], PROBE_TIMEOUT)
        .map_err(|e| AppError::Internal(format!("could not run claude --version: {e}")))?;
    if out.timed_out {
        return Err(AppError::Internal("claude --version timed out".into()));
    }
    if out.code != Some(0) {
        return Err(AppError::Internal(format!(
            "claude --version exited with {:?}",
            out.code
        )));
    }
    parse_version(&out.stdout)
        .ok_or_else(|| AppError::Internal("claude --version printed no version number".into()))
}

/// 글이 JSON 하나이거나 앞에 다른 글이 섞여 있어도 첫 `{` 부터 읽는다. 오류 글에 받은 내용은 넣지 않는다 (이메일이 있을 수 있음).
pub fn parse_auth_status(stdout: &str) -> Result<AuthInfo, AppError> {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(rename = "loggedIn")]
        logged_in: bool,
        #[serde(rename = "authMethod")]
        auth_method: Option<String>,
        #[serde(rename = "subscriptionType")]
        subscription_type: Option<String>,
    }
    // 앞 글에 `{` 가 있을 수 있다 (`config {default} loaded`) — 읽어지는 첫 `{` 를 찾는다. 시도 횟수는 막아 둔다.
    let mut tried = 0;
    let mut raw: Option<Raw> = None;
    for (start, _) in stdout.match_indices('{').take(MAX_JSON_STARTS) {
        tried += 1;
        let parsed = serde_json::Deserializer::from_str(&stdout[start..])
            .into_iter::<Raw>()
            .next();
        if let Some(Ok(found)) = parsed {
            raw = Some(found);
            break;
        }
    }
    let raw = raw.ok_or_else(|| {
        AppError::Internal(if tried == 0 {
            "auth status printed no JSON".into()
        } else {
            "auth status JSON has an unexpected shape".into()
        })
    })?;
    Ok(AuthInfo {
        logged_in: raw.logged_in,
        auth_method: raw.auth_method.map(short),
        subscription_type: raw.subscription_type.map(short),
    })
}

/// 화면에 그대로 가는 짧은 이름이라 길이를 막아 둔다.
fn short(text: String) -> String {
    text.chars().take(64).collect()
}

/// `claude auth status --json`. 로그인 안 됨은 종료 코드 1 이지만 JSON 은 똑같이 나오므로 코드는 보지 않는다.
pub fn read_auth(cmd: &ClaudeCommand) -> Result<AuthInfo, AppError> {
    let out = cmd
        .run_capture(["auth", "status", "--json"], PROBE_TIMEOUT)
        .map_err(|e| AppError::Internal(format!("could not run claude auth status: {e}")))?;
    if out.timed_out {
        return Err(AppError::Internal("claude auth status timed out".into()));
    }
    parse_auth_status(&out.stdout)
}

/// 찾기 전체. `cmd` 가 `None` 이면 "못 찾음".
pub fn status(cmd: Option<&ClaudeCommand>, api_key_present: bool) -> ClaudeStatus {
    status_with(cmd, api_key_present, Vec::new())
}

/// `status` + 환경에서 찾은 다른 과금 변수 이름.
pub fn status_with(
    cmd: Option<&ClaudeCommand>,
    api_key_present: bool,
    other_billing: Vec<String>,
) -> ClaudeStatus {
    let mut status = ClaudeStatus {
        found: cmd.is_some(),
        path: cmd.map(|c| c.program().display().to_string()),
        version: None,
        known_version: KNOWN_CLI_VERSION,
        version_matches: None,
        logged_in: None,
        auth_method: None,
        subscription_type: None,
        api_key_present,
        other_billing,
        problem: None,
    };
    let Some(cmd) = cmd else {
        return status;
    };
    match read_version(cmd) {
        Ok(version) => {
            status.version_matches = Some(version == KNOWN_CLI_VERSION);
            status.version = Some(version);
        }
        Err(err) => {
            log::warn!("claude version check failed: {err}");
            status.problem = Some("version_failed".into());
        }
    }
    match read_auth(cmd) {
        Ok(auth) => {
            status.logged_in = Some(auth.logged_in);
            status.auth_method = auth.auth_method;
            status.subscription_type = auth.subscription_type;
        }
        Err(err) => {
            log::warn!("claude auth status check failed: {err}");
            status.problem.get_or_insert_with(|| "auth_failed".into());
        }
    }
    status
}

/// 이 PC 에서 찾아 확인한다.
pub fn status_here() -> ClaudeStatus {
    let cmd = locate_here(None).map(ClaudeCommand::new);
    status_with(
        cmd.as_ref(),
        exec::api_key_present(),
        exec::other_billing_vars(),
    )
}

/// `cmd.exe /C start ...` 에 넘길 글. 새 콘솔 창에서 `claude auth login` 이 돈다.
/// 경로에 따옴표나 `%` 가 있으면 cmd 가 다르게 읽을 수 있어 거절한다.
fn login_command_line(program: &Path) -> Result<OsString, AppError> {
    let text = program.to_string_lossy();
    if text.contains(['"', '%']) || text.chars().any(char::is_control) {
        return Err(AppError::InvalidInput(
            "claude path has characters that cannot be passed to the login window".into(),
        ));
    }
    let mut line = OsString::from("/C start \"Nyanitor login\" \"");
    line.push(program.as_os_str());
    line.push("\" auth login");
    Ok(line)
}

/// 로그인 창을 띄울 `cmd.exe` 의 절대 경로: `<SystemRoot>\System32\cmd.exe` (`SystemRoot` 가 없거나 비었으면 `C:\Windows`).
#[cfg_attr(not(windows), allow(dead_code))]
fn system_cmd_exe(system_root: Option<&OsStr>) -> PathBuf {
    let root = system_root
        .filter(|root| !root.is_empty())
        .map_or_else(|| PathBuf::from("C:\\Windows"), PathBuf::from);
    root.join("System32").join("cmd.exe")
}

/// 로그인 안 됨 → `claude auth login` 을 새 터미널 창으로 띄운다. 로그인 흐름은 Anthropic 것이고 앱은 만들지 않는다 (D-19).
/// 끝난 뒤 화면이 `status` 를 다시 불러 확인한다.
pub fn open_login_window(program: &Path) -> Result<(), AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let line = login_command_line(program)?;
        // `cmd.exe` 자체는 창 없이 돌고, `start` 가 claude 를 새 콘솔 창으로 띄운다.
        // PATH 에서 찾지 않고 System32 의 것을 쓴다 (환경을 비운 자식 · 쓰기 가능한 폴더의 가짜 `cmd.exe` 를 막는다).
        let mut command = Command::new(system_cmd_exe(std::env::var_os("SystemRoot").as_deref()));
        command
            .raw_arg(line)
            .env_clear()
            .envs(exec::clean_env(std::env::vars_os(), false))
            .current_dir(std::env::temp_dir())
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // `claude.cmd` 가 새 창에서 `node` 를 찾을 때도 현재 폴더를 보지 않게 (D-45).
        exec::guard_script_search(&mut command, program);
        let mut child = command
            .spawn()
            .map_err(|e| AppError::Internal(format!("could not open the login window: {e}")))?;
        // `start` 는 바로 돌아온다. 핸들만 정리한다.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = program;
        Err(AppError::Internal(
            "opening the login window is only supported on Windows for now".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::TempDir;
    use super::*;
    use std::fs;

    fn temp(name: &str) -> TempDir {
        TempDir::new(name)
    }

    fn exe_name() -> &'static str {
        if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        }
    }

    #[test]
    fn locate_prefers_the_user_path() {
        let dir = temp("user");
        let mine = dir.join("my-claude");
        fs::write(&mine, b"x").unwrap();
        let found = locate(Some(&mine), Some(OsStr::new("")), None);
        assert_eq!(found, Some(mine));
    }

    #[test]
    fn locate_ignores_a_user_path_that_is_missing_or_relative() {
        assert_eq!(
            locate(Some(Path::new("nope")), Some(OsStr::new("")), None),
            None
        );
        let dir = temp("user-missing");
        assert_eq!(
            locate(Some(&dir.join("missing")), Some(OsStr::new("")), None),
            None
        );
    }

    #[test]
    fn locate_walks_path_in_order_and_skips_relative_entries() {
        let first = temp("path-a");
        let second = temp("path-b");
        fs::write(second.join(exe_name()), b"x").unwrap();
        let path_var = std::env::join_paths([
            PathBuf::from("."),
            first.to_path_buf(),
            second.to_path_buf(),
        ])
        .unwrap();
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(second.join(exe_name()))
        );
        // 앞 칸에도 있으면 앞 칸이 이긴다.
        fs::write(first.join(exe_name()), b"x").unwrap();
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(first.join(exe_name()))
        );
    }

    #[test]
    fn locate_falls_back_to_home_local_bin() {
        let home = temp("home");
        let bin = home.join(".local").join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join(exe_name()), b"x").unwrap();
        assert_eq!(
            locate(None, Some(OsStr::new("")), Some(home.path())),
            Some(bin.join(exe_name()))
        );
    }

    #[test]
    fn locate_returns_none_when_nothing_is_there() {
        let home = temp("empty-home");
        let empty = temp("empty-path");
        let path_var = std::env::join_paths([empty.path()]).unwrap();
        assert_eq!(locate(None, Some(&path_var), Some(home.path())), None);
        assert_eq!(locate(None, None, None), None);
    }

    #[cfg(windows)]
    #[test]
    fn locate_finds_an_npm_style_cmd_shim() {
        let dir = temp("npm");
        fs::write(dir.join("claude.cmd"), b"x").unwrap();
        // 확장자 없는 sh 스크립트는 Windows 에서 실행할 수 없으니 고르지 않는다.
        fs::write(dir.join("claude"), b"x").unwrap();
        let path_var = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(dir.join("claude.cmd"))
        );
    }

    #[test]
    fn parses_the_version_line() {
        assert_eq!(
            parse_version("2.1.296 (Claude Code)\n"),
            Some("2.1.296".into())
        );
        assert_eq!(parse_version("2.2.0\r\n"), Some("2.2.0".into()));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("error: nope"), None);
    }

    #[test]
    fn parses_logged_in_status_and_drops_the_rest() {
        let json = r#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"someone@example.com","orgName":"Example Org","subscriptionType":"pro"}"#;
        let info = parse_auth_status(json).unwrap();
        assert_eq!(
            info,
            AuthInfo {
                logged_in: true,
                auth_method: Some("claude.ai".into()),
                subscription_type: Some("pro".into())
            }
        );
        let debug = format!("{info:?}");
        assert!(!debug.contains("example.com") && !debug.contains("Example Org"));
    }

    #[test]
    fn parses_logged_out_status() {
        let info = parse_auth_status(r#"{"loggedIn":false,"authMethod":"none"}"#).unwrap();
        assert!(!info.logged_in);
        assert_eq!(info.auth_method.as_deref(), Some("none"));
        assert_eq!(info.subscription_type, None);
    }

    #[test]
    fn auth_status_garbage_is_an_error_without_echoing_the_text() {
        for bad in [
            "",
            "no json here",
            r#"{"loggedIn":"yes"}"#,
            r#"{"email":"a@b.c"}"#,
        ] {
            let err = parse_auth_status(bad).unwrap_err();
            assert_eq!(err.kind(), "internal");
            assert!(!err.to_string().contains("a@b.c"));
        }
    }

    #[test]
    fn auth_status_tolerates_text_before_the_json() {
        let info = parse_auth_status("warning: something\n{\"loggedIn\":true}\n").unwrap();
        assert!(info.logged_in);
    }

    #[test]
    fn status_without_claude_is_not_found() {
        let status = status(None, true);
        assert!(!status.found);
        assert_eq!(status.path, None);
        assert!(status.api_key_present);
        assert_eq!(status.known_version, KNOWN_CLI_VERSION);
    }

    #[test]
    fn login_command_line_quotes_the_program() {
        let line = login_command_line(Path::new("C:\\Program Files\\claude\\claude.exe")).unwrap();
        assert_eq!(
            line.to_string_lossy(),
            "/C start \"Nyanitor login\" \"C:\\Program Files\\claude\\claude.exe\" auth login"
        );
    }

    #[test]
    fn login_command_line_rejects_characters_cmd_would_reread() {
        for bad in [
            "C:\\a\"b\\claude.exe",
            "C:\\%PATH%\\claude.exe",
            "C:\\a\nb\\claude.exe",
        ] {
            let err = login_command_line(Path::new(bad)).unwrap_err();
            assert_eq!(err.kind(), "invalid_input");
        }
    }
}

/// P3-03 — 찾기 경계 시험 (PATH 의 같은 이름 여러 개 · 디렉터리인 claude · 확장자 순서 · 출력 읽기 · 계정 정보가 안 남는지).
#[cfg(test)]
mod edge_tests {
    use super::super::test_util::TempDir;
    use super::*;
    use std::fs;

    fn path_of(dirs: &[&Path]) -> OsString {
        std::env::join_paths(dirs.iter().copied()).unwrap()
    }

    // ───────── 찾기 ─────────

    #[cfg(windows)]
    #[test]
    fn a_folder_named_claude_exe_is_not_an_executable_and_the_search_goes_on() {
        let fake_dir = TempDir::new("dir-named-exe");
        fs::create_dir(fake_dir.join("claude.exe")).unwrap();
        let real_dir = TempDir::new("real-after-dir");
        fs::write(real_dir.join("claude.exe"), b"x").unwrap();
        let path_var = path_of(&[fake_dir.path(), real_dir.path()]);
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(real_dir.join("claude.exe"))
        );
        // 폴더뿐이면 못 찾음
        let only_dir = path_of(&[fake_dir.path()]);
        assert_eq!(locate(None, Some(&only_dir), None), None);
    }

    #[cfg(windows)]
    #[test]
    fn in_one_folder_exe_wins_over_cmd_and_cmd_over_bat() {
        let dir = TempDir::new("ext-order");
        for name in ["claude.bat", "claude.cmd", "claude.exe"] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        let path_var = path_of(&[dir.path()]);
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(dir.join("claude.exe"))
        );
        fs::remove_file(dir.join("claude.exe")).unwrap();
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(dir.join("claude.cmd"))
        );
        fs::remove_file(dir.join("claude.cmd")).unwrap();
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(dir.join("claude.bat"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn an_earlier_path_folder_wins_even_when_it_only_has_the_less_preferred_extension() {
        // PATH 순서가 확장자 순서보다 앞선다 (where.exe · 셸과 같은 규칙)
        let first = TempDir::new("order-first");
        let second = TempDir::new("order-second");
        fs::write(first.join("claude.cmd"), b"x").unwrap();
        fs::write(second.join("claude.exe"), b"x").unwrap();
        let path_var = path_of(&[first.path(), second.path()]);
        assert_eq!(
            locate(None, Some(&path_var), None),
            Some(first.join("claude.cmd"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn extensionless_and_lookalike_names_are_not_picked_on_windows() {
        let dir = TempDir::new("lookalike");
        for name in [
            "claude",
            "claude.exe.txt",
            "claude.ps1",
            "claude-code.exe",
            "Claude.EXE.bak",
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        let path_var = path_of(&[dir.path()]);
        assert_eq!(locate(None, Some(&path_var), None), None);
    }

    #[test]
    fn empty_missing_and_non_folder_path_entries_are_skipped_without_trouble() {
        let real = TempDir::new("real");
        let exe = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        fs::write(real.join(exe), b"x").unwrap();
        let not_a_folder = real.join(exe); // 파일을 PATH 칸으로
        let missing = real.join("no-such-folder");
        let path_var = std::env::join_paths([
            PathBuf::from(""),
            PathBuf::from("."),
            PathBuf::from(".."),
            PathBuf::from("relative\\bin"),
            not_a_folder,
            missing,
            real.to_path_buf(),
        ])
        .unwrap();
        assert_eq!(locate(None, Some(&path_var), None), Some(real.join(exe)));
        assert_eq!(locate(None, Some(OsStr::new("")), None), None);
    }

    #[test]
    fn a_user_path_that_is_a_folder_or_names_something_else_is_still_used_if_it_is_a_file() {
        let dir = TempDir::new("user-kinds");
        let folder = dir.join("claude.exe");
        fs::create_dir(&folder).unwrap();
        assert_eq!(locate(Some(&folder), Some(OsStr::new("")), None), None);
        // 이름은 아무래도 상관없다 — 설정에서 직접 고른 파일이므로
        let odd = dir.join("my tool.bin");
        fs::write(&odd, b"x").unwrap();
        assert_eq!(locate(Some(&odd), Some(OsStr::new("")), None), Some(odd));
    }

    #[test]
    fn a_user_path_wins_over_path_and_a_broken_one_falls_back_to_path() {
        let user = TempDir::new("user-wins");
        let on_path = TempDir::new("on-path");
        let exe = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        fs::write(on_path.join(exe), b"x").unwrap();
        let mine = user.join("mine");
        fs::write(&mine, b"x").unwrap();
        let path_var = path_of(&[on_path.path()]);
        assert_eq!(locate(Some(&mine), Some(&path_var), None), Some(mine));
        assert_eq!(
            locate(Some(&user.join("gone")), Some(&path_var), None),
            Some(on_path.join(exe))
        );
    }

    #[test]
    fn home_local_bin_is_only_a_fallback_and_a_folder_there_does_not_count() {
        let home = TempDir::new("home-fallback");
        let bin = home.join(".local").join("bin");
        fs::create_dir_all(&bin).unwrap();
        let exe = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        fs::create_dir(bin.join(exe)).unwrap();
        assert_eq!(locate(None, Some(OsStr::new("")), Some(home.path())), None);
        // PATH 에 있으면 PATH 가 이긴다
        let on_path = TempDir::new("home-vs-path");
        fs::write(on_path.join(exe), b"x").unwrap();
        fs::remove_dir(bin.join(exe)).unwrap();
        fs::write(bin.join(exe), b"x").unwrap();
        let path_var = path_of(&[on_path.path()]);
        assert_eq!(
            locate(None, Some(&path_var), Some(home.path())),
            Some(on_path.join(exe))
        );
    }

    #[test]
    fn paths_with_korean_and_spaces_are_found_and_returned_unchanged() {
        let base = TempDir::new("korean");
        let dir = base.join("내 도구 (x86)");
        fs::create_dir(&dir).unwrap();
        let exe = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        fs::write(dir.join(exe), b"x").unwrap();
        let path_var = path_of(&[dir.as_path()]);
        assert_eq!(locate(None, Some(&path_var), None), Some(dir.join(exe)));
    }

    // ───────── 버전 줄 ─────────

    #[test]
    fn version_lines_in_odd_shapes() {
        assert_eq!(
            parse_version("  2.1.296  (Claude Code)  "),
            Some("2.1.296".into())
        );
        assert_eq!(parse_version("2.1.296\r\n"), Some("2.1.296".into()));
        assert_eq!(
            parse_version("2.1.296\nsecond line\n"),
            Some("2.1.296".into())
        );
        assert_eq!(
            parse_version("3.0.0-beta.1+build.5 (Claude Code)"),
            Some("3.0.0-beta.1+build.5".into())
        );
        for bad in [
            "",
            "\n2.1.296",
            "   \n",
            "v2.1.296",
            "claude 2.1.296",
            "error: unknown option",
            "2.1.296;rm",
            "2.1.296\u{0}",
            "٢.١",
            "2.1.296$(calc)",
        ] {
            assert_eq!(parse_version(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_huge_version_token_is_taken_whole_without_trouble() {
        let token = format!("1.{}", "9".repeat(10_000));
        assert_eq!(parse_version(&token), Some(token.clone()));
    }

    // ───────── 로그인 상태 읽기 ─────────

    #[test]
    fn auth_json_after_several_lines_of_other_text_and_with_crlf_is_read() {
        let text =
            "Checking...\r\nsome warning\r\n{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\r\n";
        assert_eq!(
            parse_auth_status(text).unwrap().auth_method.as_deref(),
            Some("claude.ai")
        );
        // 앞에 BOM · 공백 · 색 코드
        assert!(
            !parse_auth_status("\u{feff}{\"loggedIn\":false}")
                .unwrap()
                .logged_in
        );
        assert!(
            parse_auth_status("\u{1b}[32m ok \u{1b}[0m {\"loggedIn\":true}")
                .unwrap()
                .logged_in
        );
        // 뒤에 다른 글이 붙어도 첫 JSON 만 읽는다
        assert!(
            parse_auth_status("{\"loggedIn\":true}\ntrailing log line {not json}")
                .unwrap()
                .logged_in
        );
    }

    #[test]
    fn a_brace_inside_the_text_before_the_json_does_not_hide_the_json() {
        let text =
            "note: using {default} settings\n{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\n";
        assert!(parse_auth_status(text).unwrap().logged_in);
    }

    #[test]
    fn auth_fields_of_the_wrong_type_or_missing_are_refused_but_nulls_are_fine() {
        for bad in [
            r#"{"loggedIn":null}"#,
            r#"{"loggedIn":1}"#,
            r#"{"loggedIn":"true"}"#,
            r#"{"authMethod":"claude.ai"}"#,
            r#"{"loggedIn":true,"authMethod":5}"#,
            r#"{"loggedIn":true,"subscriptionType":["pro"]}"#,
            "{",
            "{}",
        ] {
            assert!(parse_auth_status(bad).is_err(), "{bad}");
        }
        let ok =
            parse_auth_status(r#"{"loggedIn":true,"authMethod":null,"subscriptionType":null}"#)
                .unwrap();
        assert_eq!((ok.auth_method, ok.subscription_type), (None, None));
    }

    #[test]
    fn auth_names_shown_on_screen_are_cut_to_64_characters() {
        let long = "가".repeat(500);
        let json =
            format!(r#"{{"loggedIn":true,"authMethod":"{long}","subscriptionType":"{long}"}}"#);
        let info = parse_auth_status(&json).unwrap();
        assert_eq!(info.auth_method.unwrap().chars().count(), 64);
        assert_eq!(info.subscription_type.unwrap().chars().count(), 64);
    }

    #[test]
    fn account_details_never_appear_in_errors_even_when_the_json_is_unusable() {
        let secrets = ["someone@example.com", "Example Org", "sk-ant-secret"];
        for text in [
            r#"{"email":"someone@example.com","orgName":"Example Org"}"#,
            r#"{"loggedIn":"sk-ant-secret","email":"someone@example.com"}"#,
            r#"user someone@example.com in Example Org is logged out"#,
            r#"{"loggedIn":true,"email":"someone@example.com""#,
        ] {
            if let Err(err) = parse_auth_status(text) {
                let shown = format!("{err} / {err:?}");
                for secret in secrets {
                    assert!(!shown.contains(secret), "{text}: {shown}");
                }
            }
        }
        // 읽은 결과에도 없다 (Debug · Clone · 비교용 구조체 어디에도 계정 칸이 없다)
        let info = parse_auth_status(
            r#"{"loggedIn":true,"email":"someone@example.com","orgName":"Example Org","orgId":"o-1","accountUuid":"u-1","token":"sk-ant-secret"}"#,
        )
        .unwrap();
        let shown = format!("{info:?}");
        for secret in secrets.iter().chain(["o-1", "u-1"].iter()) {
            assert!(!shown.contains(secret), "{shown}");
        }
    }

    #[test]
    fn the_status_json_has_exactly_the_documented_keys() {
        let status = status(None, false);
        let value = serde_json::to_value(&status).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "apiKeyPresent",
                "authMethod",
                "found",
                "knownVersion",
                "loggedIn",
                "otherBilling",
                "path",
                "problem",
                "subscriptionType",
                "version",
                "versionMatches"
            ]
        );
    }

    #[test]
    fn login_window_command_lines_refuse_control_characters_and_percent_and_quotes_but_keep_unicode()
     {
        for bad in [
            "C:\\a\rb\\c.exe",
            "C:\\a\u{7}b\\c.exe",
            "C:\\100%\\c.exe",
            "C:\\\"x\\c.exe",
        ] {
            assert!(login_command_line(Path::new(bad)).is_err(), "{bad:?}");
        }
        let line = login_command_line(Path::new("C:\\내 도구\\claude.exe")).unwrap();
        assert!(line.to_string_lossy().contains("내 도구"));
        // `&` · `^` · `(` 는 따옴표 안이라 cmd 가 명령으로 읽지 않는다 — 그대로 둔다 (현재 동작 기록)
        assert!(login_command_line(Path::new("C:\\a&b\\c.exe")).is_ok());
    }
}

/// P3-05 — 로그인 창 cmd.exe 절대 경로 · 앞 글의 중괄호 · 다른 과금 알림.
#[cfg(test)]
mod fix_tests {
    use super::*;

    #[test]
    fn the_login_window_uses_the_system32_cmd_exe_by_absolute_path() {
        assert_eq!(
            system_cmd_exe(Some(OsStr::new("C:\\Windows"))),
            Path::new("C:\\Windows").join("System32").join("cmd.exe")
        );
        assert_eq!(
            system_cmd_exe(Some(OsStr::new("D:\\WinNT"))),
            Path::new("D:\\WinNT").join("System32").join("cmd.exe")
        );
        // 없거나 빈 값이면 기본 위치 — 이름만(`cmd.exe`) 돌려주지는 않는다
        for missing in [None, Some(OsStr::new(""))] {
            let path = system_cmd_exe(missing);
            assert!(path.is_absolute() || path.starts_with("C:"), "{path:?}");
            assert!(path.ends_with(Path::new("System32").join("cmd.exe")));
        }
    }

    #[test]
    fn the_real_system_cmd_exe_exists_on_windows() {
        if cfg!(windows) {
            let path = system_cmd_exe(std::env::var_os("SystemRoot").as_deref());
            assert!(path.is_file(), "{path:?}");
        }
    }

    #[test]
    fn braces_in_the_text_before_the_json_do_not_hide_it_and_the_account_stays_out() {
        for text in [
            "note: using {default} settings\n{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\n",
            "{ {{ } {\"loggedIn\":true}",
            "{\"a\":\n{\"loggedIn\":true}",
            "warn {x\n{\"loggedIn\":true,\"email\":\"someone@example.com\"}",
        ] {
            let info = parse_auth_status(text).unwrap_or_else(|e| panic!("{text:?}: {e}"));
            assert!(info.logged_in, "{text:?}");
            assert!(!format!("{info:?}").contains("someone@example.com"));
        }
        // 읽을 수 있는 JSON 이 하나도 없으면 그대로 오류 — 받은 글은 오류에 안 들어간다
        for bad in ["{ {{ } }", "{\"loggedIn\":\"yes\"} {\"email\":\"a@b.c\"}"] {
            let err = parse_auth_status(bad).unwrap_err();
            assert!(!err.to_string().contains("a@b.c"));
        }
        assert!(
            parse_auth_status("no braces here")
                .unwrap_err()
                .to_string()
                .contains("no JSON")
        );
    }

    #[test]
    fn a_thousand_open_braces_are_given_up_on_quickly() {
        let text = "{".repeat(5000);
        let started = std::time::Instant::now();
        assert!(parse_auth_status(&text).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn status_carries_the_other_billing_names_and_nothing_else_about_them() {
        let names = vec!["ANTHROPIC_AUTH_TOKEN".to_string()];
        let status = status_with(None, false, names.clone());
        assert_eq!(status.other_billing, names);
        let value = serde_json::to_value(&status).unwrap();
        assert_eq!(value["otherBilling"], serde_json::json!(names));
        // `status` 만 부르면 비어 있다
        assert!(status_for_nothing().other_billing.is_empty());
    }

    fn status_for_nothing() -> ClaudeStatus {
        status(None, false)
    }
}
