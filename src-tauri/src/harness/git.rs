//! git · Git Bash 찾기, 원본 받기(clone), 업데이트 확인(fetch → 미리보기) · 받기(확인 때 본 커밋까지만 `merge --ff-only`) — 정해 둔 것 3 · 4 · 5 · 6.
//!
//! git 은 Rust 가 찾은 실행 파일 하나만, 인자는 이 파일이 만든다. 저장소 경로는 `<하네스 폴더>/repo` 뿐이고
//! 받는 주소는 `Context::origin_url` (Tauri 명령에서는 상수). 묻는 창 · 입력 대기로 멈추지 않게 하고(`GIT_TERMINAL_PROMPT=0` 등)
//! 창을 숨기며 시간 제한을 둔다. 고칠 수 없는 상태(로컬 변경 · 갈라짐 · 다른 원격 주소)는 고치지 않고 그대로 알린다.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri_plugin_log::log;

use super::Context;
use super::locate::{self, same_path};
use crate::claude::exec::{Captured, ClaudeCommand};

/// 짧은 git 명령 (버전 · 상태 · 목록)
const LOCAL_TIMEOUT: Duration = Duration::from_secs(30);
/// 네트워크를 쓰는 명령 (fetch · pull)
const NETWORK_TIMEOUT: Duration = Duration::from_secs(180);
/// 처음 받기
const CLONE_TIMEOUT: Duration = Duration::from_secs(600);

/// 미리보기에 담을 최대 개수 (넘으면 `*_total` 만 크게 보인다)
pub const COMMITS_MAX: usize = 50;
pub const FILES_MAX: usize = 200;
const SUBJECT_MAX: usize = 200;
const PATH_MAX: usize = 300;
const DETAIL_MAX: usize = 600;

/// 받는 중인 복제본이 머무는 이름 — 다 받으면 `repo` 로 옮긴다 (받다가 끊겨도 `repo` 는 반쯤 받은 채로 남지 않는다).
const CLONING_DIR: &str = "repo.cloning";

// ───────────────────────────── git · Git Bash 찾기 (D-44) ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitInfo {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// `version_failed` — 찾았지만 `git --version` 이 안 돌았다
    pub problem: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBashInfo {
    /// 이 OS 에서 필요한가 (Windows 만 — 작업자 가드 hook 이 bash 로 돈다)
    pub required: bool,
    pub found: bool,
    pub path: Option<String>,
    /// `env` (`CLAUDE_CODE_GIT_BASH_PATH`) · `git` (git 설치 폴더의 `bin\bash.exe`)
    pub source: Option<&'static str>,
    /// `env_path_missing` — 사용자가 정한 `CLAUDE_CODE_GIT_BASH_PATH` 가 가리키는 파일이 없다
    pub problem: Option<&'static str>,
}

/// 사용자가 Git Bash 위치를 정하는 변수 (Claude Code 가 읽는다)
pub const GIT_BASH_VAR: &str = "CLAUDE_CODE_GIT_BASH_PATH";

/// git 실행 파일 찾기: PATH 의 절대 경로 칸 → 흔한 설치 위치. 상대 경로 칸(`.` 등)은 보지 않는다.
pub fn locate_git(path_var: Option<&OsStr>, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let from_path = path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .filter(|dir| dir.is_absolute());
    from_path
        .chain(extra_dirs.iter().cloned())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// 흔한 설치 위치 (PATH 에 없을 때)
fn common_git_dirs() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        let mut dirs = Vec::new();
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var).filter(|v| !v.is_empty()) {
                dirs.push(PathBuf::from(base).join("Git").join("cmd"));
            }
        }
        if let Some(base) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty()) {
            dirs.push(PathBuf::from(base).join("Programs").join("Git").join("cmd"));
        }
        dirs
    }
    #[cfg(not(windows))]
    {
        ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
            .iter()
            .map(PathBuf::from)
            .collect()
    }
}

pub fn locate_git_here() -> Option<PathBuf> {
    locate_git(std::env::var_os("PATH").as_deref(), &common_git_dirs())
}

/// `git version 2.55.0.windows.3` → `2.55.0.windows.3`
pub fn parse_git_version(output: &str) -> Option<String> {
    let line = output.lines().next()?.trim();
    let version = line.strip_prefix("git version ")?.trim();
    (!version.is_empty()
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+')))
    .then(|| version.to_string())
}

pub fn git_info(ctx: &Context) -> GitInfo {
    let Some(git) = ctx.git.as_deref() else {
        return GitInfo {
            found: false,
            path: None,
            version: None,
            problem: None,
        };
    };
    let version = run_git(ctx, git, None, &["--version"], LOCAL_TIMEOUT)
        .ok()
        .and_then(|out| parse_git_version(&out.stdout));
    GitInfo {
        found: true,
        path: Some(git.display().to_string()),
        problem: version.is_none().then_some("version_failed"),
        version,
    }
}

/// Git Bash 찾기 (Windows): 사용자가 정한 `CLAUDE_CODE_GIT_BASH_PATH` 가 있으면 그것 (없는 파일이면 "찾지 못함"으로 알린다 —
/// Claude Code 도 그 경로를 쓴다), 없으면 git 설치 폴더의 `bin\bash.exe`. PATH 의 `bash.exe`(WSL 실행기)는 보지 않는다.
pub fn locate_git_bash(
    git: Option<&Path>,
    env_value: Option<&OsStr>,
    required: bool,
) -> GitBashInfo {
    let mut info = GitBashInfo {
        required,
        found: false,
        path: None,
        source: None,
        problem: None,
    };
    if !required {
        return info;
    }
    if let Some(value) = env_value.filter(|v| !v.is_empty()) {
        let path = PathBuf::from(value);
        if path.is_absolute() && path.is_file() {
            info.found = true;
            info.path = Some(path.display().to_string());
            info.source = Some("env");
        } else {
            info.problem = Some("env_path_missing");
        }
        return info;
    }
    // `…\Git\cmd\git.exe` · `…\Git\bin\git.exe` · `…\Git\mingw64\bin\git.exe` 모두 위로 올라가며 `bin\bash.exe` 를 본다.
    if let Some(git) = git {
        let found = git
            .ancestors()
            .skip(1)
            .take(4)
            .map(|dir| dir.join("bin").join("bash.exe"))
            .find(|candidate| candidate.is_file());
        if let Some(bash) = found {
            info.found = true;
            info.path = Some(bash.display().to_string());
            info.source = Some("git");
        }
    }
    info
}

pub fn git_bash_info(ctx: &Context) -> GitBashInfo {
    locate_git_bash(
        ctx.git.as_deref(),
        std::env::var_os(GIT_BASH_VAR).as_deref(),
        cfg!(windows),
    )
}

// ───────────────────────────── git 실행 ─────────────────────────────

/// 어느 저장소를 볼지 바꾸는 git 환경 변수 — 앱이 다른 곳에서 떠서 물려받았더라도 자식에게 넘기지 않는다.
const GIT_REPO_VARS: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_INTERNAL_SUPER_PREFIX",
    "GIT_QUARANTINE_PATH",
    "GIT_CEILING_DIRECTORIES",
];

/// 환경에서 저장소를 고르는 git 변수를 뺀다 (이름의 대소문자는 가리지 않는다 — Windows).
pub fn strip_repo_vars(
    base: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    base.into_iter()
        .filter(|(name, _)| {
            let upper = name.to_string_lossy().to_ascii_uppercase();
            !GIT_REPO_VARS.contains(&upper.as_str())
        })
        .collect()
}

/// git 이 실패한 모양
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitError {
    /// 실행하지 못했다 (파일이 없어짐 · 권한)
    Spawn(String),
    /// 시간이 넘어 끝냈다
    TimedOut,
    /// 종료 코드가 0 이 아니다. `detail` 은 끝부분 몇 줄 (주소의 계정 정보는 지웠다)
    Exit { code: Option<i32>, detail: String },
}

impl GitError {
    fn outcome(&self) -> GitOutcome {
        match self {
            GitError::TimedOut => GitOutcome::TimedOut,
            _ => GitOutcome::Failed,
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            GitError::Spawn(text) => Some(text.clone()),
            GitError::TimedOut => None,
            GitError::Exit { detail, .. } => (!detail.is_empty()).then(|| detail.clone()),
        }
    }
}

/// `scheme://user:pass@host` 의 계정 정보를 지운다 (화면 · 로그에 토큰이 새지 않게).
pub fn redact_url(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find("://") {
        let (head, tail) = rest.split_at(index + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '/' || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        match authority.rfind('@') {
            Some(at) => out.push_str(&authority[at + 1..]),
            None => out.push_str(authority),
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// 오류 출력의 끝부분 몇 줄 — 사람이 읽는 진단용
fn detail_tail(out: &Captured) -> String {
    let text = if out.stderr.trim().is_empty() {
        &out.stdout
    } else {
        &out.stderr
    };
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    redact_url(&tail).chars().take(DETAIL_MAX).collect()
}

fn git_command(ctx: &Context, git: &Path) -> ClaudeCommand {
    let mut command = ClaudeCommand::new(git)
        .with_base_env(strip_repo_vars(std::env::vars_os()))
        // 계정 · 비밀번호를 묻는 창이나 입력 대기로 멈추지 않게
        .with_extra_env("GIT_TERMINAL_PROMPT", "0")
        .with_extra_env("GCM_INTERACTIVE", "never")
        // 오류 글을 읽을 일이 있어 언어를 고정한다
        .with_extra_env("LC_ALL", "C")
        .with_extra_env("LANGUAGE", "C")
        // 읽기 명령이 인덱스를 다시 쓰지 않게
        .with_extra_env("GIT_OPTIONAL_LOCKS", "0");
    for (name, value) in &ctx.extra_env {
        command = command.with_extra_env(name, value);
    }
    command
}

/// git 을 한 번 돌린다 (시간 제한 · 환경 정리 · 상위 저장소 방지). 내 수정 기록(`custom::history`)도 이것으로 돌린다.
pub fn run_git<S: AsRef<OsStr>>(
    ctx: &Context,
    git: &Path,
    repo: Option<&Path>,
    args: &[S],
    timeout: Duration,
) -> Result<Captured, GitError> {
    let mut full: Vec<OsString> = vec!["-c".into(), "core.quotepath=false".into()];
    if let Some(repo) = repo {
        full.push("-C".into());
        full.push(repo.as_os_str().to_owned());
    }
    full.extend(args.iter().map(|arg| arg.as_ref().to_owned()));
    let mut command = git_command(ctx, git);
    if repo.is_some()
        && let Ok(ceiling) = std::env::join_paths([&ctx.locations.harness_home])
    {
        // 상위 폴더에 다른 저장소가 있어도 거슬러 올라가 그것을 잡지 않게
        command = command.with_extra_env("GIT_CEILING_DIRECTORIES", ceiling);
    }
    let out = command
        .run_capture(&full, ctx.timeout.unwrap_or(timeout))
        .map_err(|e| GitError::Spawn(format!("could not run git: {e}")))?;
    if out.timed_out {
        return Err(GitError::TimedOut);
    }
    if out.code != Some(0) {
        return Err(GitError::Exit {
            code: out.code,
            detail: detail_tail(&out),
        });
    }
    Ok(out)
}

fn first_line(out: &Captured) -> String {
    out.stdout.lines().next().unwrap_or("").trim().to_string()
}

// ───────────────────────────── 결과 모양 ─────────────────────────────

/// 받기 · 업데이트 확인 · 업데이트 받기의 결과 종류 (화면이 문구를 고른다 — `src/lib/ipc-types.ts` 의 `GitOutcome` 과 같이)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GitOutcome {
    /// 처음 받았다 (clone)
    Cloned,
    /// 이미 받은 원본이 있다 (clone 은 하지 않았다)
    AlreadyPresent,
    /// 업데이트를 확인했다 (`update` 에 목록)
    Checked,
    /// 업데이트를 받았다
    Updated,
    /// 이미 최신이라 받을 것이 없었다
    UpToDate,
    /// 고치지 않고 거절했다 (`reason`: `dirty` · `diverged` · `ahead` · `detached_head` · `no_upstream` · `not_fast_forward`)
    Refused,
    /// 개발자 모드 — 개발자가 직접 관리하는 원본이라 받기 · 업데이트를 하지 않는다
    DeveloperMode,
    GitMissing,
    /// 받은 원본(`repo`)이 아직 없다
    RepoMissing,
    /// `repo` 가 있지만 쓸 수 없다 (`reason`: `not_git_repo` · `remote_mismatch`) — 지우지 않고 알린다
    RepoUnusable,
    /// git 이 실패했다 (`detail` 에 끝부분 몇 줄)
    Failed,
    TimedOut,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    UpToDate,
    /// 받을 커밋이 있고 빨리 감기로 받을 수 있다
    Behind,
    /// 로컬에만 있는 커밋이 있다 (원본은 아무도 고치지 않아야 한다)
    Ahead,
    Diverged,
    /// 브랜치가 아닌 커밋에 서 있다
    Detached,
    /// 따라가는 원격 브랜치가 없다
    NoUpstream,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub hash: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// git 의 한 글자 상태: `A` 새로 · `M` 바뀜 · `D` 지워짐 · `T` 종류 바뀜
    pub status: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreview {
    pub branch: Option<String>,
    pub upstream: Option<String>,
    /// 확인한 그때 따라가는 원격 브랜치가 가리키던 커밋의 전체 해시 — 받기는 이 커밋까지만 받는다 (확인 뒤 원본에 생긴 새 커밋은 받지 않는다)
    pub upstream_hash: Option<String>,
    pub state: UpdateState,
    pub ahead: u32,
    pub behind: u32,
    /// 로컬 변경(추적하는 파일)이 있다
    pub dirty: bool,
    pub commits: Vec<CommitInfo>,
    pub commits_total: u32,
    pub files: Vec<FileChange>,
    pub files_total: u32,
    /// `behind` 이고 로컬 변경이 없다 = 받기 단추를 켤 수 있다
    pub can_pull: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitResult {
    pub outcome: GitOutcome,
    /// 거절 · 쓸 수 없음의 이유 (진단용 짧은 이름)
    pub reason: Option<String>,
    /// git 의 끝부분 몇 줄 · 이상한 원격 주소 (주소의 계정 정보는 지웠다)
    pub detail: Option<String>,
    /// 지금 `repo` 의 짧은 해시
    pub head: Option<String>,
    /// 받기 전의 짧은 해시 (업데이트 받기)
    pub before: Option<String>,
    /// 업데이트 확인의 목록
    pub update: Option<UpdatePreview>,
    /// 업데이트 받기가 실제로 받은 커밋 (받기 전 HEAD..새 HEAD, 최신이 먼저, 상한 있음)
    pub pulled: Vec<CommitInfo>,
    /// 실제로 받은 커밋의 전체 수 (`pulled` 는 상한까지만)
    pub pulled_total: u32,
}

/// 업데이트 확인이 본 것 — 앱이 기억해 두었다가 받기가 그 커밋까지만 받게 한다 (`HarnessState`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedUpdate {
    /// 확인 때 서 있던 브랜치 — 받을 때 다른 브랜치에 서 있으면 받지 않는다
    pub branch: String,
    /// 확인 때 따라가는 원격 브랜치의 전체 해시
    pub upstream_hash: String,
}

impl CheckedUpdate {
    /// 업데이트 확인 결과에서 뽑는다 (확인이 끝나지 못했거나 따라갈 브랜치가 없으면 `None`)
    pub fn from_result(result: &GitResult) -> Option<Self> {
        let update = result.update.as_ref()?;
        (result.outcome == GitOutcome::Checked).then_some(())?;
        Some(Self {
            branch: update.branch.clone()?,
            upstream_hash: update.upstream_hash.clone()?,
        })
    }
}

impl GitResult {
    fn new(outcome: GitOutcome) -> Self {
        Self {
            outcome,
            reason: None,
            detail: None,
            head: None,
            before: None,
            update: None,
            pulled: Vec::new(),
            pulled_total: 0,
        }
    }

    fn reason(mut self, reason: &str) -> Self {
        self.reason = Some(reason.to_string());
        self
    }

    fn detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    fn head(mut self, head: Option<String>) -> Self {
        self.head = head;
        self
    }

    fn from_error(error: &GitError) -> Self {
        Self::new(error.outcome()).detail(error.detail())
    }
}

// ───────────────────────────── 받은 원본(repo) 살피기 ─────────────────────────────

/// 주소 비교용 — 끝의 `/` · `.git` · 계정 정보 · 구분자 모양 차이를 없앤다.
pub fn normalize_url(text: &str) -> String {
    let mut text = redact_url(text.trim()).replace('\\', "/");
    while text.ends_with('/') {
        text.pop();
    }
    if let Some(stripped) = text.strip_suffix(".git") {
        text = stripped.to_string();
    }
    while text.ends_with('/') {
        text.pop();
    }
    if cfg!(windows) || text.contains("://") || text.contains('@') {
        text = text.to_lowercase();
    }
    text
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RepoCheck {
    /// `repo` 폴더가 없다
    Missing,
    /// 폴더가 있지만 git 저장소가 아니다 (또는 다른 저장소의 하위 폴더일 뿐이다)
    NotARepo,
    /// 원격 `origin` 이 없거나 우리 원본 주소가 아니다 (`remote` 는 계정 정보를 지운 모양)
    WrongRemote {
        remote: Option<String>,
    },
    Ok {
        head: Option<String>,
    },
}

/// `repo` 가 우리가 받은 원본인지 본다. 아무것도 고치지 않는다.
pub fn inspect_repo(ctx: &Context, git: &Path) -> Result<RepoCheck, GitError> {
    let repo = ctx.locations.repo_dir();
    match fs::metadata(&repo) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Ok(RepoCheck::NotARepo),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // 깨진 링크도 "없음" 이 아니라 쓸 수 없는 것으로 알린다
            return Ok(if fs::symlink_metadata(&repo).is_ok() {
                RepoCheck::NotARepo
            } else {
                RepoCheck::Missing
            });
        }
        Err(err) => {
            return Err(GitError::Spawn(format!(
                "could not read the repo folder: {err}"
            )));
        }
    }
    // 저장소 맨 위에 `.git` 이 있어야 한다 — 없으면 상위 폴더의 저장소를 잘못 잡을 수 있다
    if fs::symlink_metadata(repo.join(".git")).is_err() {
        return Ok(RepoCheck::NotARepo);
    }
    match run_git(
        ctx,
        git,
        Some(&repo),
        &["rev-parse", "--show-toplevel"],
        LOCAL_TIMEOUT,
    ) {
        Ok(out) => {
            if !same_path(Path::new(&first_line(&out)), &repo) {
                return Ok(RepoCheck::NotARepo);
            }
        }
        Err(GitError::Exit { detail, code }) => {
            // 소유자가 다르다는 거절은 "저장소가 아님" 이 아니라 그대로 알린다
            if detail.contains("dubious ownership") {
                return Err(GitError::Exit { code, detail });
            }
            return Ok(RepoCheck::NotARepo);
        }
        Err(other) => return Err(other),
    }
    // 사용자 설정의 `url.<..>.insteadOf` 로 펼쳐지지 않은, 저장소에 적힌 그대로의 주소 (`remote get-url` 은 펼친 값을 준다)
    let remote = match run_git(
        ctx,
        git,
        Some(&repo),
        &["config", "--get", "remote.origin.url"],
        LOCAL_TIMEOUT,
    ) {
        Ok(out) => redact_url(&first_line(&out)),
        Err(GitError::Exit { .. }) => return Ok(RepoCheck::WrongRemote { remote: None }),
        Err(other) => return Err(other),
    };
    if normalize_url(&remote) != normalize_url(&ctx.origin_url) {
        return Ok(RepoCheck::WrongRemote {
            remote: Some(remote),
        });
    }
    Ok(RepoCheck::Ok {
        head: short_head(ctx, git, &repo),
    })
}

fn short_head(ctx: &Context, git: &Path, repo: &Path) -> Option<String> {
    run_git(
        ctx,
        git,
        Some(repo),
        &["rev-parse", "--short", "HEAD"],
        LOCAL_TIMEOUT,
    )
    .ok()
    .map(|out| first_line(&out))
    .filter(|h| !h.is_empty())
}

/// 개발자 모드 · git 없음 · repo 상태를 걸러, 쓸 수 있는 repo 에서만 `Ok` 로 돌려준다 (오류면 그 결과를 바로 돌려줄 수 있게 `Err`).
fn usable_repo(ctx: &Context, need_repo: bool) -> Result<(&Path, Option<String>), Box<GitResult>> {
    if locate::resolve_source(&ctx.locations).developer() {
        return Err(Box::new(GitResult::new(GitOutcome::DeveloperMode)));
    }
    let Some(git) = ctx.git.as_deref() else {
        return Err(Box::new(GitResult::new(GitOutcome::GitMissing)));
    };
    let refuse = |result: GitResult| Err(Box::new(result));
    match inspect_repo(ctx, git) {
        Ok(RepoCheck::Ok { head }) => Ok((git, head)),
        Ok(RepoCheck::Missing) if !need_repo => Ok((git, None)),
        Ok(RepoCheck::Missing) => refuse(GitResult::new(GitOutcome::RepoMissing)),
        Ok(RepoCheck::NotARepo) => {
            refuse(GitResult::new(GitOutcome::RepoUnusable).reason("not_git_repo"))
        }
        Ok(RepoCheck::WrongRemote { remote }) => refuse(
            GitResult::new(GitOutcome::RepoUnusable)
                .reason("remote_mismatch")
                .detail(remote),
        ),
        Err(error) => refuse(GitResult::from_error(&error)),
    }
}

// ───────────────────────────── 받기 (clone) ─────────────────────────────

/// 지우기 — 링크는 따라가지 않고 링크만 지운다 (`remove_dir_all` 이 그렇게 한다). 실패는 알리지 않는다 (임시 폴더 정리).
fn remove_quietly(path: &Path) {
    if fs::symlink_metadata(path).is_ok() {
        let _ = fs::remove_dir_all(path);
    }
}

/// 원본을 `<하네스 폴더>/repo` 로 받는다. `repo` 가 없을 때만 받고, 있으면 아무것도 지우지 않고 알린다.
pub fn clone_origin(ctx: &Context) -> GitResult {
    let (git, existing_head) = match usable_repo(ctx, false) {
        Ok(found) => found,
        Err(result) => return *result,
    };
    let repo = ctx.locations.repo_dir();
    if existing_head.is_some() || fs::symlink_metadata(&repo).is_ok() {
        // `usable_repo` 가 통과시킨 `repo` 는 우리 원본이다 — 이미 있다
        return GitResult::new(GitOutcome::AlreadyPresent).head(short_head(ctx, git, &repo));
    }

    let home = &ctx.locations.harness_home;
    if let Err(err) = fs::create_dir_all(home) {
        return GitResult::new(GitOutcome::Failed)
            .detail(Some(format!("could not create the harness folder: {err}")));
    }
    let staging = home.join(CLONING_DIR);
    remove_quietly(&staging);

    log::info!("harness: cloning the origin into {}", staging.display());
    let args: Vec<OsString> = vec![
        "clone".into(),
        // Windows 의 `core.autocrlf=true` 가 `.sh` 를 CRLF 로 받아 bash 가 못 읽는 일을 막는다 (저장소 설정으로 남는다)
        "-c".into(),
        "core.autocrlf=false".into(),
        "-c".into(),
        "core.longpaths=true".into(),
        "--quiet".into(),
        "--".into(),
        OsString::from(&ctx.origin_url),
        staging.as_os_str().to_owned(),
    ];
    let cloned = run_git(ctx, git, None, &args, CLONE_TIMEOUT);
    if let Err(error) = cloned {
        remove_quietly(&staging);
        log::warn!("harness: clone failed: {error:?}");
        return GitResult::from_error(&error);
    }
    if let Err(err) = fs::rename(&staging, &repo) {
        remove_quietly(&staging);
        return GitResult::new(GitOutcome::Failed)
            .detail(Some(format!("could not move the clone into place: {err}")));
    }
    GitResult::new(GitOutcome::Cloned).head(short_head(ctx, git, &repo))
}

// ───────────────────────────── 업데이트 확인 · 받기 ─────────────────────────────

/// 지금 서 있는 브랜치와 따라가는 원격 브랜치
fn branch_and_upstream(ctx: &Context, git: &Path, repo: &Path) -> (Option<String>, Option<String>) {
    let branch = run_git(
        ctx,
        git,
        Some(repo),
        &["symbolic-ref", "--short", "-q", "HEAD"],
        LOCAL_TIMEOUT,
    )
    .ok()
    .map(|out| first_line(&out))
    .filter(|b| !b.is_empty());
    if branch.is_none() {
        return (None, None);
    }
    let upstream = run_git(
        ctx,
        git,
        Some(repo),
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        LOCAL_TIMEOUT,
    )
    .ok()
    .map(|out| first_line(&out))
    .filter(|u| !u.is_empty());
    (branch, upstream)
}

fn is_dirty(ctx: &Context, git: &Path, repo: &Path) -> Result<bool, GitError> {
    let out = run_git(
        ctx,
        git,
        Some(repo),
        &["status", "--porcelain=v1", "--untracked-files=no"],
        LOCAL_TIMEOUT,
    )?;
    Ok(!out.stdout.trim().is_empty())
}

/// `target`(커밋 해시)과 비교한 `(내 쪽에만 있는 수, 그쪽에만 있는 수)`
fn ahead_behind(
    ctx: &Context,
    git: &Path,
    repo: &Path,
    target: &str,
) -> Result<(u32, u32), GitError> {
    let range = format!("HEAD...{target}");
    let out = run_git(
        ctx,
        git,
        Some(repo),
        &["rev-list", "--left-right", "--count", range.as_str()],
        LOCAL_TIMEOUT,
    )?;
    let line = first_line(&out);
    let mut numbers = line.split_whitespace().map(str::parse::<u32>);
    match (numbers.next(), numbers.next()) {
        (Some(Ok(ahead)), Some(Ok(behind))) => Ok((ahead, behind)),
        _ => Err(GitError::Exit {
            code: Some(0),
            detail: "unexpected rev-list output".into(),
        }),
    }
}

/// 전체 해시 모양인가 (SHA-1 40자 · SHA-256 64자, 16진수)
fn is_full_hash(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|c| c.is_ascii_hexdigit())
}

/// 커밋 하나의 전체 해시 (`rev` 는 이 파일이 정한 `HEAD` · `@{u}` 뿐이다)
fn full_hash(ctx: &Context, git: &Path, repo: &Path, rev: &str) -> Result<String, GitError> {
    let spec = format!("{rev}^{{commit}}");
    let out = run_git(
        ctx,
        git,
        Some(repo),
        &["rev-parse", "--verify", "--quiet", spec.as_str()],
        LOCAL_TIMEOUT,
    )?;
    let hash = first_line(&out);
    if is_full_hash(&hash) {
        Ok(hash)
    } else {
        Err(GitError::Exit {
            code: Some(0),
            detail: "unexpected rev-parse output".into(),
        })
    }
}

/// `range`(`a..b`)의 커밋 목록(최신이 먼저, `COMMITS_MAX` 까지)과 전체 수
fn commit_list(
    ctx: &Context,
    git: &Path,
    repo: &Path,
    range: &str,
) -> Result<(Vec<CommitInfo>, u32), GitError> {
    let max = format!("--max-count={COMMITS_MAX}");
    let listed = run_git(
        ctx,
        git,
        Some(repo),
        &[
            "log",
            &max,
            "--date=short",
            "--format=%h%x1f%cd%x1f%s",
            range,
        ],
        LOCAL_TIMEOUT,
    )?;
    let counted = run_git(
        ctx,
        git,
        Some(repo),
        &["rev-list", "--count", range],
        LOCAL_TIMEOUT,
    )?;
    let commits = parse_commits(&listed.stdout);
    let total = first_line(&counted)
        .parse::<u32>()
        .unwrap_or_else(|_| u32::try_from(commits.len()).unwrap_or(u32::MAX));
    Ok((commits, total))
}

/// `git log` 한 줄씩 (`해시 \x1f 날짜 \x1f 제목`)
pub fn parse_commits(text: &str) -> Vec<CommitInfo> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.trim_end_matches('\r').splitn(3, '\u{1f}');
            let hash = parts.next()?.trim();
            let date = parts.next()?.trim();
            let subject = parts.next()?.trim();
            (!hash.is_empty()).then(|| CommitInfo {
                hash: hash.chars().take(40).collect(),
                date: date.chars().take(32).collect(),
                subject: subject.chars().take(SUBJECT_MAX).collect(),
            })
        })
        .collect()
}

/// `git diff --name-status -z` (상태 `\0` 경로 `\0` …). 이름 바꾸기는 `--no-renames` 로 지웠다 + 새로 로 나온다.
pub fn parse_name_status(text: &str) -> Vec<FileChange> {
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let mut files = Vec::new();
    while let (Some(status), Some(path)) = (tokens.next(), tokens.next()) {
        files.push(FileChange {
            status: status.chars().take(1).collect(),
            path: path.chars().take(PATH_MAX).collect(),
        });
    }
    files
}

fn state_of(
    branch: &Option<String>,
    upstream: &Option<String>,
    ahead: u32,
    behind: u32,
) -> UpdateState {
    if branch.is_none() {
        return UpdateState::Detached;
    }
    if upstream.is_none() {
        return UpdateState::NoUpstream;
    }
    match (ahead, behind) {
        (0, 0) => UpdateState::UpToDate,
        (0, _) => UpdateState::Behind,
        (_, 0) => UpdateState::Ahead,
        _ => UpdateState::Diverged,
    }
}

/// 업데이트 확인: `git fetch` 로 원격을 보고 받을 커밋 · 바뀔 파일을 미리 보인다. 작업 폴더는 건드리지 않는다.
/// 그때 따라가는 원격 브랜치의 커밋을 `upstream_hash` 로 못 박고, 아래 목록 · 개수는 모두 그 커밋 기준이다 (받기가 그 커밋까지만 받는다).
pub fn update_check(ctx: &Context) -> GitResult {
    let (git, head) = match usable_repo(ctx, true) {
        Ok(found) => found,
        Err(result) => return *result,
    };
    let repo = ctx.locations.repo_dir();
    let (branch, upstream) = branch_and_upstream(ctx, git, &repo);
    if upstream.is_some() {
        log::info!("harness: git fetch");
        if let Err(error) = run_git(
            ctx,
            git,
            Some(&repo),
            &["fetch", "--quiet", "origin"],
            NETWORK_TIMEOUT,
        ) {
            return GitResult::from_error(&error).head(head);
        }
    }
    let dirty = match is_dirty(ctx, git, &repo) {
        Ok(dirty) => dirty,
        Err(error) => return GitResult::from_error(&error).head(head),
    };
    let upstream_hash = if upstream.is_some() {
        match full_hash(ctx, git, &repo, "@{u}") {
            Ok(hash) => Some(hash),
            Err(error) => return GitResult::from_error(&error).head(head),
        }
    } else {
        None
    };
    let (ahead, behind) = match upstream_hash.as_deref() {
        Some(target) => match ahead_behind(ctx, git, &repo, target) {
            Ok(counts) => counts,
            Err(error) => return GitResult::from_error(&error).head(head),
        },
        None => (0, 0),
    };
    let mut preview = UpdatePreview {
        state: state_of(&branch, &upstream, ahead, behind),
        branch,
        upstream,
        upstream_hash: upstream_hash.clone(),
        ahead,
        behind,
        dirty,
        commits: Vec::new(),
        commits_total: behind,
        files: Vec::new(),
        files_total: 0,
        can_pull: false,
    };
    if let (Some(target), true) = (upstream_hash.as_deref(), behind > 0) {
        match commit_list(ctx, git, &repo, &format!("HEAD..{target}")) {
            Ok((commits, total)) => {
                preview.commits = commits;
                preview.commits_total = total;
            }
            Err(error) => return GitResult::from_error(&error).head(head),
        }
        let range = format!("HEAD...{target}");
        match run_git(
            ctx,
            git,
            Some(&repo),
            &[
                "diff",
                "--name-status",
                "-z",
                "--no-renames",
                range.as_str(),
            ],
            LOCAL_TIMEOUT,
        ) {
            Ok(out) => {
                let mut files = parse_name_status(&out.stdout);
                preview.files_total = u32::try_from(files.len()).unwrap_or(u32::MAX);
                files.truncate(FILES_MAX);
                preview.files = files;
            }
            Err(error) => return GitResult::from_error(&error).head(head),
        }
    }
    preview.can_pull = preview.state == UpdateState::Behind && !preview.dirty;
    let mut result = GitResult::new(GitOutcome::Checked).head(head);
    result.update = Some(preview);
    result
}

/// 업데이트 받기: 확인 때 본 커밋까지만 빨리 감기로 합친다 (`merge --ff-only <그 해시>`) — 다시 fetch 하지 않으므로 확인 뒤 원본에 생긴 새 커밋은 받지 않는다.
/// `checked` 가 없으면(확인한 적 없음 · 이미 받음 · 설치함) `check_first` 로 거절한다. 로컬 변경 · 갈라짐 · 로컬에만 있는 커밋이 있으면 고치지 않고 거절한다.
pub fn update_pull(ctx: &Context, checked: Option<&CheckedUpdate>) -> GitResult {
    let (git, before) = match usable_repo(ctx, true) {
        Ok(found) => found,
        Err(result) => return *result,
    };
    let repo = ctx.locations.repo_dir();
    let refuse = |reason: &str| {
        GitResult::new(GitOutcome::Refused)
            .reason(reason)
            .head(before.clone())
    };
    let (branch, upstream) = branch_and_upstream(ctx, git, &repo);
    let Some(branch) = branch else {
        return refuse("detached_head");
    };
    if upstream.is_none() {
        return refuse("no_upstream");
    }
    let Some(checked) = checked else {
        return refuse("check_first");
    };
    if checked.branch != branch || !is_full_hash(&checked.upstream_hash) {
        // 확인한 뒤에 다른 브랜치로 옮겨 섰다 — 본 것과 받는 것이 달라지므로 다시 확인하게 한다
        return refuse("check_first");
    }
    let target = checked.upstream_hash.as_str();
    match is_dirty(ctx, git, &repo) {
        Ok(true) => return refuse("dirty"),
        Ok(false) => {}
        Err(error) => return GitResult::from_error(&error).head(before),
    }
    match ahead_behind(ctx, git, &repo, target) {
        Ok((0, _)) => {}
        Ok((_, 0)) => return refuse("ahead"),
        Ok(_) => return refuse("diverged"),
        Err(error) => return GitResult::from_error(&error).head(before),
    }
    let before_full = match full_hash(ctx, git, &repo, "HEAD") {
        Ok(hash) => hash,
        Err(error) => return GitResult::from_error(&error).head(before),
    };
    log::info!("harness: fast-forward merge up to {target}");
    // 사용자 설정(`merge.ff` · `merge.verifySignatures` · `pull.rebase` …)이 받는 방식을 바꾸지 못하게 못 박는다
    let merged = run_git(
        ctx,
        git,
        Some(&repo),
        &[
            "merge",
            "--ff-only",
            "--no-edit",
            "--no-autostash",
            "--no-verify-signatures",
            "--quiet",
            target,
        ],
        LOCAL_TIMEOUT,
    );
    if let Err(error) = merged {
        // 빨리 감기가 안 되는 경우를 git 이 먼저 알려 주면 그대로 거절로 알린다 (`LC_ALL=C` 로 글이 고정이다)
        if let GitError::Exit { detail, .. } = &error
            && (detail.contains("fast-forward") || detail.contains("diverging"))
        {
            return refuse("not_fast_forward").detail(Some(detail.clone()));
        }
        return GitResult::from_error(&error).head(before);
    }
    let after = short_head(ctx, git, &repo);
    let outcome = if after == before {
        GitOutcome::UpToDate
    } else {
        GitOutcome::Updated
    };
    let mut result = GitResult::new(outcome).head(after);
    result.before = before;
    if outcome == GitOutcome::Updated {
        // 실제로 받은 커밋 (받기 전 HEAD..새 HEAD). 목록을 못 읽어도 받기는 이미 끝났으니 오류로 올리지 않는다.
        match commit_list(ctx, git, &repo, &format!("{before_full}..HEAD")) {
            Ok((commits, total)) => {
                result.pulled = commits;
                result.pulled_total = total;
            }
            Err(error) => log::warn!("harness: could not list the pulled commits: {error:?}"),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    #[test]
    fn parses_git_version_lines() {
        assert_eq!(
            parse_git_version("git version 2.55.0.windows.3\n"),
            Some("2.55.0.windows.3".into())
        );
        assert_eq!(
            parse_git_version("git version 2.43.0"),
            Some("2.43.0".into())
        );
        assert_eq!(
            parse_git_version("git version 2.39.5 (Apple Git-154)"),
            None
        );
        assert_eq!(parse_git_version(""), None);
        assert_eq!(parse_git_version("error: not git"), None);
        assert_eq!(parse_git_version("git version "), None);
    }

    #[test]
    fn urls_lose_account_details() {
        assert_eq!(
            redact_url("https://user:ghp_secret@github.com/a/b.git"),
            "https://github.com/a/b.git"
        );
        assert_eq!(
            redact_url(
                "fatal: unable to access 'https://tok@github.com/a/b/': Could not resolve host"
            ),
            "fatal: unable to access 'https://github.com/a/b/': Could not resolve host"
        );
        assert_eq!(
            redact_url("https://github.com/a/b"),
            "https://github.com/a/b"
        );
        assert_eq!(redact_url("C:\\local\\path"), "C:\\local\\path");
        // 한 글에 주소가 둘이어도 둘 다
        assert_eq!(
            redact_url("a https://u:p@h1/x and ssh://git@h2/y"),
            "a https://h1/x and ssh://h2/y"
        );
    }

    #[test]
    fn urls_compare_by_meaning_not_spelling() {
        let base = normalize_url("https://github.com/nerohee/claude-harness");
        for same in [
            "https://github.com/nerohee/claude-harness.git",
            "https://github.com/nerohee/claude-harness/",
            "https://github.com/nerohee/claude-harness.git/",
            "HTTPS://GitHub.com/Nerohee/Claude-Harness",
            "https://token@github.com/nerohee/claude-harness.git",
        ] {
            assert_eq!(normalize_url(same), base, "{same}");
        }
        for other in [
            "https://github.com/nerohee/claude-harness-fork",
            "https://github.com/someone/claude-harness",
            "https://gitlab.com/nerohee/claude-harness",
            "git@github.com:nerohee/claude-harness.git",
        ] {
            assert_ne!(normalize_url(other), base, "{other}");
        }
        assert_eq!(normalize_url("C:\\a\\b\\"), normalize_url("C:/a/b"));
    }

    #[test]
    fn git_is_found_in_absolute_path_entries_then_extra_dirs() {
        let name = if cfg!(windows) { "git.exe" } else { "git" };
        let first = TempDir::new("git-a");
        let second = TempDir::new("git-b");
        let extra = TempDir::new("git-c");
        fs::write(second.join(name), b"x").unwrap();
        fs::write(extra.join(name), b"x").unwrap();
        let path_var = std::env::join_paths([
            PathBuf::from("."),
            first.to_path_buf(),
            second.to_path_buf(),
        ])
        .unwrap();
        // 상대 칸은 건너뛰고 PATH 순서대로
        assert_eq!(
            locate_git(Some(&path_var), &[extra.to_path_buf()]),
            Some(second.join(name))
        );
        // PATH 에 없으면 흔한 위치
        let empty = std::env::join_paths([first.path()]).unwrap();
        assert_eq!(
            locate_git(Some(&empty), &[extra.to_path_buf()]),
            Some(extra.join(name))
        );
        assert_eq!(locate_git(Some(&empty), &[]), None);
        assert_eq!(locate_git(None, &[]), None);
    }

    #[test]
    fn repo_selecting_git_variables_are_not_passed_on_but_the_rest_is() {
        let os = |s: &str| OsString::from(s);
        let base = vec![
            (os("PATH"), os("x")),
            (os("GIT_DIR"), os("/elsewhere/.git")),
            (os("git_work_tree"), os("/elsewhere")),
            (os("GIT_INDEX_FILE"), os("i")),
            (os("GIT_CEILING_DIRECTORIES"), os("/")),
            (os("GIT_SSH_COMMAND"), os("ssh -i key")),
            (os("HTTPS_PROXY"), os("http://proxy")),
            (os("GIT_CONFIG_GLOBAL"), os("g")),
        ];
        let kept: Vec<String> = strip_repo_vars(base)
            .into_iter()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            kept,
            [
                "PATH",
                "GIT_SSH_COMMAND",
                "HTTPS_PROXY",
                "GIT_CONFIG_GLOBAL"
            ]
        );
    }

    #[test]
    fn git_bash_is_not_required_off_windows() {
        let info = locate_git_bash(None, None, false);
        assert!(!info.required && !info.found);
    }

    #[test]
    fn git_bash_from_the_users_variable_is_used_and_a_missing_file_is_a_problem_not_a_fallback() {
        let dir = TempDir::new("bash-env");
        let mine = dir.join("my-bash.exe");
        fs::write(&mine, b"x").unwrap();
        let info = locate_git_bash(None, Some(mine.as_os_str()), true);
        assert!(info.found);
        assert_eq!(info.source, Some("env"));
        assert_eq!(info.path.as_deref(), Some(mine.to_string_lossy().as_ref()));

        // git 설치 폴더에 bash 가 있어도, 사용자가 정한 길이 틀렸으면 틀렸다고 알린다 (Claude Code 도 그 길을 쓴다)
        let git_dir = dir.join("Git");
        fs::create_dir_all(git_dir.join("cmd")).unwrap();
        fs::create_dir_all(git_dir.join("bin")).unwrap();
        fs::write(git_dir.join("cmd").join("git.exe"), b"x").unwrap();
        fs::write(git_dir.join("bin").join("bash.exe"), b"x").unwrap();
        let missing = dir.join("nope.exe");
        let info = locate_git_bash(
            Some(&git_dir.join("cmd").join("git.exe")),
            Some(missing.as_os_str()),
            true,
        );
        assert!(!info.found);
        assert_eq!(info.problem, Some("env_path_missing"));
        // 상대 경로도 안 된다
        let info = locate_git_bash(None, Some(OsStr::new("bash.exe")), true);
        assert_eq!(info.problem, Some("env_path_missing"));
        // 빈 값은 없는 것
        let info = locate_git_bash(None, Some(OsStr::new("")), true);
        assert_eq!(info.problem, None);
    }

    #[test]
    fn git_bash_is_found_next_to_git_in_any_standard_layout() {
        let root = TempDir::new("bash-layout");
        let git_dir = root.join("Git");
        fs::create_dir_all(git_dir.join("bin")).unwrap();
        fs::write(git_dir.join("bin").join("bash.exe"), b"x").unwrap();
        for layout in [
            ["cmd", "git.exe"].as_slice(),
            ["bin", "git.exe"].as_slice(),
            ["mingw64", "bin", "git.exe"].as_slice(),
        ] {
            let mut git = git_dir.clone();
            for part in layout {
                git.push(part);
            }
            let info = locate_git_bash(Some(&git), None, true);
            assert!(info.found, "{layout:?}");
            assert_eq!(info.source, Some("git"));
        }
        // 위로 4칸 안에 없으면 못 찾는다 (엉뚱한 곳의 bash.exe 를 줍지 않는다)
        let lonely = root.join("tools").join("git.exe");
        assert!(!locate_git_bash(Some(&lonely), None, true).found);
    }

    #[test]
    fn commit_lines_parse_and_odd_lines_are_skipped() {
        let text = "abc1234\u{1f}2026-10-20\u{1f}fix: 제목\nbad line\n\u{1f}x\u{1f}y\ndef5678\u{1f}2026-10-19\u{1f}feat: a\u{1f}b\r\n";
        let commits = parse_commits(text);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "abc1234");
        assert_eq!(commits[0].subject, "fix: 제목");
        // 제목에 구분 글자가 있어도 제목 안에 남는다
        assert_eq!(commits[1].subject, "feat: a\u{1f}b");
    }

    #[test]
    fn commit_subjects_are_capped() {
        let text = format!("abc\u{1f}2026-10-20\u{1f}{}\n", "가".repeat(1000));
        assert_eq!(parse_commits(&text)[0].subject.chars().count(), SUBJECT_MAX);
    }

    #[test]
    fn name_status_output_parses_in_pairs_with_non_ascii_names() {
        let text = "M\0README.md\0A\0docs/한글 이름.md\0D\0old.txt\0";
        let files = parse_name_status(text);
        assert_eq!(
            files,
            vec![
                FileChange {
                    status: "M".into(),
                    path: "README.md".into()
                },
                FileChange {
                    status: "A".into(),
                    path: "docs/한글 이름.md".into()
                },
                FileChange {
                    status: "D".into(),
                    path: "old.txt".into()
                },
            ]
        );
        // 짝이 안 맞는 끝은 버린다
        assert_eq!(parse_name_status("M\0a\0A\0").len(), 1);
        assert!(parse_name_status("").is_empty());
    }

    #[test]
    fn update_state_is_decided_from_counts() {
        let on = Some("main".to_string());
        let up = Some("origin/main".to_string());
        assert_eq!(state_of(&on, &up, 0, 0), UpdateState::UpToDate);
        assert_eq!(state_of(&on, &up, 0, 3), UpdateState::Behind);
        assert_eq!(state_of(&on, &up, 2, 0), UpdateState::Ahead);
        assert_eq!(state_of(&on, &up, 2, 3), UpdateState::Diverged);
        assert_eq!(state_of(&None, &None, 0, 0), UpdateState::Detached);
        assert_eq!(state_of(&on, &None, 0, 0), UpdateState::NoUpstream);
    }

    #[test]
    fn git_error_details_are_cut_to_the_tail_without_account_details() {
        let out = Captured {
            code: Some(128),
            stdout: String::new(),
            stderr: (1..=20)
                .map(|n| format!("line {n}"))
                .chain(std::iter::once(
                    "fatal: unable to access 'https://u:tok@h/x/': boom".to_string(),
                ))
                .collect::<Vec<_>>()
                .join("\n"),
            timed_out: false,
        };
        let detail = detail_tail(&out);
        assert!(detail.contains("boom"));
        assert!(!detail.contains("tok"));
        assert!(!detail.contains("line 1\n"));
        assert!(detail.lines().count() <= 6);
    }
}
