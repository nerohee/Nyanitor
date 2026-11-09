//! 알림 · 트레이 상태의 Tauri 쪽 — 얇게. 결정은 `decide::Tracker` (순수) 가 한다.
//!
//! 스레드 하나(`attention`)가 줄(`mpsc`)로 일을 받는다: 세션 이벤트 · 창 포커스 · 읽은 진행 문서.
//! 줄에 넣는 쪽(세션 읽기 스레드 · 창 이벤트)은 **기다리지 않는다**. 창 상태 묻기(`is_visible` 등)는 메인 스레드의 답을 기다리므로
//! 세션 스레드가 아니라 이 스레드가 한다 — 앱이 끝나는 중에 세션 스레드가 막히지 않게.
//! 진행 문서는 파일 읽기라 느릴 수 있어 일마다 따로 스레드를 띄워 읽고, 결과를 같은 줄로 돌려보낸다 (이 스레드가 막히지 않는다).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::thread;

use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_log::log;
use tauri_plugin_notification::NotificationExt;

use super::decide::{
    Effect, Host, Notice, ProgressSnapshot, Ticket, Tracker, WindowState, is_relevant,
    state_needs_quit_warning,
};
use crate::claude::events::SessionEvent;
use crate::claude::session::SessionManager;
use crate::db::AppDb;
use crate::projects::{self, ProjectsState, progress};
use crate::tray;

enum Msg {
    /// 이벤트는 큰 편이라 상자에 담는다 (다른 낱말이 작다)
    Session(Box<SessionEvent>),
    /// 메인 창이 포커스를 얻었다 (알린 할 일을 봤는지 다시 본다)
    WindowChanged,
    Progress {
        ticket: Ticket,
        snapshot: ProgressSnapshot,
    },
}

#[derive(Default)]
struct Shared {
    /// 이 스레드가 마지막으로 본 "끝내기 전에 물어야 하나"
    quit_warning: AtomicBool,
}

/// 세션 이벤트 · 창 이벤트를 이 모듈에 넘기는 손잡이. 복제하면 같은 줄을 가리킨다.
#[derive(Clone)]
pub struct AttentionHandle {
    tx: Sender<Msg>,
    shared: Arc<Shared>,
}

impl AttentionHandle {
    /// 세션 이벤트를 넘긴다 (`TauriSink::emit` 가 내보낸 뒤 부른다). 기다리지 않는다 — 쓰지 않는 이벤트는 줄에 넣지도 않는다.
    pub fn session_event(&self, event: SessionEvent) {
        if is_relevant(&event) && self.tx.send(Msg::Session(Box::new(event))).is_err() {
            log::warn!("the attention thread is gone — a session event was dropped");
        }
    }

    /// 메인 창이 포커스를 얻었다 (`tray::handle_window_event`)
    pub fn window_focused(&self) {
        let _ = self.tx.send(Msg::WindowChanged);
    }

    /// 이벤트로 따라온 "끝내기 전에 물어야 하나" — 세션 관리자의 답과 함께 쓴다 (`quit_needs_warning`)
    fn quit_warning_hint(&self) -> bool {
        self.shared.quit_warning.load(Ordering::SeqCst)
    }
}

/// 트레이 "종료" 를 눌렀을 때 물어야 하나 — 턴이 돌거나 · 작업자가 일하거나 · 남은 요청이 있다.
/// 이벤트를 따라온 값과 세션 관리자의 지금 상태 중 하나라도 "그렇다" 면 묻는다 (일을 멈추는 쪽으로 틀리지 않게).
/// 세션 관리자의 잠금을 짧게 쥐므로 메뉴 처리기(메인 스레드)에서 부르지 않는다.
pub fn quit_needs_warning<R: Runtime>(app: &AppHandle<R>) -> bool {
    let tracked = app
        .try_state::<AttentionHandle>()
        .is_some_and(|handle| handle.quit_warning_hint());
    let live = app
        .try_state::<SessionManager>()
        .is_some_and(|manager| state_needs_quit_warning(&manager.state()));
    tracked || live
}

/// 이 모듈의 스레드를 띄운다.
pub fn start(app: AppHandle) -> AttentionHandle {
    let (tx, rx) = mpsc::channel::<Msg>();
    let shared = Arc::new(Shared::default());
    let handle = AttentionHandle {
        tx: tx.clone(),
        shared: Arc::clone(&shared),
    };
    let spawned = thread::Builder::new()
        .name("attention".into())
        .spawn(move || {
            let host = TauriHost { app: app.clone() };
            let mut tracker = Tracker::new();
            // 이 스레드가 보내는 쪽도 하나 쥐고 있어 줄이 닫히지 않는다 — 앱이 끝날 때까지 산다
            while let Ok(msg) = rx.recv() {
                let effects = match msg {
                    Msg::Session(event) => tracker.on_event(&event, &host),
                    Msg::WindowChanged => tracker.on_window_changed(&host),
                    Msg::Progress { ticket, snapshot } => {
                        tracker.on_progress(ticket, &snapshot, &host)
                    }
                };
                shared
                    .quit_warning
                    .store(tracker.quit_warning(), Ordering::SeqCst);
                for effect in effects {
                    apply(&app, &tx, effect);
                }
            }
        });
    if let Err(err) = spawned {
        log::error!("could not start the attention thread: {err}");
    }
    handle
}

fn apply(app: &AppHandle, tx: &Sender<Msg>, effect: Effect) {
    match effect {
        Effect::SetMood(mood) => tray::apply_mood(app, mood),
        Effect::Notify(notice) => show_notice(app, &notice),
        Effect::ReadProgress { ticket, project_id } => {
            let (app, tx) = (app.clone(), tx.clone());
            let spawned = thread::Builder::new()
                .name("attention-progress".into())
                .spawn(move || {
                    let snapshot = read_snapshot(&app, project_id);
                    let _ = tx.send(Msg::Progress { ticket, snapshot });
                });
            if let Err(err) = spawned {
                log::warn!("could not start a progress read for a notice: {err}");
            }
        }
    }
}

/// OS 알림을 띄운다. 실패해도 로그만 남기고 계속한다 (본문은 로그에 남기지 않는다).
fn show_notice(app: &AppHandle, notice: &Notice) {
    let shown = app
        .notification()
        .builder()
        .title(&notice.title)
        .body(&notice.body)
        .show();
    if let Err(err) = shown {
        log::warn!("could not show a {:?} notification: {err}", notice.kind);
    }
}

fn read_snapshot(app: &AppHandle, project_id: i64) -> ProgressSnapshot {
    let (Some(db), Some(state)) = (app.try_state::<AppDb>(), app.try_state::<ProjectsState>())
    else {
        return ProgressSnapshot::unreadable();
    };
    match progress::read(&db, &state.env(), project_id) {
        Ok(result) => ProgressSnapshot::from_result(&result),
        Err(err) => {
            log::info!("could not read the progress documents for a notice: {err}");
            ProgressSnapshot::unreadable()
        }
    }
}

struct TauriHost {
    app: AppHandle,
}

impl Host for TauriHost {
    fn window(&self) -> WindowState {
        let Some(window) = self.app.get_webview_window(tray::MAIN_WINDOW) else {
            return WindowState::default();
        };
        // 못 알아내면 "앞에 없다" 쪽으로 — 알림을 놓치는 것보다 한 번 더 뜨는 편이 낫다
        WindowState {
            visible: window.is_visible().unwrap_or(false),
            minimized: window.is_minimized().unwrap_or(false),
            focused: window.is_focused().unwrap_or(false),
        }
    }

    fn project_name(&self, project_id: i64) -> Option<String> {
        let db = self.app.try_state::<AppDb>()?;
        match db.read(|conn| projects::store::get(conn, project_id)) {
            Ok(row) => row.map(|row| row.name),
            Err(err) => {
                log::debug!("could not look up a project name for a notice: {err}");
                None
            }
        }
    }
}
