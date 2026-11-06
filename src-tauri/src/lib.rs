pub mod agents;
pub mod claude;
pub mod commands;
pub mod db;
pub mod error;
pub mod harness;
pub mod history;
pub mod projects;
pub mod skills;
pub mod strings;
pub mod tray;
pub mod usage;

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
        // 폴더 고르기 대화상자 — Rust 에서만 부른다 (`projects::commands`). 화면 권한(`capabilities/`)에는 dialog 를 열지 않는다 (D-47).
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            log::info!(
                "{} {} started",
                app.package_info().name,
                app.package_info().version
            );
            tray::setup(app.handle())?;
            // 앱 DB (프로젝트 목록 · 세션 ID · 채팅 기록 · 츄르): 앱 데이터 폴더의 SQLite 하나. 못 열어도 앱은 뜨고, DB 를 쓰는 명령만 오류를 돌려준다 (P6-01).
            let app_data = app.path().app_data_dir()?;
            let app_db = db::AppDb::open(&app_data.join(db::DB_FILE));
            // 옛 `claude-sessions.json` 의 세션 ID 를 가져온다 (등록된 프로젝트의 것만). 못 맞춘(아직 등록 안 된 폴더) 항목이 남으면 파일을 그대로 두고,
            // 그 폴더를 등록할 때 다시 찾는다 (`projects::add`). 다 맞췄을 때만 파일 이름을 바꾼다. 실패해도 앱은 뜬다.
            claude::store::import_legacy(&app_db, &app_data.join(claude::store::LEGACY_FILE));
            // 세션 관리자 (Claude 연결): 이어 하기 세션 ID · 채팅 기록 · 츄르를 같은 DB 에 쓴다 (P6-03).
            app.manage(claude::session::SessionManager::new(
                claude::commands::TauriSink::new(app.handle().clone()),
                app_db.clone(),
                claude::session::ManagerConfig::default(),
            ));
            app.manage(app_db);
            // 하네스 일(받기 · 업데이트 · 설치 · 되돌리기)은 한 번에 하나 (P4-02).
            app.manage(harness::HarnessState::default());
            // 사용량 한도 읽기: 받은 값을 잠깐 기억하고 한 번에 하나만 읽는다 (P5-01).
            app.manage(usage::UsageState::default());
            app.manage(projects::ProjectsState::new(app_data));
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
            harness::commands::harness_status,
            harness::commands::harness_clone,
            harness::commands::harness_update_check,
            harness::commands::harness_update_pull,
            harness::commands::harness_install_plan,
            harness::commands::harness_install,
            harness::commands::harness_backups,
            harness::commands::harness_restore_plan,
            harness::commands::harness_restore,
            agents::commands::agents_list,
            skills::commands::skills_list,
            usage::commands::usage_read,
            projects::commands::projects_list,
            projects::commands::project_pick_folder,
            projects::commands::project_add,
            projects::commands::project_update,
            projects::commands::project_remove,
            projects::commands::project_touch,
            projects::commands::project_requirements_read,
            projects::commands::project_requirements_version,
            projects::commands::project_requirements_write,
            history::commands::project_chat_history,
            history::commands::app_usage_summary,
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
