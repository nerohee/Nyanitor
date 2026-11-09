//! 알림 · 트레이 상태 결정 — 순수한 부분 (D-50). 창 · 파일 · OS 를 만지지 않는다.
//!
//! `Tracker` 는 세션 이벤트를 **차례로** 받아 (1) 트레이 상태 (2) 띄울 알림 (3) 읽어야 할 진행 문서를 `Effect` 로 돌려준다.
//! 창 상태 · 프로젝트 이름은 `Host` 로 바꿔 끼운다 (시험에서 가짜). 진행 문서는 느릴 수 있어 여기서 읽지 않고
//! `Effect::ReadProgress` 로 부탁한 뒤, 읽은 결과를 `on_progress` 로 돌려받는다 — 부르는 쪽이 다른 스레드에서 읽는다.
//!
//! 규칙 (`docs/01-planning/decisions.md` D-50):
//! - 메인 창이 보이고 · 최소화가 아니고 · 포커스가 있으면 알리지 않는다.
//! - 알림은 요청 번호마다 한 번, 턴 끝 알림은 턴마다 한 번.
//! - 트레이 상태: 기다림(남은 요청 · 알린 할 일을 아직 창에서 안 봄) > 일하는 중(턴이 도는 중 · 작업자) > 쉬는 중.

use std::collections::{BTreeSet, HashSet};

use crate::claude::events::{EndKind, SessionEvent, SessionState, TurnOutcome};
use crate::projects::progress::{
    HandoffResult, NowState, PhaseStatus, PlanResult, ProgressResult, Section,
};
use crate::strings;

use super::text;

/// 트레이가 보이는 상태
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mood {
    /// 쉬는 중
    Idle,
    /// 일하는 중
    Working,
    /// 기다림
    Waiting,
}

/// 알림의 종류 (D-50 의 할 일 다섯 가지)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    Question,
    Approval,
    RunCheck,
    PhaseDone,
    Error,
}

/// 띄울 알림 하나
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub kind: NoticeKind,
    pub title: String,
    pub body: String,
    /// 같은 알림을 두 번 띄우지 않으려고 기억한 열쇠 (`req:<요청 번호>` · `turn:<n>` · `end`)
    pub key: String,
}

/// 메인 창이 지금 어떤가
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WindowState {
    pub visible: bool,
    pub minimized: bool,
    pub focused: bool,
}

impl WindowState {
    /// 사용자가 지금 창을 보고 있다 (보이고 · 최소화가 아니고 · 포커스가 있다)
    pub fn in_front(self) -> bool {
        self.visible && !self.minimized && self.focused
    }
}

/// 바깥 세상을 묻는 자리 — 시험은 가짜로 바꿔 끼운다.
pub trait Host {
    fn window(&self) -> WindowState;
    /// 등록된 프로젝트의 이름 (모르면 `None`)
    fn project_name(&self, project_id: i64) -> Option<String>;
}

/// 읽은 진행 문서를 어디에 쓸 것인가
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TicketKind {
    /// 세션을 시작할 때 읽어 단계 표의 처음 값을 잡는다
    Baseline,
    /// `n` 번째 턴이 끝났을 때 — 알릴 것이 있는지 본다
    Turn(u64),
}

/// 진행 문서 읽기를 부탁한 표 — 결과가 돌아왔을 때 아직 그 세션 · 그 턴인지 가린다
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ticket {
    run: u64,
    kind: TicketKind,
}

/// 부르는 쪽이 해야 할 일
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// 트레이 모양을 바꾼다 (상태가 **바뀔 때만** 나온다)
    SetMood(Mood),
    Notify(Notice),
    /// 그 프로젝트의 진행 문서를 (다른 스레드에서) 읽어 `Tracker::on_progress` 로 돌려준다
    ReadProgress {
        ticket: Ticket,
        project_id: i64,
    },
}

// ───────────────────────── 진행 문서에서 필요한 것만 ─────────────────────────

/// 단계 표의 한 줄 (알림에 필요한 것만)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhaseView {
    pub id: String,
    pub name: Option<String>,
    pub done: bool,
}

/// `handoff.md` 의 지금 상태가 사용자에게 넘어왔는가
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    /// 아니다 (또는 못 읽었다)
    No,
    /// 사용자 답 기다림
    Answer,
    /// 실행 확인 기다림
    Run,
}

/// 읽은 진행 문서 — 못 읽은 부분은 "없음" 으로 둔다 (알리지 않는 쪽으로 기운다)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressSnapshot {
    pub waiting: Waiting,
    /// 단계 표를 읽었으면 `Some`
    pub phases: Option<Vec<PhaseView>>,
}

impl ProgressSnapshot {
    /// 아무것도 못 읽었다 (프로젝트 · DB · 폴더 · 문서 문제)
    pub fn unreadable() -> Self {
        Self {
            waiting: Waiting::No,
            phases: None,
        }
    }

    pub fn from_result(result: &ProgressResult) -> Self {
        let waiting = match &result.handoff {
            HandoffResult::Ok(info) => match &info.current {
                Section::Ok { value } => match value.state {
                    NowState::WaitingRun => Waiting::Run,
                    NowState::WaitingAnswer => Waiting::Answer,
                    _ => Waiting::No,
                },
                Section::Unreadable { .. } => Waiting::No,
            },
            HandoffResult::Absent | HandoffResult::Unreadable(_) => Waiting::No,
        };
        let phases = match &result.plan {
            PlanResult::Ok(plan) => Some(
                plan.phases
                    .iter()
                    .map(|phase| PhaseView {
                        id: phase.id.clone(),
                        name: phase.name.clone(),
                        done: phase.status == PhaseStatus::Done,
                    })
                    .collect(),
            ),
            PlanResult::Absent | PlanResult::Unreadable(_) => None,
        };
        Self { waiting, phases }
    }

    fn done_ids(&self) -> Option<BTreeSet<String>> {
        self.phases.as_ref().map(|phases| {
            phases
                .iter()
                .filter(|phase| phase.done)
                .map(|phase| phase.id.clone())
                .collect()
        })
    }
}

// ───────────────────────── 이벤트 고르기 ─────────────────────────

/// 이 이벤트를 `Tracker` 가 쓰는가 — 글 · 도구 줄 · 원본 로그처럼 많이 오는 것은 넘기지 않는다.
pub fn is_relevant(event: &SessionEvent) -> bool {
    matches!(
        event,
        SessionEvent::SessionStarted { .. }
            | SessionEvent::TurnStarted { .. }
            | SessionEvent::PermissionRequest(_)
            | SessionEvent::QuestionRequest(_)
            | SessionEvent::RequestAnswered { .. }
            | SessionEvent::RequestCancelled { .. }
            | SessionEvent::WorkerStarted { .. }
            | SessionEvent::WorkerEnded { .. }
            | SessionEvent::TurnEnded(_)
            | SessionEvent::SessionEnded { .. }
    )
}

/// `claude_session_state` 의 답으로 "끝내기 전에 물어야 하나" — 세션이 돌고 있고 턴이 돌거나 · 작업자가 일하거나 · 남은 요청이 있다.
pub fn state_needs_quit_warning(state: &SessionState) -> bool {
    state.running && (state.busy || !state.pending.is_empty() || !state.workers.is_empty())
}

// ───────────────────────── 추적기 ─────────────────────────

/// 지금 돌고 있는 세션에 대해 기억하는 것
struct SessionTrack {
    run: u64,
    project_id: Option<i64>,
    /// `TurnStarted` ~ `TurnEnded`
    busy: bool,
    /// 답을 기다리는 요청 번호
    pending: BTreeSet<String>,
    /// 일하는 작업자(작업을 부른 도구 호출 번호)
    workers: BTreeSet<String>,
    turns_ended: u64,
    /// 이미 알림을 정한 열쇠
    notified: HashSet<String>,
    /// 마지막으로 읽었을 때 완료였던 단계 (못 읽었으면 `None` — 처음 읽은 때부터 센다)
    baseline: Option<BTreeSet<String>>,
    /// 이번 턴(또는 이번 끝)에 오류 알림을 정했다 — 같은 일로 두 번 알리지 않으려고
    error_noticed: bool,
}

impl SessionTrack {
    fn new(run: u64, project_id: Option<i64>) -> Self {
        Self {
            run,
            project_id,
            busy: false,
            pending: BTreeSet::new(),
            workers: BTreeSet::new(),
            turns_ended: 0,
            notified: HashSet::new(),
            baseline: None,
            error_noticed: false,
        }
    }
}

pub struct Tracker {
    run_counter: u64,
    session: Option<SessionTrack>,
    /// 알린 할 일을 아직 창에서 안 봤다 (알림을 띄웠고 그 뒤 창이 보이며 포커스를 얻은 적 없음)
    unseen: bool,
    mood: Mood,
}

impl Default for Tracker {
    fn default() -> Self {
        Self::new()
    }
}

impl Tracker {
    pub fn new() -> Self {
        Self {
            run_counter: 0,
            session: None,
            unseen: false,
            mood: Mood::Idle,
        }
    }

    /// 지금 트레이 상태
    pub fn mood(&self) -> Mood {
        self.mood
    }

    /// 끝내기 전에 물어야 하나 (턴이 돌거나 · 작업자가 일하거나 · 남은 요청이 있다)
    pub fn quit_warning(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|s| s.busy || !s.workers.is_empty() || !s.pending.is_empty())
    }

    fn wanted_mood(&self) -> Mood {
        let session = self.session.as_ref();
        if self.unseen || session.is_some_and(|s| !s.pending.is_empty()) {
            Mood::Waiting
        } else if session.is_some_and(|s| s.busy || !s.workers.is_empty()) {
            Mood::Working
        } else {
            Mood::Idle
        }
    }

    /// 모은 일에 트레이 상태 변화를 덧붙여 돌려준다 (바뀌었을 때만)
    fn finish(&mut self, mut effects: Vec<Effect>) -> Vec<Effect> {
        let wanted = self.wanted_mood();
        if wanted != self.mood {
            self.mood = wanted;
            effects.push(Effect::SetMood(wanted));
        }
        effects
    }

    fn session_mut(&mut self) -> &mut SessionTrack {
        if self.session.is_none() {
            // `SessionStarted` 를 못 본 세션(앱이 중간에 붙음 · 시험) — 프로젝트를 모르는 세션으로 다룬다
            self.run_counter += 1;
            self.session = Some(SessionTrack::new(self.run_counter, None));
        }
        self.session
            .as_mut()
            .expect("the session was just created above")
    }

    /// 알림을 띄울지 정한다. 열쇠는 창 상태와 상관없이 기억한다 (같은 요청이 두 번 와도 한 번만).
    fn notice(
        &mut self,
        host: &dyn Host,
        key: String,
        kind: NoticeKind,
        body: String,
    ) -> Option<Effect> {
        let session = self.session.as_mut()?;
        if !session.notified.insert(key.clone()) {
            return None;
        }
        if host.window().in_front() {
            return None;
        }
        let name = session.project_id.and_then(|id| host.project_name(id));
        self.unseen = true;
        Some(Effect::Notify(Notice {
            kind,
            title: text::title(name.as_deref()),
            body,
            key,
        }))
    }

    pub fn on_event(&mut self, event: &SessionEvent, host: &dyn Host) -> Vec<Effect> {
        let mut effects = Vec::new();
        match event {
            SessionEvent::SessionStarted { project_id, .. } => {
                self.run_counter += 1;
                let session = SessionTrack::new(self.run_counter, Some(*project_id));
                effects.push(Effect::ReadProgress {
                    ticket: Ticket {
                        run: session.run,
                        kind: TicketKind::Baseline,
                    },
                    project_id: *project_id,
                });
                self.session = Some(session);
            }
            SessionEvent::TurnStarted { .. } => {
                let session = self.session_mut();
                session.busy = true;
                session.error_noticed = false;
            }
            SessionEvent::WorkerStarted { tool_use_id, .. } => {
                self.session_mut().workers.insert(tool_use_id.clone());
            }
            SessionEvent::WorkerEnded { tool_use_id, .. } => {
                self.session_mut().workers.remove(tool_use_id);
            }
            SessionEvent::PermissionRequest(info) => {
                self.session_mut().pending.insert(info.request_id.clone());
                // 본문은 도구 이름까지만 — 명령 · 경로 · 입력 · 작업 폴더를 싣지 않는다
                let body = text::permission_body(&info.tool);
                effects.extend(self.notice(
                    host,
                    format!("req:{}", info.request_id),
                    NoticeKind::Approval,
                    body,
                ));
            }
            SessionEvent::QuestionRequest(info) => {
                self.session_mut().pending.insert(info.request_id.clone());
                let first = info.questions.first();
                let question = first.map_or("", |q| q.question.as_str());
                let (kind, body) = match text::approval_title(question) {
                    Some((phase, name)) => (
                        NoticeKind::Approval,
                        text::stage_approval_body(&phase, &name),
                    ),
                    None => (
                        NoticeKind::Question,
                        text::question_body(first.and_then(|q| q.header.as_deref()), question),
                    ),
                };
                effects.extend(self.notice(host, format!("req:{}", info.request_id), kind, body));
            }
            SessionEvent::RequestAnswered { request_id, .. }
            | SessionEvent::RequestCancelled { request_id } => {
                self.session_mut().pending.remove(request_id);
            }
            SessionEvent::TurnEnded(summary) => {
                let session = self.session_mut();
                session.busy = false;
                session.turns_ended += 1;
                let turn = session.turns_ended;
                match summary.outcome {
                    TurnOutcome::Success => {
                        // 남은 요청 · 일하는 작업자가 있으면 아직 "내 차례" 가 아니다
                        if session.pending.is_empty()
                            && session.workers.is_empty()
                            && let Some(project_id) = session.project_id
                        {
                            effects.push(Effect::ReadProgress {
                                ticket: Ticket {
                                    run: session.run,
                                    kind: TicketKind::Turn(turn),
                                },
                                project_id,
                            });
                        }
                    }
                    TurnOutcome::Interrupted => {}
                    TurnOutcome::Error | TurnOutcome::Limit => {
                        session.error_noticed = true;
                        let body = if summary.outcome == TurnOutcome::Limit {
                            strings::NOTICE_LIMIT
                        } else {
                            strings::NOTICE_ERROR
                        };
                        effects.extend(self.notice(
                            host,
                            format!("turn:{turn}"),
                            NoticeKind::Error,
                            body.to_string(),
                        ));
                    }
                }
            }
            SessionEvent::SessionEnded {
                ended, mid_turn, ..
            } => {
                let died = *ended == EndKind::Died || *mid_turn;
                // 같은 일(오류로 끝난 턴 뒤에 CLI 가 죽음)로 두 번 알리지 않는다
                let already = self.session.as_ref().is_some_and(|s| s.error_noticed);
                if died && !already {
                    effects.extend(self.notice(
                        host,
                        "end".to_string(),
                        NoticeKind::Error,
                        strings::NOTICE_ERROR.to_string(),
                    ));
                }
                // 세션이 끝났다 — 요청 · 턴 · 작업자는 모두 없다. 아직 안 본 알림만 남는다.
                self.session = None;
            }
            _ => {}
        }
        self.finish(effects)
    }

    /// 창이 바뀌었다(포커스를 얻음 등) — 지금 창이 앞에 있으면 알린 할 일을 본 것으로 친다.
    pub fn on_window_changed(&mut self, host: &dyn Host) -> Vec<Effect> {
        if self.unseen && host.window().in_front() {
            self.unseen = false;
        }
        self.finish(Vec::new())
    }

    /// 진행 문서를 읽은 결과를 받는다. 그 세션 · 그 턴이 아니면(그사이 끝났거나 다음 턴이 시작됐으면) 버린다.
    pub fn on_progress(
        &mut self,
        ticket: Ticket,
        snapshot: &ProgressSnapshot,
        host: &dyn Host,
    ) -> Vec<Effect> {
        let mut effects = Vec::new();
        let Some(session) = self.session.as_mut() else {
            return effects;
        };
        if session.run != ticket.run {
            return effects;
        }
        match ticket.kind {
            TicketKind::Baseline => {
                // 처음 값은 한 번만 — 첫 턴 끝의 읽기가 먼저 도착했으면 그것이 처음 값이다
                if session.baseline.is_none() {
                    session.baseline = snapshot.done_ids();
                }
            }
            TicketKind::Turn(turn) => {
                if session.turns_ended != turn
                    || session.busy
                    || !session.pending.is_empty()
                    || !session.workers.is_empty()
                {
                    return effects;
                }
                // 새로 완료가 된 단계 — 여럿이면 표에서 마지막 것. 비교한 뒤에는 이번 읽은 값이 새 기준이다.
                let new_done = match (&session.baseline, &snapshot.phases) {
                    (Some(before), Some(phases)) => phases
                        .iter()
                        .rfind(|phase| phase.done && !before.contains(&phase.id)),
                    _ => None,
                };
                let phase_done =
                    new_done.map(|phase| text::phase_done_body(&phase.id, phase.name.as_deref()));
                if let Some(done) = snapshot.done_ids() {
                    session.baseline = Some(done);
                }
                // 실행 확인 > 답 기다림 > 단계 완료 — 턴마다 하나
                let chosen = match snapshot.waiting {
                    Waiting::Run => Some((NoticeKind::RunCheck, strings::NOTICE_RUN_CHECK.into())),
                    Waiting::Answer => Some((
                        NoticeKind::Question,
                        strings::NOTICE_WAITING_ANSWER.to_string(),
                    )),
                    Waiting::No => phase_done.map(|body| (NoticeKind::PhaseDone, body)),
                };
                if let Some((kind, body)) = chosen {
                    effects.extend(self.notice(host, format!("turn:{turn}"), kind, body));
                }
            }
        }
        self.finish(effects)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::events::{
        AnswerKind, PermissionRequestInfo, QuestionInfo, QuestionRequestInfo, TokenUsage,
        TurnSummary, WorkerOutcome,
    };
    use crate::projects::progress::{NowInfo, PhaseInfo, PlanInfo};
    use serde_json::json;
    use std::cell::Cell;

    // ── 가짜 바깥 세상 ──

    struct FakeHost {
        window: Cell<WindowState>,
        name: Option<String>,
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
        fn hidden() -> Self {
            Self {
                window: Cell::new(HIDDEN),
                name: Some("우리 집".into()),
            }
        }
        fn set(&self, window: WindowState) {
            self.window.set(window);
        }
    }

    impl Host for FakeHost {
        fn window(&self) -> WindowState {
            self.window.get()
        }
        fn project_name(&self, _: i64) -> Option<String> {
            self.name.clone()
        }
    }

    // ── 이벤트 만들기 ──

    fn started(project_id: i64) -> SessionEvent {
        SessionEvent::SessionStarted {
            project_id,
            project_dir: "C:\\p".into(),
            pid: 1,
            resumed: false,
            resume_session_id: None,
            cli_version: None,
            model: None,
            effort: None,
        }
    }

    fn turn_started() -> SessionEvent {
        SessionEvent::TurnStarted {
            session_id: "s".into(),
            model: None,
            cli_version: None,
            permission_mode: None,
            api_key_source: None,
        }
    }

    fn summary(outcome: TurnOutcome) -> TurnSummary {
        TurnSummary {
            outcome,
            subtype: None,
            is_error: outcome == TurnOutcome::Error,
            terminal_reason: None,
            result: None,
            errors: Vec::new(),
            api_error_status: None,
            duration_ms: None,
            num_turns: None,
            usage: TokenUsage::default(),
            cost_usd: 0.0,
            total_cost_usd: 0.0,
        }
    }

    fn turn_ended(outcome: TurnOutcome) -> SessionEvent {
        SessionEvent::TurnEnded(summary(outcome))
    }

    fn permission(id: &str) -> SessionEvent {
        SessionEvent::PermissionRequest(PermissionRequestInfo {
            request_id: id.into(),
            tool_use_id: Some("tu".into()),
            worker: None,
            tool: "Bash".into(),
            display_name: Some("Bash 실행".into()),
            description: Some("비밀 설명 SECRET-DESC".into()),
            command: Some("curl -H 'Authorization: SECRET-TOKEN' https://x".into()),
            path: Some("C:\\secret\\SECRET-PATH.txt".into()),
            cwd: "C:\\secret-cwd".into(),
            input: json!({ "command": "SECRET-INPUT" }),
            always_rule: None,
        })
    }

    fn question(id: &str, text: &str, header: Option<&str>) -> SessionEvent {
        SessionEvent::QuestionRequest(QuestionRequestInfo {
            request_id: id.into(),
            tool_use_id: None,
            worker: None,
            questions: vec![QuestionInfo {
                question: text.into(),
                header: header.map(str::to_string),
                multi_select: false,
                options: Vec::new(),
            }],
        })
    }

    fn answered(id: &str) -> SessionEvent {
        SessionEvent::RequestAnswered {
            request_id: id.into(),
            kind: AnswerKind::Allow,
            text: None,
            answers: None,
        }
    }

    fn cancelled(id: &str) -> SessionEvent {
        SessionEvent::RequestCancelled {
            request_id: id.into(),
        }
    }

    fn worker_started(id: &str) -> SessionEvent {
        SessionEvent::WorkerStarted {
            tool_use_id: id.into(),
            agent_id: None,
            name: "harness-builder-system".into(),
            description: None,
            background: false,
            depth: 1,
            at_ms: 0,
        }
    }

    fn worker_ended(id: &str) -> SessionEvent {
        SessionEvent::WorkerEnded {
            tool_use_id: id.into(),
            outcome: WorkerOutcome::Done,
            at_ms: 0,
        }
    }

    fn session_ended(ended: EndKind, mid_turn: bool) -> SessionEvent {
        SessionEvent::SessionEnded {
            ended,
            exit_code: Some(0),
            forced: false,
            mid_turn,
            stderr_tail: Vec::new(),
        }
    }

    // ── 도우미 ──

    fn notices(effects: &[Effect]) -> Vec<&Notice> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::Notify(n) => Some(n),
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

    fn reads(effects: &[Effect]) -> Vec<Ticket> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::ReadProgress { ticket, .. } => Some(*ticket),
                _ => None,
            })
            .collect()
    }

    /// 세션을 시작해 둔 추적기 (시작 때의 읽기 부탁은 따로 돌려받는다)
    fn running(host: &FakeHost) -> (Tracker, Ticket) {
        let mut tracker = Tracker::new();
        let effects = tracker.on_event(&started(7), host);
        let ticket = reads(&effects)[0];
        (tracker, ticket)
    }

    fn phase(id: &str, name: Option<&str>, done: bool) -> PhaseView {
        PhaseView {
            id: id.into(),
            name: name.map(str::to_string),
            done,
        }
    }

    fn snapshot(waiting: Waiting, phases: Option<Vec<PhaseView>>) -> ProgressSnapshot {
        ProgressSnapshot { waiting, phases }
    }

    /// 턴 하나를 돌리고 끝낸 뒤 턴 끝의 읽기 표를 돌려준다
    fn finish_turn(tracker: &mut Tracker, host: &FakeHost) -> Ticket {
        tracker.on_event(&turn_started(), host);
        let effects = tracker.on_event(&turn_ended(TurnOutcome::Success), host);
        let tickets = reads(&effects);
        assert_eq!(tickets.len(), 1, "a successful turn asks for one read");
        tickets[0]
    }

    // ── 권한 · 질문 ──

    #[test]
    fn a_permission_request_notifies_once_per_request_id_when_the_window_is_away() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let first = tracker.on_event(&permission("r1"), &host);
        let list = notices(&first);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, NoticeKind::Approval);
        assert_eq!(list[0].title, "Nyanitor · 우리 집");
        assert_eq!(list[0].body, "허락을 기다려요 — Bash");
        assert_eq!(list[0].key, "req:r1");
        // 같은 요청 번호가 또 와도 다시 알리지 않는다
        assert!(notices(&tracker.on_event(&permission("r1"), &host)).is_empty());
        // 다른 요청은 알린다
        assert_eq!(
            notices(&tracker.on_event(&permission("r2"), &host)).len(),
            1
        );
    }

    #[test]
    fn a_permission_notice_carries_only_the_tool_name() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let effects = tracker.on_event(&permission("r1"), &host);
        let notice = notices(&effects)[0];
        let shown = format!("{} | {}", notice.title, notice.body);
        for secret in [
            "SECRET-TOKEN",
            "SECRET-PATH",
            "SECRET-INPUT",
            "SECRET-DESC",
            "secret-cwd",
            "curl",
            "Bash 실행",
        ] {
            assert!(!shown.contains(secret), "{secret} leaked into {shown}");
        }
        assert_eq!(notice.body, "허락을 기다려요 — Bash");
    }

    #[test]
    fn nothing_is_decided_while_the_window_is_in_front() {
        let host = FakeHost::hidden();
        host.set(FRONT);
        let (mut tracker, _) = running(&host);
        for event in [
            permission("r1"),
            question("q1", "무엇을 할까요?", None),
            turn_ended(TurnOutcome::Error),
        ] {
            assert!(notices(&tracker.on_event(&event, &host)).is_empty());
        }
        // 앞에 있어도 남은 요청은 트레이를 "기다림" 으로 한다 (보고 있는 사람에게는 알림 없이)
        assert_eq!(tracker.mood(), Mood::Waiting);
    }

    #[test]
    fn a_visible_but_unfocused_or_minimized_window_still_gets_notices() {
        for window in [
            WindowState {
                visible: true,
                minimized: false,
                focused: false,
            },
            WindowState {
                visible: true,
                minimized: true,
                focused: true,
            },
            HIDDEN,
        ] {
            let host = FakeHost::hidden();
            host.set(window);
            let (mut tracker, _) = running(&host);
            assert_eq!(
                notices(&tracker.on_event(&permission("r1"), &host)).len(),
                1,
                "{window:?}"
            );
        }
    }

    #[test]
    fn a_stage_approval_question_is_an_approval_and_other_questions_are_questions() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let approval = tracker.on_event(
            &question(
                "q1",
                "단계 승인 — P8 알림 · 트레이\n- 무엇을: 알림",
                Some("승인"),
            ),
            &host,
        );
        let list = notices(&approval);
        assert_eq!(list[0].kind, NoticeKind::Approval);
        assert_eq!(list[0].body, "승인을 기다려요 — P8 알림 · 트레이");

        let plain = tracker.on_event(
            &question("q2", "어느 쪽으로 할까요?\n두 번째 줄", Some("방향")),
            &host,
        );
        let list = notices(&plain);
        assert_eq!(list[0].kind, NoticeKind::Question);
        assert_eq!(list[0].body, "먹물이 물어봐요 — 방향");

        // 머리말이 없으면 질문 첫 줄
        let no_header = tracker.on_event(&question("q3", "\n첫 줄이에요\n둘째", None), &host);
        assert_eq!(notices(&no_header)[0].body, "먹물이 물어봐요 — 첫 줄이에요");
    }

    #[test]
    fn a_long_question_notice_stays_within_eighty_characters() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let effects = tracker.on_event(&question("q1", &"아주 긴 질문 ".repeat(50), None), &host);
        let body = &notices(&effects)[0].body;
        assert!(body.chars().count() <= text::BODY_MAX_CHARS);
        assert!(body.ends_with('…'));
    }

    #[test]
    fn the_title_is_plain_nyanitor_when_the_project_name_is_unknown() {
        let host = FakeHost {
            window: Cell::new(HIDDEN),
            name: None,
        };
        let (mut tracker, _) = running(&host);
        let effects = tracker.on_event(&permission("r1"), &host);
        assert_eq!(notices(&effects)[0].title, "Nyanitor");
    }

    // ── 턴 끝 ──

    #[test]
    fn a_successful_turn_end_asks_for_the_progress_documents_once_nothing_is_left() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let ticket = finish_turn(&mut tracker, &host);
        assert_eq!(ticket.kind, TicketKind::Turn(1));
    }

    #[test]
    fn a_turn_end_with_a_pending_request_or_a_working_worker_reads_nothing() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        tracker.on_event(&permission("r1"), &host);
        assert!(reads(&tracker.on_event(&turn_ended(TurnOutcome::Success), &host)).is_empty());
        tracker.on_event(&cancelled("r1"), &host);

        tracker.on_event(&turn_started(), &host);
        tracker.on_event(&worker_started("w1"), &host);
        assert!(reads(&tracker.on_event(&turn_ended(TurnOutcome::Success), &host)).is_empty());
        tracker.on_event(&worker_ended("w1"), &host);
        // 작업자가 끝난 뒤의 다음 턴 끝은 읽는다
        let ticket = finish_turn(&mut tracker, &host);
        assert_eq!(ticket.kind, TicketKind::Turn(3));
    }

    #[test]
    fn an_interrupted_turn_notifies_nothing_and_reads_nothing() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        let effects = tracker.on_event(&turn_ended(TurnOutcome::Interrupted), &host);
        assert!(notices(&effects).is_empty());
        assert!(reads(&effects).is_empty());
    }

    #[test]
    fn waiting_for_a_run_check_notifies_run_check() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(ticket, &snapshot(Waiting::Run, None), &host);
        let list = notices(&effects);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, NoticeKind::RunCheck);
        assert_eq!(
            list[0].body,
            "실행해서 확인해 주세요 — 창을 열면 볼 것이 있어요"
        );
    }

    #[test]
    fn waiting_for_an_answer_notifies_a_question() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(ticket, &snapshot(Waiting::Answer, None), &host);
        let list = notices(&effects);
        assert_eq!(list[0].kind, NoticeKind::Question);
        assert_eq!(list[0].body, "먹물이 답을 기다려요");
    }

    #[test]
    fn an_unreadable_or_uninteresting_state_notifies_nothing() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(ticket, &ProgressSnapshot::unreadable(), &host);
        assert!(notices(&effects).is_empty());
        // 상태가 `between` · `working` 이고 새로 끝난 단계가 없을 때
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(
            ticket,
            &snapshot(Waiting::No, Some(vec![phase("P1", None, false)])),
            &host,
        );
        assert!(notices(&effects).is_empty());
        assert_eq!(tracker.mood(), Mood::Idle);
    }

    #[test]
    fn a_phase_done_notice_needs_a_phase_that_was_not_done_when_the_session_started() {
        let host = FakeHost::hidden();
        let (mut tracker, baseline) = running(&host);
        // 시작 때: P1 완료 · P2 진행 중
        tracker.on_progress(
            baseline,
            &snapshot(
                Waiting::No,
                Some(vec![
                    phase("P1", Some("뼈대"), true),
                    phase("P2", Some("연결"), false),
                ]),
            ),
            &host,
        );
        // 첫 턴: 아직 P1 만 완료 → 알림 없음 (이미 끝난 단계로는 알리지 않는다)
        let ticket = finish_turn(&mut tracker, &host);
        let same = snapshot(
            Waiting::No,
            Some(vec![
                phase("P1", Some("뼈대"), true),
                phase("P2", Some("연결"), false),
            ]),
        );
        assert!(notices(&tracker.on_progress(ticket, &same, &host)).is_empty());
        // 둘째 턴: P2 가 새로 완료 → 알림
        let ticket = finish_turn(&mut tracker, &host);
        let newly = snapshot(
            Waiting::No,
            Some(vec![
                phase("P1", Some("뼈대"), true),
                phase("P2", Some("연결"), true),
            ]),
        );
        let effects = tracker.on_progress(ticket, &newly, &host);
        let list = notices(&effects);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, NoticeKind::PhaseDone);
        assert_eq!(list[0].body, "P2 연결 단계가 끝났어요");
        // 셋째 턴: 같은 표 → 다시 알리지 않는다 (마지막으로 읽은 값이 새 기준)
        let ticket = finish_turn(&mut tracker, &host);
        assert!(notices(&tracker.on_progress(ticket, &newly, &host)).is_empty());
    }

    #[test]
    fn with_several_new_phases_the_last_one_is_named() {
        let host = FakeHost::hidden();
        let (mut tracker, baseline) = running(&host);
        let before = snapshot(
            Waiting::No,
            Some(vec![
                phase("P1", Some("가"), false),
                phase("P2", Some("나"), false),
                phase("P3", Some("다"), false),
            ]),
        );
        tracker.on_progress(baseline, &before, &host);
        let ticket = finish_turn(&mut tracker, &host);
        let now = snapshot(
            Waiting::No,
            Some(vec![
                phase("P1", Some("가"), true),
                phase("P2", Some("나"), true),
                phase("P3", Some("다"), false),
            ]),
        );
        let effects = tracker.on_progress(ticket, &now, &host);
        assert_eq!(notices(&effects)[0].body, "P2 나 단계가 끝났어요");
    }

    #[test]
    fn a_phase_without_a_name_is_named_by_its_number_only() {
        let host = FakeHost::hidden();
        let (mut tracker, baseline) = running(&host);
        tracker.on_progress(
            baseline,
            &snapshot(Waiting::No, Some(vec![phase("P1", None, false)])),
            &host,
        );
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(
            ticket,
            &snapshot(Waiting::No, Some(vec![phase("P1", None, true)])),
            &host,
        );
        assert_eq!(notices(&effects)[0].body, "P1 단계가 끝났어요");
    }

    #[test]
    fn without_a_starting_value_the_first_read_is_the_starting_value() {
        let host = FakeHost::hidden();
        // 시작 때 못 읽었다 (baseline 이 비어 있다)
        let (mut tracker, baseline) = running(&host);
        tracker.on_progress(baseline, &ProgressSnapshot::unreadable(), &host);
        // 첫 턴 끝에 처음 읽는다 — 이미 완료인 단계가 있어도 알리지 않는다
        let ticket = finish_turn(&mut tracker, &host);
        let first = snapshot(Waiting::No, Some(vec![phase("P1", Some("뼈대"), true)]));
        assert!(notices(&tracker.on_progress(ticket, &first, &host)).is_empty());
        // 그다음 턴부터 비교한다
        let ticket = finish_turn(&mut tracker, &host);
        let next = snapshot(
            Waiting::No,
            Some(vec![
                phase("P1", Some("뼈대"), true),
                phase("P2", Some("연결"), true),
            ]),
        );
        assert_eq!(
            notices(&tracker.on_progress(ticket, &next, &host))[0].body,
            "P2 연결 단계가 끝났어요"
        );
    }

    #[test]
    fn run_check_wins_over_phase_done_and_a_turn_gets_one_notice() {
        let host = FakeHost::hidden();
        let (mut tracker, baseline) = running(&host);
        tracker.on_progress(
            baseline,
            &snapshot(Waiting::No, Some(vec![phase("P1", Some("뼈대"), false)])),
            &host,
        );
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(
            ticket,
            &snapshot(Waiting::Run, Some(vec![phase("P1", Some("뼈대"), true)])),
            &host,
        );
        let list = notices(&effects);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, NoticeKind::RunCheck);
        // 같은 턴의 읽기 결과가 두 번 와도 한 번만
        assert!(
            notices(&tracker.on_progress(ticket, &snapshot(Waiting::Run, None), &host)).is_empty()
        );
    }

    #[test]
    fn the_progress_read_decides_with_the_window_state_at_the_time_it_arrives() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let ticket = finish_turn(&mut tracker, &host);
        // 읽는 동안 사용자가 창을 앞으로 가져왔다
        host.set(FRONT);
        let effects = tracker.on_progress(ticket, &snapshot(Waiting::Run, None), &host);
        assert!(notices(&effects).is_empty());
    }

    #[test]
    fn a_stale_progress_result_is_dropped() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let first = finish_turn(&mut tracker, &host);
        // 읽는 사이 다음 턴이 시작됐다
        tracker.on_event(&turn_started(), &host);
        let effects = tracker.on_progress(first, &snapshot(Waiting::Run, None), &host);
        assert!(notices(&effects).is_empty());
        // 요청이 남았을 때도 버린다
        let second = {
            let effects = tracker.on_event(&turn_ended(TurnOutcome::Success), &host);
            reads(&effects)[0]
        };
        tracker.on_event(&permission("r1"), &host);
        let effects = tracker.on_progress(second, &snapshot(Waiting::Run, None), &host);
        assert!(notices(&effects).is_empty());
        // 다른 세션의 결과도 버린다
        let (mut other, old_baseline) = running(&host);
        other.on_event(&started(8), &host);
        let effects = other.on_progress(old_baseline, &snapshot(Waiting::Run, None), &host);
        assert!(effects.is_empty());
        let ticket = finish_turn(&mut other, &host);
        other.on_event(&session_ended(EndKind::Normal, false), &host);
        assert!(
            other
                .on_progress(ticket, &snapshot(Waiting::Run, None), &host)
                .is_empty()
        );
    }

    // ── 오류 · 한도 · 죽음 ──

    #[test]
    fn a_failed_turn_a_limit_and_a_died_cli_each_notify_an_error() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        let failed = tracker.on_event(&turn_ended(TurnOutcome::Error), &host);
        let list = notices(&failed);
        assert_eq!(list[0].kind, NoticeKind::Error);
        assert_eq!(list[0].body, "먹물이 멈췄어요 — 창을 열어 확인해 주세요");

        tracker.on_event(&turn_started(), &host);
        let limit = tracker.on_event(&turn_ended(TurnOutcome::Limit), &host);
        assert_eq!(
            notices(&limit)[0].body,
            "사용량 한도에 닿았어요 — 창을 열어 확인해 주세요"
        );

        let (mut died, _) = running(&host);
        let effects = died.on_event(&session_ended(EndKind::Died, false), &host);
        assert_eq!(notices(&effects)[0].kind, NoticeKind::Error);

        // 정상으로 끝났지만 턴 도중이었다
        let (mut mid, _) = running(&host);
        mid.on_event(&turn_started(), &host);
        let effects = mid.on_event(&session_ended(EndKind::Normal, true), &host);
        assert_eq!(notices(&effects).len(), 1);
    }

    #[test]
    fn a_normal_end_between_turns_is_not_an_error() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        finish_turn(&mut tracker, &host);
        let effects = tracker.on_event(&session_ended(EndKind::Normal, false), &host);
        assert!(notices(&effects).is_empty());
    }

    #[test]
    fn a_failed_turn_followed_by_a_dying_cli_is_one_notice() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        assert_eq!(
            notices(&tracker.on_event(&turn_ended(TurnOutcome::Error), &host)).len(),
            1
        );
        let effects = tracker.on_event(&session_ended(EndKind::Died, false), &host);
        assert!(notices(&effects).is_empty());
    }

    #[test]
    fn a_new_session_may_notify_the_same_request_id_again() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        assert_eq!(
            notices(&tracker.on_event(&permission("req-1"), &host)).len(),
            1
        );
        tracker.on_event(&session_ended(EndKind::Normal, false), &host);
        tracker.on_event(&started(7), &host);
        assert_eq!(
            notices(&tracker.on_event(&permission("req-1"), &host)).len(),
            1
        );
    }

    // ── 트레이 상태 ──

    #[test]
    fn the_mood_goes_idle_working_waiting_and_back() {
        let host = FakeHost::hidden();
        let mut tracker = Tracker::new();
        assert_eq!(tracker.mood(), Mood::Idle);

        // 세션만 시작 — 아직 쉬는 중이라 바뀐 것이 없다
        assert!(moods(&tracker.on_event(&started(7), &host)).is_empty());

        assert_eq!(
            moods(&tracker.on_event(&turn_started(), &host)),
            [Mood::Working]
        );
        // 이미 일하는 중이면 같은 상태를 다시 내보내지 않는다
        assert!(moods(&tracker.on_event(&worker_started("w1"), &host)).is_empty());

        // 기다림 > 일하는 중
        assert_eq!(
            moods(&tracker.on_event(&permission("r1"), &host)),
            [Mood::Waiting]
        );
        // 답하면 일하는 중으로 — 그런데 알린 할 일을 아직 안 봤으므로 기다림이 이어진다
        assert!(moods(&tracker.on_event(&answered("r1"), &host)).is_empty());
        assert_eq!(tracker.mood(), Mood::Waiting);
        // 창에서 보면 일하는 중으로 돌아온다
        host.set(FRONT);
        assert_eq!(moods(&tracker.on_window_changed(&host)), [Mood::Working]);

        // 작업자 끝 + 턴 끝 → 쉬는 중
        assert!(moods(&tracker.on_event(&worker_ended("w1"), &host)).is_empty());
        assert_eq!(
            moods(&tracker.on_event(&turn_ended(TurnOutcome::Success), &host)),
            [Mood::Idle]
        );
    }

    #[test]
    fn answering_or_cancelling_a_request_returns_the_mood_when_it_was_seen() {
        // 창이 앞에 있어 알림 없이 요청이 쌓인 경우 — 답 · 취소로 되돌아간다
        let host = FakeHost::hidden();
        host.set(FRONT);
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        assert_eq!(tracker.mood(), Mood::Working);
        tracker.on_event(&question("q1", "물어요", None), &host);
        assert_eq!(tracker.mood(), Mood::Waiting);
        tracker.on_event(&answered("q1"), &host);
        assert_eq!(tracker.mood(), Mood::Working);
        tracker.on_event(&permission("r2"), &host);
        assert_eq!(tracker.mood(), Mood::Waiting);
        tracker.on_event(&cancelled("r2"), &host);
        assert_eq!(tracker.mood(), Mood::Working);
        tracker.on_event(&turn_ended(TurnOutcome::Interrupted), &host);
        assert_eq!(tracker.mood(), Mood::Idle);
    }

    #[test]
    fn the_end_of_a_session_clears_everything_but_an_unseen_notice() {
        let host = FakeHost::hidden();
        host.set(FRONT);
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        tracker.on_event(&worker_started("w1"), &host);
        tracker.on_event(&permission("r1"), &host);
        assert_eq!(tracker.mood(), Mood::Waiting);
        // 세션이 끝났다 (남은 요청 · 작업자는 모두 사라진다)
        let effects = tracker.on_event(&session_ended(EndKind::Normal, false), &host);
        assert_eq!(moods(&effects), [Mood::Idle]);
        assert!(!tracker.quit_warning());

        // 창이 먼 때 죽으면 알림이 남아 "기다림" 이 이어진다 — 창에서 보면 쉬는 중
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        tracker.on_event(&turn_started(), &host);
        let effects = tracker.on_event(&session_ended(EndKind::Died, true), &host);
        assert_eq!(notices(&effects).len(), 1);
        assert_eq!(tracker.mood(), Mood::Waiting);
        host.set(FRONT);
        assert_eq!(moods(&tracker.on_window_changed(&host)), [Mood::Idle]);
    }

    #[test]
    fn a_notice_keeps_the_mood_waiting_until_the_window_is_seen() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let ticket = finish_turn(&mut tracker, &host);
        let effects = tracker.on_progress(ticket, &snapshot(Waiting::Run, None), &host);
        assert_eq!(moods(&effects), [Mood::Waiting]);
        // 창이 보이기만 하고 포커스가 없으면 아직 안 본 것
        host.set(WindowState {
            visible: true,
            minimized: false,
            focused: false,
        });
        assert!(tracker.on_window_changed(&host).is_empty());
        assert_eq!(tracker.mood(), Mood::Waiting);
        // 최소화된 채 포커스 신호가 와도 본 것이 아니다
        host.set(WindowState {
            visible: true,
            minimized: true,
            focused: true,
        });
        assert!(tracker.on_window_changed(&host).is_empty());
        host.set(FRONT);
        assert_eq!(moods(&tracker.on_window_changed(&host)), [Mood::Idle]);
        // 한 번 본 뒤 다시 창이 바뀌어도 아무 일 없다
        assert!(tracker.on_window_changed(&host).is_empty());
    }

    #[test]
    fn the_mood_is_only_emitted_when_it_changes() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        let mut all = Vec::new();
        for event in [
            turn_started(),
            worker_started("w1"),
            worker_ended("w1"),
            turn_started(),
            turn_ended(TurnOutcome::Success),
        ] {
            all.extend(moods(&tracker.on_event(&event, &host)));
        }
        assert_eq!(all, [Mood::Working, Mood::Idle]);
    }

    // ── 끝내기 전 경고 ──

    #[test]
    fn quit_needs_a_warning_when_a_turn_runs_a_worker_works_or_a_request_waits() {
        let host = FakeHost::hidden();
        let (mut tracker, _) = running(&host);
        assert!(!tracker.quit_warning());
        tracker.on_event(&turn_started(), &host);
        assert!(tracker.quit_warning());
        tracker.on_event(&turn_ended(TurnOutcome::Success), &host);
        assert!(!tracker.quit_warning());
        tracker.on_event(&worker_started("w1"), &host);
        assert!(tracker.quit_warning());
        tracker.on_event(&worker_ended("w1"), &host);
        assert!(!tracker.quit_warning());
        tracker.on_event(&question("q1", "물어요", None), &host);
        assert!(tracker.quit_warning());
        tracker.on_event(&answered("q1"), &host);
        assert!(!tracker.quit_warning());
        // 알린 할 일을 아직 안 본 것만으로는 묻지 않는다 (일이 멈추는 것이 아니다)
        tracker.on_event(&turn_started(), &host);
        tracker.on_event(&turn_ended(TurnOutcome::Error), &host);
        assert_eq!(tracker.mood(), Mood::Waiting);
        assert!(!tracker.quit_warning());
    }

    fn state(running: bool, busy: bool, pending: usize, workers: usize) -> SessionState {
        SessionState {
            running,
            project_id: None,
            project_dir: None,
            pid: None,
            session_id: None,
            busy,
            pending: (0..pending).map(|_| turn_started()).collect(),
            workers: (0..workers).map(|_| turn_started()).collect(),
        }
    }

    #[test]
    fn the_session_state_decides_the_quit_warning_the_same_way() {
        assert!(!state_needs_quit_warning(&state(false, false, 0, 0)));
        assert!(!state_needs_quit_warning(&state(true, false, 0, 0)));
        assert!(state_needs_quit_warning(&state(true, true, 0, 0)));
        assert!(state_needs_quit_warning(&state(true, false, 1, 0)));
        assert!(state_needs_quit_warning(&state(true, false, 0, 2)));
        // 세션이 없으면 남은 값이 있어도 묻지 않는다
        assert!(!state_needs_quit_warning(&state(false, true, 1, 1)));
    }

    // ── 진행 문서 → 알림에 쓰는 값 ──

    fn plan_with(phases: Vec<(&str, Option<&str>, PhaseStatus)>) -> PlanResult {
        PlanResult::Ok(PlanInfo {
            phases: phases
                .into_iter()
                .map(|(id, name, status)| PhaseInfo {
                    id: id.into(),
                    summary: String::new(),
                    owners: Vec::new(),
                    owners_text: String::new(),
                    gate: String::new(),
                    status,
                    status_text: String::new(),
                    name: name.map(str::to_string),
                    goal: None,
                })
                .collect(),
        })
    }

    fn handoff_now(state: NowState) -> HandoffResult {
        use crate::projects::progress::HandoffInfo;
        HandoffResult::Ok(HandoffInfo {
            skill: None,
            requirements: None,
            phase: None,
            updated: None,
            current: Section::Ok {
                value: NowInfo {
                    state,
                    text: "x".into(),
                },
            },
            tasks: Section::Ok { value: Vec::new() },
            waiting: Section::Ok { value: Vec::new() },
            next: Section::Ok { value: Vec::new() },
        })
    }

    #[test]
    fn a_progress_result_becomes_a_snapshot() {
        let result = ProgressResult {
            version: "v".into(),
            plan: plan_with(vec![
                ("P1", Some("뼈대"), PhaseStatus::Done),
                ("P2", None, PhaseStatus::Now),
                ("P3", None, PhaseStatus::Unknown),
            ]),
            handoff: handoff_now(NowState::WaitingRun),
        };
        let snapshot = ProgressSnapshot::from_result(&result);
        assert_eq!(snapshot.waiting, Waiting::Run);
        assert_eq!(
            snapshot.phases,
            Some(vec![
                phase("P1", Some("뼈대"), true),
                phase("P2", None, false),
                phase("P3", None, false)
            ])
        );
        for (state, waiting) in [
            (NowState::WaitingAnswer, Waiting::Answer),
            (NowState::Working, Waiting::No),
            (NowState::Reviewing, Waiting::No),
            (NowState::Between, Waiting::No),
            (NowState::Unknown, Waiting::No),
        ] {
            let result = ProgressResult {
                version: "v".into(),
                plan: PlanResult::Absent,
                handoff: handoff_now(state),
            };
            assert_eq!(ProgressSnapshot::from_result(&result).waiting, waiting);
        }
    }

    #[test]
    fn missing_documents_become_an_empty_snapshot() {
        let result = ProgressResult {
            version: "v".into(),
            plan: PlanResult::Absent,
            handoff: HandoffResult::Absent,
        };
        assert_eq!(
            ProgressSnapshot::from_result(&result),
            ProgressSnapshot::unreadable()
        );
    }
}
