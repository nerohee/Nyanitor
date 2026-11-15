//! 앱 업데이트의 Tauri 명령 · 플러그인 부르기 — 얇게: 순서 · 한 번에 하나 · 경고 규칙은 모두 `update` 모듈(`run_check` · `run_install`)에 있고,
//! 여기는 그 순서에 실제 플러그인(`tauri-plugin-updater`) 호출을 꽂아 줄 뿐이다.
//!
//! 화면이 넘기는 값은 `force`(경고를 보고도 설치하겠다) 하나뿐이다. 주소 · 키 · 경로를 받는 길은 없다 — 배포 주소와 공개 키는 `tauri.conf.json` 의 `plugins.updater`.
//! 화면 권한(`capabilities/`)에는 `updater:*` · `process:*` 를 열지 않는다. 이 플러그인의 화면용 명령(`plugin:updater|…`)은 권한이 없어 화면이 부를 수 없다.
//!
//! 끝내기 정리: 설치가 끝나면 앱을 다시 시작하는데, macOS · Linux 는 `request_restart` 가 `RunEvent::Exit` 를 거치므로 `lib.rs` 의 `exit_cleanup`(세션 정리 ·
//! 하네스 도중 끝남 표시)이 돈다. **Windows 는 설치 프로그램을 띄우고 업데이터가 `std::process::exit(0)` 으로 바로 끝내** `RunEvent::Exit` 가 오지 않으므로,
//! 업데이터의 "끝내기 직전" 훅(`before_exit`)에서 같은 정리를 직접 부른다.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_log::log;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};
use tauri_plugin_window_state::AppHandleExt;

use super::{
    InstallOutcome, InstallResult, NOTES_MAX_CHARS, ProgressFn, ReleaseInfo, UPDATE_EVENT,
    UpdateStatus, UpdateStore, WarningKind, auto_check_enabled, clean_date,
    install_unsupported_here, run_check, run_install, trim_notes,
};
use crate::attention;
use crate::claude::commands::blocking;
use crate::error::AppError;
use crate::tray;

/// 앱이 들고 있는 업데이트 상태 (Tauri `State`)
pub type AppUpdate = UpdateStore<Update>;

/// 시작 뒤 자동 확인까지 기다리는 시간 — 창이 보이고 첫 화면이 자리잡은 뒤
pub const STARTUP_CHECK_DELAY: Duration = Duration::from_secs(10);

/// 확인(`latest.json` 읽기) 시간 제한 — 안 두면 끊긴 네트워크에서 "확인 중" 이 끝나지 않는다
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// 받기 시간 제한 (요청 전체). 설치 파일은 수십 MB 라 확인보다 훨씬 길게 둔다.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// 상태가 바뀔 때마다 화면에 이벤트로 알리는 상태를 만든다 (`lib.rs` 의 setup 에서 `manage`)
pub fn new_state(app: AppHandle) -> AppUpdate {
    UpdateStore::new(move |status| {
        if let Err(err) = app.emit(UPDATE_EVENT, status) {
            log::warn!("could not emit an update event: {err}");
        }
    })
}

/// 업데이터의 "끝내기 직전" 훅이 돌았다 (Windows). 이 뒤에 설치 프로그램을 띄우지 못하면 앱은 반쯤 정리된 채로 남는다 — `app_update_install` 이 읽는다.
static EXIT_HOOK_RAN: AtomicBool = AtomicBool::new(false);

/// 앱을 끝내기 직전의 정리 — 창 위치 저장 + 돌던 세션 · 하네스 일 정리 + 창 · 트레이 치우기
/// (Windows 는 업데이터가 앱을 `RunEvent::Exit` 없이 끝내므로 업데이터 훅이 이것을 부른다).
fn before_exit(app: &AppHandle) {
    log::info!("update: the installer is about to end the app — cleaning up first");
    EXIT_HOOK_RAN.store(true, Ordering::SeqCst);
    save_window_state(app);
    crate::exit_cleanup(app);
    app.cleanup_before_exit();
}

fn save_window_state(app: &AppHandle) {
    if let Err(err) = app.save_window_state(tray::window_state_flags()) {
        log::warn!("failed to save window state before the update restart: {err}");
    }
}

/// 업데이터 하나 — 시간 제한과 끝내기 직전 훅을 붙인다. 설정(`plugins.updater`)이 깨졌으면 오류 글.
fn build_updater(app: &AppHandle, timeout: Duration) -> Result<Updater, String> {
    let for_exit = app.clone();
    app.updater_builder()
        .timeout(timeout)
        .on_before_exit(move || before_exit(&for_exit))
        .build()
        .map_err(|err| err.to_string())
}

fn release_of(update: &Update) -> ReleaseInfo {
    let (notes, notes_truncated) = trim_notes(update.body.as_deref(), NOTES_MAX_CHARS);
    ReleaseInfo {
        version: update.version.clone(),
        date: update
            .date
            .and_then(|date| clean_date(&date.date().to_string())),
        notes,
        notes_truncated,
    }
}

/// 플러그인으로 새 판을 확인한다 (실제 네트워크). 오류는 글로 돌려준다.
async fn plugin_check(app: &AppHandle) -> Result<Option<(ReleaseInfo, Update)>, String> {
    let updater = build_updater(app, CHECK_TIMEOUT)?;
    let found = updater.check().await.map_err(|err| err.to_string())?;
    Ok(found.map(|update| (release_of(&update), update)))
}

/// 지금 확인한다 (`silent` 는 시작 때 자동 확인 — 실패해도 화면에 오류를 내지 않는다)
pub async fn check_now(
    app: &AppHandle,
    store: &AppUpdate,
    silent: bool,
) -> Result<UpdateStatus, AppError> {
    run_check(store, silent, install_unsupported_here(), plugin_check(app)).await
}

/// 시작 때 한 번 자동으로 확인한다 — 출시 빌드만, 잠시 뒤. 실패는 로그만 (화면에는 아무것도 보이지 않는다).
pub fn start_auto_check(app: AppHandle) {
    if !auto_check_enabled(cfg!(debug_assertions)) {
        log::info!("update: no startup check in a debug build");
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("update-startup-check".into())
        .spawn(move || {
            std::thread::sleep(STARTUP_CHECK_DELAY);
            let store = app.state::<AppUpdate>().inner().clone();
            match tauri::async_runtime::block_on(check_now(&app, &store, true)) {
                Ok(status) => log::info!("update: startup check done ({})", status_name(&status)),
                // 사용자가 먼저 눌러 확인 중이다 — 그 결과를 쓴다
                Err(AppError::UpdateBusy) => log::info!("update: startup check skipped (busy)"),
                Err(err) => log::warn!("update: startup check failed: {err}"),
            }
        });
    if let Err(err) = spawned {
        log::warn!("could not start the update check thread: {err}");
    }
}

/// 로그에 남길 상태 이름 (내용은 남기지 않는다)
fn status_name(status: &UpdateStatus) -> &'static str {
    match status {
        UpdateStatus::Idle => "idle",
        UpdateStatus::Checking => "checking",
        UpdateStatus::Latest => "latest",
        UpdateStatus::Available { .. } => "available",
        UpdateStatus::Downloading { .. } => "downloading",
        UpdateStatus::Ready { .. } => "ready",
        UpdateStatus::Unsupported { .. } => "unsupported",
        UpdateStatus::Failed { .. } => "failed",
    }
}

/// 지금 앱을 끄면 안 되는 일 (트레이 "종료" 가 묻는 것과 같다). 세션 관리자의 잠금을 짧게 쥐므로 블로킹 풀에서 부른다.
async fn current_warning(app: AppHandle) -> Result<Option<WarningKind>, AppError> {
    blocking(move || Ok(attention::quit_warning(&app).map(WarningKind::from_quit))).await
}

/// 지금 상태 읽기 — 화면이 열릴 때 · 이벤트를 놓쳤을 때 (싸다)
#[tauri::command]
pub async fn app_update_status(state: State<'_, AppUpdate>) -> Result<UpdateStatus, AppError> {
    Ok(state.status())
}

/// 지금 확인 — 확인 중이거나 받는 중이면 `update_busy`, 이미 받아 둔 새 판이 있으면 그 상태 그대로
#[tauri::command]
pub async fn app_update_check(
    app: AppHandle,
    state: State<'_, AppUpdate>,
) -> Result<UpdateStatus, AppError> {
    let store = state.inner().clone();
    check_now(&app, &store, false)
        .await
        .map_err(AppError::logged)
}

/// 새 판 설치 — 받기 진행은 `UPDATE_EVENT` 로 보내고, 끝나면 다시 시작한다.
/// 앱을 끄면 안 되는 일(일하는 중 · 하네스 작업)이 있으면 `force` 없이는 설치하지 않고 `warning` 을 돌려준다.
#[tauri::command]
pub async fn app_update_install(
    app: AppHandle,
    state: State<'_, AppUpdate>,
    force: bool,
) -> Result<InstallResult, AppError> {
    let store = state.inner().clone();
    let warning_app = app.clone();
    let result = run_install(
        &store,
        force,
        move || current_warning(warning_app.clone()),
        |update: Update, progress: ProgressFn| async move {
            let mut update = update;
            update.timeout = Some(DOWNLOAD_TIMEOUT);
            update
                .download(move |chunk, total| progress(chunk as u64, total), || {})
                .await
                .map_err(|err| err.to_string())
        },
        |update: Update, bytes: Vec<u8>| async move {
            // 설치는 파일을 쓰고 설치 프로그램을 띄우므로 블로킹 풀에서 (Windows 는 여기서 앱이 끝난다)
            tauri::async_runtime::spawn_blocking(move || {
                update.install(bytes).map_err(|err| err.to_string())
            })
            .await
            .map_err(|err| format!("background task failed: {err}"))?
        },
    )
    .await
    .map_err(AppError::logged)?;
    if result.outcome == InstallOutcome::Failed && EXIT_HOOK_RAN.load(Ordering::SeqCst) {
        // 설치 프로그램을 띄우기 직전에 정리(세션 끝 · 창 숨김 · 트레이 치움)까지 했는데 띄우지 못했다 (Windows). 앱이 보이지 않는 채로 남지 않게 새로 시작한다 —
        // 다시 시작하면 지금 판으로 깨끗하게 뜨고, 새 판은 다음 확인에서 다시 받을 수 있다.
        log::error!(
            "update: the installer could not be started after the cleanup — restarting the app"
        );
        app.request_restart();
    }
    if result.outcome == InstallOutcome::Restarting {
        // 창 위치를 저장하고 다시 시작을 요청한다 — `RunEvent::Exit` 에서 세션 · 하네스 일을 정리한 뒤 새로 뜬다 (macOS · Linux)
        save_window_state(&app);
        app.request_restart();
    }
    Ok(result)
}
