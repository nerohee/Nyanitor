//! 가짜 CLI 시험 도우미 — 가짜 `claude` 실행 파일 찾기, 이벤트 모으기, 프로세스 살아 있나 확인.
#![allow(dead_code)] // 시험 파일마다 쓰는 것이 다르다

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nyanitor_lib::claude::events::{SessionEvent, StartInfo};
use nyanitor_lib::claude::exec::ClaudeCommand;
use nyanitor_lib::claude::launch::StartPlan;
use nyanitor_lib::claude::session::{EventSink, ManagerConfig, SessionManager};
use nyanitor_lib::claude::store::{self, project_key};
use nyanitor_lib::db::{AppDb, DB_FILE};
use nyanitor_lib::error::AppError;
use nyanitor_lib::projects::store as projects_store;
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

/// `Harness` 가 프로젝트 1번을 등록한 때 (유닉스 초)
pub const REGISTERED_AT: i64 = 100;

#[derive(Clone, Copy, PartialEq, Eq)]
enum DbState {
    /// 열려 있고 프로젝트 1번이 등록돼 있다
    Project,
    /// 열려 있고 비어 있다
    Empty,
    /// 열 수 없다
    Unusable,
    /// 이 앱보다 새 번호의 DB — 읽기만 된다 (프로젝트 1번은 등록돼 있다)
    ReadOnly,
}

/// 시험 폴더를 마지막에 지운다 — `Harness` 의 맨 끝 칸이라 관리자 · DB 가 먼저 버려진 뒤에 돈다 (열린 DB 파일이 있으면 Windows 는 지우지 못한다).
struct RootGuard(PathBuf);

impl Drop for RootGuard {
    fn drop(&mut self) {
        // 끝난 세션의 스레드가 아직 DB 손잡이를 쥐고 있을 수 있다 — 잠깐 기다리며 다시 시도한다
        for _ in 0..60 {
            if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

pub struct Harness {
    pub manager: SessionManager,
    rx: Receiver<SessionEvent>,
    seen: Vec<SessionEvent>,
    cursor: usize,
    pub root: PathBuf,
    /// 프로젝트 폴더 (세션의 작업 폴더) — 앱 DB 에 프로젝트 1번으로 등록돼 있다
    pub project: PathBuf,
    /// 관리자가 쓰는 앱 DB (`<root>/data/nyanitor.db`)
    pub db: AppDb,
    _guard: RootGuard,
}

pub fn fast_config() -> ManagerConfig {
    ManagerConfig {
        stop_grace: Duration::from_millis(700),
        shutdown_grace: Duration::from_millis(500),
        kill_wait: Duration::from_secs(5),
        reader_grace: Duration::from_secs(2),
        ..ManagerConfig::default()
    }
}

impl Harness {
    pub fn new(name: &str) -> Self {
        Self::with_config(name, fast_config())
    }

    pub fn with_config(name: &str, config: ManagerConfig) -> Self {
        Self::build(name, config, None, DbState::Project)
    }

    /// 이 프로젝트의 마지막 세션 ID 가 이미 저장돼 있는 상태로 (앱을 다시 켠 뒤처럼).
    pub fn with_saved_session(name: &str, session_id: &str) -> Self {
        Self::build(name, fast_config(), Some(session_id), DbState::Project)
    }

    /// 앱 DB 는 열려 있지만 등록된 프로젝트가 하나도 없다
    pub fn without_project(name: &str) -> Self {
        Self::build(name, fast_config(), None, DbState::Empty)
    }

    /// 앱 DB 를 열 수 없는 상태로 — 데이터 폴더 자리에 파일이 있다. 세션은 그래도 뜨고 알림만 해야 한다.
    pub fn with_unusable_db(name: &str) -> Self {
        Self::build(name, fast_config(), None, DbState::Unusable)
    }

    /// 이 앱보다 새 번호의 앱 DB — 읽을 수만 있다. 세션은 그래도 뜨고 알림만 해야 한다.
    pub fn with_read_only_db(name: &str) -> Self {
        Self::build(name, fast_config(), None, DbState::ReadOnly)
    }

    fn build(name: &str, config: ManagerConfig, saved: Option<&str>, state: DbState) -> Self {
        let root = unique_dir(name);
        let project = root.join("project");
        fs::create_dir_all(&project).unwrap();
        if state == DbState::Unusable {
            fs::write(root.join("data"), b"i am a file").unwrap();
        }
        let mut db = AppDb::open(&root.join("data").join(DB_FILE));
        if state == DbState::ReadOnly {
            // 프로젝트를 등록한 뒤 번호를 올려 다시 연다
            db.write(|conn| {
                projects_store::insert(
                    conn,
                    &project.display().to_string(),
                    &project_key(&project),
                    "시험 프로젝트",
                    None,
                    REGISTERED_AT,
                )
            })
            .expect("register the project");
            drop(db);
            let path = root.join("data").join(DB_FILE);
            rusqlite::Connection::open(&path)
                .unwrap()
                .pragma_update(None, "user_version", 9999)
                .unwrap();
            db = AppDb::open(&path);
        }
        if state == DbState::Project {
            // 프로젝트 폴더를 1번 프로젝트로 등록한다 (세션은 등록된 프로젝트로만 시작한다 — `plan()` 의 번호)
            db.write(|conn| {
                projects_store::insert(
                    conn,
                    &project.display().to_string(),
                    &project_key(&project),
                    "시험 프로젝트",
                    None,
                    REGISTERED_AT,
                )
            })
            .expect("register the project");
            if let Some(id) = saved {
                db.write(|conn| store::remember(conn, 1, id, 1))
                    .expect("save the session id");
            }
        }
        let (tx, rx) = mpsc::channel();
        let manager =
            SessionManager::new(Arc::new(ChannelSink(Mutex::new(tx))), db.clone(), config);
        Self {
            manager,
            rx,
            seen: Vec::new(),
            cursor: 0,
            root: root.clone(),
            project,
            db,
            _guard: RootGuard(root),
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

    /// 시작 계획 (화면이 보낸 요청을 Rust 가 풀어 만든 것 — 폴더 · 모델 · 수준은 이미 정해졌다). 프로젝트 번호는 1.
    pub fn plan(&self) -> StartPlan {
        StartPlan {
            project_id: 1,
            project_dir: self.project.clone(),
            resume: false,
            use_api_key: false,
            model: None,
            effort: None,
            warnings: Vec::new(),
        }
    }

    pub fn start(&self, cmd: &FakeCmd) -> Result<StartInfo, AppError> {
        self.manager.start(self.plan(), cmd.command.clone())
    }

    pub fn start_resume(&self, cmd: &FakeCmd) -> Result<StartInfo, AppError> {
        let mut plan = self.plan();
        plan.resume = true;
        self.manager.start(plan, cmd.command.clone())
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
        // 세션을 끝내고 채팅 기록의 남은 쓰기를 마친다. 폴더 지우기는 맨 끝 칸 (`RootGuard`) 이 한다.
        self.manager.shutdown();
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

// ───────────────────────────── 하네스 시험 도우미 (P4-02) ─────────────────────────────

use nyanitor_lib::harness::Context;
use nyanitor_lib::harness::git::locate_git_here;
use nyanitor_lib::harness::locate::Locations;

/// 폴더 링크 만들기 — Windows 는 정션(`mklink /J`, 권한이 필요 없다), 그 밖은 심볼릭 링크. 실패하면 `false`.
pub fn make_dir_link(link: &Path, target: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("cmd")
            .raw_arg(format!(
                "/C mklink /J \"{}\" \"{}\"",
                link.display(),
                target.display()
            ))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        status.is_ok_and(|s| s.success())
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}

/// 시험 폴더 한 벌: 가짜 `~/.claude` · 하네스 폴더가 모두 `root` 아래에 있다 (실제 홈 폴더는 어디에도 안 쓰인다).
pub struct HarnessRoot {
    pub root: PathBuf,
    pub locations: Locations,
}

impl HarnessRoot {
    pub fn new(name: &str) -> Self {
        let root = unique_dir(name);
        let locations = Locations {
            claude_dir: root.join("claude"),
            harness_home: root.join("hh"),
            claude_dir_from_env: true,
            harness_home_from_env: true,
        };
        fs::create_dir_all(&locations.claude_dir).unwrap();
        fs::create_dir_all(&locations.harness_home).unwrap();
        Self { root, locations }
    }

    pub fn ctx(&self) -> Context {
        Context::new(self.locations.clone(), Some(git_exe()))
    }

    pub fn ctx_without_git(&self) -> Context {
        Context::new(self.locations.clone(), None)
    }
}

impl Drop for HarnessRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

pub fn git_exe() -> PathBuf {
    locate_git_here().expect("git must be installed to run the harness tests")
}

/// 시험용 git 한 번 — 작성자 · 서명 · 줄바꿈 설정을 못 박고 실패하면 멈춘다. 표준 출력(끝 공백 뺌)을 돌려준다.
pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new(git_exe())
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=Tester",
            "-c",
            "user.email=tester@example.com",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.autocrlf=false",
        ])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("run git");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// 파일을 쓰고 커밋한다 (폴더는 알아서 만든다).
pub fn commit_file(repo: &Path, name: &str, text: &str, message: &str) {
    let path = repo.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, text).unwrap();
    git(repo, &["add", "--", name]);
    git(repo, &["commit", "-q", "-m", message]);
}

/// 원격 대신 쓸 로컬 저장소 (`main`, 첫 커밋 하나)
pub fn make_origin_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    commit_file(dir, "README.md", "hello\n", "feat: 처음");
}

/// 경로를 git 이 받는 주소 모양으로 (Windows 는 `/`)
pub fn as_url(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

// ───────────────────────────── 내 수정 시험 도우미 (P9-01) ─────────────────────────────

use nyanitor_lib::custom::Env;

/// 시험용 하네스 한 벌 — 가짜 `~/.claude` · 하네스 폴더 · 가짜 원본(`<하네스 폴더>/repo`: 에이전트 · 스킬 · 가짜 설치 스크립트)
pub struct CustomRoot {
    pub h: HarnessRoot,
    /// 원본 폴더 (`<하네스 폴더>/repo`)
    pub source: PathBuf,
    /// 내 수정 폴더 (`<하네스 폴더>/custom`)
    pub custom: PathBuf,
}

fn custom_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/custom")
        .join(name)
}

fn harness_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/harness")
        .join(name)
}

pub const SOURCE_AGENT_UI: &str = "---\nname: harness-builder-ui\ndescription: 화면 구현자\nmodel: sonnet\neffort: medium\ncolor: blue\n---\n\n너는 화면 구현자다.\n";
pub const SOURCE_AGENT_DESIGNER: &str = "---\nname: harness-designer\ndescription: 디자이너\nmodel: opus\neffort: high\n---\n\n너는 디자이너다.\n";
pub const SOURCE_SKILL_WEB: &str = "---\nname: web-full\ndescription: 웹 서비스 만들기\nargument-hint: [요구사항.md]\n---\n\n웹을 만든다.\n";
pub const SOURCE_SKILL_DESKTOP: &str =
    "---\nname: desktop-app\ndescription: 데스크톱 앱 만들기\n---\n\n앱을 만든다.\n";
pub const SOURCE_CONFIG_EXAMPLE: &str = "{\n  \"language\": \"ko\",\n  \"planner\": {\n    \"model\": \"opus\",\n    \"effort\": \"high\"\n  },\n  \"agents\": {\n    \"ui\": \"harness-builder-ui\"\n  }\n}\n";

impl CustomRoot {
    /// 원본이 있는 시험 폴더 (`harness-builder-ui` · `harness-designer` · 스킬 `web-full` · `desktop-app` · 공통 폴더 `agents/_common`)
    pub fn new(name: &str) -> Self {
        let root = Self::empty(name);
        root.write_source("agents/harness-builder-ui.md", SOURCE_AGENT_UI);
        root.write_source("agents/harness-designer.md", SOURCE_AGENT_DESIGNER);
        root.write_source("agents/_common/rules.md", "공통 규칙\n");
        root.write_source("skills/web-full/SKILL.md", SOURCE_SKILL_WEB);
        root.write_source("skills/desktop-app/SKILL.md", SOURCE_SKILL_DESKTOP);
        root.write_source("config.example.json", SOURCE_CONFIG_EXAMPLE);
        root
    }

    /// 원본 폴더가 아직 없는 시험 폴더 (하네스를 받기 전)
    pub fn empty(name: &str) -> Self {
        let h = HarnessRoot::new(name);
        let source = h.locations.repo_dir();
        let custom = h.locations.harness_home.join("custom");
        Self { h, source, custom }
    }

    /// 가짜 설치 스크립트를 원본에 둔다 (`install` 은 성공 녹화를 내보낸다). 스크립트는 `custom/agents` · `custom/skills` 에서 본 파일을 `calls.log` 에 남긴다.
    pub fn with_script(self) -> Self {
        fs::create_dir_all(&self.source).unwrap();
        let name = nyanitor_lib::harness::locate::script_name();
        fs::copy(custom_fixture(name), self.source.join(name)).unwrap();
        self.script_out("install", "install-change.json", 0);
        self
    }

    /// 가짜 스크립트가 `op` 에서 내보낼 녹화와 종료 코드
    pub fn script_out(&self, op: &str, json_fixture: &str, exit: i32) {
        fs::copy(
            harness_fixture(json_fixture),
            self.source.join(format!("{op}.out")),
        )
        .unwrap();
        fs::write(self.source.join(format!("{op}.exit")), format!("{exit}\n")).unwrap();
    }

    /// 가짜 스크립트가 받은 호출 — `(명령, 그때 본 custom 파일들(정렬))`
    pub fn script_calls(&self) -> Vec<(String, Vec<String>)> {
        fs::read_to_string(self.source.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(|line| {
                let (op, files) = line.split_once('|').unwrap_or((line, ""));
                let mut files: Vec<String> = files
                    .split(',')
                    .filter(|f| !f.is_empty())
                    .map(str::to_string)
                    .collect();
                files.sort();
                (op.to_string(), files)
            })
            .collect()
    }

    pub fn install_calls(&self) -> usize {
        self.script_calls()
            .iter()
            .filter(|(op, _)| op == "install")
            .count()
    }

    pub fn write_source(&self, rel: &str, text: &str) {
        let path = self.source.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    pub fn write_custom(&self, rel: &str, text: &str) {
        let path = self.custom.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    pub fn read_custom(&self, rel: &str) -> String {
        fs::read_to_string(self.custom.join(rel)).unwrap()
    }

    pub fn custom_exists(&self, rel: &str) -> bool {
        self.custom.join(rel).exists()
    }

    pub fn ctx(&self) -> Context {
        self.h.ctx()
    }

    pub fn ctx_without_git(&self) -> Context {
        self.h.ctx_without_git()
    }

    /// `~/.claude` 안에 파일을 둔다 (사용자 자신의 에이전트 · 스킬 · 상태 파일)
    pub fn write_claude(&self, rel: &str, text: &str) {
        let path = self.h.locations.claude_dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    /// 내 수정 폴더의 git (시험용 — 앱이 쓰는 설정과 따로)
    pub fn git(&self, args: &[&str]) -> String {
        git(&self.custom, args)
    }

    /// 커밋 제목들 (최신이 먼저)
    pub fn subjects(&self) -> Vec<String> {
        let out = self.git(&["log", "--format=%s"]);
        out.lines().map(str::to_string).collect()
    }
}

/// `Context` 로 `Env` 를 만든다
pub fn env_of(ctx: &Context) -> Env<'_> {
    Env::new(ctx)
}
