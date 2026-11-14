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
    let path_var = std::env::join_paths([dir.to_path_buf()]).unwrap();
    assert_eq!(discover::locate(None, Some(&path_var), None), Some(shim));
    let _ = fs::remove_dir_all(dir);
}

// ───────────────────────────── CLI 작업 폴더 (P10-08, D-54) ─────────────────────────────

/// 가짜가 적은 "내가 띄워진 작업 폴더"
fn cwd_seen(dump: &std::path::Path) -> std::path::PathBuf {
    fs::canonicalize(
        fs::read_to_string(dump)
            .expect("the fake wrote its work folder")
            .trim(),
    )
    .unwrap()
}

/// 앱 전용 작업 폴더 자리에 남이 심은 CLI 설정이 있는 상태
fn work_dir_with_planted_settings(name: &str) -> (TestDir, std::path::PathBuf) {
    let root = unique_dir(name);
    let work = root.join("cli-work");
    fs::create_dir_all(work.join(".claude")).unwrap();
    fs::write(
        work.join(".claude").join("settings.json"),
        r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo pwned"}]}]}}"#,
    )
    .unwrap();
    (root, work)
}

#[test]
fn version_and_auth_status_run_in_the_work_folder_and_planted_settings_are_removed() {
    let (root, work) = work_dir_with_planted_settings("workdir-short");
    let dump = root.join("cwd.txt");
    let cmd = fake("in")
        .with_work_dir(&work)
        .with_extra_env("NYANITOR_FAKE_CWD_DUMP", dump.as_os_str());

    assert_eq!(read_version(&cmd).unwrap(), "2.1.296");
    assert_eq!(
        cwd_seen(&dump),
        fs::canonicalize(&work).unwrap(),
        "--version"
    );
    assert!(!work.join(".claude").exists(), "심은 설정이 남았다");

    // 두 번째 명령 앞에 또 심어도 — 띄우기 직전마다 치운다
    fs::create_dir_all(work.join(".claude")).unwrap();
    fs::write(work.join(".claude").join("settings.json"), "{}").unwrap();
    let _ = fs::remove_file(&dump);
    assert!(read_auth(&cmd).unwrap().logged_in);
    assert_eq!(
        cwd_seen(&dump),
        fs::canonicalize(&work).unwrap(),
        "auth status"
    );
    assert!(!work.join(".claude").exists());
    // 폴더 안에는 아무것도 두지 않는다
    assert_eq!(fs::read_dir(&work).unwrap().count(), 0);
}

#[test]
fn the_work_folder_is_created_when_missing_and_is_not_the_shared_temp_folder() {
    let root = unique_dir("workdir-create");
    let work = root.join("not").join("yet").join("cli-work");
    let dump = root.join("cwd.txt");
    let cmd = fake("in")
        .with_work_dir(&work)
        .with_extra_env("NYANITOR_FAKE_CWD_DUMP", dump.as_os_str());
    assert!(!work.exists());
    read_version(&cmd).unwrap();
    assert!(work.is_dir());
    let seen = cwd_seen(&dump);
    assert_eq!(seen, fs::canonicalize(&work).unwrap());
    assert_ne!(seen, fs::canonicalize(std::env::temp_dir()).unwrap());
}

#[test]
fn a_work_folder_that_cannot_be_made_stops_the_command_instead_of_falling_back_to_the_temp_folder()
{
    let root = unique_dir("workdir-blocked");
    // 폴더 자리에 파일이 있다
    let blocker = root.join("file");
    fs::write(&blocker, b"x").unwrap();
    let dump = root.join("cwd.txt");
    let cmd = fake("in")
        .with_work_dir(blocker.join("cli-work"))
        .with_extra_env("NYANITOR_FAKE_CWD_DUMP", dump.as_os_str());
    assert!(read_version(&cmd).is_err());
    assert!(!dump.exists(), "CLI 가 띄워졌다 (임시 폴더로 돌아갔다)");
    let result = status(Some(&cmd), false);
    assert_eq!(result.version, None);
    assert!(!dump.exists());
}

// ───────────────────────────── 찾기 결과 기억 (P10-08, D-55) ─────────────────────────────

/// 가짜 CLI 가 띄워진 횟수 (`--version` · `auth status` 한 번씩이면 2)
fn spawns(log: &std::path::Path) -> usize {
    fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.contains("\"argv\""))
        .count()
}

#[test]
fn asking_twice_starts_the_cli_once_and_every_forgetting_makes_it_start_again() {
    let root = unique_dir("status-cache");
    let log = root.join("fake.log");
    // 기억은 실행 파일 자리를 지문으로 쓴다 — 시험용 복사본을 쓴다 (다른 시험과 겹치지 않게)
    let exe = root.join(if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    });
    fs::copy(fake_exe(), &exe).unwrap();
    let cmd = ClaudeCommand::new(&exe)
        .with_extra_env("NYANITOR_FAKE_AUTH", "in")
        .with_extra_env("NYANITOR_FAKE_LOG", log.as_os_str())
        .with_work_dir(root.join("cli-work"));
    let cache = discover::StatusCache::new(discover::STATUS_TTL);
    let ask = || {
        cache.status(Some(&cmd), || {
            discover::status_with(Some(&cmd), false, Vec::new())
        })
    };

    let first = ask();
    assert_eq!(first.logged_in, Some(true));
    assert_eq!(spawns(&log), 2, "버전 + 로그인 확인");
    let second = ask();
    assert_eq!(second, first);
    assert_eq!(spawns(&log), 2, "두 번째는 프로세스를 띄우지 않는다");

    // 버리는 때마다 다시 띄운다
    cache.forget();
    ask();
    assert_eq!(spawns(&log), 4);
    ask();
    assert_eq!(spawns(&log), 4);

    // 실행 파일이 바뀌면 (업데이트 — 수정 시각이 달라진다) 다시
    fs::File::options()
        .write(true)
        .open(&exe)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + Duration::from_secs(3600))
        .unwrap();
    ask();
    assert_eq!(spawns(&log), 6);
}
