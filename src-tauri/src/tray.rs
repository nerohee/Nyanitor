use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use tauri_plugin_log::log;

use crate::attention::{self, AttentionHandle, Mood};
use crate::strings;

/// `tauri.conf.json` 의 메인 창 이름 (창을 따로 정하지 않으면 `main`).
pub const MAIN_WINDOW: &str = "main";

/// 숨어 있던(또는 최소화였던) 창이 열렸다 — 화면이 듣는 이벤트 이름 (`src/lib/ipc-types.ts` 의 `WINDOW_SHOWN_EVENT` 와 같이 바꾼다, D-50 · D-25).
/// 내용은 `{ "reason": "tray" | "tray_menu" | "second_instance" }`. 앱이 처음 뜰 때(`ShowCause::Startup`)는 보내지 않는다.
pub const WINDOW_SHOWN_EVENT: &str = "app:window-shown";

const MENU_STATUS: &str = "status";
const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";

/// 트레이 아이콘 · 상태 줄을 나중에 고치려고 쥐고 있는 손잡이
struct TrayParts<R: Runtime> {
    tray: TrayIcon<R>,
    /// 메뉴 맨 위 상태 줄 (누를 수 없다)
    status: MenuItem<R>,
}

/// 창을 보이게 한 까닭
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShowCause {
    /// 앱이 처음 뜰 때 — 화면에 알리지 않는다
    Startup,
    /// 트레이 아이콘을 왼쪽으로 눌렀다
    Tray,
    /// 트레이 메뉴의 "열기"
    TrayMenu,
    /// 앱을 한 번 더 실행했다 (single-instance)
    SecondInstance,
}

impl ShowCause {
    fn reason(self) -> Option<&'static str> {
        match self {
            ShowCause::Startup => None,
            ShowCause::Tray => Some("tray"),
            ShowCause::TrayMenu => Some("tray_menu"),
            ShowCause::SecondInstance => Some("second_instance"),
        }
    }
}

#[derive(Clone, Serialize)]
struct WindowShown {
    reason: &'static str,
}

/// window-state 가 저장 · 복원할 항목. 보이는지(VISIBLE)는 넣지 않는다 —
/// 트레이에 숨긴 채 끝나도 다음 실행에는 창이 보이게 한다.
pub fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// 메인 창을 보이고, 최소화를 풀고, 앞으로 가져온다. 창이 없으면 아무것도 하지 않는다.
/// 창이 **숨어 있었거나 최소화였으면** 화면에 `WINDOW_SHOWN_EVENT` 를 보낸다 (`ShowCause::Startup` 은 빼고).
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>, cause: ShowCause) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("main window not found when asked to show it");
        return;
    };
    // 알 수 없으면 숨어 있던 것으로 본다 — 화면이 한 번 더 확인하는 편이 놓치는 것보다 낫다
    let was_away = !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true);
    // 최소화를 먼저 푼다. Windows 는 백그라운드 프로그램이 앞으로 나오는 것을 막아서(포커스 잠금)
    // set_focus 만으로는 다른 창 뒤에 남을 수 있다 — 잠깐 "항상 위" 로 올렸다 풀어 맨 위로 올린다.
    for (step, result) in [
        ("unminimize", window.unminimize()),
        ("show", window.show()),
        ("raise", window.set_always_on_top(true)),
        ("lower", window.set_always_on_top(false)),
        ("focus", window.set_focus()),
    ] {
        if let Err(err) = result {
            log::warn!("failed to {step} the main window: {err}");
        }
    }
    if was_away
        && let Some(reason) = cause.reason()
        && let Err(err) = app.emit(WINDOW_SHOWN_EVENT, WindowShown { reason })
    {
        log::warn!("could not tell the screen that the window was shown: {err}");
    }
}

/// 메인 창의 닫기 요청은 막고 트레이로 숨긴다 (D-06). 완전 종료는 트레이 메뉴의 "종료".
/// 창이 포커스를 얻으면 알림 쪽에 알린다 (알린 할 일을 창에서 봤는지 — D-50).
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            if let Err(err) = window.hide() {
                log::warn!("failed to hide the main window: {err}");
            }
        }
        WindowEvent::Focused(true) => {
            if let Some(handle) = window.try_state::<AttentionHandle>() {
                handle.window_focused();
            }
        }
        _ => {}
    }
}

/// 창 상태를 저장하고 앱을 끝낸다. 숨겨진 채 끝나도 크기 · 위치가 남는다.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = app.save_window_state(window_state_flags()) {
        log::warn!("failed to save window state before quit: {err}");
    }
    app.exit(0);
}

/// 종료 경고 대화상자가 떠 있다 (두 번 눌러도 하나만)
static QUIT_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

/// 트레이 "종료" — 쉬는 중이면 바로 끝내고, 일하는 중이면 먼저 묻는다 (D-06 · D-50).
/// 메뉴 처리기는 메인 스레드라 상태 확인은 따로 돌리고, 대화상자는 막지 않는 방식(`show` — 답이 오면 콜백)으로 띄운다.
fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !attention::quit_needs_warning(&app) {
            quit(&app);
            return;
        }
        if QUIT_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
            // 이미 떠 있다 — 다른 창 뒤에 숨었을 수 있다 (P8-03 점검 5)
            log::info!("the quit prompt is already open — ignoring another quit");
            return;
        }
        let quit_app = app.clone();
        let mut dialog = app
            .dialog()
            .message(strings::QUIT_MESSAGE)
            .title(strings::QUIT_TITLE)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                strings::QUIT_CONFIRM.into(),
                strings::QUIT_CANCEL.into(),
            ));
        // 메인 창이 보이면 그 위에 띄운다 (다른 창 뒤로 숨지 않게). 숨었거나 최소화면 그대로 — 트레이에서 누른 것이다.
        if let Some(window) = app.get_webview_window(MAIN_WINDOW)
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(true)
        {
            dialog = dialog.parent(&window);
        }
        dialog.show(move |confirmed| {
            QUIT_PROMPT_OPEN.store(false, Ordering::SeqCst);
            if confirmed {
                quit(&quit_app);
            }
        });
    });
}

// ───────────────────────── 아이콘 · 문구 ─────────────────────────

/// 트레이 아이콘 파일 두 벌 — 보통(32px) · 큰 화면(`@2x`, 64px). 바이너리에 넣어 둔다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IconSize {
    Standard,
    Hires,
}

/// 화면 배율이 150% 이상이면 큰 아이콘 (트레이 칸이 24px 이상이다). 100% · 125% 는 32px 을 줄여 쓴다.
fn icon_size_for(scale_factor: f64) -> IconSize {
    if scale_factor >= 1.5 {
        IconSize::Hires
    } else {
        IconSize::Standard
    }
}

fn icon_bytes(mood: Mood, size: IconSize) -> &'static [u8] {
    match (mood, size) {
        (Mood::Idle, IconSize::Standard) => include_bytes!("../icons/tray/tray-idle.png"),
        (Mood::Idle, IconSize::Hires) => include_bytes!("../icons/tray/tray-idle@2x.png"),
        (Mood::Working, IconSize::Standard) => include_bytes!("../icons/tray/tray-working.png"),
        (Mood::Working, IconSize::Hires) => include_bytes!("../icons/tray/tray-working@2x.png"),
        (Mood::Waiting, IconSize::Standard) => include_bytes!("../icons/tray/tray-waiting.png"),
        (Mood::Waiting, IconSize::Hires) => include_bytes!("../icons/tray/tray-waiting@2x.png"),
    }
}

fn tooltip(mood: Mood) -> &'static str {
    match mood {
        Mood::Idle => strings::TRAY_TOOLTIP_IDLE,
        Mood::Working => strings::TRAY_TOOLTIP_WORKING,
        Mood::Waiting => strings::TRAY_TOOLTIP_WAITING,
    }
}

fn status_line(mood: Mood) -> &'static str {
    match mood {
        Mood::Idle => strings::TRAY_STATUS_IDLE,
        Mood::Working => strings::TRAY_STATUS_WORKING,
        Mood::Waiting => strings::TRAY_STATUS_WAITING,
    }
}

/// 지금 주 모니터의 배율 (모르면 1배)
fn scale_factor<R: Runtime>(app: &AppHandle<R>) -> f64 {
    app.primary_monitor()
        .ok()
        .flatten()
        .map_or(1.0, |monitor| monitor.scale_factor())
}

fn mood_icon<R: Runtime>(app: &AppHandle<R>, mood: Mood) -> Option<Image<'static>> {
    let size = icon_size_for(scale_factor(app));
    match Image::from_bytes(icon_bytes(mood, size)) {
        Ok(icon) => Some(icon),
        Err(err) => {
            log::warn!("could not read the tray icon for {mood:?}: {err}");
            None
        }
    }
}

/// 트레이 모양(아이콘 · 툴팁 · 메뉴 상태 줄)을 이 상태로 바꾼다. 상태가 바뀔 때만 부른다 (`attention::decide::Tracker`).
pub fn apply_mood<R: Runtime>(app: &AppHandle<R>, mood: Mood) {
    let Some(parts) = app.try_state::<TrayParts<R>>() else {
        log::warn!("the tray is not ready — could not show {mood:?}");
        return;
    };
    if let Some(icon) = mood_icon(app, mood)
        && let Err(err) = parts.tray.set_icon(Some(icon))
    {
        log::warn!("could not change the tray icon: {err}");
    }
    if let Err(err) = parts.tray.set_tooltip(Some(tooltip(mood))) {
        log::warn!("could not change the tray tooltip: {err}");
    }
    if let Err(err) = parts.status.set_text(status_line(mood)) {
        log::warn!("could not change the tray status line: {err}");
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let mood = Mood::Idle;
    let status = MenuItem::with_id(app, MENU_STATUS, status_line(mood), false, None::<&str>)?;
    let open = MenuItem::with_id(app, MENU_OPEN, strings::TRAY_OPEN, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, strings::TRAY_QUIT, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&status, &separator, &open, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip(tooltip(mood))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main_window(app, ShowCause::TrayMenu),
            MENU_QUIT => request_quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle(), ShowCause::Tray);
            }
        });
    // 쉬는 중 아이콘으로 시작한다. 읽지 못하면 앱 기본 아이콘으로.
    if let Some(icon) = mood_icon(app, mood).or_else(|| app.default_window_icon().cloned()) {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    app.manage(TrayParts { tray, status });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_high_scale_picks_the_big_icon() {
        assert_eq!(icon_size_for(1.0), IconSize::Standard);
        assert_eq!(icon_size_for(1.25), IconSize::Standard);
        assert_eq!(icon_size_for(1.5), IconSize::Hires);
        assert_eq!(icon_size_for(2.0), IconSize::Hires);
        assert_eq!(icon_size_for(3.0), IconSize::Hires);
    }

    #[test]
    fn every_tray_icon_is_a_readable_png_of_the_expected_size() {
        for mood in [Mood::Idle, Mood::Working, Mood::Waiting] {
            for (size, side) in [(IconSize::Standard, 32), (IconSize::Hires, 64)] {
                let icon = Image::from_bytes(icon_bytes(mood, size))
                    .unwrap_or_else(|err| panic!("{mood:?} {size:?}: {err}"));
                assert_eq!(
                    (icon.width(), icon.height()),
                    (side, side),
                    "{mood:?} {size:?}"
                );
            }
        }
    }

    #[test]
    fn each_state_has_its_own_words() {
        let tips = [Mood::Idle, Mood::Working, Mood::Waiting].map(tooltip);
        assert_eq!(
            tips,
            [
                "Nyanitor — 쉬는 중",
                "Nyanitor — 일하는 중",
                "Nyanitor — 기다리고 있어요"
            ]
        );
        let lines = [Mood::Idle, Mood::Working, Mood::Waiting].map(status_line);
        assert_eq!(lines, ["쉬는 중", "일하는 중", "답을 기다려요"]);
    }

    #[test]
    fn only_a_real_reopen_tells_the_screen() {
        assert_eq!(ShowCause::Startup.reason(), None);
        assert_eq!(ShowCause::Tray.reason(), Some("tray"));
        assert_eq!(ShowCause::TrayMenu.reason(), Some("tray_menu"));
        assert_eq!(ShowCause::SecondInstance.reason(), Some("second_instance"));
    }

    #[test]
    fn the_event_payload_has_a_reason_field() {
        let json = serde_json::to_value(WindowShown { reason: "tray" }).unwrap();
        assert_eq!(json, serde_json::json!({ "reason": "tray" }));
    }
}
