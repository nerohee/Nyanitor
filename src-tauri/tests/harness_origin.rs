//! 원본 고르기 시험 — 링크 · 정션으로 설치된 개발자 환경, 링크 대상이 사라진 경우, 상태 한눈에 (P4-02).
//! 임시 폴더만 쓴다 (실제 `~/.claude` · `~/.claude-harness` 는 읽지도 않는다).

mod common;

use std::fs;
use std::path::Path;

use common::*;
use nyanitor_lib::harness::locate::{
    OriginKind, pick_origin, reason, resolve_source, same_path, script_name,
};
use nyanitor_lib::harness::status::status;

fn make_clone(dir: &Path, with_script: bool) {
    fs::create_dir_all(dir).unwrap();
    if with_script {
        fs::write(dir.join(script_name()), "# fake\n").unwrap();
    }
}

#[test]
fn a_link_to_another_clone_is_developer_mode() {
    let h = HarnessRoot::new("origin-link-dev");
    let clone = h.root.join("my-clone");
    make_clone(&clone, true);
    assert!(
        make_dir_link(&h.locations.installed_harness(), &clone),
        "링크를 만들 수 있어야 한다"
    );

    let origin = pick_origin(&h.locations);
    assert_eq!(origin.kind, OriginKind::Developer);
    assert_eq!(origin.marker, Some("link"));
    // 화면에 보이는 경로는 `\\?\` 없이 사람이 아는 모양
    let shown = origin.path.clone().unwrap();
    assert!(!shown.starts_with(r"\\?\"), "{shown}");
    assert!(same_path(Path::new(&shown), &clone));

    let source = resolve_source(&h.locations);
    assert!(source.developer());
    assert!(source.script().is_some());
}

#[test]
fn a_link_to_our_own_repo_is_the_normal_flow() {
    let h = HarnessRoot::new("origin-link-repo");
    make_clone(&h.locations.repo_dir(), true);
    assert!(make_dir_link(
        &h.locations.installed_harness(),
        &h.locations.repo_dir()
    ));
    let origin = pick_origin(&h.locations);
    assert_eq!(origin.kind, OriginKind::Repo);
    assert_eq!(origin.marker, Some("link"));
    assert!(!resolve_source(&h.locations).developer());
}

#[test]
fn a_link_whose_target_was_deleted_is_reported_and_the_normal_flow_is_used() {
    let h = HarnessRoot::new("origin-link-broken");
    let clone = h.root.join("gone-clone");
    make_clone(&clone, true);
    assert!(make_dir_link(&h.locations.installed_harness(), &clone));
    fs::remove_dir_all(&clone).unwrap();
    let origin = pick_origin(&h.locations);
    assert_eq!(origin.kind, OriginKind::Unreadable);
    assert!(
        matches!(
            origin.reason,
            Some(reason::LINK_BROKEN) | Some(reason::SOURCE_MISSING)
        ),
        "{origin:?}"
    );
    assert!(!resolve_source(&h.locations).developer());
    assert_eq!(resolve_source(&h.locations).dir, h.locations.repo_dir());
}

#[test]
fn a_link_to_a_folder_without_the_install_script_is_not_developer_mode() {
    let h = HarnessRoot::new("origin-link-noscript");
    let clone = h.root.join("empty-clone");
    make_clone(&clone, false);
    assert!(make_dir_link(&h.locations.installed_harness(), &clone));
    let origin = pick_origin(&h.locations);
    assert_eq!(origin.kind, OriginKind::Unreadable);
    assert_eq!(origin.reason, Some(reason::SCRIPT_MISSING));
}

#[test]
fn status_shows_the_locations_the_origin_and_that_nothing_is_cloned_yet() {
    let h = HarnessRoot::new("status-fresh");
    let st = status(&h.ctx());
    assert_eq!(
        st.claude_dir.as_deref(),
        Some(h.locations.claude_dir.to_str().unwrap())
    );
    assert_eq!(
        st.harness_home.as_deref(),
        Some(h.locations.harness_home.to_str().unwrap())
    );
    assert!(st.claude_dir_from_env && st.harness_home_from_env);
    assert_eq!(st.origin.kind, OriginKind::None);
    assert!(!st.developer_mode);
    assert_eq!(
        st.script_path, None,
        "원본을 받기 전에는 돌릴 스크립트가 없다"
    );
    let repo = st.repo.unwrap();
    assert!(!repo.present && repo.usable.is_none());
    assert!(st.git.found && st.git.version.is_some(), "{:?}", st.git);
    assert_eq!(st.keep_backups, 12);
    // 이 시험 폴더에 아무것도 만들어지지 않았다 (읽기만 한다)
    assert!(!h.locations.repo_dir().exists());
    assert!(!h.locations.backups_dir().exists());
}

#[test]
fn status_in_developer_mode_points_at_the_developer_source_and_its_script() {
    let h = HarnessRoot::new("status-dev");
    let clone = h.root.join("dev-clone");
    make_clone(&clone, true);
    fs::create_dir_all(h.locations.installed_harness()).unwrap();
    fs::write(
        h.locations.installed_harness().join(".install-mode"),
        format!("copy\n{}\n", clone.display()),
    )
    .unwrap();
    let st = status(&h.ctx());
    assert!(st.developer_mode);
    assert_eq!(st.origin.kind, OriginKind::Developer);
    assert_eq!(st.origin.marker, Some("copy"));
    assert!(same_path(
        Path::new(st.source_dir.as_deref().unwrap()),
        &clone
    ));
    assert!(st.script_path.unwrap().ends_with(script_name()));
}

#[test]
fn status_without_git_still_answers_and_says_so() {
    let h = HarnessRoot::new("status-nogit");
    fs::create_dir_all(h.locations.repo_dir()).unwrap();
    let st = status(&h.ctx_without_git());
    assert!(!st.git.found && st.git.path.is_none());
    // git 이 없으면 repo 가 있어도 확인하지 못한다 (있다는 것만 안다)
    let repo = st.repo.unwrap();
    assert!(repo.present);
    assert_eq!(repo.usable, None);
}

// ───────────────────────────── 실제 폴더 판별 · 네트워크 원본 (P4-06) ─────────────────────────────

use nyanitor_lib::harness::Context;
use nyanitor_lib::harness::locate::Locations;
use nyanitor_lib::harness::status::status_with_home;

/// `home` 아래 기본 위치(`.claude` · `.claude-harness`)를 환경 변수로 넘긴 것처럼 만든 상태
fn status_for(
    claude: &Path,
    harness_home: &Path,
    home: &Path,
) -> nyanitor_lib::harness::status::HarnessStatus {
    fs::create_dir_all(claude).unwrap();
    fs::create_dir_all(harness_home).unwrap();
    let locations = Locations {
        claude_dir: claude.to_path_buf(),
        harness_home: harness_home.to_path_buf(),
        claude_dir_from_env: true,
        harness_home_from_env: true,
    };
    status_with_home(&Context::new(locations, None), Some(home))
}

#[test]
fn status_tells_a_sandbox_from_the_real_default_even_when_both_come_from_environment_variables() {
    let h = HarnessRoot::new("status-default");
    let home = h.root.join("home");
    fs::create_dir_all(&home).unwrap();
    let sandbox = h.root.join("sandbox");

    // 시험 폴더: 환경 변수로 정했고 기본 위치가 아니다
    let st = status_for(&sandbox.join("claude"), &sandbox.join("hh"), &home);
    assert!(st.claude_dir_from_env && st.harness_home_from_env);
    assert!(!st.claude_dir_is_default && !st.harness_home_is_default);

    // 환경 변수가 기본 위치를 가리킨다 — 이름이 같은 폴더면 실제 폴더다
    let st = status_for(&home.join(".claude"), &home.join(".claude-harness"), &home);
    assert!(
        st.claude_dir_from_env && st.harness_home_from_env,
        "환경 변수로 정했지만"
    );
    assert!(st.claude_dir_is_default && st.harness_home_is_default);

    // 철자가 달라도 같은 폴더면 같다 (`..` 를 거치기 · 끝 구분자)
    let spelled = home.join("x").join("..").join(".claude");
    let st = status_for(&spelled, &sandbox.join("hh"), &home);
    assert!(st.claude_dir_is_default && !st.harness_home_is_default);

    // 하나만 기본 위치여도 그쪽은 실제 폴더다 (다른 쪽은 시험 폴더)
    let st = status_for(
        &sandbox.join("claude"),
        &home.join(".claude-harness"),
        &home,
    );
    assert!(!st.claude_dir_is_default && st.harness_home_is_default);
}

#[test]
fn a_link_that_leads_to_the_real_default_folder_is_recognised_as_the_real_one() {
    let h = HarnessRoot::new("status-default-link");
    let home = h.root.join("home");
    let real = home.join(".claude");
    fs::create_dir_all(&real).unwrap();
    // 시험 폴더처럼 보이는 이름이 사실은 실제 폴더로 가는 링크 (정션)
    let alias = h.root.join("looks-like-a-sandbox");
    assert!(make_dir_link(&alias, &real), "링크를 만들 수 있어야 한다");
    let st = status_for(&alias, &h.root.join("hh"), &home);
    assert!(st.claude_dir_is_default, "링크를 따라가 같은 폴더로 본다");
    assert!(!st.harness_home_is_default);
}

#[test]
fn an_unknown_home_folder_never_claims_to_be_the_default() {
    let h = HarnessRoot::new("status-default-nohome");
    let locations = Locations {
        claude_dir: h.root.join("claude"),
        harness_home: h.root.join("hh"),
        claude_dir_from_env: true,
        harness_home_from_env: true,
    };
    let st = status_with_home(&Context::new(locations, None), None);
    assert!(!st.claude_dir_is_default && !st.harness_home_is_default);
}

#[test]
fn a_local_source_is_not_marked_as_a_network_path() {
    let h = HarnessRoot::new("status-not-network");
    let clone = h.root.join("dev-clone");
    make_clone(&clone, true);
    fs::create_dir_all(h.locations.installed_harness()).unwrap();
    fs::write(
        h.locations.installed_harness().join(".install-mode"),
        format!("copy\n{}\n", clone.display()),
    )
    .unwrap();
    let st = status(&h.ctx());
    assert!(st.developer_mode);
    assert!(!st.source_is_network);
    // 받은 원본(repo)도 마찬가지
    let fresh = HarnessRoot::new("status-not-network-repo");
    assert!(!status(&fresh.ctx()).source_is_network);
}

/// Windows 의 관리 공유(`\\127.0.0.1\C$\…`)로 같은 폴더를 UNC 로 본다 — 이 PC 에서 열리지 않으면 `None` (시험을 건너뛴다)
#[cfg(windows)]
fn as_unc_via_loopback(path: &Path) -> Option<std::path::PathBuf> {
    let text = path.to_str()?;
    let (drive, rest) = text.split_once(":\\")?;
    let unc = std::path::PathBuf::from(format!(r"\\127.0.0.1\{drive}$\{rest}"));
    unc.is_dir().then_some(unc)
}

#[cfg(windows)]
#[test]
fn a_source_reached_through_a_network_share_is_marked_but_still_used() {
    let h = HarnessRoot::new("status-network");
    let clone = h.root.join("dev-clone");
    make_clone(&clone, true);
    let Some(unc) = as_unc_via_loopback(&clone) else {
        eprintln!("skipped: the loopback admin share is not reachable on this PC");
        return;
    };
    fs::create_dir_all(h.locations.installed_harness()).unwrap();
    fs::write(
        h.locations.installed_harness().join(".install-mode"),
        format!("copy\n{}\n", unc.display()),
    )
    .unwrap();
    let st = status(&h.ctx());
    // 막지는 않는다 (D-20 — 사용자 자신의 설정): 개발자 모드로 쓰이고, 경고용 표시만 켜진다
    assert!(st.developer_mode, "{:?}", st.origin);
    assert!(st.source_is_network, "{:?}", st.source_dir);
    assert!(st.script_path.is_some());
}
