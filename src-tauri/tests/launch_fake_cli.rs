//! 세션을 **등록된 프로젝트 번호로** 시작하는 길 (P6-02) — 가짜 CLI 로 돌린다. 실제 `claude` 는 쓰지 않는다.
//!
//! 프로젝트 번호 → 폴더 · 하네스 `planner` 설정 → `--model` · `--effort` · 시작 알림 · 이어 하기 · "최근에 연" 기록.
//! 입력 확인(거절)의 경계는 `src/claude/launch.rs` 의 단위 시험이 보고, 여기는 프로세스가 뜨는지 · 안 뜨는지를 본다.

mod common;

use std::fs;
use std::time::Duration;

use common::*;
use nyanitor_lib::claude::events::{SessionEvent, StartRequest, TurnOutcome};
use nyanitor_lib::claude::launch::{self, PlannerChoice};
use nyanitor_lib::claude::store::project_key;
use nyanitor_lib::db::{AppDb, DB_FILE};
use nyanitor_lib::projects::folder::{ForbiddenReason, ForbiddenSet};
use nyanitor_lib::projects::{Env, store};

const SESSION_ID: &str = "00000000-0000-4000-8000-000000000001";
const OPENED_LONG_AGO: i64 = 100;

fn env_with(forbidden: ForbiddenSet) -> Env {
    Env {
        forbidden,
        docs_dir: "docs".into(),
        inspect_deadline: Duration::from_secs(5),
    }
}

fn plain_env() -> Env {
    env_with(ForbiddenSet::new())
}

/// 이 시험의 앱 DB — `Harness` 보다 나중에 만들어 먼저 버려진다 (열린 DB 파일이 폴더 지우기를 막지 않게)
fn open_db(h: &Harness) -> AppDb {
    AppDb::open(&h.root.join("data").join(DB_FILE))
}

/// 프로젝트 폴더(`h.project`)를 등록하고 번호를 돌려준다
fn register(db: &AppDb, h: &Harness, name: &str) -> i64 {
    let path = h.project.display().to_string();
    db.write(|conn| {
        store::insert(
            conn,
            &path,
            &project_key(&h.project),
            name,
            None,
            OPENED_LONG_AGO,
        )
    })
    .expect("register the project")
    .id
}

fn request(project_id: i64) -> StartRequest {
    StartRequest {
        project_id,
        resume: false,
        use_api_key: false,
    }
}

fn planner(model: Option<&str>, effort: Option<&str>) -> PlannerChoice {
    PlannerChoice {
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
        warnings: Vec::new(),
    }
}

fn wait_for_argv(cmd: &FakeCmd) -> Vec<String> {
    let deadline = std::time::Instant::now() + WAIT;
    loop {
        let argv = cmd.argv();
        if !argv.is_empty() || std::time::Instant::now() >= deadline {
            return argv;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn after(argv: &[String], flag: &str) -> Option<String> {
    let at = argv.iter().position(|a| a == flag)?;
    argv.get(at + 1).cloned()
}

fn turn_outcome(event: &SessionEvent) -> Option<TurnOutcome> {
    match event {
        SessionEvent::TurnEnded(t) => Some(t.outcome),
        _ => None,
    }
}

fn warning_codes(h: &mut Harness) -> Vec<String> {
    h.seen()
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Warning { code, .. } => Some(code.clone()),
            _ => None,
        })
        .collect()
}

/// 설정 폴더 하나에 하네스 설정을 둔다 (`<설정 폴더>/harness/config.local.json`)
fn claude_dir_with(h: &Harness, config: &str) -> std::path::PathBuf {
    let claude = h.root.join("claude");
    fs::create_dir_all(claude.join("harness")).unwrap();
    fs::write(claude.join("harness").join("config.local.json"), config).unwrap();
    claude
}

// ───────────────────────── 번호로 시작 ─────────────────────────

#[test]
fn starting_by_project_id_runs_the_cli_in_that_projects_folder_with_the_planner_model_and_effort() {
    let mut h = Harness::new("launch-ok");
    let db = open_db(&h);
    let id = register(&db, &h, "고양이 앨범");
    let claude = claude_dir_with(
        &h,
        r#"{ "planner": { "model": "opus", "effort": "high" } }"#,
    );
    let cmd = h.fake("start", &[]);
    let info = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        launch::read_planner(&claude),
        &request(id),
        cmd.command.clone(),
    )
    .unwrap();
    assert_eq!(info.project_id, id);
    assert_eq!(info.project_dir, h.project.display().to_string());
    assert_eq!(info.model.as_deref(), Some("opus"));
    assert_eq!(info.effort.as_deref(), Some("high"));

    // 시작 알림에도 같은 값이 실린다
    let started = h.wait_for("session_started", |e| match e {
        SessionEvent::SessionStarted {
            project_id,
            model,
            effort,
            ..
        } => Some((*project_id, model.clone(), effort.clone())),
        _ => None,
    });
    assert_eq!(started.0, id);
    assert_eq!(started.1.as_deref(), Some("opus"));
    assert_eq!(started.2.as_deref(), Some("high"));
    // 상태에도 프로젝트 번호가 있다 (화면을 다시 열었을 때)
    let state = h.manager.state();
    assert!(state.running);
    assert_eq!(state.project_id, Some(id));

    let argv = wait_for_argv(&cmd);
    assert_eq!(after(&argv, "--model").as_deref(), Some("opus"));
    assert_eq!(after(&argv, "--effort").as_deref(), Some("high"));
    assert!(!argv.contains(&"--resume".to_string()));
    assert!(warning_codes(&mut h).is_empty(), "{:?}", h.kinds());

    h.manager.send_message("say pong").unwrap();
    assert_eq!(h.wait_for("turn", turn_outcome), TurnOutcome::Success);
    h.manager.stop().unwrap();
}

#[test]
fn without_a_planner_setting_the_cli_gets_no_model_or_effort_and_the_screen_is_told() {
    let mut h = Harness::new("launch-noplanner");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    // 설정 폴더가 비어 있다 (하네스 없음)
    let empty_claude = h.root.join("empty-claude");
    fs::create_dir_all(&empty_claude).unwrap();
    let cmd = h.fake("start", &[]);
    let info = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        launch::read_planner(&empty_claude),
        &request(id),
        cmd.command.clone(),
    )
    .unwrap();
    assert_eq!((info.model.clone(), info.effort.clone()), (None, None));
    let argv = wait_for_argv(&cmd);
    assert!(!argv.contains(&"--model".to_string()));
    assert!(!argv.contains(&"--effort".to_string()));
    // 세션은 뜨고, 알림이 하나 온다
    let code = h.wait_for("warning", |e| match e {
        SessionEvent::Warning { code, detail } if code.starts_with("planner_") => {
            Some((code.clone(), detail.clone()))
        }
        _ => None,
    });
    assert_eq!(code.0, "planner_config_missing");
    h.manager.send_message("say pong").unwrap();
    assert_eq!(h.wait_for("turn", turn_outcome), TurnOutcome::Success);
    h.manager.stop().unwrap();
}

#[test]
fn a_broken_or_odd_planner_setting_still_starts_and_never_passes_the_odd_value() {
    for (name, config, want_code) in [
        ("broken", "{ not json", "planner_config_unreadable"),
        (
            "odd-model",
            r#"{ "planner": { "model": "--dangerously-skip-permissions", "effort": "high" } }"#,
            "planner_model_unusable",
        ),
        (
            "odd-effort",
            r#"{ "planner": { "model": "opus", "effort": "ultra" } }"#,
            "planner_effort_unusable",
        ),
    ] {
        let mut h = Harness::new(&format!("launch-{name}"));
        let db = open_db(&h);
        let id = register(&db, &h, "p");
        let claude = claude_dir_with(&h, config);
        let cmd = h.fake("start", &[]);
        launch::start_session(
            &h.manager,
            &db,
            &plain_env(),
            launch::read_planner(&claude),
            &request(id),
            cmd.command.clone(),
        )
        .unwrap();
        let argv = wait_for_argv(&cmd);
        assert!(
            !argv.iter().any(|a| a.starts_with("--dangerously")),
            "{name}: {argv:?}"
        );
        assert!(!argv.contains(&"ultra".to_string()), "{name}: {argv:?}");
        h.wait_for("planner warning", |e| match e {
            SessionEvent::Warning { code, .. } if code == want_code => Some(()),
            _ => None,
        });
        h.manager.stop().unwrap();
    }
}

#[test]
fn this_pcs_planner_setting_starts_opus_high_when_it_says_so() {
    // 이 PC 의 실제 설정(`~/.claude/harness/config.local.json`)이 있고 `opus` · `high` 면 그대로 넘긴다.
    // 다른 PC(설정이 다르거나 없음)에서는 건너뛴다 — 값은 설정이 정하는 것이다.
    let planner = launch::planner_here();
    if planner.model.as_deref() != Some("opus") || planner.effort.as_deref() != Some("high") {
        eprintln!("이 PC 의 planner 설정이 opus · high 가 아님 — 건너뜀: {planner:?}");
        return;
    }
    let h = Harness::new("launch-real-config");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    let cmd = h.fake("start", &[]);
    let info = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        planner,
        &request(id),
        cmd.command.clone(),
    )
    .unwrap();
    assert_eq!(info.model.as_deref(), Some("opus"));
    assert_eq!(info.effort.as_deref(), Some("high"));
    let argv = wait_for_argv(&cmd);
    assert_eq!(after(&argv, "--model").as_deref(), Some("opus"));
    assert_eq!(after(&argv, "--effort").as_deref(), Some("high"));
    h.manager.stop().unwrap();
}

// ───────────────────────── 거절 (프로세스를 띄우기 전) ─────────────────────────

#[test]
fn a_project_that_is_not_registered_is_refused_and_nothing_runs() {
    let h = Harness::new("launch-unregistered");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    let cmd = h.fake("start", &[]);
    for bad in [id + 1, 0, -1, i64::MAX, i64::MIN] {
        let err = launch::start_session(
            &h.manager,
            &db,
            &plain_env(),
            planner(Some("opus"), Some("high")),
            &request(bad),
            cmd.command.clone(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), "project_not_found", "{bad}");
    }
    assert!(cmd.log_entries().is_empty(), "the fake was never launched");
    assert!(!h.manager.state().running);
    // 빈 DB 도 같다
    let empty = Harness::new("launch-empty-db");
    let empty_db = open_db(&empty);
    let err = launch::start_session(
        &empty.manager,
        &empty_db,
        &plain_env(),
        PlannerChoice::default(),
        &request(1),
        cmd.command.clone(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "project_not_found");
}

#[test]
fn a_project_whose_folder_is_gone_is_refused_with_its_own_error_and_nothing_runs() {
    let h = Harness::new("launch-gone");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    fs::remove_dir_all(&h.project).unwrap();
    let cmd = h.fake("start", &[]);
    let err = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &request(id),
        cmd.command.clone(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "project_folder_missing");
    assert!(cmd.log_entries().is_empty());
    assert!(!h.manager.state().running);
    // 폴더 자리에 파일이 생겨도 폴더가 아니다
    fs::write(&h.project, "x").unwrap();
    let err = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &request(id),
        cmd.command.clone(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "project_folder_missing");
    assert!(cmd.log_entries().is_empty());
}

#[test]
fn a_project_whose_folder_became_unselectable_is_refused_and_nothing_runs() {
    let h = Harness::new("launch-forbidden");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    // 등록한 뒤 위치 설정이 바뀌어 이 폴더가 "고를 수 없는 폴더" 가 됐다 (홈 폴더 자체 · 앱 데이터 안)
    for env in [
        env_with(ForbiddenSet::new().with_exact(ForbiddenReason::Home, &h.project)),
        env_with(ForbiddenSet::new().with_inside(ForbiddenReason::AppData, &h.root)),
        env_with(ForbiddenSet::new().with_inside(ForbiddenReason::ClaudeDir, &h.project)),
    ] {
        let cmd = h.fake("start", &[]);
        let err = launch::start_session(
            &h.manager,
            &db,
            &env,
            PlannerChoice::default(),
            &request(id),
            cmd.command.clone(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), "project_folder_forbidden");
        assert!(cmd.log_entries().is_empty());
    }
    assert!(!h.manager.state().running);
}

#[test]
fn an_unusable_database_refuses_instead_of_guessing_a_folder() {
    let h = Harness::new("launch-nodb");
    // DB 자리에 폴더를 둬서 못 열게 한다
    let blocked = h.root.join("data").join(DB_FILE);
    fs::create_dir_all(&blocked).unwrap();
    let db = open_db(&h);
    let cmd = h.fake("start", &[]);
    let err = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &request(1),
        cmd.command.clone(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "db_unavailable");
    assert!(cmd.log_entries().is_empty());
}

#[test]
fn only_one_session_runs_at_a_time_even_for_another_project() {
    let h = Harness::new("launch-one");
    let db = open_db(&h);
    let first = register(&db, &h, "first");
    let second_dir = h.root.join("second-project");
    fs::create_dir_all(&second_dir).unwrap();
    let second = db
        .write(|conn| {
            store::insert(
                conn,
                &second_dir.display().to_string(),
                &project_key(&second_dir),
                "second",
                None,
                OPENED_LONG_AGO,
            )
        })
        .unwrap()
        .id;
    let cmd = h.fake("start", &[]);
    launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &request(first),
        cmd.command.clone(),
    )
    .unwrap();
    for id in [first, second] {
        let err = launch::start_session(
            &h.manager,
            &db,
            &plain_env(),
            PlannerChoice::default(),
            &request(id),
            cmd.command.clone(),
        )
        .unwrap_err();
        assert_eq!(err.kind(), "session_running", "project {id}");
    }
    // 거절된 시작은 도는 세션을 건드리지 않았다
    assert_eq!(h.manager.state().project_id, Some(first));
    h.manager.stop().unwrap();
}

// ───────────────────────── 이어 하기 · 최근에 연 ─────────────────────────

#[test]
fn the_last_session_is_asked_and_resumed_by_project_id() {
    let mut h = Harness::new("launch-resume");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    assert_eq!(launch::last_session(&h.manager, &db, id).unwrap(), None);

    let first = h.fake("resume.first", &[]);
    launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        planner(Some("opus"), Some("high")),
        &request(id),
        first.command.clone(),
    )
    .unwrap();
    h.manager.send_message("remember PINEAPPLE").unwrap();
    h.wait_for("turn end", turn_outcome);
    assert_eq!(
        launch::last_session(&h.manager, &db, id)
            .unwrap()
            .as_deref(),
        Some(SESSION_ID)
    );
    h.manager.stop().unwrap();
    h.wait_ended();
    assert!(!first.argv().contains(&"--resume".to_string()));

    let second = h.fake("resume.second", &[]);
    let info = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        planner(Some("opus"), Some("high")),
        &StartRequest {
            project_id: id,
            resume: true,
            use_api_key: false,
        },
        second.command.clone(),
    )
    .unwrap();
    assert!(info.resumed);
    assert_eq!(info.resume_session_id.as_deref(), Some(SESSION_ID));
    assert_eq!(info.project_id, id);
    h.manager.send_message("what did I say?").unwrap();
    assert_eq!(h.wait_for("turn", turn_outcome), TurnOutcome::Success);
    let argv = wait_for_argv(&second);
    assert_eq!(after(&argv, "--resume").as_deref(), Some(SESSION_ID));
    // 모델 · 수준도 이어 할 때 같다
    assert_eq!(after(&argv, "--model").as_deref(), Some("opus"));
    assert_eq!(after(&argv, "--effort").as_deref(), Some("high"));
    h.manager.stop().unwrap();
}

#[test]
fn resuming_a_project_with_no_saved_session_is_refused_and_asking_for_unknown_ids_fails() {
    let h = Harness::new("launch-noresume");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    let cmd = h.fake("start", &[]);
    let err = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &StartRequest {
            project_id: id,
            resume: true,
            use_api_key: false,
        },
        cmd.command.clone(),
    )
    .unwrap_err();
    assert_eq!(err.kind(), "no_saved_session");
    assert!(cmd.log_entries().is_empty());
    assert_eq!(
        launch::last_session(&h.manager, &db, id + 5)
            .unwrap_err()
            .kind(),
        "project_not_found"
    );
    // 폴더가 없어진 프로젝트는 이어 할 수 없는 이유가 폴더다
    fs::remove_dir_all(&h.project).unwrap();
    assert_eq!(
        launch::last_session(&h.manager, &db, id)
            .unwrap_err()
            .kind(),
        "project_folder_missing"
    );
}

#[test]
fn starting_marks_the_project_as_opened_just_now_and_a_failed_start_does_not() {
    let h = Harness::new("launch-touch");
    let db = open_db(&h);
    let id = register(&db, &h, "p");
    let opened = |db: &AppDb| {
        db.read(|conn| store::get(conn, id))
            .unwrap()
            .unwrap()
            .last_opened_at
    };
    assert_eq!(opened(&db), OPENED_LONG_AGO);

    // 시작이 실패하면(이어 할 세션이 없음) 기록하지 않는다
    let cmd = h.fake("start", &[]);
    launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &StartRequest {
            project_id: id,
            resume: true,
            use_api_key: false,
        },
        cmd.command.clone(),
    )
    .unwrap_err();
    assert_eq!(opened(&db), OPENED_LONG_AGO);

    launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &request(id),
        cmd.command.clone(),
    )
    .unwrap();
    assert!(opened(&db) > OPENED_LONG_AGO);
    h.manager.stop().unwrap();
}

#[test]
fn a_database_that_cannot_be_written_still_starts_the_session_and_says_so() {
    let mut h = Harness::new("launch-touch-readonly");
    let data = h.root.join("data");
    let id = {
        let db = open_db(&h);
        register(&db, &h, "p")
    };
    // 이 앱보다 새 번호의 DB 로 바꾼다 — 읽기만 된다 (`db_read_only`)
    {
        let conn = rusqlite::Connection::open(data.join(DB_FILE)).unwrap();
        conn.pragma_update(None, "user_version", 9999).unwrap();
    }
    let db = open_db(&h);
    let cmd = h.fake("start", &[]);
    let info = launch::start_session(
        &h.manager,
        &db,
        &plain_env(),
        PlannerChoice::default(),
        &request(id),
        cmd.command.clone(),
    )
    .unwrap();
    assert_eq!(info.project_id, id);
    let detail = h.wait_for("touch warning", |e| match e {
        SessionEvent::Warning { code, detail } if code == "project_touch_failed" => {
            Some(detail.clone())
        }
        _ => None,
    });
    assert_eq!(detail.as_deref(), Some("db_read_only"));
    h.manager.send_message("say pong").unwrap();
    assert_eq!(h.wait_for("turn", turn_outcome), TurnOutcome::Success);
    h.manager.stop().unwrap();
}
