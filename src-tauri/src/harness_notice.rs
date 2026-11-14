//! 지난번 하네스 일이 끝나기 전에 앱이 꺼졌다는 알림 (P10-09, D-50 · D-54) — 앱이 시작될 때 한 번.
//!
//! 앱이 설치 · 되돌리기 · 받기 도중 끝나면 `harness::interrupted` 가 앱 데이터 폴더에 표시를 남긴다. 그 표시를 읽고 지워서 있으면 OS 알림 하나를 띄운다.
//! 알림은 `attention` 과 같은 길(Rust 에서 `tauri-plugin-notification` — 화면 권한에는 notification 을 열지 않는다)이다.
//! 표시는 읽는 순간 지워진다 — 알림이 안 떠도 다음 실행에서 같은 말을 되풀이하지 않는다. 정하는 로직은 알림 띄우기를 바꿔 끼울 수 있게 일반 함수로 둔다.

use std::path::Path;

use tauri::{AppHandle, Runtime};
use tauri_plugin_log::log;
use tauri_plugin_notification::NotificationExt;

use crate::harness::interrupted::{self, Interrupted, InterruptedTask};
use crate::strings;

/// 알림 본문 — 일의 종류에 맞춘다 (받기는 "다시 받기", 나머지는 "되돌리기")
pub fn body_for(task: InterruptedTask) -> &'static str {
    match task {
        InterruptedTask::Install => strings::HARNESS_INTERRUPTED_INSTALL,
        InterruptedTask::Fetch => strings::HARNESS_INTERRUPTED_FETCH,
    }
}

/// 표시가 있으면 읽고 지운 뒤 `show(제목, 본문)` 을 한 번 부른다. 없으면(읽을 수 없는 표시 포함) 아무것도 부르지 않는다.
pub fn announce_interrupted(dir: &Path, show: impl FnOnce(&str, &str)) -> Option<Interrupted> {
    let note = interrupted::take(dir)?;
    show(strings::NOTICE_TITLE, body_for(note.task));
    Some(note)
}

/// 앱이 시작될 때 부른다 (`lib.rs` setup — 창 · 트레이가 준비된 뒤). 알림이 실패해도 앱은 뜬다 (로그만, 본문은 남기지 않는다).
pub fn announce_on_start<R: Runtime>(app: &AppHandle<R>, app_data: &Path) {
    announce_interrupted(app_data, |title, body| {
        if let Err(err) = app.notification().builder().title(title).body(body).show() {
            log::warn!("could not show the interrupted harness task notification: {err}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;
    use std::cell::RefCell;

    fn run(dir: &Path) -> Vec<(String, String)> {
        let shown = RefCell::new(Vec::new());
        announce_interrupted(dir, |title, body| {
            shown
                .borrow_mut()
                .push((title.to_string(), body.to_string()));
        });
        shown.into_inner()
    }

    #[test]
    fn a_mark_gives_one_notification_and_is_removed() {
        let dir = TempDir::new("harness-notice-install");
        interrupted::mark(&dir, InterruptedTask::Install, 1_700_000_000).unwrap();
        let shown = run(&dir);
        assert_eq!(
            shown,
            [(
                strings::NOTICE_TITLE.to_string(),
                strings::HARNESS_INTERRUPTED_INSTALL.to_string()
            )]
        );
        assert!(!dir.join(interrupted::FILE).exists(), "표시가 지워진다");
        // 다음 시작에는 아무것도 없다
        assert!(run(&dir).is_empty());
    }

    #[test]
    fn a_fetch_mark_uses_the_fetch_wording() {
        let dir = TempDir::new("harness-notice-fetch");
        interrupted::mark(&dir, InterruptedTask::Fetch, 5).unwrap();
        let shown = run(&dir);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].1, strings::HARNESS_INTERRUPTED_FETCH);
        assert_ne!(
            strings::HARNESS_INTERRUPTED_FETCH,
            strings::HARNESS_INTERRUPTED_INSTALL
        );
    }

    #[test]
    fn no_mark_means_no_notification() {
        let dir = TempDir::new("harness-notice-none");
        assert!(run(&dir).is_empty());
        // 앱 데이터 폴더가 아직 없어도 아무 일 없다
        assert!(run(&dir.join("not-yet")).is_empty());
    }

    #[test]
    fn an_unreadable_mark_means_no_notification_and_is_removed() {
        let dir = TempDir::new("harness-notice-garbage");
        std::fs::write(dir.join(interrupted::FILE), "not json").unwrap();
        assert!(run(&dir).is_empty());
        assert!(!dir.join(interrupted::FILE).exists());
    }
}
