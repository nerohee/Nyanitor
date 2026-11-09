//! 기록 — 내 수정 폴더(`custom/`)의 로컬 git (D-21 · D-51). 원격 · 푸시 · 브랜치는 없다.
//!
//! 앱 전용 저장소라 사용자의 git 설정에 기대지 않는다: 모든 명령에서 이름 · 메일 · 서명 끄기 · 줄바꿈 변환 끄기 · 글자 인용 끄기를 정하고,
//! 사용자 전역의 hook · 무시 목록 · 임시 파일 감시(fsmonitor) · 자동 정리(gc)가 끼어들지 않게 한다. 실행은 `harness::git::run_git` 하나로 한다
//! (시간 제한 · 환경 정리 · 상위 저장소 방지가 이미 되어 있다).
//!
//! - **적용 안 한 것** = 커밋 안 된 변경 (새 파일 포함). 목록 · 줄 단위 차이를 준다.
//! - 커밋 종류는 메시지 끝 표시 줄 `Nyanitor-Kind: <종류>` 로 알아본다 (두 번째 `-m` 문단). 표시가 없는 커밋은 `other`.
//! - git 이 없으면 (`Access::NoGit`) 저장 · 적용은 되고 기록만 없다 — 오류가 아니다.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri_plugin_log::log;

use super::Env;
use super::fsx;
use super::model::{
    CommitDiff, CommitEntry, CommitKind, DiffLine, FileDiff, FileStatus, HistoryInfo, HistoryList,
    HistoryState, Unapplied, UnappliedFile,
};
use crate::claude::exec::Captured;
use crate::error::AppError;
use crate::harness::git::{GitError, run_git};
use crate::strings;

/// git 한 번의 시간 제한 (로컬 명령뿐이다)
const GIT_TIMEOUT: Duration = Duration::from_secs(60);
/// 커밋 이름 · 메일 (사용자 설정과 상관없다)
pub const AUTHOR_NAME: &str = "Nyanitor";
pub const AUTHOR_EMAIL: &str = "nyanitor@localhost";
/// 기록 목록의 커밋 수 상한
pub const LOG_MAX: usize = 200;
/// 커밋 하나에 보이는 파일 이름 수 상한
const COMMIT_FILES_MAX: usize = 50;
/// 적용 안 한 파일 목록 상한
pub const UNAPPLIED_FILES_MAX: usize = 200;
/// 차이를 주는 파일 수 · 파일마다 줄 수 · 전체 줄 수 상한
const DIFF_FILES_MAX: usize = 100;
const DIFF_LINES_PER_FILE: usize = 400;
const DIFF_LINES_TOTAL: usize = 2000;
/// 차이 한 줄의 글자 수 상한
const DIFF_LINE_CHARS: usize = 1000;
/// 커밋 메시지 한 줄의 글자 수 상한
pub const MESSAGE_MAX_CHARS: usize = 200;
/// 첫 기록이 만드는 `.gitignore` — 임시 파일과 OS 가 만드는 찌꺼기만 (저장 중 끊겨 남은 임시 파일이 기록에 끼지 않게)
const GITIGNORE: &str = "# Nyanitor 가 만든 내 수정 기록 — 쓰다 남은 임시 파일과 OS 찌꺼기는 기록하지 않는다\n.*.nyanitor-*.tmp\n.DS_Store\nThumbs.db\ndesktop.ini\n";
const KIND_PREFIX: &str = "Nyanitor-Kind:";

/// 기록을 쓸 수 있는 상태
pub enum Access<'a> {
    /// 이 PC 에 git 이 없다
    NoGit,
    /// `custom/` 에 아직 기록이 없다 (`.git` 이 없거나 첫 커밋이 없다)
    NotStarted,
    /// git 을 부르지 못했다 (진단용 글)
    Failed(String),
    Ready(Repo<'a>),
}

/// 기록이 시작된 저장소 한 개
pub struct Repo<'a> {
    env: &'a Env<'a>,
    git: &'a Path,
}

pub fn describe(error: &GitError) -> String {
    match error {
        GitError::Spawn(text) => text.clone(),
        GitError::TimedOut => "git timed out".to_string(),
        GitError::Exit { code, detail } => format!(
            "git exited with {}: {}",
            code.map_or("no code".to_string(), |c| c.to_string()),
            detail
        ),
    }
}

fn internal(error: &GitError) -> AppError {
    AppError::Internal(format!("custom history: {}", describe(error)))
}

/// 모든 명령 앞에 붙는 설정 — 사용자 git 설정에 기대지 않는다 (이름 · 메일 · 서명 · 줄바꿈 · 인용 · hook · 무시 목록 · fsmonitor · 자동 정리)
fn base_config(custom: &Path) -> Vec<OsString> {
    // 없는 폴더 · 파일을 가리켜 사용자 전역의 hook · 무시 목록을 끈다 (git 은 없는 경로를 "없음" 으로 본다)
    let nowhere = custom.join(".git").join("nyanitor-none");
    let mut args: Vec<OsString> = Vec::new();
    for (key, value) in [
        ("user.name", AUTHOR_NAME.to_string()),
        ("user.email", AUTHOR_EMAIL.to_string()),
        ("commit.gpgsign", "false".to_string()),
        ("tag.gpgsign", "false".to_string()),
        ("core.autocrlf", "false".to_string()),
        ("core.safecrlf", "false".to_string()),
        ("core.quotepath", "false".to_string()),
        ("core.longpaths", "true".to_string()),
        ("core.fsmonitor", "false".to_string()),
        ("core.hooksPath", nowhere.display().to_string()),
        ("core.excludesFile", nowhere.display().to_string()),
        ("gc.auto", "0".to_string()),
        ("maintenance.auto", "false".to_string()),
        ("advice.detachedHead", "false".to_string()),
    ] {
        args.push("-c".into());
        args.push(format!("{key}={value}").into());
    }
    args
}

fn run_in(env: &Env, git: &Path, dir: &Path, args: &[&str]) -> Result<Captured, GitError> {
    let mut full = base_config(&env.custom);
    full.extend(args.iter().map(OsString::from));
    run_git(env.ctx, git, Some(dir), &full, GIT_TIMEOUT)
}

/// 지금 기록이 어떤 상태인가 (읽기만 한다 — 아무것도 만들지 않는다)
pub fn access<'a>(env: &'a Env<'a>) -> Access<'a> {
    let Some(git) = env.ctx.git.as_deref() else {
        return Access::NoGit;
    };
    let dot_git = env.custom.join(".git");
    match fs::symlink_metadata(&dot_git) {
        Ok(meta) if fsx::is_link(&meta) || !meta.is_dir() => {
            return Access::Failed("the history folder is not a plain folder".into());
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Access::NotStarted,
        Err(err) => return Access::Failed(err.to_string()),
    }
    if fsx::check_plain(&env.custom, ".git").is_err() {
        return Access::Failed("the history folder is behind a link".into());
    }
    match run_in(
        env,
        git,
        &env.custom,
        &["rev-parse", "--verify", "--quiet", "HEAD"],
    ) {
        Ok(_) => Access::Ready(Repo { env, git }),
        // `--quiet` — 첫 커밋이 없으면 조용히 1 로 끝난다
        Err(GitError::Exit { code: Some(1), .. }) => Access::NotStarted,
        Err(error) => Access::Failed(describe(&error)),
    }
}

/// 기록 상태의 화면용 요약
pub fn info(access: &Access) -> HistoryInfo {
    let (state, detail) = match access {
        Access::NoGit => (HistoryState::NoGit, None),
        Access::NotStarted => (HistoryState::NotStarted, None),
        Access::Failed(detail) => (HistoryState::Failed, Some(detail.clone())),
        Access::Ready(_) => (HistoryState::Ok, None),
    };
    HistoryInfo { state, detail }
}

/// 쓰기 전에 기록이 없으면 시작한다 — `git init` + `.gitignore` + 있던 내용 그대로 첫 커밋 (`처음 기록`).
/// git 이 없으면 아무것도 안 하고 `Ok(false)`. 시작했거나 이미 시작돼 있으면 `Ok(true)`.
/// 시작하지 못하면 오류 — 기록 없이 쓰면 어디까지가 "적용한 것" 인지 잃는다.
pub fn ensure_started(env: &Env) -> Result<bool, AppError> {
    match access(env) {
        Access::NoGit => Ok(false),
        Access::Ready(_) => Ok(true),
        Access::Failed(detail) => Err(AppError::Internal(format!(
            "custom history is unusable: {detail}"
        ))),
        Access::NotStarted => {
            let git = env
                .ctx
                .git
                .as_deref()
                .ok_or_else(|| AppError::Internal("git vanished".into()))?;
            fsx::check_plain(&env.custom, ".git")
                .map_err(|_| AppError::Internal("custom history is behind a link".into()))?;
            fs::create_dir_all(&env.custom)
                .map_err(|e| AppError::FileWriteFailed(e.to_string()))?;
            // 한 번 더 — 만든 폴더가 링크 위가 아닌지
            fsx::check_plain(&env.custom, ".git")
                .map_err(|_| AppError::Internal("custom history is behind a link".into()))?;
            let dot_git = env.custom.join(".git");
            if !dot_git.exists() {
                // 사용자 전역의 init 틀(hook 등)이 들어오지 않게 `--template=` (비움)
                run_in(
                    env,
                    git,
                    &env.custom,
                    &["-c", "init.defaultBranch=main", "init", "-q", "--template="],
                )
                .map_err(|e| internal(&e))?;
            }
            let ignore = env.custom.join(".gitignore");
            if !ignore.exists() {
                fsx::write_text(&env.custom, ".gitignore", GITIGNORE)
                    .map_err(|e| AppError::FileWriteFailed(format!("{e:?}")))?;
            }
            let repo = Repo { env, git };
            repo.run(&["add", "-A"]).map_err(|e| internal(&e))?;
            repo.commit(strings::CUSTOM_COMMIT_START, CommitKind::Start, true, None)
                .map_err(|e| internal(&e))?;
            Ok(true)
        }
    }
}

impl<'a> Repo<'a> {
    fn run(&self, args: &[&str]) -> Result<Captured, GitError> {
        run_in(self.env, self.git, &self.env.custom, args)
    }

    /// 커밋을 만든다 (`-m <한 줄>` + `-m Nyanitor-Kind: <종류>`). `only` 가 있으면 그 파일만 (`--only -- <파일>`). 짧은 번호를 돌려준다.
    pub fn commit(
        &self,
        subject: &str,
        kind: CommitKind,
        allow_empty: bool,
        only: Option<&str>,
    ) -> Result<String, GitError> {
        let marker = format!("{KIND_PREFIX} {}", kind.marker());
        let mut args: Vec<&str> = vec!["commit", "-q", "--no-verify"];
        if allow_empty {
            args.push("--allow-empty");
        }
        args.extend(["-m", subject, "-m", &marker]);
        if let Some(path) = only {
            args.extend(["--only", "--", path]);
        }
        self.run(&args)?;
        self.short_head()
    }

    /// 작업 트리의 모든 변경(새 파일 · 지운 파일 포함)을 인덱스에 올린다 (`git add -A`)
    pub fn stage_all(&self) -> Result<(), GitError> {
        self.run(&["add", "-A"])?;
        Ok(())
    }

    pub fn short_head(&self) -> Result<String, GitError> {
        let out = self.run(&["rev-parse", "--short=7", "HEAD"])?;
        Ok(out.stdout.trim().to_string())
    }

    /// `HEAD` 의 전체 번호
    fn head(&self) -> Result<String, GitError> {
        Ok(self.run(&["rev-parse", "HEAD"])?.stdout.trim().to_string())
    }

    /// 사용자가 보낸 커밋 번호(7~40글자 16진수)를 전체 번호로 — 그런 커밋이 없으면 `None`
    pub fn resolve(&self, hash: &str) -> Result<Option<String>, GitError> {
        let spec = format!("{hash}^{{commit}}");
        match self.run(&["rev-parse", "--verify", "--quiet", &spec]) {
            Ok(out) => {
                let full = out.stdout.trim().to_string();
                Ok((full.len() == 40).then_some(full))
            }
            // 없음 (1) · 모호함 (128 — "short object ID ... is ambiguous") 모두 "그런 커밋이 없다"
            Err(GitError::Exit {
                code: Some(1 | 128),
                ..
            }) => Ok(None),
            Err(error) => Err(error),
        }
    }

    // ───────────── 적용 안 한 것 ─────────────

    /// 적용 안 한 파일들 (상태 · 경로). 새 파일은 하나씩 (`-uall`).
    fn status_entries(&self) -> Result<Vec<(String, FileStatus, bool)>, GitError> {
        let out = self.run(&[
            "status",
            "--porcelain=v1",
            "-z",
            "-uall",
            "--no-renames",
            "--ignored=no",
        ])?;
        let mut entries = Vec::new();
        for record in out.stdout.split('\0') {
            if record.len() < 4 {
                continue;
            }
            let (code, path) = record.split_at(2);
            let path = path.trim_start_matches(' ');
            if path.is_empty() {
                continue;
            }
            let untracked = code == "??";
            let status = if untracked || code.contains('A') {
                FileStatus::Added
            } else if code.contains('D') {
                FileStatus::Removed
            } else {
                FileStatus::Changed
            };
            entries.push((path.to_string(), status, untracked));
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(entries)
    }

    pub fn unapplied(&self) -> Result<Unapplied, GitError> {
        let entries = self.status_entries()?;
        let count = entries.len() as u32;
        let files = entries
            .into_iter()
            .take(UNAPPLIED_FILES_MAX)
            .map(|(path, status, _)| UnappliedFile { path, status })
            .collect();
        Ok(Unapplied {
            known: true,
            count,
            files,
        })
    }

    /// 새로 생긴 에이전트 · 스킬 글 파일이 적용 안 한 것에 있는가 (`new` 커밋 종류를 정한다). `in_source` 는 원본에도 있는 경로인지 묻는다.
    pub fn adds_new_item(&self, in_source: &dyn Fn(&str) -> bool) -> Result<bool, GitError> {
        Ok(self.status_entries()?.iter().any(|(path, status, _)| {
            *status == FileStatus::Added && is_item_file(path) && !in_source(path)
        }))
    }

    /// 적용하면 바뀌는 것 — 줄 단위 차이
    pub fn unapplied_diff(&self) -> Result<(Vec<FileDiff>, u32), GitError> {
        let entries = self.status_entries()?;
        let total = entries.len() as u32;
        let tracked = self.run(&[
            "diff",
            "HEAD",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-U3",
        ])?;
        let mut files = parse_diff(&tracked.stdout);
        for (path, _, untracked) in &entries {
            if !untracked {
                continue;
            }
            files.push(self.new_file_diff(path));
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Ok((limit_diffs(files), total))
    }

    /// 새 파일(추적 안 함)의 차이 — 글 전체가 더해진 것으로 만든다
    fn new_file_diff(&self, path: &str) -> FileDiff {
        let skipped = |binary: bool| FileDiff {
            path: path.to_string(),
            status: FileStatus::Added,
            binary,
            lines: Vec::new(),
            truncated: false,
            added: 0,
            removed: 0,
        };
        match fsx::read_text(&self.env.custom, path) {
            Ok(Some(text)) => {
                let normalized = text.replace("\r\n", "\n");
                let body = normalized.strip_suffix('\n').unwrap_or(&normalized);
                let mut lines: Vec<DiffLine> = Vec::new();
                let count = if normalized.is_empty() {
                    0
                } else {
                    body.split('\n').count()
                };
                lines.push(DiffLine {
                    sign: '@',
                    text: format!("@@ -0,0 +1,{count} @@"),
                    old: None,
                    new: None,
                });
                if count > 0 {
                    for (index, line) in body.split('\n').enumerate() {
                        lines.push(DiffLine {
                            sign: '+',
                            text: cut_chars(line, DIFF_LINE_CHARS),
                            old: None,
                            new: Some(index as u32 + 1),
                        });
                    }
                }
                FileDiff {
                    path: path.to_string(),
                    status: FileStatus::Added,
                    binary: false,
                    lines,
                    truncated: false,
                    added: count as u32,
                    removed: 0,
                }
            }
            // 크거나 글이 아니거나 읽을 수 없다 — 줄 차이를 주지 않는다
            _ => skipped(true),
        }
    }

    /// 적용 안 한 것을 버린다 — 작업 트리 · 인덱스를 HEAD 로, 새 파일은 지운다 (`.git` · 무시한 임시 파일은 그대로). 버린 파일 수를 돌려준다.
    pub fn discard(&self) -> Result<u32, GitError> {
        let count = self.status_entries()?.len() as u32;
        if count == 0 {
            return Ok(0);
        }
        self.reset_to_head()?;
        Ok(count)
    }

    /// 작업 트리 · 인덱스를 HEAD 모습으로 (새 파일 포함)
    pub fn reset_to_head(&self) -> Result<(), GitError> {
        self.run(&["reset", "-q", "--hard", "HEAD"])?;
        self.run(&["clean", "-fdq"])?;
        Ok(())
    }

    // ───────────── 되돌리기 ─────────────

    /// 그 커밋의 모습이 HEAD 와 같은가 (내용 비교)
    pub fn same_as_head(&self, full: &str) -> Result<bool, GitError> {
        match self.run(&[
            "diff",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            full,
        ]) {
            Ok(_) => Ok(true),
            Err(GitError::Exit { code: Some(1), .. }) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// 작업 트리 · 인덱스를 그 커밋의 모습으로 (그 커밋에 없는 파일은 지운다, `HEAD` 는 그대로 — 이력을 지우지 않는다)
    pub fn checkout_tree(&self, full: &str) -> Result<(), GitError> {
        self.run(&["read-tree", "--reset", "-u", full])?;
        Ok(())
    }

    // ───────────── 기록 목록 ─────────────

    pub fn log(&self) -> Result<(Vec<CommitEntry>, bool), GitError> {
        let limit = format!("-n{}", LOG_MAX + 1);
        let out = self.run(&[
            "log",
            &limit,
            "--no-renames",
            "--name-only",
            "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f",
        ])?;
        let mut commits = parse_log(&out.stdout);
        let truncated = commits.len() > LOG_MAX;
        commits.truncate(LOG_MAX);
        Ok((commits, truncated))
    }

    /// 커밋 하나의 요약 (파일 이름 포함)
    fn entry(&self, full: &str) -> Result<Option<CommitEntry>, GitError> {
        let out = self.run(&[
            "log",
            "-n1",
            "--no-renames",
            "--name-only",
            "--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f",
            full,
        ])?;
        Ok(parse_log(&out.stdout).into_iter().next())
    }

    /// 커밋 하나의 차이
    pub fn commit_diff(
        &self,
        full: &str,
    ) -> Result<Option<(CommitEntry, Vec<FileDiff>, u32)>, GitError> {
        let Some(entry) = self.entry(full)? else {
            return Ok(None);
        };
        let out = self.run(&[
            "show",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--format=",
            "-U3",
            full,
        ])?;
        let files = parse_diff(&out.stdout);
        let total = files.len() as u32;
        Ok(Some((entry, limit_diffs(files), total)))
    }

    /// `git add -- <파일>` 하고 그 파일만 커밋한다 (다른 적용 안 한 것은 그대로). 바뀐 것이 없으면 `None`.
    pub fn commit_only(
        &self,
        path: &str,
        subject: &str,
        kind: CommitKind,
    ) -> Result<Option<String>, GitError> {
        self.run(&["add", "--", path])?;
        // 인덱스에 이 파일의 변경이 있는가 (`--cached` 로 HEAD 와 비교)
        match self.run(&["diff", "--cached", "--quiet", "--", path]) {
            Ok(_) => return Ok(None),
            Err(GitError::Exit { code: Some(1), .. }) => {}
            Err(error) => return Err(error),
        }
        self.commit(subject, kind, false, Some(path)).map(Some)
    }

    /// 전체 번호 → 짧은 번호 (7글자)
    pub fn short_of(&self, full: &str) -> String {
        full.chars().take(7).collect()
    }

    pub fn head_full(&self) -> Result<String, GitError> {
        self.head()
    }
}

/// 에이전트 · 스킬의 글 파일 경로인가 (`agents/<이름>.md` · `skills/<이름>/SKILL.md`)
fn is_item_file(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    match parts.as_slice() {
        ["agents", file] => file.strip_suffix(".md").is_some_and(super::id::valid_name),
        ["skills", name, "SKILL.md"] => super::id::valid_name(name),
        _ => false,
    }
}

fn cut_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

// ───────────────────────────── 차이 읽기 ─────────────────────────────

/// `git diff` · `git show` 의 출력에서 파일마다 줄 차이를 뽑는다 (`--no-renames` 라 이름 바꿈은 없다)
pub fn parse_diff(text: &str) -> Vec<FileDiff> {
    let mut files: Vec<FileDiff> = Vec::new();
    let mut in_hunk = false;
    let (mut old_line, mut new_line) = (0u32, 0u32);
    let mut minus_path: Option<String> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            in_hunk = false;
            minus_path = None;
            files.push(FileDiff {
                path: path_from_header(rest),
                status: FileStatus::Changed,
                binary: false,
                lines: Vec::new(),
                truncated: false,
                added: 0,
                removed: 0,
            });
            continue;
        }
        let Some(file) = files.last_mut() else {
            continue;
        };
        if !in_hunk {
            if line.starts_with("new file mode") {
                file.status = FileStatus::Added;
            } else if line.starts_with("deleted file mode") {
                file.status = FileStatus::Removed;
            } else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
                file.binary = true;
            } else if let Some(path) = line.strip_prefix("--- a/") {
                minus_path = Some(path.to_string());
            } else if let Some(path) = line.strip_prefix("+++ b/") {
                file.path = path.to_string();
            } else if line == "+++ /dev/null"
                && let Some(path) = minus_path.take()
            {
                file.path = path;
            }
        }
        if line.starts_with("@@ ") {
            in_hunk = true;
            (old_line, new_line) = hunk_starts(line);
            file.lines.push(DiffLine {
                sign: '@',
                text: cut_chars(line, DIFF_LINE_CHARS),
                old: None,
                new: None,
            });
            continue;
        }
        if !in_hunk {
            continue;
        }
        let mut chars = line.chars();
        match chars.next() {
            Some('+') => {
                file.added += 1;
                file.lines.push(DiffLine {
                    sign: '+',
                    text: cut_chars(chars.as_str(), DIFF_LINE_CHARS),
                    old: None,
                    new: Some(new_line),
                });
                new_line += 1;
            }
            Some('-') => {
                file.removed += 1;
                file.lines.push(DiffLine {
                    sign: '-',
                    text: cut_chars(chars.as_str(), DIFF_LINE_CHARS),
                    old: Some(old_line),
                    new: None,
                });
                old_line += 1;
            }
            Some(' ') => {
                file.lines.push(DiffLine {
                    sign: ' ',
                    text: cut_chars(chars.as_str(), DIFF_LINE_CHARS),
                    old: Some(old_line),
                    new: Some(new_line),
                });
                old_line += 1;
                new_line += 1;
            }
            // `\ No newline at end of file` 등
            _ => {}
        }
    }
    files
}

/// `diff --git a/<경로> b/<경로>` 의 경로 (이름 바꿈이 없어 두 경로가 같다)
fn path_from_header(rest: &str) -> String {
    if let Some(both) = rest.strip_prefix("a/") {
        // `<경로> b/<경로>` — 가운데 ` b/` 를 기준으로 반으로 나눈다
        let mid = (both.len().saturating_sub(3)) / 2;
        if both.is_char_boundary(mid) {
            return both[..mid].to_string();
        }
    }
    rest.to_string()
}

/// `@@ -a,b +c,d @@` 의 시작 줄 번호 둘
fn hunk_starts(line: &str) -> (u32, u32) {
    let mut old = 1;
    let mut new = 1;
    for part in line.split_whitespace() {
        let number = |prefix: char| {
            part.strip_prefix(prefix)
                .and_then(|rest| rest.split(',').next())
                .and_then(|n| n.parse::<u32>().ok())
        };
        if let Some(n) = number('-') {
            old = n;
        } else if let Some(n) = number('+') {
            new = n;
        }
    }
    (old, new)
}

/// 상한을 지켜 자른다 — 파일 수 · 파일마다 줄 수 · 전체 줄 수
fn limit_diffs(mut files: Vec<FileDiff>) -> Vec<FileDiff> {
    files.truncate(DIFF_FILES_MAX);
    let mut budget = DIFF_LINES_TOTAL;
    for file in &mut files {
        let allowed = DIFF_LINES_PER_FILE.min(budget);
        if file.lines.len() > allowed {
            file.lines.truncate(allowed);
            file.truncated = true;
        }
        budget -= file.lines.len();
    }
    files
}

// ───────────────────────────── 기록 목록 읽기 ─────────────────────────────

/// `git log --format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f --name-only` 의 출력 → 커밋들 (최신이 먼저)
pub fn parse_log(text: &str) -> Vec<CommitEntry> {
    let mut out = Vec::new();
    for record in text.split('\u{1e}') {
        let mut fields = record.splitn(5, '\u{1f}');
        let (Some(hash), Some(date), Some(subject), Some(body), Some(names)) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            continue;
        };
        let hash = hash.trim();
        if hash.len() != 40 {
            continue;
        }
        let kind = body
            .lines()
            .rev()
            .find_map(|line| line.trim().strip_prefix(KIND_PREFIX))
            .map_or(CommitKind::Other, CommitKind::from_marker);
        let all: Vec<&str> = names
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        out.push(CommitEntry {
            hash: hash.to_string(),
            short: hash.chars().take(7).collect(),
            date: date.trim().to_string(),
            message: subject.trim().to_string(),
            kind,
            files_total: all.len() as u32,
            files: all
                .into_iter()
                .take(COMMIT_FILES_MAX)
                .map(str::to_string)
                .collect(),
        });
    }
    out
}

/// 사용자가 보낸 커밋 번호의 모양 (7~40글자 16진수 소문자)
pub fn valid_commit_ref(text: &str) -> bool {
    (7..=40).contains(&text.len())
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// 커밋 메시지로 쓸 한 줄 — 제어 문자(줄바꿈 · 탭 포함)는 공백으로, 공백이 이어지면 하나로, 앞뒤를 다듬고 200자 안쪽으로 자른다.
/// 비면 `None` (부르는 쪽이 기본 문구를 쓴다).
pub fn clean_message(text: &str) -> Option<String> {
    let spaced: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = spaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = collapsed.chars().take(MESSAGE_MAX_CHARS).collect();
    let cut = cut.trim_end().to_string();
    (!cut.is_empty()).then_some(cut)
}

/// 원본 업데이트 받음 기록 (D-51) — 업데이트 받기가 원본을 바꿨고 내 수정 기록이 시작돼 있으면 빈 커밋 하나. 실패해도 업데이트 결과는 그대로 (로그만).
pub fn record_origin_update(ctx: &crate::harness::Context, source_short: &str) {
    let env = Env::new(ctx);
    let Access::Ready(repo) = access(&env) else {
        return;
    };
    let subject = strings::custom_commit_origin_update(source_short);
    if let Err(error) = repo.commit(&subject, CommitKind::OriginUpdate, true, None) {
        log::warn!(
            "custom: could not record the origin update: {}",
            describe(&error)
        );
    }
}

/// 기록 목록 (읽기만 한다)
pub fn list(env: &Env) -> HistoryList {
    match access(env) {
        Access::Ready(repo) => match repo.log() {
            Ok((commits, truncated)) => HistoryList {
                state: HistoryState::Ok,
                detail: None,
                commits,
                truncated,
            },
            Err(error) => HistoryList {
                state: HistoryState::Failed,
                detail: Some(describe(&error)),
                commits: Vec::new(),
                truncated: false,
            },
        },
        other => {
            let HistoryInfo { state, detail } = info(&other);
            HistoryList {
                state,
                detail,
                commits: Vec::new(),
                truncated: false,
            }
        }
    }
}

/// 커밋 하나의 차이 (읽기만 한다)
pub fn commit_diff(env: &Env, hash: &str) -> Result<CommitDiff, AppError> {
    if !valid_commit_ref(hash) {
        return Err(AppError::InvalidInput(
            "commit id has the wrong shape".into(),
        ));
    }
    Ok(match access(env) {
        Access::NoGit => CommitDiff::NoGit,
        Access::NotStarted => CommitDiff::NotStarted,
        Access::Failed(detail) => CommitDiff::Failed { detail },
        Access::Ready(repo) => {
            let found = repo.resolve(hash).and_then(|full| match full {
                Some(full) => repo.commit_diff(&full),
                None => Ok(None),
            });
            match found {
                Ok(Some((commit, files, files_total))) => CommitDiff::Ok {
                    commit,
                    files,
                    files_total,
                },
                Ok(None) => CommitDiff::UnknownCommit,
                Err(error) => CommitDiff::Failed {
                    detail: describe(&error),
                },
            }
        }
    })
}

/// 적용 안 한 것의 요약 (읽기만 한다). git 이 없거나 부르지 못하면 `known: false`, 기록이 없으면 `0`.
pub fn unapplied_of(access: &Access) -> Unapplied {
    match access {
        Access::Ready(repo) => repo.unapplied().unwrap_or_else(|error| {
            log::warn!(
                "custom: could not read the unapplied files: {}",
                describe(&error)
            );
            Unapplied::unknown()
        }),
        Access::NotStarted => Unapplied::none(),
        Access::NoGit | Access::Failed(_) => Unapplied::unknown(),
    }
}

/// 하네스 폴더 안의 내 수정 폴더 (`<하네스 폴더>/custom`)
pub fn custom_dir(ctx: &crate::harness::Context) -> PathBuf {
    ctx.locations.harness_home.join("custom")
}

/// 적용하면 바뀌는 것 — 적용 안 한 것의 줄 단위 차이 (읽기만 한다)
pub fn changes(env: &Env) -> super::model::ChangesList {
    use super::model::ChangesList;
    match access(env) {
        Access::Ready(repo) => match repo.unapplied_diff() {
            Ok((files, files_total)) => ChangesList {
                state: HistoryState::Ok,
                detail: None,
                files,
                files_total,
            },
            Err(error) => ChangesList {
                state: HistoryState::Failed,
                detail: Some(describe(&error)),
                files: Vec::new(),
                files_total: 0,
            },
        },
        other => {
            let HistoryInfo { state, detail } = info(&other);
            ChangesList {
                state,
                detail,
                files: Vec::new(),
                files_total: 0,
            }
        }
    }
}
