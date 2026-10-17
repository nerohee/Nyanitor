//! 세션 관리자 시험 — 진짜 프로세스 경로(띄우기 · 줄 읽기 · 응답 · 종료 · 트리 끄기)를 가짜 CLI(`examples/fake_claude.rs`)로 돌린다.
//! 가짜 CLI 는 P3-01 녹화본을 재생한다. 실제 `claude` 는 쓰지 않는다.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::events::{AnswerValue, EndKind, Response, SessionEvent, TurnOutcome};
use nyanitor_lib::claude::exec::ClaudeCommand;
use nyanitor_lib::claude::store::{ResumeStore, project_key};
use serde_json::{Value, json};

const SESSION_ID: &str = "00000000-0000-4000-8000-000000000001";

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

// ───────────────────────── 한 턴 · 끝내기 ─────────────────────────

#[test]
fn a_plain_turn_streams_events_and_stop_ends_it_cleanly() {
    let mut h = Harness::new("plain");
    let cmd = h.fake("start", &[]);
    let info = h.start(&cmd).unwrap();
    assert!(!info.resumed);
    assert_eq!(info.cli_version.as_deref(), Some("2.1.296"));
    h.wait_for("session_started", |e| {
        matches!(e, SessionEvent::SessionStarted { .. }).then_some(())
    });

    h.manager.send_message("say pong").unwrap();
    h.wait_for("user_message", |e| {
        matches!(
            e,
            SessionEvent::UserMessage {
                deferred: false,
                ..
            }
        )
        .then_some(())
    });
    h.wait_for("turn_started", |e| match e {
        SessionEvent::TurnStarted { session_id, .. } => Some(session_id.clone()),
        _ => None,
    });
    let text = h.wait_for("text", |e| match e {
        SessionEvent::Text { text } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(text, "pong");
    h.wait_for("rate_limit", |e| {
        matches!(e, SessionEvent::RateLimit { .. }).then_some(())
    });
    let outcome = h.wait_for("turn_ended", turn_outcome);
    assert_eq!(outcome, TurnOutcome::Success);
    assert!(!h.manager.state().busy);

    // 앱은 사용자 메시지 한 줄만 보냈다 (initialize 같은 것을 보내지 않는다)
    let sent = cmd.stdin_messages();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["message"]["content"], "say pong");

    let stopped = h.manager.stop().unwrap();
    assert!(stopped.was_running && !stopped.forced);
    let SessionEvent::SessionEnded {
        ended,
        exit_code,
        forced,
        mid_turn,
        ..
    } = h.wait_ended()
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Normal);
    assert_eq!(exit_code, Some(0));
    assert!(!forced && !mid_turn);
    assert!(!h.manager.state().running);
}

#[test]
fn the_cli_is_started_with_the_d44_options_in_the_project_folder() {
    let h = Harness::new("args");
    let cmd = h.fake("start", &[]);
    let mut request = h.request();
    request.model = Some("haiku".into());
    h.manager.start(request, cmd.command.clone()).unwrap();
    // 세션 인자 기록이 생길 때까지 기다린다
    let deadline = Instant::now() + WAIT;
    while cmd.argv().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    let argv = cmd.argv();
    assert_eq!(
        argv,
        [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--permission-prompt-tool",
            "stdio",
            "--model",
            "haiku"
        ]
    );
    h.manager.stop().unwrap();
}

#[test]
fn the_working_folder_of_the_cli_is_the_project_folder() {
    let mut h = Harness::new("cwd");
    // 녹화의 작업 폴더 이름은 가짜 CLI 가 자기 실제 작업 폴더로 바꿔 내보낸다 → 권한 카드의 cwd 와 같은 폴더여야 한다
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    let info = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    });
    assert_eq!(info.cwd, h.project.display().to_string());
    let path = info.path.unwrap();
    assert!(path.starts_with(&h.project.display().to_string()), "{path}");
}

#[test]
fn a_second_start_is_refused_while_one_is_running() {
    let h = Harness::new("single");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    let err = h.start(&cmd).unwrap_err();
    assert_eq!(err.kind(), "session_running");
    h.manager.stop().unwrap();
    // 끝난 뒤에는 다시 시작할 수 있다
    let again = h.fake("start", &[]);
    h.start(&again).unwrap();
    h.manager.stop().unwrap();
}

#[test]
fn commands_without_a_session_say_so() {
    let h = Harness::new("none");
    assert_eq!(
        h.manager.send_message("x").unwrap_err().kind(),
        "no_session"
    );
    assert_eq!(h.manager.interrupt().unwrap_err().kind(), "no_session");
    assert_eq!(
        h.manager.respond("r", Response::Allow).unwrap_err().kind(),
        "no_session"
    );
    let stopped = h.manager.stop().unwrap();
    assert!(!stopped.was_running);
    assert!(!h.manager.state().running);
}

#[test]
fn start_rejects_bad_folders_and_models_before_running_anything() {
    let h = Harness::new("badinput");
    let cmd = h.fake("start", &[]);
    for dir in ["", "relative", "C:\\definitely\\not\\here\\nyanitor-xyz"] {
        let mut request = h.request();
        request.project_dir = dir.into();
        let err = h.manager.start(request, cmd.command.clone()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input", "{dir}");
    }
    let mut request = h.request();
    request.model = Some("--dangerously-skip-permissions".into());
    assert_eq!(
        h.manager
            .start(request, cmd.command.clone())
            .unwrap_err()
            .kind(),
        "invalid_input"
    );
    assert!(!cmd.log.exists(), "the fake was never launched");
}

#[test]
fn a_missing_executable_is_reported_as_claude_not_found() {
    let h = Harness::new("nocli");
    let missing = nyanitor_lib::claude::exec::ClaudeCommand::new(h.root.join("no-such-claude.exe"));
    // 버전 확인에서 먼저 막힌다 (실행 파일이 없으면 internal 오류로 알린다)
    let err = h.manager.start(h.request(), missing).unwrap_err();
    assert!(
        matches!(err.kind(), "internal" | "claude_not_found"),
        "{}",
        err.kind()
    );
    assert!(!h.manager.state().running);
}

#[test]
fn a_second_message_during_a_turn_is_refused() {
    let mut h = Harness::new("busy");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    assert_eq!(
        h.manager.send_message("again").unwrap_err().kind(),
        "turn_in_progress"
    );
    let state = h.manager.state();
    assert!(state.busy);
    h.wait_for("permission", permission_id);
    assert_eq!(
        h.manager.state().pending.len(),
        1,
        "state restores the card"
    );
}

// ───────────────────────── 권한 응답 ─────────────────────────

#[test]
fn allow_sends_the_original_input_and_no_rule() {
    let mut h = Harness::new("allow");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write hello.txt").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager.respond(&id, Response::Allow).unwrap();
    h.wait_for("tool result", |e| {
        matches!(
            e,
            SessionEvent::ToolResult {
                is_error: false,
                ..
            }
        )
        .then_some(())
    });
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);

    let responses = cmd.control_responses();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0]["subtype"], "success");
    assert_eq!(responses[0]["request_id"], id);
    let body = &responses[0]["response"];
    assert_eq!(body["behavior"], "allow");
    assert!(
        body["updatedInput"]["file_path"]
            .as_str()
            .unwrap()
            .ends_with("hello.txt")
    );
    assert!(body.get("updatedPermissions").is_none());
    assert!(h.manager.state().pending.is_empty());
}

#[test]
fn answering_the_same_request_twice_is_refused() {
    let mut h = Harness::new("twice");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager.respond(&id, Response::Allow).unwrap();
    let err = h.manager.respond(&id, Response::Allow).unwrap_err();
    assert_eq!(err.kind(), "request_not_found");
    assert_eq!(
        h.manager
            .respond("never-asked", Response::Deny { message: None })
            .unwrap_err()
            .kind(),
        "request_not_found"
    );
    h.wait_for("turn end", turn_outcome);
    assert_eq!(
        cmd.control_responses().len(),
        1,
        "only one answer reached the CLI"
    );
}

#[test]
fn always_allow_for_bash_sends_the_rule_the_cli_suggested() {
    let mut h = Harness::new("always-bash");
    let cmd = h.fake("permission-always", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("mkdir").unwrap();
    let info = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    });
    assert_eq!(
        info.always_rule.as_ref().unwrap().rule,
        "Bash(mkdir probe-dir *)"
    );
    h.manager
        .respond(&info.request_id, Response::AlwaysAllow)
        .unwrap();
    h.wait_for("turn end", turn_outcome);

    let body = &cmd.control_responses()[0]["response"];
    assert_eq!(body["behavior"], "allow");
    assert_eq!(
        body["updatedPermissions"],
        json!([{
            "type": "addRules",
            "rules": [{ "toolName": "Bash", "ruleContent": "mkdir probe-dir *" }],
            "behavior": "allow",
            "destination": "localSettings"
        }])
    );
}

#[test]
fn always_allow_for_write_is_narrowed_to_the_files_folder() {
    let mut h = Harness::new("always-write");
    // `permission-scope.first` 의 Write 는 `sub/a.txt` — 가짜 CLI 가 작업 폴더를 이 프로젝트 폴더로 바꿔 준다
    let cmd = h.fake("permission-scope.first", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write sub/a.txt").unwrap();
    let info = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    });
    let rule = info
        .always_rule
        .as_ref()
        .expect("a rule for a file inside the project");
    assert_eq!(rule.rule, "Edit(/sub/**)");
    assert_eq!(rule.folder.as_deref(), Some("sub"));
    h.manager
        .respond(&info.request_id, Response::AlwaysAllow)
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    let body = &cmd.control_responses()[0]["response"];
    assert_eq!(
        body["updatedPermissions"][0]["rules"],
        json!([{ "toolName": "Edit", "ruleContent": "/sub/**" }])
    );
    assert_eq!(
        body["updatedPermissions"][0]["destination"],
        "localSettings"
    );
}

#[test]
fn always_allow_is_refused_for_a_file_outside_the_project_and_the_request_stays() {
    let mut h = Harness::new("always-outside");
    // `keep-cwd`: 녹화의 옛 작업 폴더를 그대로 둔다 → 파일이 이 프로젝트 폴더 밖
    let cmd = h.fake("permission-allow", &["keep-cwd"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    let info = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    });
    assert_eq!(
        info.always_rule, None,
        "no always-allow button for this one"
    );
    let err = h
        .manager
        .respond(&info.request_id, Response::AlwaysAllow)
        .unwrap_err();
    assert_eq!(err.kind(), "invalid_input");
    assert_eq!(h.manager.state().pending.len(), 1, "still waiting");
    h.manager
        .respond(&info.request_id, Response::Allow)
        .unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
}

#[test]
fn answers_that_do_not_fit_the_request_kind_are_refused_and_the_request_stays() {
    let mut h = Harness::new("kind-mismatch");
    let cmd = h.fake("question", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask me").unwrap();
    let (id, _) = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some((q.request_id.clone(), q.questions.len())),
        _ => None,
    });
    for wrong in [
        Response::Allow,
        Response::AlwaysAllow,
        Response::Tell { text: "x".into() },
    ] {
        let err = h.manager.respond(&id, wrong).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
    }
    assert_eq!(h.manager.state().pending.len(), 1, "still waiting");
    assert!(cmd.control_responses().is_empty());
}

#[test]
fn deny_sends_the_message_or_a_default() {
    let mut h = Harness::new("deny");
    let cmd = h.fake("permission-deny", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write draft").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager
        .respond(
            &id,
            Response::Deny {
                message: Some("not that file".into()),
            },
        )
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    let body = &cmd.control_responses()[0]["response"];
    assert_eq!(body["behavior"], "deny");
    assert_eq!(body["message"], "not that file");
    assert!(body.get("interrupt").is_none());
}

#[test]
fn deny_without_a_message_uses_a_default_one() {
    let mut h = Harness::new("deny-default");
    let cmd = h.fake("permission-deny", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write draft").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager
        .respond(
            &id,
            Response::Deny {
                message: Some("   ".into()),
            },
        )
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    let body = &cmd.control_responses()[0]["response"];
    assert_eq!(body["behavior"], "deny");
    assert!(!body["message"].as_str().unwrap().is_empty());
}

#[test]
fn telling_it_otherwise_denies_with_interrupt_then_sends_the_words_as_a_new_message() {
    let mut h = Harness::new("tell");
    let cmd = h.fake("permission-deny.interrupt", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write draft.txt").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager
        .respond(
            &id,
            Response::Tell {
                text: "use notes.txt instead".into(),
            },
        )
        .unwrap();

    // 거부 + 중단 → 그 턴은 "중단됨" 으로 끝나고 → 사용자의 말이 새 메시지로 나간다
    assert_eq!(
        h.wait_for("interrupted", turn_outcome),
        TurnOutcome::Interrupted
    );
    let words = h.wait_for("deferred message", |e| match e {
        SessionEvent::UserMessage {
            text,
            deferred: true,
        } => Some(text.clone()),
        _ => None,
    });
    assert_eq!(words, "use notes.txt instead");
    let second = h.wait_for("second permission", permission_id);
    h.manager.respond(&second, Response::Allow).unwrap();
    assert_eq!(h.wait_for("final", turn_outcome), TurnOutcome::Success);

    let responses = cmd.control_responses();
    assert_eq!(responses[0]["response"]["behavior"], "deny");
    assert_eq!(responses[0]["response"]["interrupt"], true);
    let users: Vec<_> = cmd
        .stdin_messages()
        .into_iter()
        .filter(|m| m["type"] == "user")
        .map(|m| m["message"]["content"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(users, ["write draft.txt", "use notes.txt instead"]);
    // 나간 순서: 거부 → 사용자 메시지
    let order: Vec<_> = cmd
        .stdin_messages()
        .iter()
        .map(|m| m["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        order,
        ["user", "control_response", "user", "control_response"]
    );
}

// ───────────────────────── 질문 ─────────────────────────

fn first_option_answers(
    q: &nyanitor_lib::claude::events::QuestionRequestInfo,
) -> BTreeMap<String, AnswerValue> {
    q.questions
        .iter()
        .map(|question| {
            let value = if question.multi_select {
                AnswerValue::Many(
                    question
                        .options
                        .iter()
                        .take(2)
                        .map(|o| o.label.clone())
                        .collect(),
                )
            } else {
                AnswerValue::One(question.options[0].label.clone())
            };
            (question.question.clone(), value)
        })
        .collect()
}

#[test]
fn a_single_choice_answer_goes_back_in_updated_input_answers() {
    let mut h = Harness::new("q-single");
    let cmd = h.fake("question", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask").unwrap();
    let q = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some(q.clone()),
        _ => None,
    });
    let answers = first_option_answers(&q);
    h.manager
        .respond(
            &q.request_id,
            Response::Answer {
                answers: answers.clone(),
            },
        )
        .unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);

    let body = &cmd.control_responses()[0]["response"];
    assert_eq!(body["behavior"], "allow");
    // CLI 가 준 questions 원본이 그대로 돌아가고 답이 얹힌다
    assert!(body["updatedInput"]["questions"].as_array().is_some());
    let given = body["updatedInput"]["answers"].as_object().unwrap();
    assert_eq!(given.len(), q.questions.len());
    for (question, value) in &answers {
        let AnswerValue::One(label) = value else {
            panic!()
        };
        assert_eq!(given[question], Value::String(label.clone()));
    }
}

#[test]
fn multiple_choices_and_a_written_answer_are_passed_as_given() {
    let mut h = Harness::new("q-multi");
    let cmd = h.fake("question.multi", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask").unwrap();
    let q = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some(q.clone()),
        _ => None,
    });
    assert!(
        q.questions.iter().any(|x| x.multi_select),
        "the fixture has a multi-select question"
    );
    // 직접 쓰기: 라벨이 아닌 글을 한 개 질문에 그대로
    let mut answers = first_option_answers(&q);
    let single = q.questions.iter().find(|x| !x.multi_select).unwrap();
    answers.insert(
        single.question.clone(),
        AnswerValue::One("Purple (my own idea)".into()),
    );
    h.manager
        .respond(&q.request_id, Response::Answer { answers })
        .unwrap();
    h.wait_for("turn end", turn_outcome);

    let given = cmd.control_responses()[0]["response"]["updatedInput"]["answers"].clone();
    assert_eq!(given[&single.question], "Purple (my own idea)");
    let multi = q.questions.iter().find(|x| x.multi_select).unwrap();
    assert_eq!(given[&multi.question].as_array().unwrap().len(), 2);
}

#[test]
fn incomplete_or_foreign_answers_leave_the_question_waiting() {
    let mut h = Harness::new("q-bad");
    let cmd = h.fake("question", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask").unwrap();
    let q = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some(q.clone()),
        _ => None,
    });
    let none = Response::Answer {
        answers: BTreeMap::new(),
    };
    assert_eq!(
        h.manager.respond(&q.request_id, none).unwrap_err().kind(),
        "invalid_input"
    );
    let mut foreign = first_option_answers(&q);
    foreign.insert(
        "a question nobody asked".into(),
        AnswerValue::One("x".into()),
    );
    assert_eq!(
        h.manager
            .respond(&q.request_id, Response::Answer { answers: foreign })
            .unwrap_err()
            .kind(),
        "invalid_input"
    );
    assert_eq!(h.manager.state().pending.len(), 1);
    // 올바른 답은 그 뒤에도 된다
    h.manager
        .respond(
            &q.request_id,
            Response::Answer {
                answers: first_option_answers(&q),
            },
        )
        .unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    assert!(h.manager.state().pending.is_empty());
}

#[test]
fn a_question_can_be_denied() {
    let mut h = Harness::new("q-deny");
    let cmd = h.fake("question.denied", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask").unwrap();
    let q = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some(q.request_id.clone()),
        _ => None,
    });
    h.manager
        .respond(
            &q,
            Response::Deny {
                message: Some("skip it".into()),
            },
        )
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    assert_eq!(cmd.control_responses()[0]["response"]["behavior"], "deny");
}

// ───────────────────────── 중단 · 취소 ─────────────────────────

#[test]
fn interrupting_a_pending_permission_closes_the_card_and_the_next_message_works() {
    let mut h = Harness::new("interrupt");
    let cmd = h.fake("interrupt.pending-permission", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write something").unwrap();
    let id = h.wait_for("permission", permission_id);
    assert_eq!(h.manager.state().pending.len(), 1);

    h.manager.interrupt().unwrap();
    let cancelled = h.wait_for("cancel", |e| match e {
        SessionEvent::RequestCancelled { request_id } => Some(request_id.clone()),
        _ => None,
    });
    assert_eq!(cancelled, id);
    assert_eq!(
        h.wait_for("interrupted", turn_outcome),
        TurnOutcome::Interrupted
    );
    assert!(h.manager.state().pending.is_empty());
    assert!(!h.manager.state().busy);
    // 뒤늦게 답해도 받아 주지 않는다
    assert_eq!(
        h.manager.respond(&id, Response::Allow).unwrap_err().kind(),
        "request_not_found"
    );

    // 프로세스는 살아 있고 다음 메시지를 받는다
    h.manager.send_message("hello again").unwrap();
    assert_eq!(
        h.wait_for("second turn", turn_outcome),
        TurnOutcome::Success
    );
    let sent: Vec<_> = cmd
        .stdin_messages()
        .iter()
        .map(|m| m["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(sent, ["user", "control_request", "user"]);
    assert_eq!(cmd.stdin_messages()[1]["request"]["subtype"], "interrupt");
}

#[test]
fn pending_requests_are_cleaned_up_when_the_session_ends() {
    let mut h = Harness::new("cleanup");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    let id = h.wait_for("permission", permission_id);
    // 질문이 대기 중인 채로 끝낸다
    let stopped = h.manager.stop().unwrap();
    assert!(stopped.was_running);
    let cancelled = h.wait_for("cancel on end", |e| match e {
        SessionEvent::RequestCancelled { request_id } => Some(request_id.clone()),
        _ => None,
    });
    assert_eq!(cancelled, id);
    let SessionEvent::SessionEnded { mid_turn, .. } = h.wait_ended() else {
        unreachable!()
    };
    assert!(mid_turn, "a turn was in progress");
    assert!(h.manager.state().pending.is_empty());
}

// ───────────────────────── 죽음 · 이상한 줄 ─────────────────────────

#[test]
fn dying_before_the_result_is_reported_with_the_exit_code_and_no_turn_end() {
    let mut h = Harness::new("die");
    let cmd = h.fake("start", &["die-before-result"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    let SessionEvent::SessionEnded {
        ended,
        exit_code,
        mid_turn,
        forced,
        ..
    } = h.wait_ended()
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Died);
    assert_eq!(exit_code, Some(1));
    assert!(mid_turn && !forced);
    assert!(!h.kinds().contains(&"turn_ended".to_string()));
    assert!(!h.manager.state().running);
    // 죽은 뒤에는 새로 시작할 수 있다
    let again = h.fake("start", &[]);
    h.start(&again).unwrap();
    h.manager.stop().unwrap();
}

#[test]
fn a_line_cut_in_the_middle_only_reaches_the_raw_log_and_the_session_ends_as_died() {
    let mut h = Harness::new("cut");
    // 4 번째 줄(`result`)을 반만 쓰고 죽는다
    let cmd = h.fake("start", &[]).env("NYANITOR_FAKE_CUT_LINE", "3");
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    let SessionEvent::SessionEnded {
        ended, exit_code, ..
    } = h.wait_ended()
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Died);
    assert_eq!(exit_code, Some(1));
    let kinds = h.kinds();
    assert!(!kinds.contains(&"turn_ended".to_string()), "{kinds:?}");
    let raw: Vec<_> = h
        .manager
        .raw_log()
        .into_iter()
        .filter(|e| e.dir == "recv")
        .collect();
    assert_eq!(raw.len(), 4, "three whole lines and the cut one");
    assert!(serde_json::from_str::<Value>(&raw[3].text).is_err());
}

#[test]
fn unknown_types_and_non_json_lines_do_not_break_the_turn() {
    let mut h = Harness::new("strange");
    let cmd = h.fake("start", &["inject-unknown", "inject-nonjson"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    h.manager.stop().unwrap();
    h.wait_ended();
    let kinds = h.kinds();
    assert_eq!(
        kinds,
        [
            "session_started",
            "user_message",
            "turn_started",
            "text",
            "rate_limit",
            "turn_ended",
            "session_ended"
        ]
    );
    // 모르는 줄은 원본 로그에만 남았다
    let raw = h.manager.raw_log();
    assert!(
        raw.iter()
            .any(|e| e.dir == "recv" && e.text.contains("future_thing"))
    );
    assert!(
        raw.iter()
            .any(|e| e.dir == "recv" && e.text == "this is not json {")
    );
}

#[test]
fn a_very_long_line_comes_through_whole() {
    let mut h = Harness::new("long");
    let cmd = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_LONG_LINE", "3000000");
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    let long = h.wait_for("long text", |e| match e {
        SessionEvent::Text { text } if text.len() > 1_000_000 => Some(text.len()),
        _ => None,
    });
    assert_eq!(long, 3_000_000);
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    // 원본 로그에는 잘린 채로
    let entry = h
        .manager
        .raw_log()
        .into_iter()
        .find(|e| e.original_len > 1_000_000)
        .unwrap();
    assert!(entry.truncated && entry.text.chars().count() < 10_000);
}

#[test]
fn a_version_other_than_the_verified_one_only_warns() {
    let mut h = Harness::new("version");
    let cmd = h.fake("start", &[]).env("NYANITOR_FAKE_VERSION", "2.1.999");
    h.start(&cmd).unwrap();
    let detail = h.wait_for("warning", |e| match e {
        SessionEvent::Warning { code, detail } if code == "cli_version_mismatch" => detail.clone(),
        _ => None,
    });
    assert!(detail.contains("2.1.999") && detail.contains("2.1.296"));
    h.manager.send_message("pong").unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
}

#[test]
fn a_matching_version_gives_no_warning() {
    let mut h = Harness::new("version-ok");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    assert!(!h.kinds().contains(&"warning".to_string()));
}

// ───────────────────────── 이어 하기 ─────────────────────────

#[test]
fn the_session_id_is_saved_per_project_and_used_for_resume() {
    let mut h = Harness::new("resume");
    let first = h.fake("resume.first", &[]);
    h.start(&first).unwrap();
    assert_eq!(
        h.manager
            .last_session(&h.project.display().to_string())
            .unwrap(),
        None
    );
    h.manager.send_message("remember PINEAPPLE").unwrap();
    h.wait_for("turn end", turn_outcome);
    assert_eq!(
        h.manager
            .last_session(&h.project.display().to_string())
            .unwrap()
            .as_deref(),
        Some(SESSION_ID)
    );
    h.manager.stop().unwrap();
    h.wait_ended();
    assert!(!first.argv().contains(&"--resume".to_string()));

    // 앱을 다시 켠 것처럼: 새 관리자가 같은 파일을 읽는다
    let reopened = ResumeStore::open(h.store_path.clone());
    assert_eq!(
        reopened.get(&project_key(&h.project)).as_deref(),
        Some(SESSION_ID)
    );

    let second = h.fake("resume.second", &[]);
    let info = h.start_resume(&second).unwrap();
    assert!(info.resumed);
    assert_eq!(info.resume_session_id.as_deref(), Some(SESSION_ID));
    h.manager.send_message("what did I say?").unwrap();
    assert_eq!(
        h.wait_for("resumed turn", turn_outcome),
        TurnOutcome::Success
    );
    let argv = second.argv();
    let at = argv
        .iter()
        .position(|a| a == "--resume")
        .expect("--resume was passed");
    assert_eq!(argv[at + 1], SESSION_ID);
    h.manager.stop().unwrap();
}

#[test]
fn resuming_without_a_saved_session_is_an_error_and_starts_nothing() {
    let h = Harness::new("resume-none");
    let cmd = h.fake("start", &[]);
    let err = h.start_resume(&cmd).unwrap_err();
    assert_eq!(err.kind(), "no_saved_session");
    assert!(!cmd.log.exists());
    assert!(!h.manager.state().running);
}

#[test]
fn a_session_the_cli_does_not_know_is_announced_so_the_screen_can_offer_a_fresh_start() {
    let mut h = Harness::with_saved_session("resume-missing", SESSION_ID);
    let cmd = h.fake("strange-bad-args.bad-resume", &[]);
    h.start_resume(&cmd).unwrap();
    h.manager.send_message("hello").unwrap();
    // 알림(stderr 줄 · result 두 곳에서 옴)과 턴 끝의 도착 순서는 읽기 스레드 경쟁이라 정해져 있지 않다 (P3-03: 순서를 가정한
    // 앞 판이 가끔 30 초 시간 초과로 실패했다) — 세션이 끝난 뒤 받은 것 전체에서 찾는다.
    let ended_event = h.wait_ended();
    let id = h
        .seen()
        .iter()
        .find_map(|e| match e {
            SessionEvent::ResumeNotFound { session_id } => Some(session_id.clone()),
            _ => None,
        })
        .expect("resume_not_found was announced");
    assert_eq!(id, SESSION_ID);
    assert_eq!(
        h.seen().iter().find_map(turn_outcome),
        Some(TurnOutcome::Error)
    );
    let SessionEvent::SessionEnded {
        ended,
        exit_code,
        stderr_tail,
        ..
    } = ended_event
    else {
        unreachable!()
    };
    assert_eq!(ended, EndKind::Died);
    assert_eq!(exit_code, Some(1));
    assert!(
        stderr_tail
            .iter()
            .any(|l| l.contains("No conversation found"))
    );
    // 한 번만 알린다 (stderr 와 result 두 곳에서 왔어도)
    let announcements = h
        .seen()
        .iter()
        .filter(|e| matches!(e, SessionEvent::ResumeNotFound { .. }))
        .count();
    assert_eq!(announcements, 1);
    // 이어 하기로 못 열었으니 새 세션으로 시작할 수 있다 (저장된 옛 ID 는 새 세션이 열리면 덮인다)
    let fresh = h.fake("start", &[]);
    h.start(&fresh).unwrap();
    assert!(!fresh.argv().contains(&"--resume".to_string()));
    h.manager.send_message("pong").unwrap();
    h.wait_for("fresh turn", turn_outcome);
    h.manager.stop().unwrap();
}

// ───────────────────────── 환경 ─────────────────────────

fn env_names(path: &std::path::Path) -> Vec<String> {
    wait_for_file(path, WAIT)
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn the_child_never_gets_the_parent_only_variables_or_the_api_key() {
    let h = Harness::new("env");
    let dump = h.root.join("env.txt");
    // 부모 환경이 이런 모양일 때 (Claude Code 안에서 앱을 돌린 경우 + 사용자가 키를 둔 경우)
    let mut base: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().collect();
    for (k, v) in [
        ("CLAUDECODE", "1"),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("CLAUDE_CODE_SESSION_ID", "abc"),
        ("CLAUDE_CODE_MESSAGING_TOKEN", "secret-token"),
        ("CLAUDE_CODE_QUESTION_PREVIEW_FORMAT", "markdown"),
        ("CLAUDE_AGENT_SDK_VERSION", "1"),
        ("CLAUDE_PID", "42"),
        ("MCP_CONNECTION_NONBLOCKING", "1"),
        ("ANTHROPIC_API_KEY", "sk-ant-fake-key"),
        ("CLAUDE_CODE_USE_BEDROCK", "1"),
        ("ANTHROPIC_BASE_URL", "http://proxy.example"),
    ] {
        base.retain(|(name, _)| !name.eq_ignore_ascii_case(k));
        base.push((k.into(), v.into()));
    }
    let command = nyanitor_lib::claude::exec::ClaudeCommand::new(fake_exe())
        .with_base_env(base)
        .with_extra_env("NYANITOR_FAKE_REPLAY", "start")
        .with_extra_env("NYANITOR_FAKE_ENV_DUMP", dump.clone());
    h.manager.start(h.request(), command.clone()).unwrap();
    let names = env_names(&dump);
    for gone in [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
        "CLAUDE_AGENT_SDK_VERSION",
        "CLAUDE_PID",
        "MCP_CONNECTION_NONBLOCKING",
        "ANTHROPIC_API_KEY",
    ] {
        assert!(
            !names.iter().any(|n| n.eq_ignore_ascii_case(gone)),
            "{gone} leaked: {names:?}"
        );
    }
    // 사용자가 일부러 정한 것은 그대로
    assert!(names.iter().any(|n| n == "CLAUDE_CODE_USE_BEDROCK"));
    assert!(names.iter().any(|n| n == "ANTHROPIC_BASE_URL"));
    h.manager.stop().unwrap();
}

#[test]
fn asking_for_the_key_passes_it_through_and_warns() {
    let mut h = Harness::new("env-key");
    let dump = h.root.join("env.txt");
    let mut base: Vec<(std::ffi::OsString, std::ffi::OsString)> = std::env::vars_os().collect();
    base.push(("ANTHROPIC_API_KEY".into(), "sk-ant-fake-key".into()));
    let command = nyanitor_lib::claude::exec::ClaudeCommand::new(fake_exe())
        .with_base_env(base)
        .with_extra_env("NYANITOR_FAKE_REPLAY", "start")
        .with_extra_env("NYANITOR_FAKE_ENV_DUMP", dump.clone());
    let mut request = h.request();
    request.use_api_key = true;
    h.manager.start(request, command).unwrap();
    assert!(env_names(&dump).iter().any(|n| n == "ANTHROPIC_API_KEY"));
    // 이 PC 환경에는 키가 없으면 경고는 없다 (경고는 실제 환경에 키가 있을 때만)
    let _ = &mut h;
    h.manager.stop().unwrap();
}

#[test]
fn the_real_environment_never_leaks_parent_only_names_either() {
    let h = Harness::new("env-real");
    let dump = h.root.join("env.txt");
    let cmd = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_ENV_DUMP", dump.clone());
    h.start(&cmd).unwrap();
    let names = env_names(&dump);
    // 이 시험이 Claude Code 안에서 돌아도 (CLAUDECODE 가 있어도) 자식은 못 받는다
    for n in &names {
        let up = n.to_ascii_uppercase();
        assert!(
            up != "CLAUDECODE"
                && up != "ANTHROPIC_API_KEY"
                && !up.starts_with("CLAUDE_AGENT_SDK_")
                && up != "CLAUDE_PID",
            "{n}"
        );
    }
    h.manager.stop().unwrap();
}

// ───────────────────────── 끝내기 · 프로세스 트리 ─────────────────────────

#[test]
fn stop_kills_a_cli_that_ignores_stdin_close_and_everything_under_it() {
    let mut h = Harness::new("force");
    let pidfile = h.root.join("child.pid");
    let cmd = h
        .fake("start", &["hang-on-eof"])
        .env("NYANITOR_FAKE_CHILD_PIDFILE", pidfile.clone());
    let info = h.start(&cmd).unwrap();
    let child_pid: u32 = wait_for_file(&pidfile, WAIT).trim().parse().unwrap();
    assert!(pid_alive(child_pid) && pid_alive(info.pid));

    h.manager.send_message("pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    let started = Instant::now();
    let stopped = h.manager.stop().unwrap();
    assert!(
        stopped.was_running && stopped.forced,
        "stdin close alone did not end it"
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    let SessionEvent::SessionEnded { forced, ended, .. } = h.wait_ended() else {
        unreachable!()
    };
    assert!(forced);
    assert_eq!(ended, EndKind::Normal, "we asked it to stop");
    assert!(
        wait_dead(info.pid, Duration::from_secs(5)),
        "claude is gone"
    );
    assert!(
        wait_dead(child_pid, Duration::from_secs(5)),
        "the process under claude is gone too"
    );
}

#[test]
fn a_child_holding_stdout_open_does_not_keep_the_session_from_ending() {
    let mut h = Harness::new("grandchild");
    let pidfile = h.root.join("child.pid");
    let cmd = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_CHILD_PIDFILE", pidfile.clone());
    let info = h.start(&cmd).unwrap();
    let child_pid: u32 = wait_for_file(&pidfile, WAIT).trim().parse().unwrap();
    h.manager.send_message("pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    let started = Instant::now();
    let stopped = h.manager.stop().unwrap();
    assert!(!stopped.forced, "the CLI exits by itself when stdin closes");
    h.wait_ended();
    // 손자가 stdout 을 쥐고 있어도 몇 초 안에 끝났다 (EOF 가 아니라 종료 신호로 판단)
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "{:?}",
        started.elapsed()
    );
    assert!(wait_dead(info.pid, Duration::from_secs(5)));
    assert!(
        wait_dead(child_pid, Duration::from_secs(5)),
        "left-over processes are cleaned up"
    );
}

#[cfg(windows)]
#[test]
fn closing_the_job_handle_kills_the_whole_tree_like_an_app_crash_would() {
    use nyanitor_lib::claude::process_tree::ProcessTree;
    use std::process::Stdio;

    let root = unique_dir("job");
    let pidfile = root.join("child.pid");
    let command = nyanitor_lib::claude::exec::ClaudeCommand::new(fake_exe())
        .with_extra_env("NYANITOR_FAKE_REPLAY", "start")
        .with_extra_env("NYANITOR_FAKE_CHILD_PIDFILE", pidfile.clone());
    let mut process = command.command(Vec::<&str>::new());
    process
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = process.spawn().unwrap();
    let tree = ProcessTree::attach(&child);
    assert!(tree.is_job(), "the child was put in a job object");
    let child_pid: u32 = wait_for_file(&pidfile, WAIT).trim().parse().unwrap();
    assert!(pid_alive(child.id()) && pid_alive(child_pid));

    // 앱이 죽으면 OS 가 핸들을 닫는다 — 같은 일을 핸들 버리기로 흉내 낸다
    drop(tree);
    assert!(wait_dead(child.id(), Duration::from_secs(5)));
    assert!(wait_dead(child_pid, Duration::from_secs(5)));
    let _ = child.wait();
    let _ = fs::remove_dir_all(root);
}

// ───────────────────────── 느린 재생 ─────────────────────────

#[test]
fn a_slow_replay_delivers_events_one_by_one_in_order() {
    let mut h = Harness::new("slow");
    let cmd = h.fake("start", &[]).env("NYANITOR_FAKE_DELAY_MS", "120");
    h.start(&cmd).unwrap();
    let t0 = Instant::now();
    h.manager.send_message("pong").unwrap();
    h.wait_for("turn started", |e| {
        matches!(e, SessionEvent::TurnStarted { .. }).then_some(())
    });
    let first_at = t0.elapsed();
    h.wait_for("turn end", turn_outcome);
    assert!(
        t0.elapsed() - first_at >= Duration::from_millis(240),
        "events were spread out"
    );
    let kinds = h.kinds();
    let order: Vec<_> = kinds
        .iter()
        .filter(|k| ["turn_started", "text", "rate_limit", "turn_ended"].contains(&k.as_str()))
        .collect();
    assert_eq!(order, ["turn_started", "text", "rate_limit", "turn_ended"]);
}

// ───────────────────────── 비용 · 사용량 ─────────────────────────

#[test]
fn two_turns_report_the_cost_difference_not_the_running_total() {
    let mut h = Harness::new("cost");
    let cmd = h.fake("two-turns", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("first").unwrap();
    let first = h.wait_for("first end", |e| match e {
        SessionEvent::TurnEnded(t) => Some(t.clone()),
        _ => None,
    });
    h.manager.send_message("second").unwrap();
    let second = h.wait_for("second end", |e| match e {
        SessionEvent::TurnEnded(t) => Some(t.clone()),
        _ => None,
    });
    assert_eq!(first.cost_usd, first.total_cost_usd);
    assert!(second.total_cost_usd > first.total_cost_usd);
    assert!((second.cost_usd - (second.total_cost_usd - first.total_cost_usd)).abs() < 1e-9);
    assert!(second.usage.output_tokens > 0);
}

// ───────────────────────── 녹화본 전부 ─────────────────────────

#[test]
fn every_recording_replays_to_the_end_without_hanging_or_dropping_a_result() {
    let mut names: Vec<String> = fs::read_dir(fixtures_dir())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .map(|p| p.file_stem().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert!(names.len() >= 30);

    for name in names {
        let text = fs::read_to_string(fixtures_dir().join(format!("{name}.jsonl"))).unwrap();
        let records: Vec<Value> = text
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let results = records
            .iter()
            .filter(|r| r["dir"] == "recv" && r["msg"]["type"] == "result")
            .count();
        let asks = records
            .iter()
            .filter(|r| {
                r["dir"] == "recv"
                    && r["msg"]["type"] == "control_request"
                    && r["msg"]["request"]["subtype"] == "can_use_tool"
            })
            .count();
        let exit_code = records
            .iter()
            .find(|r| r["dir"] == "exit")
            .and_then(|r| r["code"].as_i64());

        let mut h = Harness::new("free");
        let cmd = h.fake(&name, &["free", "mark-done"]);
        h.start(&cmd).unwrap_or_else(|e| panic!("{name}: {e}"));
        // 재생이 끝날 때까지 (끝 표시 stderr 줄 또는 스스로 죽음)
        let ended_by_itself = exit_code.is_some_and(|c| c != 0);
        if !ended_by_itself {
            h.wait_for(&format!("{name}: replay complete"), |e| match e {
                SessionEvent::RawLog(r)
                    if r.dir == "stderr" && r.text.contains("replay complete") =>
                {
                    Some(())
                }
                _ => None,
            });
            h.manager.stop().unwrap();
        }
        let SessionEvent::SessionEnded {
            exit_code: code, ..
        } = h.wait_ended()
        else {
            unreachable!()
        };
        if ended_by_itself {
            assert_eq!(code.map(i64::from), exit_code, "{name}");
        }
        let seen = h.seen().to_vec();
        let turn_ends = seen
            .iter()
            .filter(|e| matches!(e, SessionEvent::TurnEnded(_)))
            .count();
        let requests = seen
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    SessionEvent::PermissionRequest(_) | SessionEvent::QuestionRequest(_)
                )
            })
            .count();
        assert_eq!(turn_ends, results, "{name}: turn_ended count");
        // 질문 · 권한 요청은 전부 카드가 된다 (읽을 수 없는 질문은 없다)
        assert_eq!(requests, asks, "{name}: request cards");
        // 대기 중이던 것은 끝날 때 모두 정리됐다
        assert!(h.manager.state().pending.is_empty(), "{name}");
    }
}

// ───────────────────────── 원본 로그 · 쓰기 ─────────────────────────

#[test]
fn raw_log_records_what_was_sent_and_received_and_stderr() {
    let mut h = Harness::with_saved_session("rawlog", SESSION_ID);
    let cmd = h.fake("strange-bad-args.bad-resume", &[]);
    h.start_resume(&cmd).unwrap();
    h.manager.send_message("hello").unwrap();
    h.wait_ended();
    let raw = h.manager.raw_log();
    assert!(
        raw.iter()
            .any(|e| e.dir == "send" && e.text.contains("\"hello\""))
    );
    assert!(
        raw.iter()
            .any(|e| e.dir == "recv" && e.text.contains("\"type\":\"result\""))
    );
    assert!(
        raw.iter()
            .any(|e| e.dir == "stderr" && e.text.contains("No conversation found"))
    );
    assert!(raw.windows(2).all(|w| w[0].seq < w[1].seq));
}

// ───────────────────────── P3-05: 항상 허용 범위 · 정리 · 순서 · npm 쉼 ─────────────────────────

#[test]
fn always_allow_for_a_top_level_file_sends_a_rule_for_that_one_file_never_the_whole_project() {
    let mut h = Harness::new("always-top-file");
    // `permission-allow` 의 Write 는 프로젝트 맨 위 `hello.txt` — 가짜 CLI 가 작업 폴더를 이 프로젝트 폴더로 바꿔 준다
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write hello.txt").unwrap();
    let info = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    });
    let rule = info.always_rule.as_ref().expect("a one-file rule");
    assert_eq!(rule.rule, "Edit(/hello.txt)");
    assert_eq!(
        serde_json::to_value(rule.scope).unwrap(),
        json!("file"),
        "the scope the card shows"
    );
    h.manager
        .respond(&info.request_id, Response::AlwaysAllow)
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    let body = &cmd.control_responses()[0]["response"];
    assert_eq!(
        body["updatedPermissions"][0]["rules"],
        json!([{ "toolName": "Edit", "ruleContent": "/hello.txt" }])
    );
    let sent = serde_json::to_string(&cmd.control_responses()).unwrap();
    assert!(
        !sent.contains("\"/*\"") && !sent.contains("\"/**\""),
        "{sent}"
    );
}

#[test]
fn the_card_input_is_cut_for_display_but_allow_returns_the_whole_original_to_the_cli() {
    let mut h = Harness::new("big-input");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    let info = h.wait_for("permission", |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    });
    // 녹화본의 입력은 짧아 잘리지 않는다 — 카드 입력이 CLI 가 준 것과 같다 (키 · 값 그대로)
    assert!(
        info.input["file_path"]
            .as_str()
            .unwrap()
            .ends_with("hello.txt")
    );
    h.manager
        .respond(&info.request_id, Response::Allow)
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    let sent = &cmd.control_responses()[0]["response"];
    assert_eq!(sent["updatedInput"]["file_path"], info.input["file_path"]);
}

#[test]
fn busy_stays_up_between_the_interrupted_turn_and_the_deferred_message() {
    let mut h = Harness::new("tell-busy");
    let cmd = h.fake("permission-deny.interrupt", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write draft.txt").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager
        .respond(
            &id,
            Response::Tell {
                text: "use notes.txt instead".into(),
            },
        )
        .unwrap();
    assert_eq!(
        h.wait_for("interrupted", turn_outcome),
        TurnOutcome::Interrupted
    );
    // 미룬 말이 있어서 이 턴이 끝난 뒤에도 곧 이어 보낸다 — 그 사이 다른 메시지가 끼어들면 안 된다
    assert!(h.manager.state().busy, "busy must not drop in between");
    assert_eq!(
        h.manager.send_message("an intruder").unwrap_err().kind(),
        "turn_in_progress"
    );
    h.wait_for("deferred message", |e| match e {
        SessionEvent::UserMessage { deferred: true, .. } => Some(()),
        _ => None,
    });
    assert!(h.manager.state().busy);
    let second = h.wait_for("second permission", permission_id);
    h.manager.respond(&second, Response::Allow).unwrap();
    assert_eq!(h.wait_for("final", turn_outcome), TurnOutcome::Success);
    assert!(!h.manager.state().busy);
}

#[test]
fn state_and_other_calls_do_not_wait_for_a_slow_version_check_during_start() {
    let h = Harness::new("start-not-locking");
    let slow = h
        .fake("start", &[])
        .env("NYANITOR_FAKE_VERSION_DELAY_MS", "1500");
    let (manager, request, command) = (h.manager.clone(), h.request(), slow.command.clone());
    let starting = std::thread::spawn(move || manager.start(request, command));
    std::thread::sleep(Duration::from_millis(300));

    // 시작이 `--version` 을 기다리는 동안에도 상태 조회 · 로그 · 끝내기가 바로 돌아온다
    let began = Instant::now();
    assert!(!h.manager.state().running);
    assert!(h.manager.raw_log().is_empty());
    assert_eq!(
        h.manager.send_message("x").unwrap_err().kind(),
        "no_session"
    );
    assert!(
        began.elapsed() < Duration::from_millis(1000),
        "state() waited for the version check: {:?}",
        began.elapsed()
    );
    // 끝내기가 들어오면 이 시작은 프로세스를 띄우지 않고 물러난다
    let stopped = Instant::now();
    assert!(!h.manager.stop().unwrap().was_running);
    assert!(
        stopped.elapsed() < Duration::from_millis(1000),
        "stop() waited for the version check"
    );
    let result = starting.join().unwrap();
    assert!(result.is_err(), "the cancelled start must not launch");
    assert!(slow.argv().is_empty(), "no session process was launched");
    assert!(!h.manager.state().running);
    // 취소가 다음 시작에 남지 않는다
    let again = h.fake("start", &[]);
    h.start(&again).unwrap();
    h.manager.stop().unwrap();
}

#[cfg(windows)]
mod npm_shim {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    struct Planted(PathBuf);
    impl Drop for Planted {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    /// 이 프로세스의 환경에서 현재 폴더 탐색을 끄는 변수를 뺀 것 — 이미 켜져 있는 PC(개발 도구 셸 등)에서도 앱의 보호가 실제로 일하는지 보려고.
    fn env_without_the_guard() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
        std::env::vars_os()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("NoDefaultCurrentDirectoryInExePath"))
            .collect()
    }

    /// `claude.cmd`: 쉼이 `node` 를 이름만으로 부르는 것처럼 다른 스크립트를 이름만으로 부른다.
    fn shim(dir: &Path, planted_name: &str) -> PathBuf {
        let shim = dir.join("claude.cmd");
        fs::write(
            &shim,
            format!("@echo off\r\ncall {planted_name}\r\necho 2.1.296 (Claude Code)\r\n"),
        )
        .unwrap();
        shim
    }

    fn plant(folder: &Path, name: &str, marker: &Path) -> Planted {
        let file = folder.join(format!("{name}.cmd"));
        fs::write(
            &file,
            format!("@echo off\r\necho hit>> \"{}\"\r\n", marker.display()),
        )
        .unwrap();
        Planted(file)
    }

    #[test]
    fn a_planted_script_in_the_project_folder_is_not_run_by_a_cmd_shim_session() {
        let mut h = Harness::new("shim-session");
        let marker = h.root.join("hit-session.txt");
        let name = format!("nyanitor-planted-{}", std::process::id());
        let _planted = plant(&h.project, &name, &marker);
        let shim = shim(&h.root, &name);

        // 대조: 보호 없이 프로젝트 폴더에서 같은 쉼을 돌리면 심어 둔 것이 실제로 불린다 (이 시험이 의미가 있는지)
        let control = Command::new("cmd.exe")
            .arg("/C")
            .arg(&shim)
            .current_dir(&h.project)
            .env_remove("NoDefaultCurrentDirectoryInExePath")
            .output()
            .unwrap();
        assert!(control.status.success());
        assert!(
            marker.exists(),
            "control: the planted script should run without the guard"
        );
        fs::remove_file(&marker).unwrap();

        // 앱이 띄운 세션은 현재 폴더(프로젝트 폴더)를 보지 않는다
        let command = ClaudeCommand::new(&shim).with_base_env(env_without_the_guard());
        h.manager.start(h.request(), command).unwrap();
        h.wait_ended();
        assert!(!marker.exists(), "the planted script ran in the session");
    }

    #[test]
    fn the_version_check_and_auth_status_do_not_run_a_script_planted_in_the_temp_folder() {
        let root = unique_dir("shim-capture");
        let marker = root.join("hit-capture.txt");
        let name = format!("nyanitor-planted-cap-{}", std::process::id());
        // `run_capture` 의 작업 폴더는 OS 임시 폴더다
        let _planted = plant(&std::env::temp_dir(), &name, &marker);
        let shim = shim(&root, &name);

        let control = Command::new("cmd.exe")
            .arg("/C")
            .arg(&shim)
            .current_dir(std::env::temp_dir())
            .env_remove("NoDefaultCurrentDirectoryInExePath")
            .output()
            .unwrap();
        assert!(control.status.success());
        assert!(marker.exists(), "control: the planted script should run");
        fs::remove_file(&marker).unwrap();

        let command = ClaudeCommand::new(&shim).with_base_env(env_without_the_guard());
        let out = command
            .run_capture(["--version"], Duration::from_secs(20))
            .unwrap();
        assert!(out.stdout.contains("2.1.296"), "{out:?}");
        let out = command
            .run_capture(["auth", "status", "--json"], Duration::from_secs(20))
            .unwrap();
        assert!(!out.timed_out);
        assert!(!marker.exists(), "the planted script ran in a capture");
        let _ = fs::remove_dir_all(root);
    }
}
