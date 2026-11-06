//! 채팅 기록 · 세션 츄르 시험 (P6-03) — 진짜 세션 관리자 + 가짜 CLI(`examples/fake_claude.rs`)로 대화한 뒤 기록을 읽는다. 실제 `claude` 는 쓰지 않는다.
//!
//! 보는 것: 같은 항목이 같은 순서로 나온다 · 답한 카드는 답과 함께, 답 못 한 카드는 지나감 · 쓰기가 세션 이벤트를 늦추지 않는다 · 앱을 끌 때 남은 것을 쓴다 ·
//! DB 를 못 써도 세션은 뜬다 · 츄르 합이 턴들의 합과 맞다 · 프로젝트를 빼면 기록도 지워진다.

mod common;

use std::collections::BTreeMap;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::events::{
    AnswerValue, QuestionRequestInfo, Response, SessionEvent, TokenUsage, TurnOutcome,
};
use nyanitor_lib::claude::session::SessionManager;
use nyanitor_lib::db::{AppDb, DB_FILE};
use nyanitor_lib::history::chat::RequestStatus;
use nyanitor_lib::history::usage;
use nyanitor_lib::history::{self, ChatPage};
use nyanitor_lib::projects::{self, ProjectsState};
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

fn read(h: &Harness, before: Option<i64>, limit: u32) -> ChatPage {
    history::chat_history(&h.db, &h.manager, 1, before, limit).expect("read the chat history")
}

fn types(page: &ChatPage) -> Vec<String> {
    page.entries
        .iter()
        .map(|e| e.event["type"].as_str().unwrap().to_string())
        .collect()
}

/// 화면이 실시간으로 받은 이벤트 가운데 기록이 다시 그릴 것 (답 · 취소는 카드에 합쳐지므로 뺀다) 의 종류들
fn live_types(h: &mut Harness) -> Vec<String> {
    h.seen()
        .iter()
        .filter(|e| history::record::wants(e))
        .filter(|e| {
            !matches!(
                e,
                SessionEvent::RequestAnswered { .. } | SessionEvent::RequestCancelled { .. }
            )
        })
        .map(kind_of)
        .collect()
}

fn first_option_answers(q: &QuestionRequestInfo) -> BTreeMap<String, AnswerValue> {
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

// ───────────────────────── 읽기 · 순서 ─────────────────────────

#[test]
fn a_plain_conversation_comes_back_in_the_same_order_after_the_session_ends() {
    let mut h = Harness::new("hist-plain");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("say pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();

    let page = read(&h, None, 100);
    assert!(!page.has_more);
    assert_eq!(
        types(&page),
        [
            "session_started",
            "user_message",
            "text",
            "turn_ended",
            "session_ended"
        ]
    );
    assert_eq!(
        types(&page),
        live_types(&mut h),
        "화면이 받은 것과 같은 순서"
    );
    assert_eq!(page.entries[1].event["text"], "say pong");
    assert_eq!(page.entries[2].event["text"], "pong");
    // 성공한 턴의 최종 글은 `text` 로 이미 있으니 뺀다. 결과 · 사용량은 남는다
    assert_eq!(page.entries[3].event["result"], Value::Null);
    assert_eq!(page.entries[3].event["outcome"], "success");
    assert!(
        page.entries[3].event["usage"]["outputTokens"]
            .as_u64()
            .unwrap()
            > 0
    );
    // 순서 번호는 늘기만 하고, 모두 같은 세션 ID 를 달았다 (첫 턴 전의 항목도 나중에 채워졌다)
    assert!(page.entries.windows(2).all(|w| w[0].id < w[1].id));
    assert!(page.entries.iter().all(|e| e.session_id.is_some()));
    assert!(page.entries.iter().all(|e| e.request.is_none()));
    assert!(page.entries.iter().all(|e| !e.truncated));
    // 성공한 도구 결과 · 한도 `allowed` · 알림은 저장하지 않는다
    assert!(!types(&page).iter().any(|t| {
        [
            "tool_result",
            "rate_limit",
            "warning",
            "turn_started",
            "raw_log",
        ]
        .contains(&t.as_str())
    }));
}

#[test]
fn the_history_survives_an_app_restart() {
    let mut h = Harness::new("hist-restart");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("say pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let before = types(&read(&h, None, 100));

    // 앱을 다시 켠 것처럼: DB 를 새로 열고 새 관리자로 읽는다
    let reopened = AppDb::open(&h.root.join("data").join(DB_FILE));
    let (tx, _rx) = mpsc::channel();
    struct Quiet(Mutex<mpsc::Sender<SessionEvent>>);
    impl nyanitor_lib::claude::session::EventSink for Quiet {
        fn emit(&self, event: SessionEvent) {
            let _ = self.0.lock().unwrap().send(event);
        }
    }
    let manager = SessionManager::new(
        Arc::new(Quiet(Mutex::new(tx))),
        reopened.clone(),
        fast_config(),
    );
    let page = history::chat_history(&reopened, &manager, 1, None, 100).unwrap();
    assert_eq!(types(&page), before);
    manager.shutdown();
}

#[test]
fn pages_come_newest_first_and_join_into_the_whole_conversation() {
    let mut h = Harness::new("hist-pages");
    let cmd = h.fake("two-turns", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("one").unwrap();
    h.wait_for("first turn", turn_outcome);
    h.manager.send_message("two").unwrap();
    h.wait_for("second turn", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();

    let whole = read(&h, None, 100);
    assert!(whole.entries.len() >= 7, "{:?}", types(&whole));
    // 3개씩 위로 올라가며 읽는다
    let mut collected: Vec<i64> = Vec::new();
    let mut before = None;
    loop {
        let page = read(&h, before, 3);
        assert!(page.entries.len() <= 3);
        // 쪽 안은 오래된 것이 앞
        assert!(page.entries.windows(2).all(|w| w[0].id < w[1].id));
        let mut ids: Vec<i64> = page.entries.iter().map(|e| e.id).collect();
        ids.extend(collected);
        collected = ids;
        before = page.entries.first().map(|e| e.id);
        if !page.has_more {
            break;
        }
    }
    let whole_ids: Vec<i64> = whole.entries.iter().map(|e| e.id).collect();
    assert_eq!(
        collected, whole_ids,
        "쪽을 이으면 전체와 같다 (빠지거나 겹치지 않는다)"
    );
    // 맨 앞보다 앞은 비었다
    let none = read(&h, before, 3);
    assert!(none.entries.is_empty() && !none.has_more);
}

#[test]
fn asking_for_an_unregistered_project_or_a_zero_limit_is_refused() {
    let h = Harness::new("hist-refuse");
    assert_eq!(
        history::chat_history(&h.db, &h.manager, 99, None, 10)
            .unwrap_err()
            .kind(),
        "project_not_found"
    );
    assert_eq!(
        history::chat_history(&h.db, &h.manager, 1, None, 0)
            .unwrap_err()
            .kind(),
        "invalid_input"
    );
    // 너무 큰 쪽은 줄여 준다 (오류가 아니다)
    assert!(history::chat_history(&h.db, &h.manager, 1, None, u32::MAX).is_ok());
    // 비어 있는 프로젝트
    let page = history::chat_history(&h.db, &h.manager, 1, None, 10).unwrap();
    assert!(page.entries.is_empty() && !page.has_more);
}

// ───────────────────────── 카드 · 사용자의 답 ─────────────────────────

#[test]
fn an_allowed_card_comes_back_answered_and_the_answer_event_reaches_the_screen_too() {
    let mut h = Harness::new("hist-allow");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write hello.txt").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager.respond(&id, Response::Allow).unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();

    // 화면은 답 이벤트를 요청 바로 다음에 받는다
    let live: Vec<String> = h
        .kinds()
        .into_iter()
        .filter(|k| k == "permission_request" || k == "request_answered")
        .collect();
    assert_eq!(live, ["permission_request", "request_answered"]);
    let answered = h
        .seen()
        .iter()
        .find_map(|e| match e {
            SessionEvent::RequestAnswered {
                request_id, kind, ..
            } => Some((request_id.clone(), *kind)),
            _ => None,
        })
        .unwrap();
    assert_eq!(answered.0, id);

    let page = read(&h, None, 100);
    assert_eq!(types(&page), live_types(&mut h));
    let cards: Vec<_> = page
        .entries
        .iter()
        .filter(|e| e.request.is_some())
        .collect();
    assert_eq!(
        cards.len(),
        1,
        "답은 목록에 따로 나오지 않고 카드에 합쳐진다"
    );
    assert_eq!(cards[0].event["requestId"], id);
    assert_eq!(cards[0].event["tool"], "Write");
    let state = cards[0].request.clone().unwrap();
    assert_eq!(state.status, RequestStatus::Answered);
    let answer = state.answer.unwrap();
    assert_eq!(answer["type"], "request_answered");
    assert_eq!(answer["kind"], "allow");
    assert_eq!(answer["requestId"], id);
}

#[test]
fn a_question_card_keeps_the_chosen_answers() {
    let mut h = Harness::new("hist-question");
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
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();

    let page = read(&h, None, 100);
    let card = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "question_request")
        .unwrap();
    assert_eq!(
        card.event["questions"].as_array().unwrap().len(),
        q.questions.len()
    );
    let state = card.request.clone().unwrap();
    assert_eq!(state.status, RequestStatus::Answered);
    let answer = state.answer.unwrap();
    assert_eq!(answer["kind"], "answer");
    // 고른 답이 질문 문장을 열쇠로 그대로 남는다 (하나 · 여러 개)
    for (question, value) in &answers {
        let expected = match value {
            AnswerValue::One(label) => json!(label),
            AnswerValue::Many(labels) => json!(labels),
        };
        assert_eq!(answer["answers"][question], expected);
    }
}

#[test]
fn a_denial_keeps_its_message_and_telling_it_otherwise_keeps_the_words_and_the_following_message() {
    let mut h = Harness::new("hist-deny");
    let cmd = h.fake("permission-deny", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write draft").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager
        .respond(
            &id,
            Response::Deny {
                message: Some("  not that file  ".into()),
            },
        )
        .unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let card = page.entries.iter().find(|e| e.request.is_some()).unwrap();
    let answer = card.request.clone().unwrap().answer.unwrap();
    assert_eq!(answer["kind"], "deny");
    assert_eq!(
        answer["text"], "not that file",
        "다듬은 글 — CLI 로 간 것과 같다"
    );

    // 다르게 말하기: 답 + 거부된 턴의 중단 + 그 말이 새 사용자 메시지로
    let mut h = Harness::new("hist-tell");
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
    let second = h.wait_for("second permission", permission_id);
    h.manager.respond(&second, Response::Allow).unwrap();
    assert_eq!(h.wait_for("final", turn_outcome), TurnOutcome::Success);
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    assert_eq!(types(&page), live_types(&mut h));
    let told = page
        .entries
        .iter()
        .find(|e| {
            e.request
                .as_ref()
                .and_then(|r| r.answer.as_ref())
                .is_some_and(|a| a["kind"] == "tell")
        })
        .expect("the tell answer");
    assert_eq!(
        told.request.clone().unwrap().answer.unwrap()["text"],
        "use notes.txt instead"
    );
    let order = types(&page);
    let interrupted = order.iter().position(|t| t == "turn_ended").unwrap();
    let words = page
        .entries
        .iter()
        .position(|e| e.event["type"] == "user_message" && e.event["deferred"] == true)
        .expect("the words went out as a new message");
    assert!(words > interrupted, "중단된 턴이 끝난 뒤에 그 말이 간다");
    assert_eq!(page.entries[words].event["text"], "use notes.txt instead");
}

#[test]
fn a_waiting_card_is_pending_to_the_live_session_expired_to_a_restarted_app_and_cancelled_once_closed()
 {
    let mut h = Harness::new("hist-expire");
    let cmd = h.fake("interrupt.pending-permission", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write something").unwrap();
    let id = h.wait_for("permission", permission_id);

    // 살아 있는 세션이 기다리는 중 — 카드에 답할 수 있다
    let page = read(&h, None, 100);
    let card = page.entries.iter().find(|e| e.request.is_some()).unwrap();
    assert_eq!(card.request.clone().unwrap().status, RequestStatus::Pending);

    // 앱을 다시 켠 것처럼 세션을 모르는 새 관리자로 읽으면 같은 카드는 지나간 것이다
    let other_db = AppDb::open(&h.root.join("data").join(DB_FILE));
    let (tx, _rx) = mpsc::channel();
    struct Quiet(Mutex<mpsc::Sender<SessionEvent>>);
    impl nyanitor_lib::claude::session::EventSink for Quiet {
        fn emit(&self, event: SessionEvent) {
            let _ = self.0.lock().unwrap().send(event);
        }
    }
    let restarted = SessionManager::new(
        Arc::new(Quiet(Mutex::new(tx))),
        other_db.clone(),
        fast_config(),
    );
    let page = history::chat_history(&other_db, &restarted, 1, None, 100).unwrap();
    let card = page.entries.iter().find(|e| e.request.is_some()).unwrap();
    assert_eq!(card.request.clone().unwrap().status, RequestStatus::Expired);
    assert_eq!(card.request.clone().unwrap().answer, None);
    restarted.shutdown();
    drop(other_db);

    // 중단하면 카드는 취소됨
    h.manager.interrupt().unwrap();
    h.wait_for("cancelled", |e| {
        matches!(e, SessionEvent::RequestCancelled { request_id } if *request_id == id)
            .then_some(())
    });
    let page = read(&h, None, 100);
    let card = page.entries.iter().find(|e| e.request.is_some()).unwrap();
    assert_eq!(
        card.request.clone().unwrap().status,
        RequestStatus::Cancelled
    );
    assert!(
        !types(&page).contains(&"request_cancelled".to_string()),
        "취소도 목록에 따로 나오지 않는다"
    );
    h.manager.stop().unwrap();
}

#[test]
fn a_card_still_waiting_when_the_session_ends_is_closed_in_the_history() {
    let mut h = Harness::new("hist-end-cards");
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write").unwrap();
    h.wait_for("permission", permission_id);
    // 답하지 않고 끝낸다 — 끝 알림 앞에서 카드가 취소된다
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let card = page.entries.iter().find(|e| e.request.is_some()).unwrap();
    assert_eq!(
        card.request.clone().unwrap().status,
        RequestStatus::Cancelled
    );
    assert_eq!(page.entries.last().unwrap().event["type"], "session_ended");
}

// ───────────────────────── 이어 하기 · 세션 ID ─────────────────────────

#[test]
fn a_resumed_run_is_recorded_after_the_first_with_its_own_start() {
    let mut h = Harness::new("hist-resume");
    let first = h.fake("resume.first", &[]);
    h.start(&first).unwrap();
    h.manager.send_message("remember PINEAPPLE").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let second = h.fake("resume.second", &[]);
    h.start_resume(&second).unwrap();
    h.manager.send_message("what did I say?").unwrap();
    h.wait_for("resumed turn", turn_outcome);
    h.manager.stop().unwrap();

    let page = read(&h, None, 100);
    let starts: Vec<&Value> = page
        .entries
        .iter()
        .filter(|e| e.event["type"] == "session_started")
        .map(|e| &e.event)
        .collect();
    assert_eq!(starts.len(), 2);
    assert_eq!(starts[0]["resumed"], false);
    assert_eq!(starts[1]["resumed"], true);
    assert_eq!(starts[1]["resumeSessionId"], SESSION_ID);
    assert!(
        page.entries
            .iter()
            .all(|e| e.session_id.as_deref() == Some(SESSION_ID))
    );
    assert_eq!(
        h.manager.last_session(1).unwrap().as_deref(),
        Some(SESSION_ID)
    );
}

#[test]
fn a_missing_resume_target_is_recorded() {
    let mut h = Harness::with_saved_session("hist-missing", SESSION_ID);
    let cmd = h.fake("strange-bad-args.bad-resume", &[]);
    h.start_resume(&cmd).unwrap();
    h.manager.send_message("hello").unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let kinds = types(&page);
    assert!(kinds.contains(&"resume_not_found".to_string()), "{kinds:?}");
    let missing = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "resume_not_found")
        .unwrap();
    assert_eq!(missing.event["sessionId"], SESSION_ID);
    assert_eq!(
        kinds.iter().filter(|k| *k == "resume_not_found").count(),
        1,
        "한 번만"
    );
    assert_eq!(page.entries.last().unwrap().event["type"], "session_ended");
    // 실패한 턴의 오류 글은 남는다
    let ended = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "turn_ended")
        .unwrap();
    assert_eq!(ended.event["outcome"], "error");
}

// ───────────────────────── 쓰기 ─────────────────────────

#[test]
fn slow_history_writes_do_not_slow_the_session_events() {
    let mut h = Harness::new("hist-slow");
    let cmd = h.fake("two-turns", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("one").unwrap();
    h.wait_for("first turn", turn_outcome);
    assert!(h.manager.flush_history(Duration::from_secs(10)));

    // DB 를 오래 쥐고 있는 일이 끼었다 — 같은 세션 ID 의 두 번째 턴은 DB 를 기다리지 않아야 한다
    let blocker = h.db.clone();
    let (held_tx, held_rx) = mpsc::channel();
    let holder = thread::spawn(move || {
        blocker
            .write(|_| {
                held_tx.send(()).unwrap();
                thread::sleep(Duration::from_millis(1500));
                Ok(())
            })
            .unwrap();
    });
    held_rx.recv().unwrap();
    let started = Instant::now();
    h.manager.send_message("two").unwrap();
    assert_eq!(
        h.wait_for("second turn", turn_outcome),
        TurnOutcome::Success
    );
    let took = started.elapsed();
    assert!(
        took < Duration::from_millis(1000),
        "events waited for the database: {took:?}"
    );
    holder.join().unwrap();
    // 막힌 것이 풀리면 밀린 것이 모두 쓰인다
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    assert_eq!(types(&page), live_types(&mut h));
}

#[test]
fn shutting_down_writes_what_is_left_without_a_flush() {
    let mut h = Harness::new("hist-shutdown");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("say pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    // 읽기 쪽 flush 를 거치지 않고 곧바로 앱을 끈다
    h.manager.shutdown();
    let direct =
        h.db.read(|conn| nyanitor_lib::history::chat::read_page(conn, 1, None, 100, None))
            .unwrap();
    let kinds: Vec<String> = direct
        .entries
        .iter()
        .map(|e| e.event["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        kinds,
        [
            "session_started",
            "user_message",
            "text",
            "turn_ended",
            "session_ended"
        ],
        "끌 때 세션 끝 알림까지 기록에 들어갔다"
    );
    let usage = h.db.read(|conn| usage::summarize(conn, 0, None)).unwrap();
    assert_eq!(usage.today.turns, 1);
}

#[test]
fn a_database_that_is_read_only_lets_the_session_run_and_only_warns() {
    let mut h = Harness::with_read_only_db("hist-readonly");
    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("say pong").unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Success);
    h.manager.flush_history(Duration::from_secs(10));
    h.manager.stop().unwrap();
    h.wait_ended();
    let codes: Vec<String> = h
        .seen()
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Warning { code, .. } => Some(code.clone()),
            _ => None,
        })
        .collect();
    assert!(
        codes.contains(&"session_store_failed".to_string()),
        "{codes:?}"
    );
    assert!(
        codes.contains(&"history_write_failed".to_string()),
        "{codes:?}"
    );
    assert_eq!(
        codes
            .iter()
            .filter(|c| *c == "history_write_failed")
            .count(),
        1,
        "같은 실패는 한 번만 알린다"
    );
    // 읽기는 된다 (비어 있다)
    assert!(read(&h, None, 10).entries.is_empty());
}

// ───────────────────────── 츄르 ─────────────────────────

fn turn_tokens(h: &mut Harness) -> (usize, TokenUsage, f64) {
    let mut total = TokenUsage::default();
    let mut cost = 0.0;
    let mut turns = 0;
    for event in h.seen() {
        if let SessionEvent::TurnEnded(summary) = event {
            turns += 1;
            total.input_tokens += summary.usage.input_tokens;
            total.output_tokens += summary.usage.output_tokens;
            total.cache_creation_input_tokens += summary.usage.cache_creation_input_tokens;
            total.cache_read_input_tokens += summary.usage.cache_read_input_tokens;
            cost += summary.cost_usd;
        }
    }
    (turns, total, cost)
}

#[test]
fn the_chure_sum_matches_the_turns_and_the_live_session_is_this_run_only() {
    let mut h = Harness::new("hist-usage");
    let cmd = h.fake("two-turns", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("one").unwrap();
    h.wait_for("first turn", turn_outcome);
    h.manager.send_message("two").unwrap();
    h.wait_for("second turn", turn_outcome);
    let (turns, tokens, cost) = turn_tokens(&mut h);
    assert_eq!(turns, 2);
    assert!(tokens.output_tokens > 0);
    h.manager.flush_history(Duration::from_secs(10));

    // 돌고 있는 동안: 지금 세션의 합 = 이번 실행의 턴들의 합
    let live = h.manager.live_run().expect("a live session");
    assert_eq!(live.project_id, 1);
    assert_eq!(live.session_id.as_deref(), Some(SESSION_ID));
    let summary =
        h.db.read(|conn| usage::summarize(conn, 0, Some(&live)))
            .unwrap();
    let expected_total = tokens.input_tokens
        + tokens.output_tokens
        + tokens.cache_creation_input_tokens
        + tokens.cache_read_input_tokens;
    for sum in [
        summary.today,
        summary.projects[0].total,
        summary.projects[0].today,
        summary.session.as_ref().unwrap().usage,
    ] {
        assert_eq!(sum.turns, 2);
        assert_eq!(sum.input_tokens, tokens.input_tokens);
        assert_eq!(sum.output_tokens, tokens.output_tokens);
        assert_eq!(
            sum.cache_creation_input_tokens,
            tokens.cache_creation_input_tokens
        );
        assert_eq!(sum.cache_read_input_tokens, tokens.cache_read_input_tokens);
        assert_eq!(sum.total_tokens, expected_total);
        assert!(
            (sum.cost_usd - cost).abs() < 1e-8,
            "{} vs {cost}",
            sum.cost_usd
        );
        // 구독(`apiKeySource: none`)으로 돌았으니 "참고용 추정"
        assert_eq!((sum.subscription_turns, sum.api_key_turns), (2, 0));
        assert!(sum.reference_only);
    }
    assert_eq!(
        summary.session.unwrap().session_id.as_deref(),
        Some(SESSION_ID)
    );
    // 명령이 부르는 길(오늘 = 이 PC 의 자정부터)도 같은 합을 낸다 — 방금 쓴 것이니 오늘 안이다
    let via_command = history::usage_summary(&h.db, &h.manager).unwrap();
    assert!(via_command.since <= usage::now_secs());
    assert!(via_command.today.turns <= 2);
    assert!(via_command.session.is_some());

    h.manager.stop().unwrap();
    h.wait_ended();

    // 이어서 같은 프로젝트를 한 번 더 — 지금 세션의 합은 새 실행 것만, 프로젝트 합은 둘 다
    let again = h.fake("start", &[]);
    h.start(&again).unwrap();
    h.manager.send_message("say pong").unwrap();
    h.wait_for("third turn", turn_outcome);
    h.manager.flush_history(Duration::from_secs(10));
    let live = h.manager.live_run().unwrap();
    let summary =
        h.db.read(|conn| usage::summarize(conn, 0, Some(&live)))
            .unwrap();
    assert_eq!(summary.session.unwrap().usage.turns, 1);
    assert_eq!(summary.projects[0].total.turns, 3);
    h.manager.stop().unwrap();
    h.wait_ended();
    // 끝난 세션은 "지금 세션" 이 아니다
    let ended = history::usage_summary(&h.db, &h.manager).unwrap();
    assert!(ended.session.is_none());
}

#[test]
fn a_turn_billed_to_an_api_key_is_counted_as_such() {
    let mut h = Harness::new("hist-apikey");
    let cmd = h.fake("env.apikey", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("Say only: hi").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    h.manager.flush_history(Duration::from_secs(10));
    let summary = h.db.read(|conn| usage::summarize(conn, 0, None)).unwrap();
    assert_eq!(summary.today.turns, 1);
    assert_eq!(summary.today.api_key_turns, 1);
    assert_eq!(summary.today.subscription_turns, 0);
    assert!(
        !summary.today.reference_only,
        "키로 과금된 것은 참고용이 아니다"
    );
}

// ───────────────────────── 프로젝트 빼기 ─────────────────────────

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

#[test]
fn removing_a_project_removes_its_sessions_history_and_chure_but_not_the_folder_or_other_projects()
{
    let mut h = Harness::new("hist-remove");
    // 다른 프로젝트의 기록 (직접 넣는다)
    h.db.write(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, path, path_key, name, created_at, last_opened_at) VALUES (2, 'x', 'x', 'x', 1, 1);
             INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at) VALUES (2, '00000000-0000-4000-8000-000000000009', 1, 1);
             INSERT INTO chat_items (project_id, run_id, at, kind, body) VALUES (2, 1, 1, 'text', '{\"type\":\"text\",\"text\":\"keep\"}');
             INSERT INTO usage_turns (project_id, run_id, at, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, outcome)
               VALUES (2, 1, 1, 1, 1, 0, 0, 0.1, 'success');",
        )?;
        Ok(())
    })
    .unwrap();

    let cmd = h.fake("start", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("say pong").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    h.manager.flush_history(Duration::from_secs(10));
    assert!(count(&h, "sessions", 1) > 0);
    assert!(count(&h, "chat_items", 1) > 0);
    assert!(count(&h, "usage_turns", 1) > 0);

    let marker = h.project.join("keep-me.txt");
    std::fs::write(&marker, "x").unwrap();
    let state = ProjectsState::new(h.root.join("data"));
    projects::remove(&h.db, &state, &h.manager, 1).unwrap();
    for table in ["sessions", "chat_items", "usage_turns"] {
        assert_eq!(count(&h, table, 1), 0, "{table}");
        assert_eq!(count(&h, table, 2), 1, "{table} of the other project");
    }
    assert!(marker.exists(), "폴더 · 파일은 그대로");
    assert_eq!(
        history::chat_history(&h.db, &h.manager, 1, None, 10)
            .unwrap_err()
            .kind(),
        "project_not_found"
    );
    assert_eq!(h.manager.last_session(1).unwrap(), None);
    // 번호는 물려받지 않는다 — 같은 폴더를 다시 등록해도 새 번호라 옛 기록이 따라오지 않는다
    let again = projects::store::insert(
        &mut_conn(&h),
        &h.project.display().to_string(),
        &nyanitor_lib::claude::store::project_key(&h.project),
        "again",
        None,
        1,
    );
    assert!(again.unwrap().id > 2);
}

/// 시험에서 DB 연결 하나를 빌려 쓴다
fn mut_conn(h: &Harness) -> rusqlite::Connection {
    rusqlite::Connection::open(h.root.join("data").join(DB_FILE)).unwrap()
}

// ───────────────────────── 이 시험만의 녹화 (한도 · 오류 · 긴 글) ─────────────────────────

fn send_user() -> Value {
    json!({ "dir": "send", "msg": { "type": "user", "message": { "role": "user", "content": "x" } } })
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

fn say(t: &str) -> Value {
    recv(json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": t }] } }))
}

fn rate(status: &str) -> Value {
    recv(json!({
        "type": "rate_limit_event",
        "rate_limit_info": { "status": status, "rateLimitType": "five_hour", "resetsAt": 1_900_000_000 }
    }))
}

fn finished(total: f64) -> Value {
    recv(json!({
        "type": "result", "subtype": "success", "is_error": false, "result": "ok",
        "total_cost_usd": total, "usage": { "input_tokens": 1, "output_tokens": 2 }
    }))
}

fn exit_with(code: i32) -> Value {
    json!({ "dir": "exit", "code": code })
}

fn custom(h: &Harness, name: &str, records: Vec<Value>) -> FakeCmd {
    let dir = h.root.join("fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    let body: Vec<String> = records.iter().map(Value::to_string).collect();
    std::fs::write(dir.join(format!("{name}.jsonl")), body.join("\n") + "\n").unwrap();
    h.fake(name, &[]).env("NYANITOR_FAKE_FIXTURES", dir)
}

#[test]
fn only_a_rate_limit_that_is_not_plain_allowed_is_kept_and_the_same_one_is_kept_once() {
    let mut h = Harness::new("hist-rate");
    let cmd = custom(
        &h,
        "rate",
        vec![
            send_user(),
            init(SESSION_ID),
            rate("allowed"),
            rate("allowed_warning"),
            rate("allowed_warning"),
            rate("allowed"),
            rate("rejected"),
            say("slow down"),
            finished(0.1),
            exit_with(0),
        ],
    );
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let limits: Vec<&str> = page
        .entries
        .iter()
        .filter(|e| e.event["type"] == "rate_limit")
        .map(|e| e.event["status"].as_str().unwrap())
        .collect();
    // 막힘(`rejected`) · 임박(`allowed_warning`) 만, 같은 값이 거듭 와도 한 번만
    assert_eq!(limits, ["allowed_warning", "rejected"]);
}

#[test]
fn a_turn_that_ended_on_the_limit_keeps_its_error_text_and_its_usage() {
    let mut h = Harness::new("hist-limit");
    let cmd = custom(
        &h,
        "limit",
        vec![
            send_user(),
            init(SESSION_ID),
            rate("rejected"),
            recv(json!({
                "type": "result", "subtype": "success", "is_error": true, "api_error_status": 429,
                "result": "You've hit your limit", "total_cost_usd": 0.0,
                "usage": { "input_tokens": 7, "output_tokens": 0 }
            })),
            exit_with(0),
        ],
    );
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    assert_eq!(h.wait_for("turn end", turn_outcome), TurnOutcome::Limit);
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let ended = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "turn_ended")
        .unwrap();
    assert_eq!(ended.event["outcome"], "limit");
    assert_eq!(
        ended.event["result"], "You've hit your limit",
        "오류 글은 남는다"
    );
    assert_eq!(ended.event["apiErrorStatus"], 429);
    h.manager.flush_history(Duration::from_secs(10));
    let sum = h.db.read(|c| usage::summarize(c, 0, None)).unwrap().today;
    assert_eq!(
        (sum.turns, sum.input_tokens),
        (1, 7),
        "한도에 걸린 턴도 쓴 만큼은 쌓는다"
    );
    let outcome: String =
        h.db.read(|c| Ok(c.query_row("SELECT outcome FROM usage_turns", [], |r| r.get(0))?))
            .unwrap();
    assert_eq!(outcome, "limit");
}

#[test]
fn a_very_long_message_and_reply_are_cut_and_flagged() {
    let mut config = fast_config();
    config.history.max_text_chars = 50;
    let mut h = Harness::with_config("hist-long", config);
    let long_reply = "답".repeat(500);
    let cmd = custom(
        &h,
        "long",
        vec![
            send_user(),
            init(SESSION_ID),
            say(&long_reply),
            finished(0.1),
            exit_with(0),
        ],
    );
    h.start(&cmd).unwrap();
    h.manager.send_message(&"질".repeat(200)).unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let user = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "user_message")
        .unwrap();
    assert!(user.truncated);
    assert_eq!(user.event["text"], format!("{}…", "질".repeat(50)));
    let reply = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "text")
        .unwrap();
    assert!(reply.truncated);
    assert_eq!(reply.event["text"], format!("{}…", "답".repeat(50)));
    // 잘리지 않은 항목은 표시가 없다
    let ended = page
        .entries
        .iter()
        .find(|e| e.event["type"] == "turn_ended")
        .unwrap();
    assert!(!ended.truncated);
}

#[test]
fn the_oldest_items_go_first_when_a_project_passes_its_limit() {
    let mut config = fast_config();
    config.history.max_items_per_project = 6;
    let mut h = Harness::with_config("hist-limit-items", config);
    let cmd = h.fake("two-turns", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("one").unwrap();
    h.wait_for("first turn", turn_outcome);
    h.manager.send_message("two").unwrap();
    h.wait_for("second turn", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let all = live_types(&mut h);
    assert!(all.len() > 6, "{all:?}");
    let page = read(&h, None, 100);
    assert_eq!(page.entries.len(), 6);
    assert_eq!(types(&page), all[all.len() - 6..], "가장 최근 6개만 남았다");
    assert!(!types(&page).contains(&"session_started".to_string()));
    // 츄르는 한도와 상관없이 남는다
    let sum = h.db.read(|c| usage::summarize(c, 0, None)).unwrap().today;
    assert_eq!(sum.turns, 2);
}

#[test]
fn an_error_tool_result_is_kept_but_a_successful_one_is_not() {
    let mut h = Harness::new("hist-toolresult");
    let ok = recv(
        json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "fine" }] } }),
    );
    let bad = recv(
        json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t2", "content": "boom", "is_error": true }] } }),
    );
    let cmd = custom(
        &h,
        "toolresult",
        vec![
            send_user(),
            init(SESSION_ID),
            ok,
            bad,
            finished(0.1),
            exit_with(0),
        ],
    );
    h.start(&cmd).unwrap();
    h.manager.send_message("go").unwrap();
    h.wait_for("turn end", turn_outcome);
    h.manager.stop().unwrap();
    h.wait_ended();
    let page = read(&h, None, 100);
    let results: Vec<&Value> = page
        .entries
        .iter()
        .filter(|e| e.event["type"] == "tool_result")
        .map(|e| &e.event)
        .collect();
    assert_eq!(results.len(), 1, "{:?}", types(&page));
    assert_eq!(results[0]["isError"], true);
    assert_eq!(results[0]["toolUseId"], "t2");
    // 실패한 결과도 글은 저장하지 않는다 (D-48) — 칸은 빈 글이다
    assert_eq!(results[0]["summary"], "");
    assert!(!format!("{:?}", page.entries).contains("boom"));
    // 화면으로 간 실시간 이벤트에는 글이 있다
    let live: Vec<Value> = h
        .seen()
        .iter()
        .filter(|e| matches!(e, SessionEvent::ToolResult { is_error: true, .. }))
        .map(to_json)
        .collect();
    assert_eq!(live.len(), 1);
    assert_eq!(live[0]["summary"], "boom");
}
