//! 하네스 상태 — 위치 · 원본(개발자 모드) · 받은 원본(repo) · git · Git Bash. 읽기만 한다 (실제 폴더에 돌려 봐도 된다).

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::git::{self, GitBashInfo, GitInfo, RepoCheck};
use super::locate::{
    self, LocationError, Origin, is_default_location, is_network_path, resolve_source,
};
use super::{Context, KEEP_BACKUPS};

/// 받은 원본(`<하네스 폴더>/repo`)의 모양
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    /// 폴더가 있다
    pub present: bool,
    /// git 으로 확인한 결과: 우리 원본이다 (git 이 없거나 `repo` 가 없으면 `None`)
    pub usable: Option<bool>,
    /// `not_git_repo` · `remote_mismatch` · `check_failed`
    pub problem: Option<String>,
    /// 원격 주소 (계정 정보는 지웠다)
    pub remote: Option<String>,
    pub head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    /// 지금 쓰는 `~/.claude` (위치를 정하지 못했으면 `None`)
    pub claude_dir: Option<String>,
    /// 지금 쓰는 하네스 폴더
    pub harness_home: Option<String>,
    /// 환경 변수로 정한 위치인가 (아니면 기본 위치 = 실제 폴더일 수 있다)
    pub claude_dir_from_env: bool,
    pub harness_home_from_env: bool,
    /// 이 PC 의 기본 위치(`~/.claude` · `~/.claude-harness`)와 같은 폴더인가 — 환경 변수로 정했어도 기본 위치를 가리키면 `true` (실제 폴더)
    pub claude_dir_is_default: bool,
    pub harness_home_is_default: bool,
    /// 위치를 정하지 못한 이유 (`no_home` · `config_dir_not_absolute` · `harness_home_not_absolute`)
    pub problem: Option<&'static str>,
    pub repo_dir: Option<String>,
    pub repo: Option<RepoStatus>,
    /// `~/.claude/harness` 가 가리키는 원본
    pub origin: Origin,
    /// 개발자 모드 — 다른 원본을 쓰는 중이라 받기 · 업데이트를 하지 않는다
    pub developer_mode: bool,
    /// 스크립트를 돌릴 원본 폴더 (개발자 원본 또는 `repo`)
    pub source_dir: Option<String>,
    /// 돌릴 설치 스크립트 (파일이 있을 때만)
    pub script_path: Option<String>,
    /// 원본이 네트워크 공유(UNC `\\서버\공유`)에 있다 — WSL(`\\wsl.localhost\…`)은 아니다. 막지는 않고 알린다 (D-20: 사용자 자신의 설정)
    pub source_is_network: bool,
    pub git: GitInfo,
    pub git_bash: GitBashInfo,
    pub keep_backups: usize,
}

fn repo_status(ctx: &Context) -> RepoStatus {
    let repo = ctx.locations.repo_dir();
    let present = std::fs::symlink_metadata(&repo).is_ok();
    let mut status = RepoStatus {
        present,
        usable: None,
        problem: None,
        remote: None,
        head: None,
    };
    let Some(git_exe) = ctx.git.as_deref().filter(|_| present) else {
        return status;
    };
    match git::inspect_repo(ctx, git_exe) {
        Ok(RepoCheck::Ok { head }) => {
            status.usable = Some(true);
            status.head = head;
        }
        Ok(RepoCheck::Missing) => status.present = false,
        Ok(RepoCheck::NotARepo) => {
            status.usable = Some(false);
            status.problem = Some("not_git_repo".into());
        }
        Ok(RepoCheck::WrongRemote { remote }) => {
            status.usable = Some(false);
            status.problem = Some("remote_mismatch".into());
            status.remote = remote;
        }
        Err(_) => {
            status.usable = Some(false);
            status.problem = Some("check_failed".into());
        }
    }
    status
}

/// 위치를 정하지 못해도 git 은 알려 준다 (화면이 안내를 보일 수 있게)
fn broken(error: LocationError) -> HarnessStatus {
    // 위치가 없으니 위치를 쓰지 않는 확인(git · Git Bash 찾기)에만 쓰는 빈 틀
    let probe = Context::new(
        locate::Locations {
            claude_dir: PathBuf::new(),
            harness_home: PathBuf::new(),
            claude_dir_from_env: false,
            harness_home_from_env: false,
        },
        git::locate_git_here(),
    );
    HarnessStatus {
        claude_dir: None,
        harness_home: None,
        claude_dir_from_env: false,
        harness_home_from_env: false,
        claude_dir_is_default: false,
        harness_home_is_default: false,
        problem: Some(error.code()),
        repo_dir: None,
        repo: None,
        origin: Origin {
            kind: locate::OriginKind::None,
            path: None,
            marker: None,
            reason: None,
        },
        developer_mode: false,
        source_dir: None,
        script_path: None,
        source_is_network: false,
        git: git::git_info(&probe),
        git_bash: git::git_bash_info(&probe),
        keep_backups: KEEP_BACKUPS,
    }
}

pub fn status(ctx: &Context) -> HarnessStatus {
    status_with_home(ctx, std::env::home_dir().as_deref())
}

/// `home` 을 바깥에서 받는 `status` (기본 위치와 같은지 볼 홈 폴더를 시험이 정할 수 있게)
pub fn status_with_home(ctx: &Context, home: Option<&Path>) -> HarnessStatus {
    let source = resolve_source(&ctx.locations);
    HarnessStatus {
        claude_dir: Some(ctx.locations.claude_dir.display().to_string()),
        harness_home: Some(ctx.locations.harness_home.display().to_string()),
        claude_dir_from_env: ctx.locations.claude_dir_from_env,
        harness_home_from_env: ctx.locations.harness_home_from_env,
        claude_dir_is_default: is_default_location(&ctx.locations.claude_dir, home, ".claude"),
        harness_home_is_default: is_default_location(
            &ctx.locations.harness_home,
            home,
            ".claude-harness",
        ),
        problem: None,
        repo_dir: Some(ctx.locations.repo_dir().display().to_string()),
        repo: Some(repo_status(ctx)),
        developer_mode: source.developer(),
        source_dir: Some(source.dir.display().to_string()),
        script_path: source.script().map(|p| p.display().to_string()),
        source_is_network: is_network_path(&source.dir),
        origin: source.origin,
        git: git::git_info(ctx),
        git_bash: git::git_bash_info(ctx),
        keep_backups: KEEP_BACKUPS,
    }
}

/// 이 PC 의 환경으로 본 상태
pub fn status_here() -> HarnessStatus {
    match Context::here() {
        Ok(ctx) => status(&ctx),
        Err(error) => broken(error),
    }
}
