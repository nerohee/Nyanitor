//! 앱 업데이트 (P11-01, D-26) — GitHub Releases 의 `latest.json` 으로 새 판을 확인하고, 사용자가 누르면 받아 설치한 뒤 다시 시작한다.
//!
//! - 이 파일: 상태 · 한 번에 하나 규칙 · 확인 · 설치의 **순서** (`UpdateStore`, `run_check`, `run_install`) 와 순수 함수.
//!   실제 네트워크 · 플러그인 호출은 인자(함수 · 닫는 식)로 받으므로 시험은 가짜로 돈다.
//! - `commands` — Tauri 명령 셋 · 플러그인(`tauri-plugin-updater`) 부르기 · 시작 때 자동 확인 · 끝내기 직전 정리 (얇게)
//!
//! 화면은 이 플러그인을 직접 부르지 않는다 — `capabilities/` 에 `updater:*` · `process:*` 권한이 없고, 화면은 앱 명령(`app_update_*`)과
//! 이벤트(`UPDATE_EVENT`)만 쓴다 (알림 · 대화상자와 같은 방식, D-47 · D-50). 화면이 넘기는 값은 `force` 하나뿐이고, 주소 · 키 · 경로를 받는 길은 없다
//! (배포 주소와 공개 키는 `tauri.conf.json` 의 `plugins.updater`).
//!
//! 상태는 앱(Rust)이 들고 있다: 확인 중 → 최신 / 새 판 / (설치 방식이 안 맞음) / 실패, 새 판 → 받는 중 → 설치 준비 끝 → 다시 시작.
//! 확인 · 받기는 한 번에 하나 — 돌고 있을 때 또 부르면 `update_busy`. 앱을 끄게 되는 일이 있으면(`attention::quit_warning`) `force` 없이는 설치하지 않고 경고만 돌려준다.

pub mod commands;

use std::ffi::OsStr;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri_plugin_log::log;

use crate::attention::QuitWarning;
use crate::error::AppError;
use crate::harness::HarnessTask;

/// 화면이 듣는 이벤트 이름 (`src/lib/ipc-types.ts` 의 `APP_UPDATE_EVENT` 와 같이 바꾼다). 내용은 `UpdateStatus` 그대로 — 바뀔 때마다 보낸다.
pub const UPDATE_EVENT: &str = "app:update";

/// 바뀐 점(릴리스 글)을 이 글자 수까지만 화면에 준다 — 넘으면 자르고 `notes_truncated`
pub const NOTES_MAX_CHARS: usize = 4000;

/// 받는 진행을 이벤트로 보내는 최소 간격 (조각마다 보내면 화면이 밀린다). 다 받은 순간은 간격과 상관없이 보낸다.
pub const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);

/// 오류 문구(진단용 영어)를 화면에 줄 때의 최대 글자 수
const MESSAGE_MAX_CHARS: usize = 300;

/// 새 판 하나 — 화면이 보이는 것
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub version: String,
    /// 릴리스 날짜 `YYYY-MM-DD` (모르면 `None`)
    pub date: Option<String>,
    /// 바뀐 점 — GitHub 릴리스 글 (마크다운 그대로, `NOTES_MAX_CHARS` 까지). 없으면 `None`
    pub notes: Option<String>,
    /// 글이 길어서 잘랐다
    pub notes_truncated: bool,
}

/// 이 설치 방식으로는 앱이 스스로 설치하지 못하는 까닭
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnsupportedReason {
    /// Linux deb 로 설치했다 — 업데이터는 AppImage 만 바꿀 수 있다 (화면이 "Releases 에서 받기" 를 보인다)
    NotAppImage,
}

/// 어느 단계에서 실패했나 — 화면이 문구를 고르는 열쇠
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailStage {
    Check,
    Download,
    Install,
}

/// 앱 업데이트의 지금 상태 (화면에 `state` 로 간다)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStatus {
    /// 아직 확인하지 않았다 (앱을 막 열었다)
    Idle,
    Checking,
    /// 지금 판이 최신이다
    Latest,
    /// 새 판이 있다 — 사용자가 누르면 받는다
    Available {
        release: ReleaseInfo,
    },
    /// 받는 중. `total` 은 서버가 크기를 알려 주지 않으면 `None`
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// 받아서 서명까지 확인했고 설치만 남았다 (경고 때문에 멈췄거나 설치 직전)
    Ready {
        version: String,
    },
    /// 새 판은 있지만 이 설치 방식으로는 앱이 설치하지 못한다
    Unsupported {
        reason: UnsupportedReason,
        release: ReleaseInfo,
    },
    /// 확인 · 받기 · 설치가 실패했다. `message` 는 진단용 영어 한 줄 (화면은 `stage` 로 문구를 고른다)
    Failed {
        stage: FailStage,
        message: String,
    },
}

/// 설치하려는데 앱을 끄면 안 되는 일이 있다 (`attention::QuitWarning` 의 화면용 모양)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WarningKind {
    /// 먹물이 일하는 중 (턴 · 작업자 · 남은 요청)
    Working,
    /// 하네스를 받는 중
    HarnessFetch,
    /// 하네스를 설치 · 되돌리는 중 (내 수정 적용 · 기록 되돌리기 포함)
    HarnessInstall,
}

impl WarningKind {
    pub fn from_quit(warning: QuitWarning) -> Self {
        match warning {
            QuitWarning::Working => WarningKind::Working,
            QuitWarning::Harness(HarnessTask::Fetch) => WarningKind::HarnessFetch,
            // `Light` 는 경고로 오지 않는다 — 와도 설치 경고가 더 안전한 쪽이다 (`QuitWarning::message` 와 같다)
            QuitWarning::Harness(_) => WarningKind::HarnessInstall,
        }
    }
}

/// 설치 명령의 결과 — 어떤 일이 있었나
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOutcome {
    /// 설치를 끝냈고 앱이 다시 시작한다 (Windows 는 설치 프로그램이 앱을 끝내고 다시 띄우므로 이 결과가 오기 전에 창이 닫힐 수 있다)
    Restarting,
    /// 앱을 끄면 안 되는 일이 있어 설치하지 않았다 — `warning` 을 보이고 사용자가 고르면 `force` 로 다시 부른다
    Warning,
    /// 설치할 새 판이 없다 (확인하지 않았거나 최신이다)
    NoUpdate,
    /// 이 설치 방식으로는 설치하지 못한다 (`Unsupported` 상태)
    Unsupported,
    /// 받기 · 설치가 실패했다 (`status` 가 `failed`)
    Failed,
}

/// `app_update_install` 의 결과
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub outcome: InstallOutcome,
    /// `outcome` 이 `warning` 일 때만
    pub warning: Option<WarningKind>,
    /// 이 명령이 끝난 뒤의 상태
    pub status: UpdateStatus,
}

// ───────────────────────── 순수 함수 ─────────────────────────

/// 릴리스 글을 화면에 줄 만큼 다듬는다 — 앞뒤 공백을 떼고, 줄바꿈은 `\n` 으로 맞추고, `max_chars` 글자(문자 단위)를 넘으면 자른다.
/// 빈 글은 `None`. 돌려주는 둘째 값은 잘랐는가.
pub fn trim_notes(body: Option<&str>, max_chars: usize) -> (Option<String>, bool) {
    let Some(body) = body else {
        return (None, false);
    };
    let text = body.replace("\r\n", "\n").replace('\r', "\n");
    let text = text.trim();
    if text.is_empty() {
        return (None, false);
    }
    match text.char_indices().nth(max_chars) {
        None => (Some(text.to_string()), false),
        Some((end, _)) => (Some(text[..end].trim_end().to_string()), true),
    }
}

/// 진단용 오류 글을 한 줄로 줄인다 (줄바꿈 → 공백, `MESSAGE_MAX_CHARS` 글자까지)
pub fn short_message(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= MESSAGE_MAX_CHARS {
        return one_line;
    }
    let cut: String = one_line.chars().take(MESSAGE_MAX_CHARS).collect();
    format!("{cut}…")
}

/// 이 설치 방식이면 앱이 스스로 설치할 수 없는가. `os` 는 `std::env::consts::OS`, `appimage` 는 환경 변수 `APPIMAGE`.
/// Linux 에서 `APPIMAGE` 가 없거나 비었으면 deb 같은 시스템 설치다 — 업데이터는 AppImage 파일만 바꿀 수 있다. 그 밖의 OS 는 설치할 수 있다.
pub fn install_unsupported(os: &str, appimage: Option<&OsStr>) -> Option<UnsupportedReason> {
    if os != "linux" {
        return None;
    }
    match appimage {
        Some(path) if !path.is_empty() => None,
        _ => Some(UnsupportedReason::NotAppImage),
    }
}

/// 이 PC 의 환경으로 `install_unsupported` 를 묻는다
pub fn install_unsupported_here() -> Option<UnsupportedReason> {
    install_unsupported(
        std::env::consts::OS,
        std::env::var_os("APPIMAGE").as_deref(),
    )
}

/// 시작 때 자동으로 확인하는가 — 출시 빌드만 (개발 빌드는 수동 명령으로만)
pub fn auto_check_enabled(debug_build: bool) -> bool {
    !debug_build
}

/// 날짜 글자가 `YYYY-MM-DD` 모양일 때만 쓴다
pub fn clean_date(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let ok = bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        });
    ok.then(|| text.to_string())
}

// ───────────────────────── 상태 기억 ─────────────────────────

type Emit = Arc<dyn Fn(&UpdateStatus) + Send + Sync>;

struct Inner<H> {
    status: UpdateStatus,
    /// 확인이 찾은 새 판의 손잡이 (플러그인의 `Update`)
    found: Option<H>,
    /// 받아서 서명을 확인한 설치 파일 (`Ready` 일 때)
    bytes: Option<Vec<u8>>,
    /// 확인 · 받기 · 설치가 도는 중 (한 번에 하나)
    working: bool,
    /// 받기 진행을 마지막으로 이벤트로 보낸 때
    last_progress_emit: Option<Instant>,
}

/// 앱 업데이트의 상태 · 한 번에 하나 규칙. 복제하면 같은 기억을 가리킨다 (Tauri `State` · 스레드에 나눠 쥔다).
/// `H` 는 새 판 손잡이 — 실제로는 `tauri_plugin_updater::Update`, 시험은 아무 값.
pub struct UpdateStore<H> {
    inner: Arc<Mutex<Inner<H>>>,
    emit: Emit,
}

impl<H> Clone for UpdateStore<H> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
            emit: Arc::clone(&self.emit),
        }
    }
}

impl<H> UpdateStore<H> {
    /// `emit` 은 상태가 바뀔 때마다 (잠금 밖에서) 불린다 — 실제로는 Tauri 이벤트로 내보낸다.
    pub fn new(emit: impl Fn(&UpdateStatus) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                status: UpdateStatus::Idle,
                found: None,
                bytes: None,
                working: false,
                last_progress_emit: None,
            })),
            emit: Arc::new(emit),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner<H>> {
        // 한 번 패닉한 일이 남긴 기억도 쓸 수 있게 둔다 (값은 단순해서 반쯤 바뀐 상태가 없다)
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 지금 상태
    pub fn status(&self) -> UpdateStatus {
        self.lock().status.clone()
    }

    /// 기억을 바꾸고, 상태가 달라졌으면 이벤트를 보낸다 (이벤트는 잠금 밖에서)
    fn mutate<R>(&self, change: impl FnOnce(&mut Inner<H>) -> R) -> R {
        let (result, changed) = {
            let mut inner = self.lock();
            let before = inner.status.clone();
            let result = change(&mut inner);
            let changed = (inner.status != before).then(|| inner.status.clone());
            (result, changed)
        };
        if let Some(status) = changed {
            (self.emit)(&status);
        }
        result
    }

    /// 확인을 시작한다. 돌고 있으면 `update_busy`. 이미 받아 둔 새 판이 있으면(`Ready`) 아무것도 하지 않는다 (`None`) — 받은 파일을 버리지 않으려고.
    pub fn begin_check(&self) -> Result<Option<CheckRun<H>>, AppError> {
        let before = {
            let mut inner = self.lock();
            if inner.working {
                return Err(AppError::UpdateBusy);
            }
            if matches!(inner.status, UpdateStatus::Ready { .. }) {
                return Ok(None);
            }
            inner.working = true;
            inner.status.clone()
        };
        self.mutate(|inner| inner.status = UpdateStatus::Checking);
        Ok(Some(CheckRun {
            store: self.clone(),
            before,
            armed: true,
        }))
    }

    /// 설치를 시작한다. `warning` 은 지금 앱을 끄면 안 되는 일 (`force` 일 때는 `None` 으로 부른다).
    /// 돌고 있으면 `update_busy`. 경고가 있으면 아무것도 바꾸지 않고 `Warn`. 새 판이 없거나 설치할 수 없는 방식이면 `Refused`.
    pub fn begin_install(&self, warning: Option<WarningKind>) -> Result<Begin<H>, AppError>
    where
        H: Clone,
    {
        let begun = {
            let mut inner = self.lock();
            if inner.working {
                return Err(AppError::UpdateBusy);
            }
            match &inner.status {
                UpdateStatus::Unsupported { .. } => {
                    return Ok(Begin::Refused(InstallOutcome::Unsupported));
                }
                UpdateStatus::Available { .. } | UpdateStatus::Ready { .. } => {}
                _ => return Ok(Begin::Refused(InstallOutcome::NoUpdate)),
            }
            if let Some(kind) = warning {
                return Ok(Begin::Warn(kind));
            }
            let Some(handle) = inner.found.clone() else {
                // 상태는 새 판인데 손잡이가 없다 — 있을 수 없는 모양이라 새 판이 없는 것으로 본다
                return Ok(Begin::Refused(InstallOutcome::NoUpdate));
            };
            inner.working = true;
            (handle, inner.bytes.take())
        };
        let (handle, bytes) = begun;
        match bytes {
            Some(bytes) => {
                let run = InstallRun::new(self.clone(), FailStage::Install);
                Ok(Begin::Install(run, handle, bytes))
            }
            None => {
                let run = InstallRun::new(self.clone(), FailStage::Download);
                self.mutate(|inner| {
                    let version = match &inner.status {
                        UpdateStatus::Available { release } => release.version.clone(),
                        UpdateStatus::Ready { version } => version.clone(),
                        _ => String::new(),
                    };
                    inner.last_progress_emit = None;
                    inner.status = UpdateStatus::Downloading {
                        version,
                        received: 0,
                        total: None,
                    };
                });
                Ok(Begin::Download(run, handle))
            }
        }
    }

    /// 받은 조각을 센다. 이벤트는 `PROGRESS_EMIT_INTERVAL` 마다 (다 받은 순간은 바로) 보낸다. 받는 중이 아니면 아무것도 하지 않는다.
    pub fn progress(&self, chunk: u64, total: Option<u64>, now: Instant) {
        let emitted = {
            let mut inner = self.lock();
            let last = inner.last_progress_emit;
            let UpdateStatus::Downloading {
                received,
                total: known_total,
                ..
            } = &mut inner.status
            else {
                return;
            };
            *received = received.saturating_add(chunk);
            if total.is_some() {
                *known_total = total;
            }
            let complete = known_total.is_some_and(|all| *received >= all);
            let due =
                last.is_none_or(|at| now.saturating_duration_since(at) >= PROGRESS_EMIT_INTERVAL);
            if complete || due {
                inner.last_progress_emit = Some(now);
                Some(inner.status.clone())
            } else {
                None
            }
        };
        if let Some(status) = emitted {
            (self.emit)(&status);
        }
    }
}

/// `begin_install` 의 답
pub enum Begin<H> {
    /// 앱을 끄면 안 되는 일이 있다 — 아무것도 바꾸지 않았다
    Warn(WarningKind),
    /// 설치할 수 없다 — 아무것도 바꾸지 않았다
    Refused(InstallOutcome),
    /// 새 판을 받는다 (상태는 `Downloading`)
    Download(InstallRun<H>, H),
    /// 받아 둔 파일로 설치한다
    Install(InstallRun<H>, H, Vec<u8>),
}

/// 돌고 있는 확인 — 끝내지 않고 버려지면(패닉 · 중단) 자리를 놓고 확인 전 상태로 돌려놓는다
pub struct CheckRun<H> {
    store: UpdateStore<H>,
    /// 확인을 시작하기 전의 상태 (조용한 확인이 실패하면 이 상태로 돌아간다)
    before: UpdateStatus,
    armed: bool,
}

impl<H> CheckRun<H> {
    /// 확인 결과를 반영한다. `silent` (시작 때 자동 확인) 인데 실패하면 화면에 오류를 내지 않고 확인 전 상태로 돌아간다 (로그만).
    pub fn finish(
        mut self,
        result: Result<Option<(ReleaseInfo, H)>, String>,
        unsupported: Option<UnsupportedReason>,
        silent: bool,
    ) -> UpdateStatus {
        self.armed = false;
        let before = self.before.clone();
        self.store.mutate(move |inner| {
            inner.working = false;
            if let (Err(message), true) = (&result, silent) {
                // 확인 전에 알던 새 판(손잡이 · 받은 파일 포함)은 그대로 둔다
                log::warn!("update check failed (startup): {}", short_message(message));
                inner.status = before;
                return inner.status.clone();
            }
            inner.found = None;
            inner.bytes = None;
            inner.status = match (result, unsupported) {
                (Err(message), _) => {
                    log::warn!("update check failed: {}", short_message(&message));
                    UpdateStatus::Failed {
                        stage: FailStage::Check,
                        message: short_message(&message),
                    }
                }
                (Ok(None), _) => UpdateStatus::Latest,
                (Ok(Some((release, _))), Some(reason)) => {
                    UpdateStatus::Unsupported { reason, release }
                }
                (Ok(Some((release, handle))), None) => {
                    inner.found = Some(handle);
                    UpdateStatus::Available { release }
                }
            };
            inner.status.clone()
        })
    }
}

impl<H> Drop for CheckRun<H> {
    fn drop(&mut self) {
        if self.armed {
            let before = self.before.clone();
            self.store.mutate(|inner| {
                inner.working = false;
                inner.status = before;
            });
        }
    }
}

/// 돌고 있는 받기 · 설치 — 끝내지 않고 버려지면 실패로 돌려놓는다
pub struct InstallRun<H> {
    store: UpdateStore<H>,
    armed: bool,
    stage: FailStage,
}

impl<H> InstallRun<H> {
    fn new(store: UpdateStore<H>, stage: FailStage) -> Self {
        Self {
            store,
            armed: true,
            stage,
        }
    }

    /// 다 받았다 — 상태는 `Ready`, 설치 파일은 기억한다 (아직 설치하지 않았다)
    pub fn downloaded(mut self, bytes: Vec<u8>) -> UpdateStatus {
        self.armed = false;
        self.store.mutate(move |inner| {
            inner.working = false;
            let version = match &inner.status {
                UpdateStatus::Downloading { version, .. } | UpdateStatus::Ready { version } => {
                    version.clone()
                }
                _ => String::new(),
            };
            inner.bytes = Some(bytes);
            inner.status = UpdateStatus::Ready { version };
            inner.status.clone()
        })
    }

    /// 설치 파일을 넘겼고 설치 프로그램이 앱을 다시 띄운다 — 더 할 일이 없다 (상태는 `Ready` 로 둔다).
    pub fn installed(mut self) -> UpdateStatus {
        self.armed = false;
        self.store.mutate(|inner| {
            inner.working = false;
            inner.status.clone()
        })
    }

    /// 받기 · 설치가 실패했다 — 새 판 손잡이 · 받은 파일을 버린다 (다시 하려면 다시 확인한다)
    pub fn fail(mut self, message: &str) -> UpdateStatus {
        self.armed = false;
        let stage = self.stage;
        self.store
            .mutate(move |inner| fail_inner(inner, stage, message))
    }
}

fn fail_inner<H>(inner: &mut Inner<H>, stage: FailStage, message: &str) -> UpdateStatus {
    log::warn!("update {stage:?} failed: {}", short_message(message));
    inner.working = false;
    inner.found = None;
    inner.bytes = None;
    inner.status = UpdateStatus::Failed {
        stage,
        message: short_message(message),
    };
    inner.status.clone()
}

impl<H> Drop for InstallRun<H> {
    fn drop(&mut self) {
        if self.armed {
            let stage = self.stage;
            self.store
                .mutate(|inner| fail_inner(inner, stage, "the update was interrupted"));
        }
    }
}

// ───────────────────────── 확인 · 설치의 순서 ─────────────────────────

/// 새 판을 확인한다. `check` 가 실제 확인 (플러그인), `unsupported` 는 이 설치 방식으로 설치할 수 있는지 (`install_unsupported_here`).
/// 이미 확인 중이거나 받는 중이면 `update_busy`, 받아 둔 새 판이 있으면 그대로 그 상태를 돌려준다.
pub async fn run_check<H, F>(
    store: &UpdateStore<H>,
    silent: bool,
    unsupported: Option<UnsupportedReason>,
    check: F,
) -> Result<UpdateStatus, AppError>
where
    F: Future<Output = Result<Option<(ReleaseInfo, H)>, String>>,
{
    let Some(run) = store.begin_check()? else {
        return Ok(store.status());
    };
    let result = check.await;
    Ok(run.finish(result, unsupported, silent))
}

/// 받는 진행을 알리는 함수 — 조각 크기와 (알면) 전체 크기
pub type ProgressFn = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

/// 새 판을 받아 설치한다 (`InstallOutcome::Restarting` 이면 부른 쪽이 다시 시작한다).
///
/// 순서: (경고 확인) → 받기 → (경고 다시 확인) → 설치. 받는 데 시간이 걸리므로 받은 뒤 한 번 더 확인한다 — 그 사이 일이 시작됐을 수 있다.
/// 경고에 걸리면 받은 파일은 `Ready` 로 남아 있고, `force` 로 다시 부르면 받지 않고 바로 설치한다.
/// `warning` 은 지금 앱을 끄면 안 되는 일 (`force` 이면 부르지 않는다), `download` 는 받기 + 서명 확인, `install` 은 설치.
pub async fn run_install<H, W, WF, D, DF, I, IF>(
    store: &UpdateStore<H>,
    force: bool,
    warning: W,
    download: D,
    install: I,
) -> Result<InstallResult, AppError>
where
    H: Clone + Send + 'static,
    W: Fn() -> WF,
    WF: Future<Output = Result<Option<WarningKind>, AppError>>,
    D: FnOnce(H, ProgressFn) -> DF,
    DF: Future<Output = Result<Vec<u8>, String>>,
    I: FnOnce(H, Vec<u8>) -> IF,
    IF: Future<Output = Result<(), String>>,
{
    let result = |outcome, warning, status| InstallResult {
        outcome,
        warning,
        status,
    };
    let mut download = Some(download);
    // 받기(1) → 받은 뒤 다시 확인하고 설치(2) 두 번이면 끝난다
    for _ in 0..2 {
        let warn = if force { None } else { warning().await? };
        match store.begin_install(warn)? {
            Begin::Warn(kind) => {
                return Ok(result(InstallOutcome::Warning, Some(kind), store.status()));
            }
            Begin::Refused(outcome) => return Ok(result(outcome, None, store.status())),
            Begin::Download(run, handle) => {
                let Some(download) = download.take() else {
                    // 한 번 받았는데 또 받으라는 것은 있을 수 없는 흐름이다
                    let status = run.fail("the update was requested to download twice");
                    return Ok(result(InstallOutcome::Failed, None, status));
                };
                let progress_store = store.clone();
                let progress: ProgressFn = Arc::new(move |chunk, total| {
                    progress_store.progress(chunk, total, Instant::now());
                });
                match download(handle, progress).await {
                    Ok(bytes) => {
                        run.downloaded(bytes);
                    }
                    Err(message) => {
                        let status = run.fail(&message);
                        return Ok(result(InstallOutcome::Failed, None, status));
                    }
                }
            }
            Begin::Install(run, handle, bytes) => {
                return match install(handle, bytes).await {
                    Ok(()) => Ok(result(InstallOutcome::Restarting, None, run.installed())),
                    Err(message) => {
                        let status = run.fail(&message);
                        Ok(result(InstallOutcome::Failed, None, status))
                    }
                };
            }
        }
    }
    // 두 번을 돌고도 끝나지 않았다 — 받은 직후 다른 호출이 끼어든 경우뿐이다
    Err(AppError::UpdateBusy)
}

#[cfg(test)]
mod tests;
