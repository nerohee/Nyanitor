//! 작업자(서브에이전트) 시험 (P7-02) — 진짜 세션 관리자 + 가짜 CLI(`examples/fake_claude.rs`)가 실제 CLI 녹화본(`agent*.jsonl`)을 재생한다.
//! 보는 것: 작업자 시작 · 끝 이벤트가 시나리오대로 나온다 · 일하는 중에 상태를 물으면 작업자가 보인다 · 세션이 끝나거나 죽거나 중단되면 남은 작업자가 "멈춤" 으로 끝난다 ·
//! 채팅 기록에는 이름 · 설명 · 결과 · 시각뿐이고 지시 글 · 작업자 결과 글은 없다 · 앱을 다시 켜면 끝 없는 작업자는 "멈춤".
//! 실제 `claude` 는 쓰지 않는다.

mod common;

use common::*;
use nyanitor_lib::claude::events::{EndKind, Response, SessionEvent, TurnOutcome, WorkerOutcome};
use nyanitor_lib::history::chat::{WorkerState, WorkerStatus};
use nyanitor_lib::history::{self, ChatPage};
use serde_json::Value;

/// 녹화본 `agent*.jsonl` 의 지시 글 · 작업자 결과 글 가운데 기록에 있으면 안 되는 것들.
const PROMPT_TEXT: &str = "reply with only the first word";
const HAND_BACK_TEXT: &str = "Claude Docs document";

fn permission_id(event: &SessionEvent) -> Option<String> {
    match event {
        SessionEvent::PermissionRequest(p) => Some(p.request_id.clone()),
        _ => None,
    }
}

fn turn_outcome(event: &SessionEvent) -> Option<TurnOutcome> {
    match event {
        SessionEvent::TurnEnded(t) => Some(t.outcome),
        _ => None,
    }
}

fn worker_end(event: &SessionEvent) -> Option<(String, WorkerOutcome)> {
    match event {
        SessionEvent::WorkerEnded {
            tool_use_id,
            outcome,
            ..
        } => Some((tool_use_id.clone(), *outcome)),
        _ => None,
    }
}

fn worker_start(event: &SessionEvent) -> Option<(String, String, bool)> {
    match event {
        SessionEvent::WorkerStarted {
            tool_use_id,
            name,
            background,
            ..
        } => Some((tool_use_id.clone(), name.clone(), *background)),
        _ => None,
    }
}

fn read(h: &Harness) -> ChatPage {
    history::chat_history(&h.db, &h.manager, 1, None, 100).expect("read the chat history")
}

fn worker_rows(page: &ChatPage) -> Vec<(String, Option<WorkerState>)> {
    page.entries
        .iter()
        .filter(|e| e.event["type"] == "worker_started")
        .map(|e| {
            (
                e.event["name"].as_str().unwrap().to_string(),
                e.worker.clone(),
            )
        })
        .collect()
}

/// 앱 DB 의 채팅 기록 줄 전부 (저장된 JSON 그대로)
fn stored_bodies(h: &Harness) -> Vec<(String, String)> {
    h.manager.flush_history(WAIT);
    h.db.read(|conn| {
        let mut statement = conn.prepare("SELECT kind, body FROM chat_items ORDER BY id")?;
        let rows = statement
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
    .expect("read the stored items")
}

fn assert_no_prompt_or_result_text_stored(h: &Harness) {
    for (kind, body) in stored_bodies(h) {
        assert!(
            !body.contains(PROMPT_TEXT) && !body.contains(HAND_BACK_TEXT),
            "{kind} stored the prompt or the worker's result text: {body}"
        );
    }
}

// ───────────────────────── 앞 · 뒤 · 둘 ─────────────────────────

#[test]
fn a_foreground_worker_starts_and_ends_and_the_history_shows_it_done() {
    let mut h = Harness::new("worker-fg");
    let cmd = h.fake("agent", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate").unwrap();
    let (call, name, background) = h.wait_for("worker start", worker_start);
    assert_eq!(name, "probe-helper");
    assert!(!background);
    let (ended_call, outcome) = h.wait_for("worker end", worker_end);
    assert_eq!(ended_call, call);
    assert_eq!(outcome, WorkerOutcome::Done);
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    assert!(h.manager.state().workers.is_empty());

    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h);
    let rows = worker_rows(&page);
    assert_eq!(rows.len(), 1);
    let state = rows[0].1.as_ref().unwrap();
    assert_eq!(state.status, WorkerStatus::Done);
    assert!(state.ended_at_ms.is_some());
    // 끝 항목은 목록에 따로 나오지 않는다. 작업자 안쪽 글 · 도구는 기록에도 없다 (메인의 Agent 호출 하나뿐)
    assert!(
        page.entries
            .iter()
            .all(|e| e.event["type"] != "worker_ended")
    );
    let tools: Vec<_> = page
        .entries
        .iter()
        .filter(|e| e.event["type"] == "tool_use")
        .map(|e| e.event["tool"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(tools, ["Agent"]);
    assert_no_prompt_or_result_text_stored(&h);
}

#[test]
fn a_background_worker_ends_after_the_first_turn_and_the_second_turn_starts_by_itself() {
    let mut h = Harness::new("worker-bg");
    let cmd = h.fake("agent.default", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate").unwrap();
    let (call, _, background) = h.wait_for("worker start", worker_start);
    assert!(background);
    // 첫 턴이 끝났는데도 작업자는 일하는 중이다
    assert_eq!(
        h.wait_for("first turn end", turn_outcome),
        TurnOutcome::Success
    );
    let (ended_call, outcome) = h.wait_for("worker end", worker_end);
    assert_eq!(ended_call, call);
    assert_eq!(outcome, WorkerOutcome::Done);
    // 끝 알림 뒤 CLI 가 스스로 둘째 턴을 시작해 끝낸다
    assert_eq!(
        h.wait_for("second turn end", turn_outcome),
        TurnOutcome::Success
    );
    h.manager.stop().unwrap();
    h.wait_ended();
    assert_no_prompt_or_result_text_stored(&h);
}

#[test]
fn two_workers_are_told_apart_by_their_call_ids() {
    let mut h = Harness::new("worker-two");
    let cmd = h.fake("agent-two", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate two").unwrap();
    let first = h.wait_for("first start", worker_start);
    let second = h.wait_for("second start", worker_start);
    assert_ne!(first.0, second.0);
    let mut ends = vec![
        h.wait_for("first end", worker_end),
        h.wait_for("second end", worker_end),
    ];
    ends.sort_by(|a, b| a.0.cmp(&b.0));
    let mut want = vec![
        (first.0.clone(), WorkerOutcome::Done),
        (second.0.clone(), WorkerOutcome::Done),
    ];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(ends, want);
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    h.manager.stop().unwrap();
    h.wait_ended();
    assert_eq!(worker_rows(&read(&h)).len(), 2);
}

#[test]
fn nothing_from_inside_a_worker_comes_out_as_chat_events() {
    let mut h = Harness::new("worker-inner");
    let cmd = h.fake("agent", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate").unwrap();
    h.wait_for("turn end", turn_outcome);
    let events: Vec<SessionEvent> = h.seen().to_vec();
    // 작업자의 안쪽 도구(Read) · 작업자가 한 말(banana\n\n Note…)이 메인 이벤트에 없다
    for event in &events {
        match event {
            SessionEvent::ToolUse { tool, .. } => assert_eq!(tool, "Agent", "{event:?}"),
            SessionEvent::Text { text } => assert_eq!(text, "banana", "{event:?}"),
            _ => {}
        }
    }
    // 원본 출력에는 그대로 남는다 (안쪽 줄도)
    let raw_inner = events.iter().any(|e| {
        matches!(e, SessionEvent::RawLog(r) if r.dir == "recv" && r.text.contains("\"parent_tool_use_id\":\"toolu_"))
    });
    assert!(raw_inner, "the raw log keeps the worker's inner lines");
    h.manager.stop().unwrap();
}

// ───────────────────────── 권한 · 중단 ─────────────────────────

#[test]
fn a_permission_request_from_a_worker_says_which_worker_and_the_state_shows_it_working() {
    let mut h = Harness::new("worker-permission");
    let cmd = h.fake("agent-permission", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate").unwrap();
    let (call, _, _) = h.wait_for("worker start", worker_start);
    let (id, worker) = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some((p.request_id.clone(), p.worker.clone())),
        _ => None,
    });
    let worker = worker.expect("the request came from a worker");
    assert_eq!(worker.tool_use_id.as_deref(), Some(call.as_str()));
    assert_eq!(worker.name.as_deref(), Some("probe-writer"));
    // 화면을 다시 열면 일하는 작업자와 기다리는 카드가 같이 보인다
    let state = h.manager.state();
    assert_eq!(state.workers.len(), 1);
    assert_eq!(state.pending.len(), 1);
    assert_eq!(
        h.manager
            .state()
            .workers
            .first()
            .and_then(worker_start)
            .map(|w| w.0),
        Some(call)
    );
    h.manager.respond(&id, Response::Allow).unwrap();
    h.wait_for("worker end", worker_end);
    h.wait_for("turn end", turn_outcome);
    assert!(h.manager.state().workers.is_empty());
    h.manager.stop().unwrap();
    h.wait_ended();
    // 기록의 카드에도 어느 작업자인지 남는다 (도구 입력은 없다)
    let page = read(&h);
    let card = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "permission_request")
        .unwrap();
    assert_eq!(card.event["worker"]["name"], "probe-writer");
    assert!(card.event.get("input").is_none());
}

#[test]
fn interrupting_while_a_worker_works_stops_it_once_before_the_turn_ends_interrupted() {
    let mut h = Harness::new("worker-interrupt");
    let cmd = h.fake("agent-interrupt", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate slow").unwrap();
    let (call, name, _) = h.wait_for("worker start", worker_start);
    assert_eq!(name, "probe-slow");
    let id = h.wait_for("permission", permission_id);
    h.manager.respond(&id, Response::Allow).unwrap();
    h.manager.interrupt().unwrap();
    let (ended_call, outcome) = h.wait_for("worker end", worker_end);
    assert_eq!(ended_call, call);
    assert_eq!(outcome, WorkerOutcome::Stopped);
    assert_eq!(
        h.wait_for("turn end", turn_outcome),
        TurnOutcome::Interrupted
    );
    assert!(h.manager.state().workers.is_empty());
    h.manager.stop().unwrap();
    h.wait_ended();
    // 끝이 한 번뿐이다
    let ends = h.seen().iter().filter_map(worker_end).count();
    assert_eq!(ends, 1);
    let rows = worker_rows(&read(&h));
    assert_eq!(rows[0].1.as_ref().unwrap().status, WorkerStatus::Stopped);
}

// ───────────────────────── 세션이 끝나거나 죽을 때 ─────────────────────────

#[test]
fn stopping_the_session_while_a_worker_works_ends_it_as_stopped_before_the_end_notice() {
    let mut h = Harness::new("worker-stop");
    let cmd = h.fake("agent-interrupt", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate slow").unwrap();
    let (call, _, _) = h.wait_for("worker start", worker_start);
    h.wait_for("permission", permission_id);
    assert_eq!(h.manager.state().workers.len(), 1);

    h.manager.stop().unwrap();
    h.wait_ended();
    let events: Vec<SessionEvent> = h.seen().to_vec();
    let end = events.iter().position(|e| worker_end(e).is_some()).unwrap();
    let session_end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::SessionEnded { .. }))
        .unwrap();
    assert!(end < session_end, "작업자는 끝 알림 앞에서 멈춘다");
    assert_eq!(
        worker_end(&events[end]),
        Some((call, WorkerOutcome::Stopped))
    );
    // 세션이 끝난 뒤 상태에는 작업자가 없다
    assert!(h.manager.state().workers.is_empty());
    let rows = worker_rows(&read(&h));
    assert_eq!(rows[0].1.as_ref().unwrap().status, WorkerStatus::Stopped);
    assert!(rows[0].1.as_ref().unwrap().ended_at_ms.is_some());
}

#[test]
fn a_session_that_dies_while_a_worker_works_leaves_no_worker_running() {
    let mut h = Harness::new("worker-die");
    // 첫 `result` 직전에 죽는다 — 그때 백그라운드 작업자는 일하는 중이다
    let cmd = h.fake("agent.default", &["die-before-result"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate").unwrap();
    let (call, _, _) = h.wait_for("worker start", worker_start);
    let ended = h.wait_ended();
    let SessionEvent::SessionEnded { ended: kind, .. } = ended else {
        unreachable!()
    };
    assert_eq!(kind, EndKind::Died);
    let events: Vec<SessionEvent> = h.seen().to_vec();
    let ends: Vec<_> = events.iter().filter_map(worker_end).collect();
    assert_eq!(ends, [(call, WorkerOutcome::Stopped)]);
    let end = events.iter().position(|e| worker_end(e).is_some()).unwrap();
    let session_end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::SessionEnded { .. }))
        .unwrap();
    assert!(end < session_end);
    assert!(h.manager.state().workers.is_empty());
    let rows = worker_rows(&read(&h));
    assert_eq!(rows[0].1.as_ref().unwrap().status, WorkerStatus::Stopped);
}

// ───────────────────────── 앱을 다시 켤 때 ─────────────────────────

#[test]
fn after_a_restart_a_worker_with_no_end_row_shows_as_stopped_not_running() {
    let mut h = Harness::new("worker-restart");
    let cmd = h.fake("agent-interrupt", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate slow").unwrap();
    h.wait_for("worker start", worker_start);
    h.wait_for("permission", permission_id);
    // 일하는 동안에는 "일하는 중"
    let page = read(&h);
    assert_eq!(
        worker_rows(&page)[0].1.as_ref().unwrap().status,
        WorkerStatus::Running
    );
    h.manager.stop().unwrap();
    h.wait_ended();
    // 앱이 죽어서 끝 줄을 못 남긴 것처럼 — 끝 줄을 지운다
    h.manager.flush_history(WAIT);
    h.db.write(|conn| {
        conn.execute("DELETE FROM chat_items WHERE kind = 'worker_ended'", [])?;
        Ok(())
    })
    .unwrap();
    let page = read(&h);
    let state = worker_rows(&page)[0].1.clone().unwrap();
    assert_eq!(state.status, WorkerStatus::Stopped);
    assert_eq!(state.ended_at_ms, None, "끝 시각을 지어내지 않는다");
}

#[test]
fn the_stored_worker_rows_have_no_prompt_and_no_result_text_even_for_a_failed_call() {
    let mut h = Harness::new("worker-stored");
    let cmd = h.fake("agent-permission", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("delegate").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager.respond(&id, Response::Allow).unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let bodies = stored_bodies(&h);
    let kinds: Vec<&str> = bodies.iter().map(|(k, _)| k.as_str()).collect();
    assert!(kinds.contains(&"worker_started") && kinds.contains(&"worker_ended"));
    assert!(
        !kinds.contains(&"worker_activity"),
        "하는 일은 저장하지 않는다"
    );
    for (kind, body) in &bodies {
        if kind.starts_with("worker_") {
            let value: Value = serde_json::from_str(body).unwrap();
            let keys: Vec<&str> = value
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            for key in keys {
                assert!(
                    [
                        "type",
                        "toolUseId",
                        "agentId",
                        "name",
                        "description",
                        "background",
                        "depth",
                        "atMs",
                        "outcome"
                    ]
                    .contains(&key),
                    "{kind} stores an unexpected field {key}"
                );
            }
        }
    }
    assert_no_prompt_or_result_text_stored(&h);
    // 이 녹화의 지시 글 · 작업자의 결과 글도 없다
    for (kind, body) in &bodies {
        assert!(
            !body.contains("Create a file named out.txt") && !body.contains("containing `hi`"),
            "{kind}: {body}"
        );
    }
}
