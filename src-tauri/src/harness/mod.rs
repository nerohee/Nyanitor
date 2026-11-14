//! 하네스 설치 · 업데이트 (P4-02) — git 확인 · 원본 받기 · 업데이트 확인 · 설치 스크립트 · 백업 정리.
//!
//! 약속 문서: 하네스 저장소 `shared/app-contract.md` (버전 1). 결정: D-04 · D-05 · D-20 · D-21 · D-22 · D-44 · D-46.
//!
//! - `locate` — `~/.claude` · 하네스 폴더 · 쓸 원본(개발자 모드 알아보기) · 상태
//! - `git` — git · Git Bash 찾기, 원본 받기(clone), 업데이트 확인(fetch) · 받기(확인 때 본 커밋까지만 merge --ff-only)
//! - `status` — 위치 · 원본 · 받은 원본 · git · Git Bash 한눈에 (읽기만)
//! - `script` — 설치 스크립트 실행 · 표준 출력 JSON 읽기 · 백업 번호 검사
//! - `backups` — 오래된 백업 정리 (최신 12개만)
//! - `gitlock` — 강제로 꺼진 git 이 남긴 `.git/index.lock` 을 git 을 부르기 직전에 치운다 (오래된 것만)
//! - `interrupted` — 하네스 작업 도중 앱을 끝냈다는 표시 (앱 데이터 폴더, 다음 실행이 읽고 지운다)
//! - `flow` — 한 번에 하나 잠금 + 본 것만 한다 (확인 → 받기, 미리보기 → 설치 · 되돌리기를 Rust 에서 지키는 기억)
//! - `commands` — Tauri 명령 (얇게: `flow` 로 전달만)
//!
//! 화면(IPC)에서 실행 파일 · 인자 · 경로 · URL 을 받는 길은 없다. 받는 입력은 백업 번호 하나뿐이고, 그것도 Rust 에서
//! 모양과 `--backups` 목록 안에 있는지 다시 확인한다. 위치는 환경 변수(`CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME`)로만 바뀐다.

pub mod backups;
pub mod commands;
pub mod flow;
pub mod git;
pub mod gitlock;
pub mod interrupted;
pub mod locate;
pub mod script;
pub mod status;

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use locate::Locations;

/// 하네스 원본 주소 (공개 저장소). 화면에서 바꿀 수 없고, 시험은 `Context::origin_url` 에 로컬 저장소 경로를 넘긴다.
pub const HARNESS_REPO_URL: &str = "https://github.com/nerohee/claude-harness";

/// 백업을 몇 개 남기는가 (D-46).
pub const KEEP_BACKUPS: usize = 12;

/// 한 번의 하네스 작업이 쓰는 것 — 위치 · git · 원본 주소. 명령마다 환경에서 새로 만든다.
#[derive(Debug, Clone)]
pub struct Context {
    pub locations: Locations,
    /// 찾은 git 실행 파일 (없으면 `None`)
    pub git: Option<PathBuf>,
    /// 받을 원본 주소
    pub origin_url: String,
    /// 시험용: 자식 프로세스(git · 설치 스크립트)에 더 넘길 변수. 화면에서는 채울 수 없다.
    pub extra_env: Vec<(OsString, OsString)>,
    /// 시험용: 모든 자식 프로세스의 시간 제한을 이 값으로 바꾼다 (시간이 넘는 경우를 짧게 시험하려고). 화면에서는 채울 수 없다.
    pub timeout: Option<Duration>,
}

impl Context {
    pub fn new(locations: Locations, git: Option<PathBuf>) -> Self {
        Self {
            locations,
            git,
            origin_url: HARNESS_REPO_URL.to_string(),
            extra_env: Vec::new(),
            timeout: None,
        }
    }

    /// 이 프로세스의 환경 · 홈 폴더 · PATH 로 만든다.
    pub fn here() -> Result<Self, locate::LocationError> {
        let locations = locate::locations_here()?;
        Ok(Self::new(locations, git::locate_git_here()))
    }

    /// 시험용: 받을 원본 주소를 바꾼다 (Tauri 명령은 쓰지 않는다).
    pub fn with_origin_url(mut self, url: impl Into<String>) -> Self {
        self.origin_url = url.into();
        self
    }

    /// 시험용: 자식 프로세스의 시간 제한을 바꾼다.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// 시험용: 자식에게 변수를 더 넘긴다.
    pub fn with_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.extra_env.push((name.into(), value.into()));
        self
    }
}

/// 앱이 기억해 두는 것 — 화면이 아니라 Rust 가 들고 있으므로 화면이 넘기는 값은 늘지 않는다.
/// "본 것만 한다" 를 Rust 에서 지키려는 것이다: 확인 때 본 커밋까지만 받고, 미리보기를 돌린 원본으로만 설치 · 되돌린다.
#[derive(Debug, Default)]
struct Memory {
    /// 가장 최근 업데이트 확인이 본 것 (받기가 그 커밋까지만 받는다)
    checked: Option<git::CheckedUpdate>,
    /// 가장 최근 설치 미리보기를 돌린 스크립트
    install_plan: Option<PathBuf>,
    /// 가장 최근 되돌리기 미리보기의 백업 번호와 돌린 스크립트
    restore_plan: Option<(String, PathBuf)>,
}

/// 하네스 일이 어떤 종류인가 — 앱을 끄려 할 때 물어야 하는지 · 뭐라고 물을지를 정한다 (P10-08, D-54).
/// 일을 시작하는 쪽이 `HarnessState::begin_task` 로 밝힌다. 밝히지 않은 일(`begin`)은 `Light`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HarnessTask {
    /// 짧은 읽기 · 미리보기 · 파일 저장 — 도중에 끊겨도 다시 하면 된다 (끝낼 때 묻지 않는다)
    Light,
    /// 원본 받기 · 업데이트 확인 · 받아 오기 (git) — 끊기면 받던 것이 반쯤 남을 수 있다
    Fetch,
    /// 설치 · 되돌리기 · 내 수정 적용 · 기록 되돌리기 — 끊기면 `~/.claude` 가 반쯤 바뀌거나, 설치는 됐는데 기록은 안 남을 수 있다
    Install,
}

impl HarnessTask {
    fn code(self) -> u8 {
        match self {
            HarnessTask::Light => 1,
            HarnessTask::Fetch => 2,
            HarnessTask::Install => 3,
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(HarnessTask::Light),
            2 => Some(HarnessTask::Fetch),
            3 => Some(HarnessTask::Install),
            _ => None,
        }
    }

    /// 앱을 끌 때 묻고 · "도중 끝냄" 표시를 남길 일인가
    pub fn needs_quit_warning(self) -> bool {
        self != HarnessTask::Light
    }
}

/// 하네스 일(git · 스크립트 · 정리)은 앱 안에서 한 번에 하나 (정해 둔 것 11).
/// `begin()` 이 돌려준 표를 쥐고 있는 동안 다른 `begin()` 은 실패한다. 버려지면(오류 · 패닉 포함) 풀린다.
/// 기억(`Memory`)은 표를 쥔 쪽만 읽고 쓴다 — 앱을 다시 띄우면 비어 있다.
/// 표에는 일의 종류(`HarnessTask`)가 같이 적힌다 — 하나의 원자 값이라 "돌고 있나" 와 "무슨 일인가" 가 어긋나지 않는다.
#[derive(Debug, Clone, Default)]
pub struct HarnessState {
    /// 0 = 일 없음, 아니면 `HarnessTask::code`
    running: std::sync::Arc<std::sync::atomic::AtomicU8>,
    memory: std::sync::Arc<std::sync::Mutex<Memory>>,
}

#[derive(Debug)]
pub struct BusyGuard {
    running: std::sync::Arc<std::sync::atomic::AtomicU8>,
    memory: std::sync::Arc<std::sync::Mutex<Memory>>,
}

impl HarnessState {
    /// 표를 잡는다 — 종류는 `Light` (끌 때 묻지 않는 짧은 일). 묻어야 하는 일은 `begin_task`.
    pub fn begin(&self) -> Result<BusyGuard, crate::error::AppError> {
        self.begin_task(HarnessTask::Light)
    }

    /// 표를 잡고 일의 종류를 밝힌다 (앱을 끄려 할 때 `running_task` 가 읽는다).
    pub fn begin_task(&self, task: HarnessTask) -> Result<BusyGuard, crate::error::AppError> {
        use std::sync::atomic::Ordering;
        self.running
            .compare_exchange(0, task.code(), Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| crate::error::AppError::HarnessBusy)?;
        Ok(BusyGuard {
            running: self.running.clone(),
            memory: self.memory.clone(),
        })
    }

    pub fn is_busy(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::Acquire) != 0
    }

    /// 지금 도는 일의 종류 (없으면 `None`)
    pub fn running_task(&self) -> Option<HarnessTask> {
        HarnessTask::from_code(self.running.load(std::sync::atomic::Ordering::Acquire))
    }

    /// 앱을 끄려 할 때 물어야 하는 일이 돌고 있으면 그 종류 (`Light` 는 묻지 않는다)
    pub fn quit_task(&self) -> Option<HarnessTask> {
        self.running_task().filter(|task| task.needs_quit_warning())
    }
}

impl BusyGuard {
    /// 한 번 패닉한 일이 남긴 기억도 쓸 수 있게 둔다 (값은 단순한 `Option` 이라 반쯤 바뀐 상태가 없다)
    fn memory(&self) -> std::sync::MutexGuard<'_, Memory> {
        self.memory
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 업데이트 확인이 본 것을 기억한다 (`None` 이면 지운다)
    pub fn remember_check(&self, checked: Option<git::CheckedUpdate>) {
        self.memory().checked = checked;
    }

    /// 기억한 확인을 꺼낸다 — 한 번 꺼내면 비어 있다 (확인 한 번에 받기 한 번)
    pub fn take_check(&self) -> Option<git::CheckedUpdate> {
        self.memory().checked.take()
    }

    /// 설치 미리보기를 돌린 스크립트를 기억한다 (`None` 이면 지운다)
    pub fn remember_install_plan(&self, script: Option<PathBuf>) {
        self.memory().install_plan = script;
    }

    pub fn install_plan(&self) -> Option<PathBuf> {
        self.memory().install_plan.clone()
    }

    /// 되돌리기 미리보기의 백업 번호와 스크립트를 기억한다 (`None` 이면 지운다)
    pub fn remember_restore_plan(&self, plan: Option<(String, PathBuf)>) {
        self.memory().restore_plan = plan;
    }

    pub fn restore_plan(&self) -> Option<(String, PathBuf)> {
        self.memory().restore_plan.clone()
    }

    /// 쓰는 일(받기 · 업데이트 받기 · 설치 · 되돌리기) 뒤에는 본 것이 낡았으니 모두 지운다
    pub fn forget_all(&self) {
        *self.memory() = Memory::default();
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.running.store(0, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_one_harness_task_at_a_time_and_it_frees_when_dropped() {
        let state = HarnessState::default();
        let first = state.begin().unwrap();
        assert!(state.is_busy());
        let second = state.begin().unwrap_err();
        assert_eq!(second.kind(), "harness_busy");
        // 같은 상태를 복사해 가진 쪽(명령마다 clone 한다)에도 똑같이 보인다
        assert_eq!(state.clone().begin().unwrap_err().kind(), "harness_busy");
        drop(first);
        assert!(!state.is_busy());
        let again = state.begin().unwrap();
        drop(again);
    }

    #[test]
    fn the_running_task_is_told_while_the_turn_is_held_and_gone_when_it_is_dropped() {
        let state = HarnessState::default();
        assert_eq!(state.running_task(), None);
        assert_eq!(state.quit_task(), None);
        for task in [HarnessTask::Fetch, HarnessTask::Install] {
            let guard = state.begin_task(task).unwrap();
            assert_eq!(state.running_task(), Some(task));
            assert_eq!(state.quit_task(), Some(task));
            // 같은 상태를 복사해 가진 쪽에도 같은 것이 보이고, 둘째 일은 종류를 바꾸지 못한다
            assert_eq!(state.clone().quit_task(), Some(task));
            assert!(state.begin_task(HarnessTask::Light).is_err());
            assert_eq!(state.running_task(), Some(task));
            drop(guard);
            assert_eq!(state.running_task(), None);
            assert_eq!(state.quit_task(), None);
        }
    }

    #[test]
    fn a_light_turn_is_busy_but_does_not_ask_the_user_before_quitting() {
        let state = HarnessState::default();
        let guard = state.begin().unwrap();
        assert!(state.is_busy());
        assert_eq!(state.running_task(), Some(HarnessTask::Light));
        assert_eq!(state.quit_task(), None);
        drop(guard);
        assert!(!state.is_busy());
    }

    #[test]
    fn the_task_is_cleared_when_the_work_panics() {
        let state = HarnessState::default();
        let inner = state.clone();
        let _ = std::thread::spawn(move || {
            let _guard = inner.begin_task(HarnessTask::Install).unwrap();
            panic!("boom");
        })
        .join();
        assert_eq!(state.quit_task(), None);
        assert!(state.begin().is_ok());
    }

    #[test]
    fn the_lock_is_released_when_the_work_panics() {
        let state = HarnessState::default();
        let inner = state.clone();
        let result = std::thread::spawn(move || {
            let _guard = inner.begin().unwrap();
            panic!("boom");
        })
        .join();
        assert!(result.is_err());
        assert!(!state.is_busy());
        assert!(state.begin().is_ok());
    }

    #[test]
    fn memory_is_kept_by_whoever_holds_the_turn_and_cleared_by_forget_all() {
        let state = HarnessState::default();
        let checked = git::CheckedUpdate {
            branch: "main".into(),
            upstream_hash: "a".repeat(40),
        };
        {
            let guard = state.begin().unwrap();
            guard.remember_check(Some(checked.clone()));
            guard.remember_install_plan(Some(PathBuf::from("x/install.sh")));
            guard.remember_restore_plan(Some(("2026-10-18_143205".into(), PathBuf::from("x"))));
        }
        // 표를 놓았다 다시 잡아도 기억은 남아 있다 (같은 상태를 복사해 가진 쪽에도)
        let guard = state.clone().begin().unwrap();
        assert_eq!(guard.install_plan(), Some(PathBuf::from("x/install.sh")));
        assert_eq!(
            guard.restore_plan().map(|(id, _)| id).as_deref(),
            Some("2026-10-18_143205")
        );
        // 확인은 한 번만 꺼낼 수 있다
        assert_eq!(guard.take_check(), Some(checked));
        assert_eq!(guard.take_check(), None);
        guard.remember_check(Some(git::CheckedUpdate {
            branch: "b".into(),
            upstream_hash: "b".repeat(40),
        }));
        guard.forget_all();
        assert_eq!(guard.take_check(), None);
        assert_eq!(guard.install_plan(), None);
        assert_eq!(guard.restore_plan(), None);
    }

    #[test]
    fn a_panic_while_holding_the_memory_does_not_lock_the_app_out() {
        let state = HarnessState::default();
        let inner = state.clone();
        let _ = std::thread::spawn(move || {
            let guard = inner.begin().unwrap();
            let _memory = guard.memory();
            panic!("boom");
        })
        .join();
        let guard = state.begin().unwrap();
        guard.remember_install_plan(Some(PathBuf::from("y")));
        assert_eq!(guard.install_plan(), Some(PathBuf::from("y")));
    }
}
