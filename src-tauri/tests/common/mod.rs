//! 가짜 CLI 시험 도우미 — 가짜 `claude` 실행 파일 찾기, 이벤트 모으기, 프로세스 살아 있나 확인.
#![allow(dead_code)] // 시험 파일마다 쓰는 것이 다르다

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nyanitor_lib::claude::events::{SessionEvent, StartInfo, StartRequest};
use nyanitor_lib::claude::exec::ClaudeCommand;
use nyanitor_lib::claude::session::{EventSink, ManagerConfig, SessionManager};
use nyanitor_lib::claude::store::ResumeStore;
use nyanitor_lib::error::AppError;
use serde_json::Value;

pub const WAIT: Duration = Duration::from_secs(30);

/// 가짜 CLI 실행 파일. `cargo test` 가 예제도 만든다 (`[[example]] fake_claude`).
pub fn fake_exe() -> PathBuf {
    let mut dir = std::env::current_exe().expect("current exe");
    dir.pop(); // deps
    dir.pop(); // debug
    let name = if cfg!(windows) {
        "fake_claude.exe"
    } else {
        "fake_claude"
    };
    let exe = dir.join("examples").join(name);
    assert!(
        exe.exists(),
        "fake claude not built at {} — run `cargo test` (builds examples) or `cargo build --example fake_claude`",
        exe.display()
    );
    exe
}

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cli")
}

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// 시험마다 새 임시 폴더 (프로젝트 폴더 · 저장 파일 · 로그가 들어간다).
pub fn unique_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "nyanitor-test-{name}-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

pub struct ChannelSink(Mutex<Sender<SessionEvent>>);

impl EventSink for ChannelSink {
    fn emit(&self, event: SessionEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

/// 가짜 CLI 로 띄울 `ClaudeCommand` 와 그것이 stdin · 인자를 적는 로그 파일.
pub struct FakeCmd {
    pub command: ClaudeCommand,
    pub log: PathBuf,
}

impl FakeCmd {
    pub fn env(mut self, name: &str, value: impl Into<OsString>) -> Self {
        self.command = self.command.with_extra_env(name, value);
        self
    }

    /// 가짜 CLI 가 받은 인자와 stdin 줄 (`{"argv":[..]}` · `{"stdin":"<줄>"}`).
    pub fn log_entries(&self) -> Vec<Value> {
        fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    /// 세션으로 띄운 때의 인자 (`-p ...`). `--version` 같은 짧은 호출은 뺀다.
    pub fn argv(&self) -> Vec<String> {
        self.log_entries()
            .iter()
            .filter_map(|e| e.get("argv"))
            .map(|a| {
                a.as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_string())
                    .collect::<Vec<_>>()
            })
            .find(|argv| argv.first().map(String::as_str) == Some("-p"))
            .unwrap_or_default()
    }

    /// 앱이 stdin 으로 보낸 JSON 줄들 (파싱한 것).
    pub fn stdin_messages(&self) -> Vec<Value> {
        self.log_entries()
            .iter()
            .filter_map(|e| e.get("stdin").and_then(Value::as_str))
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }

    /// 앱이 보낸 `control_response` 의 안쪽 `response` 들.
    pub fn control_responses(&self) -> Vec<Value> {
        self.stdin_messages()
            .into_iter()
            .filter(|m| m["type"] == "control_response")
            .map(|m| m["response"].clone())
            .collect()
    }
}

pub struct Harness {
    pub manager: SessionManager,
    rx: Receiver<SessionEvent>,
    seen: Vec<SessionEvent>,
    cursor: usize,
    pub root: PathBuf,
    /// 프로젝트 폴더 (세션의 작업 폴더)
    pub project: PathBuf,
    pub store_path: PathBuf,
}

pub fn fast_config() -> ManagerConfig {
    ManagerConfig {
        stop_grace: Duration::from_millis(700),
        shutdown_grace: Duration::from_millis(500),
        kill_wait: Duration::from_secs(5),
        reader_grace: Duration::from_secs(2),
    }
}

impl Harness {
    pub fn new(name: &str) -> Self {
        Self::with_config(name, fast_config())
    }

    pub fn with_config(name: &str, config: ManagerConfig) -> Self {
        Self::build(name, config, None)
    }

    /// 이 프로젝트의 마지막 세션 ID 가 이미 저장돼 있는 상태로 (앱을 다시 켠 뒤처럼).
    pub fn with_saved_session(name: &str, session_id: &str) -> Self {
        Self::build(name, fast_config(), Some(session_id))
    }

    fn build(name: &str, config: ManagerConfig, saved: Option<&str>) -> Self {
        let root = unique_dir(name);
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        let store_path = root.join("data").join("claude-sessions.json");
        if let Some(id) = saved {
            ResumeStore::open(store_path.clone())
                .set(&nyanitor_lib::claude::store::project_key(&project), id)
                .unwrap();
        }
        let (tx, rx) = mpsc::channel();
        let manager = SessionManager::new(
            Arc::new(ChannelSink(Mutex::new(tx))),
            ResumeStore::open(store_path.clone()),
            config,
        );
        Self {
            manager,
            rx,
            seen: Vec::new(),
            cursor: 0,
            root,
            project,
            store_path,
        }
    }

    /// 녹화 `replay` 를 재생하는 가짜 CLI. `flags` 는 `NYANITOR_FAKE_FLAGS`.
    pub fn fake(&self, replay: &str, flags: &[&str]) -> FakeCmd {
        static LOGS: AtomicU32 = AtomicU32::new(0);
        let log = self
            .root
            .join(format!("fake-{}.log", LOGS.fetch_add(1, Ordering::Relaxed)));
        let command = ClaudeCommand::new(fake_exe())
            .with_extra_env("NYANITOR_FAKE_REPLAY", replay)
            .with_extra_env("NYANITOR_FAKE_FLAGS", flags.join(","))
            .with_extra_env("NYANITOR_FAKE_LOG", log.clone());
        FakeCmd { command, log }
    }

    pub fn request(&self) -> StartRequest {
        StartRequest {
            project_dir: self.project.display().to_string(),
            model: None,
            resume: false,
            use_api_key: false,
        }
    }

    pub fn start(&self, cmd: &FakeCmd) -> Result<StartInfo, AppError> {
        self.manager.start(self.request(), cmd.command.clone())
    }

    pub fn start_resume(&self, cmd: &FakeCmd) -> Result<StartInfo, AppError> {
        let mut request = self.request();
        request.resume = true;
        self.manager.start(request, cmd.command.clone())
    }

    /// 아직 보지 않은 이벤트 중 `pick` 이 `Some` 을 돌려주는 첫 번째를 기다려 꺼낸다 (그 앞의 것은 지나간 것으로 본다).
    pub fn wait_for<T>(&mut self, what: &str, pick: impl Fn(&SessionEvent) -> Option<T>) -> T {
        let deadline = Instant::now() + WAIT;
        loop {
            while self.cursor < self.seen.len() {
                let event = &self.seen[self.cursor];
                self.cursor += 1;
                if let Some(found) = pick(event) {
                    return found;
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            match self.rx.recv_timeout(left) {
                Ok(event) => self.seen.push(event),
                Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                    panic!("timed out waiting for {what}; seen: {:#?}", self.kinds())
                }
            }
        }
    }

    /// 지금까지 본 이벤트 종류 (RawLog 는 뺀다).
    pub fn kinds(&self) -> Vec<String> {
        self.seen
            .iter()
            .filter(|e| !matches!(e, SessionEvent::RawLog(_)))
            .map(kind_of)
            .collect()
    }

    /// 지금까지 본 모든 이벤트.
    pub fn seen(&mut self) -> &[SessionEvent] {
        while let Ok(event) = self.rx.try_recv() {
            self.seen.push(event);
        }
        &self.seen
    }

    pub fn wait_ended(&mut self) -> SessionEvent {
        self.wait_for("session_ended", |e| {
            matches!(e, SessionEvent::SessionEnded { .. }).then(|| e.clone())
        })
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.manager.shutdown();
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn kind_of(event: &SessionEvent) -> String {
    serde_json::to_value(event).unwrap()["type"]
        .as_str()
        .unwrap()
        .to_string()
}

pub fn to_json(event: &SessionEvent) -> Value {
    serde_json::to_value(event).unwrap()
}

#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: 읽기 전용 질의. 핸들은 바로 닫는다.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code);
        CloseHandle(handle);
        ok != 0 && code == 259 // STILL_ACTIVE
    }
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: 신호 0 은 존재 확인만 한다.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// `pid` 가 `within` 안에 사라지기를 기다린다.
pub fn wait_dead(pid: u32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !pid_alive(pid)
}

pub fn wait_for_file(path: &Path, within: Duration) -> String {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Ok(text) = fs::read_to_string(path)
            && !text.is_empty()
        {
            return text;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("{} did not appear", path.display());
}
