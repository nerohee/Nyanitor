//! 사용량 읽기 시험 (P5-01) — 가짜 CLI 가 녹화본(`tests/fixtures/cli/usage.jsonl`) 또는 시험용으로 만든 녹화를 재생한다 (실제 `claude` 는 쓰지 않는다).
//! 확인하는 것: 받은 보고서 해석 · 못 받는 이유마다의 결과 · 시간 초과 · 끝난 뒤 프로세스(손자 포함) 정리 · 로그인 확인에서 멈추면 세션을 띄우지 않음 ·
//! 동시에 여러 번 불러도 세션 하나 · 받은 줄이 어디에도 남지 않음.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::exec::ClaudeCommand;
use nyanitor_lib::usage::fetch::{FetchConfig, read_with};
use nyanitor_lib::usage::{CacheConfig, UnavailableReason, UsageReading, UsageResult, UsageState};
use serde_json::{Value, json};

fn config() -> FetchConfig {
    FetchConfig {
        timeout: Duration::from_secs(20),
        exit_grace: Duration::from_millis(300),
    }
}

/// 가짜 CLI. `fixtures` 가 없으면 저장소의 녹화본 폴더.
fn fake(root: &Path, replay: &str, flags: &[&str], fixtures: Option<&Path>) -> FakeCmd {
    static LOGS: AtomicUsize = AtomicUsize::new(0);
    let log = root.join(format!("fake-{}.log", LOGS.fetch_add(1, Ordering::Relaxed)));
    let mut command = ClaudeCommand::new(fake_exe())
        .with_extra_env("NYANITOR_FAKE_REPLAY", replay)
        .with_extra_env("NYANITOR_FAKE_FLAGS", flags.join(","))
        .with_extra_env("NYANITOR_FAKE_LOG", log.clone());
    if let Some(dir) = fixtures {
        command = command.with_extra_env("NYANITOR_FAKE_FIXTURES", dir.as_os_str());
    }
    FakeCmd { command, log }
}

/// 시험용 녹화 하나를 `<root>/fx/<name>.jsonl` 로 쓴다 (`recv` 줄들 — 앞에 `/usage` 를 기다리는 `send` 가 붙는다). `exit` 가 `None` 이면 코드 0.
fn write_recording(root: &Path, name: &str, recv: &[Value], exit: Option<i32>) -> PathBuf {
    let dir = root.join("fx");
    fs::create_dir_all(&dir).unwrap();
    let mut lines = vec![json!({ "dir": "meta", "format": "nyanitor-cli-record/1" })];
    lines.push(json!({ "dir": "send", "t": 0, "msg": { "type": "user", "message": { "role": "user", "content": "/usage" } } }));
    for msg in recv {
        lines.push(json!({ "dir": "recv", "t": 1, "msg": msg }));
    }
    lines.push(json!({ "dir": "exit", "t": 2, "code": exit.unwrap_or(0), "signal": null }));
    let text: Vec<String> = lines.iter().map(Value::to_string).collect();
    fs::write(dir.join(format!("{name}.jsonl")), text.join("\n") + "\n").unwrap();
    dir
}

fn init() -> Value {
    json!({ "type": "system", "subtype": "init", "session_id": "s", "model": "claude-haiku-5-5" })
}

fn synthetic_with(report: Value) -> Value {
    json!({ "type": "assistant", "message": { "model": "<synthetic>", "content": [{ "type": "text", "text": "…" }] },
            "usage_report": report })
}

fn result() -> Value {
    json!({ "type": "result", "subtype": "success", "is_error": false, "total_cost_usd": 0 })
}

fn good_report() -> Value {
    json!({ "session": { "total_cost_usd": 0 }, "rate_limits": { "limits": [
        { "kind": "session", "group": "session", "percent": 25, "resets_at": "2026-10-28T03:30:00+00:00", "scope": null, "severity": "normal", "is_active": false },
        { "kind": "weekly_all", "group": "weekly", "percent": 50, "resets_at": "2026-10-28T17:00:00+00:00", "scope": null, "severity": "warning", "is_active": true }
    ] } })
}

fn reading(result: UsageResult) -> UsageReading {
    match result {
        UsageResult::Ok(reading) => reading,
        other => panic!("expected ok, got {other:?}"),
    }
}

fn unavailable(result: UsageResult) -> UnavailableReason {
    match result {
        UsageResult::Unavailable(u) => u.reason,
        other => panic!("expected unavailable, got {other:?}"),
    }
}

/// 가짜 CLI 가 세션으로 띄워진 횟수 (`-p` 로 시작하는 인자 줄)
fn sessions_started(cmd: &FakeCmd) -> usize {
    cmd.log_entries()
        .iter()
        .filter_map(|e| e.get("argv").and_then(Value::as_array))
        .filter(|argv| argv.first().and_then(Value::as_str) == Some("-p"))
        .count()
}

#[test]
fn the_recorded_usage_session_gives_both_windows() {
    let root = unique_dir("usage-recorded");
    let cmd = fake(&root, "usage", &[], None);
    let started = Instant::now();
    let result = reading(read_with(Some(&cmd.command), false, &config()));
    let five = result.five_hour.expect("five hour");
    let seven = result.seven_day.expect("seven day");
    assert!((five.utilization - 0.1).abs() < 1e-9 && (seven.utilization - 0.1).abs() < 1e-9);
    assert_eq!(five.resets_at, Some(1_793_158_200));
    assert_eq!(seven.resets_at, Some(1_793_206_800));
    assert!(result.read_at > 1_700_000_000);
    // 가짜는 바로 답한다 — 끝내기 기다림(grace)이 아니라 stdin 을 닫으면 끝나므로 몇 초 안에 돌아온다
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    // 세션을 정확히 한 번 띄웠고, 보낸 것은 `/usage` 한 줄뿐이다
    assert_eq!(sessions_started(&cmd), 1);
    let sent = cmd.stdin_messages();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert_eq!(sent[0]["type"], "user");
    assert_eq!(sent[0]["message"]["content"], "/usage");
}

#[test]
fn the_session_is_started_with_the_safe_arguments() {
    let root = unique_dir("usage-args");
    let cmd = fake(&root, "usage", &[], None);
    reading(read_with(Some(&cmd.command), false, &config()));
    let argv = cmd.argv();
    assert_eq!(argv.first().map(String::as_str), Some("-p"));
    for wanted in [
        "--no-session-persistence",
        "stream-json",
        "--max-turns",
        "1",
    ] {
        assert!(argv.iter().any(|a| a == wanted), "{wanted} in {argv:?}");
    }
    for forbidden in [
        "--resume",
        "--permission-prompt-tool",
        "--dangerously-skip-permissions",
        "--add-dir",
    ] {
        assert!(
            !argv.iter().any(|a| a == forbidden),
            "{forbidden} in {argv:?}"
        );
    }
}

#[test]
fn the_child_never_sees_the_api_key() {
    // 키가 환경에 있어도 한도를 읽는 세션에는 넘기지 않는다 (키로 돌면 구독 한도가 아니다)
    let root = unique_dir("usage-env");
    let dump = root.join("env.txt");
    let cmd = fake(&root, "usage", &[], None);
    let command = cmd
        .command
        .clone()
        .with_base_env(vec![
            ("ANTHROPIC_API_KEY".into(), "sk-ant-fake".into()),
            ("CLAUDECODE".into(), "1".into()),
            ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
            (
                "SystemRoot".into(),
                std::env::var_os("SystemRoot").unwrap_or_default(),
            ),
        ])
        .with_extra_env("NYANITOR_FAKE_ENV_DUMP", dump.as_os_str());
    reading(read_with(Some(&command), false, &config()));
    let names = fs::read_to_string(&dump).unwrap();
    assert!(
        !names
            .lines()
            .any(|n| n.eq_ignore_ascii_case("ANTHROPIC_API_KEY")),
        "{names}"
    );
    assert!(!names.lines().any(|n| n == "CLAUDECODE"), "{names}");
}

#[test]
fn not_logged_in_stops_before_any_session_is_started() {
    let root = unique_dir("usage-logged-out");
    let cmd = fake(&root, "usage", &[], None).env("NYANITOR_FAKE_AUTH", "out");
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::NotLoggedIn
    );
    assert_eq!(sessions_started(&cmd), 0);
}

#[test]
fn an_api_key_login_is_not_a_subscription_and_no_session_is_started() {
    let root = unique_dir("usage-apikey");
    let cmd = fake(&root, "usage", &[], None).env(
        "NYANITOR_FAKE_AUTH_OUT",
        r#"{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}"#,
    );
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::NotSubscription
    );
    assert_eq!(sessions_started(&cmd), 0);
}

#[test]
fn another_billing_variable_means_not_a_subscription() {
    let root = unique_dir("usage-other-billing");
    let cmd = fake(&root, "usage", &[], None);
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), true, &config())),
        UnavailableReason::NotSubscription
    );
    assert_eq!(sessions_started(&cmd), 0);
}

#[test]
fn a_login_check_that_prints_garbage_is_a_failure_not_a_crash() {
    let root = unique_dir("usage-auth-garbage");
    let cmd = fake(&root, "usage", &[], None).env("NYANITOR_FAKE_AUTH", "garbage");
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::Failed
    );
    assert_eq!(sessions_started(&cmd), 0);
}

#[test]
fn no_claude_is_its_own_reason() {
    assert_eq!(
        unavailable(read_with(None, false, &config())),
        UnavailableReason::NoClaude
    );
}

#[test]
fn a_program_that_cannot_be_started_is_a_failure() {
    let root = unique_dir("usage-no-exe");
    let missing = ClaudeCommand::new(root.join("no-such-claude.exe"));
    assert_eq!(
        unavailable(read_with(Some(&missing), false, &config())),
        UnavailableReason::Failed
    );
}

#[test]
fn a_report_that_never_comes_times_out_and_the_whole_tree_is_killed() {
    let root = unique_dir("usage-timeout");
    let fixtures = write_recording(
        &root,
        "slow",
        &[init(), synthetic_with(good_report()), result()],
        None,
    );
    let pidfile = root.join("child.pid");
    // 줄마다 5초 쉬는 가짜 — 첫 줄(init) 뒤 보고서까지 5초가 걸린다. 손자 프로세스(60초 자는 것)도 하나 둔다.
    let cmd = fake(&root, "slow", &[], Some(&fixtures))
        .env("NYANITOR_FAKE_DELAY_MS", "5000")
        .env("NYANITOR_FAKE_CHILD_PIDFILE", pidfile.as_os_str());
    let started = Instant::now();
    let short = FetchConfig {
        timeout: Duration::from_millis(600),
        exit_grace: Duration::from_millis(300),
    };
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &short)),
        UnavailableReason::Timeout
    );
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{:?}",
        started.elapsed()
    );
    let fake_pid = session_pid(&cmd);
    let grandchild: u32 = wait_for_file(&pidfile, WAIT).trim().parse().unwrap();
    assert!(
        wait_dead(fake_pid, Duration::from_secs(5)),
        "가짜 CLI 가 남았다"
    );
    assert!(
        wait_dead(grandchild, Duration::from_secs(5)),
        "손자 프로세스가 남았다"
    );
}

/// 가짜 CLI 가 세션으로 띄워졌을 때의 pid (가짜가 로그에 적는다)
fn session_pid(cmd: &FakeCmd) -> u32 {
    cmd.log_entries()
        .iter()
        .find(|e| {
            e["argv"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                == Some("-p")
        })
        .and_then(|e| e["pid"].as_u64())
        .map(|pid| u32::try_from(pid).unwrap())
        .expect("the session pid is in the log")
}

#[test]
fn a_cli_that_ignores_stdin_closing_is_killed_after_the_grace_and_so_is_its_child() {
    let root = unique_dir("usage-hang");
    let pidfile = root.join("child.pid");
    let cmd = fake(&root, "usage", &["hang-on-eof"], None)
        .env("NYANITOR_FAKE_CHILD_PIDFILE", pidfile.as_os_str());
    let result = reading(read_with(Some(&cmd.command), false, &config()));
    assert!(result.five_hour.is_some());
    let fake_pid = session_pid(&cmd);
    let grandchild: u32 = wait_for_file(&pidfile, WAIT).trim().parse().unwrap();
    assert!(
        wait_dead(fake_pid, Duration::from_secs(5)),
        "끝나지 않는 CLI 가 남았다"
    );
    assert!(
        wait_dead(grandchild, Duration::from_secs(5)),
        "손자 프로세스가 남았다"
    );
}

#[test]
fn a_normal_cli_is_gone_when_the_call_returns_or_right_after() {
    let root = unique_dir("usage-clean");
    let cmd = fake(&root, "usage", &[], None);
    reading(read_with(Some(&cmd.command), false, &config()));
    assert!(wait_dead(session_pid(&cmd), Duration::from_secs(5)));
}

#[test]
fn a_turn_that_ends_without_a_report_is_not_supported() {
    let root = unique_dir("usage-no-report");
    let fixtures = write_recording(
        &root,
        "plain",
        &[
            init(),
            json!({ "type": "assistant", "message": { "model": "<synthetic>", "content": [] } }),
            result(),
        ],
        None,
    );
    let cmd = fake(&root, "plain", &[], Some(&fixtures));
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::NotSupported
    );
}

#[test]
fn a_real_model_reply_means_the_command_was_not_understood_and_stops_there() {
    let root = unique_dir("usage-model-reply");
    let fixtures = write_recording(
        &root,
        "model",
        &[
            init(),
            json!({ "type": "assistant", "message": { "model": "claude-haiku-5-5", "content": [{ "type": "text", "text": "Unknown command" }] } }),
            synthetic_with(good_report()), // 이 뒤의 것은 쓰지 않는다
            result(),
        ],
        None,
    );
    let cmd = fake(&root, "model", &[], Some(&fixtures));
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::NotSupported
    );
}

#[test]
fn a_report_with_null_limits_is_a_failure_to_fetch() {
    let root = unique_dir("usage-null-limits");
    let fixtures = write_recording(
        &root,
        "nulllimits",
        &[
            init(),
            synthetic_with(json!({ "session": {}, "rate_limits": null })),
            result(),
        ],
        None,
    );
    let cmd = fake(&root, "nulllimits", &[], Some(&fixtures));
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::Failed
    );
}

#[test]
fn a_report_with_a_changed_shape_is_not_supported() {
    let root = unique_dir("usage-new-shape");
    let fixtures = write_recording(
        &root,
        "newshape",
        &[init(), synthetic_with(json!({ "brand": "new" })), result()],
        None,
    );
    let cmd = fake(&root, "newshape", &[], Some(&fixtures));
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::NotSupported
    );
}

#[test]
fn a_cli_that_dies_without_a_report_is_a_failure() {
    let root = unique_dir("usage-dies");
    let fixtures = write_recording(&root, "dies", &[init()], Some(1));
    let cmd = fake(&root, "dies", &[], Some(&fixtures));
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::Failed
    );
}

#[test]
fn a_report_line_cut_in_half_is_a_failure_and_never_a_crash() {
    let root = unique_dir("usage-cut");
    let cmd = fake(&root, "usage", &[], None).env("NYANITOR_FAKE_CUT_LINE", "1");
    assert_eq!(
        unavailable(read_with(Some(&cmd.command), false, &config())),
        UnavailableReason::Failed
    );
}

#[test]
fn non_json_lines_and_unknown_messages_around_the_report_are_skipped() {
    let root = unique_dir("usage-noise");
    let cmd = fake(&root, "usage", &["inject-nonjson", "inject-unknown"], None);
    assert!(
        reading(read_with(Some(&cmd.command), false, &config()))
            .five_hour
            .is_some()
    );
}

#[test]
fn the_first_report_is_enough_even_if_the_turn_never_ends() {
    // 보고서만 오고 `result` 는 안 온다 (CLI 가 멈춤) — 보고서를 받은 시점에 끝낸다
    let root = unique_dir("usage-no-result");
    let fixtures = write_recording(
        &root,
        "noresult",
        &[init(), synthetic_with(good_report())],
        None,
    );
    let cmd = fake(&root, "noresult", &["hang-on-eof"], Some(&fixtures));
    let started = Instant::now();
    let result = reading(read_with(Some(&cmd.command), false, &config()));
    assert!((result.five_hour.unwrap().utilization - 0.25).abs() < 1e-9);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(wait_dead(session_pid(&cmd), Duration::from_secs(5)));
}

#[test]
fn simultaneous_calls_through_the_state_start_one_session() {
    let root = unique_dir("usage-simultaneous");
    // 보고서가 오기까지 조금 걸리게 해 둔다 — 그 사이에 다른 호출들이 들어온다
    let cmd = Arc::new(fake(&root, "usage", &[], None).env("NYANITOR_FAKE_DELAY_MS", "150"));
    let state = UsageState::new(CacheConfig::default());
    let handles: Vec<_> = (0..6)
        .map(|_| {
            let (state, cmd) = (state.clone(), cmd.clone());
            thread::spawn(move || state.read(|| read_with(Some(&cmd.command), false, &config())))
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert!(results.iter().all(|r| matches!(r, UsageResult::Ok(_))));
    assert!(
        results.windows(2).all(|pair| pair[0] == pair[1]),
        "모두 같은 결과"
    );
    assert_eq!(sessions_started(&cmd), 1, "세션이 하나만 떴다");
    // 이어서 불러도 기억한 값
    state.read(|| panic!("기억한 값이 있어야 한다"));
    assert_eq!(sessions_started(&cmd), 1);
}

#[test]
fn the_report_text_is_nowhere_in_the_serialized_result() {
    // 화면으로 가는 값에 계정 · 사용 내역 글이 없다 (한도 숫자와 시각만)
    let root = unique_dir("usage-serialized");
    let cmd = fake(&root, "usage", &[], None);
    let json = serde_json::to_string(&read_with(Some(&cmd.command), false, &config())).unwrap();
    for leak in [
        "local-command",
        "You are currently using",
        "Top skills",
        "example-agents",
        "subscription",
        "total_cost",
    ] {
        assert!(!json.contains(leak), "{leak} in {json}");
    }
}

#[test]
fn the_state_serializes_for_the_screen_in_both_shapes() {
    let root = unique_dir("usage-shapes");
    let cmd = fake(&root, "usage", &[], None);
    let ok = serde_json::to_value(read_with(Some(&cmd.command), false, &config())).unwrap();
    assert_eq!(ok["state"], "ok");
    assert!(ok["readAt"].as_i64().unwrap() > 0);
    assert!(ok["fiveHour"]["utilization"].is_number());
    let none = serde_json::to_value(read_with(None, false, &config())).unwrap();
    assert_eq!(
        none,
        json!({ "state": "unavailable", "reason": "no_claude" })
    );
}

// ───────────────────────────── CLI 작업 폴더 (P10-08, D-54) ─────────────────────────────

#[test]
fn the_usage_session_runs_in_the_work_folder_and_planted_settings_are_removed() {
    let root = unique_dir("usage-workdir");
    let work = root.join("cli-work");
    fs::create_dir_all(work.join(".claude")).unwrap();
    fs::write(work.join(".claude").join("settings.json"), "{\"hooks\":{}}").unwrap();
    let dump = root.join("cwd.txt");
    let cmd = fake(&root, "usage", &[], None);
    let command = cmd
        .command
        .clone()
        .with_work_dir(&work)
        .with_extra_env("NYANITOR_FAKE_CWD_DUMP", dump.as_os_str());
    reading(read_with(Some(&command), false, &config()));
    // `--version`이 아니라 세션(`-p`)을 띄운 프로세스가 마지막으로 적었다
    assert_eq!(sessions_started(&cmd), 1);
    let seen = fs::canonicalize(fs::read_to_string(&dump).unwrap().trim()).unwrap();
    assert_eq!(seen, fs::canonicalize(&work).unwrap());
    assert!(!work.join(".claude").exists(), "심은 설정이 남았다");
}

#[test]
fn a_usage_read_whose_work_folder_cannot_be_made_starts_no_session() {
    let root = unique_dir("usage-workdir-blocked");
    let blocker = root.join("file");
    fs::write(&blocker, b"x").unwrap();
    let cmd = fake(&root, "usage", &[], None);
    let command = cmd.command.clone().with_work_dir(blocker.join("cli-work"));
    let result = read_with(Some(&command), false, &config());
    assert_eq!(unavailable(result), UnavailableReason::Failed);
    assert_eq!(sessions_started(&cmd), 0);
}
