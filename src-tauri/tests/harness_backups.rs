//! 백업 정리 시험 — 링크 · 정션은 따라가지도 지우지도 않는다 (P4-02, 정해 둔 것 10).

mod common;

use std::fs;
use std::path::Path;

use common::*;
use nyanitor_lib::harness::backups::{is_backup_id, prune};

fn make_backups(home: &Path, ids: &[&str]) {
    for id in ids {
        let dir = home.join("backups").join(id);
        fs::create_dir_all(dir.join("files")).unwrap();
        fs::write(dir.join("manifest.txt"), "# id\n").unwrap();
    }
}

fn thirteen() -> Vec<String> {
    (1..=13).map(|d| format!("2026-10-{d:02}_090000")).collect()
}

/// 지키려는 "바깥" 폴더 — 링크가 가리키는 곳. 그 안의 파일이 끝까지 남아야 한다.
fn outside(h: &HarnessRoot, name: &str) -> std::path::PathBuf {
    let dir = h.root.join(name);
    fs::create_dir_all(dir.join("inner")).unwrap();
    fs::write(dir.join("inner").join("keep.txt"), "must survive").unwrap();
    dir
}

fn survives(dir: &Path) -> bool {
    fs::read_to_string(dir.join("inner").join("keep.txt")).is_ok_and(|t| t == "must survive")
}

#[test]
fn a_backup_named_folder_that_is_really_a_link_is_skipped_not_followed_or_deleted() {
    let h = HarnessRoot::new("prune-link-entry");
    let ids = thirteen();
    make_backups(
        &h.locations.harness_home,
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // 가장 오래된 이름이 사실은 바깥 폴더로 가는 링크 → 정리 대상(가장 오래됨)이어도 건드리지 않는다
    let target = outside(&h, "precious");
    let oldest = h.locations.backups_dir().join(&ids[0]);
    fs::remove_dir_all(&oldest).unwrap();
    assert!(
        make_dir_link(&oldest, &target),
        "링크를 만들 수 있어야 한다"
    );

    let result = prune(&h.locations.harness_home, 12, Some(&ids[12]));
    assert!(survives(&target), "링크 대상 안의 파일은 그대로여야 한다");
    assert!(
        fs::symlink_metadata(&oldest).is_ok(),
        "링크 자체도 지우지 않는다"
    );
    assert_eq!(result.skipped_entries, vec![ids[0].clone()]);
    // 진짜 폴더는 12개 → 그대로 (링크는 세지 않는다)
    assert_eq!(result.removed, 0, "{result:?}");
    assert_eq!(result.kept, 12);
}

#[test]
fn a_link_that_turns_up_among_the_doomed_is_left_alone_while_real_ones_are_removed() {
    let h = HarnessRoot::new("prune-link-doomed");
    let ids = thirteen();
    make_backups(
        &h.locations.harness_home,
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // 진짜 폴더가 14개가 되도록 하나 더 — 가장 오래된 둘이 정리 대상, 그중 하나가 링크
    make_backups(&h.locations.harness_home, &["2026-10-14_090000"]);
    let target = outside(&h, "precious2");
    let second_oldest = h.locations.backups_dir().join(&ids[1]);
    fs::remove_dir_all(&second_oldest).unwrap();
    assert!(make_dir_link(&second_oldest, &target));
    let result = prune(&h.locations.harness_home, 12, None);
    assert!(survives(&target));
    assert!(result.removed_ids.contains(&ids[0]));
    assert!(!h.locations.backups_dir().join(&ids[0]).exists());
    assert!(fs::symlink_metadata(&second_oldest).is_ok());
    assert!(result.skipped_entries.contains(&ids[1]));
}

#[test]
fn a_link_inside_an_old_backup_is_not_followed_when_that_backup_is_removed() {
    let h = HarnessRoot::new("prune-link-inside");
    let ids = thirteen();
    make_backups(
        &h.locations.harness_home,
        &ids.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let target = outside(&h, "precious3");
    let inner_link = h
        .locations
        .backups_dir()
        .join(&ids[0])
        .join("files")
        .join("link");
    assert!(make_dir_link(&inner_link, &target));
    let result = prune(&h.locations.harness_home, 12, Some(&ids[12]));
    assert_eq!(result.removed_ids, vec![ids[0].clone()]);
    assert!(!h.locations.backups_dir().join(&ids[0]).exists());
    assert!(survives(&target), "백업 안의 링크 너머를 지우면 안 된다");
}

#[test]
fn a_backups_folder_that_is_itself_a_link_is_not_touched_at_all() {
    let h = HarnessRoot::new("prune-link-root");
    let ids = thirteen();
    // 진짜 백업 13개는 하네스 폴더 밖에 있고, `backups` 는 그쪽으로 가는 링크
    let holder = h.root.join("elsewhere-holder");
    make_backups(&holder, &ids.iter().map(String::as_str).collect::<Vec<_>>());
    let real_backups = holder.join("backups");
    assert!(make_dir_link(&h.locations.backups_dir(), &real_backups));
    let result = prune(&h.locations.harness_home, 12, None);
    assert_eq!(result.skipped.as_deref(), Some("backups_is_link"));
    assert_eq!(result.removed, 0);
    assert_eq!(fs::read_dir(&real_backups).unwrap().count(), 13);
}

#[test]
fn names_of_other_shapes_survive_and_a_real_pile_is_trimmed_to_twelve() {
    let h = HarnessRoot::new("prune-shapes");
    make_backups(
        &h.locations.harness_home,
        &thirteen().iter().map(String::as_str).collect::<Vec<_>>(),
    );
    for odd in [
        "custom",
        "2026-10-18",
        "backup-latest",
        ".hidden",
        "2026-10-01_090000.bak",
    ] {
        fs::create_dir_all(h.locations.backups_dir().join(odd)).unwrap();
        assert!(!is_backup_id(odd));
    }
    let result = prune(&h.locations.harness_home, 12, None);
    assert_eq!(result.removed, 1);
    for odd in [
        "custom",
        "2026-10-18",
        "backup-latest",
        ".hidden",
        "2026-10-01_090000.bak",
    ] {
        assert!(h.locations.backups_dir().join(odd).is_dir(), "{odd}");
    }
}

#[test]
fn pruning_never_touches_anything_outside_the_backups_folder() {
    let h = HarnessRoot::new("prune-scope");
    make_backups(
        &h.locations.harness_home,
        &thirteen().iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // 같은 번호 모양의 폴더가 backups 밖에 있어도 그대로
    let decoy = h.locations.harness_home.join("2026-10-01_090000");
    fs::create_dir_all(&decoy).unwrap();
    let repo = h.locations.repo_dir();
    fs::create_dir_all(&repo).unwrap();
    fs::write(repo.join("file.txt"), "x").unwrap();
    prune(&h.locations.harness_home, 12, None);
    assert!(decoy.is_dir());
    assert!(repo.join("file.txt").is_file());
    assert!(h.locations.claude_dir.is_dir());
}

// ───────────────────────────── 깨진 백업 (내용을 읽을 수 없는 것) ─────────────────────────────

/// 목록 파일(`manifest.txt`)이 없는 백업 폴더 — 스크립트의 `--backups` 가 `readable:false` 로 보이는 모양
fn make_broken_backup(home: &Path, id: &str) {
    fs::create_dir_all(home.join("backups").join(id)).unwrap();
}

#[test]
fn a_newest_backup_without_its_list_file_still_counts_as_the_newest_and_the_oldest_goes() {
    let h = HarnessRoot::new("prune-broken-newest");
    let ids = thirteen();
    make_backups(
        &h.locations.harness_home,
        &ids[..12].iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // 가장 최근 백업이 깨져 있다 (설치가 백업을 쓰다 끊긴 것처럼 폴더만 있다)
    make_broken_backup(&h.locations.harness_home, &ids[12]);
    let result = prune(&h.locations.harness_home, 12, Some(&ids[12]));
    assert_eq!(result.removed_ids, vec![ids[0].clone()], "{result:?}");
    assert_eq!(result.kept, 12);
    assert!(
        h.locations.backups_dir().join(&ids[12]).is_dir(),
        "깨졌어도 최신 백업은 지우지 않는다 (사람이 되돌릴 마지막 기회일 수 있다)"
    );
    // 멀쩡한 최신 11개도 그대로
    for id in &ids[1..12] {
        assert!(
            h.locations
                .backups_dir()
                .join(id)
                .join("manifest.txt")
                .is_file()
        );
    }
}

#[test]
fn a_broken_backup_is_not_given_special_treatment_when_it_is_old() {
    let h = HarnessRoot::new("prune-broken-oldest");
    let ids = thirteen();
    make_backups(
        &h.locations.harness_home,
        &ids[1..].iter().map(String::as_str).collect::<Vec<_>>(),
    );
    make_broken_backup(&h.locations.harness_home, &ids[0]);
    // 보호 번호 없이도 (이름으로만 센다) 가장 오래된 깨진 백업이 정리 대상이다 — 열어 보지 않는다
    let result = prune(&h.locations.harness_home, 12, None);
    assert_eq!(result.removed_ids, vec![ids[0].clone()]);
    assert_eq!(result.kept, 12);
    assert!(!h.locations.backups_dir().join(&ids[0]).exists());
}

#[test]
fn several_broken_newest_backups_keep_the_just_made_one_even_when_the_clock_misplaces_it() {
    let h = HarnessRoot::new("prune-broken-protect");
    let ids = thirteen();
    make_backups(
        &h.locations.harness_home,
        &ids[1..].iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // 방금 만든 백업(시계가 거꾸로 가 가장 오래된 이름)이 깨져 있어도 지켜진다
    make_broken_backup(&h.locations.harness_home, &ids[0]);
    let result = prune(&h.locations.harness_home, 12, Some(&ids[0]));
    assert_eq!(result.kept, 12);
    assert!(h.locations.backups_dir().join(&ids[0]).is_dir());
    assert_eq!(result.removed_ids, vec![ids[1].clone()]);
}
