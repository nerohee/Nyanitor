//! 프로젝트 폴더 다루기 — 고를 수 없는 폴더 · 폴더 살펴보기 · 하네스 문서 폴더 이름 (D-47).
//!
//! 살펴보기는 파일이 **있는지**만 본다 — 내용은 읽지 않는다. 느린 폴더(네트워크 드라이브)가 목록 전체를 붙잡지 않게
//! 폴더마다 따로 스레드에서 살펴보고, 시간 안에 못 끝난 것은 `unknown` 으로 둔다.

use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::agents::config::{EXAMPLE_FILE, LOCAL_FILE};
use crate::claude::store::project_key;
use crate::harness::locate;

/// 문서 폴더 이름 기본값 (하네스 설정의 `docsDir` 이 없을 때)
pub const DEFAULT_DOCS_DIR: &str = "docs";

/// 설정 파일 하나의 최대 크기
const CONFIG_LIMIT: u64 = 256 * 1024;

/// 목록 하나를 만드는 동안 폴더 살펴보기를 기다리는 시간
pub const INSPECT_DEADLINE: Duration = Duration::from_secs(2);

/// 끝나지 않은 살펴보기 스레드가 이만큼 쌓여 있으면 새로 시작하지 않는다 (네트워크가 죽은 채 목록을 계속 불러도 스레드가 늘지 않게)
const MAX_IN_FLIGHT: usize = 16;

/// 폴더 상태
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderState {
    /// 있다
    Ok,
    /// 없다 (옮겼거나 지웠다) · 폴더가 아니다
    Missing,
    /// 알 수 없다 (제때 답이 없음 · 권한 없음)
    Unknown,
}

/// 폴더를 살펴본 결과 (파일 내용은 읽지 않는다) — 하네스 문서가 있으면 `hasHarness`, 아니면 `requirements.md` 가 있으면 `hasRequirements`, 아니면 `fresh`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FolderFinding {
    Fresh,
    HasRequirements,
    HasHarness,
}

/// 폴더 상태 + 살펴본 결과 (폴더가 `ok` 가 아니면 결과 없음)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inspection {
    pub state: FolderState,
    pub finding: Option<FolderFinding>,
}

impl Inspection {
    const UNKNOWN: Self = Self {
        state: FolderState::Unknown,
        finding: None,
    };
}

/// `docsDir` 로 쓸 수 있는 값인가 — 상대 경로이고 `..` · 드라이브 · 뿌리가 없다 (문서 폴더는 프로젝트 폴더 안이다).
fn valid_docs_dir(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty() || text.len() > 128 || text.contains('\0') {
        return None;
    }
    let path = Path::new(text);
    let ok = path.is_relative()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
    ok.then(|| text.to_string())
}

fn read_capped(path: &Path) -> io::Result<Option<String>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let mut bytes = Vec::new();
    file.take(CONFIG_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "too large"));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

/// 하네스 설정(`<하네스 폴더>/config.local.json`, 없으면 `config.example.json`)의 `docsDir` 하나만 읽는다. 없거나 읽을 수 없거나
/// 쓸 수 없는 값이면 `docs`. (에이전트 목록 쪽 설정 읽기와 같은 파일 · 같은 우선순위 — 거기서는 이 키를 읽지 않아 따로 읽는다.)
pub fn docs_dir_in(harness_dir: &Path) -> String {
    for file in [LOCAL_FILE, EXAMPLE_FILE] {
        match read_capped(&harness_dir.join(file)) {
            Ok(None) => continue,
            Ok(Some(text)) => {
                let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
                return serde_json::from_str::<Value>(text)
                    .ok()
                    .and_then(|root| root.get("docsDir")?.as_str().and_then(valid_docs_dir))
                    .unwrap_or_else(|| DEFAULT_DOCS_DIR.to_string());
            }
            // 깨진 설정은 예시로 대신하지 않는다 (에이전트 목록과 같다)
            Err(_) => break,
        }
    }
    DEFAULT_DOCS_DIR.to_string()
}

/// 이 PC 의 하네스 설정에서 읽은 `docsDir`
pub fn docs_dir_here() -> String {
    match locate::locations_here() {
        Ok(locations) => docs_dir_in(&locations.installed_harness()),
        Err(_) => DEFAULT_DOCS_DIR.to_string(),
    }
}

fn is_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file())
}

/// 폴더 하나를 살펴본다 (느릴 수 있다 — 호출하는 쪽이 시간을 건다).
pub fn inspect(dir: &Path, docs_dir: &str) -> Inspection {
    match fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Inspection {
                state: FolderState::Missing,
                finding: None,
            };
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Inspection {
                state: FolderState::Missing,
                finding: None,
            };
        }
        Err(_) => return Inspection::UNKNOWN,
    }
    let plan = dir.join(docs_dir).join("02-development");
    let finding = if is_file(&plan.join("handoff.md")) || is_file(&plan.join("dev-plan.md")) {
        FolderFinding::HasHarness
    } else if is_file(&dir.join("requirements.md")) {
        FolderFinding::HasRequirements
    } else {
        FolderFinding::Fresh
    };
    Inspection {
        state: FolderState::Ok,
        finding: Some(finding),
    }
}

/// 끝나지 않은 살펴보기 수 (스레드가 끝나면 줄어든다)
static IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);

struct InFlight;

impl InFlight {
    fn enter() -> Option<Self> {
        IN_FLIGHT
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < MAX_IN_FLIGHT).then_some(count + 1)
            })
            .ok()
            .map(|_| Self)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 여러 폴더를 한꺼번에 살펴본다 (폴더마다 스레드). `deadline` 안에 끝나지 않은 것(과 스레드를 더 못 띄운 것)은 `unknown`.
/// 느린 폴더 하나 때문에 나머지가 늦어지거나 실패하지 않는다. 결과 순서는 `paths` 와 같다.
pub fn inspect_all(paths: &[PathBuf], docs_dir: &str, deadline: Duration) -> Vec<Inspection> {
    let docs_dir = Arc::new(docs_dir.to_string());
    inspect_all_with(paths, deadline, move |path| inspect(path, &docs_dir))
}

/// `inspect_all` 의 본체 — 살펴보는 일을 바꿔 끼울 수 있다 (느린 폴더를 흉내 내는 시험용).
pub fn inspect_all_with(
    paths: &[PathBuf],
    deadline: Duration,
    work: impl Fn(&Path) -> Inspection + Send + Sync + 'static,
) -> Vec<Inspection> {
    let work = Arc::new(work);
    let (sender, receiver) = mpsc::channel();
    let mut started = 0;
    for (index, path) in paths.iter().enumerate() {
        let Some(slot) = InFlight::enter() else {
            continue;
        };
        let sender = sender.clone();
        let work = Arc::clone(&work);
        let path = path.clone();
        let spawned = std::thread::Builder::new()
            .name("nyanitor-folder-inspect".into())
            .spawn(move || {
                let _slot = slot;
                let result = work(&path);
                // 받는 쪽이 이미 떠났으면(시간 초과) 보낼 곳이 없다 — 괜찮다
                let _ = sender.send((index, result));
            });
        if spawned.is_ok() {
            started += 1;
        }
    }
    drop(sender);
    let mut results = vec![Inspection::UNKNOWN; paths.len()];
    let end = Instant::now() + deadline;
    for _ in 0..started {
        let left = end.saturating_duration_since(Instant::now());
        match receiver.recv_timeout(left) {
            Ok((index, result)) => results[index] = result,
            Err(_) => break,
        }
    }
    results
}

/// 폴더 이름 (기본 프로젝트 이름) — 이름이 없는 경로(뿌리)면 경로 글자 그대로
pub fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

// ───────────────────────── 고를 수 없는 폴더 ─────────────────────────

/// 프로젝트로 고를 수 없는 이유 — 화면이 문구를 고르는 열쇠
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForbiddenReason {
    /// 드라이브(또는 네트워크 공유)의 뿌리
    DriveRoot,
    /// 홈 폴더 자체 (그 아래 폴더는 괜찮다)
    Home,
    /// `~/.claude` (또는 `CLAUDE_CONFIG_DIR`) 와 그 안
    ClaudeDir,
    /// `~/.claude-harness` (또는 `CLAUDE_HARNESS_HOME`) 와 그 안
    HarnessHome,
    /// 이 앱의 데이터 폴더와 그 안
    AppData,
}

/// 고를 수 없는 위치들. 위치마다 글자 그대로의 키와 링크를 푼 키를 둘 다 비교한다 (정션으로 돌려 고르는 길을 막는다).
#[derive(Debug, Clone, Default)]
pub struct ForbiddenSet {
    /// 그 폴더 자체만 막는다
    exact: Vec<(ForbiddenReason, Vec<String>)>,
    /// 그 폴더와 그 안을 막는다
    inside: Vec<(ForbiddenReason, Vec<String>)>,
}

/// 경로의 비교용 키들: 글자 그대로의 키 + (있으면) 링크를 푼 실제 위치의 키
fn keys_of(path: &Path) -> Vec<String> {
    let mut keys = vec![project_key(path)];
    if let Ok(real) = fs::canonicalize(path) {
        let key = project_key(&real);
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn separator() -> char {
    if cfg!(windows) { '\\' } else { '/' }
}

/// 드라이브 뿌리 · 네트워크 공유 뿌리인가 (`project_key` 가 만든 키 기준)
fn is_root_key(key: &str) -> bool {
    if cfg!(windows) {
        if let Some(rest) = key.strip_prefix("\\\\") {
            // `\\서버\공유` — 서버와 공유 이름만 있으면 뿌리
            return rest.split('\\').filter(|part| !part.is_empty()).count() <= 2;
        }
        key.len() == 3 && key.ends_with(":\\")
    } else {
        key == "/"
    }
}

fn is_inside(key: &str, base: &str) -> bool {
    key == base
        || key
            .strip_prefix(base)
            .is_some_and(|rest| base.ends_with(separator()) || rest.starts_with(separator()))
}

impl ForbiddenSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_exact(mut self, reason: ForbiddenReason, path: &Path) -> Self {
        self.exact.push((reason, keys_of(path)));
        self
    }

    pub fn with_inside(mut self, reason: ForbiddenReason, path: &Path) -> Self {
        self.inside.push((reason, keys_of(path)));
        self
    }

    /// 이 PC 의 환경으로: 홈 · `~/.claude` · `~/.claude-harness` (환경 변수로 바뀐 위치와 기본 위치 둘 다) · 앱 데이터 폴더
    pub fn here(app_data: &Path) -> Self {
        let home = std::env::home_dir();
        let mut set = Self::new().with_inside(ForbiddenReason::AppData, app_data);
        if let Some(home) = &home {
            set = set
                .with_exact(ForbiddenReason::Home, home)
                .with_inside(ForbiddenReason::ClaudeDir, &home.join(".claude"))
                .with_inside(ForbiddenReason::HarnessHome, &home.join(".claude-harness"));
        }
        if let Ok(locations) = locate::locations_here() {
            set = set
                .with_inside(ForbiddenReason::ClaudeDir, &locations.claude_dir)
                .with_inside(ForbiddenReason::HarnessHome, &locations.harness_home);
        }
        set
    }

    /// 고를 수 없는 폴더면 그 이유
    pub fn reason(&self, path: &Path) -> Option<ForbiddenReason> {
        for key in keys_of(path) {
            if is_root_key(&key) {
                return Some(ForbiddenReason::DriveRoot);
            }
            for (reason, bases) in &self.exact {
                if bases.contains(&key) {
                    return Some(*reason);
                }
            }
            for (reason, bases) in &self.inside {
                if bases.iter().any(|base| is_inside(&key, base)) {
                    return Some(*reason);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    fn touch(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    #[test]
    fn an_empty_folder_is_fresh() {
        let dir = TempDir::new("insp-fresh");
        assert_eq!(
            inspect(&dir, "docs"),
            Inspection {
                state: FolderState::Ok,
                finding: Some(FolderFinding::Fresh)
            }
        );
    }

    #[test]
    fn a_requirements_file_in_the_root_is_found() {
        let dir = TempDir::new("insp-req");
        touch(&dir.join("requirements.md"));
        assert_eq!(
            inspect(&dir, "docs").finding,
            Some(FolderFinding::HasRequirements)
        );
        // 폴더인 requirements.md 는 파일이 아니다
        let other = TempDir::new("insp-req-dir");
        fs::create_dir(other.join("requirements.md")).unwrap();
        assert_eq!(inspect(&other, "docs").finding, Some(FolderFinding::Fresh));
        // 하위 폴더의 requirements.md 는 세지 않는다
        let nested = TempDir::new("insp-req-nested");
        touch(&nested.join("sub").join("requirements.md"));
        assert_eq!(inspect(&nested, "docs").finding, Some(FolderFinding::Fresh));
    }

    #[test]
    fn harness_documents_are_found_by_either_file_and_win_over_requirements() {
        for file in ["handoff.md", "dev-plan.md"] {
            let dir = TempDir::new("insp-harness");
            touch(&dir.join("docs").join("02-development").join(file));
            assert_eq!(
                inspect(&dir, "docs").finding,
                Some(FolderFinding::HasHarness),
                "{file}"
            );
            touch(&dir.join("requirements.md"));
            assert_eq!(
                inspect(&dir, "docs").finding,
                Some(FolderFinding::HasHarness),
                "{file} + requirements"
            );
        }
    }

    #[test]
    fn the_docs_folder_name_comes_from_the_setting() {
        let dir = TempDir::new("insp-docsdir");
        touch(
            &dir.join("documents")
                .join("02-development")
                .join("handoff.md"),
        );
        assert_eq!(inspect(&dir, "docs").finding, Some(FolderFinding::Fresh));
        assert_eq!(
            inspect(&dir, "documents").finding,
            Some(FolderFinding::HasHarness)
        );
    }

    #[test]
    fn a_missing_folder_or_a_file_is_missing() {
        let dir = TempDir::new("insp-missing");
        let gone = inspect(&dir.join("gone"), "docs");
        assert_eq!(gone.state, FolderState::Missing);
        assert_eq!(gone.finding, None);
        touch(&dir.join("a-file"));
        assert_eq!(
            inspect(&dir.join("a-file"), "docs").state,
            FolderState::Missing
        );
    }

    #[test]
    fn docs_dir_defaults_and_reads_the_setting() {
        let dir = TempDir::new("insp-config");
        assert_eq!(docs_dir_in(&dir), "docs");
        assert_eq!(docs_dir_in(&dir.join("no-such-folder")), "docs");
        fs::write(dir.join(EXAMPLE_FILE), r#"{"docsDir":"example-docs"}"#).unwrap();
        assert_eq!(docs_dir_in(&dir), "example-docs");
        fs::write(
            dir.join(LOCAL_FILE),
            "\u{feff}{\"docsDir\":\"documents/plan\"}",
        )
        .unwrap();
        assert_eq!(docs_dir_in(&dir), "documents/plan");
    }

    #[test]
    fn unusable_docs_dir_values_fall_back_to_docs() {
        let dir = TempDir::new("insp-config-bad");
        for value in [
            r#""""#,
            r#""..""#,
            r#""../outside""#,
            r#""a/../../b""#,
            r#""/abs""#,
            r#""C:\\abs""#,
            r#""\\\\server\\share""#,
            "5",
            "null",
            r#"["x"]"#,
        ] {
            fs::write(dir.join(LOCAL_FILE), format!(r#"{{"docsDir":{value}}}"#)).unwrap();
            assert_eq!(docs_dir_in(&dir), "docs", "{value}");
        }
        // 깨진 설정은 예시로 대신하지 않는다
        fs::write(dir.join(EXAMPLE_FILE), r#"{"docsDir":"example-docs"}"#).unwrap();
        fs::write(dir.join(LOCAL_FILE), "{ broken").unwrap();
        assert_eq!(docs_dir_in(&dir), "docs");
    }

    #[test]
    fn a_slow_folder_does_not_hold_up_or_fail_the_others() {
        let paths = vec![
            PathBuf::from("fast-a"),
            PathBuf::from("slow"),
            PathBuf::from("fast-b"),
        ];
        let started = Instant::now();
        let results = inspect_all_with(&paths, Duration::from_millis(300), |path| {
            if path == Path::new("slow") {
                std::thread::sleep(Duration::from_millis(1500));
            }
            Inspection {
                state: FolderState::Ok,
                finding: Some(FolderFinding::Fresh),
            }
        });
        assert!(
            started.elapsed() < Duration::from_millis(1200),
            "waited for the slow folder"
        );
        assert_eq!(results[0].state, FolderState::Ok);
        assert_eq!(results[1], Inspection::UNKNOWN);
        assert_eq!(results[2].state, FolderState::Ok);
    }

    #[test]
    fn a_panicking_inspection_leaves_unknown_and_the_rest_intact() {
        let paths = vec![PathBuf::from("boom"), PathBuf::from("fine")];
        let results = inspect_all_with(&paths, Duration::from_secs(2), |path| {
            assert_ne!(path, Path::new("boom"), "simulated crash");
            Inspection {
                state: FolderState::Ok,
                finding: Some(FolderFinding::Fresh),
            }
        });
        assert_eq!(results[0], Inspection::UNKNOWN);
        assert_eq!(results[1].state, FolderState::Ok);
    }

    #[test]
    fn inspect_all_keeps_the_order_and_handles_no_folders() {
        assert!(inspect_all(&[], "docs", Duration::from_millis(100)).is_empty());
        let a = TempDir::new("insp-all-a");
        let b = TempDir::new("insp-all-b");
        touch(&b.join("requirements.md"));
        let results = inspect_all(
            &[
                a.path().to_path_buf(),
                a.join("gone"),
                b.path().to_path_buf(),
            ],
            "docs",
            Duration::from_secs(5),
        );
        assert_eq!(results[0].finding, Some(FolderFinding::Fresh));
        assert_eq!(results[1].state, FolderState::Missing);
        assert_eq!(results[2].finding, Some(FolderFinding::HasRequirements));
    }

    fn set_for(home: &Path, claude: &Path, harness: &Path, app_data: &Path) -> ForbiddenSet {
        ForbiddenSet::new()
            .with_inside(ForbiddenReason::AppData, app_data)
            .with_exact(ForbiddenReason::Home, home)
            .with_inside(ForbiddenReason::ClaudeDir, claude)
            .with_inside(ForbiddenReason::HarnessHome, harness)
    }

    #[test]
    fn each_forbidden_folder_is_refused_with_its_own_reason() {
        let base = TempDir::new("forbid");
        let home = base.join("home");
        let claude = home.join(".claude");
        let harness = home.join(".claude-harness");
        let app_data = base.join("appdata").join("io.github.nerohee.nyanitor");
        for dir in [&home, &claude, &harness, &app_data] {
            fs::create_dir_all(dir).unwrap();
        }
        let set = set_for(&home, &claude, &harness, &app_data);

        assert_eq!(set.reason(&home), Some(ForbiddenReason::Home));
        assert_eq!(set.reason(&claude), Some(ForbiddenReason::ClaudeDir));
        assert_eq!(set.reason(&harness), Some(ForbiddenReason::HarnessHome));
        assert_eq!(set.reason(&app_data), Some(ForbiddenReason::AppData));
        // 그 안도 막는다
        fs::create_dir_all(claude.join("projects").join("x")).unwrap();
        fs::create_dir_all(harness.join("repo")).unwrap();
        fs::create_dir_all(app_data.join("logs")).unwrap();
        assert_eq!(
            set.reason(&claude.join("projects").join("x")),
            Some(ForbiddenReason::ClaudeDir)
        );
        assert_eq!(
            set.reason(&harness.join("repo")),
            Some(ForbiddenReason::HarnessHome)
        );
        assert_eq!(
            set.reason(&app_data.join("logs")),
            Some(ForbiddenReason::AppData)
        );
    }

    #[test]
    fn folders_next_to_or_under_home_are_fine() {
        let base = TempDir::new("forbid-ok");
        let home = base.join("home");
        let claude = home.join(".claude");
        let harness = home.join(".claude-harness");
        let app_data = base.join("appdata").join("nyanitor");
        let project = home.join("dev").join("my-app");
        // 이름이 비슷하지만 다른 폴더 — 접두 글자만 같으면 안 막는다
        let lookalike_a = home.join(".claude-notes");
        let lookalike_b = home.join(".claude2");
        let lookalike_c = base.join("appdata").join("nyanitor-copy");
        for dir in [
            &home,
            &claude,
            &harness,
            &app_data,
            &project,
            &lookalike_a,
            &lookalike_b,
            &lookalike_c,
        ] {
            fs::create_dir_all(dir).unwrap();
        }
        let set = set_for(&home, &claude, &harness, &app_data);
        for ok in [
            &project,
            &lookalike_a,
            &lookalike_b,
            &lookalike_c,
            &base.join("appdata"),
        ] {
            assert_eq!(set.reason(ok), None, "{}", ok.display());
        }
    }

    #[test]
    fn the_same_forbidden_folder_in_other_spellings_is_still_refused() {
        let base = TempDir::new("forbid-spelling");
        let home = base.join("home");
        let claude = home.join(".claude");
        fs::create_dir_all(claude.join("sub")).unwrap();
        let set = ForbiddenSet::new().with_inside(ForbiddenReason::ClaudeDir, &claude);
        // 끝 구분자 · 겹친 구분자 · `.`
        let sep = std::path::MAIN_SEPARATOR;
        for spelling in [
            format!("{}{sep}", claude.display()),
            format!("{}{sep}{sep}sub", claude.display()),
            format!("{}{sep}.{sep}sub", claude.display()),
        ] {
            assert_eq!(
                set.reason(Path::new(&spelling)),
                Some(ForbiddenReason::ClaudeDir),
                "{spelling}"
            );
        }
        if cfg!(windows) {
            // 대소문자 · `/`
            let text = claude.display().to_string();
            assert_eq!(
                set.reason(Path::new(&text.to_uppercase())),
                Some(ForbiddenReason::ClaudeDir)
            );
            assert_eq!(
                set.reason(Path::new(&text.replace('\\', "/"))),
                Some(ForbiddenReason::ClaudeDir)
            );
        }
    }

    #[test]
    fn drive_roots_are_refused() {
        let set = ForbiddenSet::new();
        if cfg!(windows) {
            for root in ["C:\\", "c:/", "D:\\", "\\\\?\\C:\\"] {
                assert_eq!(
                    set.reason(Path::new(root)),
                    Some(ForbiddenReason::DriveRoot),
                    "{root}"
                );
            }
            // 뿌리 아래는 괜찮다
            assert_eq!(set.reason(Path::new("C:\\dev")), None);
        } else {
            assert_eq!(set.reason(Path::new("/")), Some(ForbiddenReason::DriveRoot));
            assert_eq!(set.reason(Path::new("/home")), None);
        }
    }

    #[test]
    fn network_share_roots_are_roots_but_folders_in_them_are_not() {
        // 없는 서버를 실제로 찾아보면 오래 걸리므로 키만 본다
        if cfg!(windows) {
            for root in [
                "\\\\server\\share",
                "\\\\server\\share\\",
                "\\\\?\\UNC\\server\\share",
            ] {
                assert!(is_root_key(&project_key(Path::new(root))), "{root}");
            }
            for inner in ["\\\\server\\share\\dir", "C:\\dev"] {
                assert!(!is_root_key(&project_key(Path::new(inner))), "{inner}");
            }
        } else {
            assert!(is_root_key("/"));
            assert!(!is_root_key("/home"));
        }
    }

    #[test]
    fn a_link_into_a_forbidden_folder_is_refused_by_where_it_points() {
        let base = TempDir::new("forbid-link");
        let claude = base.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        let link = base.join("innocent");
        #[cfg(windows)]
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&claude)
            .output()
            .is_ok_and(|out| out.status.success());
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(&claude, &link).is_ok();
        if !made {
            eprintln!("skipped: cannot create directory links here");
            return;
        }
        let set = ForbiddenSet::new().with_inside(ForbiddenReason::ClaudeDir, &claude);
        assert_eq!(set.reason(&link), Some(ForbiddenReason::ClaudeDir));
    }

    #[test]
    fn the_real_environment_set_refuses_home_and_its_claude_folders() {
        let app_data = TempDir::new("forbid-here");
        let set = ForbiddenSet::here(&app_data);
        assert_eq!(
            set.reason(&app_data.join("x")),
            Some(ForbiddenReason::AppData)
        );
        if let Some(home) = std::env::home_dir() {
            assert_eq!(set.reason(&home), Some(ForbiddenReason::Home));
            assert_eq!(
                set.reason(&home.join(".claude").join("agents")),
                Some(ForbiddenReason::ClaudeDir)
            );
            assert_eq!(
                set.reason(&home.join(".claude-harness")),
                Some(ForbiddenReason::HarnessHome)
            );
        }
    }

    #[test]
    fn folder_name_is_the_last_part() {
        assert_eq!(
            folder_name(Path::new("C:\\dev\\cat-album")),
            if cfg!(windows) {
                "cat-album"
            } else {
                "C:\\dev\\cat-album"
            }
        );
        assert_eq!(folder_name(&PathBuf::from("/a/b/c")), "c");
    }
}
