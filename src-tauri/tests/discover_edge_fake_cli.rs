//! 찾기 경계 시험 (P3-03) — 가짜 CLI 로 `--version` · `auth status` 의 이상한 출력, 종료 코드, 환경 이름을 돌려 본다.
//! 실제 `claude` 는 쓰지 않는다.

mod common;

use std::ffi::OsString;
use std::fs;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::discover::{read_auth, read_version, status};
use nyanitor_lib::claude::exec::ClaudeCommand;

fn fake() -> ClaudeCommand {
    ClaudeCommand::new(fake_exe())
}

fn with_auth(out: &str, code: i32) -> ClaudeCommand {
    fake()
        .with_extra_env("NYANITOR_FAKE_AUTH_OUT", out)
        .with_extra_env("NYANITOR_FAKE_AUTH_CODE", code.to_string())
}

fn with_version(out: &str, code: i32) -> ClaudeCommand {
    fake()
        .with_extra_env("NYANITOR_FAKE_VERSION_OUT", out)
        .with_extra_env("NYANITOR_FAKE_VERSION_CODE", code.to_string())
}

// ───────────────────────── auth status ─────────────────────────

#[test]
fn text_before_the_json_and_crlf_line_ends_do_not_matter() {
    let cmd = with_auth(
        "Checking credentials...\\r\\nwarning: slow network\\r\\n{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\\r\\n",
        0,
    );
    // (가짜 CLI 는 `\n` 두 글자만 줄바꿈으로 바꾼다 — `\r` 은 글자 그대로 남아 JSON 앞 글이 된다)
    let info = read_auth(&cmd);
    assert!(info.is_ok(), "{info:?}");
    assert!(info.unwrap().logged_in);
}

#[test]
fn logged_out_json_with_exit_code_one_is_logged_out_and_not_an_error() {
    let info = read_auth(&with_auth(
        "{\"loggedIn\":false,\"authMethod\":\"none\"}",
        1,
    ))
    .unwrap();
    assert!(!info.logged_in);
}

#[test]
fn an_empty_output_or_only_stderr_style_text_is_an_auth_problem_not_a_login_state() {
    for (out, code) in [("", 0), ("", 1), ("Error: not logged in\\n", 1), ("{}", 0)] {
        let result = status(Some(&with_auth(out, code)), false);
        assert_eq!(result.logged_in, None, "{out:?}/{code}");
        assert_eq!(
            result.problem.as_deref(),
            Some("auth_failed"),
            "{out:?}/{code}"
        );
        // 버전은 따로 읽혀서 남는다
        assert_eq!(result.version.as_deref(), Some("2.1.296"));
    }
}

#[test]
fn a_huge_output_after_the_json_is_drained_and_the_json_is_still_read() {
    let cmd = with_auth("{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}\\n", 0)
        .with_extra_env("NYANITOR_FAKE_AUTH_PAD", "3000000");
    let started = Instant::now();
    let info = read_auth(&cmd).expect("the first megabyte holds the JSON");
    assert!(info.logged_in);
    assert!(started.elapsed() < Duration::from_secs(15));
}

#[test]
fn account_details_in_the_cli_output_never_reach_the_result_or_its_debug_text() {
    let json = r#"{"loggedIn":true,"authMethod":"claude.ai","email":"leak@example.com","orgName":"Leak Org","orgId":"org-123","accountUuid":"acc-456"}"#;
    let result = status(Some(&with_auth(json, 0)), false);
    let shown = format!("{result:?} {}", serde_json::to_string(&result).unwrap());
    for secret in ["leak@example.com", "Leak Org", "org-123", "acc-456"] {
        assert!(!shown.contains(secret), "{secret} leaked: {shown}");
    }
    assert_eq!(result.logged_in, Some(true));
}

// ───────────────────────── --version ─────────────────────────

#[test]
fn version_output_in_odd_shapes_is_read_or_reported_as_a_version_problem() {
    // 읽을 수 있는 것
    for (out, expected) in [
        ("2.1.296 (Claude Code)\\n", "2.1.296"),
        ("  2.1.296\\n", "2.1.296"),
        ("2.1.296\\nUpdate available: 2.2.0\\n", "2.1.296"),
    ] {
        assert_eq!(
            read_version(&with_version(out, 0)).unwrap(),
            expected,
            "{out:?}"
        );
    }
    // 못 읽는 것: 빈 출력 · 버전이 아닌 글 · 종료 코드가 0 이 아님
    for (out, code) in [
        ("", 0),
        ("hello\\n", 0),
        ("unknown option\\n", 0),
        ("2.1.296\\n", 2),
    ] {
        assert!(
            read_version(&with_version(out, code)).is_err(),
            "{out:?}/{code}"
        );
        let result = status(Some(&with_version(out, code)), false);
        assert_eq!(result.version, None, "{out:?}/{code}");
        assert_eq!(result.version_matches, None);
        assert_eq!(
            result.problem.as_deref(),
            Some("version_failed"),
            "{out:?}/{code}"
        );
        // 로그인 상태는 버전과 따로 읽는다
        assert_eq!(result.logged_in, Some(true));
    }
}

#[test]
fn a_much_newer_or_older_version_is_flagged_but_still_usable() {
    for version in ["0.0.1", "99.0.0", "2.1.295", "2.1.297", "2.1.296-beta"] {
        let result = status(
            Some(&fake().with_extra_env("NYANITOR_FAKE_VERSION", version)),
            false,
        );
        assert_eq!(result.version.as_deref(), Some(version));
        assert_eq!(result.version_matches, Some(false), "{version}");
        assert_eq!(result.problem, None);
    }
}

#[test]
fn a_slow_version_check_is_cut_off_without_hanging_the_caller() {
    // `--version` 도 짧은 명령이라 시간 제한이 있다 — 아주 짧게 줘서 확인
    let cmd = fake().with_extra_env("NYANITOR_FAKE_VERSION_DELAY_MS", "30000");
    let started = Instant::now();
    let out = cmd
        .run_capture(["--version"], Duration::from_millis(500))
        .unwrap();
    assert!(out.timed_out);
    assert!(started.elapsed() < Duration::from_secs(10));
}

// ───────────────────────── 환경 이름 (프로세스 경계) ─────────────────────────

fn names_seen_by_child(base: &[(&str, &str)], keep_api_key: bool) -> Vec<String> {
    let dir = unique_dir("env-names");
    let dump = dir.join("names.txt");
    let mut env: Vec<(OsString, OsString)> = base
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect();
    if let Some(root) = std::env::var_os("SystemRoot") {
        env.push((OsString::from("SystemRoot"), root));
    }
    let cmd = fake()
        .with_base_env(env)
        .keep_api_key(keep_api_key)
        .with_extra_env("NYANITOR_FAKE_ENV_DUMP", dump.clone());
    let out = cmd
        .run_capture(["--version"], Duration::from_secs(20))
        .unwrap();
    assert_eq!(out.code, Some(0), "{out:?}");
    let text = fs::read_to_string(&dump).unwrap();
    let _ = fs::remove_dir_all(dir);
    text.lines().map(str::to_string).collect()
}

fn has(names: &[String], wanted: &str) -> bool {
    names.iter().any(|n| n.eq_ignore_ascii_case(wanted))
}

#[test]
fn the_child_process_never_sees_the_api_key_under_any_capitalisation() {
    for spelled in [
        "ANTHROPIC_API_KEY",
        "anthropic_api_key",
        "AnThRoPiC_api_key",
    ] {
        let names = names_seen_by_child(&[(spelled, "sk-fake"), ("KEEP_ME", "1")], false);
        assert!(!has(&names, "ANTHROPIC_API_KEY"), "{spelled}: {names:?}");
        assert!(has(&names, "KEEP_ME"), "{spelled}: {names:?}");
    }
}

#[test]
fn user_variables_that_only_share_a_prefix_survive_into_the_child() {
    let names = names_seen_by_child(
        &[
            ("ANTHROPIC_API_KEY_2", "a"),
            ("MY_ANTHROPIC_API_KEY", "b"),
            ("ANTHROPIC_BASE_URL", "c"),
            ("CLAUDECODE_HOME", "d"),
            ("CLAUDE_PIDS", "e"),
            ("CLAUDE_AGENT_SDK", "f"),
            ("CLAUDE_CODE_USE_BEDROCK", "g"),
            // 이쪽은 걸러져야 한다
            ("CLAUDECODE", "1"),
            ("ClaudE_PiD", "2"),
            ("claude_agent_sdk_version", "3"),
            ("CLAUDE_CODE_ENTRYPOINT", "4"),
        ],
        false,
    );
    for kept in [
        "ANTHROPIC_API_KEY_2",
        "MY_ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDECODE_HOME",
        "CLAUDE_PIDS",
        "CLAUDE_AGENT_SDK",
        "CLAUDE_CODE_USE_BEDROCK",
    ] {
        assert!(has(&names, kept), "{kept} was dropped: {names:?}");
    }
    for stripped in [
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_CODE_ENTRYPOINT",
    ] {
        assert!(
            !has(&names, stripped),
            "{stripped} reached the child: {names:?}"
        );
    }
}

#[test]
fn asking_for_the_key_passes_it_through_in_its_original_spelling() {
    let names = names_seen_by_child(&[("AnThRoPiC_api_key", "sk-fake")], true);
    assert!(has(&names, "ANTHROPIC_API_KEY"), "{names:?}");
}
