//! 강제로 꺼진 git 이 남긴 `.git/index.lock` 을 치운다 (P10-08, D-54).
//!
//! 앱의 git 은 하네스 원본(`<하네스 폴더>/repo`)과 내 수정 기록(`<하네스 폴더>/custom`) 두 저장소에만 쓴다. 시간 초과 · 앱 종료로 git 이
//! 강제로 꺼지면 `index.lock` 이 남아 뒤의 `add` · `commit` · `merge` 가 모두 "File exists" 로 실패한다. `run_git` 이 인덱스를 쓰는 명령을
//! 부르기 직전에 `enter` 로 확인한다:
//!
//! - 잠금이 없으면 그대로 간다.
//! - 잠금이 있고 **지금 앱의 쓰는 git 이 그 저장소에서 돌고 있지 않으면**:
//!   - `STALE_AFTER` 이상 된 잠금은 남은 것으로 보고 지운다 (로그).
//!   - 그보다 새 잠금은 지우지 않고 `GitError::Locked` ("다른 git 이 쓰는 중") 로 돌려준다 — 사용자가 터미널에서 같은 저장소에 git 을 돌리는 중일 수 있다.
//! - 잠금이 있고 앱의 쓰는 git 이 이 저장소에서 돌고 있으면 잠금을 건드리지 않는다 (그 git 의 것이다).
//!
//! **기준 `STALE_AFTER` = 10초.** 앱의 git 은 작은 저장소의 로컬 명령(`add` · `commit` · `merge --ff-only`)이라 인덱스 잠금을 길어야 한두 초 쥔다.
//! 터미널의 사람 git 도 보통 몇 초 안이다. 더 길면 꺼진 git 이 남긴 것일 가능성이 크지만, **편집기를 연 채 쉬고 있는 `git commit`** 처럼 오래 잠금을
//! 쥐는 사람의 git 은 지워질 수 있다 (그 git 은 마지막에 잠금 파일을 못 찾아 커밋이 실패할 뿐 저장소가 망가지지는 않는다). 수정 시각이 미래인 잠금
//! (시계가 어긋났다)은 새 것으로 본다.
//! 앱이 직접 시간 초과로 끈 git 이 남긴 잠금은 기다릴 이유가 없어 바로 지운다 (`after_timeout`).
//!
//! 쓰는 git 이 같은 저장소에서 둘 돌지 않게는 이미 하네스 잠금(`HarnessState::begin`)이 한다. 여기서는 읽기 명령(잠그지 않는다)이 도는 것과
//! 잠금 파일을 헷갈리지 않으려고 **쓰는 명령만** 센다 (읽기는 `GIT_OPTIONAL_LOCKS=0` 이라 인덱스 잠금을 만들지 않는다).
//! `.git` 이 보통 폴더가 아닌 저장소(링크 · 작업 트리 파일)와 `index.lock` 이 보통 파일이 아닌 경우는 건드리지 않는다.
//! 다른 잠금 파일(`HEAD.lock` · `refs/**.lock` · `shallow.lock`)은 다루지 않는다 — 인덱스 잠금이 가장 오래 쥐어지고 가장 흔하다.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use tauri_plugin_log::log;

use super::git::GitError;

/// 이만큼 오래된 `index.lock` 은 꺼진 git 이 남긴 것으로 보고 지운다 (이유는 위 설명)
pub const STALE_AFTER: Duration = Duration::from_secs(10);

const LOCK_NAME: &str = "index.lock";

/// 인덱스를 쓰는 git 하위 명령 — 앱이 부르는 것 (`add` · `commit` · `reset` · `read-tree` · `merge`) 과 같은 일을 하는 것들
const WRITING: &[&str] = &[
    "add",
    "commit",
    "reset",
    "read-tree",
    "merge",
    "checkout",
    "switch",
    "restore",
    "rm",
    "mv",
    "stash",
    "rebase",
    "cherry-pick",
    "revert",
    "pull",
    "am",
];

/// 앞의 전역 옵션(`-c k=v` · `-C 경로`)을 건너뛴 첫 낱말 — git 하위 명령
fn subcommand(args: &[OsString]) -> Option<&str> {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let text = arg.to_str()?;
        match text {
            "-c" | "-C" => {
                args.next();
            }
            _ if text.starts_with('-') => {}
            _ => return Some(text),
        }
    }
    None
}

/// 이 명령이 인덱스 잠금을 만드는가
pub fn takes_index_lock(args: &[OsString]) -> bool {
    subcommand(args).is_some_and(|name| WRITING.contains(&name))
}

/// 저장소 하나의 `index.lock` 이 놓일 자리 — `.git` 이 보통 폴더일 때만 (링크 · 파일이면 `None`)
fn lock_path(repo: &Path) -> Option<PathBuf> {
    let dot_git = repo.join(".git");
    let meta = fs::symlink_metadata(&dot_git).ok()?;
    (meta.is_dir() && !meta.file_type().is_symlink()).then(|| dot_git.join(LOCK_NAME))
}

/// 잠금 파일 하나의 모습
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockState {
    /// 없다 (또는 보통 파일이 아니라 건드리지 않는다)
    Absent,
    /// 있고 `STALE_AFTER` 보다 새롭다 (수정 시각이 미래여도 여기)
    Fresh,
    /// 있고 `STALE_AFTER` 이상 됐다
    Stale,
}

fn lock_state(lock: &Path, now: SystemTime, stale_after: Duration) -> LockState {
    let Ok(meta) = fs::symlink_metadata(lock) else {
        return LockState::Absent;
    };
    if !meta.is_file() {
        return LockState::Absent;
    }
    // 나이를 못 알아내면 새 것으로 본다 (남의 잠금을 지우는 쪽으로 틀리지 않게)
    let age = meta
        .modified()
        .ok()
        .and_then(|modified| now.duration_since(modified).ok());
    match age {
        Some(age) if age >= stale_after => LockState::Stale,
        _ => LockState::Fresh,
    }
}

/// 지금 이 저장소에서 쓰는 git 이 몇 개 도는가 (잠금 파일 키별)
fn writers() -> MutexGuard<'static, HashMap<PathBuf, usize>> {
    static WRITERS: LazyLock<Mutex<HashMap<PathBuf, usize>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    WRITERS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 쓰는 git 이 도는 동안 쥐는 표 — 버려지면 센 것을 내린다
#[derive(Debug)]
pub struct WriterSlot {
    key: PathBuf,
}

impl Drop for WriterSlot {
    fn drop(&mut self) {
        let mut map = writers();
        if let Some(count) = map.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.key);
            }
        }
    }
}

/// 쓰는 git 을 부르기 직전에 부른다. 읽는 명령 · 저장소가 아닌 곳(`repo` 없음)이면 `Ok(None)`.
/// 남은 잠금을 치웠거나 없으면 표를 돌려주고, 새 잠금이 있으면 `GitError::Locked`.
pub fn enter(repo: Option<&Path>, args: &[OsString]) -> Result<Option<WriterSlot>, GitError> {
    enter_at(repo, args, SystemTime::now(), STALE_AFTER)
}

fn enter_at(
    repo: Option<&Path>,
    args: &[OsString],
    now: SystemTime,
    stale_after: Duration,
) -> Result<Option<WriterSlot>, GitError> {
    let Some(repo) = repo else {
        return Ok(None);
    };
    if !takes_index_lock(args) {
        return Ok(None);
    }
    let Some(lock) = lock_path(repo) else {
        return Ok(None);
    };
    // 확인 · 지우기 · 표 올리기를 한 잠금 안에서 — 다른 스레드의 git 이 그 사이에 시작해 새 잠금을 만들고 그것을 지우는 일이 없게
    let mut map = writers();
    let running = map.get(&lock).copied().unwrap_or(0);
    if running == 0 {
        match lock_state(&lock, now, stale_after) {
            LockState::Absent => {}
            LockState::Fresh => {
                log::info!(
                    "git: {LOCK_NAME} is fresh — another git may be using this repository; not touching it"
                );
                return Err(GitError::Locked);
            }
            LockState::Stale => match fs::remove_file(&lock) {
                Ok(()) => log::warn!(
                    "git: removed a stale {LOCK_NAME} (older than {}s) left by a git that was stopped",
                    stale_after.as_secs()
                ),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                // 지울 수 없다 = 다른 프로세스가 쥐고 있거나 권한이 없다 — 남의 것으로 본다
                Err(err) => {
                    log::warn!("git: could not remove a stale {LOCK_NAME}: {err}");
                    return Err(GitError::Locked);
                }
            },
        }
    }
    *map.entry(lock.clone()).or_insert(0) += 1;
    Ok(Some(WriterSlot { key: lock }))
}

/// 앱이 시간 초과로 끈 쓰는 git 이 남긴 잠금을 바로 지운다 (`slot` 을 쥔 채, 프로세스가 이미 꺼진 뒤에 부른다).
/// 그 git 이 쥐고 있던 것이라 나이를 따지지 않는다 — 앱의 쓰는 git 은 한 번에 하나라 다른 앱 git 의 것일 수 없다.
pub fn after_timeout(slot: &WriterSlot) {
    // 이 표를 쥔 동안에는 같은 저장소에서 앱의 쓰는 git 이 하나뿐이어야 한다 (둘이면 다른 git 의 잠금일 수 있어 건드리지 않는다)
    let alone = writers().get(&slot.key) == Some(&1);
    if !alone {
        return;
    }
    if lock_state(&slot.key, SystemTime::now(), Duration::ZERO) == LockState::Absent {
        return;
    }
    match fs::remove_file(&slot.key) {
        Ok(()) => log::warn!("git: removed the {LOCK_NAME} that a timed-out git left behind"),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => log::warn!("git: could not remove the {LOCK_NAME} a timed-out git left: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    /// 저장소 모양의 폴더 (`.git` 폴더만 — git 을 실제로 돌리지 않는다)
    fn fake_repo(dir: &Path) {
        fs::create_dir_all(dir.join(".git")).unwrap();
    }

    fn lock_file(repo: &Path) -> PathBuf {
        repo.join(".git").join(LOCK_NAME)
    }

    /// 잠금 파일을 만들고 수정 시각을 `age` 만큼 과거(또는 미래)로
    fn make_lock(repo: &Path, age: Duration, in_future: bool) {
        let path = lock_file(repo);
        fs::write(&path, b"").unwrap();
        let when = if in_future {
            SystemTime::now() + age
        } else {
            SystemTime::now() - age
        };
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    fn writing() -> Vec<OsString> {
        args(&["-c", "core.quotepath=false", "-C", "x", "add", "-A"])
    }

    #[test]
    fn only_commands_that_write_the_index_count() {
        for list in [
            &["add", "-A"][..],
            &["commit", "-q", "-m", "x"],
            &["-c", "a=b", "-C", "dir", "merge", "--ff-only", "abc"],
            &["reset", "-q", "--hard", "HEAD"],
            &["read-tree", "--reset", "-u", "abc"],
        ] {
            assert!(takes_index_lock(&args(list)), "{list:?}");
        }
        for list in [
            &["status", "--porcelain"][..],
            &["-c", "a=b", "-C", "dir", "rev-parse", "HEAD"],
            &["diff", "HEAD"],
            &["log", "--format=%s"],
            &["fetch", "--quiet", "origin"],
            &["clone", "x", "y"],
            &["clean", "-fdq"],
            &["--version"],
            &["-c", "a=add"],
            &[],
        ] {
            assert!(!takes_index_lock(&args(list)), "{list:?}");
        }
    }

    #[test]
    fn a_stale_lock_is_removed_and_the_git_may_go() {
        let dir = TempDir::new("lock-stale");
        fake_repo(&dir);
        make_lock(&dir, Duration::from_secs(60), false);
        let slot = enter(Some(&dir), &writing()).unwrap();
        assert!(slot.is_some());
        assert!(!lock_file(&dir).exists());
    }

    #[test]
    fn a_fresh_lock_is_left_alone_and_reported_as_another_git_using_it() {
        let dir = TempDir::new("lock-fresh");
        fake_repo(&dir);
        make_lock(&dir, Duration::from_secs(1), false);
        assert_eq!(enter(Some(&dir), &writing()).unwrap_err(), GitError::Locked);
        assert!(lock_file(&dir).exists());
        // 막힌 시도는 센 것을 남기지 않는다 — 잠금이 낡은 뒤에는 지나간다
        make_lock(&dir, Duration::from_secs(60), false);
        assert!(enter(Some(&dir), &writing()).unwrap().is_some());
    }

    #[test]
    fn the_age_limit_is_the_boundary_between_fresh_and_stale() {
        let dir = TempDir::new("lock-boundary");
        fake_repo(&dir);
        let now = SystemTime::now();
        let limit = Duration::from_secs(10);
        fs::write(lock_file(&dir), b"").unwrap();
        let set = |when: SystemTime| {
            fs::File::options()
                .write(true)
                .open(lock_file(&dir))
                .unwrap()
                .set_modified(when)
                .unwrap();
        };
        set(now - Duration::from_secs(9));
        assert_eq!(lock_state(&lock_file(&dir), now, limit), LockState::Fresh);
        set(now - limit);
        assert_eq!(lock_state(&lock_file(&dir), now, limit), LockState::Stale);
        set(now - Duration::from_secs(11));
        assert_eq!(lock_state(&lock_file(&dir), now, limit), LockState::Stale);
    }

    #[test]
    fn a_lock_from_the_future_is_fresh_not_stale() {
        let dir = TempDir::new("lock-future");
        fake_repo(&dir);
        make_lock(&dir, Duration::from_secs(3600), true);
        assert_eq!(enter(Some(&dir), &writing()).unwrap_err(), GitError::Locked);
        assert!(lock_file(&dir).exists());
    }

    #[test]
    fn a_lock_is_not_touched_while_the_apps_own_writing_git_runs_on_that_repo() {
        let dir = TempDir::new("lock-own");
        fake_repo(&dir);
        let first = enter(Some(&dir), &writing()).unwrap().unwrap();
        // 앱의 git 이 만든 잠금 (오래돼 보여도 지금 도는 git 의 것이다)
        make_lock(&dir, Duration::from_secs(600), false);
        let second = enter(Some(&dir), &writing()).unwrap();
        assert!(second.is_some());
        assert!(lock_file(&dir).exists());
        // 시간 초과 정리도 둘이 돌 때는 건드리지 않는다
        after_timeout(&first);
        assert!(lock_file(&dir).exists());
        drop(second);
        drop(first);
        // 다 끝난 뒤에는 낡은 잠금으로 다시 보인다
        assert!(enter(Some(&dir), &writing()).unwrap().is_some());
        assert!(!lock_file(&dir).exists());
    }

    #[test]
    fn reads_and_non_repos_never_look_at_the_lock() {
        let dir = TempDir::new("lock-reads");
        fake_repo(&dir);
        make_lock(&dir, Duration::from_secs(1), false);
        // 읽는 명령은 새 잠금이 있어도 간다
        assert!(
            enter(Some(&dir), &args(&["-C", "x", "status", "--porcelain"]))
                .unwrap()
                .is_none()
        );
        // 저장소가 없는 호출(`clone` · `--version`)도
        assert!(enter(None, &writing()).unwrap().is_none());
        // `.git` 이 없는 폴더는 건드릴 잠금이 없다
        let plain = TempDir::new("lock-plain");
        assert!(enter(Some(&plain), &writing()).unwrap().is_none());
        assert!(lock_file(&dir).exists());
    }

    #[test]
    fn a_lock_that_is_a_folder_is_not_ours_to_remove() {
        let dir = TempDir::new("lock-folder");
        fake_repo(&dir);
        fs::create_dir(lock_file(&dir)).unwrap();
        assert!(enter(Some(&dir), &writing()).unwrap().is_some());
        assert!(lock_file(&dir).is_dir());
    }

    #[test]
    fn a_lock_left_by_a_git_the_app_timed_out_is_removed_at_once() {
        let dir = TempDir::new("lock-timeout");
        fake_repo(&dir);
        let slot = enter(Some(&dir), &writing()).unwrap().unwrap();
        // 방금 끈 git 이 남긴 잠금 — 새 것이어도 지운다
        make_lock(&dir, Duration::from_secs(0), false);
        after_timeout(&slot);
        assert!(!lock_file(&dir).exists());
        // 없을 때는 아무 일도 없다
        after_timeout(&slot);
    }

    #[test]
    fn dropping_the_slot_lowers_the_count_even_after_a_panic() {
        let dir = TempDir::new("lock-panic");
        fake_repo(&dir);
        let path = dir.path().to_path_buf();
        let result = std::thread::spawn(move || {
            let _slot = enter(Some(&path), &writing()).unwrap().unwrap();
            panic!("boom");
        })
        .join();
        assert!(result.is_err());
        make_lock(&dir, Duration::from_secs(60), false);
        assert!(enter(Some(&dir), &writing()).unwrap().is_some());
        assert!(!lock_file(&dir).exists());
    }
}
