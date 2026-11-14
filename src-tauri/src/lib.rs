pub mod agents;
pub mod attention;
pub mod claude;
pub mod commands;
pub mod custom;
pub mod db;
pub mod e2e;
pub mod error;
pub mod harness;
pub mod harness_notice;
pub mod history;
pub mod log_scrub;
pub mod projects;
pub mod skills;
pub mod strings;
pub mod tray;
pub mod usage;
pub mod window;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, log};

/// 로그 파일 하나의 최대 크기. 넘으면 새 파일로 돌리고 오래된 것은 지운다.
const LOG_MAX_FILE_BYTES: u128 = 1_000_000;

/// 로그가 갈 곳 하나 — 줄 안의 사용자 홈 경로를 `~` 로 바꿔 적는다 (D-54 · D-55).
/// 목적지 형식은 플러그인 기본(시각 · 수준 · 대상 · 내용)을 그대로 두고, 그 완성된 줄을 받아 바꾼다.
fn scrubbed_target(kind: TargetKind, scrubber: Option<Arc<log_scrub::HomeScrubber>>) -> Target {
    Target::new(kind).format(move |out, line, _record| match &scrubber {
        Some(scrubber) => out.finish(format_args!("{}", scrubber.scrub(&line.to_string()))),
        None => out.finish(format_args!("{line}")),
    })
}

fn log_plugin() -> tauri_plugin_log::Builder {
    let scrubber = log_scrub::HomeScrubber::from_env().map(Arc::new);
    let mut builder = tauri_plugin_log::Builder::new()
        .clear_targets()
        .target(scrubbed_target(
            TargetKind::LogDir { file_name: None },
            scrubber.clone(),
        ))
        .max_file_size(LOG_MAX_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(5))
        .level(log::LevelFilter::Info);
    // 개발 빌드는 터미널에도 남긴다.
    if cfg!(debug_assertions) {
        builder = builder
            .target(scrubbed_target(TargetKind::Stdout, scrubber))
            .level(log::LevelFilter::Debug);
    }
    builder
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let mut builder = tauri::Builder::<tauri::Wry>::default();
    match e2e::data_root() {
        // E2E 시험 모드 (개발 빌드 + `NYANITOR_E2E_DIR`, `e2e.rs`): 앱 폴더를 모두 시험 폴더로 돌리고, single-instance 는 등록하지 않는다 (고객 앱이 떠 있어도 붙어서 꺼지지 않게).
        // window-state 는 메인 창을 빼고 등록한다 — 저장된 창 위치를 되살리지도 저장하지도 않는다. 아예 빼면 트레이 종료의 `save_window_state` 가 (플러그인 상태가 없어) 죽는다.
        // 이 플러그인의 파일 자리(`app_config_dir`)도 시험 폴더 안이다.
        Some(dirs) => {
            e2e::apply_to_config(context.config_mut(), dirs);
            builder = builder.plugin(
                tauri_plugin_window_state::Builder::default()
                    .with_state_flags(tray::window_state_flags())
                    .with_denylist(&[tray::MAIN_WINDOW])
                    .build(),
            );
        }
        None => {
            builder = builder
                // single-instance 는 다른 플러그인보다 먼저 등록해야 한다.
                .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
                    tray::show_main_window(app, tray::ShowCause::SecondInstance);
                }))
                .plugin(
                    tauri_plugin_window_state::Builder::default()
                        .with_state_flags(tray::window_state_flags())
                        .build(),
                );
        }
    }
    builder
        .plugin(log_plugin().build())
        // 폴더 고르기 대화상자 — Rust 에서만 부른다 (`projects::commands`). 화면 권한(`capabilities/`)에는 dialog 를 열지 않는다 (D-47).
        .plugin(tauri_plugin_dialog::init())
        // OS 알림 — Rust 에서만 띄운다 (`attention`). 화면 권한(`capabilities/`)에는 notification 을 열지 않는다 (D-50).
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // 시험 모드로 떴다는 것 (또는 환경 변수를 무시했다는 것) 을 로그 첫 줄로.
            e2e::announce();
            log::info!(
                "{} {} started",
                app.package_info().name,
                app.package_info().version
            );
            tray::setup(app.handle())?;
            // 알림 · 트레이 상태 (P8, D-50): 세션 이벤트를 받아 창이 앞에 없을 때만 OS 알림을 띄우고 트레이 모양을 바꾼다.
            let attention = attention::start(app.handle().clone());
            app.manage(attention.clone());
            // 앱 DB (프로젝트 목록 · 세션 ID · 채팅 기록 · 츄르): 앱 데이터 폴더의 SQLite 하나. 못 열어도 앱은 뜨고, DB 를 쓰는 명령만 오류를 돌려준다 (P6-01).
            let app_data = app.path().app_data_dir()?;
            // `--version` · `auth status` · `/usage` 같은 짧은 CLI 는 OS 의 공용 임시 폴더가 아니라 이 앱 전용 빈 폴더에서 돈다 (`claude/workdir.rs`, D-54).
            // 폴더는 띄우기 직전마다 만들고 비운다 — 못 알아내면 알리지 않고, 그 뒤 짧은 CLI 는 OS 임시 폴더에서 돈다 (경고를 남긴다).
            match app.path().app_local_data_dir() {
                Ok(local) => {
                    claude::workdir::init(local.join(claude::workdir::DIR_NAME));
                }
                Err(err) => log::warn!("could not find the app local data folder: {err}"),
            }
            let app_db = db::AppDb::open(&app_data.join(db::DB_FILE));
            // 옛 `claude-sessions.json` 의 세션 ID 를 가져온다 (등록된 프로젝트의 것만). 못 맞춘(아직 등록 안 된 폴더) 항목이 남으면 파일을 그대로 두고,
            // 그 폴더를 등록할 때 다시 찾는다 (`projects::add`). 다 맞췄을 때만 파일 이름을 바꾼다. 실패해도 앱은 뜬다.
            claude::store::import_legacy(&app_db, &app_data.join(claude::store::LEGACY_FILE));
            // 세션 관리자 (Claude 연결): 이어 하기 세션 ID · 채팅 기록 · 츄르를 같은 DB 에 쓴다 (P6-03).
            app.manage(claude::session::SessionManager::new(
                claude::commands::TauriSink::new(app.handle().clone(), attention),
                app_db.clone(),
                claude::session::ManagerConfig::default(),
            ));
            app.manage(app_db);
            // 하네스 일(받기 · 업데이트 · 설치 · 되돌리기)은 한 번에 하나 (P4-02).
            app.manage(harness::HarnessState::default());
            // 사용량 한도 읽기: 받은 값을 잠깐 기억하고 한 번에 하나만 읽는다 (P5-01).
            app.manage(usage::UsageState::default());
            app.manage(projects::ProjectsState::new(app_data));
            // 창이 숨겨지면 웹뷰도 숨기려고 보임 상태를 기억해 둔다 (`window.rs`, D-55).
            app.manage(window::VisibilityTracker::new());
            // 메인 창은 숨긴 채 만들어지고(`tauri.conf.json` 의 `visible: false`), window-state 가
            // 저장된 위치 · 크기로 옮긴 뒤 여기서 보인다 — 기본 위치에 잠깐 떴다가 옮겨지는 깜빡임을 막는다.
            // 보이기 전에 바탕색을 OS 테마에 맞춘다 — 어두운 테마에서 첫 화면이 흰색으로 번쩍이지 않게.
            window::paint_first_background(app.handle());
            // window-state 가 되살린 크기 · 위치가 지금 모니터의 작업 영역보다 크거나 밖이면 안으로 줄이고 옮긴다 (큰 모니터에서 저장한 창이 작은 화면에서 넘치지 않게).
            // 되살리기는 창을 만들 때 끝났으므로(`window::fit_first_window` 설명) 그 뒤 · 보이기 앞이다.
            window::fit_first_window(app.handle());
            tray::show_main_window(app.handle(), tray::ShowCause::Startup);
            // 지난번 하네스 일(설치 · 받기) 도중 앱이 꺼졌으면 알림 하나로 알린다 (`harness/interrupted.rs` 의 표시를 읽고 지운다, D-54).
            // 창 · 트레이가 준비된 뒤라 알림이 떠도 앱은 이미 쓸 수 있다. 앱 데이터 폴더를 못 알아내면 알리지 않는다.
            match app.path().app_data_dir() {
                Ok(dir) => harness_notice::announce_on_start(app.handle(), &dir),
                Err(err) => log::warn!("could not find the app data folder for the notice: {err}"),
            }
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
            custom::commands::custom_list,
            custom::commands::custom_item_read,
            custom::commands::custom_values_save,
            custom::commands::custom_append_save,
            custom::commands::custom_replace_start,
            custom::commands::custom_text_save,
            custom::commands::custom_replace_stop,
            custom::commands::custom_origin_keep,
            custom::commands::custom_new,
            custom::commands::custom_mine_delete,
            custom::commands::custom_changes,
            custom::commands::custom_discard,
            custom::commands::custom_apply,
            custom::commands::custom_history,
            custom::commands::custom_commit_diff,
            custom::commands::custom_restore,
            custom::commands::custom_cats_read,
            custom::commands::custom_cat_save,
            custom::commands::custom_cats_save,
            custom::commands::custom_labels_read,
            custom::commands::custom_label_save,
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
            projects::commands::project_progress_read,
            projects::commands::project_progress_version,
            projects::commands::project_docs_list,
            projects::commands::project_doc_read,
            projects::commands::project_trust_check,
            projects::commands::project_trust_grant,
            history::commands::project_chat_history,
            history::commands::app_usage_summary,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // 앱이 끝날 때 돌고 있는 세션을 정리한다 (stdin 닫기 → 안 끝나면 프로세스 트리 강제 종료).
            // 앱이 이 줄에 닿지 못하고 죽어도 Windows 는 Job Object 가, macOS · Linux 는 자식마다 붙은 감시 프로세스가 자식을 끈다 (`claude/process_tree.rs`).
            if let tauri::RunEvent::Exit = event {
                // 하네스 작업(설치 · 되돌리기 · 받기)이 도는 중에 끝나면 다음 실행이 알 수 있게 표시를 남긴다 (`harness/interrupted.rs`, D-54).
                // 세션을 정리하기 전에 — 표시는 끝내는 순간의 하네스 상태를 본다.
                if let (Some(state), Ok(dir)) = (
                    app.try_state::<harness::HarnessState>(),
                    app.path().app_data_dir(),
                ) {
                    harness::interrupted::note_exit(&dir, &state, history::usage::now_secs());
                }
                if let Some(manager) = app.try_state::<claude::session::SessionManager>() {
                    manager.shutdown();
                }
            }
        });
}
