//! macOS · Linux 에서 `claude` (와 그것이 부르는 `node`) 를 찾는 `PATH` (P11-08).
//!
//! Finder · Dock · 앱 메뉴로 연 앱의 환경 `PATH` 는 `/usr/bin:/bin:/usr/sbin:/sbin` 정도뿐이다 (터미널의 `~/.zprofile` · `~/.zshrc` 를 읽지 않는다).
//! 그래서 Homebrew · npm 전역 · nvm · volta · bun 으로 설치한 `claude` 를 찾지 못하고, 찾아도 `#!/usr/bin/env node` 의 `node` 를 못 찾는다.
//! 이 모듈이 쓸 `PATH` 를 한 번 만들어 두고 **찾기**(`discover::locate_here`)와 **자식에게 넘기기**(`ClaudeCommand::command`)가 같은 값을 쓰게 한다.
//!
//! 만드는 법 (순서대로 이어 붙이고 중복은 앞의 것만 남긴다):
//! 1. 사용자의 로그인 셸에게 `PATH` 를 묻는다 (`$SHELL -i -l -c '<표지 사이에 PATH 를 찍는 명령>'`). 셸 설정 파일을 읽어 해석하지 않는다 — 셸이 알려 주는 값만 쓴다.
//! 2. 이 프로세스의 지금 `PATH`
//! 3. 알려진 설치 자리 중 **있는 폴더** (`known_dirs`) — 셸이 못 답했거나 답이 모자랄 때를 위해 뒤에 붙인다
//!
//! 한 번만 묻는다: 앱이 뜰 때 백그라운드에서 미리 읽고 (`prefetch`), 그 전에 먼저 쓰는 곳이 있으면 끝날 때까지 기다린다 (최대 `ASK_TIMEOUT`).
//! `claude` 를 못 찾았을 때만 (사용자가 설치하거나 셸 설정을 고치고 "다시 확인" 을 누른 경우) 다시 묻는다 (`refresh_after_miss`, 10초에 한 번까지).
//!
//! Windows 는 이 모듈이 아무것도 바꾸지 않는다 (`search_path` 는 환경의 `PATH` 그대로, `with_search_path` 는 받은 환경 그대로).
//! 표지 읽기 · 값 검사 · 합치기 · 대체 자리 고르기는 OS 와 무관한 순수 함수라 어디서나 시험이 돈다. 셸을 실제로 띄우는 것만 `cfg(unix)`.
//!
//! 로그에는 어디서 왔는지 (셸 · 대체 자리 · 시간 초과) 와 칸 수만 남긴다 — `PATH` 값에는 홈 경로 · 사용자 이름이 들어 있다.
#![cfg_attr(not(unix), allow(dead_code))]

use std::ffi::OsString;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// 셸에게 시키는 명령이 `PATH` 를 이 두 표지 사이에 찍는다 — rc 파일이 찍는 다른 글 · 색 코드는 버린다.
pub const MARK_START: &str = "__NYA_PATH_START__";
pub const MARK_END: &str = "__NYA_PATH_END__";
/// `sh` 계열(`sh` · `bash` · `zsh` · `dash`)이 읽는 명령. fish · nu 는 `${PATH}` 문법이 달라 표지가 안 나오고, 그러면 대체 자리로 간다.
pub const PROBE_SCRIPT: &str = r#"printf '%s' "__NYA_PATH_START__${PATH}__NYA_PATH_END__""#;

/// 셸이 답하기를 기다리는 최대 시간 — 넘으면 프로세스 트리를 끄고 대체 자리로 간다.
pub const ASK_TIMEOUT: Duration = Duration::from_secs(5);
/// 이 값보다 긴 `PATH` 는 이상한 값으로 보고 버린다 (정상 `PATH` 는 보통 1KB 안쪽).
const MAX_PATH_BYTES: usize = 16 * 1024;
/// 못 찾았을 때 셸에게 다시 묻는 최소 간격 — 못 찾음이 되풀이돼도 셸을 계속 띄우지 않는다.
const MIN_REFRESH_AGE: Duration = Duration::from_secs(10);

// ───────────────────────────── 순수 함수 (OS 무관) ─────────────────────────────

/// 셸 출력에서 표지 사이의 글. 표지가 여럿이면 **끝 쪽** 쌍을 쓴다 (명령은 rc 파일이 다 돈 뒤에 찍으므로 앞의 것은 rc 의 잡글이다).
/// 시작 표지 뒤에 끝 표지가 없는 것은 건너뛴다 (잘린 출력). 표지가 없으면 `None`.
pub fn extract_marked(output: &str) -> Option<&str> {
    output.rmatch_indices(MARK_START).find_map(|(at, _)| {
        let rest = &output[at + MARK_START.len()..];
        rest.find(MARK_END).map(|end| &rest[..end])
    })
}

/// 절대 경로 칸만 남긴다 (`/` 로 시작). 상대 칸 (`.` · 빈 칸) 과 UTF-8 이 아니어서 깨진 칸은 버리고, 끝의 `/` 는 떼고, 같은 칸은 앞의 것만 남긴다.
/// `locate` 가 상대 칸을 건너뛰는 규칙과 같다.
pub fn absolute_entries(path: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in path.split(':') {
        if !entry.starts_with('/') || entry.contains('\u{FFFD}') {
            continue;
        }
        let entry = match entry.trim_end_matches('/') {
            "" => "/",
            trimmed => trimmed,
        };
        if !out.iter().any(|seen| seen == entry) {
            out.push(entry.to_string());
        }
    }
    out
}

/// 셸이 찍어 준 `PATH` 글을 검사해 칸 목록으로. 이상하면 `None` (그러면 셸 답을 쓰지 않는다):
/// 아주 긴 값 · 제어 문자(줄바꿈 · 색 코드 · NUL) 가 섞인 값 · 절대 경로 칸이 하나도 없는 값 (빈 값 포함).
pub fn parse_shell_path(raw: &str) -> Option<Vec<String>> {
    if raw.len() > MAX_PATH_BYTES || raw.chars().any(char::is_control) {
        return None;
    }
    let entries = absolute_entries(raw);
    (!entries.is_empty()).then_some(entries)
}

/// 칸 목록들을 순서대로 이어 붙이고 같은 칸은 먼저 나온 것만 남긴다.
pub fn merge_paths(groups: &[&[String]]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in groups.iter().flat_map(|group| group.iter()) {
        if !out.contains(entry) {
            out.push(entry.clone());
        }
    }
    out
}

/// Claude Code 를 설치하는 알려진 자리 (홈 아래 것은 `home` 이 있을 때만). 우선순위 순서.
/// - `/opt/homebrew/bin` (Apple Silicon) · `/usr/local/bin` (Intel Homebrew · 수동 설치) — `brew install --cask claude-code` 가 `claude` 를 여기에 링크한다
/// - `~/.local/bin` — 공식 설치 스크립트(native installer)의 `claude`
/// - `~/.npm-global/bin` · `~/.bun/bin` · `~/.volta/bin` — npm 전역 설치의 흔한 `prefix` · bun · volta (`node` 도 같이 있다)
/// - `~/.claude/local` — 옛 `claude migrate-installer` 의 지역 설치
pub fn known_dirs(home: Option<&str>) -> Vec<String> {
    let mut dirs = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    if let Some(home) = home
        .map(|h| h.trim_end_matches('/'))
        .filter(|h| h.starts_with('/'))
    {
        for tail in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
            ".claude/local",
        ] {
            dirs.push(format!("{home}/{tail}"));
        }
    }
    dirs
}

/// `known_dirs` 중 `is_dir` 이 참인 것만 (없는 폴더는 `PATH` 에 넣지 않는다).
pub fn existing_known_dirs(home: Option<&str>, is_dir: impl Fn(&str) -> bool) -> Vec<String> {
    known_dirs(home)
        .into_iter()
        .filter(|dir| is_dir(dir))
        .collect()
}

/// 어디서 온 값인가 (로그용)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// 로그인 셸이 알려 준 `PATH` 를 앞에 붙였다
    LoginShell,
    /// 셸에게 묻지 않았다 (터미널에서 띄운 앱 — 이미 터미널의 `PATH` 를 물려받았다)
    Inherited,
    /// 셸이 답하지 못했다 (시작 실패 · 시간 초과 · 이상한 답) — 지금 `PATH` 에 대체 자리를 붙였다
    Fallback,
}

/// 쓸 `PATH` 의 칸들
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    dirs: Vec<String>,
    source: Source,
}

impl Resolved {
    /// 셸 답 (없으면 `None`) · 지금 `PATH` 의 칸 · 있는 대체 자리를 합친다. 순서: 셸 → 지금 → 대체.
    pub fn new(
        shell: Option<&[String]>,
        current: &[String],
        known: &[String],
        source_if_no_shell: Source,
    ) -> Self {
        let dirs = merge_paths(&[shell.unwrap_or(&[]), current, known]);
        Self {
            dirs,
            source: if shell.is_some() {
                Source::LoginShell
            } else {
                source_if_no_shell
            },
        }
    }

    pub fn dirs(&self) -> &[String] {
        &self.dirs
    }

    pub fn source(&self) -> Source {
        self.source
    }

    /// `PATH` 환경 변수 값 (유닉스 구분자 `:`)
    pub fn path_var(&self) -> OsString {
        OsString::from(self.dirs.join(":"))
    }
}

/// 환경 목록의 `PATH` 를 `path` 로 바꾼다 (같은 이름이 둘이면 첫 것만 남기고, 없으면 끝에 더한다). 다른 변수는 그대로 · 순서도 그대로.
/// 유닉스의 변수 이름은 대소문자를 가리므로 `PATH` 만 본다.
pub fn replace_path_var(
    env: Vec<(OsString, OsString)>,
    path: &OsString,
) -> Vec<(OsString, OsString)> {
    let mut out = Vec::with_capacity(env.len() + 1);
    let mut replaced = false;
    for (name, value) in env {
        if name == "PATH" {
            if !replaced {
                replaced = true;
                out.push((name, path.clone()));
            }
        } else {
            out.push((name, value));
        }
    }
    if !replaced {
        out.push((OsString::from("PATH"), path.clone()));
    }
    out
}

/// `$SHELL` 이 절대 경로이고 실행할 수 있는 파일이면 그것, 아니면 `default`. 제어 문자가 든 값은 쓰지 않는다.
pub fn pick_shell(
    shell_var: Option<&str>,
    is_executable: impl Fn(&str) -> bool,
    default: &str,
) -> String {
    shell_var
        .filter(|shell| {
            shell.starts_with('/') && !shell.chars().any(char::is_control) && is_executable(shell)
        })
        .unwrap_or(default)
        .to_string()
}

// ───────────────────────────── 한 번만 기억 ─────────────────────────────

struct Slot {
    resolved: Arc<Resolved>,
    at: Instant,
}

/// 만든 `PATH` 를 기억한다. 만드는 동안 `Mutex` 를 쥐고 있어서 같은 때 온 다른 호출은 끝나기를 기다렸다 같은 값을 받는다 (셸을 둘 띄우지 않는다).
/// 만드는 쪽(`probe`)은 이 기억을 다시 부르면 안 된다 (같은 `Mutex` 를 두 번 잡는다).
pub struct PathCache {
    slot: Mutex<Option<Slot>>,
}

impl PathCache {
    pub const fn new() -> Self {
        Self {
            slot: Mutex::new(None),
        }
    }

    /// 기억한 값, 없으면 `probe` 로 만들어 기억한다.
    pub fn get(&self, probe: impl FnOnce() -> Resolved) -> Arc<Resolved> {
        let mut slot = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(slot) = slot.as_ref() {
            return slot.resolved.clone();
        }
        let resolved = Arc::new(probe());
        *slot = Some(Slot {
            resolved: resolved.clone(),
            at: Instant::now(),
        });
        resolved
    }

    /// 기억한 지 `min_age` 가 지났으면 `probe` 로 다시 만들어 바꾸고 그 값을 준다. 아직 이르면 `None` (아무것도 하지 않는다).
    pub fn refresh(
        &self,
        min_age: Duration,
        probe: impl FnOnce() -> Resolved,
    ) -> Option<Arc<Resolved>> {
        let mut slot = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        if slot
            .as_ref()
            .is_some_and(|slot| slot.at.elapsed() < min_age)
        {
            return None;
        }
        let resolved = Arc::new(probe());
        *slot = Some(Slot {
            resolved: resolved.clone(),
            at: Instant::now(),
        });
        Some(resolved)
    }
}

impl Default for PathCache {
    fn default() -> Self {
        Self::new()
    }
}

/// 앱 전체가 쓰는 기억
#[cfg(unix)]
static CACHE: PathCache = PathCache::new();

// ───────────────────────────── 앞에서 쓰는 곳 ─────────────────────────────

/// `locate` 에 넘길 `PATH`. 유닉스는 합친 값, Windows 는 환경의 `PATH` 그대로.
pub fn search_path() -> Option<OsString> {
    #[cfg(unix)]
    {
        Some(unix::current().path_var())
    }
    #[cfg(not(unix))]
    {
        std::env::var_os("PATH")
    }
}

/// 자식에게 줄 환경에 합친 `PATH` 를 얹는다. 유닉스만 바꾸고 (합친 칸이 비었으면 그대로), Windows 는 받은 환경 그대로.
pub fn with_search_path(env: Vec<(OsString, OsString)>) -> Vec<(OsString, OsString)> {
    #[cfg(unix)]
    {
        let resolved = unix::current();
        if resolved.dirs().is_empty() {
            return env;
        }
        replace_path_var(env, &resolved.path_var())
    }
    #[cfg(not(unix))]
    {
        env
    }
}

/// `claude` 를 못 찾았을 때 부른다 — 셸에게 `PATH` 를 다시 물었으면 `true` (그러면 한 번 더 찾아 볼 만하다).
/// 마지막으로 읽은 지 10초가 안 됐으면 묻지 않고 `false`. Windows 는 언제나 `false`.
pub fn refresh_after_miss() -> bool {
    #[cfg(unix)]
    {
        unix::refresh()
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// 앱이 뜰 때 백그라운드에서 미리 읽어 둔다 (첫 화면이 셸을 기다리지 않게). 앱 전용 작업 폴더 (`workdir::init`) 가 정해진 뒤에 부른다.
pub fn prefetch() {
    #[cfg(unix)]
    {
        let spawned = std::thread::Builder::new()
            .name("shell-path".into())
            .spawn(|| {
                let _ = unix::current();
            });
        if let Err(err) = spawned {
            tauri_plugin_log::log::warn!("could not start the shell PATH read: {err}");
        }
    }
}

// ───────────────────────────── 셸 띄우기 (유닉스만) ─────────────────────────────

#[cfg(unix)]
mod unix {
    use std::ffi::OsStr;
    use std::fs::{self, File};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    use tauri_plugin_log::log;

    use super::{
        ASK_TIMEOUT, CACHE, MIN_REFRESH_AGE, PROBE_SCRIPT, Resolved, Source, absolute_entries,
        existing_known_dirs, extract_marked, parse_shell_path, pick_shell,
    };
    use crate::claude::exec::ClaudeCommand;

    /// 셸이 답하지 못한 까닭 (로그용 — 화면에 보이지 않는다)
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum AskError {
        /// 셸을 띄우지 못했다 (없는 파일 · 권한 · 작업 폴더를 못 만듦)
        Spawn,
        /// 시간 안에 답이 없었다
        TimedOut,
        /// 답은 있었는데 표지가 없거나 값이 이상하다 (fish · nu 의 다른 문법, rc 파일이 `exit` 한 경우 등)
        Unusable,
    }

    impl AskError {
        fn label(self) -> &'static str {
            match self {
                Self::Spawn => "could not start",
                Self::TimedOut => "timed out",
                Self::Unusable => "no usable PATH in the answer",
            }
        }
    }

    pub fn current() -> Arc<Resolved> {
        CACHE.get(resolve)
    }

    pub fn refresh() -> bool {
        CACHE.refresh(MIN_REFRESH_AGE, resolve).is_some()
    }

    /// 로그인 셸의 기본 위치 — `$SHELL` 이 없거나 쓸 수 없을 때
    fn default_shell() -> &'static str {
        if cfg!(target_os = "macos") {
            "/bin/zsh"
        } else {
            "/bin/sh"
        }
    }

    fn is_executable_file(path: &str) -> bool {
        fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }

    /// 이 프로세스에 제어 터미널이 있는가 (`/dev/tty` 가 열리면 있다) — 터미널에서 띄운 앱.
    /// 이때는 셸에게 묻지 않는다: 이미 터미널의 `PATH` 를 물려받았고, 대화형 셸은 새 프로세스 그룹에서 터미널을 잡으려다
    /// SIGTTIN 으로 멈춘다 (WSL 에서 `bash -i` 가 제어 터미널이 있는 새 프로세스 그룹에서 멈추는 것을 확인했다).
    /// 데스크톱 메뉴 · Finder · Dock 으로 띄운 앱은 제어 터미널이 없다.
    fn has_controlling_terminal() -> bool {
        File::options()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .is_ok()
    }

    /// `shell -i -l -c script` 를 돌려 표지 사이의 `PATH` 를 읽는다.
    /// 환경은 `exec::clean_env` 로 정리한 지금 환경 (API 키 같은 것을 셸 설정 파일에 보이지 않는다), 작업 폴더는 앱 전용 빈 폴더, stdin 은 null,
    /// 시간이 넘으면 프로세스 트리를 끈다 (`ClaudeCommand::run_capture`). `ClaudeCommand::with_base_env` 를 주므로 `PATH` 합치기를 다시 부르지 않는다.
    pub fn ask(shell: &str, script: &str, timeout: Duration) -> Result<Vec<String>, AskError> {
        let cmd = ClaudeCommand::new(shell).with_base_env(std::env::vars_os().collect());
        let captured = cmd
            .run_capture(["-i", "-l", "-c", script], timeout)
            .map_err(|_| AskError::Spawn)?;
        // 표지가 나왔으면 시간이 넘었어도 (셸이 끝내다 멈춘 경우) 값은 온전하다
        match extract_marked(&captured.stdout).and_then(parse_shell_path) {
            Some(entries) => Ok(entries),
            None if captured.timed_out => Err(AskError::TimedOut),
            None => Err(AskError::Unusable),
        }
    }

    pub fn resolve() -> Resolved {
        let current = std::env::var_os("PATH")
            .map(|path| absolute_entries(&path.to_string_lossy()))
            .unwrap_or_default();
        let home = std::env::home_dir();
        let known = existing_known_dirs(home.as_deref().and_then(Path::to_str), |dir| {
            Path::new(dir).is_dir()
        });
        let (shell_answer, source) = if has_controlling_terminal() {
            log::info!("shell PATH: started from a terminal, using the inherited PATH");
            (None, Source::Inherited)
        } else {
            let shell_var = std::env::var_os("SHELL");
            let shell = pick_shell(
                shell_var.as_deref().and_then(OsStr::to_str),
                is_executable_file,
                default_shell(),
            );
            match ask(&shell, PROBE_SCRIPT, ASK_TIMEOUT) {
                Ok(entries) => (Some(entries), Source::LoginShell),
                Err(err) => {
                    log::warn!(
                        "shell PATH: the login shell {}; using the known folders",
                        err.label()
                    );
                    (None, Source::Fallback)
                }
            }
        };
        let resolved = Resolved::new(shell_answer.as_deref(), &current, &known, source);
        match resolved.source() {
            Source::LoginShell => log::info!(
                "shell PATH: read from the login shell ({} entries)",
                resolved.dirs().len()
            ),
            Source::Inherited | Source::Fallback => log::info!(
                "shell PATH: {} entries (current PATH + known folders that exist)",
                resolved.dirs().len()
            ),
        }
        resolved
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_real_login_shell_prints_its_path_between_the_marks() {
            // 어느 OS 에나 있는 `/bin/sh` 로 `-i -l -c` 가 정말 돌고 표지 사이의 PATH 를 읽는지 본다.
            // 제어 터미널이 있으면 (개발자가 터미널에서 `cargo test`) 대화형 셸이 멈춘다 — 앱도 그때는 묻지 않으므로 시험도 넘어간다.
            if has_controlling_terminal() {
                return;
            }
            let entries = ask("/bin/sh", PROBE_SCRIPT, Duration::from_secs(20))
                .expect("/bin/sh should answer");
            assert!(entries.iter().all(|entry| entry.starts_with('/')));
            assert!(
                entries
                    .iter()
                    .any(|entry| entry == "/usr/bin" || entry == "/bin"),
                "{entries:?}"
            );
        }

        #[test]
        fn a_shell_that_runs_too_long_times_out_and_is_stopped() {
            let started = std::time::Instant::now();
            let err = ask("/bin/sh", "sleep 30", Duration::from_millis(500)).unwrap_err();
            assert_eq!(err, AskError::TimedOut);
            assert!(started.elapsed() < Duration::from_secs(10));
        }

        #[test]
        fn an_answer_without_the_marks_is_unusable() {
            if has_controlling_terminal() {
                return;
            }
            let err = ask("/bin/sh", "echo hello", Duration::from_secs(20)).unwrap_err();
            assert_eq!(err, AskError::Unusable);
        }

        #[test]
        fn a_missing_shell_is_a_spawn_error() {
            let err = ask("/no/such/shell", PROBE_SCRIPT, Duration::from_secs(5)).unwrap_err();
            assert_eq!(err, AskError::Spawn);
        }
    }
}

// ───────────────────────────── 시험 (순수 함수 · 기억 · 환경 바꾸기) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    // ───────── 표지 읽기 ─────────

    #[test]
    fn the_text_between_the_marks_is_read_and_noise_around_it_is_dropped() {
        let out = format!(
            "Welcome!\n\u{1b}[32mcolor\u{1b}[0m\nLast login: x\n{MARK_START}/opt/homebrew/bin:/usr/bin{MARK_END}trailing\n"
        );
        assert_eq!(extract_marked(&out), Some("/opt/homebrew/bin:/usr/bin"));
        // 표지만 있고 안이 비어도 "빈 글" 로 읽힌다 (값 검사가 버린다)
        assert_eq!(extract_marked(&format!("{MARK_START}{MARK_END}")), Some(""));
    }

    #[test]
    fn no_marks_or_half_a_mark_is_none() {
        assert_eq!(extract_marked(""), None);
        assert_eq!(extract_marked("/usr/bin:/bin"), None);
        assert_eq!(extract_marked(&format!("{MARK_START}/usr/bin")), None);
        assert_eq!(extract_marked(&format!("/usr/bin{MARK_END}")), None);
        // 끝 표지가 시작 표지보다 앞에만 있다
        assert_eq!(
            extract_marked(&format!("{MARK_END}/usr/bin{MARK_START}")),
            None
        );
    }

    #[test]
    fn two_pairs_use_the_last_one_because_the_real_answer_comes_after_the_rc_files() {
        let out = format!(
            "{MARK_START}/fake/from-rc{MARK_END}\nmore noise\n{MARK_START}/real/path:/usr/bin{MARK_END}"
        );
        assert_eq!(extract_marked(&out), Some("/real/path:/usr/bin"));
        // 마지막 시작 표지가 잘려 있으면 그 앞의 온전한 쌍을 쓴다
        let cut = format!("{MARK_START}/first{MARK_END}{MARK_START}/second");
        assert_eq!(extract_marked(&cut), Some("/first"));
    }

    #[test]
    fn the_probe_script_prints_exactly_the_marks_around_path() {
        assert!(PROBE_SCRIPT.contains(&format!("{MARK_START}${{PATH}}{MARK_END}")));
        // 작은따옴표 · 큰따옴표 짝이 맞는다 (셸이 문법 오류로 읽지 않게)
        assert_eq!(PROBE_SCRIPT.matches('\'').count() % 2, 0);
        assert_eq!(PROBE_SCRIPT.matches('"').count() % 2, 0);
    }

    // ───────── 값 검사 ─────────

    #[test]
    fn a_normal_path_becomes_its_absolute_entries() {
        assert_eq!(
            parse_shell_path("/opt/homebrew/bin:/usr/bin:/bin"),
            Some(strings(&["/opt/homebrew/bin", "/usr/bin", "/bin"]))
        );
    }

    #[test]
    fn empty_and_all_relative_values_are_refused() {
        assert_eq!(parse_shell_path(""), None);
        assert_eq!(parse_shell_path(":"), None);
        assert_eq!(parse_shell_path(".:bin:./x:../y"), None);
        // fish 가 `${PATH}` 를 못 읽고 글자 그대로 남긴 경우 · 변수 이름이 그대로 남은 경우
        assert_eq!(parse_shell_path("${PATH}"), None);
        assert_eq!(parse_shell_path("$PATH"), None);
    }

    #[test]
    fn relative_and_empty_entries_are_dropped_but_the_absolute_ones_stay() {
        assert_eq!(
            parse_shell_path(".::/usr/bin:bin:/bin:"),
            Some(strings(&["/usr/bin", "/bin"]))
        );
    }

    #[test]
    fn values_with_control_characters_are_refused() {
        for bad in [
            "/usr/bin\n/bin",
            "/usr/bin:\u{1b}[0m/bin",
            "/usr/bin\r:/bin",
            "/usr/bin:/b\0in",
            "\t/usr/bin",
        ] {
            assert_eq!(parse_shell_path(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_very_long_value_is_refused_but_a_value_just_under_the_limit_is_fine() {
        let entry =
            "/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let long = std::iter::repeat_n(entry, MAX_PATH_BYTES / entry.len() + 2)
            .collect::<Vec<_>>()
            .join(":");
        assert!(long.len() > MAX_PATH_BYTES);
        assert_eq!(parse_shell_path(&long), None);
        let ok = format!("/usr/bin:{}", "/x".repeat(100));
        assert!(parse_shell_path(&ok).is_some());
    }

    #[test]
    fn duplicates_and_trailing_slashes_are_folded() {
        assert_eq!(
            absolute_entries("/usr/bin/:/usr/bin:/bin//:/bin:/"),
            strings(&["/usr/bin", "/bin", "/"])
        );
    }

    #[test]
    fn korean_and_space_entries_are_kept_and_broken_ones_are_dropped() {
        assert_eq!(
            absolute_entries("/Users/내 이름/.bun/bin:/bad\u{FFFD}dir:/usr/bin"),
            strings(&["/Users/내 이름/.bun/bin", "/usr/bin"])
        );
    }

    // ───────── 합치기 ─────────

    #[test]
    fn merging_puts_the_shell_path_first_and_keeps_the_first_of_each_duplicate() {
        let shell = strings(&["/opt/homebrew/bin", "/usr/bin", "/Users/me/.nvm/bin"]);
        let current = strings(&["/usr/bin", "/bin", "/opt/homebrew/bin"]);
        let known = strings(&["/usr/local/bin", "/bin"]);
        assert_eq!(
            merge_paths(&[&shell, &current, &known]),
            strings(&[
                "/opt/homebrew/bin",
                "/usr/bin",
                "/Users/me/.nvm/bin",
                "/bin",
                "/usr/local/bin"
            ])
        );
    }

    #[test]
    fn merging_nothing_gives_nothing() {
        assert!(merge_paths(&[]).is_empty());
        assert!(merge_paths(&[&[], &[]]).is_empty());
    }

    #[test]
    fn resolved_orders_shell_then_current_then_known_and_remembers_the_source() {
        let shell = strings(&["/opt/homebrew/bin"]);
        let current = strings(&["/usr/bin", "/bin"]);
        let known = strings(&["/usr/local/bin"]);
        let with_shell = Resolved::new(Some(shell.as_slice()), &current, &known, Source::Fallback);
        assert_eq!(
            with_shell.dirs(),
            strings(&["/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/local/bin"])
        );
        assert_eq!(with_shell.source(), Source::LoginShell);
        assert_eq!(
            with_shell.path_var(),
            OsString::from("/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin")
        );
        let without = Resolved::new(None, &current, &known, Source::Fallback);
        assert_eq!(
            without.dirs(),
            strings(&["/usr/bin", "/bin", "/usr/local/bin"])
        );
        assert_eq!(without.source(), Source::Fallback);
        assert_eq!(
            Resolved::new(None, &current, &known, Source::Inherited).source(),
            Source::Inherited
        );
    }

    // ───────── 대체 자리 ─────────

    #[test]
    fn known_dirs_cover_the_install_places_and_skip_home_ones_without_a_home() {
        let with_home = known_dirs(Some("/Users/me"));
        assert_eq!(
            with_home,
            strings(&[
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/Users/me/.local/bin",
                "/Users/me/.npm-global/bin",
                "/Users/me/.bun/bin",
                "/Users/me/.volta/bin",
                "/Users/me/.claude/local",
            ])
        );
        assert_eq!(
            known_dirs(None),
            strings(&["/opt/homebrew/bin", "/usr/local/bin"])
        );
        // 상대 경로 홈 · 끝에 `/` 가 있는 홈
        assert_eq!(known_dirs(Some("relative/home")).len(), 2);
        assert_eq!(known_dirs(Some("/Users/me/"))[2], "/Users/me/.local/bin");
    }

    #[test]
    fn only_existing_known_folders_are_picked() {
        let present = ["/usr/local/bin", "/Users/me/.volta/bin"];
        let picked = existing_known_dirs(Some("/Users/me"), |dir| present.contains(&dir));
        assert_eq!(picked, strings(&["/usr/local/bin", "/Users/me/.volta/bin"]));
        assert!(existing_known_dirs(Some("/Users/me"), |_| false).is_empty());
    }

    // ───────── 셸 고르기 ─────────

    #[test]
    fn shell_var_is_used_only_when_absolute_and_executable() {
        let exists = |p: &str| p == "/opt/homebrew/bin/fish" || p == "/bin/zsh";
        assert_eq!(
            pick_shell(Some("/opt/homebrew/bin/fish"), exists, "/bin/sh"),
            "/opt/homebrew/bin/fish"
        );
        // 없는 파일 · 상대 경로 · 이름만 · 빈 값 · 없음 · 제어 문자 → 기본
        for bad in [
            Some("/no/such/shell"),
            Some("zsh"),
            Some("./zsh"),
            Some(""),
            None,
            Some("/bin/zsh\n"),
        ] {
            assert_eq!(pick_shell(bad, exists, "/bin/sh"), "/bin/sh", "{bad:?}");
        }
    }

    // ───────── PATH 바꿔 넣기 ─────────

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn replacing_path_changes_only_path_and_keeps_the_order() {
        let out = replace_path_var(
            env(&[
                ("HOME", "/h"),
                ("PATH", "/usr/bin"),
                ("LANG", "ko_KR.UTF-8"),
            ]),
            &OsString::from("/opt/homebrew/bin:/usr/bin"),
        );
        assert_eq!(
            out,
            env(&[
                ("HOME", "/h"),
                ("PATH", "/opt/homebrew/bin:/usr/bin"),
                ("LANG", "ko_KR.UTF-8")
            ])
        );
    }

    #[test]
    fn replacing_path_adds_it_when_missing_and_drops_a_second_one() {
        let new = OsString::from("/a:/b");
        assert_eq!(
            replace_path_var(env(&[("HOME", "/h")]), &new),
            env(&[("HOME", "/h"), ("PATH", "/a:/b")])
        );
        assert_eq!(
            replace_path_var(env(&[("PATH", "/x"), ("A", "1"), ("PATH", "/y")]), &new),
            env(&[("PATH", "/a:/b"), ("A", "1")])
        );
        // `Path` · `path` 는 유닉스에서 다른 변수다 — 건드리지 않는다
        assert_eq!(
            replace_path_var(env(&[("Path", "/x")]), &new),
            env(&[("Path", "/x"), ("PATH", "/a:/b")])
        );
        assert_eq!(
            replace_path_var(Vec::new(), &new),
            env(&[("PATH", "/a:/b")])
        );
    }

    // ───────── 한 번만 기억 ─────────

    fn resolved(dir: &str) -> Resolved {
        Resolved::new(Some(strings(&[dir]).as_slice()), &[], &[], Source::Fallback)
    }

    #[test]
    fn the_cache_asks_once_and_hands_the_same_value_to_every_caller() {
        let cache = PathCache::new();
        let asked = AtomicUsize::new(0);
        let probe = || {
            asked.fetch_add(1, Ordering::SeqCst);
            resolved("/first")
        };
        let a = cache.get(probe);
        let b = cache.get(|| panic!("must not ask again"));
        assert_eq!(a.dirs(), strings(&["/first"]));
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn callers_at_the_same_time_wait_for_the_single_probe() {
        let cache = Arc::new(PathCache::new());
        let asked = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let (cache, asked) = (cache.clone(), asked.clone());
                std::thread::spawn(move || {
                    cache
                        .get(|| {
                            asked.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(Duration::from_millis(100));
                            resolved("/slow")
                        })
                        .dirs()
                        .to_vec()
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), strings(&["/slow"]));
        }
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn refresh_waits_for_the_minimum_age_and_then_replaces_the_value() {
        let cache = PathCache::new();
        cache.get(|| resolved("/old"));
        // 아직 이르다 — 묻지 않는다
        assert!(
            cache
                .refresh(Duration::from_secs(3600), || panic!("too early"))
                .is_none()
        );
        assert_eq!(cache.get(|| panic!("kept")).dirs(), strings(&["/old"]));
        // 나이 제한이 0 이면 바로 다시 읽고 이후는 새 값
        let fresh = cache.refresh(Duration::ZERO, || resolved("/new")).unwrap();
        assert_eq!(fresh.dirs(), strings(&["/new"]));
        assert_eq!(cache.get(|| panic!("kept")).dirs(), strings(&["/new"]));
    }

    #[test]
    fn refresh_before_anything_was_read_reads_once() {
        let cache = PathCache::new();
        let got = cache.refresh(Duration::from_secs(10), || resolved("/x"));
        assert_eq!(got.unwrap().dirs(), strings(&["/x"]));
    }

    #[test]
    fn a_probe_that_panicked_does_not_poison_the_cache_for_good() {
        let cache = Arc::new(PathCache::new());
        let c = cache.clone();
        let _ = std::thread::spawn(move || {
            c.get(|| panic!("probe blew up"));
        })
        .join();
        assert_eq!(
            cache.get(|| resolved("/after")).dirs(),
            strings(&["/after"])
        );
    }

    // ───────── Windows 는 그대로 ─────────

    #[cfg(windows)]
    #[test]
    fn on_windows_the_path_and_the_environment_are_left_alone() {
        assert_eq!(search_path(), std::env::var_os("PATH"));
        let base = env(&[("Path", "C:\\Windows"), ("HOME", "x")]);
        assert_eq!(with_search_path(base.clone()), base);
        assert!(!refresh_after_miss());
    }
}
