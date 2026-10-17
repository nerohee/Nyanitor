//! 찾기 시험 — 가짜 CLI 로 버전 · 로그인 상태 · 실패 모양을 돌려 본다 (실제 `claude` 는 쓰지 않는다).

mod common;

use std::fs;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::discover::{self, read_auth, read_version, status};
use nyanitor_lib::claude::exec::ClaudeCommand;

fn fake(auth: &str) -> ClaudeCommand {
    ClaudeCommand::new(fake_exe()).with_extra_env("NYANITOR_FAKE_AUTH", auth)
}

#[test]
fn logged_in_status_has_only_the_three_fields_and_no_account_details() {
    let cmd = fake("in");
    let result = status(Some(&cmd), false);
    assert!(result.found);
    assert_eq!(result.version.as_deref(), Some("2.1.296"));
    assert_eq!(result.version_matches, Some(true));
    assert_eq!(result.logged_in, Some(true));
    assert_eq!(result.auth_method.as_deref(), Some("claude.ai"));
    assert_eq!(result.subscription_type.as_deref(), Some("pro"));
    assert_eq!(result.problem, None);
    assert!(!result.api_key_present);
    // 이메일 · 조직은 어디에도 없다 (화면으로 가는 JSON 포함)
    let json = serde_json::to_string(&result).unwrap();
    assert!(
        !json.contains("fake@example.com") && !json.contains("Fake Org"),
        "{json}"
    );
    assert!(!format!("{result:?}").contains("fake@example.com"));
}

#[test]
fn logged_out_is_reported_even_though_the_cli_exits_with_code_1() {
    let result = status(Some(&fake("out")), false);
    assert_eq!(result.logged_in, Some(false));
    assert_eq!(result.auth_method.as_deref(), Some("none"));
    assert_eq!(result.subscription_type, None);
    assert_eq!(result.problem, None);
    assert!(read_auth(&fake("out")).is_ok());
}

#[test]
fn a_cli_that_prints_garbage_for_auth_is_an_auth_problem_not_a_crash() {
    let result = status(Some(&fake("garbage")), false);
    assert_eq!(result.version.as_deref(), Some("2.1.296"));
    assert_eq!(result.logged_in, None);
    assert_eq!(result.problem.as_deref(), Some("auth_failed"));
    let err = read_auth(&fake("garbage")).unwrap_err();
    assert_eq!(err.kind(), "internal");
}

#[test]
fn another_version_is_flagged_but_not_an_error() {
    let cmd = fake("in").with_extra_env("NYANITOR_FAKE_VERSION", "3.0.1");
    let result = status(Some(&cmd), true);
    assert_eq!(result.version.as_deref(), Some("3.0.1"));
    assert_eq!(result.version_matches, Some(false));
    assert!(result.api_key_present);
    assert_eq!(result.logged_in, Some(true));
}

#[test]
fn no_claude_means_not_found_and_nothing_else() {
    let result = status(None, false);
    assert!(!result.found);
    assert_eq!(result.version, None);
    assert_eq!(result.logged_in, None);
    assert_eq!(result.problem, None);
}

#[test]
fn an_executable_that_cannot_run_is_a_version_problem() {
    let dir = unique_dir("broken");
    let broken = dir.join(if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    });
    fs::write(&broken, b"not an executable").unwrap();
    let result = status(Some(&ClaudeCommand::new(&broken)), false);
    assert!(result.found);
    assert_eq!(result.version, None);
    assert_eq!(result.problem.as_deref(), Some("version_failed"));
    assert!(read_version(&ClaudeCommand::new(&broken)).is_err());
    let _ = fs::remove_dir_all(dir);
}

#[test]
fn a_command_that_never_finishes_is_cut_off_at_the_timeout() {
    let cmd = fake("slow");
    let started = Instant::now();
    let out = cmd
        .run_capture(["auth", "status", "--json"], Duration::from_millis(400))
        .unwrap();
    assert!(out.timed_out);
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[cfg(windows)]
#[test]
fn an_npm_style_cmd_shim_can_be_run_for_version_and_without_a_window() {
    // npm 으로 설치하면 `claude.cmd` 가 나올 수 있다 — Rust 가 .cmd 를 실행하는지 (P3-01 §4-7 에서 남긴 확인)
    let dir = unique_dir("cmdshim");
    let shim = dir.join("claude.cmd");
    fs::write(&shim, "@echo off\r\necho 2.1.296 (Claude Code)\r\n").unwrap();
    let cmd = ClaudeCommand::new(&shim);
    assert_eq!(read_version(&cmd).unwrap(), "2.1.296");
    // 찾기도 .cmd 를 고른다
    let path_var = std::env::join_paths([dir.clone()]).unwrap();
    assert_eq!(discover::locate(None, Some(&path_var), None), Some(shim));
    let _ = fs::remove_dir_all(dir);
}
