pub mod claude;
pub mod commands;
pub mod error;
pub mod strings;
pub mod tray;

use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, log};

/// 로그 파일 하나의 최대 크기. 넘으면 새 파일로 돌리고 오래된 것은 지운다.
const LOG_MAX_FILE_BYTES: u128 = 1_000_000;

fn log_plugin() -> tauri_plugin_log::Builder {
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(Target::new(TargetKind::LogDir { file_name: None }))
        .max_file_size(LOG_MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .level(log::LevelFilter::Info);
    // 개발 빌드는 터미널에도 남긴다.
    if cfg!(debug_assertions) {
        builder = builder
            .target(Target::new(TargetKind::Stdout))
            .level(log::LevelFilter::Debug);
    }
    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 는 다른 플러그인보다 먼저 등록해야 한다.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_main_window(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tray::window_state_flags())
                .build(),
        )
        .plugin(log_plugin().build())
        .setup(|app| {
            log::info!(
                "{} {} started",
                app.package_info().name,
                app.package_info().version
            );
            tray::setup(app.handle())?;
            // 세션 관리자 (Claude 연결). 마지막 세션 ID 는 앱 데이터 폴더의 작은 JSON 파일에 둔다.
            let store = claude::store::ResumeStore::open(
                app.path().app_data_dir()?.join("claude-sessions.json"),
            );
            app.manage(claude::session::SessionManager::new(
                claude::commands::TauriSink::new(app.handle().clone()),
                store,
                claude::session::ManagerConfig::default(),
            ));
            // 메인 창은 숨긴 채 만들어지고(`tauri.conf.json` 의 `visible: false`), window-state 가
            // 저장된 위치 · 크기로 옮긴 뒤 여기서 보인다 — 기본 위치에 잠깐 떴다가 옮겨지는 깜빡임을 막는다.
            tray::show_main_window(app.handle());
            Ok(())
        })
        .on_window_event(tray::handle_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            claude::commands::claude_discover,
            claude::commands::claude_open_login,
            claude::commands::claude_session_start,
            claude::commands::claude_session_send,
            claude::commands::claude_session_respond,
            claude::commands::claude_session_interrupt,
            claude::commands::claude_session_stop,
            claude::commands::claude_session_state,
            claude::commands::claude_last_session,
            claude::commands::claude_raw_log,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // 앱이 끝날 때 돌고 있는 세션을 정리한다 (stdin 닫기 → 안 끝나면 프로세스 트리 강제 종료).
            // 앱이 이 줄에 닿지 못하고 죽어도 Job Object 가 자식을 끈다 (`claude/process_tree.rs`).
            if let tauri::RunEvent::Exit = event
                && let Some(manager) = app.try_state::<claude::session::SessionManager>()
            {
                manager.shutdown();
            }
        });
}
