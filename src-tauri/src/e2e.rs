//! E2E 시험용 데이터 폴더 (P10-11) — **개발 빌드에서만**, 환경 변수 `NYANITOR_E2E_DIR` 하나로 앱의 모든 쓰기 위치를 시험용 폴더로 돌린다.
//! 실제 앱 창으로 E2E 를 돌려도 고객의 프로젝트 목록 · 채팅 기록 DB · 신뢰 기록 · 창 위치 · 로그를 건드리지 않게 하려는 것이다.
//!
//! 방법: Tauri 의 `app > appDirectoriesOverride` 설정을 앱이 만들어지기 전에 바꿔 끼운다 (`apply_to_config`).
//! 그러면 `app.path()` 의 `app_data_dir` · `app_local_data_dir` (+ 웹뷰 데이터와 `cli-work`) · `app_log_dir` (로그 플러그인) ·
//! `app_config_dir` (window-state 파일) · `app_cache_dir` 가 모두 이 모듈이 정한 하위 폴더를 가리킨다 — 코드 곳곳은 그대로 `app.path()` 를 부르고,
//! 위치를 정하는 곳은 `data_root()` 한 곳이다.
//!
//! - 출시 빌드 (`cfg!(debug_assertions)` 거짓) 에서는 환경 변수를 읽지도 않고 완전히 무시한다 — 설치본에서 남이 데이터 위치를 바꾸지 못하게.
//! - 값이 비었거나 절대 경로가 아니면 무시하고 (평소 위치) 로그를 남긴다. 상대 경로는 "어디" 인지 정할 수 없어서다.
//! - 이 모드에서는 single-instance 를 등록하지 않는다 (고객 앱이 떠 있어도 시험 앱이 거기에 붙고 꺼지지 않게).
//!   window-state 는 메인 창을 제외한 채 등록한다 — 저장된 창 위치를 되살리지도 저장하지도 않는다 (`lib.rs`, 이유는 거기).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides, Config};
use tauri_plugin_log::log;

/// 시험용 폴더의 뿌리 (절대 경로, 개발 빌드만)
pub const DIR_VAR: &str = "NYANITOR_E2E_DIR";

/// 시험용 폴더 아래의 하위 폴더 이름 — 서로 겹치지 않게 나눈다
const DATA: &str = "data";
const LOCAL: &str = "local";
const LOGS: &str = "logs";
const CONFIG: &str = "config";
const CACHE: &str = "cache";

/// 시험 모드에서 앱이 쓰는 폴더들 (뿌리 아래)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirs {
    pub root: PathBuf,
    /// 앱 데이터 — 앱 DB · 옛 세션 파일 · 도중 끝남 표시
    pub data: PathBuf,
    /// 앱 로컬 데이터 — 웹뷰 데이터 · `cli-work`
    pub local: PathBuf,
    /// 로그
    pub logs: PathBuf,
    /// 앱 설정 폴더 — window-state 파일 자리 (메인 창은 쓰지 않는다)
    pub config: PathBuf,
    /// 앱 캐시
    pub cache: PathBuf,
}

impl Dirs {
    pub fn under(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            data: root.join(DATA),
            local: root.join(LOCAL),
            logs: root.join(LOGS),
            config: root.join(CONFIG),
            cache: root.join(CACHE),
        }
    }
}

/// 환경 변수를 무시한 이유 (출시 빌드는 이유 없이 `Mode::Off`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ignored {
    /// 값이 비었다
    Empty,
    /// 절대 경로가 아니다 (상대 경로 · `\foo` · `C:foo`)
    NotAbsolute,
}

impl Ignored {
    fn describe(self) -> &'static str {
        match self {
            Ignored::Empty => "the value is empty",
            Ignored::NotAbsolute => "the value is not an absolute path",
        }
    }
}

/// 이 실행의 시험 모드 판단
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// 평소대로 — 환경 변수가 없거나, 출시 빌드다
    Off,
    /// 환경 변수가 있었지만 쓸 수 없어 평소 위치를 쓴다
    Ignored(Ignored),
    /// 시험 폴더를 쓴다
    Active(Dirs),
}

/// 판단 한 곳 (순수 함수 — 시험에서 빌드 종류 · 값을 끼워 넣는다).
/// 출시 빌드(`debug_build` 거짓)는 값이 무엇이든 `Off`.
pub fn decide(debug_build: bool, value: Option<&OsStr>) -> Mode {
    if !debug_build {
        return Mode::Off;
    }
    let Some(value) = value else {
        return Mode::Off;
    };
    if value.is_empty() {
        return Mode::Ignored(Ignored::Empty);
    }
    let root = Path::new(value);
    if !root.is_absolute() {
        return Mode::Ignored(Ignored::NotAbsolute);
    }
    Mode::Active(Dirs::under(root))
}

/// 이 프로세스의 판단 — 처음 부를 때 한 번 정하고 그대로 쓴다 (환경 변수는 출시 빌드에서 읽지도 않는다).
pub fn mode() -> &'static Mode {
    static MODE: OnceLock<Mode> = OnceLock::new();
    MODE.get_or_init(|| {
        let value = if cfg!(debug_assertions) {
            std::env::var_os(DIR_VAR)
        } else {
            None
        };
        decide(cfg!(debug_assertions), value.as_deref())
    })
}

/// 시험 모드면 그 폴더들 — 앱의 쓰기 위치는 이것으로만 정해진다.
pub fn data_root() -> Option<&'static Dirs> {
    match mode() {
        Mode::Active(dirs) => Some(dirs),
        Mode::Off | Mode::Ignored(_) => None,
    }
}

/// Tauri 설정의 앱 폴더 덮어쓰기를 시험 폴더로 정한다 (앱을 만들기 전에).
pub fn apply_to_config(config: &mut Config, dirs: &Dirs) {
    let overrides = AppDirectoryOverrides {
        config: Some(dirs.config.clone()),
        data: Some(dirs.data.clone()),
        local_data: Some(dirs.local.clone()),
        cache: Some(dirs.cache.clone()),
        log: Some(dirs.logs.clone()),
    };
    config.app.app_directories_override = Some(AppDirectoriesOverride::Directories(overrides));
}

/// 로그에 남긴다 — 시험 모드로 떴다는 것(로그의 첫 줄)이나, 환경 변수를 무시했다는 것. 로그 플러그인이 켜진 뒤(`setup`)에 부른다.
pub fn announce() {
    match mode() {
        Mode::Off => {}
        Mode::Ignored(reason) => {
            log::warn!(
                "{DIR_VAR} ignored: {} — using the normal folders",
                reason.describe()
            );
        }
        Mode::Active(dirs) => log::warn!(
            "E2E mode: every app folder is under {} (data · local · logs · config · cache); single-instance is off and the saved window position is not used",
            dirs.root.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[cfg(windows)]
    const ABS: &str = r"C:\nyanitor-e2e";
    #[cfg(not(windows))]
    const ABS: &str = "/tmp/nyanitor-e2e";

    #[test]
    fn a_release_build_ignores_the_variable_entirely() {
        let value = OsString::from(ABS);
        assert_eq!(decide(false, Some(&value)), Mode::Off);
        // 비었거나 상대 경로여도 이유를 내지 않는다 (출시 빌드는 변수를 보지도 않는다)
        assert_eq!(decide(false, Some(OsStr::new(""))), Mode::Off);
        assert_eq!(decide(false, Some(OsStr::new("rel/dir"))), Mode::Off);
        assert_eq!(decide(false, None), Mode::Off);
    }

    #[test]
    fn without_the_variable_nothing_changes() {
        assert_eq!(decide(true, None), Mode::Off);
    }

    #[test]
    fn an_empty_value_is_ignored() {
        assert_eq!(
            decide(true, Some(OsStr::new(""))),
            Mode::Ignored(Ignored::Empty)
        );
    }

    #[test]
    fn a_relative_path_is_ignored() {
        for value in ["e2e", "./e2e", "../e2e", "data/e2e", " "] {
            assert_eq!(
                decide(true, Some(OsStr::new(value))),
                Mode::Ignored(Ignored::NotAbsolute),
                "{value:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_half_absolute_paths_are_ignored() {
        // 드라이브 없는 루트 · 루트 없는 드라이브는 어디인지 정할 수 없다
        for value in [r"\e2e", r"C:e2e", "/e2e"] {
            assert_eq!(
                decide(true, Some(OsStr::new(value))),
                Mode::Ignored(Ignored::NotAbsolute),
                "{value:?}"
            );
        }
    }

    #[test]
    fn an_absolute_path_in_a_debug_build_activates_the_mode() {
        let Mode::Active(dirs) = decide(true, Some(OsStr::new(ABS))) else {
            panic!("expected the e2e mode");
        };
        assert_eq!(dirs.root, Path::new(ABS));
    }

    #[test]
    fn the_folders_are_separate_and_all_under_the_root() {
        let dirs = Dirs::under(Path::new(ABS));
        let all = [
            &dirs.data,
            &dirs.local,
            &dirs.logs,
            &dirs.config,
            &dirs.cache,
        ];
        for dir in all {
            assert!(dir.starts_with(&dirs.root), "{dir:?}");
            assert_ne!(dir, &dirs.root);
        }
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b);
                assert!(!a.starts_with(b) && !b.starts_with(a), "{a:?} / {b:?}");
            }
        }
        assert_eq!(dirs.data, Path::new(ABS).join("data"));
        assert_eq!(dirs.local, Path::new(ABS).join("local"));
        assert_eq!(dirs.logs, Path::new(ABS).join("logs"));
    }

    #[test]
    fn the_config_override_points_every_app_folder_into_the_root() {
        let dirs = Dirs::under(Path::new(ABS));
        let mut config = Config::default();
        assert!(config.app.app_directories_override.is_none());
        apply_to_config(&mut config, &dirs);
        let Some(AppDirectoriesOverride::Directories(set)) = &config.app.app_directories_override
        else {
            panic!("expected per-folder overrides");
        };
        assert_eq!(set.data.as_ref(), Some(&dirs.data));
        assert_eq!(set.local_data.as_ref(), Some(&dirs.local));
        assert_eq!(set.log.as_ref(), Some(&dirs.logs));
        assert_eq!(set.config.as_ref(), Some(&dirs.config));
        assert_eq!(set.cache.as_ref(), Some(&dirs.cache));
    }
}
