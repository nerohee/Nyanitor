//! 프로젝트 빼기와 세션이 겹칠 때 (P6-10 ①) — 진짜 세션 관리자 + 가짜 CLI. 실제 `claude` 는 쓰지 않는다.
//!
//! 그 프로젝트의 세션이 시작 중이거나 돌고 있으면 빼기는 `session_running` 으로 거절되고 프로젝트 · 기록은 그대로다. 세션이 끝난 뒤에는 빠진다.
//! 시작 쪽도 같은 잠금 안에서 프로젝트가 아직 있는지 보므로, 빼기와 시작이 동시에 와도 "둘 다 성공" 은 없다.

mod common;

use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;

use common::*;
use nyanitor_lib::claude::events::{SessionEvent, TurnOutcome};
use nyanitor_lib::projects::{self, ProjectsState};

fn turn_outcome(event: &SessionEvent) -> Option<TurnOutcome> {
    match event {
        SessionEvent::TurnEnded(t) => Some(t.outcome),
        _ => None,
    }
}

fn count(h: &Harness, table: &str, project_id: i64) -> i64 {
    h.db.read(|conn| {
        Ok(conn.query_row(
            &format!("SELECT count(*) FROM {table} WHERE project_id = ?1"),
            [project_id],
            |row| row.get(0),
        )?)
    })
    .unwrap()
}

fn project_count(h: &Harness) -> i64 {
    h.db.read(|conn| Ok(conn.query_row("SELECT count(*) FROM projects", [], |row| row.get(0))?))
        .unwrap()
}

fn state_of(h: &Harness) -> ProjectsState {
    ProjectsState::new(h.root.join("data"))
}

/// 다른 프로젝트(2번)를 직접 등록한다
fn register_second(h: &Harness) {
    h.db.write(|conn| {
        conn.execute(
            "INSERT INTO projects (id, path, path_key, name, created_at, last_opened_at) VALUES (2, 'x', 'x', 'x', 1, 1)",
            [],
        )?;
        Ok(())
    })
    .unwrap();
}

#[test]
fn removing_the_project_of_a_running_session_is_refused_and_nothing_is_lost_until_it_ends() {
    let mut h = Harness::new("remove-running");
    let cmd = h.fake("start", &[]);
    let info = h.start(&cmd).unwrap();
    h.manager.send_message("say pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.flush_history(Duration::from_secs(10));
    let (sessions, chat) = (count(&h, "sessions", 1), count(&h, "chat_items", 1));
    assert!(sessions > 0 && chat > 0);

    let state = state_of(&h);
    let err = projects::remove(&h.db, &state, &h.manager, 1).unwrap_err();
    assert_eq!(err.kind(), "session_running");
    // 프로젝트 · 세션 ID · 기록이 그대로다
    assert_eq!(project_count(&h), 1);
    assert_eq!(count(&h, "sessions", 1), sessions);
    assert_eq!(count(&h, "chat_items", 1), chat);
    // 세션은 계속 돈다 — 거절이 세션을 건드리지 않았다
    assert!(pid_alive(info.pid));
    assert!(h.manager.state().running);

    // 끝낸 뒤에는 빠진다 (기록도 같이)
    h.manager.stop().unwrap();
    h.wait_ended();
    projects::remove(&h.db, &state, &h.manager, 1).unwrap();
    assert_eq!(project_count(&h), 0);
    for table in ["sessions", "chat_items", "usage_turns"] {
        assert_eq!(count(&h, table, 1), 0, "{table}");
    }
}

#[test]
fn another_project_can_be_removed_while_a_session_runs() {
    let mut h = Harness::new("remove-other");
    register_second(&h);
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    let state = state_of(&h);
    projects::remove(&h.db, &state, &h.manager, 2).unwrap();
    assert_eq!(project_count(&h), 1);
    assert!(h.manager.state().running, "the session is untouched");
    h.manager.stop().unwrap();
    h.wait_ended();
}

#[test]
fn removing_the_project_while_its_session_is_still_starting_is_refused() {
    let mut h = Harness::new("remove-starting");
    // `--version` 확인이 오래 걸리는 동안 (시작 중 — 아직 프로세스 · 세션이 없다)
    let slow = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_VERSION_DELAY_MS", "900");
    let (manager, plan, command) = (h.manager.clone(), h.plan(), slow.command.clone());
    let starting = thread::spawn(move || manager.start(plan, command));
    thread::sleep(Duration::from_millis(250));

    let state = state_of(&h);
    let err = projects::remove(&h.db, &state, &h.manager, 1).unwrap_err();
    assert_eq!(err.kind(), "session_running");
    assert_eq!(project_count(&h), 1);

    let info = starting.join().unwrap().expect("the start succeeds");
    assert!(pid_alive(info.pid));
    h.manager.stop().unwrap();
    h.wait_ended();
    projects::remove(&h.db, &state, &h.manager, 1).unwrap();
    assert_eq!(project_count(&h), 0);
}

#[test]
fn a_start_planned_before_the_project_was_removed_is_refused_and_launches_nothing() {
    let h = Harness::new("start-after-remove");
    let state = state_of(&h);
    // 계획(`plan`)을 세운 뒤, 시작 자리를 잡기 전에 프로젝트가 빠졌다
    let plan = h.plan();
    projects::remove(&h.db, &state, &h.manager, 1).unwrap();
    let cmd = h.fake("start", &[]);
    let db = h.db.clone();
    let err = h
        .manager
        .start_checked(plan, cmd.command.clone(), || {
            projects::project_dir(&db, 1).map(drop)
        })
        .unwrap_err();
    assert_eq!(err.kind(), "project_not_found");
    assert!(
        cmd.log_entries().is_empty(),
        "the refused start must not have run claude at all"
    );
    assert!(!h.manager.state().running);
    // 자리도 잡히지 않았다 — 다른 시작이 막히지 않는다
    let again = h.fake("start", &[]);
    assert!(h.start(&again).is_ok());
    h.manager.stop().unwrap();
}

#[test]
fn remove_and_start_arriving_together_never_both_succeed() {
    for round in 0..8 {
        let mut h = Harness::new(&format!("remove-race-{round}"));
        let state = state_of(&h);
        let cmd = h.fake("start", &[]);
        let barrier = Arc::new(Barrier::new(2));

        let starter = {
            let (manager, db, plan, command, barrier) = (
                h.manager.clone(),
                h.db.clone(),
                h.plan(),
                cmd.command.clone(),
                barrier.clone(),
            );
            thread::spawn(move || {
                barrier.wait();
                manager.start_checked(plan, command, || projects::project_dir(&db, 1).map(drop))
            })
        };
        let remover = {
            let (manager, db, state, barrier) =
                (h.manager.clone(), h.db.clone(), state.clone(), barrier);
            thread::spawn(move || {
                barrier.wait();
                projects::remove(&db, &state, &manager, 1)
            })
        };
        let started = starter.join().unwrap();
        let removed = remover.join().unwrap();

        match (&started, &removed) {
            // 먼저 시작했다 → 빼기는 거절, 프로젝트는 그대로
            (Ok(_), Err(err)) => {
                assert_eq!(err.kind(), "session_running", "round {round}");
                assert_eq!(project_count(&h), 1, "round {round}");
                h.manager.stop().unwrap();
                h.wait_ended();
            }
            // 먼저 빠졌다 → 시작은 거절, 프로세스는 뜨지 않았다
            (Err(err), Ok(())) => {
                assert_eq!(err.kind(), "project_not_found", "round {round}");
                assert_eq!(project_count(&h), 0, "round {round}");
                assert!(cmd.log_entries().is_empty(), "round {round}: claude ran");
            }
            other => panic!("round {round}: both succeeded or both failed: {other:?}"),
        }
    }
}
