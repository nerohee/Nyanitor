//! 알림 · 트레이 상태 시험 (P8-01) — 가짜 CLI 가 녹화본을 재생해 **진짜 세션 관리자**가 내보낸 이벤트를 `attention::decide::Tracker` 에 처음부터 끝까지 넣는다.
//! 창 · 알림 · 트레이는 가짜다 (`Host`) — 알림이 정확히 한 번 결정되는지, 창이 앞에 있으면 결정되지 않는지, 트레이 상태가 어떻게 바뀌는지를 본다.

mod common;

use std::cell::Cell;
use std::fs;
use std::time::SystemTime;

use common::*;
use nyanitor_lib::attention::Mood;
use nyanitor_lib::attention::decide::{
    BURST_MS, Effect, Host, Notice, NoticeKind, ProgressSnapshot, Tracker, WindowState,
};
use nyanitor_lib::claude::events::{Response, SessionEvent, TurnOutcome};
use nyanitor_lib::projects::progress;

struct FakeHost {
    window: Cell<WindowState>,
    /// 가짜 시계 — 읽을 때마다 `BURST_MS` 만큼 간다 (알림이 몰리지 않는 보통 경우)
    now: Cell<u64>,
}

const HIDDEN: WindowState = WindowState {
    visible: false,
    minimized: false,
    focused: false,
};
const FRONT: WindowState = WindowState {
    visible: true,
    minimized: false,
    focused: true,
};

impl FakeHost {
    fn new(window: WindowState) -> Self {
        Self {
            window: Cell::new(window),
            now: Cell::new(1_000_000),
        }
    }
}

impl Host for FakeHost {
    fn window(&self) -> WindowState {
        self.window.get()
    }
    fn project_name(&self, project_id: i64) -> Option<String> {
        (project_id == 1).then(|| "시험 프로젝트".to_string())
    }
    fn now_ms(&self) -> u64 {
        let now = self.now.get();
        self.now.set(now + BURST_MS);
        now
    }
}

/// 이벤트를 차례로 넣고 모인 일을 돌려준다
fn run(tracker: &mut Tracker, host: &FakeHost, events: &[SessionEvent]) -> Vec<Effect> {
    events
        .iter()
        .flat_map(|event| tracker.on_event(event, host))
        .collect()
}

fn notices(effects: &[Effect]) -> Vec<Notice> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Notify(n) => Some(n.clone()),
            _ => None,
        })
        .collect()
}

fn moods(effects: &[Effect]) -> Vec<Mood> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::SetMood(m) => Some(*m),
            _ => None,
        })
        .collect()
}

fn turn_end(event: &SessionEvent) -> Option<TurnOutcome> {
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

/// 허락 요청 하나를 허용해 턴이 성공으로 끝나고 세션이 정상으로 끝나기까지의 이벤트
fn permission_flow(name: &str) -> (Harness, Vec<SessionEvent>) {
    let mut h = Harness::new(name);
    let cmd = h.fake("permission-allow", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write a file").unwrap();
    let id = h.wait_for("permission", permission_id);
    h.manager.respond(&id, Response::Allow).unwrap();
    assert_eq!(h.wait_for("turn end", turn_end), TurnOutcome::Success);
    h.manager.stop().unwrap();
    h.wait_ended();
    let events = h.seen().to_vec();
    (h, events)
}

#[test]
fn a_permission_turn_from_start_to_end_notifies_once_and_the_mood_follows() {
    let (h, events) = permission_flow("attn-permission");
    let host = FakeHost::new(HIDDEN);
    let mut tracker = Tracker::new();
    let effects = run(&mut tracker, &host, &events);

    // 알림은 정확히 한 번 — 허락 요청 (턴 끝의 진행 문서는 아직 안 읽었으니 아직 없다)
    let list = notices(&effects);
    assert_eq!(list.len(), 1, "{list:#?}");
    assert_eq!(list[0].kind, NoticeKind::Approval);
    assert_eq!(list[0].title, "Nyanitor · 시험 프로젝트");
    assert!(
        list[0].body.starts_with("허락을 기다려요 — "),
        "{}",
        list[0].body
    );

    // 본문에 명령 · 경로 · 작업 폴더가 없다 (실제 요청에는 모두 있었다)
    let info = events
        .iter()
        .find_map(|e| match e {
            SessionEvent::PermissionRequest(p) => Some(p.clone()),
            _ => None,
        })
        .expect("a permission request was recorded");
    assert!(info.path.is_some() && !info.cwd.is_empty());
    let shown = format!("{} | {}", list[0].title, list[0].body);
    assert!(!shown.contains(&info.cwd), "{shown}");
    if let Some(path) = &info.path {
        assert!(!shown.contains(path.as_str()), "{shown}");
    }
    if let Some(command) = &info.command {
        assert!(!shown.contains(command.as_str()), "{shown}");
    }
    assert_eq!(list[0].body, format!("허락을 기다려요 — {}", info.tool));

    // 트레이: 일하는 중 → 기다림 (알린 할 일을 아직 안 봤으니 답한 뒤에도 기다림) → 세션이 끝나도 안 본 알림이 남는다
    assert_eq!(moods(&effects), [Mood::Working, Mood::Waiting]);
    assert_eq!(tracker.mood(), Mood::Waiting);
    assert!(!tracker.quit_warning(), "the session is over");
    // 창에서 보면 쉬는 중
    host.window.set(FRONT);
    assert_eq!(moods(&tracker.on_window_changed(&host)), [Mood::Idle]);
    drop(h);
}

#[test]
fn the_turn_end_reads_the_progress_documents_and_a_run_check_notifies() {
    let (h, events) = permission_flow("attn-progress");
    let host = FakeHost::new(HIDDEN);
    let mut tracker = Tracker::new();
    // 세션 중간까지만 — 턴이 끝난 시점의 일을 본다
    let end = events
        .iter()
        .position(|e| turn_end(e).is_some())
        .expect("the turn ended");
    let effects = run(&mut tracker, &host, &events[..=end]);
    // 읽기 부탁은 둘이다 — 세션을 시작할 때(단계 표의 처음 값)와 턴이 끝났을 때
    let tickets: Vec<_> = effects
        .iter()
        .filter_map(|e| match e {
            Effect::ReadProgress { ticket, project_id } => {
                assert_eq!(*project_id, 1);
                Some(*ticket)
            }
            _ => None,
        })
        .collect();
    assert_eq!(tickets.len(), 2, "a start read and a turn-end read");
    let (baseline, ticket) = (tickets[0], tickets[1]);

    // 프로젝트 폴더에 하네스 문서를 두고 진짜 읽기(`progress::read_in`)로 값을 만든다
    let dev = h.project.join("docs").join("02-development");
    fs::create_dir_all(&dev).unwrap();
    fs::write(
        dev.join("dev-plan.md"),
        "# 계획\n\n## 단계 개요\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P1 | 뼈대 | system | 실행 확인 | 완료 |\n",
    )
    .unwrap();
    fs::write(
        dev.join("handoff.md"),
        "# 이어 하기 메모\n\n- 지금 단계: P1\n\n## 지금 상태\n\n실행 확인 기다림\n\n## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 | 맡길 때 git | 보고 |\n|---|---|---|---|---|\n\n## 사용자에게 기다리는 것\n\n없음\n\n## 다음 할 일\n\n1. 확인\n",
    )
    .unwrap();
    let result = progress::read_in(&h.project, "docs", SystemTime::now());
    let snapshot = ProgressSnapshot::from_result(&result);

    // 시작 때 읽은 값은 알림을 정하지 않는다
    assert!(notices(&tracker.on_progress(baseline, &snapshot, &host)).is_empty());
    // 허락 알림을 이미 띄웠으니(안 본 할 일), 이어서 실행 확인 알림이 하나 더 정해진다
    let effects = tracker.on_progress(ticket, &snapshot, &host);
    let list = notices(&effects);
    assert_eq!(list.len(), 1, "{list:#?}");
    assert_eq!(list[0].kind, NoticeKind::RunCheck);
    // 같은 결과가 다시 와도 두 번 알리지 않는다
    assert!(notices(&tracker.on_progress(ticket, &snapshot, &host)).is_empty());
    drop(h);
}

#[test]
fn nothing_is_decided_for_a_whole_session_while_the_window_is_in_front() {
    let (h, events) = permission_flow("attn-front");
    let host = FakeHost::new(FRONT);
    let mut tracker = Tracker::new();
    let effects = run(&mut tracker, &host, &events);
    assert!(notices(&effects).is_empty(), "{effects:#?}");
    // 보고 있어도 트레이는 따라간다: 일하는 중 → 기다림(요청) → 일하는 중(답함) → 쉬는 중(턴 끝)
    assert_eq!(
        moods(&effects),
        [Mood::Working, Mood::Waiting, Mood::Working, Mood::Idle]
    );
    drop(h);
}

#[test]
fn a_question_notifies_as_a_question_and_answering_it_returns_the_mood() {
    let mut h = Harness::new("attn-question");
    let cmd = h.fake("question", &[]);
    h.start(&cmd).unwrap();
    h.manager.send_message("ask me").unwrap();
    let id = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some(q.request_id.clone()),
        _ => None,
    });
    let first_events = h.seen().to_vec();
    let host = FakeHost::new(FRONT);
    let mut tracker = Tracker::new();
    let effects = run(&mut tracker, &host, &first_events);
    assert!(notices(&effects).is_empty());
    assert_eq!(tracker.mood(), Mood::Waiting);
    assert!(tracker.quit_warning());

    // 창이 먼 때 같은 질문이 오면 알림이 하나 (질문 글이 단계 승인이 아니면 `question`)
    let away = FakeHost::new(HIDDEN);
    let mut tracker = Tracker::new();
    let effects = run(&mut tracker, &away, &first_events);
    let list = notices(&effects);
    assert_eq!(list.len(), 1, "{list:#?}");
    assert!(
        matches!(list[0].kind, NoticeKind::Question | NoticeKind::Approval),
        "{:?}",
        list[0].kind
    );
    assert_eq!(list[0].key, format!("req:{id}"));
    assert!(list[0].body.chars().count() <= 80);

    // 답하면 남은 요청이 없어진다
    h.manager
        .respond(
            &id,
            Response::Deny {
                message: Some("no".into()),
            },
        )
        .unwrap();
    h.wait_for("turn end", turn_end);
    let rest = h.seen()[first_events.len()..].to_vec();
    run(&mut tracker, &away, &rest);
    assert!(!tracker.quit_warning());
    h.manager.stop().unwrap();
}

#[test]
fn a_cli_that_dies_mid_turn_notifies_one_error_and_clears_the_waiting_cards() {
    let mut h = Harness::new("attn-die");
    let cmd = h.fake("permission-allow", &["free", "die-before-result"]);
    h.start(&cmd).unwrap();
    h.manager.send_message("write a file").unwrap();
    h.wait_for("card", permission_id);
    h.wait_ended();
    let events = h.seen().to_vec();

    let host = FakeHost::new(HIDDEN);
    let mut tracker = Tracker::new();
    let effects = run(&mut tracker, &host, &events);
    let list = notices(&effects);
    // 허락 요청 하나 + 죽음 하나
    assert_eq!(list.len(), 2, "{list:#?}");
    assert_eq!(list[0].kind, NoticeKind::Approval);
    assert_eq!(list[1].kind, NoticeKind::Error);
    assert_eq!(list[1].body, "먹물이 멈췄어요 — 창을 열어 확인해 주세요");
    // 세션이 끝났으니 남은 요청 · 턴이 없다 — 끝내기 전에 묻지 않는다. 안 본 알림만 기다림으로 남는다.
    assert!(!tracker.quit_warning());
    assert_eq!(tracker.mood(), Mood::Waiting);
    host.window.set(FRONT);
    assert_eq!(moods(&tracker.on_window_changed(&host)), [Mood::Idle]);
}
