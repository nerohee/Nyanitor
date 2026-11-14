//! "하네스 작업 도중 끝냄" 표시 (P10-08, D-54) — 설치 · 되돌리기 · 받기 같은 일이 도는 중에 앱이 끝나면 그 사실을 앱 데이터 폴더에 남겨 두고,
//! 다음 실행이 읽고 지운다 (`take`). 화면에 알리는 것은 이 모듈의 일이 아니다 — 읽어 갈 길만 만든다.
//!
//! - 위치: `<앱 데이터 폴더>/harness-interrupted.json` (파일 하나, 한 번에 하나의 표시 — 새 표시가 앞의 것을 덮는다)
//! - 모양: `{"version":1,"task":"install"|"fetch","at":<유닉스 초>}` — 일의 종류와 끝낸 때뿐이다. 경로 · 계정 · 글은 넣지 않는다.
//! - 남기는 때: 앱이 끝날 때(`RunEvent::Exit`) 하네스 표(`HarnessState`)가 묻는 종류의 일을 쥐고 있으면 (`note_exit`).
//!   대화상자에서 "끝내기" 를 골랐든, 다른 길로 끝나든 같다.
//!
//! 파일은 임시 파일에 쓴 뒤 바꿔 넣어 반쯤 쓰인 채 남지 않게 한다. 읽을 수 없는 파일은 지우고 "표시 없음" 으로 본다.

use std::fs;
use std::io;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri_plugin_log::log;

use super::{HarnessState, HarnessTask};

/// 표시 파일 이름 (앱 데이터 폴더 안)
pub const FILE: &str = "harness-interrupted.json";
const TMP_FILE: &str = "harness-interrupted.json.tmp";
const VERSION: u32 = 1;

/// 끝낸 일의 종류 (`HarnessTask` 중 묻는 것만)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InterruptedTask {
    /// 원본 받기 · 업데이트 확인 · 받아 오기
    Fetch,
    /// 설치 · 되돌리기 · 내 수정 적용 · 기록 되돌리기
    Install,
}

impl InterruptedTask {
    /// 묻지 않는 일(`Light`)은 표시하지 않는다
    pub fn from_task(task: HarnessTask) -> Option<Self> {
        match task {
            HarnessTask::Light => None,
            HarnessTask::Fetch => Some(InterruptedTask::Fetch),
            HarnessTask::Install => Some(InterruptedTask::Install),
        }
    }
}

/// 남겨 둔 표시
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Interrupted {
    pub version: u32,
    pub task: InterruptedTask,
    /// 앱을 끝낸 때 (유닉스 초)
    pub at: i64,
}

/// 표시를 남긴다 (있던 표시는 덮는다). 폴더가 없으면 만든다.
pub fn mark(dir: &Path, task: InterruptedTask, at: i64) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let body = serde_json::to_string(&Interrupted {
        version: VERSION,
        task,
        at,
    })
    .map_err(io::Error::other)?;
    let tmp = dir.join(TMP_FILE);
    fs::write(&tmp, body)?;
    fs::rename(&tmp, dir.join(FILE)).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// 표시를 읽고 지운다. 없으면 `None`. 읽을 수 없거나 모르는 모양(다른 버전 포함)이면 지우고 `None` (남겨 두면 매번 같은 말을 하게 된다).
pub fn take(dir: &Path) -> Option<Interrupted> {
    let path = dir.join(FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
        // 읽지 못해도 지우려고 해 본다 (바이트가 UTF-8 이 아닌 경우 등)
        Err(err) => {
            log::warn!("harness: could not read the interrupted-task note: {err}");
            let _ = fs::remove_file(&path);
            return None;
        }
    };
    if let Err(err) = fs::remove_file(&path) {
        log::warn!("harness: could not remove the interrupted-task note: {err}");
    }
    match serde_json::from_str::<Interrupted>(&text) {
        Ok(note) if note.version == VERSION => Some(note),
        Ok(_) | Err(_) => None,
    }
}

/// 앱이 끝날 때 부른다 — 묻는 종류의 하네스 일이 도는 중이면 표시를 남기고 그 종류를 돌려준다.
/// 쓰지 못해도 끝내기를 막지 않는다 (로그만).
pub fn note_exit(dir: &Path, state: &HarnessState, at: i64) -> Option<InterruptedTask> {
    let task = InterruptedTask::from_task(state.quit_task()?)?;
    match mark(dir, task, at) {
        Ok(()) => log::warn!(
            "harness: the app is ending during a {task:?} task — noted for the next start"
        ),
        Err(err) => log::warn!("harness: could not note the interrupted task: {err}"),
    }
    Some(task)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    #[test]
    fn a_mark_is_read_once_and_then_gone() {
        let dir = TempDir::new("interrupted-once");
        mark(&dir, InterruptedTask::Install, 1_700_000_000).unwrap();
        assert!(dir.join(FILE).is_file());
        assert!(!dir.join(TMP_FILE).exists(), "임시 파일이 남지 않는다");
        let note = take(&dir).unwrap();
        assert_eq!(note.task, InterruptedTask::Install);
        assert_eq!(note.at, 1_700_000_000);
        assert!(!dir.join(FILE).exists());
        assert_eq!(take(&dir), None);
    }

    #[test]
    fn the_file_has_only_the_version_the_task_and_the_time() {
        let dir = TempDir::new("interrupted-shape");
        mark(&dir, InterruptedTask::Fetch, 5).unwrap();
        let text = fs::read_to_string(dir.join(FILE)).unwrap();
        assert_eq!(text, r#"{"version":1,"task":"fetch","at":5}"#);
    }

    #[test]
    fn a_newer_mark_replaces_the_older_one() {
        let dir = TempDir::new("interrupted-replace");
        mark(&dir, InterruptedTask::Fetch, 1).unwrap();
        mark(&dir, InterruptedTask::Install, 2).unwrap();
        let note = take(&dir).unwrap();
        assert_eq!((note.task, note.at), (InterruptedTask::Install, 2));
    }

    #[test]
    fn a_missing_folder_is_created_and_a_missing_mark_is_none() {
        let dir = TempDir::new("interrupted-missing");
        let nested = dir.join("not").join("yet");
        assert_eq!(take(&nested), None);
        mark(&nested, InterruptedTask::Fetch, 9).unwrap();
        assert_eq!(take(&nested).map(|n| n.at), Some(9));
    }

    #[test]
    fn an_unreadable_or_foreign_file_is_removed_and_means_no_mark() {
        let dir = TempDir::new("interrupted-garbage");
        for body in [
            "not json".as_bytes(),
            br#"{"version":2,"task":"install","at":1}"#,
            br#"{"version":1,"task":"explode","at":1}"#,
            &[0xff, 0xfe, 0x00],
            b"",
        ] {
            fs::write(dir.join(FILE), body).unwrap();
            assert_eq!(take(&dir), None, "{body:?}");
            assert!(!dir.join(FILE).exists(), "{body:?}");
        }
    }

    #[test]
    fn only_a_running_fetch_or_install_leaves_a_mark_at_exit() {
        let dir = TempDir::new("interrupted-exit");
        let state = HarnessState::default();
        // 일이 없으면 남기지 않는다
        assert_eq!(note_exit(&dir, &state, 1), None);
        assert!(!dir.join(FILE).exists());
        // 짧은 일(Light)도 남기지 않는다
        {
            let _light = state.begin().unwrap();
            assert_eq!(note_exit(&dir, &state, 2), None);
            assert!(!dir.join(FILE).exists());
        }
        for (task, expected) in [
            (HarnessTask::Fetch, InterruptedTask::Fetch),
            (HarnessTask::Install, InterruptedTask::Install),
        ] {
            let _guard = state.begin_task(task).unwrap();
            assert_eq!(note_exit(&dir, &state, 3), Some(expected));
            assert_eq!(take(&dir).map(|n| (n.task, n.at)), Some((expected, 3)));
        }
        // 일이 끝난 뒤에는 남기지 않는다
        assert_eq!(note_exit(&dir, &state, 4), None);
        assert!(!dir.join(FILE).exists());
    }

    #[test]
    fn a_folder_that_cannot_be_written_does_not_stop_the_exit() {
        let dir = TempDir::new("interrupted-unwritable");
        // 폴더 자리에 파일이 있다
        let blocker = dir.join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let state = HarnessState::default();
        let _guard = state.begin_task(HarnessTask::Install).unwrap();
        assert_eq!(
            note_exit(&blocker, &state, 1),
            Some(InterruptedTask::Install)
        );
        assert!(blocker.is_file());
    }
}
