//! CLI 를 띄우는 작업 폴더 (P10-08, D-54) — `claude --version` · `auth status` · 로그인 창 · `/usage` 와, `run_capture` 로 돌리는 git · 설치 스크립트가
//! 모두 OS 의 공용 임시 폴더가 아니라 **앱 전용 빈 폴더**에서 돈다. 세션(`session.rs`)은 프로젝트 폴더 그대로다.
//!
//! 이유: Linux 에서 `std::env::temp_dir()` 은 모든 사용자가 같이 쓰는 `/tmp` 다. 남이 `/tmp/.claude/settings.json` 에 훅을 넣어 두면
//! `claude -p` 는 신뢰 확인 없이 그 설정을 읽어 사용량 읽기마다 훅을 실행한다. 앱 전용 폴더는 그 사용자만 쓸 수 있는 앱 로컬 데이터 폴더 안이다.
//!
//! - 위치: `<앱 로컬 데이터 폴더>/cli-work` (`lib.rs` 의 setup 이 `init` 으로 알린다. Windows 는 `%LOCALAPPDATA%\<앱 식별자>\cli-work`).
//! - 안에 아무것도 두지 않는다. 띄우기 직전마다 폴더가 없으면 만들고(유닉스는 0700), CLI 가 읽는 프로젝트 설정 이름(`.claude` · `.claude.json` · `.mcp.json` ·
//!   `CLAUDE.md` · `CLAUDE.local.md`)이 생겨 있으면 지운다 (링크면 링크만 지우고 따라가지 않는다). 그 밖의 파일은 건드리지 않는다.
//! - `init` 을 부르지 않았으면 (단위 · 통합 시험) 예전처럼 OS 임시 폴더다. 시험은 `ClaudeCommand::with_work_dir` 로 폴더를 정한다.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri_plugin_log::log;

/// 앱 로컬 데이터 폴더 아래 폴더 이름
pub const DIR_NAME: &str = "cli-work";

/// CLI 가 작업 폴더에서 읽는 프로젝트 설정 이름 — 이 폴더에는 생기면 안 된다
const STRAY_NAMES: &[&str] = &[
    ".claude",
    ".claude.json",
    ".mcp.json",
    "CLAUDE.md",
    "CLAUDE.local.md",
];

static APP_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 앱 전용 작업 폴더를 알린다 (앱이 뜰 때 한 번). 이미 알렸으면 `false` 이고 처음 것이 남는다.
pub fn init(dir: PathBuf) -> bool {
    APP_DIR.set(dir).is_ok()
}

/// 지금 알려진 앱 전용 작업 폴더 (`init` 전이면 `None`)
pub fn app_dir() -> Option<&'static Path> {
    APP_DIR.get().map(PathBuf::as_path)
}

/// 폴더를 쓸 수 있게 한다 — 없으면 만들고, 있으면 안 되는 설정 이름을 지운다.
pub fn prepare(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    for name in STRAY_NAMES {
        remove_stray(&dir.join(name))?;
    }
    Ok(())
}

/// 이 경로가 있으면 지운다 (폴더는 통째로, 링크는 링크만)
fn remove_stray(path: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let is_link = meta.file_type().is_symlink();
    let removed = if meta.is_dir() && !is_link {
        fs::remove_dir_all(path)
    } else {
        // 폴더를 가리키는 링크는 Windows 에서 폴더 지우기 호출로만 지워진다
        fs::remove_file(path).or_else(|err| {
            if is_link {
                fs::remove_dir(path)
            } else {
                Err(err)
            }
        })
    };
    match removed {
        Ok(()) => {
            let name = path
                .file_name()
                .map_or_else(String::new, |name| name.to_string_lossy().into_owned());
            log::warn!("cli-work: removed a stray {name} from the CLI work folder");
            Ok(())
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

/// 자식을 띄울 작업 폴더를 정하고 쓸 수 있게 한다. `explicit`(시험이 정한 폴더)가 먼저, 다음이 앱 전용 폴더, 알려진 것이 없으면 OS 임시 폴더.
/// 앱 전용 폴더를 만들거나 비우지 못하면 오류다 — 공용 임시 폴더로 몰래 돌아가지 않는다.
pub fn for_spawn(explicit: Option<&Path>) -> io::Result<PathBuf> {
    let chosen: Option<&Path> = explicit.or(app_dir());
    if let Some(dir) = chosen {
        prepare(dir)?;
        return Ok(dir.to_path_buf());
    }
    Ok(std::env::temp_dir())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    #[test]
    fn a_missing_folder_is_created() {
        let root = TempDir::new("workdir-create");
        let dir = root.join("a").join("cli-work");
        prepare(&dir).unwrap();
        assert!(dir.is_dir());
        // 두 번 불러도 같다
        prepare(&dir).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[test]
    fn project_settings_that_appear_are_removed() {
        let root = TempDir::new("workdir-stray");
        let dir = root.join("cli-work");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude").join("settings.json"), "{\"hooks\":{}}").unwrap();
        fs::write(dir.join(".claude").join("settings.local.json"), "{}").unwrap();
        fs::write(dir.join(".claude.json"), "{}").unwrap();
        fs::write(dir.join(".mcp.json"), "{}").unwrap();
        fs::write(dir.join("CLAUDE.md"), "x").unwrap();
        fs::write(dir.join("CLAUDE.local.md"), "x").unwrap();
        // 그 밖의 파일은 건드리지 않는다
        fs::write(dir.join("keep.txt"), "keep").unwrap();
        prepare(&dir).unwrap();
        let mut left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["keep.txt"]);
    }

    #[test]
    fn a_link_in_place_of_the_settings_folder_is_removed_without_following_it() {
        let root = TempDir::new("workdir-link");
        let dir = root.join("cli-work");
        let elsewhere = root.join("elsewhere");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("precious.txt"), "do not delete").unwrap();
        if !crate::custom::test_support::make_dir_link(&dir.join(".claude"), &elsewhere) {
            return; // 이 PC 는 링크를 만들 수 없다
        }
        prepare(&dir).unwrap();
        assert!(fs::symlink_metadata(dir.join(".claude")).is_err());
        assert_eq!(
            fs::read_to_string(elsewhere.join("precious.txt")).unwrap(),
            "do not delete"
        );
    }

    #[test]
    fn an_explicit_folder_is_prepared_and_used_even_when_the_app_folder_is_known() {
        let root = TempDir::new("workdir-explicit");
        let dir = root.join("mine");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude").join("settings.json"), "{}").unwrap();
        let chosen = for_spawn(Some(&dir)).unwrap();
        assert_eq!(chosen, dir.to_path_buf());
        assert!(!dir.join(".claude").exists());
    }

    #[test]
    fn a_folder_that_cannot_be_made_is_an_error_not_a_fallback_to_the_temp_folder() {
        let root = TempDir::new("workdir-blocked");
        // 폴더 자리에 파일이 있다
        let blocked = root.join("file");
        fs::write(&blocked, "x").unwrap();
        assert!(for_spawn(Some(&blocked.join("cli-work"))).is_err());
    }

    #[test]
    fn without_an_app_folder_the_os_temp_folder_is_used_as_before() {
        // 단위 시험 프로세스는 `init` 을 부르지 않는다
        assert!(app_dir().is_none());
        assert_eq!(for_spawn(None).unwrap(), std::env::temp_dir());
    }
}
