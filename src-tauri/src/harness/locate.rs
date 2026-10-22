//! 위치 찾기 — `~/.claude` · 하네스 폴더 · 쓸 원본 (개발자 모드 알아보기, D-20).
//!
//! 읽기만 한다. `~/.claude/harness` 를 직접 본다 (스크립트의 `existingSource` 와 같은 뜻):
//! 링크 · 정션이면 그 대상, 폴더이고 `.install-mode` 첫 줄이 `copy` 이면 둘째 줄이 원본.

use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

pub const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";
pub const HARNESS_HOME_VAR: &str = "CLAUDE_HARNESS_HOME";

/// 복사 설치의 표시 파일 (약속 2-4절). 읽을 최대 크기를 막아 둔다.
const MARK_FILE: &str = ".install-mode";
const MARK_READ_LIMIT: u64 = 8 * 1024;

/// 이 앱이 쓰는 두 위치 (정해 둔 것 1). 스크립트를 돌릴 때도 같은 값을 환경 변수로 넘긴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Locations {
    /// `~/.claude` (`CLAUDE_CONFIG_DIR` 가 있으면 그것)
    pub claude_dir: PathBuf,
    /// `~/.claude-harness` (`CLAUDE_HARNESS_HOME` 가 있으면 그것)
    pub harness_home: PathBuf,
    pub claude_dir_from_env: bool,
    pub harness_home_from_env: bool,
}

impl Locations {
    /// 받은 원본: `<하네스 폴더>/repo`
    pub fn repo_dir(&self) -> PathBuf {
        self.harness_home.join("repo")
    }

    /// 백업: `<하네스 폴더>/backups`
    pub fn backups_dir(&self) -> PathBuf {
        self.harness_home.join("backups")
    }

    /// 지금 쓰는 하네스: `<~/.claude>/harness`
    pub fn installed_harness(&self) -> PathBuf {
        self.claude_dir.join("harness")
    }

    /// 설치 스크립트의 잠금: `<~/.claude>/.harness-install.lock` — 스크립트(설치 · 되돌리기)가 도는 동안만 있다
    pub fn install_lock(&self) -> PathBuf {
        self.claude_dir.join(".harness-install.lock")
    }
}

/// 위치를 정하지 못한 이유 — 진단용 짧은 이름이 화면으로 간다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocationError {
    /// 홈 폴더를 알 수 없다
    NoHome,
    /// `CLAUDE_CONFIG_DIR` 가 절대 경로가 아니다 (상대 경로는 어디를 가리키는지 정할 수 없다)
    ConfigDirNotAbsolute,
    /// `CLAUDE_HARNESS_HOME` 가 절대 경로가 아니다
    HarnessHomeNotAbsolute,
}

impl LocationError {
    pub fn code(self) -> &'static str {
        match self {
            LocationError::NoHome => "no_home",
            LocationError::ConfigDirNotAbsolute => "config_dir_not_absolute",
            LocationError::HarnessHomeNotAbsolute => "harness_home_not_absolute",
        }
    }
}

/// 환경 변수 값 → 위치. 빈 값은 없는 것으로 본다 (스크립트도 같다).
pub fn locations(
    lookup: impl Fn(&str) -> Option<OsString>,
    home: Option<&Path>,
) -> Result<Locations, LocationError> {
    let from_env = |name: &str| lookup(name).filter(|value| !value.is_empty());
    let (claude_dir, claude_dir_from_env) = match from_env(CONFIG_DIR_VAR) {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(LocationError::ConfigDirNotAbsolute);
            }
            (path, true)
        }
        None => (home.ok_or(LocationError::NoHome)?.join(".claude"), false),
    };
    let (harness_home, harness_home_from_env) = match from_env(HARNESS_HOME_VAR) {
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err(LocationError::HarnessHomeNotAbsolute);
            }
            (path, true)
        }
        None => (
            home.ok_or(LocationError::NoHome)?.join(".claude-harness"),
            false,
        ),
    };
    Ok(Locations {
        claude_dir,
        harness_home,
        claude_dir_from_env,
        harness_home_from_env,
    })
}

/// 이 프로세스의 환경 · 홈 폴더로 정한다.
pub fn locations_here() -> Result<Locations, LocationError> {
    locations(
        |name| std::env::var_os(name),
        std::env::home_dir().as_deref(),
    )
}

/// Windows 의 `\\?\C:\…` · `\\?\UNC\서버\…` 앞머리를 떼어 사람이 아는 모양으로 (다른 경로는 그대로).
pub fn strip_verbatim(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(text) = path.to_str() {
            if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
                return PathBuf::from(format!(r"\\{rest}"));
            }
            if let Some(rest) = text.strip_prefix(r"\\?\") {
                let bytes = rest.as_bytes();
                if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
                    return PathBuf::from(rest);
                }
            }
        }
    }
    path.to_path_buf()
}

/// 같은 폴더를 가리키는가 — 있는 폴더는 링크를 풀어서, 없는 것은 글자로 비교한다 (Windows 는 대소문자 · `/` 무시).
pub fn same_path(a: &Path, b: &Path) -> bool {
    fn normal(path: &Path) -> String {
        let real = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let text = strip_verbatim(&real).to_string_lossy().into_owned();
        let mut text = if cfg!(windows) {
            text.replace('/', "\\").to_lowercase()
        } else {
            text
        };
        while text.len() > 1 && (text.ends_with('\\') || text.ends_with('/')) {
            // `C:\` 의 끝 `\` 는 뿌리라서 남긴다
            if text.ends_with(":\\") {
                break;
            }
            text.pop();
        }
        text
    }
    normal(a) == normal(b)
}

/// `path` 가 이 PC 의 기본 위치(`<홈>/<name>`)와 같은 폴더인가 — 환경 변수가 기본 위치를 가리켜도 알아본다 (같은 폴더 규칙은 `same_path`).
/// 홈 폴더를 모르면 `false`.
pub fn is_default_location(path: &Path, home: Option<&Path>, name: &str) -> bool {
    home.is_some_and(|home| same_path(path, &home.join(name)))
}

/// 네트워크 공유(UNC `\\서버\공유`)를 가리키는 글자인가. WSL 의 `\\wsl.localhost\…` · `\\wsl$\…` 는 이 PC 안이라 아니다.
/// `\\?\` · `\\.\` 장치 경로(`\\?\UNC\서버\…` 는 벗겨서 본다)와 `C:\…` 같은 드라이브 경로도 아니다. 글자만 보므로 어느 OS 에서든 같은 답이다.
pub fn is_network_share(text: &str) -> bool {
    let unified = text.replace('/', "\\");
    let verbatim_unc = r"\\?\UNC\";
    let text = match unified.get(..verbatim_unc.len()) {
        Some(head) if head.eq_ignore_ascii_case(verbatim_unc) => {
            format!(r"\\{}", &unified[verbatim_unc.len()..])
        }
        _ => unified,
    };
    let Some(rest) = text.strip_prefix(r"\\") else {
        return false;
    };
    let server = rest.split('\\').next().unwrap_or("");
    if server.is_empty() || server == "?" || server == "." {
        return false;
    }
    let server = server.to_lowercase();
    server != "wsl.localhost" && server != "wsl$"
}

/// 네트워크 경로인가 (Windows 만 — 다른 OS 의 `//a/b` 는 그냥 경로다)
pub fn is_network_path(path: &Path) -> bool {
    cfg!(windows) && is_network_share(&path.to_string_lossy())
}

/// 이 OS 의 설치 스크립트 파일 이름
pub fn script_name() -> &'static str {
    if cfg!(windows) {
        "install.ps1"
    } else {
        "install.sh"
    }
}

/// `~/.claude/harness` 가 가리키는 곳의 종류.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginKind {
    /// 아직 설치된 적 없음 (`~/.claude/harness` 없음) — 보통 흐름
    None,
    /// 앱이 받은 `<하네스 폴더>/repo` — 보통 흐름
    Repo,
    /// 다른 원본을 쓰는 중 = 개발자 모드 — 그 원본의 스크립트를 쓰고 git 은 건드리지 않는다
    Developer,
    /// 표시가 깨졌거나 가리키는 곳을 읽을 수 없음 — 개발자 모드가 아니라 보통 흐름으로 가고, 이유를 알린다
    Unreadable,
}

/// 읽을 수 없을 때의 이유 (진단용 짧은 이름 — 화면이 문구를 고른다)
pub mod reason {
    /// 링크 · 정션이 가리키는 곳이 없다
    pub const LINK_BROKEN: &str = "link_broken";
    /// `.install-mode` 가 없거나 모양이 틀리다 (첫 줄이 `copy` 가 아님 · 둘째 줄이 절대 경로가 아님)
    pub const MARK_BROKEN: &str = "mark_broken";
    /// 표시 파일이 없는 낯선 `harness` 폴더 · 파일
    pub const FOREIGN: &str = "foreign";
    /// 표시가 가리키는 원본 폴더가 없다
    pub const SOURCE_MISSING: &str = "source_missing";
    /// 원본 폴더에 이 OS 의 설치 스크립트가 없다
    pub const SCRIPT_MISSING: &str = "script_missing";
    /// 읽는 중 입출력 오류
    pub const READ_FAILED: &str = "read_failed";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub kind: OriginKind,
    /// 가리키는 원본 폴더 (사람이 아는 모양). 알 수 없으면 `None`
    pub path: Option<String>,
    /// `link` (링크 · 정션) · `copy` (복사 + 표시 파일)
    pub marker: Option<&'static str>,
    /// `Unreadable` 일 때의 이유 (`reason::*`)
    pub reason: Option<&'static str>,
}

impl Origin {
    fn none() -> Self {
        Self {
            kind: OriginKind::None,
            path: None,
            marker: None,
            reason: None,
        }
    }

    fn unreadable(path: Option<&Path>, marker: Option<&'static str>, why: &'static str) -> Self {
        Self {
            kind: OriginKind::Unreadable,
            path: path.map(|p| p.display().to_string()),
            marker,
            reason: Some(why),
        }
    }
}

enum Mark {
    Copy(PathBuf),
    Broken,
    Missing,
    Unreadable,
}

/// `.install-mode` 읽기 — 첫 줄 `copy`, 둘째 줄 원본 절대 경로.
fn read_mark(file: &Path) -> Mark {
    let opened = match fs::File::open(file) {
        Ok(f) => f,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Mark::Missing,
        Err(_) => return Mark::Unreadable,
    };
    let mut bytes = Vec::new();
    if opened
        .take(MARK_READ_LIMIT)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return Mark::Unreadable;
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines().map(|l| l.trim_end_matches('\r'));
    if lines.next().map(str::trim) != Some("copy") {
        return Mark::Broken;
    }
    let Some(source) = lines.next().map(str::trim).filter(|l| !l.is_empty()) else {
        return Mark::Broken;
    };
    let source = PathBuf::from(source);
    if !source.is_absolute() {
        return Mark::Broken;
    }
    Mark::Copy(source)
}

/// 지금 쓰는 하네스(`~/.claude/harness`)가 어느 원본을 가리키는지 본다 (정해 둔 것 2). 아무것도 쓰지 않는다.
pub fn pick_origin(locations: &Locations) -> Origin {
    let harness = locations.installed_harness();
    let meta = match fs::symlink_metadata(&harness) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Origin::none(),
        Err(_) => return Origin::unreadable(None, None, reason::READ_FAILED),
    };

    let (marker, source): (&'static str, PathBuf) = if meta.file_type().is_symlink() {
        match fs::canonicalize(&harness) {
            Ok(target) => ("link", strip_verbatim(&target)),
            Err(_) => {
                let shown = fs::read_link(&harness).ok();
                return Origin::unreadable(shown.as_deref(), Some("link"), reason::LINK_BROKEN);
            }
        }
    } else if meta.is_dir() {
        match read_mark(&harness.join(MARK_FILE)) {
            Mark::Copy(source) => ("copy", source),
            Mark::Broken => return Origin::unreadable(None, Some("copy"), reason::MARK_BROKEN),
            Mark::Missing => return Origin::unreadable(None, None, reason::FOREIGN),
            Mark::Unreadable => return Origin::unreadable(None, None, reason::READ_FAILED),
        }
    } else {
        return Origin::unreadable(None, None, reason::FOREIGN);
    };

    if !source.is_dir() {
        return Origin::unreadable(Some(&source), Some(marker), reason::SOURCE_MISSING);
    }
    let shown = strip_verbatim(&fs::canonicalize(&source).unwrap_or_else(|_| source.clone()));
    if same_path(&shown, &locations.repo_dir()) {
        return Origin {
            kind: OriginKind::Repo,
            path: Some(shown.display().to_string()),
            marker: Some(marker),
            reason: None,
        };
    }
    if !shown.join(script_name()).is_file() {
        return Origin::unreadable(Some(&shown), Some(marker), reason::SCRIPT_MISSING);
    }
    Origin {
        kind: OriginKind::Developer,
        path: Some(shown.display().to_string()),
        marker: Some(marker),
        reason: None,
    }
}

/// 스크립트를 돌릴 원본 폴더 — 개발자 모드면 그 원본, 아니면 `<하네스 폴더>/repo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub origin: Origin,
    pub dir: PathBuf,
}

impl Source {
    pub fn developer(&self) -> bool {
        self.origin.kind == OriginKind::Developer
    }

    /// 설치 스크립트의 절대 경로 (파일이 있을 때만)
    pub fn script(&self) -> Option<PathBuf> {
        let script = self.dir.join(script_name());
        script.is_file().then_some(script)
    }
}

pub fn resolve_source(locations: &Locations) -> Source {
    let origin = pick_origin(locations);
    let dir = match (origin.kind, &origin.path) {
        (OriginKind::Developer, Some(path)) => PathBuf::from(path),
        _ => locations.repo_dir(),
    };
    Source { origin, dir }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| OsString::from(v))
        }
    }

    fn abs(name: &str) -> String {
        if cfg!(windows) {
            format!("C:\\tmp\\{name}")
        } else {
            format!("/tmp/{name}")
        }
    }

    #[test]
    fn defaults_are_under_the_home_folder() {
        let loc = locations(env(&[]), Some(Path::new("/home/me"))).unwrap();
        assert_eq!(loc.claude_dir, Path::new("/home/me").join(".claude"));
        assert_eq!(
            loc.harness_home,
            Path::new("/home/me").join(".claude-harness")
        );
        assert!(!loc.claude_dir_from_env && !loc.harness_home_from_env);
        assert_eq!(loc.repo_dir(), loc.harness_home.join("repo"));
        assert_eq!(loc.backups_dir(), loc.harness_home.join("backups"));
    }

    #[test]
    fn environment_variables_win_and_each_is_independent() {
        let config = abs("cfg");
        let loc = locations(
            env(&[(CONFIG_DIR_VAR, &config)]),
            Some(Path::new("/home/me")),
        )
        .unwrap();
        assert_eq!(loc.claude_dir, PathBuf::from(&config));
        assert!(loc.claude_dir_from_env);
        assert_eq!(
            loc.harness_home,
            Path::new("/home/me").join(".claude-harness")
        );

        let home = abs("hh");
        let loc = locations(
            env(&[(HARNESS_HOME_VAR, &home)]),
            Some(Path::new("/home/me")),
        )
        .unwrap();
        assert_eq!(loc.harness_home, PathBuf::from(&home));
        assert!(loc.harness_home_from_env);
        assert_eq!(loc.claude_dir, Path::new("/home/me").join(".claude"));
    }

    #[test]
    fn with_both_variables_the_home_folder_is_not_needed() {
        let (config, home) = (abs("cfg"), abs("hh"));
        let loc = locations(
            env(&[(CONFIG_DIR_VAR, &config), (HARNESS_HOME_VAR, &home)]),
            None,
        )
        .unwrap();
        assert_eq!(loc.claude_dir, PathBuf::from(config));
        assert_eq!(loc.harness_home, PathBuf::from(home));
    }

    #[test]
    fn empty_values_count_as_unset() {
        let loc = locations(
            env(&[(CONFIG_DIR_VAR, ""), (HARNESS_HOME_VAR, "")]),
            Some(Path::new("/home/me")),
        )
        .unwrap();
        assert!(!loc.claude_dir_from_env && !loc.harness_home_from_env);
    }

    #[test]
    fn relative_values_and_a_missing_home_are_refused_not_guessed() {
        assert_eq!(
            locations(env(&[(CONFIG_DIR_VAR, "rel/dir")]), Some(Path::new("/h"))),
            Err(LocationError::ConfigDirNotAbsolute)
        );
        assert_eq!(
            locations(env(&[(HARNESS_HOME_VAR, ".")]), Some(Path::new("/h"))),
            Err(LocationError::HarnessHomeNotAbsolute)
        );
        assert_eq!(locations(env(&[]), None), Err(LocationError::NoHome));
        let config = abs("cfg");
        // 하네스 폴더만 홈 폴더가 필요한데 홈이 없다
        assert_eq!(
            locations(env(&[(CONFIG_DIR_VAR, &config)]), None),
            Err(LocationError::NoHome)
        );
        assert_eq!(LocationError::NoHome.code(), "no_home");
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_prefixes_are_removed_for_display() {
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\C:\Users\me\x")),
            PathBuf::from(r"C:\Users\me\x")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\wsl.localhost\Ubuntu\home")),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home")
        );
        assert_eq!(
            strip_verbatim(Path::new(r"C:\plain")),
            PathBuf::from(r"C:\plain")
        );
        // 장치 경로 같은 다른 `\\?\` 모양은 그대로 둔다
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\Volume{1234}\x")),
            PathBuf::from(r"\\?\Volume{1234}\x")
        );
    }

    #[test]
    fn only_real_network_shares_count_as_network_paths() {
        for network in [
            r"\\fileserver\share\claude-harness",
            r"\\10.0.0.5\share",
            "//fileserver/share/x",
            r"\\?\UNC\fileserver\share\x",
            r"\\localhost\c$\x",
        ] {
            assert!(is_network_share(network), "{network}");
        }
        for local in [
            r"\\wsl.localhost\Ubuntu-24.04\home\me\claude-harness",
            r"\\WSL.LOCALHOST\Ubuntu\home",
            r"\\wsl$\Ubuntu\home\me",
            r"\\?\UNC\wsl.localhost\Ubuntu\home",
            r"C:\Users\me\claude-harness",
            r"\\?\C:\Users\me",
            r"\\.\pipe\x",
            "/home/me/claude-harness",
            "//",
            "",
            r"\\",
        ] {
            assert!(!is_network_share(local), "{local}");
        }
    }

    #[test]
    fn the_default_location_is_recognised_even_when_spelled_differently() {
        let home = TempDir::new("default-loc");
        let claude = home.join(".claude");
        fs::create_dir_all(&claude).unwrap();
        assert!(is_default_location(&claude, Some(home.path()), ".claude"));
        // `..` 를 거치거나 끝에 구분자가 붙어도 같은 폴더
        assert!(is_default_location(
            &home.join("x").join("..").join(".claude"),
            Some(home.path()),
            ".claude"
        ));
        let slash = PathBuf::from(format!("{}{}", claude.display(), std::path::MAIN_SEPARATOR));
        assert!(is_default_location(&slash, Some(home.path()), ".claude"));
        // 다른 폴더 · 다른 이름 · 홈을 모를 때는 기본 위치가 아니다
        assert!(!is_default_location(
            &home.join("sandbox"),
            Some(home.path()),
            ".claude"
        ));
        assert!(!is_default_location(
            &claude,
            Some(home.path()),
            ".claude-harness"
        ));
        assert!(!is_default_location(&claude, None, ".claude"));
    }

    #[test]
    fn same_path_ignores_trailing_separators_and_follows_real_folders() {
        let dir = TempDir::new("same-path");
        let sub = dir.join("a");
        fs::create_dir_all(&sub).unwrap();
        assert!(same_path(&sub, &sub.join("..").join("a")));
        let with_slash = PathBuf::from(format!("{}{}", sub.display(), std::path::MAIN_SEPARATOR));
        assert!(same_path(&sub, &with_slash));
        assert!(!same_path(&sub, &dir.join("b")));
        // 없는 폴더는 글자로 비교한다
        assert!(same_path(&dir.join("zz"), &dir.join("zz")));
        assert!(!same_path(&dir.join("zz"), &dir.join("zy")));
    }

    // ───────────── 원본 고르기: 복사 표시 · 깨진 표시 · 없음 (링크 · 정션은 tests/harness_origin.rs) ─────────────

    fn fixture(name: &str) -> (TempDir, Locations) {
        let root = TempDir::new(name);
        let loc = Locations {
            claude_dir: root.join("claude"),
            harness_home: root.join("hh"),
            claude_dir_from_env: true,
            harness_home_from_env: true,
        };
        fs::create_dir_all(&loc.claude_dir).unwrap();
        fs::create_dir_all(&loc.harness_home).unwrap();
        (root, loc)
    }

    fn make_source(dir: &Path, with_script: bool) {
        fs::create_dir_all(dir).unwrap();
        if with_script {
            fs::write(dir.join(script_name()), "# fake\n").unwrap();
        }
    }

    fn write_mark(loc: &Locations, text: &str) {
        let harness = loc.installed_harness();
        fs::create_dir_all(&harness).unwrap();
        fs::write(harness.join(MARK_FILE), text).unwrap();
    }

    #[test]
    fn no_installed_harness_means_the_normal_flow() {
        let (_root, loc) = fixture("origin-none");
        let origin = pick_origin(&loc);
        assert_eq!(origin.kind, OriginKind::None);
        assert_eq!(origin.path, None);
        let source = resolve_source(&loc);
        assert!(!source.developer());
        assert_eq!(source.dir, loc.repo_dir());
        assert_eq!(source.script(), None); // repo 가 아직 없다
    }

    #[test]
    fn a_copy_mark_pointing_elsewhere_is_developer_mode() {
        let (root, loc) = fixture("origin-copy-dev");
        let dev = root.join("my-clone");
        make_source(&dev, true);
        write_mark(&loc, &format!("copy\n{}\n", dev.display()));
        let origin = pick_origin(&loc);
        assert_eq!(origin.kind, OriginKind::Developer);
        assert_eq!(origin.marker, Some("copy"));
        assert!(same_path(Path::new(origin.path.as_ref().unwrap()), &dev));
        let source = resolve_source(&loc);
        assert!(source.developer());
        assert!(same_path(&source.dir, &dev));
        assert!(source.script().is_some());
    }

    #[test]
    fn a_copy_mark_pointing_at_our_repo_is_the_normal_flow() {
        let (_root, loc) = fixture("origin-copy-repo");
        make_source(&loc.repo_dir(), true);
        write_mark(&loc, &format!("copy\n{}\n", loc.repo_dir().display()));
        let origin = pick_origin(&loc);
        assert_eq!(origin.kind, OriginKind::Repo);
        assert!(!resolve_source(&loc).developer());
        // 끝에 구분자가 붙어도 같은 곳이다
        write_mark(
            &loc,
            &format!(
                "copy\n{}{}\n",
                loc.repo_dir().display(),
                std::path::MAIN_SEPARATOR
            ),
        );
        assert_eq!(pick_origin(&loc).kind, OriginKind::Repo);
    }

    #[test]
    fn crlf_and_bom_in_the_mark_file_are_read() {
        let (root, loc) = fixture("origin-crlf");
        let dev = root.join("clone");
        make_source(&dev, true);
        write_mark(&loc, &format!("\u{feff}copy\r\n{}\r\n", dev.display()));
        assert_eq!(pick_origin(&loc).kind, OriginKind::Developer);
    }

    #[test]
    fn broken_marks_are_reported_and_the_normal_flow_is_used() {
        let (root, loc) = fixture("origin-broken");
        let dev = root.join("clone");
        make_source(&dev, true);
        let relative = "copy\nsome/relative/path\n";
        let bad_first = format!("link\n{}\n", dev.display());
        let no_second = "copy\n".to_string();
        let blank_second = "copy\n   \n".to_string();
        for (text, label) in [
            ("", "빈 파일"),
            ("garbage", "첫 줄이 copy 가 아님"),
            (relative, "상대 경로"),
            (bad_first.as_str(), "첫 줄이 link"),
            (no_second.as_str(), "둘째 줄 없음"),
            (blank_second.as_str(), "둘째 줄이 빔"),
        ] {
            write_mark(&loc, text);
            let origin = pick_origin(&loc);
            assert_eq!(origin.kind, OriginKind::Unreadable, "{label}");
            assert_eq!(origin.reason, Some(reason::MARK_BROKEN), "{label}");
            let source = resolve_source(&loc);
            assert!(!source.developer(), "{label}");
            assert_eq!(source.dir, loc.repo_dir(), "{label}");
        }
    }

    #[test]
    fn a_source_that_is_gone_or_has_no_script_is_not_developer_mode() {
        let (root, loc) = fixture("origin-gone");
        let gone = root.join("deleted-clone");
        write_mark(&loc, &format!("copy\n{}\n", gone.display()));
        let origin = pick_origin(&loc);
        assert_eq!(origin.kind, OriginKind::Unreadable);
        assert_eq!(origin.reason, Some(reason::SOURCE_MISSING));
        assert!(origin.path.is_some(), "가리키던 곳은 화면에 보인다");

        let empty = root.join("empty-clone");
        make_source(&empty, false);
        write_mark(&loc, &format!("copy\n{}\n", empty.display()));
        let origin = pick_origin(&loc);
        assert_eq!(origin.kind, OriginKind::Unreadable);
        assert_eq!(origin.reason, Some(reason::SCRIPT_MISSING));
        // 다른 OS 의 스크립트만 있어도 이 OS 에서는 못 돌린다
        let other = if cfg!(windows) {
            "install.sh"
        } else {
            "install.ps1"
        };
        fs::write(empty.join(other), "x").unwrap();
        assert_eq!(pick_origin(&loc).reason, Some(reason::SCRIPT_MISSING));
    }

    #[test]
    fn a_folder_without_a_mark_or_a_plain_file_is_foreign() {
        let (_root, loc) = fixture("origin-foreign");
        fs::create_dir_all(loc.installed_harness()).unwrap();
        let origin = pick_origin(&loc);
        assert_eq!(origin.kind, OriginKind::Unreadable);
        assert_eq!(origin.reason, Some(reason::FOREIGN));
        fs::remove_dir_all(loc.installed_harness()).unwrap();
        fs::write(loc.installed_harness(), "x").unwrap();
        assert_eq!(pick_origin(&loc).reason, Some(reason::FOREIGN));
    }

    #[test]
    fn a_huge_mark_file_is_only_read_up_to_the_limit() {
        let (_root, loc) = fixture("origin-huge");
        let mut text = String::from("copy\n");
        text.push_str(&"x".repeat(200_000));
        write_mark(&loc, &text);
        // 앞 8KB 만 읽고 (둘째 줄이 한 줄로 길다) 절대 경로가 아니라서 깨진 표시
        assert_eq!(pick_origin(&loc).reason, Some(reason::MARK_BROKEN));
    }
}
