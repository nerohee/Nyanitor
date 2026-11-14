//! 메인 창의 화면(웹뷰) 보임 · 첫 창 바탕색 (D-55).
//!
//! Tauri 의 창 숨기기(`window.hide()`)는 OS 창만 숨기고 WebView2 컨트롤러는 그대로 "보임" 이라
//! `document.visibilityState` 가 `visible` 로 남아 화면의 애니메이션 · 주기 읽기가 계속 돈다.
//! 창이 안 보이게 되면(트레이로 숨김 · 최소화) 웹뷰도 숨기고(`Webview::hide` — `unstable` 기능 없이 쓸 수 있다),
//! 다시 보이면 되돌린다. 바뀔 때마다 화면에 `WINDOW_VISIBILITY_EVENT` 를 보낸다.
//! 정하는 로직(`VisibilityTracker` · `apply`)은 창 없이 시험할 수 있게 일반 함수로 둔다.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::webview::Webview;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, Runtime, Theme, Window};
use tauri_plugin_log::log;

use crate::tray::MAIN_WINDOW;

/// 메인 창의 화면이 보이게 되었거나 안 보이게 되었다 — 화면이 듣는 이벤트 이름
/// (`src/lib/ipc-types.ts` 의 `WINDOW_VISIBILITY_EVENT` 와 같이 바꾼다, D-55).
/// 내용은 `{ "visible": bool }`. 바뀔 때만 보낸다 (같은 값을 두 번 보내지 않는다). 앱이 처음 뜰 때는 보내지 않는다 (화면은 보이는 채로 시작).
pub const WINDOW_VISIBILITY_EVENT: &str = "app:window-visibility";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct WindowVisibility {
    visible: bool,
}

/// 웹뷰를 지금 보이는 것으로 두었는지 기억한다 — 같은 값으로 두 번 바꾸지 않으려고 (`Resized` 는 창을 끌 때 쉼 없이 온다).
/// 첫 창이 보이기 전(`begin` 전)에는 창 이벤트로 웹뷰를 건드리지 않는다 — window-state 가 창을 옮기며 내는 이벤트에 로딩 중인 화면이 숨지 않게.
pub struct VisibilityTracker {
    started: AtomicBool,
    shown: AtomicBool,
}

impl Default for VisibilityTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl VisibilityTracker {
    /// 웹뷰는 만들어질 때 보이는 채다
    pub fn new() -> Self {
        Self {
            started: AtomicBool::new(false),
            shown: AtomicBool::new(true),
        }
    }

    /// 첫 창 보이기가 시작되었다 — 이 뒤부터 창 이벤트가 웹뷰를 숨기고 보인다
    fn begin(&self) {
        self.started.store(true, Ordering::SeqCst);
    }

    fn is_started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }

    /// 이 값으로 바꾸려고 한다. 이미 같으면 `None`, 바뀌면 이전 값 (실패하면 `rollback`).
    fn claim(&self, visible: bool) -> Option<bool> {
        let previous = self.shown.swap(visible, Ordering::SeqCst);
        (previous != visible).then_some(previous)
    }

    fn rollback(&self, previous: bool) {
        self.shown.store(previous, Ordering::SeqCst);
    }
}

/// 화면이 보여야 하나 — 창이 보이고 최소화가 아닐 때만 (Windows 는 최소화된 창도 "보임" 으로 답한다)
pub fn webview_should_show(window_visible: bool, minimized: bool) -> bool {
    window_visible && !minimized
}

/// `apply` 의 결과
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    /// 이미 그 상태 — 아무것도 하지 않았다
    Unchanged,
    /// 웹뷰를 바꾸고 화면에 알렸다 (알림이 실패해도 웹뷰는 바뀐 것 — 상태를 되돌리지 않는다)
    Changed,
    /// 웹뷰를 바꾸지 못했다 — 상태를 그대로 두어 다음에 다시 시도한다
    Failed,
}

/// 웹뷰를 이 상태로 바꾸고 화면에 알린다. 이미 그 상태면 둘 다 부르지 않는다.
/// 웹뷰가 먼저다 — 알림이 먼저 가면 화면이 "보임" 을 믿고 일하다가 숨겨진다.
/// 웹뷰를 못 바꾸면 알리지 않고 상태를 되돌린다 (알리면 실제와 달라진다).
pub fn apply(
    tracker: &VisibilityTracker,
    visible: bool,
    set_webview: impl FnOnce(bool) -> Result<(), String>,
    notify: impl FnOnce(bool) -> Result<(), String>,
) -> Applied {
    let Some(previous) = tracker.claim(visible) else {
        return Applied::Unchanged;
    };
    if let Err(err) = set_webview(visible) {
        tracker.rollback(previous);
        log::warn!("could not {} the main webview: {err}", verb(visible));
        return Applied::Failed;
    }
    if let Err(err) = notify(visible) {
        log::warn!(
            "could not tell the screen that it is {}: {err}",
            state(visible)
        );
    }
    Applied::Changed
}

fn verb(visible: bool) -> &'static str {
    if visible { "show" } else { "hide" }
}

fn state(visible: bool) -> &'static str {
    if visible { "visible" } else { "hidden" }
}

/// 첫 창 보이기가 시작되었다고 기억한다 (`tray::show_main_window` 가 맨 먼저 부른다)
pub fn begin<R: Runtime>(app: &AppHandle<R>) {
    if let Some(tracker) = app.try_state::<VisibilityTracker>() {
        tracker.begin();
    }
}

/// 메인 웹뷰를 이 상태로 한다 (창을 방금 숨겼거나 보인 쪽이 부른다). 상태 기억이 없으면(시험) 아무것도 하지 않는다.
pub fn set_webview_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) -> Applied {
    let Some(tracker) = app.try_state::<VisibilityTracker>() else {
        return Applied::Unchanged;
    };
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("main window not found when changing its webview visibility");
        return Applied::Failed;
    };
    let webview: &Webview<R> = window.as_ref();
    apply(
        &tracker,
        visible,
        |visible| {
            (if visible {
                webview.show()
            } else {
                webview.hide()
            })
            .map_err(|err| err.to_string())
        },
        |visible| {
            app.emit(WINDOW_VISIBILITY_EVENT, WindowVisibility { visible })
                .map_err(|err| err.to_string())
        },
    )
}

/// 창의 실제 상태(보임 · 최소화)를 읽어 웹뷰를 맞춘다 — 창 크기 · 포커스 이벤트에서 부른다 (최소화 · 최소화 풀림 · 다른 길로 보임).
/// 첫 창이 보이기 전에는 하지 않고, 상태를 못 읽으면 그대로 둔다.
pub fn sync_with_window<R: Runtime>(window: &Window<R>) {
    let app = window.app_handle();
    let started = app
        .try_state::<VisibilityTracker>()
        .is_some_and(|tracker| tracker.is_started());
    if !started {
        return;
    }
    let (Ok(window_visible), Ok(minimized)) = (window.is_visible(), window.is_minimized()) else {
        return;
    };
    set_webview_visible(app, webview_should_show(window_visible, minimized));
}

// ───────────────────────── 첫 창 바탕색 ─────────────────────────

/// 밝은 테마 바탕 (`src/styles/tokens.css` 의 `--color-bg`, 크림 종이) — `tauri.conf.json` 의 `backgroundColor` 와 같다
pub const LIGHT_BACKGROUND: Color = Color(0xfb, 0xf8, 0xf3, 0xff);
/// 어두운 테마 바탕 (`--color-bg` 어둡게)
pub const DARK_BACKGROUND: Color = Color(0x1c, 0x1a, 0x17, 0xff);

/// OS 테마에 맞는 창 바탕색
pub fn background_for(theme: Theme) -> Color {
    match theme {
        Theme::Dark => DARK_BACKGROUND,
        _ => LIGHT_BACKGROUND,
    }
}

/// 메인 창이 처음 보이기 전에 바탕색을 OS 테마에 맞춘다 — 어두운 테마에서 흰 화면이 번쩍이지 않게.
/// 밝은 테마는 설정 파일의 값이 이미 맞다. 못 바꿔도 앱은 뜬다 (흰 깜빡임만 남는다).
pub fn paint_first_background<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let theme = match window.theme() {
        Ok(theme) => theme,
        Err(err) => {
            log::warn!("could not read the OS theme for the first background: {err}");
            return;
        }
    };
    if let Err(err) = window.set_background_color(Some(background_for(theme))) {
        log::warn!("could not set the first window background: {err}");
    }
}

// ───────────────────────── 큰 창 복원 ─────────────────────────

/// 창의 최소 크기 (논리 픽셀) — `tauri.conf.json` 의 `minWidth` · `minHeight` 와 같다 (시험이 맞는지 본다)
pub const MIN_WIDTH: u32 = 1024;
pub const MIN_HEIGHT: u32 = 540;

/// 화면 픽셀(물리) 사각형
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// `fit_to_work_area` 의 결과 — 바꿀 것만 담는다 (`Default` = 그대로 둔다)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Fit {
    /// 바꿀 안쪽(화면이 그려지는 영역) 크기
    pub inner_size: Option<(u32, u32)>,
    /// 바꿀 바깥 위치 (제목 줄 왼쪽 위)
    pub outer_position: Option<(i32, i32)>,
    /// 작업 영역이 최소 크기보다 작다 — 줄이지 않고 최대화한다
    pub maximize: bool,
}

/// 배율을 곱한 최소 안쪽 크기 (물리 픽셀)
pub fn min_inner_size(scale_factor: f64) -> (u32, u32) {
    // 이상한 배율(0 · NaN · 음수)이면 1 로 본다
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    (
        (f64::from(MIN_WIDTH) * scale).ceil() as u32,
        (f64::from(MIN_HEIGHT) * scale).ceil() as u32,
    )
}

/// window-state 가 되살린 창이 지금 있는 모니터의 작업 영역(작업 표시줄 제외)에 들어오게 계산한다 (순수 함수).
/// - 작업 영역이 최소 크기보다 작으면 줄이지 않고 `maximize` 만 켠다.
/// - 아니면 바깥 크기를 작업 영역 안으로 줄이되 최소 크기보다 작게는 줄이지 않는다.
/// - 줄인 뒤에도 창이 작업 영역 밖으로 나가 있으면(제목 줄이 밖이면) 안으로 옮긴다 — 이미 안에 있으면 옮기지 않는다.
/// - 작업 영역 크기가 0 이면 모니터 정보를 믿을 수 없다 — 그대로 둔다.
///
/// `outer` · `inner` 는 지금 창의 바깥 사각형 · 안쪽 크기 (둘의 차이가 제목 줄 · 테두리), `min_inner` 는 `min_inner_size`.
pub fn fit_to_work_area(outer: Rect, inner: (u32, u32), work: Rect, min_inner: (u32, u32)) -> Fit {
    if work.width == 0 || work.height == 0 {
        return Fit::default();
    }
    let frame_w = i64::from(outer.width) - i64::from(inner.0);
    let frame_h = i64::from(outer.height) - i64::from(inner.1);
    let (frame_w, frame_h) = (frame_w.max(0), frame_h.max(0));
    let min_outer_w = i64::from(min_inner.0) + frame_w;
    let min_outer_h = i64::from(min_inner.1) + frame_h;
    if i64::from(work.width) < min_outer_w || i64::from(work.height) < min_outer_h {
        return Fit {
            maximize: true,
            ..Fit::default()
        };
    }

    let width = i64::from(outer.width)
        .min(i64::from(work.width))
        .max(min_outer_w);
    let height = i64::from(outer.height)
        .min(i64::from(work.height))
        .max(min_outer_h);
    // 작업 영역 ≥ 최소 크기 이므로 아래 범위는 비지 않는다
    let x = i64::from(outer.x).clamp(
        i64::from(work.x),
        i64::from(work.x) + i64::from(work.width) - width,
    );
    let y = i64::from(outer.y).clamp(
        i64::from(work.y),
        i64::from(work.y) + i64::from(work.height) - height,
    );

    let mut fit = Fit::default();
    if width != i64::from(outer.width) || height != i64::from(outer.height) {
        // 안쪽 = 바깥 − 테두리 (최소 안쪽 크기 이상이 보장된다)
        fit.inner_size = Some(((width - frame_w) as u32, (height - frame_h) as u32));
    }
    if x != i64::from(outer.x) || y != i64::from(outer.y) {
        fit.outer_position = Some((x as i32, y as i32));
    }
    fit
}

fn rect_of(position: tauri::PhysicalPosition<i32>, size: tauri::PhysicalSize<u32>) -> Rect {
    Rect {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

/// 첫 창 보이기 전에, window-state 가 되살린 크기 · 위치가 지금 모니터의 작업 영역에 들어오게 한다.
/// 순서: `setup` 이 도는 때에는 `tauri.conf.json` 의 창이 이미 만들어져 있고 window-state 의 `on_window_ready` 가 저장된 크기 · 위치를 되살린 뒤이다
/// (`tauri-2.12.3 app.rs::setup` → 창 만들기 → 사용자 `setup`) — 그래서 `setup` 안에서 `show_main_window` 앞에 부른다. 창은 아직 숨어 있어 깜빡이지 않는다.
/// 이미 최대화로 되살아난 창은 건드리지 않는다 (OS 가 작업 영역에 맞춘다). 모니터 · 창 정보를 못 읽거나 바꾸지 못해도 앱은 뜬다 (로그만).
pub fn fit_first_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if window.is_maximized().unwrap_or(false) {
        return;
    }
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => monitor,
        Ok(None) => match window.primary_monitor() {
            Ok(Some(monitor)) => monitor,
            _ => return,
        },
        Err(err) => {
            log::warn!("could not read the monitor for the first window: {err}");
            return;
        }
    };
    let (Ok(position), Ok(outer), Ok(inner)) = (
        window.outer_position(),
        window.outer_size(),
        window.inner_size(),
    ) else {
        log::warn!("could not read the first window's size or position");
        return;
    };
    let work = monitor.work_area();
    let fit = fit_to_work_area(
        rect_of(position, outer),
        (inner.width, inner.height),
        rect_of(work.position, work.size),
        min_inner_size(monitor.scale_factor()),
    );
    if fit.maximize {
        if let Err(err) = window.maximize() {
            log::warn!("could not maximize the first window on a small screen: {err}");
        }
        return;
    }
    // 크기를 먼저 — 위치는 줄어든 크기를 기준으로 계산했다
    if let Some((width, height)) = fit.inner_size
        && let Err(err) = window.set_size(tauri::PhysicalSize::new(width, height))
    {
        log::warn!("could not fit the first window into the work area: {err}");
    }
    if let Some((x, y)) = fit.outer_position
        && let Err(err) = window.set_position(tauri::PhysicalPosition::new(x, y))
    {
        log::warn!("could not move the first window into the work area: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 부른 순서 · 값을 적어 두는 가짜 웹뷰 · 화면 알림
    struct Calls(RefCell<Vec<String>>);

    impl Calls {
        fn new() -> Self {
            Self(RefCell::new(Vec::new()))
        }
        fn run(
            &self,
            tracker: &VisibilityTracker,
            visible: bool,
            webview_ok: bool,
            notify_ok: bool,
        ) -> Applied {
            apply(
                tracker,
                visible,
                |v| {
                    self.0.borrow_mut().push(format!("webview:{v}"));
                    if webview_ok {
                        Ok(())
                    } else {
                        Err("boom".into())
                    }
                },
                |v| {
                    self.0.borrow_mut().push(format!("notify:{v}"));
                    if notify_ok {
                        Ok(())
                    } else {
                        Err("boom".into())
                    }
                },
            )
        }
        fn taken(&self) -> Vec<String> {
            self.0.borrow().clone()
        }
    }

    #[test]
    fn the_webview_shows_only_for_a_visible_window_that_is_not_minimized() {
        assert!(webview_should_show(true, false));
        assert!(!webview_should_show(false, false), "트레이에 숨김");
        assert!(
            !webview_should_show(true, true),
            "최소화 (Windows 는 보임 으로 답한다)"
        );
        assert!(!webview_should_show(false, true));
    }

    #[test]
    fn a_new_tracker_means_a_shown_webview_and_the_same_value_changes_nothing() {
        let tracker = VisibilityTracker::new();
        let calls = Calls::new();
        assert_eq!(calls.run(&tracker, true, true, true), Applied::Unchanged);
        assert!(
            calls.taken().is_empty(),
            "처음 값(보임)과 같으면 웹뷰도 화면도 건드리지 않는다"
        );
    }

    #[test]
    fn hiding_then_showing_calls_the_webview_first_and_then_tells_the_screen() {
        let tracker = VisibilityTracker::new();
        let calls = Calls::new();
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Changed);
        assert_eq!(calls.run(&tracker, true, true, true), Applied::Changed);
        assert_eq!(
            calls.taken(),
            [
                "webview:false",
                "notify:false",
                "webview:true",
                "notify:true"
            ]
        );
    }

    #[test]
    fn repeated_events_with_the_same_state_act_once() {
        // 최소화 뒤 `Resized` · `Focused` 가 여러 번 온다
        let tracker = VisibilityTracker::new();
        let calls = Calls::new();
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Changed);
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Unchanged);
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Unchanged);
        assert_eq!(calls.taken(), ["webview:false", "notify:false"]);
    }

    #[test]
    fn a_webview_that_will_not_hide_is_not_announced_and_is_retried_next_time() {
        let tracker = VisibilityTracker::new();
        let calls = Calls::new();
        assert_eq!(calls.run(&tracker, false, false, true), Applied::Failed);
        assert_eq!(
            calls.taken(),
            ["webview:false"],
            "못 숨겼는데 숨었다고 알리지 않는다"
        );
        // 상태가 되돌려져 있어서 다음 이벤트에서 다시 시도한다
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Changed);
        assert_eq!(
            calls.taken(),
            ["webview:false", "webview:false", "notify:false"]
        );
    }

    #[test]
    fn a_webview_that_will_not_show_again_stays_hidden_in_the_record_and_retries() {
        let tracker = VisibilityTracker::new();
        let calls = Calls::new();
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Changed);
        assert_eq!(calls.run(&tracker, true, false, true), Applied::Failed);
        // 숨은 채로 기록되어 있어서 다시 보이라는 요청이 또 실제로 간다
        assert_eq!(calls.run(&tracker, true, true, true), Applied::Changed);
        assert_eq!(
            calls.taken(),
            [
                "webview:false",
                "notify:false",
                "webview:true",
                "webview:true",
                "notify:true"
            ]
        );
    }

    #[test]
    fn a_failed_notice_keeps_the_new_state_because_the_webview_really_changed() {
        let tracker = VisibilityTracker::new();
        let calls = Calls::new();
        assert_eq!(calls.run(&tracker, false, true, false), Applied::Changed);
        assert_eq!(calls.run(&tracker, false, true, true), Applied::Unchanged);
    }

    #[test]
    fn window_events_do_nothing_before_the_first_show() {
        let tracker = VisibilityTracker::new();
        assert!(!tracker.is_started());
        tracker.begin();
        assert!(tracker.is_started());
    }

    #[test]
    fn the_event_payload_has_a_visible_field() {
        let json = serde_json::to_value(WindowVisibility { visible: false }).unwrap();
        assert_eq!(json, serde_json::json!({ "visible": false }));
    }

    #[test]
    fn the_first_background_follows_the_os_theme() {
        assert_eq!(background_for(Theme::Light), LIGHT_BACKGROUND);
        assert_eq!(background_for(Theme::Dark), DARK_BACKGROUND);
        assert_ne!(LIGHT_BACKGROUND, DARK_BACKGROUND);
    }

    // ── 큰 창 복원 ──

    /// 100% 배율의 테두리: 안쪽 + (16, 39) = 바깥
    fn at(x: i32, y: i32, inner: (u32, u32), scale_percent: u32) -> (Rect, (u32, u32)) {
        let frame = (16 * scale_percent / 100, 39 * scale_percent / 100);
        (
            Rect {
                x,
                y,
                width: inner.0 + frame.0,
                height: inner.1 + frame.1,
            },
            inner,
        )
    }

    fn work(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn fit(window: (Rect, (u32, u32)), work: Rect, scale_percent: u32) -> Fit {
        fit_to_work_area(
            window.0,
            window.1,
            work,
            min_inner_size(f64::from(scale_percent) / 100.0),
        )
    }

    #[test]
    fn a_window_that_already_fits_is_left_alone() {
        // 1920×1080 · 작업 표시줄 40
        let w = work(0, 0, 1920, 1040);
        assert_eq!(fit(at(100, 50, (1280, 800), 100), w, 100), Fit::default());
        // 작업 영역에 딱 맞는 창
        let exact = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            fit_to_work_area(exact, (1904, 1001), w, (1024, 540)),
            Fit::default()
        );
    }

    #[test]
    fn a_window_saved_on_a_big_monitor_shrinks_to_a_smaller_work_area() {
        // 4K 에서 3600×2000 으로 저장 → 1920×1080 (작업 영역 1920×1040) 에서 연다
        let result = fit(at(0, 0, (3600, 2000), 100), work(0, 0, 1920, 1040), 100);
        // 바깥 1920×1040 → 안쪽 1904×1001
        assert_eq!(result.inner_size, Some((1904, 1001)));
        assert_eq!(result.outer_position, None);
        assert!(!result.maximize);
        // 가로만 크거나 세로만 크다
        let wide = fit(at(0, 0, (3000, 700), 100), work(0, 0, 1920, 1040), 100);
        assert_eq!(wide.inner_size, Some((1904, 700)));
        let tall = fit(at(0, 0, (1400, 2000), 100), work(0, 0, 1920, 1040), 100);
        assert_eq!(tall.inner_size, Some((1400, 1001)));
    }

    #[test]
    fn a_window_whose_title_bar_is_off_the_work_area_is_moved_in() {
        let w = work(0, 0, 1920, 1040);
        // 위로 벗어남 (제목 줄을 잡을 수 없다)
        let up = fit(at(100, -80, (1280, 800), 100), w, 100);
        assert_eq!(up.outer_position, Some((100, 0)));
        assert_eq!(up.inner_size, None);
        // 아래 · 오른쪽으로 벗어남
        let down = fit(at(1500, 900, (1280, 800), 100), w, 100);
        assert_eq!(down.outer_position, Some((1920 - 1296, 1040 - 839)));
        // 왼쪽으로 벗어남
        let left = fit(at(-1200, 10, (1280, 800), 100), w, 100);
        assert_eq!(left.outer_position, Some((0, 10)));
    }

    #[test]
    fn a_second_monitor_with_a_negative_origin_or_an_offset_is_handled_in_its_own_coordinates() {
        // 왼쪽 모니터 (x 가 음수)
        let left = work(-1920, 0, 1920, 1040);
        assert_eq!(
            fit(at(-1800, 100, (1280, 800), 100), left, 100),
            Fit::default()
        );
        let spill = fit(at(-600, 100, (1280, 800), 100), left, 100);
        assert_eq!(spill.outer_position, Some((-1296, 100)));
        // 오른쪽 모니터 (x 가 1920 부터), 창이 첫 모니터 쪽으로 걸쳐 있음
        let right = work(1920, 0, 2560, 1400);
        let straddle = fit(at(1700, 100, (1280, 800), 100), right, 100);
        assert_eq!(straddle.outer_position, Some((1920, 100)));
        // 위로 올린 모니터 (y 가 음수)
        let above = work(0, -1080, 1920, 1040);
        let low = fit(at(0, 100, (1280, 800), 100), above, 100);
        assert_eq!(low.outer_position, Some((0, -1080 + 1040 - 839)));
    }

    #[test]
    fn scaled_monitors_use_physical_pixels_and_a_scaled_minimum() {
        // 150% : 작업 영역 2560×1400 물리 (논리 1706×933), 창 물리 3000×1900
        let result = fit(at(0, 0, (3000, 1900), 150), work(0, 0, 2560, 1400), 150);
        // 테두리 (24, 58) → 안쪽 2536×1342
        assert_eq!(result.inner_size, Some((2536, 1342)));
        assert!(!result.maximize);
        assert_eq!(min_inner_size(1.5), (1536, 810));
        assert_eq!(min_inner_size(1.25), (1280, 675));
        assert_eq!(min_inner_size(1.0), (1024, 540));
        // 200% : 작업 영역 1920×1040 물리 (논리 960×520) 는 최소 1024×540 논리보다 작다 → 최대화
        let small = fit(at(0, 0, (2400, 1200), 200), work(0, 0, 1920, 1040), 200);
        assert!(small.maximize);
        assert_eq!((small.inner_size, small.outer_position), (None, None));
    }

    #[test]
    fn a_work_area_smaller_than_the_minimum_maximizes_instead_of_shrinking() {
        // 가로가 모자람 (1024 미만) · 세로가 모자람 (540 미만)
        let narrow = fit(at(0, 0, (1280, 800), 100), work(0, 0, 1000, 1000), 100);
        assert!(narrow.maximize);
        let short = fit(at(0, 0, (1280, 800), 100), work(0, 0, 1920, 560), 100);
        assert!(short.maximize);
        // 테두리까지 넣어 딱 모자라는 경계: 바깥 최소 1040×579
        assert!(fit(at(0, 0, (1280, 800), 100), work(0, 0, 1039, 1000), 100).maximize);
        assert!(fit(at(0, 0, (1280, 800), 100), work(0, 0, 1920, 578), 100).maximize);
        let exact_min = fit(at(0, 0, (1280, 800), 100), work(0, 0, 1040, 579), 100);
        assert!(!exact_min.maximize);
        assert_eq!(exact_min.inner_size, Some((1024, 540)));
    }

    #[test]
    fn the_window_never_goes_below_the_minimum_even_if_it_was_saved_smaller() {
        // 저장된 크기가 최소보다 작아도 (최소 크기를 올린 뒤) 최소 크기로 맞춘다
        let small = fit(at(0, 0, (900, 500), 100), work(0, 0, 1920, 1040), 100);
        assert_eq!(small.inner_size, Some((1024, 540)));
        assert_eq!(small.outer_position, None);
    }

    #[test]
    fn a_work_area_without_size_is_not_trusted() {
        let window = at(5000, -300, (3000, 2000), 100);
        assert_eq!(fit(window, work(0, 0, 0, 0), 100), Fit::default());
        assert_eq!(fit(window, work(0, 0, 1920, 0), 100), Fit::default());
        assert_eq!(fit(window, work(0, 0, 0, 1080), 100), Fit::default());
    }

    #[test]
    fn extreme_numbers_do_not_overflow() {
        let huge = Rect {
            x: i32::MAX,
            y: i32::MIN,
            width: u32::MAX,
            height: u32::MAX,
        };
        let result = fit_to_work_area(
            huge,
            (u32::MAX, u32::MAX),
            work(0, 0, 1920, 1040),
            (1024, 540),
        );
        assert_eq!(result.inner_size, Some((1920, 1040)));
        assert_eq!(result.outer_position, Some((0, 0)));
        // 바깥이 안쪽보다 작게 읽혀도 (이상한 값) 터지지 않는다
        let odd = fit_to_work_area(
            Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            (500, 500),
            work(0, 0, 1920, 1040),
            (1024, 540),
        );
        assert_eq!(odd.inner_size, Some((1024, 540)));
    }

    #[test]
    fn odd_scale_factors_fall_back_to_one() {
        for scale in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            assert_eq!(min_inner_size(scale), (1024, 540), "{scale}");
        }
    }

    #[test]
    fn the_minimum_size_matches_the_window_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["minWidth"], MIN_WIDTH);
        assert_eq!(window["minHeight"], MIN_HEIGHT);
    }
}
