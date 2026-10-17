//! 세션 관리자 경계 시험 (P3-03) — 시작 중 겹치는 호출 · 응답 검사 · 죽음 · 이상한 바이트 · 저장소 실패를 가짜 CLI 로 돌린다.
//! 실제 `claude` 는 쓰지 않는다. 이 파일만의 시나리오는 시험 안에서 만든 녹화 폴더(`NYANITOR_FAKE_FIXTURES`)로 재생한다.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::events::{AnswerValue, EndKind, Response, SessionEvent, TurnOutcome};
use serde_json::{Value, json};

const SESSION_ID: &str = "00000000-0000-4000-8000-000000000001";

// ───────────────────────── 녹화 만들기 ─────────────────────────

fn send_user() -> Value {
    json!({ "dir": "send", "msg": { "type": "user", "message": { "role": "user", "content": "x" } } })
}

fn send_control() -> Value {
    json!({ "dir": "send", "msg": { "type": "control_response", "response": { "subtype": "success" } } })
}

fn recv(msg: Value) -> Value {
    json!({ "dir": "recv", "msg": msg })
}

fn init(session_id: &str) -> Value {
    recv(json!({
        "type": "system", "subtype": "init", "session_id": session_id, "model": "m",
        "claude_code_version": "2.1.296", "permissionMode": "default", "apiKeySource": "none"
    }))
}

fn text(t: &str) -> Value {
    recv(json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": t }] } }))
}

fn result(total: f64) -> Value {
    recv(json!({
        "type": "result", "subtype": "success", "is_error": false, "result": "ok",
        "total_cost_usd": total, "usage": { "input_tokens": 1, "output_tokens": 2 }
    }))
}

fn can_use(request_id: &str, tool: &str, input: Value) -> Value {
    recv(json!({
        "type": "control_request", "request_id": request_id,
        "request": { "subtype": "can_use_tool", "tool_name": tool, "input": input, "description": "d" }
    }))
}

fn exit_with(code: i32) -> Value {
    json!({ "dir": "exit", "code": code })
}

fn bytes(data: &[u8]) -> Value {
    let hex: String = data.iter().map(|b| format!("{b:02x}")).collect();
    json!({ "dir": "recv_bytes", "hex": hex })
}

/// 이 시험만의 녹화 파일들을 만든다. 돌려주는 폴더를 `NYANITOR_FAKE_FIXTURES` 로 넘긴다.
fn fixtures(h: &Harness, scenarios: &[(&str, Vec<Value>)]) -> PathBuf {
    let dir = h.root.join("fixtures");
    fs::create_dir_all(&dir).unwrap();
    for (name, records) in scenarios {
        let body: Vec<String> = records.iter().map(Value::to_string).collect();
        fs::write(dir.join(format!("{name}.jsonl")), body.join("\n") + "\n").unwrap();
    }
    dir
}

fn custom(h: &Harness, dir: &PathBuf, name: &str, flags: &[&str]) -> FakeCmd {
    h.fake(name, flags).env("NYANITOR_FAKE_FIXTURES", dir)
}

fn turn_outcome(event: &SessionEvent) -> Option<TurnOutcome> {
    match event {
        SessionEvent::TurnEnded(t) => Some(t.outcome),
        _ => None,
    }
}

fn permission_id(event: &SessionEvent) -> Option<String> {
    match event {
        SessionEvent::PermissionRequest(p) => Some(p.request_id.clone()),
        _ => None,
    }
}

fn question_id(event: &SessionEvent) -> Option<String> {
    match event {
        SessionEvent::QuestionRequest(q) => Some(q.request_id.clone()),
        _ => None,
    }
}

fn warning_code(event: &SessionEvent) -> Option<String> {
    match event {
        SessionEvent::Warning { code, .. } => Some(code.clone()),
        _ => None,
    }
}

/// 조건이 될 때까지 기다린다 (넉넉하게).
fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if condition() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("timed out waiting for {what}");
}

// ───────────────────────── 시작 · 끝내기가 겹칠 때 ─────────────────────────

#[test]
fn a_second_start_while_the_first_is_still_starting_is_refused_and_launches_nothing() {
    let mut h = Harness::new("start-race");
    // `--version` 확인이 오래 걸리는 동안 (시작 중)
    let slow = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_VERSION_DELAY_MS", "900");
    let second = h.fake("start", &[]);
    let (manager, request, command) = (h.manager.clone(), h.request(), slow.command.clone());
    let first = thread::spawn(move || manager.start(request, command));
    thread::sleep(Duration::from_millis(250));

    let err = h.start(&second).unwrap_err();
    assert_eq!(err.kind(), "session_running");
    assert!(
        second.log_entries().is_empty(),
        "the refused start must not have run claude at all: {:?}",
        second.log_entries()
    );

    let info = first.join().unwrap().expect("the first start succeeds");
    assert!(pid_alive(info.pid));
    h.manager.send_message("pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    assert!(wait_dead(info.pid, Duration::from_secs(5)));
}

#[test]
fn stopping_while_a_start_is_in_progress_never_leaves_a_session_running_afterwards() {
    let h = Harness::new("stop-during-start");
    let slow = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_VERSION_DELAY_MS", "900");
    let (manager, request, command) = (h.manager.clone(), h.request(), slow.command.clone());
    let starting = thread::spawn(move || manager.start(request, command));
    thread::sleep(Duration::from_millis(250));

    // 끝내기가 시작 중에 들어왔다 — 시작이 끝난 뒤에 끝내거나, 시작을 막아야 한다. 어느 쪽이든 끝내기가 돌아온 뒤 세션이 남아 있으면 안 된다.
    let stopped = h.manager.stop();
    let started = starting.join().unwrap();
    if let Ok(info) = &started {
        assert!(
            wait_dead(info.pid, Duration::from_secs(5)),
            "a session survived a stop that came while it was starting"
        );
    }
    assert!(stopped.is_ok());
    assert!(
        !h.manager.state().running,
        "stop() returned but a session is running (stop: {stopped:?}, start: {started:?})"
    );
}

#[test]
fn many_simultaneous_starts_launch_exactly_one_process() {
    let h = Harness::new("start-storm");
    let mut threads = Vec::new();
    let cmds: Vec<_> = (0..6).map(|_| h.fake("start", &[])).collect();
    for cmd in &cmds {
        let (manager, request, command) = (h.manager.clone(), h.request(), cmd.command.clone());
        threads.push(thread::spawn(move || manager.start(request, command)));
    }
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    let ok: Vec<_> = results.iter().filter(|r| r.is_ok()).collect();
    assert_eq!(ok.len(), 1, "{results:?}");
    for r in results.iter().filter_map(|r| r.as_ref().err()) {
        assert_eq!(r.kind(), "session_running");
    }
    // 띄운 프로세스가 기록을 남길 때까지 기다린 뒤, 더 늘지 않는지 잠시 지켜본다
    wait_until("the one claude to log its start", || {
        cmds.iter().any(|c| !c.argv().is_empty())
    });
    thread::sleep(Duration::from_millis(400));
    let launched = cmds.iter().filter(|c| !c.argv().is_empty()).count();
    assert_eq!(launched, 1, "only one claude was launched");
    h.manager.stop().unwrap();
}

#[test]
fn interrupting_twice_in_a_row_while_idle_is_harmless_and_the_next_message_still_works() {
    let mut h = Harness::new("double-interrupt");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.interrupt().unwrap();
    h.manager.interrupt().unwrap();
    h.manager.send_message("pong").unwrap();
    assert_eq!(h.wait_for("turn", turn_outcome), TurnOutcome::Success);

    let interrupts: Vec<_> = cmd
        .stdin_messages()
        .into_iter()
        .filter(|m| m["type"] == "control_request" && m["request"]["subtype"] == "interrupt")
        .collect();
    assert_eq!(interrupts.len(), 2);
    assert_ne!(
        interrupts[0]["request_id"], interrupts[1]["request_id"],
        "each interrupt has its own request id"
    );
    h.manager.stop().unwrap();
}

#[test]
fn after_the_process_died_every_command_says_no_session_and_a_second_stop_is_a_no_op() {
    let mut h = Harness::new("after-death");
    let cmd = h.fake("start", &["die-before-result"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    h.wait_ended();

    assert_eq!(
        h.manager.send_message("again").unwrap_err().kind(),
        "no_session"
    );
    assert_eq!(h.manager.interrupt().unwrap_err().kind(), "no_session");
    assert_eq!(
        h.manager.respond("x", Response::Allow).unwrap_err().kind(),
        "no_session"
    );
    let state = h.manager.state();
    assert!(!state.running && !state.busy && state.pending.is_empty());
    for _ in 0..2 {
        let stop = h.manager.stop().unwrap();
        assert!(!stop.was_running && !stop.forced);
    }
}

#[test]
fn stop_after_a_clean_stop_is_a_no_op_and_start_works_again_without_leftovers() {
    let mut h = Harness::new("stop-twice");
    let first = h.fake("start", &[]);
    let info = h.start(&first).unwrap();
    assert!(h.manager.stop().unwrap().was_running);
    let again = h.manager.stop().unwrap();
    assert!(!again.was_running);
    assert!(wait_dead(info.pid, Duration::from_secs(5)));
    h.wait_ended();
    // 세션 끝 알림은 한 번만 왔다
    let ended = h
        .seen()
        .iter()
        .filter(|e| matches!(e, SessionEvent::SessionEnded { .. }))
        .count();
    assert_eq!(ended, 1);
    let second = h.fake("start", &[]);
    h.start(&second).unwrap();
    h.manager.stop().unwrap();
}

#[test]
fn stopping_in_the_middle_of_a_turn_sends_an_interrupt_before_closing_stdin() {
    let mut h = Harness::new("stop-busy");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write a file").unwrap();
    h.wait_for("card", permission_id);
    assert!(h.manager.state().busy);

    let stopped = h.manager.stop().unwrap();
    assert!(stopped.was_running && !stopped.forced);
    let kinds: Vec<_> = cmd
        .stdin_messages()
        .iter()
        .map(|m| {
            if m["type"] == "control_request" {
                format!(
                    "control_request:{}",
                    m["request"]["subtype"].as_str().unwrap()
                )
            } else {
                m["type"].as_str().unwrap().to_string()
            }
        })
        .collect();
    assert_eq!(kinds, ["user", "control_request:interrupt"], "{kinds:?}");
    let SessionEvent::SessionEnded {
        ended, mid_turn, ..
    } = h.wait_ended()
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Normal);
    assert!(mid_turn);
}

#[test]
fn the_cli_dying_by_itself_while_a_card_is_open_cancels_the_card_before_the_end_notice() {
    let mut h = Harness::new("die-with-card");
    // free: 녹화를 답 기다림 없이 끝까지 틀고, 첫 result 직전에 죽는다 → 카드가 열린 채 프로세스가 사라진다
    let cmd = h.fake("permission-allow", &["free", "die-before-result"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write a file").unwrap();
    let id = h.wait_for("card", permission_id);
    let cancelled = h.wait_for("card closed", |e| match e {
        SessionEvent::RequestCancelled { request_id } => Some(request_id.clone()),
        _ => None,
    });
    assert_eq!(cancelled, id);
    let SessionEvent::SessionEnded {
        ended,
        exit_code,
        mid_turn,
        ..
    } = h.wait_ended()
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Died);
    assert_eq!(exit_code, Some(1));
    assert!(mid_turn);
    let state = h.manager.state();
    assert!(!state.running && state.pending.is_empty());
    // 끝 알림 뒤에는 어떤 이벤트도 더 오지 않는다
    let kinds = h.kinds();
    assert_eq!(
        kinds.last().map(String::as_str),
        Some("session_ended"),
        "{kinds:?}"
    );
    assert_eq!(
        h.manager.respond(&id, Response::Allow).unwrap_err().kind(),
        "no_session"
    );
}

// ───────────────────────── 응답 검사 ─────────────────────────

fn open_card(name: &str) -> (Harness, FakeCmd, String) {
    let mut h = Harness::new(name);
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write a file").unwrap();
    let id = h.wait_for("card", permission_id);
    (h, cmd, id)
}

#[test]
fn a_tell_with_no_words_or_too_many_is_refused_and_the_card_stays_for_a_valid_one() {
    let (mut h, cmd, id) = open_card("tell-bad");
    for bad in ["", "   ", "\n\t", &"x".repeat((1 << 20) + 1)] {
        let err = h
            .manager
            .respond(
                &id,
                Response::Tell {
                    text: bad.to_string(),
                },
            )
            .unwrap_err();
        assert_eq!(
            err.kind(),
            "invalid_input",
            "{:?}",
            &bad[..bad.len().min(10)]
        );
        assert_eq!(h.manager.state().pending.len(), 1, "the card must stay");
    }
    h.manager
        .respond(
            &id,
            Response::Tell {
                text: "다르게 해 주세요".into(),
            },
        )
        .unwrap();
    assert!(h.manager.state().pending.is_empty());
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    // 끝난 뒤(= CLI 가 받은 줄을 모두 기록한 뒤) 본다: 거절된 답은 CLI 로 가지 않았고, 마지막 올바른 말 하나만 갔다
    assert_eq!(
        cmd.control_responses().len(),
        1,
        "only the valid answer may reach the CLI"
    );
}

#[test]
fn a_denial_with_only_spaces_uses_the_default_message_and_an_oversized_one_is_refused() {
    let (h, cmd, id) = open_card("deny-edge");
    let err = h
        .manager
        .respond(
            &id,
            Response::Deny {
                message: Some("x".repeat((1 << 20) + 1)),
            },
        )
        .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert_eq!(h.manager.state().pending.len(), 1);
    h.manager
        .respond(
            &id,
            Response::Deny {
                message: Some("   \n ".into()),
            },
        )
        .unwrap();
    h.manager.stop().unwrap();
    let responses = cmd.control_responses();
    assert_eq!(responses.len(), 1);
    let message = responses[0]["response"]["message"].as_str().unwrap();
    assert!(
        !message.trim().is_empty(),
        "a blank message must become the default one"
    );
    assert_eq!(responses[0]["response"]["behavior"], "deny");
}

#[test]
fn odd_request_ids_are_just_not_found() {
    let (h, cmd, id) = open_card("odd-ids");
    let long = "x".repeat(100_000);
    for odd in [
        "",
        " ",
        &format!(" {id}"),
        &format!("{id}\n"),
        "한글",
        "../../etc",
        "\0",
        long.as_str(),
    ] {
        let err = h.manager.respond(odd, Response::Allow).unwrap_err();
        let expected = if odd == id {
            "never"
        } else {
            "request_not_found"
        };
        assert_eq!(err.kind(), expected, "{:?}", &odd[..odd.len().min(12)]);
    }
    assert_eq!(
        h.manager.state().pending.len(),
        1,
        "the real card is untouched"
    );
    h.manager.stop().unwrap();
    assert!(cmd.control_responses().is_empty());
}

#[test]
fn a_permission_card_refuses_questions_answers_and_a_question_refuses_permission_answers() {
    let (h, _cmd, id) = open_card("kind-mismatch");
    let mut answers = BTreeMap::new();
    answers.insert("q".to_string(), AnswerValue::One("a".into()));
    assert_eq!(
        h.manager
            .respond(
                &id,
                Response::Answer {
                    answers: BTreeMap::new()
                }
            )
            .unwrap_err()
            .kind(),
        "invalid_input"
    );
    assert_eq!(h.manager.state().pending.len(), 1);
    h.manager.stop().unwrap();

    let mut q = Harness::new("question-kinds");
    let cmd = q.fake("question", &[]);
    q.start(&cmd).unwrap();
    q.manager.send_message("ask me").unwrap();
    let qid = q.wait_for("question", question_id);
    for wrong in [
        Response::Allow,
        Response::AlwaysAllow,
        Response::Tell { text: "hi".into() },
    ] {
        let err = q.manager.respond(&qid, wrong).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert_eq!(q.manager.state().pending.len(), 1, "the question stays");
    }
    q.manager.stop().unwrap();
    assert!(cmd.control_responses().is_empty());
}

#[test]
fn a_written_answer_over_the_size_limit_is_refused_and_the_question_stays() {
    let mut h = Harness::new("answer-big");
    let cmd = h.fake("question", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask me").unwrap();
    let qid = h.wait_for("question", question_id);
    let Some(SessionEvent::QuestionRequest(info)) = h.manager.state().pending.first().cloned()
    else {
        panic!("a pending question");
    };
    let key = info.questions[0].question.clone();
    let mut answers = BTreeMap::new();
    for q in &info.questions {
        answers.insert(q.question.clone(), AnswerValue::One("ok".into()));
    }
    answers.insert(key, AnswerValue::One("x".repeat((1 << 20) + 1)));
    let err = h
        .manager
        .respond(&qid, Response::Answer { answers })
        .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert_eq!(h.manager.state().pending.len(), 1);
    h.manager.stop().unwrap();
    assert!(cmd.control_responses().is_empty());
}

#[test]
fn answering_in_the_same_instant_from_two_threads_sends_exactly_one_response() {
    let (h, cmd, id) = open_card("double-answer");
    let mut threads = Vec::new();
    for _ in 0..8 {
        let (manager, id) = (h.manager.clone(), id.clone());
        threads.push(thread::spawn(move || manager.respond(&id, Response::Allow)));
    }
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(
        results.iter().filter(|r| r.is_ok()).count(),
        1,
        "{results:?}"
    );
    for err in results.iter().filter_map(|r| r.as_ref().err()) {
        assert_eq!(err.kind(), "request_not_found");
    }
    h.manager.stop().unwrap();
    assert_eq!(cmd.control_responses().len(), 1);
}

#[test]
fn the_same_request_id_arriving_twice_makes_one_card_not_two() {
    let mut h = Harness::new("dup-request");
    let scenario = vec![
        send_user(),
        init(SESSION_ID),
        can_use("dup", "Bash", json!({ "command": "ls" })),
        can_use("dup", "Bash", json!({ "command": "ls" })),
        send_control(),
        result(0.1),
        exit_with(0),
    ];
    let dir = fixtures(&h, &[("dup", scenario)]);
    let cmd = custom(&h, &dir, "dup", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    h.wait_for("card", permission_id);
    wait_until("both requests read", || {
        h.manager
            .raw_log()
            .iter()
            .filter(|e| e.dir == "recv" && e.text.contains("can_use_tool"))
            .count()
            == 2
    });
    assert_eq!(h.manager.state().pending.len(), 1);
    h.manager.stop().unwrap();
}

// ───────────────────────── 이상한 줄 · 바이트 ─────────────────────────

#[test]
fn crlf_line_ends_blank_lines_and_invalid_utf8_inside_a_line_do_not_break_the_turn() {
    let mut h = Harness::new("odd-bytes");
    let mut assistant: Vec<u8> =
        br#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok "#.to_vec();
    assistant.extend_from_slice(&[0xff, 0xfe]);
    assistant.extend_from_slice(b" bad\"}]}}\n");
    let scenario = vec![
        send_user(),
        bytes(
            format!(
                "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{SESSION_ID}\"}}\r\n"
            )
            .as_bytes(),
        ),
        bytes(b"\n\r\n   \n\t\r\n\r\r\n"),
        bytes(&assistant),
        bytes(b"{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.2}\r\n"),
        exit_with(0),
    ];
    let dir = fixtures(&h, &[("odd-bytes", scenario)]);
    let cmd = custom(&h, &dir, "odd-bytes", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();

    let started = h.wait_for("turn_started", |e| match e {
        SessionEvent::TurnStarted { session_id, .. } => Some(session_id.clone()),
        _ => None,
    });
    assert_eq!(
        started, SESSION_ID,
        "a CRLF-terminated line is read like any other"
    );
    let shown = h.wait_for("text", |e| match e {
        SessionEvent::Text { text } => Some(text.clone()),
        _ => None,
    });
    assert!(
        shown.starts_with("ok ") && shown.ends_with(" bad"),
        "{shown:?}"
    );
    assert!(
        shown.contains('\u{fffd}'),
        "broken bytes become replacement characters: {shown:?}"
    );
    assert_eq!(h.wait_for("turn_ended", turn_outcome), TurnOutcome::Success);
    assert!(!h.manager.state().busy);

    // 빈 줄 · 공백 줄은 원본 로그에도 남기지 않는다
    for entry in h.manager.raw_log().iter().filter(|e| e.dir == "recv") {
        assert!(
            !entry.text.trim().is_empty(),
            "blank line in the raw log: {entry:?}"
        );
        assert!(!entry.text.ends_with('\r'), "CR must be trimmed: {entry:?}");
    }
    let stopped = h.manager.stop().unwrap();
    assert!(stopped.was_running && !stopped.forced);
}

#[test]
fn a_multibyte_character_cut_at_the_very_end_is_survived_and_only_reaches_the_raw_log() {
    let mut h = Harness::new("cut-utf8");
    let mut partial: Vec<u8> =
        br#"{"type":"assistant","message":{"content":[{"type":"text","text":"ab"#.to_vec();
    partial.extend_from_slice(&[0xea, 0xb0]); // `가`(EA B0 80) 의 앞 두 바이트
    let scenario = vec![send_user(), init(SESSION_ID), bytes(&partial), exit_with(1)];
    let dir = fixtures(&h, &[("cut-utf8", scenario)]);
    let cmd = custom(&h, &dir, "cut-utf8", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    let SessionEvent::SessionEnded {
        ended,
        exit_code,
        mid_turn,
        ..
    } = h.wait_ended()
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Died);
    assert_eq!(exit_code, Some(1));
    assert!(mid_turn);
    assert!(
        !h.kinds().contains(&"text".to_string()),
        "a half line must not become a message"
    );
    assert!(
        h.manager
            .raw_log()
            .iter()
            .any(|e| e.dir == "recv" && e.text.contains("\"text\":\"ab")),
        "the broken line is kept for diagnosis"
    );
}

#[test]
fn a_result_with_no_turn_running_only_reports_and_leaves_the_session_usable() {
    let mut h = Harness::new("stray-result");
    let scenario = vec![result(0.25), exit_with(0)];
    let dir = fixtures(&h, &[("stray", scenario)]);
    let cmd = custom(&h, &dir, "stray", &["free"]);
    h.start(&cmd).unwrap();
    assert_eq!(h.wait_for("turn_ended", turn_outcome), TurnOutcome::Success);
    let state = h.manager.state();
    assert!(state.running && !state.busy, "{state:?}");
    let stop = h.manager.stop().unwrap();
    assert!(stop.was_running && !stop.forced);
}

#[test]
fn a_flood_of_lines_keeps_every_event_but_only_the_newest_thousand_in_the_raw_log() {
    let mut h = Harness::new("flood");
    let mut scenario = vec![send_user(), init(SESSION_ID)];
    scenario.extend((0..1500).map(|i| text(&format!("line {i}"))));
    scenario.push(result(0.1));
    scenario.push(exit_with(0));
    let dir = fixtures(&h, &[("flood", scenario)]);
    let cmd = custom(&h, &dir, "flood", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    h.wait_for("turn_ended", turn_outcome);

    let texts = h
        .seen()
        .iter()
        .filter(|e| matches!(e, SessionEvent::Text { .. }))
        .count();
    assert_eq!(texts, 1500, "no event may be lost");
    let log = h.manager.raw_log();
    assert_eq!(log.len(), 1000);
    assert!(log.windows(2).all(|w| w[0].seq < w[1].seq));
    assert!(
        log.last().unwrap().seq >= 1500,
        "the newest lines are the ones kept"
    );
    h.manager.stop().unwrap();
}

// ───────────────────────── 세션 ID · 저장소 ─────────────────────────

#[test]
fn a_session_id_of_a_strange_shape_is_not_saved_the_old_one_survives_and_the_session_goes_on() {
    let mut h = Harness::with_saved_session("weird-ids", SESSION_ID);
    let weird = [
        "has space in it",
        "short",
        "",
        "id;rm -rf /",
        "한글세션아이디입니다만",
        &"a".repeat(100),
        "line\nbreak-id-xx",
    ];
    let scenarios: Vec<(String, Vec<Value>)> = weird
        .iter()
        .enumerate()
        .map(|(n, id)| {
            (
                format!("weird{n}"),
                vec![send_user(), init(id), text("ok"), result(0.1), exit_with(0)],
            )
        })
        .collect();
    let refs: Vec<(&str, Vec<Value>)> = scenarios
        .iter()
        .map(|(n, s)| (n.as_str(), s.clone()))
        .collect();
    let dir = fixtures(&h, &refs);
    for (n, id) in weird.iter().enumerate() {
        let cmd = custom(&h, &dir, &format!("weird{n}"), &[]);
        h.start(&cmd).unwrap();
        h.manager.send_message("go").unwrap();
        assert_eq!(
            h.wait_for("store warning", warning_code),
            "session_store_failed",
            "{id:?}"
        );
        assert_eq!(
            h.wait_for("turn end", turn_outcome),
            TurnOutcome::Success,
            "{id:?}"
        );
        h.manager.stop().unwrap();
        h.wait_ended();
        assert_eq!(
            h.manager
                .last_session(&h.project.display().to_string())
                .unwrap()
                .as_deref(),
            Some(SESSION_ID),
            "a strange id ({id:?}) replaced the saved one"
        );
    }
}

#[test]
fn a_session_id_that_looks_like_an_option_is_never_saved_nor_passed_back_as_an_argument() {
    let mut h = Harness::new("option-like-id");
    let evil = "--dangerously-skip-permissions";
    let dir = fixtures(
        &h,
        &[
            (
                "evil",
                vec![send_user(), init(evil), result(0.1), exit_with(0)],
            ),
            (
                "again",
                vec![send_user(), init(SESSION_ID), result(0.1), exit_with(0)],
            ),
        ],
    );
    let first = custom(&h, &dir, "evil", &[]);
    h.start(&first).unwrap();
    h.manager.send_message("go").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();

    let second = custom(&h, &dir, "again", &[]);
    // 저장되지 않았다면 이어 하기는 기록이 없다고 거절한다. 저장됐다면 인자로 들어가는지 본다.
    if h.start_resume(&second).is_ok() {
        h.manager.send_message("go").unwrap();
        h.wait_for("turn end", turn_outcome);
        assert!(
            !second.argv().iter().any(|a| a == evil),
            "the CLI-provided id became an argument: {:?}",
            second.argv()
        );
        h.manager.stop().unwrap();
    }
}

#[test]
fn when_the_session_file_cannot_be_written_the_session_still_runs_and_only_warns() {
    let mut h = Harness::new("store-unwritable");
    // 데이터 폴더 자리에 파일이 있어 만들 수 없다
    fs::write(h.root.join("data"), b"i am a file").unwrap();
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    assert_eq!(h.wait_for("warning", warning_code), "session_store_failed");
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    assert_eq!(
        h.manager
            .last_session(&h.project.display().to_string())
            .unwrap(),
        None,
        "nothing was saved, so nothing is claimed"
    );
    // 다음 이어 하기는 기록이 없다고 분명히 말한다
    h.manager.stop().unwrap();
    let again = h.fake("start", &[]);
    assert_eq!(
        h.start_resume(&again).unwrap_err().kind(),
        "no_saved_session"
    );
}

#[cfg(windows)]
#[test]
fn the_saved_session_is_found_when_the_same_folder_is_typed_in_another_case_with_a_trailing_slash()
{
    let mut h = Harness::with_saved_session("spelling", SESSION_ID);
    let respelled = format!("{}\\", h.project.display().to_string().to_uppercase());
    assert_eq!(
        h.manager.last_session(&respelled).unwrap().as_deref(),
        Some(SESSION_ID)
    );
    let cmd = h.fake("resume.second", &[]);
    let mut request = h.request();
    request.project_dir = respelled;
    request.resume = true;
    let info = h.manager.start(request, cmd.command.clone()).unwrap();
    assert_eq!(info.resume_session_id.as_deref(), Some(SESSION_ID));
    h.manager.send_message("what did I say?").unwrap();
    h.wait_for("turn", turn_outcome);
    let argv = cmd.argv();
    let at = argv.iter().position(|a| a == "--resume").expect("--resume");
    assert_eq!(argv[at + 1], SESSION_ID);
    h.manager.stop().unwrap();
}

#[test]
fn a_folder_that_vanished_between_pick_and_start_is_a_plain_invalid_input_and_runs_nothing() {
    let h = Harness::new("vanished");
    let cmd = h.fake("start", &[]);
    let mut request = h.request();
    let gone = h.root.join("gone-folder");
    fs::create_dir(&gone).unwrap();
    request.project_dir = gone.display().to_string();
    fs::remove_dir(&gone).unwrap();
    let err = h.manager.start(request, cmd.command.clone()).unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert!(cmd.log_entries().is_empty());
    assert!(!h.manager.state().running);
}

#[test]
fn start_with_a_model_name_that_looks_like_an_option_runs_nothing() {
    let h = Harness::new("model-option");
    let cmd = h.fake("start", &[]);
    for bad in ["--dangerously-skip-permissions", "-p", "opus --foo", ""] {
        let mut request = h.request();
        request.model = Some(bad.to_string());
        let err = h.manager.start(request, cmd.command.clone()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input", "{bad:?}");
    }
    assert!(
        cmd.log_entries().is_empty(),
        "claude must not have been run"
    );
}

#[test]
fn the_end_notice_carries_the_last_five_stderr_lines_cut_short() {
    let mut h = Harness::new("stderr-tail");
    let mut scenario = vec![send_user(), init(SESSION_ID)];
    for i in 0..9 {
        scenario.push(json!({ "dir": "stderr", "raw": format!("err {i} {}", "z".repeat(500)) }));
    }
    scenario.push(exit_with(1));
    let dir = fixtures(&h, &[("stderr", scenario)]);
    let cmd = custom(&h, &dir, "stderr", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    let SessionEvent::SessionEnded { stderr_tail, .. } = h.wait_ended() else {
        unreachable!()
    };
    assert_eq!(stderr_tail.len(), 5, "{stderr_tail:?}");
    assert!(stderr_tail[0].starts_with("err 4"));
    assert!(stderr_tail[4].starts_with("err 8"));
    assert!(stderr_tail.iter().all(|l| l.chars().count() <= 301));
}

// ───────────────────────── P3-05: CLI 가 스스로 끝난 뒤 정리 ─────────────────────────

#[test]
fn the_writer_thread_ends_after_the_cli_dies_by_itself_and_every_other_way_it_can_end() {
    // (시나리오 이름, 끝내기를 앱이 부르는가). 앱이 부르지 않아도 (CLI 가 죽음 · 스스로 끝남 · 끊김) 쓰기 스레드가 끝나야 한다.
    for (name, flags, app_stops) in [
        ("start", vec!["die-before-result"], false),
        ("cut-line", vec!["cut-line"], false),
        ("start", vec![], true),
    ] {
        let mut h = Harness::new(&format!("writer-{name}"));
        let cmd = h.fake(name, &flags);
        h.start(&cmd).unwrap();
        wait_until("the writer thread to start", || {
            h.manager.running_writers() == 1
        });
        h.manager.send_message("pong").unwrap();
        if app_stops {
            h.wait_for("turn end", turn_outcome);
            h.manager.stop().unwrap();
        }
        h.wait_ended();
        wait_until("the writer thread to end after the session ended", || {
            h.manager.running_writers() == 0
        });
        assert!(!h.manager.state().running);
        // 끝난 세션에는 아무것도 못 보낸다 (닫힌 stdin 에 쌓이지 않는다)
        assert_eq!(
            h.manager.send_message("again").unwrap_err().kind(),
            "no_session"
        );
    }
}

#[test]
fn a_cli_that_ends_on_its_own_with_a_final_exit_code_also_releases_its_writer() {
    let mut h = Harness::new("writer-exit0");
    let dir = fixtures(
        &h,
        &[(
            "bye",
            vec![send_user(), init(SESSION_ID), result(0.1), exit_with(3)],
        )],
    );
    let cmd = custom(&h, &dir, "bye", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    h.wait_ended();
    wait_until("the writer thread to end", || {
        h.manager.running_writers() == 0
    });
    // 다음 세션도 정상으로 뜨고 쓰기 스레드는 다시 하나다
    let second = custom(&h, &dir, "bye", &[]);
    h.start(&second).unwrap();
    wait_until("one writer again", || h.manager.running_writers() == 1);
    h.manager.send_message("go").unwrap();
    h.wait_ended();
    wait_until("the writer thread to end again", || {
        h.manager.running_writers() == 0
    });
}

#[test]
fn a_session_id_the_cli_reports_that_is_not_a_uuid_is_never_saved_or_used_to_resume() {
    let mut h = Harness::with_saved_session("not-uuid-id", SESSION_ID);
    let dir = fixtures(
        &h,
        &[(
            "odd",
            vec![send_user(), init("abcdefgh"), result(0.1), exit_with(1)],
        )],
    );
    let cmd = custom(&h, &dir, "odd", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    assert_eq!(
        h.wait_for("store warning", warning_code),
        "session_store_failed"
    );
    h.wait_ended();
    assert_eq!(
        h.manager
            .last_session(&h.project.display().to_string())
            .unwrap()
            .as_deref(),
        Some(SESSION_ID)
    );
    // 이어 하기 인자에는 저장된 UUID 만 들어간다
    let resume = custom(&h, &dir, "odd", &[]);
    h.start_resume(&resume).unwrap();
    wait_until("the resumed claude to log its start", || {
        !resume.argv().is_empty()
    });
    let argv = resume.argv();
    let at = argv.iter().position(|a| a == "--resume").unwrap();
    assert_eq!(argv[at + 1], SESSION_ID);
}
