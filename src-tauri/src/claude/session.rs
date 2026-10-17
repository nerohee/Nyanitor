//! 세션 관리자 — `claude` 프로세스 하나 = 대화 세션 하나 (D-12: 한 번에 하나).
//!
//! 스레드 구성 (프로세스마다): 쓰기 1 (stdin 은 여기서만 쓴다 → 줄이 섞이지 않는다) · stdout 읽기 · stderr 읽기 ·
//! 기다리기 (프로세스가 끝났다는 신호는 EOF 가 아니라 `wait()` 로 받는다 — 손자 프로세스가 파이프를 쥐고 있어도 끝을 안다).
//! 받은 줄의 뜻 풀이는 `protocol.rs`, 화면으로 가는 이벤트 모양은 `events.rs`.
//! 이 모듈은 비공식 protocol 의 세부(필드 이름 등)를 모른다 — 줄을 `protocol` 에 넘기고 결과를 반영할 뿐이다.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tauri_plugin_log::log;

use super::KNOWN_CLI_VERSION;
use super::discover;
use super::events::{
    AnswerValue, EndKind, RawLogEntry, Response, SessionEvent, SessionState, StartInfo,
    StartRequest, StopInfo,
};
use super::exec::{self, ClaudeCommand};
use super::process_tree::ProcessTree;
use super::protocol::{
    self, Interpretation, Interpreter, PendingKind, PendingRequest, truncate_chars,
};
use super::store::{ResumeStore, project_key};
use crate::error::AppError;

/// 한 줄의 최대 길이 (줄바꿈 제외) — 정상 출력(수십 KB)보다 훨씬 크다. 넘으면 그 줄은 버리고 원본 로그에 알린다 (메모리 보호).
const MAX_LINE_BYTES: usize = 16 << 20;
/// 큰 줄을 읽고 난 뒤 줄 버퍼를 이 크기로 줄인다 (한 번 커진 버퍼가 세션이 끝날 때까지 남지 않게).
const LINE_BUF_KEEP: usize = 256 << 10;
/// 원본 로그에 남기는 줄 수 · 한 줄당 글자 수.
const RAW_LOG_LINES: usize = 1000;
const RAW_LOG_LINE_CHARS: usize = 8000;
/// 사용자 글(메시지 · 말하기 · 질문 답)의 최대 크기.
const MAX_USER_TEXT_BYTES: usize = 1 << 20;

/// 화면 · 시험이 이벤트를 받는 자리.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: SessionEvent);
}

#[derive(Debug, Clone)]
pub struct ManagerConfig {
    /// 끝내기: stdin 을 닫고 기다리는 시간 — 안 끝나면 프로세스 트리를 강제로 끈다
    pub stop_grace: Duration,
    /// 앱을 끌 때의 같은 시간 (창이 오래 떠 있지 않게 더 짧게)
    pub shutdown_grace: Duration,
    /// 강제로 끈 뒤 끝났다는 신호를 기다리는 시간
    pub kill_wait: Duration,
    /// 프로세스가 끝난 뒤 남은 출력 읽기를 기다리는 시간
    pub reader_grace: Duration,
}

impl Default for ManagerConfig {
    fn default() -> Self {
        Self {
            stop_grace: Duration::from_secs(5),
            shutdown_grace: Duration::from_secs(2),
            kill_wait: Duration::from_secs(3),
            reader_grace: Duration::from_secs(2),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ───────────────────────── 원본 로그 ─────────────────────────

struct RawLog {
    seq: AtomicU64,
    started: Instant,
    entries: Mutex<VecDeque<RawLogEntry>>,
}

impl RawLog {
    fn new() -> Self {
        Self {
            seq: AtomicU64::new(0),
            started: Instant::now(),
            entries: Mutex::new(VecDeque::new()),
        }
    }

    fn clear(&self) {
        lock(&self.entries).clear();
    }

    fn record(&self, dir: &'static str, text: &str) -> RawLogEntry {
        let original_len = text.len();
        let shown = truncate_chars(text, RAW_LOG_LINE_CHARS);
        let entry = RawLogEntry {
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            dir,
            truncated: shown.len() != text.len(),
            text: shown,
            original_len,
            at_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
        };
        let mut entries = lock(&self.entries);
        if entries.len() >= RAW_LOG_LINES {
            entries.pop_front();
        }
        entries.push_back(entry.clone());
        entry
    }

    fn snapshot(&self) -> Vec<RawLogEntry> {
        lock(&self.entries).iter().cloned().collect()
    }
}

// ───────────────────────── 세션 ─────────────────────────

#[derive(Default)]
struct Flags {
    /// 턴이 도는 중 (사용자 메시지를 보낸 뒤 `result` 까지)
    busy: bool,
    stop_requested: bool,
    forced: bool,
    session_id: Option<String>,
    /// "다르게 하라고 말하기": 중단된 턴의 `result` 가 오면 보낼 말
    deferred: Option<String>,
    resume_not_found_sent: bool,
    stderr_tail: VecDeque<String>,
}

struct Session {
    id: u64,
    pid: u32,
    project_dir: PathBuf,
    project_key: String,
    /// `--resume` 으로 시작했다면 그 세션 ID
    resume_id: Option<String>,
    /// 쓰기 스레드로 가는 줄. `None` = stdin 을 닫았다.
    writer: Mutex<Option<Sender<String>>>,
    pending: Mutex<Vec<(String, PendingRequest)>>,
    flags: Mutex<Flags>,
    interpreter: Mutex<Interpreter>,
    tree: ProcessTree,
    /// 이벤트를 내보내는 자리의 잠금 · 닫힘 표시. 끝난 뒤에는 어떤 스레드도 이벤트를 내지 못한다.
    emit_gate: Mutex<bool>,
    exit: Mutex<Option<Option<i32>>>,
    exit_cv: Condvar,
    request_counter: AtomicU64,
}

impl Session {
    fn has_exited(&self) -> bool {
        lock(&self.exit).is_some()
    }

    /// 끝날 때까지 기다린다. 끝났으면 `true`.
    fn wait_exit(&self, timeout: Duration) -> bool {
        let guard = lock(&self.exit);
        let (guard, _) = self
            .exit_cv
            .wait_timeout_while(guard, timeout, |exit| exit.is_none())
            .unwrap_or_else(PoisonError::into_inner);
        guard.is_some()
    }

    fn emit(&self, shared: &Shared, event: SessionEvent) {
        let closed = lock(&self.emit_gate);
        if !*closed {
            shared.sink.emit(event);
        }
    }

    fn log_raw(&self, shared: &Shared, dir: &'static str, text: &str) {
        let entry = shared.raw.record(dir, text);
        self.emit(shared, SessionEvent::RawLog(entry));
    }

    fn warn(&self, shared: &Shared, code: &str, detail: Option<String>) {
        self.emit(
            shared,
            SessionEvent::Warning {
                code: code.to_string(),
                detail,
            },
        );
    }

    /// stdin 으로 줄 하나를 보낸다 (쓰기 스레드가 차례대로 쓴다).
    fn send_line(&self, line: String) -> Result<(), AppError> {
        debug_assert!(!line.contains('\n'));
        let writer = lock(&self.writer);
        match writer.as_ref() {
            Some(tx) => tx.send(line).map_err(|_| AppError::NoSession),
            None => Err(AppError::NoSession),
        }
    }

    /// stdin 을 닫는다 (쓰기 스레드가 남은 줄을 쓴 뒤 끝나면서 파이프를 닫는다).
    fn close_stdin(&self) {
        lock(&self.writer).take();
    }
}

/// 세션 자리. 시작은 `--version` 확인이 오래 걸릴 수 있어 그 동안 이 자리의 잠금을 쥐지 않고 `starting` 표시만 해 둔다.
#[derive(Default)]
struct Slot {
    session: Option<Arc<Session>>,
    /// 시작하는 중 (한 번에 하나 — 두 번째 시작은 `session_running`)
    starting: bool,
    /// 시작하는 중에 끝내기가 들어왔다 — 시작은 프로세스를 띄우지 않고 물러난다
    cancelled: bool,
}

struct Shared {
    sink: Arc<dyn EventSink>,
    store: Mutex<ResumeStore>,
    raw: RawLog,
    slot: Mutex<Slot>,
    config: ManagerConfig,
    next_id: AtomicU64,
    /// 아직 안 끝난 쓰기 스레드 수 (프로세스가 끝나면 0 으로 돌아와야 한다 — 시험 · 진단용)
    live_writers: AtomicUsize,
}

/// 세션 관리자. 복제해도 같은 관리자를 가리킨다 (Tauri `State` · 스레드에 나눠 쥔다).
#[derive(Clone)]
pub struct SessionManager {
    shared: Arc<Shared>,
}

impl SessionManager {
    pub fn new(sink: Arc<dyn EventSink>, store: ResumeStore, config: ManagerConfig) -> Self {
        Self {
            shared: Arc::new(Shared {
                sink,
                store: Mutex::new(store),
                raw: RawLog::new(),
                slot: Mutex::new(Slot::default()),
                config,
                next_id: AtomicU64::new(1),
                live_writers: AtomicUsize::new(0),
            }),
        }
    }

    /// 이 프로젝트의 마지막 세션 ID (이어 하기용). 없으면 `None`.
    pub fn last_session(&self, project_dir: &str) -> Result<Option<String>, AppError> {
        let dir = validate_project_dir(project_dir)?;
        Ok(lock(&self.shared.store).get(&project_key(&dir)))
    }

    pub fn raw_log(&self) -> Vec<RawLogEntry> {
        self.shared.raw.snapshot()
    }

    /// 아직 안 끝난 쓰기 스레드 수. 세션이 끝나면 곧 0 이 된다 (진단 · 시험용).
    pub fn running_writers(&self) -> usize {
        self.shared.live_writers.load(Ordering::SeqCst)
    }

    /// 세션을 시작한다. 이미 돌고 있으면 오류 (D-12).
    pub fn start(
        &self,
        request: StartRequest,
        command: ClaudeCommand,
    ) -> Result<StartInfo, AppError> {
        let project_dir = validate_project_dir(&request.project_dir)?;
        let model = request.model.as_deref().map(validate_model).transpose()?;

        // 시작 자리를 잡는다 — 두 번 눌러도 하나만 뜬다. 잠금은 표시를 하는 동안만 쥔다:
        // 아래의 `--version` 확인은 최대 20초 걸릴 수 있어서, 그 동안 잠그면 앱 종료 · 상태 조회가 같이 기다린다.
        {
            let mut slot = lock(&self.shared.slot);
            if slot.starting || slot.session.as_ref().is_some_and(|s| !s.has_exited()) {
                return Err(AppError::SessionRunning);
            }
            slot.starting = true;
            slot.cancelled = false;
        }
        let result = self.start_claimed(&request, command, &project_dir, model.as_deref());
        let mut slot = lock(&self.shared.slot);
        slot.starting = false;
        slot.cancelled = false;
        result
    }

    /// `start` 가 시작 자리를 잡은 뒤의 일: 버전 확인(잠금 밖) → 프로세스 띄우기 · 등록(잠금 안).
    fn start_claimed(
        &self,
        request: &StartRequest,
        command: ClaudeCommand,
        project_dir: &Path,
        model: Option<&str>,
    ) -> Result<StartInfo, AppError> {
        let key = project_key(project_dir);
        let resume_id = if request.resume {
            Some(
                lock(&self.shared.store)
                    .get(&key)
                    .ok_or(AppError::NoSavedSession)?,
            )
        } else {
            None
        };

        let command = command.keep_api_key(request.use_api_key);
        // 시작 전 버전 확인 (`system/init` 은 첫 메시지 뒤에야 온다). 잠금 밖에서 한다.
        let cli_version = discover::read_version(&command)?;

        let args = build_args(model, resume_id.as_deref());
        // 여기부터 자리 잠금 — 끝내기가 그 사이 들어왔으면 띄우지 않는다. 띄우기 · 등록은 짧다.
        let mut slot = lock(&self.shared.slot);
        if slot.cancelled {
            return Err(AppError::Internal(
                "the start was cancelled because the session was stopped".into(),
            ));
        }
        let mut process = command.command(&args);
        process
            .current_dir(project_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = process.spawn().map_err(|err| {
            if err.kind() == io::ErrorKind::NotFound {
                AppError::ClaudeNotFound
            } else {
                AppError::Internal(format!("could not start claude: {err}"))
            }
        })?;
        let tree = ProcessTree::attach(&child);
        let pid = child.id();
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            tree.kill();
            let _ = child.wait();
            return Err(AppError::Internal(
                "claude started without piped stdio".into(),
            ));
        };

        let (tx, rx) = mpsc::channel::<String>();
        let session = Arc::new(Session {
            id: self.shared.next_id.fetch_add(1, Ordering::Relaxed),
            pid,
            project_dir: project_dir.to_path_buf(),
            project_key: key,
            resume_id: resume_id.clone(),
            writer: Mutex::new(Some(tx)),
            pending: Mutex::new(Vec::new()),
            flags: Mutex::new(Flags::default()),
            interpreter: Mutex::new(Interpreter::new(project_dir)),
            tree,
            emit_gate: Mutex::new(false),
            exit: Mutex::new(None),
            exit_cv: Condvar::new(),
            request_counter: AtomicU64::new(1),
        });

        self.shared.raw.clear();
        let info = StartInfo {
            project_dir: project_dir.display().to_string(),
            pid,
            resumed: resume_id.is_some(),
            resume_session_id: resume_id.clone(),
            cli_version: Some(cli_version.clone()),
        };
        // 읽기 스레드가 이벤트를 내기 전에 먼저 알린다.
        session.emit(
            &self.shared,
            SessionEvent::SessionStarted {
                project_dir: info.project_dir.clone(),
                pid,
                resumed: info.resumed,
                resume_session_id: resume_id,
                cli_version: Some(cli_version.clone()),
            },
        );
        if protocol_version_differs(&cli_version) {
            session.warn(
                &self.shared,
                "cli_version_mismatch",
                Some(format!("found {cli_version}, verified {KNOWN_CLI_VERSION}")),
            );
        }
        if request.use_api_key && exec::api_key_present() {
            session.warn(&self.shared, "api_key_in_use", None);
        }

        if let Err(err) = self.spawn_threads(&session, child, stdin, stdout, stderr, rx) {
            // 이미 "시작됨" 을 알렸으므로 "끝남" 도 알린다. 먼저 뜬 쓰기 스레드가 남지 않게 stdin 도 닫는다.
            session.tree.kill();
            session.close_stdin();
            let mut closed = lock(&session.emit_gate);
            self.shared.sink.emit(SessionEvent::SessionEnded {
                ended: EndKind::Died,
                exit_code: None,
                forced: true,
                mid_turn: false,
                stderr_tail: Vec::new(),
            });
            *closed = true;
            return Err(err);
        }
        slot.session = Some(session);
        Ok(info)
    }

    fn spawn_threads(
        &self,
        session: &Arc<Session>,
        child: Child,
        stdin: ChildStdin,
        stdout: ChildStdout,
        stderr: ChildStderr,
        rx: Receiver<String>,
    ) -> Result<(), AppError> {
        let spawn = |name: &str, body: Box<dyn FnOnce() + Send>| {
            thread::Builder::new()
                .name(format!("claude-{name}-{}", session.id))
                .spawn(body)
                .map(drop)
                .map_err(|err| AppError::Internal(format!("could not start a thread: {err}")))
        };
        let (done_tx, done_rx) = mpsc::channel::<()>();
        {
            let (s, sh) = (session.clone(), self.shared.clone());
            // 스레드가 뜨기 전에 센다 — 세션이 끝난 뒤 0 이 아니면 쓰기 스레드가 안 끝난 것이다.
            self.shared.live_writers.fetch_add(1, Ordering::SeqCst);
            let started = spawn(
                "writer",
                Box::new(move || {
                    write_loop(&s, &sh, stdin, rx);
                    sh.live_writers.fetch_sub(1, Ordering::SeqCst);
                }),
            );
            if started.is_err() {
                self.shared.live_writers.fetch_sub(1, Ordering::SeqCst);
            }
            started?;
        }
        {
            let (s, sh, done) = (session.clone(), self.shared.clone(), done_tx.clone());
            spawn(
                "stdout",
                Box::new(move || {
                    read_stdout(&s, &sh, stdout);
                    drop(done);
                }),
            )?;
        }
        {
            let (s, sh, done) = (session.clone(), self.shared.clone(), done_tx);
            spawn(
                "stderr",
                Box::new(move || {
                    read_stderr(&s, &sh, stderr);
                    drop(done);
                }),
            )?;
        }
        {
            let (s, sh) = (session.clone(), self.shared.clone());
            spawn(
                "wait",
                Box::new(move || wait_and_finish(child, &s, &sh, &done_rx)),
            )?;
        }
        Ok(())
    }

    fn current(&self) -> Option<Arc<Session>> {
        lock(&self.shared.slot)
            .session
            .clone()
            .filter(|s| !s.has_exited())
    }

    pub fn state(&self) -> SessionState {
        match self.current() {
            None => SessionState {
                running: false,
                project_dir: None,
                pid: None,
                session_id: None,
                busy: false,
                pending: Vec::new(),
            },
            Some(session) => {
                let (busy, session_id) = {
                    let flags = lock(&session.flags);
                    (flags.busy, flags.session_id.clone())
                };
                SessionState {
                    running: true,
                    project_dir: Some(session.project_dir.display().to_string()),
                    pid: Some(session.pid),
                    session_id,
                    busy,
                    pending: lock(&session.pending)
                        .iter()
                        .map(|(_, p)| p.event.clone())
                        .collect(),
                }
            }
        }
    }

    /// 사용자 메시지를 보낸다. 턴이 도는 중이면 오류.
    pub fn send_message(&self, text: &str) -> Result<(), AppError> {
        let text = checked_text(text, "message")?;
        let session = self.current().ok_or(AppError::NoSession)?;
        {
            let mut flags = lock(&session.flags);
            if flags.busy {
                return Err(AppError::TurnInProgress);
            }
            flags.busy = true;
        }
        session.emit(
            &self.shared,
            SessionEvent::UserMessage {
                text: text.to_string(),
                deferred: false,
            },
        );
        if let Err(err) = session.send_line(protocol::user_message_line(text)) {
            lock(&session.flags).busy = false;
            return Err(err);
        }
        Ok(())
    }

    /// 중단 (`interrupt`). 턴이 없을 때 보내도 해가 없다.
    pub fn interrupt(&self) -> Result<(), AppError> {
        let session = self.current().ok_or(AppError::NoSession)?;
        send_interrupt(&session);
        Ok(())
    }

    /// 기다리는 요청에 답한다. 한 요청에는 한 번만 답할 수 있다 (두 번째는 `request_not_found`).
    pub fn respond(&self, request_id: &str, response: Response) -> Result<(), AppError> {
        let session = self.current().ok_or(AppError::NoSession)?;
        let mut pending = lock(&session.pending);
        let index = pending
            .iter()
            .position(|(id, _)| id == request_id)
            .ok_or_else(|| AppError::RequestNotFound(request_id.to_string()))?;
        let request = &pending[index].1;
        let mut defer_text = None;

        // 보낼 줄을 먼저 만들어 확인한다 — 잘못된 답이면 요청은 그대로 남는다.
        let line = match (&request.kind, response) {
            (PendingKind::Permission { input, .. }, Response::Allow) => {
                protocol::allow_response_line(request_id, input, None)
            }
            (PendingKind::Permission { input, always }, Response::AlwaysAllow) => {
                let Some(rule) = always else {
                    return Err(AppError::InvalidInput(
                        "this request has no always-allow rule".into(),
                    ));
                };
                protocol::allow_response_line(request_id, input, Some(rule))
            }
            (_, Response::Deny { message }) => {
                let message = message
                    .as_deref()
                    .map(str::trim)
                    .filter(|m| !m.is_empty())
                    .map(|m| checked_text(m, "message"))
                    .transpose()?
                    .unwrap_or("The user denied this request.");
                protocol::deny_response_line(request_id, message, false)
            }
            (PendingKind::Permission { .. }, Response::Tell { text }) => {
                let text = checked_text(&text, "text")?;
                defer_text = Some(text.to_string());
                protocol::deny_response_line(
                    request_id,
                    "The user rejected this and will say what to do instead.",
                    true,
                )
            }
            (PendingKind::Question { questions, shapes }, Response::Answer { answers }) => {
                let answers = validate_answers(shapes, answers)?;
                protocol::answer_response_line(request_id, questions, &answers)
            }
            _ => {
                return Err(AppError::InvalidInput(
                    "that answer does not fit this kind of request".into(),
                ));
            }
        };

        // 미룬 말은 줄을 보내기 **전에** 넣는다 — CLI 가 중단된 턴의 `result` 를 바로 보내도 읽는 스레드가 이 말을 본다.
        // (flags 잠금은 짧게, pending 잠금을 쥔 채 잡는다 — 다른 곳은 이 순서를 거꾸로 잡지 않는다.)
        if let Some(text) = &defer_text {
            lock(&session.flags).deferred = Some(text.clone());
        }
        if let Err(err) = session.send_line(line) {
            if defer_text.is_some() {
                lock(&session.flags).deferred = None;
            }
            return Err(err);
        }
        pending.remove(index);
        Ok(())
    }

    /// 끝내기 — stdin 닫기 → 몇 초 기다림 → 안 끝나면 프로세스 트리 강제 종료. 끝난 뒤(이벤트까지 낸 뒤) 돌아온다.
    pub fn stop(&self) -> Result<StopInfo, AppError> {
        self.stop_within(self.shared.config.stop_grace)
    }

    /// 앱을 끌 때 — 같은 순서에 기다림만 짧게. 오류는 기록만 한다.
    pub fn shutdown(&self) {
        if let Err(err) = self.stop_within(self.shared.config.shutdown_grace) {
            log::warn!("session shutdown: {err}");
        }
    }

    fn stop_within(&self, grace: Duration) -> Result<StopInfo, AppError> {
        {
            // 시작하는 중이면 그 시작이 프로세스를 띄우지 못하게 한다 (띄운 뒤라면 아래에서 보통대로 끈다).
            let mut slot = lock(&self.shared.slot);
            if slot.starting {
                slot.cancelled = true;
            }
        }
        let Some(session) = self.current() else {
            return Ok(StopInfo {
                was_running: false,
                forced: false,
            });
        };
        let busy = {
            let mut flags = lock(&session.flags);
            flags.stop_requested = true;
            flags.busy
        };
        if busy {
            // 턴이 도는 중이면 먼저 멈추게 한다 (stdin 만 닫으면 턴이 끝날 때까지 안 끝날 수 있다).
            send_interrupt(&session);
        }
        session.close_stdin();
        let mut forced = false;
        if !session.wait_exit(grace) {
            forced = !session.has_exited();
            if forced {
                lock(&session.flags).forced = true;
                session.tree.kill();
            }
            if !session.wait_exit(self.shared.config.kill_wait) {
                // 강제로 꺼도 끝났다는 신호가 안 온다 — 세션 자리를 비우고 끝났다고 알린다 (안 그러면 계속 `session_running` 이다).
                // 늦게라도 끝나면 `wait_and_finish` 가 같은 일을 다시 하지 않는다 (알림은 한 번만).
                announce_end(&session, &self.shared, None, true);
                return Err(AppError::Internal(
                    "the claude process did not exit after being killed".into(),
                ));
            }
        }
        Ok(StopInfo {
            was_running: true,
            forced,
        })
    }
}

fn protocol_version_differs(found: &str) -> bool {
    found != KNOWN_CLI_VERSION
}

fn send_interrupt(session: &Session) {
    let n = session.request_counter.fetch_add(1, Ordering::Relaxed);
    // 앱이 못 보내는 상황(이미 stdin 이 닫힘)은 끝내는 중이라는 뜻이니 무시한다.
    let _ = session.send_line(protocol::interrupt_line(&format!("nyanitor-int-{n}")));
}

// ───────────────────────── 입력 확인 ─────────────────────────

/// 프로젝트 폴더: 절대 경로이고 실제로 있는 폴더.
fn validate_project_dir(text: &str) -> Result<PathBuf, AppError> {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 || trimmed.contains('\0') {
        return Err(AppError::InvalidInput(
            "project folder is empty or too long".into(),
        ));
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(AppError::InvalidInput(
            "project folder must be an absolute path".into(),
        ));
    }
    match std::fs::metadata(&path) {
        Ok(meta) if meta.is_dir() => Ok(path),
        Ok(_) => Err(AppError::InvalidInput(
            "project folder is not a folder".into(),
        )),
        Err(_) => Err(AppError::InvalidInput(
            "project folder does not exist".into(),
        )),
    }
}

/// `--model` 값: 이름 모양만 (`opus`, `claude-sonnet-4-5`, `sonnet[1m]` …). `-` 로 시작하면 옵션으로 읽히므로 거절.
fn validate_model(text: &str) -> Result<String, AppError> {
    let model = text.trim();
    let ok = !model.is_empty()
        && model.len() <= 64
        && !model.starts_with('-')
        && model.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '[' | ']' | '/')
        });
    if ok {
        Ok(model.to_string())
    } else {
        Err(AppError::InvalidInput(
            "model name has an unexpected shape".into(),
        ))
    }
}

/// 실행 인자 — 앱이 만든다 (D-44). `--dangerously-skip-permissions` · `bypassPermissions` · `--max-turns` ·
/// `--no-session-persistence` 는 쓰지 않는다.
pub fn build_args(model: Option<&str>, resume_id: Option<&str>) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-prompt-tool",
        "stdio",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    if let Some(model) = model {
        args.push("--model".into());
        args.push(model.into());
    }
    if let Some(id) = resume_id {
        args.push("--resume".into());
        args.push(id.into());
    }
    args
}

fn checked_text<'a>(text: &'a str, what: &str) -> Result<&'a str, AppError> {
    if text.trim().is_empty() {
        return Err(AppError::InvalidInput(format!("{what} is empty")));
    }
    if text.len() > MAX_USER_TEXT_BYTES {
        return Err(AppError::InvalidInput(format!("{what} is too long")));
    }
    Ok(text)
}

/// 질문마다 답이 있어야 하고, 모르는 질문 문장 · 빈 답 · 하나만 고르는 질문에 여러 개는 거절한다.
fn validate_answers(
    shapes: &[protocol::QuestionShape],
    answers: std::collections::BTreeMap<String, AnswerValue>,
) -> Result<Map<String, Value>, AppError> {
    for key in answers.keys() {
        if !shapes.iter().any(|s| &s.question == key) {
            return Err(AppError::InvalidInput(
                "answer for a question that was not asked".into(),
            ));
        }
    }
    let mut out = Map::new();
    for shape in shapes {
        let answer = answers
            .get(&shape.question)
            .ok_or_else(|| AppError::InvalidInput("every question needs an answer".into()))?;
        let value = match answer {
            AnswerValue::One(text) => {
                Value::String(checked_text(text, "answer")?.trim().to_string())
            }
            AnswerValue::Many(list) => {
                if list.is_empty() || (!shape.multi_select && list.len() > 1) {
                    return Err(AppError::InvalidInput(
                        "wrong number of answers for this question".into(),
                    ));
                }
                let mut items = Vec::with_capacity(list.len());
                for item in list {
                    items.push(Value::String(
                        checked_text(item, "answer")?.trim().to_string(),
                    ));
                }
                Value::Array(items)
            }
        };
        out.insert(shape.question.clone(), value);
    }
    Ok(out)
}

// ───────────────────────── 스레드 ─────────────────────────

fn write_loop(session: &Session, shared: &Shared, mut stdin: ChildStdin, rx: Receiver<String>) {
    // 모든 보내는 줄이 여기를 지난다 — 한 번에 한 줄씩, 줄바꿈으로 끝낸다.
    for line in rx {
        session.log_raw(shared, "send", &line);
        let written = stdin
            .write_all(line.as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .and_then(|()| stdin.flush());
        if let Err(err) = written {
            session.warn(shared, "write_failed", Some(err.to_string()));
            break;
        }
    }
    // `stdin` 이 버려지면서 파이프가 닫힌다 → CLI 가 끝낸다.
}

enum LineRead {
    Eof,
    Line { overflowed: bool },
}

/// 줄 하나를 `buf` 에 읽는다 (줄바꿈 제외). 길이 제한 없이 읽되 `cap` 을 넘는 나머지는 버리고 `overflowed` 로 알린다.
/// 줄바꿈 없이 스트림이 끝나면 그때까지 읽은 것을 한 줄로 돌려준다 (줄 중간에 끊긴 경우).
fn read_line_capped<R: BufRead>(
    reader: &mut R,
    buf: &mut Vec<u8>,
    cap: usize,
) -> io::Result<LineRead> {
    buf.clear();
    let mut overflowed = false;
    let mut got_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(available) => available,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            return Ok(if got_any {
                LineRead::Line { overflowed }
            } else {
                LineRead::Eof
            });
        }
        got_any = true;
        let newline = available.iter().position(|&b| b == b'\n');
        let used = newline.map_or(available.len(), |i| i + 1);
        // `cap` 은 줄바꿈 글자를 뺀 내용 길이 기준이다 (내용이 cap 바이트 딱 맞는 줄은 버리지 않는다).
        let content = newline.unwrap_or(available.len());
        if !overflowed {
            let room = cap.saturating_sub(buf.len());
            if content > room {
                buf.extend_from_slice(&available[..room]);
                overflowed = true;
            } else {
                buf.extend_from_slice(&available[..used]);
            }
        }
        reader.consume(used);
        if newline.is_some() {
            while matches!(buf.last(), Some(b'\n' | b'\r')) {
                buf.pop();
            }
            return Ok(LineRead::Line { overflowed });
        }
    }
}

fn read_stdout(session: &Session, shared: &Shared, stdout: ChildStdout) {
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut buf = Vec::new();
    loop {
        // 앞의 큰 줄 하나 때문에 커진 버퍼를 세션이 끝날 때까지 쥐고 있지 않는다.
        if buf.capacity() > LINE_BUF_KEEP {
            buf.clear();
            buf.shrink_to(LINE_BUF_KEEP);
        }
        match read_line_capped(&mut reader, &mut buf, MAX_LINE_BYTES) {
            Ok(LineRead::Eof) => break,
            Ok(LineRead::Line { overflowed }) => {
                if overflowed {
                    session.warn(
                        shared,
                        "line_too_long",
                        Some(format!("a line over {MAX_LINE_BYTES} bytes was dropped")),
                    );
                    continue;
                }
                let line = String::from_utf8_lossy(&buf);
                handle_stdout_line(session, shared, &line);
            }
            Err(err) => {
                session.log_raw(shared, "note", &format!("stdout read error: {err}"));
                break;
            }
        }
    }
}

fn handle_stdout_line(session: &Session, shared: &Shared, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    session.log_raw(shared, "recv", line);
    // JSON 이 아닌 줄 · 모르는 종류는 원본 로그에만 남는다.
    let Some(value) = protocol::parse_line(line) else {
        return;
    };
    let interpretation = lock(&session.interpreter).handle(&value);
    apply(session, shared, interpretation);
}

/// 해석 결과를 반영한다 — 기다리는 요청 등록 · 취소 먼저, 그다음 이벤트를 순서대로 (화면이 바로 답해도 요청이 있게).
fn apply(session: &Session, shared: &Shared, interpretation: Interpretation) {
    let Interpretation {
        events,
        new_pending,
        cancelled,
        session_id,
        turn_started,
        turn_ended,
        replies,
        resume_not_found,
    } = interpretation;

    let mut events = events;
    {
        let mut pending = lock(&session.pending);
        // 이미 기다리는 ID 로 또 요청이 오면 카드를 또 만들지 않는다 (답은 한 번만 가야 한다).
        let mut duplicates = Vec::new();
        for (id, request) in new_pending {
            if pending.iter().any(|(known, _)| *known == id) {
                duplicates.push(id);
            } else {
                pending.push((id, request));
            }
        }
        pending.retain(|(id, _)| !cancelled.contains(id));
        if !duplicates.is_empty() {
            events.retain(|event| !is_request_card_for(event, &duplicates));
            for id in duplicates {
                events.push(SessionEvent::Warning {
                    code: "duplicate_request".into(),
                    detail: Some(truncate_chars(&id, 80)),
                });
            }
        }
    }
    if let Some(id) = session_id {
        remember_session_id(session, shared, &id);
    }
    {
        let mut flags = lock(&session.flags);
        if turn_started {
            flags.busy = true;
        }
        // 미룬 말("다르게 말하기")이 있으면 `busy` 를 내리지 않는다 — 곧 그 말을 이어 보내므로, 그 사이에 다른 메시지가 끼어들 틈을 없앤다.
        if turn_ended && flags.deferred.is_none() {
            flags.busy = false;
        }
    }
    for line in replies {
        if let Err(err) = session.send_line(line) {
            session.warn(shared, "write_failed", Some(err.to_string()));
        }
    }
    for event in events {
        session.emit(shared, event);
    }
    if resume_not_found {
        announce_resume_not_found(session, shared);
    }
    if turn_ended {
        send_deferred_message(session, shared);
    }
}

/// 이 이벤트가 `ids` 중 하나의 요청 카드(권한 · 질문)인가.
fn is_request_card_for(event: &SessionEvent, ids: &[String]) -> bool {
    match event {
        SessionEvent::PermissionRequest(info) => ids.contains(&info.request_id),
        SessionEvent::QuestionRequest(info) => ids.contains(&info.request_id),
        _ => false,
    }
}

/// `system/init` 의 세션 ID 를 프로젝트 폴더에 묶어 저장한다 (이어 하기). 못 써도 세션은 계속된다.
fn remember_session_id(session: &Session, shared: &Shared, id: &str) {
    {
        let mut flags = lock(&session.flags);
        if flags.session_id.as_deref() == Some(id) {
            return;
        }
        flags.session_id = Some(id.to_string());
    }
    if let Err(err) = lock(&shared.store).set(&session.project_key, id) {
        log::warn!("could not save the session id: {err}");
        session.warn(shared, "session_store_failed", Some(err.to_string()));
    }
}

fn announce_resume_not_found(session: &Session, shared: &Shared) {
    let Some(id) = &session.resume_id else {
        return;
    };
    {
        let mut flags = lock(&session.flags);
        if flags.resume_not_found_sent {
            return;
        }
        flags.resume_not_found_sent = true;
    }
    session.emit(
        shared,
        SessionEvent::ResumeNotFound {
            session_id: id.clone(),
        },
    );
}

/// "다르게 하라고 말하기" — 중단된 턴이 끝난 뒤 사용자의 말을 새 사용자 메시지로 보낸다 (D-44).
fn send_deferred_message(session: &Session, shared: &Shared) {
    let text = {
        let mut flags = lock(&session.flags);
        let Some(text) = flags.deferred.take() else {
            return;
        };
        flags.busy = true;
        text
    };
    session.emit(
        shared,
        SessionEvent::UserMessage {
            text: text.clone(),
            deferred: true,
        },
    );
    if let Err(err) = session.send_line(protocol::user_message_line(&text)) {
        lock(&session.flags).busy = false;
        session.warn(shared, "write_failed", Some(err.to_string()));
    }
}

fn read_stderr(session: &Session, shared: &Shared, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        match read_line_capped(&mut reader, &mut buf, 1 << 20) {
            Ok(LineRead::Eof) | Err(_) => break,
            Ok(LineRead::Line { .. }) => {
                let line = String::from_utf8_lossy(&buf).into_owned();
                if line.trim().is_empty() {
                    continue;
                }
                session.log_raw(shared, "stderr", &line);
                {
                    let mut flags = lock(&session.flags);
                    if flags.stderr_tail.len() >= 5 {
                        flags.stderr_tail.pop_front();
                    }
                    flags.stderr_tail.push_back(truncate_chars(&line, 300));
                }
                if line.contains("No conversation found") {
                    announce_resume_not_found(session, shared);
                }
            }
        }
    }
}

/// 프로세스가 끝나기를 기다렸다가 뒷정리를 하고 끝났다고 알린다.
fn wait_and_finish(mut child: Child, session: &Session, shared: &Shared, done: &Receiver<()>) {
    let status = child.wait();
    // CLI 가 스스로 끝났어도 stdin 쪽을 닫는다 — 안 그러면 쓰기 스레드가 (세션이 스스로 쥔 `Sender` 때문에) 영영 안 끝나
    // 스레드 · stdin 핸들 · 세션 메모리가 남는다. 끝내기 경로(`stop`)는 이미 닫았을 수 있으니 두 번 닫아도 된다.
    session.close_stdin();
    // 끝난 CLI 밑에 남은 프로세스(백그라운드 작업 등)는 함께 끈다 — 파이프를 쥐고 있으면 읽기도 안 끝난다.
    session.tree.kill();
    let deadline = Instant::now() + shared.config.reader_grace;
    // 읽기 스레드는 끝나면 `Sender` 를 버린다 — 둘 다 끝나면 `Disconnected`. 안 끝나면 시간이 차서 넘어간다.
    while done
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .is_ok()
    {}

    let code = match status {
        Ok(status) => status.code(),
        Err(err) => {
            log::warn!("waiting for claude failed: {err}");
            None
        }
    };
    announce_end(session, shared, code, false);
}

/// 세션이 끝났다고 알리고 자리를 비운다. 알림은 세션마다 **한 번만** 나간다 (이미 나갔으면 아무것도 안 한다 —
/// 강제로 꺼도 신호가 안 와서 `stop` 이 먼저 끝냈는데 프로세스가 뒤늦게 끝난 경우).
/// `died` 는 끝내기가 실패한 경우 — 앱이 끝내라고 했어도 정상 종료로 치지 않는다.
fn announce_end(session: &Session, shared: &Shared, code: Option<i32>, died: bool) {
    let (stop_requested, forced, mid_turn, stderr_tail) = {
        let flags = lock(&session.flags);
        (
            flags.stop_requested,
            flags.forced,
            flags.busy,
            flags.stderr_tail.iter().cloned().collect::<Vec<_>>(),
        )
    };
    let ended = if !died && (stop_requested || code == Some(0)) {
        EndKind::Normal
    } else {
        EndKind::Died
    };
    {
        // 이 뒤로는 어떤 스레드도 이벤트를 내지 못한다 (늦게 도착한 읽기 결과가 끝 알림 뒤에 섞이지 않게).
        let mut closed = lock(&session.emit_gate);
        if *closed {
            return;
        }
        // 기다리던 카드는 끝 알림 앞에서 닫는다.
        let leftover = std::mem::take(&mut *lock(&session.pending));
        for (request_id, _) in leftover {
            shared
                .sink
                .emit(SessionEvent::RequestCancelled { request_id });
        }
        // "끝남" 표시를 알림보다 먼저 한다 — 알림을 받은 화면이 바로 상태를 물어도 이미 꺼진 것으로 보이게.
        *lock(&session.exit) = Some(code);
        shared.sink.emit(SessionEvent::SessionEnded {
            ended,
            exit_code: code,
            forced,
            mid_turn,
            stderr_tail,
        });
        *closed = true;
    }
    session.exit_cv.notify_all();
    let mut slot = lock(&shared.slot);
    if slot.session.as_ref().is_some_and(|s| s.id == session.id) {
        slot.session = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::Cursor;

    fn read_all(input: &[u8], cap: usize) -> Vec<(String, bool)> {
        let mut reader = BufReader::with_capacity(7, Cursor::new(input.to_vec()));
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        while let LineRead::Line { overflowed } =
            read_line_capped(&mut reader, &mut buf, cap).unwrap()
        {
            lines.push((String::from_utf8_lossy(&buf).into_owned(), overflowed));
        }
        lines
    }

    #[test]
    fn lines_are_split_on_newline_and_crlf_is_trimmed() {
        let lines = read_all(b"one\ntwo\r\n\nthree\n", 1024);
        assert_eq!(
            lines,
            [
                ("one".into(), false),
                ("two".into(), false),
                (String::new(), false),
                ("three".into(), false)
            ]
        );
    }

    #[test]
    fn a_line_longer_than_the_reader_buffer_comes_back_whole() {
        let long = "x".repeat(100_000);
        let lines = read_all(format!("{long}\nend\n").as_bytes(), 1 << 20);
        assert_eq!(lines[0].0.len(), 100_000);
        assert_eq!(lines[1].0, "end");
    }

    #[test]
    fn a_final_line_without_a_newline_is_still_returned() {
        let lines = read_all(b"ok\n{\"cut\":", 1024);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1].0, "{\"cut\":");
    }

    #[test]
    fn lines_over_the_cap_are_flagged_and_the_next_line_is_intact() {
        let lines = read_all(b"0123456789ABCDEF\nshort\n", 8);
        assert!(lines[0].1, "overflow flagged");
        assert_eq!(lines[0].0.len(), 8);
        assert_eq!(lines[1], ("short".into(), false));
    }

    #[test]
    fn empty_input_is_eof() {
        assert!(read_all(b"", 10).is_empty());
    }

    #[test]
    fn project_dir_must_be_an_existing_absolute_folder() {
        let temp = std::env::temp_dir();
        assert!(validate_project_dir(&temp.display().to_string()).is_ok());
        for bad in [
            "",
            "   ",
            "relative/dir",
            "C:\\definitely\\not\\here\\nyanitor-xyz",
            "bad\0nul",
        ] {
            let err = validate_project_dir(bad).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad:?}");
        }
        // 파일은 폴더가 아니다
        let file = temp.join(format!("nyanitor-notdir-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(
            validate_project_dir(&file.display().to_string())
                .unwrap_err()
                .kind(),
            "invalid_input"
        );
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn model_names_are_limited_to_name_shapes() {
        for ok in [
            "haiku",
            "opus",
            "claude-sonnet-4-5",
            "sonnet[1m]",
            "claude-haiku-5-5",
        ] {
            assert!(validate_model(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "--dangerously-skip-permissions",
            "-x",
            "a b",
            "a;b",
            "a\"b",
            &"m".repeat(65),
        ] {
            assert!(validate_model(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn args_follow_d44_and_never_include_dangerous_flags() {
        let args: Vec<String> =
            build_args(Some("haiku"), Some("00000000-0000-4000-8000-000000000001"))
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
        assert_eq!(
            args,
            [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-prompt-tool",
                "stdio",
                "--model",
                "haiku",
                "--resume",
                "00000000-0000-4000-8000-000000000001"
            ]
        );
        let bare: Vec<String> = build_args(None, None)
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(!bare.iter().any(|a| a == "--model" || a == "--resume"));
        for forbidden in [
            "--dangerously-skip-permissions",
            "bypassPermissions",
            "--max-turns",
            "--no-session-persistence",
            "--permission-mode",
        ] {
            assert!(!args.iter().any(|a| a == forbidden), "{forbidden}");
        }
    }

    fn shapes() -> Vec<protocol::QuestionShape> {
        vec![
            protocol::QuestionShape {
                question: "Color?".into(),
                multi_select: false,
            },
            protocol::QuestionShape {
                question: "Pick some".into(),
                multi_select: true,
            },
        ]
    }

    fn answers(pairs: &[(&str, AnswerValue)]) -> BTreeMap<String, AnswerValue> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    #[test]
    fn complete_answers_pass_and_keep_one_vs_many() {
        let out = validate_answers(
            &shapes(),
            answers(&[
                ("Color?", AnswerValue::One(" Blue ".into())),
                ("Pick some", AnswerValue::Many(vec!["A".into(), "C".into()])),
            ]),
        )
        .unwrap();
        assert_eq!(out["Color?"], Value::String("Blue".into()));
        assert_eq!(out["Pick some"], serde_json::json!(["A", "C"]));
    }

    #[test]
    fn answers_missing_extra_empty_or_too_many_are_refused() {
        let color = ("Color?", AnswerValue::One("Blue".into()));
        // 빠진 질문
        assert!(validate_answers(&shapes(), answers(std::slice::from_ref(&color))).is_err());
        // 묻지 않은 질문
        assert!(
            validate_answers(
                &shapes(),
                answers(&[
                    color.clone(),
                    ("Pick some", AnswerValue::One("A".into())),
                    ("Other", AnswerValue::One("x".into()))
                ])
            )
            .is_err()
        );
        // 빈 글
        assert!(
            validate_answers(
                &shapes(),
                answers(&[
                    ("Color?", AnswerValue::One("  ".into())),
                    ("Pick some", AnswerValue::One("A".into()))
                ])
            )
            .is_err()
        );
        // 하나만 고르는 질문에 여러 개
        assert!(
            validate_answers(
                &shapes(),
                answers(&[
                    ("Color?", AnswerValue::Many(vec!["a".into(), "b".into()])),
                    ("Pick some", AnswerValue::One("A".into()))
                ])
            )
            .is_err()
        );
        // 빈 배열
        assert!(
            validate_answers(
                &shapes(),
                answers(&[color, ("Pick some", AnswerValue::Many(vec![]))])
            )
            .is_err()
        );
    }

    #[test]
    fn user_text_must_be_non_empty_and_bounded() {
        assert!(checked_text("hello", "message").is_ok());
        assert!(checked_text("   \n", "message").is_err());
        assert!(checked_text(&"x".repeat(MAX_USER_TEXT_BYTES + 1), "message").is_err());
    }

    #[test]
    fn raw_log_truncates_long_lines_and_keeps_the_newest() {
        let log = RawLog::new();
        let entry = log.record("recv", &"가".repeat(RAW_LOG_LINE_CHARS + 10));
        assert!(entry.truncated);
        assert_eq!(entry.text.chars().count(), RAW_LOG_LINE_CHARS + 1);
        assert_eq!(entry.original_len, (RAW_LOG_LINE_CHARS + 10) * 3);
        for i in 0..RAW_LOG_LINES + 5 {
            log.record("note", &format!("line {i}"));
        }
        let snapshot = log.snapshot();
        assert_eq!(snapshot.len(), RAW_LOG_LINES);
        assert_eq!(
            snapshot.last().unwrap().text,
            format!("line {}", RAW_LOG_LINES + 4)
        );
        assert!(snapshot.windows(2).all(|w| w[0].seq < w[1].seq));
    }
}

/// P3-03 — 입력 확인 · 줄 읽기 경계 시험 (위 `tests` 는 P3-02 것). 프로세스 · 스레드가 든 경계는 `tests/session_edge_fake_cli.rs`.
#[cfg(test)]
mod edge_tests {
    use super::*;
    use crate::claude::test_util::TempDir;
    use std::collections::BTreeMap;
    use std::io::{Cursor, Read};

    // ───────── 줄 읽기 ─────────

    fn read_all_bytes(input: &[u8], cap: usize, buffer: usize) -> Vec<(Vec<u8>, bool)> {
        let mut reader = BufReader::with_capacity(buffer, Cursor::new(input.to_vec()));
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        while let LineRead::Line { overflowed } =
            read_line_capped(&mut reader, &mut buf, cap).unwrap()
        {
            lines.push((buf.clone(), overflowed));
        }
        lines
    }

    #[test]
    fn the_result_is_the_same_however_the_stream_is_chopped_into_reads() {
        let input = "{\"a\":1}\r\n\r\n한글 줄\n\n마지막 줄".as_bytes();
        let whole = read_all_bytes(input, 1024, 1 << 16);
        for buffer in [1, 2, 3, 5, 7, 64] {
            assert_eq!(
                read_all_bytes(input, 1024, buffer),
                whole,
                "buffer {buffer}"
            );
        }
        assert_eq!(whole.len(), 5);
        assert_eq!(whole[4].0, "마지막 줄".as_bytes());
    }

    #[test]
    fn blank_lines_with_lf_or_crlf_come_back_as_empty_lines_not_as_the_end() {
        let lines = read_all_bytes(b"\n\r\n\n", 1024, 8);
        assert_eq!(lines.len(), 3);
        assert!(lines.iter().all(|(text, over)| text.is_empty() && !over));
    }

    #[test]
    fn carriage_returns_are_only_trimmed_at_the_end_of_a_line() {
        let lines = read_all_bytes(b"a\rb\r\r\nc\n", 1024, 4);
        assert_eq!(lines[0].0, b"a\rb");
        assert_eq!(lines[1].0, b"c");
        // 줄바꿈 없이 끝난 마지막 줄의 끝 \r 은 그대로 (줄바꿈이 오지 않았으니 줄 끝으로 보지 않는다)
        let tail = read_all_bytes(b"x\r", 1024, 4);
        assert_eq!(tail, [(b"x\r".to_vec(), false)]);
    }

    #[test]
    fn invalid_utf8_and_nul_bytes_pass_through_the_reader_untouched() {
        let lines = read_all_bytes(b"ok \xff\xfe bad\n\x00\x00\n\xed\xa0\x80\n", 1024, 3);
        assert_eq!(lines[0].0, b"ok \xff\xfe bad");
        assert_eq!(lines[1].0, [0u8, 0]);
        assert_eq!(lines[2].0, b"\xed\xa0\x80");
        // 줄로 읽을 때는 손실 변환 — 깨진 글자는 U+FFFD 가 되고 패닉하지 않는다
        assert!(String::from_utf8_lossy(&lines[0].0).contains('\u{fffd}'));
    }

    #[test]
    fn a_utf8_character_cut_at_the_end_of_the_stream_becomes_a_replacement_character() {
        // `가` = EA B0 80 — 마지막 바이트가 잘렸다
        let lines = read_all_bytes(b"{\"t\":\"\xea\xb0", 1024, 4);
        assert_eq!(lines.len(), 1);
        let text = String::from_utf8_lossy(&lines[0].0).into_owned();
        assert!(text.contains('\u{fffd}'));
        assert!(protocol::parse_line(&text).is_none());
    }

    #[test]
    fn a_multibyte_character_split_across_two_reads_is_reassembled() {
        let lines = read_all_bytes("가나다\n".as_bytes(), 1024, 1);
        assert_eq!(String::from_utf8(lines[0].0.clone()).unwrap(), "가나다");
    }

    #[test]
    fn a_line_exactly_at_the_cap_is_kept_and_one_byte_more_is_dropped_with_the_next_line_intact() {
        // cap 은 줄바꿈 글자를 뺀 내용 길이 기준이다 (P3-05 에서 고침 — 내용이 cap 바이트 딱 맞는 줄도 남는다)
        let ok = read_all_bytes(b"abc\nnext\n", 5, 3);
        assert_eq!(ok, [(b"abc".to_vec(), false), (b"next".to_vec(), false)]);
        let over = read_all_bytes(b"abcdef\nnext\n", 5, 3);
        assert!(over[0].1);
        assert_eq!(over[1], (b"next".to_vec(), false));
    }

    #[test]
    fn a_line_of_exactly_cap_bytes_with_lf_is_not_flagged_as_overflowing() {
        let lines = read_all_bytes(b"abcd\n", 4, 16);
        assert_eq!(lines, [(b"abcd".to_vec(), false)]);
    }

    #[test]
    fn an_overflowing_last_line_without_a_newline_is_flagged_and_the_stream_then_ends() {
        let mut reader = BufReader::with_capacity(4, Cursor::new(b"0123456789".to_vec()));
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            LineRead::Line { overflowed: true }
        ));
        assert!(matches!(
            read_line_capped(&mut reader, &mut buf, 5).unwrap(),
            LineRead::Eof
        ));
    }

    /// 처음에 `Interrupted` 를 한 번 내고, 다음에 데이터, 그다음에 진짜 오류를 낸다.
    struct Flaky {
        step: u8,
    }

    impl Read for Flaky {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            self.step += 1;
            match self.step {
                1 => Err(io::Error::from(io::ErrorKind::Interrupted)),
                2 => {
                    out[..3].copy_from_slice(b"ab\n");
                    Ok(3)
                }
                _ => Err(io::Error::other("pipe broke")),
            }
        }
    }

    #[test]
    fn an_interrupted_read_is_retried_and_a_real_error_is_returned() {
        let mut reader = BufReader::new(Flaky { step: 0 });
        let mut buf = Vec::new();
        assert!(matches!(
            read_line_capped(&mut reader, &mut buf, 100).unwrap(),
            LineRead::Line { overflowed: false }
        ));
        assert_eq!(buf, b"ab");
        assert!(read_line_capped(&mut reader, &mut buf, 100).is_err());
    }

    #[test]
    fn the_buffer_is_cleared_for_each_call_even_after_an_eof() {
        let mut reader = BufReader::new(Cursor::new(b"x\n".to_vec()));
        let mut buf = b"leftover".to_vec();
        read_line_capped(&mut reader, &mut buf, 10).unwrap();
        assert_eq!(buf, b"x");
        assert!(matches!(
            read_line_capped(&mut reader, &mut buf, 10).unwrap(),
            LineRead::Eof
        ));
        assert!(buf.is_empty());
    }

    // ───────── 입력 확인 ─────────

    #[test]
    fn project_folders_with_odd_text_are_refused_or_trimmed_but_never_misread() {
        let dir = TempDir::new("odd-dir");
        let good = dir.display().to_string();
        // 앞뒤 공백은 지우고, 안쪽 · 숨은 글자는 거절
        assert_eq!(
            validate_project_dir(&format!("  {good}\t\n")).unwrap(),
            PathBuf::from(&good)
        );
        for bad in [
            String::new(),
            "   ".to_string(),
            format!("{good}\0"),
            format!("{good}\0\\x"),
            "x".repeat(4097),
            ".".to_string(),
            "..".to_string(),
            "relative\\dir".to_string(),
            "C:".to_string(),
            "\\".to_string(),
            "\\\\no-such-server\\share\\folder".to_string(),
        ] {
            assert!(validate_project_dir(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_file_a_missing_folder_and_a_folder_with_korean_and_spaces_are_told_apart() {
        let dir = TempDir::new("kinds");
        let file = dir.join("a file.txt");
        std::fs::write(&file, b"x").unwrap();
        let korean = dir.join("내 프로젝트 (1)");
        std::fs::create_dir(&korean).unwrap();
        let err = validate_project_dir(&file.display().to_string()).unwrap_err();
        assert_eq!(err.kind(), "invalid_input");
        assert!(err.to_string().contains("not a folder"));
        let missing = validate_project_dir(&dir.join("missing").display().to_string()).unwrap_err();
        assert!(missing.to_string().contains("does not exist"));
        assert_eq!(
            validate_project_dir(&korean.display().to_string()).unwrap(),
            korean
        );
    }

    #[test]
    fn model_names_with_options_spaces_shell_characters_or_odd_lengths_are_refused() {
        for ok in [
            "opus",
            "sonnet[1m]",
            "claude-sonnet-4-5",
            "a.b_c:d/e",
            "  haiku  ",
            &"m".repeat(64),
        ] {
            assert!(validate_model(ok).is_ok(), "{ok:?}");
        }
        for bad in [
            "",
            " ",
            "-",
            "--help",
            "-x",
            "a b",
            "a\tb",
            "opus\nsonnet",
            "opus;calc",
            "opus&&calc",
            "$(calc)",
            "`calc`",
            "opus\"",
            "오퍼스",
            "opus\0",
            &"m".repeat(65),
        ] {
            assert!(validate_model(bad).is_err(), "{bad:?}");
        }
        // 앞뒤 공백은 지운 이름이 쓰인다
        assert_eq!(validate_model("  haiku\n").unwrap(), "haiku");
    }

    #[test]
    fn arguments_put_the_model_and_resume_id_as_separate_values_and_nothing_else() {
        let args = build_args(Some("opus"), Some("00000000-0000-4000-8000-000000000001"));
        let text: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let at = |flag: &str| text.iter().position(|a| a == flag).unwrap();
        assert_eq!(text[at("--model") + 1], "opus");
        assert_eq!(
            text[at("--resume") + 1],
            "00000000-0000-4000-8000-000000000001"
        );
        assert_eq!(
            text.iter().filter(|a| a.starts_with("--")).count(),
            6,
            "{text:?}"
        );
        let plain = build_args(None, None);
        assert!(!plain.iter().any(|a| a == "--model" || a == "--resume"));
    }

    #[test]
    fn user_text_limits_are_in_bytes_and_whitespace_only_text_counts_as_empty() {
        assert!(checked_text(&"x".repeat(MAX_USER_TEXT_BYTES), "m").is_ok());
        assert!(checked_text(&"x".repeat(MAX_USER_TEXT_BYTES + 1), "m").is_err());
        // 한글은 글자당 3 바이트 — 글자 수가 아니라 바이트로 센다
        let third = MAX_USER_TEXT_BYTES / 3;
        assert!(checked_text(&"가".repeat(third), "m").is_ok());
        assert!(checked_text(&"가".repeat(third + 1), "m").is_err());
        for blank in ["", " ", "\n\r\t", "\u{a0}", "\u{3000}", "\u{2003}"] {
            assert!(checked_text(blank, "m").is_err(), "{blank:?}");
        }
        // 안 보이는 글자(제로 폭 공백)만 있는 글은 trim 이 못 거른다 — 그대로 통과한다 (현재 동작 기록)
        assert!(checked_text("\u{200b}", "m").is_ok());
        // 앞뒤 공백이 있어도 글 자체는 바꾸지 않고 돌려준다
        assert_eq!(checked_text("  hi  ", "m").unwrap(), "  hi  ");
    }

    // ───────── 질문 답 ─────────

    fn two_questions() -> Vec<protocol::QuestionShape> {
        vec![
            protocol::QuestionShape {
                question: "Color?".into(),
                multi_select: false,
            },
            protocol::QuestionShape {
                question: "Pick some".into(),
                multi_select: true,
            },
        ]
    }

    fn given(pairs: &[(&str, AnswerValue)]) -> BTreeMap<String, AnswerValue> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn one(text: &str) -> AnswerValue {
        AnswerValue::One(text.into())
    }

    fn many(items: &[&str]) -> AnswerValue {
        AnswerValue::Many(items.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn an_answer_for_an_unknown_question_is_refused_even_if_the_real_ones_are_all_there() {
        let result = validate_answers(
            &two_questions(),
            given(&[
                ("Color?", one("Blue")),
                ("Pick some", many(&["A"])),
                ("Surprise", one("x")),
            ]),
        );
        assert_eq!(result.unwrap_err().kind(), "invalid_input");
    }

    #[test]
    fn question_text_must_match_exactly_no_case_or_space_forgiveness() {
        for key in ["color?", "Color? ", " Color?", "Color？", "COLOR?"] {
            let result = validate_answers(
                &two_questions(),
                given(&[(key, one("Blue")), ("Pick some", many(&["A"]))]),
            );
            assert!(result.is_err(), "{key:?}");
        }
    }

    #[test]
    fn written_answers_are_trimmed_bounded_and_may_be_anything_not_just_an_option_label() {
        let ok = validate_answers(
            &two_questions(),
            given(&[
                ("Color?", one("  내가 직접 쓴 색  ")),
                ("Pick some", many(&[" A ", "B\nC"])),
            ]),
        )
        .unwrap();
        assert_eq!(ok["Color?"], Value::String("내가 직접 쓴 색".into()));
        assert_eq!(ok["Pick some"], serde_json::json!(["A", "B\nC"]));
        // 한도: 한 답이 1 MiB 를 넘으면 거절, 딱 1 MiB 는 통과
        let at_limit = validate_answers(
            &two_questions(),
            given(&[
                ("Color?", one(&"x".repeat(MAX_USER_TEXT_BYTES))),
                ("Pick some", many(&["A"])),
            ]),
        );
        assert!(at_limit.is_ok());
        let over = validate_answers(
            &two_questions(),
            given(&[
                ("Color?", one(&"x".repeat(MAX_USER_TEXT_BYTES + 1))),
                ("Pick some", many(&["A"])),
            ]),
        );
        assert!(over.is_err());
        let over_in_list = validate_answers(
            &two_questions(),
            given(&[
                ("Color?", one("Blue")),
                (
                    "Pick some",
                    many(&["A", &"y".repeat(MAX_USER_TEXT_BYTES + 1)]),
                ),
            ]),
        );
        assert!(over_in_list.is_err());
    }

    #[test]
    fn blank_items_inside_a_list_and_a_list_for_a_single_choice_are_refused() {
        for bad in [
            given(&[("Color?", one("Blue")), ("Pick some", many(&["A", ""]))]),
            given(&[("Color?", one("Blue")), ("Pick some", many(&["A", "   "]))]),
            given(&[("Color?", one("Blue")), ("Pick some", many(&[]))]),
            given(&[
                ("Color?", many(&["Blue", "Red"])),
                ("Pick some", many(&["A"])),
            ]),
            given(&[("Color?", many(&[])), ("Pick some", many(&["A"]))]),
            given(&[("Color?", one("")), ("Pick some", many(&["A"]))]),
            given(&[]),
        ] {
            assert!(
                validate_answers(&two_questions(), bad.clone()).is_err(),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_list_with_one_item_for_a_single_choice_is_accepted_and_sent_as_a_list() {
        // 화면은 하나 고르기에 글 하나를 보내지만, 한 개짜리 배열이 와도 막지 않는다 (현재 동작 기록)
        let out = validate_answers(
            &two_questions(),
            given(&[("Color?", many(&["Blue"])), ("Pick some", one("A"))]),
        )
        .unwrap();
        assert_eq!(out["Color?"], serde_json::json!(["Blue"]));
        assert_eq!(out["Pick some"], Value::String("A".into()));
    }

    #[test]
    fn duplicate_choices_in_a_multi_select_list_are_passed_through() {
        let out = validate_answers(
            &two_questions(),
            given(&[("Color?", one("Blue")), ("Pick some", many(&["A", "A"]))]),
        )
        .unwrap();
        assert_eq!(out["Pick some"], serde_json::json!(["A", "A"]));
    }

    #[test]
    fn two_questions_with_the_same_sentence_need_only_one_answer_key() {
        let shapes = vec![
            protocol::QuestionShape {
                question: "Same?".into(),
                multi_select: false,
            },
            protocol::QuestionShape {
                question: "Same?".into(),
                multi_select: false,
            },
        ];
        let out = validate_answers(&shapes, given(&[("Same?", one("yes"))])).unwrap();
        assert_eq!(out.len(), 1);
    }

    // ───────── 원본 로그 ─────────

    #[test]
    fn raw_log_cuts_exactly_at_the_limit_and_counts_bytes_for_the_original_length() {
        let log = RawLog::new();
        let exact = log.record("recv", &"a".repeat(RAW_LOG_LINE_CHARS));
        assert!(!exact.truncated);
        assert_eq!(exact.text.len(), RAW_LOG_LINE_CHARS);
        let over = log.record("recv", &"a".repeat(RAW_LOG_LINE_CHARS + 1));
        assert!(over.truncated);
        assert_eq!(over.original_len, RAW_LOG_LINE_CHARS + 1);
        let korean = log.record("recv", &"한".repeat(10));
        assert!(!korean.truncated);
        assert_eq!(korean.original_len, 30);
        let empty = log.record("note", "");
        assert!(!empty.truncated && empty.text.is_empty());
    }

    #[test]
    fn raw_log_sequence_numbers_keep_counting_after_old_lines_are_dropped_and_after_a_clear() {
        let log = RawLog::new();
        for i in 0..RAW_LOG_LINES + 3 {
            log.record("recv", &i.to_string());
        }
        let snapshot = log.snapshot();
        assert_eq!(snapshot.first().unwrap().seq, 3);
        assert_eq!(snapshot.last().unwrap().seq, (RAW_LOG_LINES + 2) as u64);
        log.clear();
        assert!(log.snapshot().is_empty());
        // 비워도 번호는 계속 늘어난다 — 화면이 같은 번호를 두 번 보지 않는다
        assert_eq!(log.record("recv", "x").seq, (RAW_LOG_LINES + 3) as u64);
    }

    // ───────── 이벤트 문서 ↔ 코드 ─────────

    /// 소스 글에서 `.warn(` 의 첫 글자열 인자와 `code: "…"` 를 모은다.
    fn warning_codes_in(source: &str) -> Vec<String> {
        let mut found = Vec::new();
        for chunk in source.split(".warn(").skip(1) {
            if let Some(code) = first_quoted(chunk) {
                found.push(code);
            }
        }
        for chunk in source.split("code: \"").skip(1) {
            if let Some(end) = chunk.find('"') {
                found.push(chunk[..end].to_string());
            }
        }
        found
    }

    fn first_quoted(text: &str) -> Option<String> {
        let start = text.find('"')? + 1;
        let end = text[start..].find('"')? + start;
        let head = &text[..start - 1];
        // 첫 글자열 앞에 `)` 나 `;` 가 있으면 다른 호출로 넘어간 것
        (!head.contains([')', ';'])).then(|| text[start..end].to_string())
    }

    fn documented_and_emitted_warning_codes() -> (
        std::collections::BTreeSet<String>,
        std::collections::BTreeSet<String>,
    ) {
        let events = include_str!("events.rs");
        let documented = events
            .lines()
            .skip_while(|l| !l.contains("`code`:"))
            .take_while(|l| l.trim_start().starts_with("///"))
            .flat_map(|l| {
                l.split('`')
                    .skip(1)
                    .step_by(2)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .filter(|code| code != "code")
            .collect();
        let mut used = std::collections::BTreeSet::new();
        for source in [include_str!("session.rs"), include_str!("protocol.rs")] {
            // 이 파일의 시험 모듈은 건너뛴다 (시험 글 안의 `code: "x"` 를 세지 않게)
            let production = source.split("#[cfg(test)]").next().unwrap();
            used.extend(warning_codes_in(production));
        }
        (documented, used)
    }

    #[test]
    fn every_documented_warning_code_is_really_emitted_somewhere() {
        let (documented, used) = documented_and_emitted_warning_codes();
        assert!(used.len() >= 6, "코드를 못 찾았다: {used:?}");
        let never: Vec<_> = documented.difference(&used).collect();
        assert!(
            never.is_empty(),
            "문서에만 있고 내보내지 않는 코드: {never:?}"
        );
    }

    #[test]
    fn every_emitted_warning_code_is_listed_in_the_event_doc() {
        let (documented, used) = documented_and_emitted_warning_codes();
        let undocumented: Vec<_> = used.difference(&documented).collect();
        assert!(
            undocumented.is_empty(),
            "내보내지만 문서에 없는 코드: {undocumented:?}"
        );
    }
}

/// P3-05 — 줄 상한 · 줄 읽기 세는 법.
#[cfg(test)]
mod fix_tests {
    use super::*;
    use std::io::Cursor;

    fn read_all(input: &[u8], cap: usize, chunk: usize) -> Vec<(Vec<u8>, bool)> {
        let mut reader = BufReader::with_capacity(chunk, Cursor::new(input.to_vec()));
        let mut buf = Vec::new();
        let mut lines = Vec::new();
        while let LineRead::Line { overflowed } =
            read_line_capped(&mut reader, &mut buf, cap).unwrap()
        {
            lines.push((buf.clone(), overflowed));
        }
        lines
    }

    #[test]
    fn the_line_cap_is_sixteen_mebibytes() {
        assert_eq!(MAX_LINE_BYTES, 16 << 20);
        const { assert!(LINE_BUF_KEEP < MAX_LINE_BYTES) };
    }

    #[test]
    fn the_cap_counts_the_content_not_the_line_break() {
        for chunk in [1, 2, 3, 4, 5, 64] {
            // 내용이 cap 바이트 딱 맞는 줄은 LF 로 끝나도 남는다
            assert_eq!(
                read_all(b"abcd\nnext\n", 4, chunk),
                [(b"abcd".to_vec(), false), (b"next".to_vec(), false)],
                "chunk {chunk}"
            );
            // 한 바이트 넘치면 버려지고 다음 줄은 온전하다
            let over = read_all(b"abcde\nnext\n", 4, chunk);
            assert!(over[0].1, "chunk {chunk}");
            assert_eq!(over[0].0, b"abcd");
            assert_eq!(over[1], (b"next".to_vec(), false), "chunk {chunk}");
        }
    }

    #[test]
    fn a_crlf_line_counts_its_carriage_return_as_content() {
        // CR 은 내용으로 센다 (줄 끝에서 떼어 내기 전) — cap 4 에 `abc\r\n` 은 딱 맞고 `abcd\r\n` 은 넘친다
        assert_eq!(read_all(b"abc\r\n", 4, 3), [(b"abc".to_vec(), false)]);
        assert!(read_all(b"abcd\r\n", 4, 3)[0].1);
    }

    #[test]
    fn a_last_line_without_a_line_break_at_exactly_the_cap_is_kept() {
        assert_eq!(read_all(b"abcd", 4, 2), [(b"abcd".to_vec(), false)]);
        assert!(read_all(b"abcde", 4, 2)[0].1);
    }
}
