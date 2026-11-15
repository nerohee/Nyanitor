use std::cell::Cell;
use std::ffi::OsStr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::async_runtime::block_on;

use super::*;

type Store = UpdateStore<u32>;
type Events = Arc<Mutex<Vec<UpdateStatus>>>;

fn store() -> (Store, Events) {
    let events: Events = Arc::default();
    let sink = Arc::clone(&events);
    let store = UpdateStore::new(move |status| sink.lock().unwrap().push(status.clone()));
    (store, events)
}

fn release(version: &str) -> ReleaseInfo {
    ReleaseInfo {
        version: version.into(),
        date: Some("2026-11-20".into()),
        notes: Some("- 고침".into()),
        notes_truncated: false,
    }
}

fn available(version: &str) -> UpdateStatus {
    UpdateStatus::Available {
        release: release(version),
    }
}

/// 확인 결과를 넣어 `Available` 로 만든다
fn found(store: &Store, version: &str) {
    let status = block_on(run_check(store, false, None, async {
        Ok(Some((release(version), 7u32)))
    }))
    .unwrap();
    assert_eq!(status, available(version));
}

fn no_warning() -> impl Fn() -> std::future::Ready<Result<Option<WarningKind>, AppError>> {
    || std::future::ready(Ok(None))
}

fn warning_of(
    kind: WarningKind,
) -> impl Fn() -> std::future::Ready<Result<Option<WarningKind>, AppError>> {
    move || std::future::ready(Ok(Some(kind)))
}

type Downloaded = Result<Vec<u8>, String>;

/// 받기를 부른 횟수를 세는 가짜 받기
fn download_ok(
    calls: &Cell<u32>,
) -> impl FnOnce(u32, ProgressFn) -> std::future::Ready<Downloaded> + '_ {
    move |_, progress| {
        calls.set(calls.get() + 1);
        progress(40, Some(100));
        progress(60, Some(100));
        std::future::ready(Ok(vec![1, 2, 3]))
    }
}

fn install_ok(
    calls: &Cell<u32>,
) -> impl FnOnce(u32, Vec<u8>) -> std::future::Ready<Result<(), String>> + '_ {
    move |_, bytes| {
        assert_eq!(bytes, vec![1, 2, 3]);
        calls.set(calls.get() + 1);
        std::future::ready(Ok(()))
    }
}

// ───────────────────────── 순수 함수 ─────────────────────────

#[test]
fn notes_are_trimmed_and_missing_ones_are_none() {
    assert_eq!(trim_notes(None, 10), (None, false));
    assert_eq!(trim_notes(Some(""), 10), (None, false));
    assert_eq!(trim_notes(Some("  \r\n\t "), 10), (None, false));
    assert_eq!(
        trim_notes(Some("  - 첫째\r\n- 둘째\r\n"), 100),
        (Some("- 첫째\n- 둘째".to_string()), false)
    );
}

#[test]
fn long_notes_are_cut_on_a_character_boundary() {
    // 정확히 한도면 자르지 않는다
    assert_eq!(
        trim_notes(Some("가나다라마"), 5),
        (Some("가나다라마".into()), false)
    );
    // 넘으면 글자(문자) 단위로 자른다 — 한글 한 글자가 둘로 갈라지지 않는다
    assert_eq!(
        trim_notes(Some("가나다라마바"), 5),
        (Some("가나다라마".into()), true)
    );
    // 자른 끝의 공백은 뗀다
    assert_eq!(
        trim_notes(Some("가나 다라마바"), 3),
        (Some("가나".into()), true)
    );
    // 실제 한도로도 같다
    let long = "x".repeat(NOTES_MAX_CHARS + 50);
    let (notes, truncated) = trim_notes(Some(&long), NOTES_MAX_CHARS);
    assert!(truncated);
    assert_eq!(notes.unwrap().chars().count(), NOTES_MAX_CHARS);
}

#[test]
fn error_messages_become_one_short_line() {
    assert_eq!(short_message("a\n  b\r\nc"), "a b c");
    let long = "e".repeat(MESSAGE_MAX_CHARS + 10);
    let cut = short_message(&long);
    assert_eq!(cut.chars().count(), MESSAGE_MAX_CHARS + 1);
    assert!(cut.ends_with('…'));
}

#[test]
fn only_a_linux_install_without_appimage_cannot_update_itself() {
    let appimage = OsStr::new("/home/me/Nyanitor.AppImage");
    assert_eq!(
        install_unsupported("linux", None),
        Some(UnsupportedReason::NotAppImage),
        "deb"
    );
    assert_eq!(
        install_unsupported("linux", Some(OsStr::new(""))),
        Some(UnsupportedReason::NotAppImage),
        "빈 환경 변수는 없는 것과 같다"
    );
    assert_eq!(install_unsupported("linux", Some(appimage)), None);
    // 다른 OS 는 APPIMAGE 와 상관없다
    assert_eq!(install_unsupported("windows", None), None);
    assert_eq!(install_unsupported("macos", None), None);
}

#[test]
fn only_release_builds_check_at_startup() {
    assert!(auto_check_enabled(false));
    assert!(!auto_check_enabled(true));
}

#[test]
fn dates_are_kept_only_in_the_plain_day_shape() {
    assert_eq!(clean_date("2026-11-20"), Some("2026-11-20".to_string()));
    for bad in [
        "",
        "2026-11-2",
        "2026/11/20",
        "2026-11-20T10:00:00Z",
        "abcd-ef-gh",
    ] {
        assert_eq!(clean_date(bad), None, "{bad}");
    }
}

#[test]
fn quit_warnings_map_to_update_warnings() {
    assert_eq!(
        WarningKind::from_quit(QuitWarning::Working),
        WarningKind::Working
    );
    assert_eq!(
        WarningKind::from_quit(QuitWarning::Harness(HarnessTask::Fetch)),
        WarningKind::HarnessFetch
    );
    assert_eq!(
        WarningKind::from_quit(QuitWarning::Harness(HarnessTask::Install)),
        WarningKind::HarnessInstall
    );
}

#[test]
fn statuses_serialize_with_a_state_tag_and_camel_case_fields() {
    let value = serde_json::to_value(available("0.2.0")).unwrap();
    assert_eq!(
        value,
        serde_json::json!({
            "state": "available",
            "release": { "version": "0.2.0", "date": "2026-11-20", "notes": "- 고침", "notesTruncated": false }
        })
    );
    let value = serde_json::to_value(UpdateStatus::Downloading {
        version: "0.2.0".into(),
        received: 5,
        total: None,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "state": "downloading", "version": "0.2.0", "received": 5, "total": null })
    );
    let value = serde_json::to_value(UpdateStatus::Failed {
        stage: FailStage::Download,
        message: "boom".into(),
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "state": "failed", "stage": "download", "message": "boom" })
    );
    let value = serde_json::to_value(UpdateStatus::Unsupported {
        reason: UnsupportedReason::NotAppImage,
        release: release("0.2.0"),
    })
    .unwrap();
    assert_eq!(value["state"], "unsupported");
    assert_eq!(value["reason"], "not_app_image");
    let value = serde_json::to_value(InstallResult {
        outcome: InstallOutcome::Warning,
        warning: Some(WarningKind::HarnessInstall),
        status: UpdateStatus::Idle,
    })
    .unwrap();
    assert_eq!(
        value,
        serde_json::json!({ "outcome": "warning", "warning": "harness_install", "status": { "state": "idle" } })
    );
}

// ───────────────────────── 확인 ─────────────────────────

#[test]
fn a_new_store_has_not_checked_yet() {
    let (store, events) = store();
    assert_eq!(store.status(), UpdateStatus::Idle);
    assert!(events.lock().unwrap().is_empty());
}

#[test]
fn a_check_goes_through_checking_to_latest() {
    let (store, events) = store();
    let status = block_on(run_check(&store, false, None, async { Ok(None) })).unwrap();
    assert_eq!(status, UpdateStatus::Latest);
    assert_eq!(
        *events.lock().unwrap(),
        vec![UpdateStatus::Checking, UpdateStatus::Latest]
    );
}

#[test]
fn a_found_release_becomes_available_with_its_notes() {
    let (store, _) = store();
    found(&store, "0.2.0");
    assert_eq!(store.status(), available("0.2.0"));
}

#[test]
fn a_release_on_an_install_that_cannot_update_is_unsupported_and_cannot_be_installed() {
    let (store, _) = store();
    let status = block_on(run_check(
        &store,
        false,
        Some(UnsupportedReason::NotAppImage),
        async { Ok(Some((release("0.2.0"), 7u32))) },
    ))
    .unwrap();
    assert_eq!(
        status,
        UpdateStatus::Unsupported {
            reason: UnsupportedReason::NotAppImage,
            release: release("0.2.0")
        }
    );
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let result = block_on(run_install(
        &store,
        true,
        no_warning(),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Unsupported);
    assert_eq!(
        (downloads.get(), installs.get()),
        (0, 0),
        "받지도 설치하지도 않는다"
    );
    assert_eq!(
        store.status(),
        status,
        "상태는 그대로 — 화면이 Releases 링크를 보인다"
    );
}

#[test]
fn a_failed_manual_check_is_a_failed_status_with_the_stage() {
    let (store, events) = store();
    let status = block_on(run_check(&store, false, None, async {
        Err::<Option<(ReleaseInfo, u32)>, _>(
            "error sending request\nfor url (https://x)".to_string(),
        )
    }))
    .unwrap();
    assert_eq!(
        status,
        UpdateStatus::Failed {
            stage: FailStage::Check,
            message: "error sending request for url (https://x)".into()
        }
    );
    assert_eq!(events.lock().unwrap().last(), Some(&status));
}

#[test]
fn a_failed_startup_check_shows_nothing_and_goes_back() {
    let (store, events) = store();
    let status = block_on(run_check(&store, true, None, async {
        Err::<Option<(ReleaseInfo, u32)>, _>("offline".to_string())
    }))
    .unwrap();
    assert_eq!(status, UpdateStatus::Idle);
    assert_eq!(store.status(), UpdateStatus::Idle);
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .all(|status| !matches!(status, UpdateStatus::Failed { .. })),
        "화면에 실패가 가지 않는다"
    );
    // 앞서 알아낸 상태가 있으면 그 상태로 돌아간다
    found(&store, "0.2.0");
    block_on(run_check(&store, true, None, async {
        Err::<Option<(ReleaseInfo, u32)>, _>("offline".to_string())
    }))
    .unwrap();
    assert_eq!(store.status(), available("0.2.0"));
    // 새 판 손잡이도 남아 있어 그대로 설치할 수 있다
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let result = block_on(run_install(
        &store,
        true,
        no_warning(),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Restarting);
}

#[test]
fn two_checks_at_the_same_time_run_only_once() {
    let (store, _) = store();
    let first = store.begin_check().unwrap().expect("첫 확인은 시작한다");
    assert!(matches!(store.begin_check(), Err(AppError::UpdateBusy)));
    assert_eq!(store.status(), UpdateStatus::Checking);
    // 끝나면 다시 확인할 수 있다
    first.finish(Ok(None), None, false);
    assert!(store.begin_check().unwrap().is_some());
}

#[test]
fn a_check_that_is_dropped_unfinished_frees_the_slot() {
    let (store, _) = store();
    let run = store.begin_check().unwrap().unwrap();
    drop(run);
    assert_eq!(store.status(), UpdateStatus::Idle);
    assert!(
        store.begin_check().unwrap().is_some(),
        "중단된 확인이 자리를 쥐고 있지 않다"
    );
}

#[test]
fn checking_again_never_throws_away_a_downloaded_update() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let installs = Cell::new(0);
    let downloads = Cell::new(0);
    // 경고 때문에 멈춰 `Ready` 로 남긴다
    let result = block_on(run_install(
        &store,
        false,
        {
            let asked = Cell::new(0);
            move || {
                asked.set(asked.get() + 1);
                // 받기 전에는 없고, 받은 뒤에 생겼다
                std::future::ready(Ok((asked.get() > 1).then_some(WarningKind::Working)))
            }
        },
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Warning);
    assert!(matches!(store.status(), UpdateStatus::Ready { .. }));
    let calls = Cell::new(false);
    let status = block_on(run_check(&store, false, None, async {
        calls.set(true);
        Ok(None)
    }))
    .unwrap();
    assert!(!calls.get(), "확인을 하지 않는다");
    assert!(matches!(status, UpdateStatus::Ready { .. }));
}

// ───────────────────────── 설치 ─────────────────────────

#[test]
fn installing_without_a_new_release_does_nothing() {
    let (store, events) = store();
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    for _ in 0..2 {
        let result = block_on(run_install(
            &store,
            true,
            no_warning(),
            download_ok(&downloads),
            install_ok(&installs),
        ))
        .unwrap();
        assert_eq!(result.outcome, InstallOutcome::NoUpdate);
        assert_eq!(result.status, UpdateStatus::Idle);
    }
    // 최신일 때도, 실패 뒤에도
    block_on(run_check(&store, false, None, async { Ok(None) })).unwrap();
    let result = block_on(run_install(
        &store,
        true,
        no_warning(),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::NoUpdate);
    assert_eq!((downloads.get(), installs.get()), (0, 0));
    assert_eq!(
        events.lock().unwrap().len(),
        2,
        "상태가 바뀐 것은 확인뿐이다"
    );
}

#[test]
fn a_warning_stops_the_install_before_anything_is_downloaded() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let result = block_on(run_install(
        &store,
        false,
        warning_of(WarningKind::HarnessInstall),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Warning);
    assert_eq!(result.warning, Some(WarningKind::HarnessInstall));
    assert_eq!(result.status, available("0.2.0"), "새 판은 그대로 남는다");
    assert_eq!((downloads.get(), installs.get()), (0, 0));
}

#[test]
fn force_installs_even_with_a_warning_and_never_asks_for_it() {
    let (store, events) = store();
    found(&store, "0.2.0");
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let asked = Cell::new(0);
    let result = block_on(run_install(
        &store,
        true,
        || {
            asked.set(asked.get() + 1);
            std::future::ready(Ok(Some(WarningKind::Working)))
        },
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Restarting);
    assert_eq!(result.warning, None);
    assert_eq!((downloads.get(), installs.get(), asked.get()), (1, 1, 0));
    // 받는 중 → (진행) → 설치 준비 끝
    let seen = events.lock().unwrap().clone();
    assert!(seen.contains(&UpdateStatus::Downloading {
        version: "0.2.0".into(),
        received: 0,
        total: None
    }));
    assert!(seen.contains(&UpdateStatus::Ready {
        version: "0.2.0".into()
    }));
}

#[test]
fn without_a_warning_the_install_downloads_then_installs() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let result = block_on(run_install(
        &store,
        false,
        no_warning(),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Restarting);
    assert_eq!((downloads.get(), installs.get()), (1, 1));
    // 설치를 넘긴 뒤에는 상태가 `Ready`, 일은 끝났다 (다시 눌러도 겹치지 않는다)
    assert_eq!(
        store.status(),
        UpdateStatus::Ready {
            version: "0.2.0".into()
        }
    );
}

#[test]
fn a_warning_that_appears_during_the_download_stops_before_installing_and_keeps_the_file() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let asked = Cell::new(0);
    let result = block_on(run_install(
        &store,
        false,
        || {
            asked.set(asked.get() + 1);
            // 받기 전에는 조용했고, 받는 사이 일이 시작됐다
            std::future::ready(Ok((asked.get() == 2).then_some(WarningKind::Working)))
        },
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Warning);
    assert_eq!(result.warning, Some(WarningKind::Working));
    assert_eq!(
        result.status,
        UpdateStatus::Ready {
            version: "0.2.0".into()
        }
    );
    assert_eq!((downloads.get(), installs.get()), (1, 0));
    // 사용자가 "그래도 설치" 를 고르면 다시 받지 않고 받아 둔 파일로 설치한다
    let result = block_on(run_install(
        &store,
        true,
        no_warning(),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Restarting);
    assert_eq!((downloads.get(), installs.get()), (1, 1));
}

#[test]
fn a_failed_download_is_a_failed_status_and_the_release_is_dropped() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let installs = Cell::new(0);
    let result = block_on(run_install(
        &store,
        true,
        no_warning(),
        |_, _| std::future::ready(Err("connection reset".to_string())),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Failed);
    assert_eq!(
        result.status,
        UpdateStatus::Failed {
            stage: FailStage::Download,
            message: "connection reset".into()
        }
    );
    assert_eq!(installs.get(), 0);
    // 다시 하려면 다시 확인한다
    let downloads = Cell::new(0);
    let again = block_on(run_install(
        &store,
        true,
        no_warning(),
        download_ok(&downloads),
        install_ok(&installs),
    ))
    .unwrap();
    assert_eq!(again.outcome, InstallOutcome::NoUpdate);
    found(&store, "0.2.0");
}

#[test]
fn a_failed_install_is_a_failed_status_with_the_install_stage() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let downloads = Cell::new(0);
    let result = block_on(run_install(
        &store,
        true,
        no_warning(),
        download_ok(&downloads),
        |_, _| std::future::ready(Err("the signature does not match".to_string())),
    ))
    .unwrap();
    assert_eq!(result.outcome, InstallOutcome::Failed);
    assert_eq!(
        result.status,
        UpdateStatus::Failed {
            stage: FailStage::Install,
            message: "the signature does not match".into()
        }
    );
    assert!(
        store.begin_check().unwrap().is_some(),
        "자리를 쥐고 있지 않다"
    );
}

#[test]
fn a_warning_check_that_fails_is_reported_and_changes_nothing() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let downloads = Cell::new(0);
    let installs = Cell::new(0);
    let result = block_on(run_install(
        &store,
        false,
        || std::future::ready(Err(AppError::Internal("background task failed".into()))),
        download_ok(&downloads),
        install_ok(&installs),
    ));
    assert!(matches!(result, Err(AppError::Internal(_))));
    assert_eq!(store.status(), available("0.2.0"));
}

#[test]
fn nothing_else_starts_while_a_download_is_running() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let Ok(Begin::Download(run, handle)) = store.begin_install(None) else {
        panic!("받기가 시작돼야 한다");
    };
    assert_eq!(handle, 7);
    assert!(matches!(
        store.begin_install(None),
        Err(AppError::UpdateBusy)
    ));
    assert!(matches!(store.begin_check(), Err(AppError::UpdateBusy)));
    // 경고가 있어도 받는 중이라는 것이 먼저다 (같은 일을 두 번 시작하지 않는다)
    assert!(matches!(
        store.begin_install(Some(WarningKind::Working)),
        Err(AppError::UpdateBusy)
    ));
    run.downloaded(vec![9]);
    assert!(matches!(
        store.begin_install(Some(WarningKind::Working)),
        Ok(Begin::Warn(WarningKind::Working))
    ));
}

#[test]
fn a_download_that_is_dropped_unfinished_becomes_a_failure_and_frees_the_slot() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let Ok(Begin::Download(run, _)) = store.begin_install(None) else {
        panic!("받기가 시작돼야 한다");
    };
    drop(run);
    assert!(matches!(
        store.status(),
        UpdateStatus::Failed {
            stage: FailStage::Download,
            ..
        }
    ));
    assert!(store.begin_check().unwrap().is_some());
}

// ───────────────────────── 받기 진행 ─────────────────────────

#[test]
fn progress_counts_every_chunk_but_emits_at_most_once_per_interval() {
    let (store, events) = store();
    found(&store, "0.2.0");
    let Ok(Begin::Download(_run, _)) = store.begin_install(None) else {
        panic!("받기가 시작돼야 한다");
    };
    events.lock().unwrap().clear();
    let start = Instant::now();
    store.progress(10, Some(1000), start); // 처음은 보낸다
    store.progress(10, Some(1000), start + Duration::from_millis(50)); // 간격 안 — 세기만
    store.progress(10, Some(1000), start + Duration::from_millis(100));
    store.progress(10, Some(1000), start + PROGRESS_EMIT_INTERVAL); // 간격이 찼다 — 보낸다
    let seen = events.lock().unwrap().clone();
    let received: Vec<u64> = seen
        .iter()
        .map(|status| match status {
            UpdateStatus::Downloading { received, .. } => *received,
            other => panic!("받는 중이어야 한다: {other:?}"),
        })
        .collect();
    assert_eq!(received, vec![10, 40]);
    // 다 받은 순간은 간격과 상관없이 보낸다
    store.progress(
        960,
        Some(1000),
        start + PROGRESS_EMIT_INTERVAL + Duration::from_millis(1),
    );
    assert!(matches!(
        store.status(),
        UpdateStatus::Downloading {
            received: 1000,
            total: Some(1000),
            ..
        }
    ));
    assert_eq!(events.lock().unwrap().len(), 3);
}

#[test]
fn progress_is_ignored_when_nothing_is_downloading() {
    let (store, events) = store();
    store.progress(10, Some(100), Instant::now());
    found(&store, "0.2.0");
    let before = events.lock().unwrap().len();
    store.progress(10, Some(100), Instant::now());
    assert_eq!(store.status(), available("0.2.0"));
    assert_eq!(events.lock().unwrap().len(), before);
}

#[test]
fn the_total_stays_unknown_when_the_server_does_not_say() {
    let (store, _) = store();
    found(&store, "0.2.0");
    let Ok(Begin::Download(_run, _)) = store.begin_install(None) else {
        panic!("받기가 시작돼야 한다");
    };
    store.progress(10, None, Instant::now());
    assert!(matches!(
        store.status(),
        UpdateStatus::Downloading {
            received: 10,
            total: None,
            ..
        }
    ));
}
