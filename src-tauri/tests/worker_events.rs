//! 작업자(서브에이전트) 이벤트 시험 (P7-02) — 실제 CLI 녹화본(`tests/fixtures/cli/agent*.jsonl`)을 해석기에 그대로 먹여
//! 작업자 시작 · 끝 · 하는 일이 시나리오대로 나오는지, 작업자 안쪽 줄이 메인 채팅 이벤트로 새지 않는지, 어떤 끝에서도 일하는 작업자가 남지 않는지 본다.
//! 프로세스 · 스레드는 쓰지 않는다 (순수 해석기 시험).

use std::fs;
use std::path::{Path, PathBuf};

use nyanitor_lib::claude::events::{SessionEvent, TurnOutcome, WorkerOutcome};
use nyanitor_lib::claude::protocol::Interpreter;
use serde_json::{Value, json};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cli")
}

/// 녹화본에서 CLI → 앱 메시지만 순서대로.
fn recv_messages(name: &str) -> Vec<Value> {
    let text = fs::read_to_string(fixtures_dir().join(format!("{name}.jsonl"))).unwrap();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<Value>(l).unwrap())
        .filter(|rec| rec["dir"] == "recv")
        .filter_map(|rec| rec.get("msg").cloned())
        .collect()
}

fn fixed_clock() -> u64 {
    1_234
}

fn interpreter() -> Interpreter {
    Interpreter::with_clock(Path::new("C:\\p"), fixed_clock)
}

/// 녹화를 먹여 나온 이벤트 전부와, 다 먹인 뒤의 해석기.
fn feed(name: &str) -> (Vec<SessionEvent>, Interpreter) {
    let mut interp = interpreter();
    let mut events = Vec::new();
    for msg in recv_messages(name) {
        events.extend(interp.handle(&msg).events);
    }
    (events, interp)
}

fn feed_messages(messages: &[Value]) -> (Vec<SessionEvent>, Interpreter) {
    let mut interp = interpreter();
    let mut events = Vec::new();
    for msg in messages {
        events.extend(interp.handle(msg).events);
    }
    (events, interp)
}

fn kind(event: &SessionEvent) -> String {
    serde_json::to_value(event).unwrap()["type"]
        .as_str()
        .unwrap()
        .to_string()
}

/// 이벤트 종류 순서 (작업자 · 턴 · 도구 줄만 — 모양 비교용)
fn story(events: &[SessionEvent]) -> Vec<String> {
    events
        .iter()
        .map(kind)
        .filter(|k| {
            k.starts_with("worker_")
                || matches!(
                    k.as_str(),
                    "turn_started" | "turn_ended" | "tool_use" | "tool_result" | "text"
                )
        })
        .collect()
}

fn started(events: &[SessionEvent]) -> Vec<&SessionEvent> {
    events
        .iter()
        .filter(|e| matches!(e, SessionEvent::WorkerStarted { .. }))
        .collect()
}

fn ended(events: &[SessionEvent]) -> Vec<(String, WorkerOutcome)> {
    events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::WorkerEnded {
                tool_use_id,
                outcome,
                ..
            } => Some((tool_use_id.clone(), *outcome)),
            _ => None,
        })
        .collect()
}

fn started_id(event: &SessionEvent) -> String {
    match event {
        SessionEvent::WorkerStarted { tool_use_id, .. } => tool_use_id.clone(),
        other => panic!("not a worker start: {other:?}"),
    }
}

// ───────────────────────── 녹화본 → 이벤트 ─────────────────────────

#[test]
fn a_foreground_worker_starts_works_and_ends_done_before_the_agent_call_returns() {
    let (events, interp) = feed("agent");
    assert_eq!(
        story(&events),
        [
            "turn_started",
            "tool_use",       // 메인이 작업자를 부른다 (Agent)
            "worker_started", // task_started (is_backgrounded false)
            "worker_activity",
            "worker_ended", // task_notification completed
            "tool_result",  // Agent 호출의 결과 (작업자의 인계 글)
            "text",
            "turn_ended"
        ]
    );
    let SessionEvent::WorkerStarted {
        tool_use_id,
        agent_id,
        name,
        description,
        background,
        depth,
        at_ms,
    } = &events
        .iter()
        .find(|e| matches!(e, SessionEvent::WorkerStarted { .. }))
        .unwrap()
        .clone()
    else {
        unreachable!()
    };
    assert!(tool_use_id.starts_with("toolu_"));
    assert!(agent_id.as_deref().is_some_and(|id| !id.is_empty()));
    assert_eq!(name, "probe-helper");
    assert_eq!(description.as_deref(), Some("read note"));
    assert!(!background, "run_in_background:false 로 불렀다");
    assert_eq!(*depth, 1);
    assert_eq!(*at_ms, 1_234);
    // 하는 일: 마지막 도구와 한 줄 설명
    let activity: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::WorkerActivity {
                tool_use_id: id,
                tool,
                summary,
                tool_uses,
            } => Some((id.clone(), tool.clone(), summary.clone(), *tool_uses)),
            _ => None,
        })
        .collect();
    assert_eq!(
        activity,
        [(
            tool_use_id.clone(),
            Some("Read".to_string()),
            Some("Reading note.txt".to_string()),
            Some(1)
        )]
    );
    assert_eq!(
        ended(&events),
        [(tool_use_id.clone(), WorkerOutcome::Done)],
        "끝 알림 하나가 끝이다 (task_updated 도 같이 왔지만 두 번 끝나지 않는다)"
    );
    assert!(interp.running_workers().is_empty());
}

#[test]
fn a_worker_called_without_saying_foreground_runs_in_the_background_and_outlives_the_turn() {
    // 이 CLI(2.1.319)는 `run_in_background` 를 안 주면 작업자를 백그라운드로 돌린다 — 부른 턴의 `result` 뒤에 끝이 온다.
    let (events, interp) = feed("agent.default");
    assert_eq!(
        story(&events),
        [
            "turn_started",
            "tool_use",
            "worker_started",
            "tool_result", // "Async agent launched" — 끝이 아니다
            "worker_activity",
            "text",
            "turn_ended", // 첫 턴은 작업자가 도는 채로 끝난다
            "worker_ended",
            "turn_started", // 끝 알림 뒤 CLI 가 스스로 시작하는 턴
            "text",
            "turn_ended"
        ]
    );
    let SessionEvent::WorkerStarted { background, .. } = started(&events)[0] else {
        unreachable!()
    };
    assert!(*background);
    // 첫 턴이 끝난 뒤에도 일하는 중이었다 (turn_ended 가 worker_ended 보다 앞)
    let first_turn_end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::TurnEnded(_)))
        .unwrap();
    let end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::WorkerEnded { .. }))
        .unwrap();
    assert!(first_turn_end < end);
    assert!(interp.running_workers().is_empty());
}

#[test]
fn an_explicit_background_worker_is_the_same_story() {
    let (events, _) = feed("agent-background");
    let SessionEvent::WorkerStarted {
        background, name, ..
    } = started(&events)[0]
    else {
        unreachable!()
    };
    assert!(*background);
    assert_eq!(name, "probe-helper");
    assert_eq!(ended(&events).len(), 1);
    assert_eq!(ended(&events)[0].1, WorkerOutcome::Done);
    // 첫 `result` 가 작업자의 끝보다 앞이다
    let first_turn_end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::TurnEnded(_)))
        .unwrap();
    let end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::WorkerEnded { .. }))
        .unwrap();
    assert!(first_turn_end < end);
}

#[test]
fn two_workers_at_once_each_get_their_own_start_and_end() {
    let (events, interp) = feed("agent-two");
    let starts = started(&events);
    assert_eq!(starts.len(), 2);
    let ids: Vec<String> = starts.iter().map(|e| started_id(e)).collect();
    assert_ne!(ids[0], ids[1]);
    let mut done: Vec<String> = ended(&events)
        .into_iter()
        .inspect(|(_, outcome)| assert_eq!(*outcome, WorkerOutcome::Done))
        .map(|(id, _)| id)
        .collect();
    let mut want = ids.clone();
    done.sort();
    want.sort();
    assert_eq!(done, want);
    // 하는 일은 작업자마다 따로 온다
    let activity_ids: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::WorkerActivity { tool_use_id, .. } => Some(tool_use_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(activity_ids.len(), 2);
    assert!(ids.iter().all(|id| activity_ids.contains(id)));
    assert!(interp.running_workers().is_empty());
}

#[test]
fn a_permission_request_from_inside_a_worker_names_that_worker() {
    for name in ["agent-permission", "agent-permission.background"] {
        let (events, _) = feed(name);
        let SessionEvent::WorkerStarted {
            tool_use_id,
            agent_id,
            name: worker_name,
            ..
        } = started(&events)[0]
        else {
            unreachable!()
        };
        let request = events
            .iter()
            .find_map(|e| match e {
                SessionEvent::PermissionRequest(info) => Some(info),
                _ => None,
            })
            .unwrap_or_else(|| panic!("{name}: no permission request"));
        assert_eq!(request.tool, "Write");
        let worker = request
            .worker
            .as_ref()
            .unwrap_or_else(|| panic!("{name}: the request has no worker"));
        assert_eq!(Some(&worker.agent_id), agent_id.as_ref());
        assert_eq!(worker.tool_use_id.as_ref(), Some(tool_use_id));
        assert_eq!(worker.name.as_ref(), Some(worker_name));
        assert_eq!(worker_name, "probe-writer");
        // 요청의 `toolUseId` 는 작업자 안쪽의 도구 호출이다 — 작업자를 부른 호출과 다르다
        assert_ne!(request.tool_use_id.as_ref(), Some(tool_use_id));
    }
}

#[test]
fn a_request_from_the_main_conversation_has_no_worker() {
    let (events, _) = feed("permission-allow");
    let request = events
        .iter()
        .find_map(|e| match e {
            SessionEvent::PermissionRequest(info) => Some(info),
            _ => None,
        })
        .unwrap();
    assert!(request.worker.is_none());
}

#[test]
fn interrupting_stops_the_working_worker_once_before_the_turn_ends_interrupted() {
    let (events, interp) = feed("agent-interrupt");
    assert_eq!(
        ended(&events)
            .iter()
            .map(|(_, outcome)| *outcome)
            .collect::<Vec<_>>(),
        [WorkerOutcome::Stopped],
        "task_notification(stopped) 로 한 번 — 중단 result 가 또 끝내지 않는다"
    );
    let end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::WorkerEnded { .. }))
        .unwrap();
    let turn = events
        .iter()
        .position(
            |e| matches!(e, SessionEvent::TurnEnded(t) if t.outcome == TurnOutcome::Interrupted),
        )
        .unwrap();
    assert!(end < turn);
    assert!(interp.running_workers().is_empty());
}

#[test]
fn interrupting_while_only_a_background_worker_runs_stops_it_without_a_turn() {
    let (events, interp) = feed("agent-interrupt.background");
    assert_eq!(ended(&events).len(), 1);
    assert_eq!(ended(&events)[0].1, WorkerOutcome::Stopped);
    assert!(interp.running_workers().is_empty());
}

// ───────────────────────── 작업자 안쪽 줄은 메인 채팅에 섞이지 않는다 ─────────────────────────

const AGENT_FIXTURES: [&str; 8] = [
    "agent",
    "agent.default",
    "agent-background",
    "agent-two",
    "agent-permission",
    "agent-permission.background",
    "agent-interrupt",
    "agent-interrupt.background",
];

fn is_inner(msg: &Value) -> bool {
    msg["parent_tool_use_id"].is_string()
}

#[test]
fn nothing_said_or_run_inside_a_worker_reaches_the_main_chat_events() {
    for name in AGENT_FIXTURES {
        let messages = recv_messages(name);
        let inner: Vec<&Value> = messages
            .iter()
            .filter(|m| m["type"] == "assistant" || m["type"] == "user")
            .filter(|m| is_inner(m))
            .collect();
        if name != "agent-interrupt.background" {
            assert!(!inner.is_empty(), "{name}: the recording has inner lines");
        }
        // 안쪽 도구 호출 · 도구 결과의 ID, 안쪽 글
        let mut inner_ids = Vec::new();
        let mut inner_texts = Vec::new();
        for m in &inner {
            for block in m["message"]["content"].as_array().into_iter().flatten() {
                for key in ["id", "tool_use_id"] {
                    if let Some(id) = block[key].as_str() {
                        inner_ids.push(id.to_string());
                    }
                }
                if let Some(text) = block["text"].as_str().filter(|t| t.len() > 10) {
                    inner_texts.push(text.to_string());
                }
            }
        }
        let (events, _) = feed(name);
        for event in &events {
            match event {
                SessionEvent::ToolUse { tool_use_id, .. }
                | SessionEvent::ToolResult { tool_use_id, .. } => {
                    assert!(
                        !inner_ids.contains(tool_use_id),
                        "{name}: an inner tool line leaked: {event:?}"
                    );
                }
                SessionEvent::Text { text } => {
                    assert!(
                        !inner_texts.iter().any(|t| t == text),
                        "{name}: inner text leaked: {text}"
                    );
                }
                _ => {}
            }
        }
        // 메인 줄은 그대로 나온다: 메인 assistant 의 도구 호출 수 = ToolUse 이벤트 수
        let main_tool_uses = messages
            .iter()
            .filter(|m| m["type"] == "assistant" && !is_inner(m))
            .flat_map(|m| {
                m["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .filter(|b| b["type"] == "tool_use")
            .count();
        let tool_use_events = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::ToolUse { .. }))
            .count();
        assert_eq!(main_tool_uses, tool_use_events, "{name}");
    }
}

#[test]
fn the_agent_call_summary_is_the_description_never_the_prompt() {
    let messages = recv_messages("agent");
    let call = messages
        .iter()
        .filter(|m| m["type"] == "assistant" && !is_inner(m))
        .flat_map(|m| {
            m["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .find(|b| b["type"] == "tool_use" && b["name"] == "Agent")
        .unwrap();
    let prompt = call["input"]["prompt"].as_str().unwrap().to_string();
    let (events, _) = feed("agent");
    let summary = events
        .iter()
        .find_map(|e| match e {
            SessionEvent::ToolUse { tool, summary, .. } if tool == "Agent" => Some(summary.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(summary, "read note");
    // 어떤 이벤트에도 지시 글이 없다 (작업자 시작 · 하는 일 · 끝 · 도구 줄)
    for event in &events {
        if matches!(
            event,
            SessionEvent::WorkerStarted { .. }
                | SessionEvent::WorkerActivity { .. }
                | SessionEvent::WorkerEnded { .. }
                | SessionEvent::ToolUse { .. }
        ) {
            let text = serde_json::to_string(event).unwrap();
            assert!(!text.contains(&prompt), "{text}");
        }
    }
    // 설명이 없는 호출이어도 지시 글로 대신하지 않는다
    let mut interp = interpreter();
    let out = interp.handle(&json!({
        "type": "assistant",
        "message": { "content": [{
            "type": "tool_use", "id": "t1", "name": "Agent",
            "input": { "subagent_type": "x", "prompt": "SECRET-INSTRUCTION" }
        }] }
    }));
    let SessionEvent::ToolUse { summary, .. } = &out.events[0] else {
        panic!()
    };
    assert_eq!(summary, "x");
    assert!(!summary.contains("SECRET"));
}

#[test]
fn the_old_task_tool_name_works_the_same_because_workers_come_from_task_started() {
    // 작업자는 도구 이름(Agent · Task)이 아니라 `system/task_started` 로 안다 — 이름이 바뀌어도 상관없다
    let messages: Vec<Value> = recv_messages("agent")
        .into_iter()
        .map(|mut m| {
            if m["type"] == "assistant" {
                for block in m["message"]["content"].as_array_mut().into_iter().flatten() {
                    if block["name"] == "Agent" {
                        block["name"] = json!("Task");
                    }
                }
            }
            m
        })
        .collect();
    let (events, _) = feed_messages(&messages);
    assert_eq!(started(&events).len(), 1);
    assert_eq!(ended(&events).len(), 1);
    let SessionEvent::ToolUse { tool, summary, .. } = events
        .iter()
        .find(|e| matches!(e, SessionEvent::ToolUse { .. }))
        .unwrap()
    else {
        unreachable!()
    };
    assert_eq!(tool, "Task");
    assert_eq!(summary, "read note");
}

// ───────────────────────── 끝나지 않은 작업자 ─────────────────────────

/// 녹화의 앞부분만 먹인다 — `stop` 줄이 처음 나오기 직전까지 (`task_started` 가 이미 온 뒤).
fn feed_until(name: &str, stop_at: impl Fn(&Value) -> bool) -> (Vec<SessionEvent>, Interpreter) {
    let messages: Vec<Value> = recv_messages(name)
        .into_iter()
        .take_while(|m| !stop_at(m))
        .collect();
    feed_messages(&messages)
}

fn is_subtype(m: &Value, subtype: &str) -> bool {
    m["type"] == "system" && m["subtype"] == subtype
}

#[test]
fn workers_left_when_the_session_goes_away_are_all_ended_as_stopped() {
    // 일하는 중에 세션이 끝나거나 죽는다 (끝 알림이 오기 전에 줄이 끊긴다)
    for name in ["agent", "agent.default", "agent-two", "agent-permission"] {
        let (events, mut interp) = feed_until(name, |m| is_subtype(m, "task_updated"));
        let running = started(&events).len();
        assert!(running >= 1, "{name}");
        assert_eq!(interp.running_workers().len(), running, "{name}");
        assert_eq!(interp.running_worker_ids().len(), running, "{name}");
        let drained = interp.end_all_workers(WorkerOutcome::Stopped);
        assert_eq!(drained.len(), running, "{name}");
        for event in &drained {
            assert!(
                matches!(
                    event,
                    SessionEvent::WorkerEnded {
                        outcome: WorkerOutcome::Stopped,
                        at_ms: 1_234,
                        ..
                    }
                ),
                "{event:?}"
            );
        }
        // 이 뒤로는 남은 작업자가 없고, 한 번 더 끝내도 아무것도 안 나온다
        assert!(interp.running_workers().is_empty());
        assert!(interp.end_all_workers(WorkerOutcome::Stopped).is_empty());
    }
}

#[test]
fn an_interrupted_result_ends_workers_even_when_no_end_notification_came() {
    // 끝 알림이 빠진 중단: task_notification · task_updated 를 뺀다
    let messages: Vec<Value> = recv_messages("agent-interrupt")
        .into_iter()
        .filter(|m| !is_subtype(m, "task_notification") && !is_subtype(m, "task_updated"))
        .collect();
    let (events, interp) = feed_messages(&messages);
    assert_eq!(
        ended(&events)
            .iter()
            .map(|(_, outcome)| *outcome)
            .collect::<Vec<_>>(),
        [WorkerOutcome::Stopped]
    );
    let end = events
        .iter()
        .position(|e| matches!(e, SessionEvent::WorkerEnded { .. }))
        .unwrap();
    let turn = events
        .iter()
        .position(|e| matches!(e, SessionEvent::TurnEnded(_)))
        .unwrap();
    assert!(end < turn, "끝 알림은 턴 끝 앞에 온다");
    assert!(interp.running_workers().is_empty());
}

#[test]
fn a_normal_or_failed_result_does_not_touch_workers_that_keep_running() {
    // 백그라운드 작업자는 턴이 끝나도 계속 일한다 — 중단이 아닌 result 는 끝내지 않는다
    for (subtype, is_error) in [
        ("success", false),
        ("error_max_turns", true),
        ("success", true),
    ] {
        let (_, mut interp) = feed_until("agent.default", |m| is_subtype(m, "task_progress"));
        assert_eq!(interp.running_workers().len(), 1);
        let out = interp.handle(&json!({
            "type": "result", "subtype": subtype, "is_error": is_error, "terminal_reason": "completed"
        }));
        assert!(
            out.events
                .iter()
                .all(|e| !matches!(e, SessionEvent::WorkerEnded { .. })),
            "{subtype} {is_error}"
        );
        assert_eq!(interp.running_workers().len(), 1);
    }
}

// ───────────────────────── 이상한 입력 ─────────────────────────

fn task_started(tool_use_id: &str, task_id: &str) -> Value {
    json!({
        "type": "system", "subtype": "task_started", "task_id": task_id, "tool_use_id": tool_use_id,
        "description": "d", "subagent_type": "helper", "is_backgrounded": false, "spawn_depth": 1,
        "task_type": "local_agent", "prompt": "THE-PROMPT"
    })
}

fn notification(tool_use_id: &str, status: &str) -> Value {
    json!({
        "type": "system", "subtype": "task_notification", "task_id": "a", "tool_use_id": tool_use_id,
        "status": status, "summary": "THE-RESULT-TEXT"
    })
}

#[test]
fn the_same_start_twice_is_one_worker_and_the_second_end_is_ignored() {
    let (events, interp) = feed_messages(&[
        task_started("t1", "a"),
        task_started("t1", "a"),
        notification("t1", "completed"),
        notification("t1", "completed"),
        json!({ "type": "system", "subtype": "task_updated", "task_id": "a", "patch": { "status": "completed" } }),
    ]);
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["worker_started", "worker_ended"]
    );
    assert!(interp.running_workers().is_empty());
}

#[test]
fn an_end_without_a_start_is_ignored_without_panicking() {
    let (events, interp) = feed_messages(&[
        notification("never-started", "completed"),
        json!({ "type": "system", "subtype": "task_updated", "task_id": "ghost", "patch": { "status": "killed" } }),
        json!({ "type": "system", "subtype": "task_progress", "task_id": "ghost", "tool_use_id": "nobody", "last_tool_name": "Read" }),
        notification("", "completed"),
        json!({ "type": "system", "subtype": "task_notification" }),
    ]);
    assert!(events.is_empty(), "{events:?}");
    assert!(interp.running_workers().is_empty());
}

#[test]
fn a_restarted_call_after_its_end_is_a_new_worker() {
    let (events, interp) = feed_messages(&[
        task_started("t1", "a"),
        notification("t1", "completed"),
        task_started("t1", "a"),
    ]);
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["worker_started", "worker_ended", "worker_started"]
    );
    assert_eq!(interp.running_workers().len(), 1);
}

#[test]
fn end_statuses_map_to_done_failed_or_stopped_and_unknown_ones_still_end_the_worker() {
    for (status, want) in [
        ("completed", WorkerOutcome::Done),
        ("failed", WorkerOutcome::Failed),
        ("stopped", WorkerOutcome::Stopped),
        ("killed", WorkerOutcome::Stopped),
        ("cancelled", WorkerOutcome::Stopped),
        ("something-new", WorkerOutcome::Failed),
    ] {
        let (events, interp) =
            feed_messages(&[task_started("t1", "a"), notification("t1", status)]);
        assert_eq!(ended(&events), [("t1".to_string(), want)], "{status}");
        assert!(interp.running_workers().is_empty(), "{status}");
    }
    // `task_updated` 만 와도 (끝 알림이 빠져도) 끝난다. 끝나지 않은 상태는 무시한다.
    let (events, interp) = feed_messages(&[
        task_started("t1", "a"),
        json!({ "type": "system", "subtype": "task_updated", "task_id": "a", "patch": { "status": "running" } }),
        json!({ "type": "system", "subtype": "task_updated", "task_id": "a", "patch": { "end_time": 5 } }),
        json!({ "type": "system", "subtype": "task_updated", "task_id": "a", "patch": { "status": "failed" } }),
    ]);
    assert_eq!(ended(&events), [("t1".to_string(), WorkerOutcome::Failed)]);
    assert!(interp.running_workers().is_empty());
}

#[test]
fn progress_is_reported_only_when_the_tool_or_the_line_changes() {
    let progress = |tool: &str, line: &str, uses: u64| {
        json!({
            "type": "system", "subtype": "task_progress", "task_id": "a", "tool_use_id": "t1",
            "description": line, "last_tool_name": tool, "usage": { "tool_uses": uses }
        })
    };
    let (events, _) = feed_messages(&[
        task_started("t1", "a"),
        progress("Read", "Reading a.txt", 1),
        progress("Read", "Reading a.txt", 2),
        progress("Read", "Reading b.txt", 3),
        progress("Bash", "Reading b.txt", 4),
        progress("Bash", "Reading b.txt", 5),
    ]);
    let uses: Vec<Option<u64>> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::WorkerActivity { tool_uses, .. } => Some(*tool_uses),
            _ => None,
        })
        .collect();
    assert_eq!(uses, [Some(1), Some(3), Some(4)]);
}

#[test]
fn only_agent_tasks_are_workers_background_commands_pass_by() {
    let (events, interp) = feed_messages(&[
        json!({
            "type": "system", "subtype": "task_started", "task_id": "b1", "tool_use_id": "t9",
            "description": "run a command", "is_backgrounded": true, "task_type": "local_bash"
        }),
        notification("t9", "completed"),
        // task_type 이 없어도 subagent_type 이 있으면 작업자다
        json!({ "type": "system", "subtype": "task_started", "task_id": "a", "tool_use_id": "t2", "subagent_type": "helper" }),
        // 어느 쪽도 없으면 작업자가 아니다
        json!({ "type": "system", "subtype": "task_started", "task_id": "x", "tool_use_id": "t3" }),
    ]);
    assert_eq!(
        events.iter().map(kind).collect::<Vec<_>>(),
        ["worker_started"]
    );
    assert_eq!(interp.running_worker_ids(), ["t2"]);
}

#[test]
fn odd_fields_fall_back_and_long_text_is_cut_and_the_prompt_and_result_text_never_appear() {
    let long = "가".repeat(1000);
    let (events, _) = feed_messages(&[
        json!({
            "type": "system", "subtype": "task_started", "task_id": "a", "tool_use_id": "t1",
            "description": long, "subagent_type": "  ", "is_backgrounded": "yes", "spawn_depth": "deep",
            "task_type": "local_agent", "prompt": "THE-PROMPT"
        }),
        json!({
            "type": "system", "subtype": "task_started", "task_id": 5, "tool_use_id": "t2",
            "task_type": "local_agent", "subagent_type": "n".repeat(500)
        }),
        notification("t1", "completed"),
        notification("t2", "completed"),
    ]);
    let SessionEvent::WorkerStarted {
        name,
        description,
        background,
        depth,
        agent_id,
        ..
    } = &events[0]
    else {
        panic!("{events:?}")
    };
    assert_eq!(name, "general-purpose", "이름이 비면 CLI 의 기본 작업자");
    assert_eq!(description.as_ref().unwrap().chars().count(), 301);
    assert!(!background && *depth == 1);
    assert_eq!(agent_id.as_deref(), Some("a"));
    let SessionEvent::WorkerStarted { name, agent_id, .. } = &events[1] else {
        panic!()
    };
    assert_eq!(name.chars().count(), 101);
    assert_eq!(*agent_id, None, "글이 아닌 ID 는 없는 것");
    for event in &events {
        let text = serde_json::to_string(event).unwrap();
        assert!(
            !text.contains("THE-PROMPT") && !text.contains("THE-RESULT-TEXT"),
            "{text}"
        );
    }
}

#[test]
fn too_many_workers_at_once_are_not_remembered_and_warn_once() {
    let mut messages: Vec<Value> = (0..250)
        .map(|n| task_started(&format!("t{n}"), &format!("a{n}")))
        .collect();
    messages.push(notification("t0", "completed"));
    messages.push(task_started("late", "alate"));
    let (events, interp) = feed_messages(&messages);
    assert_eq!(
        started(&events).len(),
        201,
        "200 개까지 + 하나 끝난 자리에 하나"
    );
    let warnings: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, SessionEvent::Warning { code, .. } if code == "worker_limit"))
        .collect();
    assert_eq!(warnings.len(), 1);
    assert_eq!(interp.running_workers().len(), 200);
}

#[test]
fn a_nested_worker_reports_its_depth_and_inner_lines_of_any_depth_stay_out_of_the_chat() {
    let mut nested = task_started("t2", "a2");
    nested["spawn_depth"] = json!(2);
    let (events, _) = feed_messages(&[
        task_started("t1", "a1"),
        nested,
        // 작업자 속 작업자의 줄도 `parent_tool_use_id` 가 있다
        json!({
            "type": "assistant", "parent_tool_use_id": "t2",
            "message": { "content": [{ "type": "text", "text": "deep thought" }] }
        }),
        json!({
            "type": "user", "parent_tool_use_id": 7,
            "message": { "content": [{ "type": "tool_result", "tool_use_id": "x", "content": "odd" }] }
        }),
        // 빈 글 · null 은 메인 줄이다
        json!({
            "type": "assistant", "parent_tool_use_id": null,
            "message": { "content": [{ "type": "text", "text": "main A" }] }
        }),
        json!({
            "type": "assistant", "parent_tool_use_id": "",
            "message": { "content": [{ "type": "text", "text": "main B" }] }
        }),
    ]);
    let depths: Vec<u64> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::WorkerStarted { depth, .. } => Some(*depth),
            _ => None,
        })
        .collect();
    assert_eq!(depths, [1, 2]);
    let texts: Vec<&str> = events
        .iter()
        .filter_map(|e| match e {
            SessionEvent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, ["main A", "main B"]);
}

#[test]
fn a_request_from_an_unknown_worker_still_carries_the_agent_id() {
    // 시작 알림보다 요청이 먼저 오는 경우 — 호출 ID · 이름은 모르고 작업자 ID 만
    let mut interp = interpreter();
    let out = interp.handle(&json!({
        "type": "control_request", "request_id": "r1",
        "request": {
            "subtype": "can_use_tool", "tool_name": "Write", "input": { "file_path": "C:\\p\\a.txt" },
            "tool_use_id": "inner1", "agent_id": "ghost"
        }
    }));
    let SessionEvent::PermissionRequest(info) = &out.events[0] else {
        panic!()
    };
    let worker = info.worker.as_ref().unwrap();
    assert_eq!(worker.agent_id, "ghost");
    assert_eq!(worker.tool_use_id, None);
    assert_eq!(worker.name, None);
    // 질문 카드도 같다
    let out = interp.handle(&json!({
        "type": "control_request", "request_id": "r2",
        "request": {
            "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "agent_id": "ghost",
            "input": { "questions": [{ "question": "Q?", "header": "H", "multiSelect": false,
                "options": [{ "label": "A", "description": "a" }, { "label": "B", "description": "b" }] }] }
        }
    }));
    let SessionEvent::QuestionRequest(info) = &out.events[0] else {
        panic!("{:?}", out.events)
    };
    assert_eq!(info.worker.as_ref().unwrap().agent_id, "ghost");
}
