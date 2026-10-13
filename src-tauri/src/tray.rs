use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, Window, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use tauri_plugin_log::log;

use crate::strings;

/// `tauri.conf.json` 의 메인 창 이름 (창을 따로 정하지 않으면 `main`).
pub const MAIN_WINDOW: &str = "main";

const MENU_OPEN: &str = "open";
const MENU_QUIT: &str = "quit";

/// window-state 가 저장 · 복원할 항목. 보이는지(VISIBLE)는 넣지 않는다 —
/// 트레이에 숨긴 채 끝나도 다음 실행에는 창이 보이게 한다.
pub fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// 메인 창을 보이고, 최소화를 풀고, 앞으로 가져온다. 창이 없으면 아무것도 하지 않는다.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("main window not found when asked to show it");
        return;
    };
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
}

/// 메인 창의 닫기 요청은 막고 트레이로 숨긴다 (D-06). 완전 종료는 트레이 메뉴의 "종료".
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(err) = window.hide() {
            log::warn!("failed to hide the main window: {err}");
        }
    }
}

/// 창 상태를 저장하고 앱을 끝낸다. 숨겨진 채 끝나도 크기 · 위치가 남는다.
fn quit<R: Runtime>(app: &AppHandle<R>) {
    if let Err(err) = app.save_window_state(window_state_flags()) {
        log::warn!("failed to save window state before quit: {err}");
    }
    app.exit(0);
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, strings::TRAY_OPEN, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, strings::TRAY_QUIT, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit_item])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip(strings::TRAY_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => show_main_window(app),
            MENU_QUIT => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    // 임시로 앱 기본 아이콘을 쓴다 (트레이 전용 한 가지 색 아이콘은 디자인 단계에서).
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
