//! 백업 번호 모양 · 오래된 백업 정리 (D-46, 정해 둔 것 10).
//!
//! 설치 스크립트는 백업을 지우지 않는다 — 정리는 앱의 몫이다. 설치가 성공하고 백업을 만들었을 때
//! `<하네스 폴더>/backups/` 에서 최신 12개만 남긴다. 지우는 것은 **이름이 백업 번호 모양인 바로 아래 폴더**뿐이고,
//! 링크 · 정션은 따라가지도 지우지도 않는다 (건너뛰고 알린다).

use std::fs;
use std::path::Path;

use serde::Serialize;
use tauri_plugin_log::log;

/// `YYYY-MM-DD_HHMMSS` 또는 같은 초의 `…-2`, `…-3` … (약속 4절) 의 정렬 열쇠 `(날짜시각, 순번)`. 모양이 틀리면 `None`.
/// 날짜 · 시각은 범위만 본다 (윤년 · 월별 일수는 보지 않는다 — 이름이 번호 모양인지 가릴 뿐이다).
pub fn parse_backup_id(id: &str) -> Option<(String, u32)> {
    if !id.is_ascii() || id.len() < 17 {
        return None;
    }
    let (stamp, rest) = id.split_at(17);
    let b = stamp.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = &stamp[range];
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())
            .flatten()
    };
    if b[4] != b'-' || b[7] != b'-' || b[10] != b'_' {
        return None;
    }
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (digits(11..13)?, digits(13..15)?, digits(15..17)?);
    let _ = year;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let order = if rest.is_empty() {
        1
    } else {
        let suffix = rest.strip_prefix('-')?;
        if suffix.is_empty() || suffix.len() > 6 || !suffix.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let n: u32 = suffix.parse().ok()?;
        // 같은 초의 두 번째부터 `-2` 다 (`-0` · `-1` · `-02` 는 스크립트가 만들지 않는다)
        if n < 2 || suffix.starts_with('0') {
            return None;
        }
        n
    };
    Some((stamp.to_string(), order))
}

pub fn is_backup_id(id: &str) -> bool {
    parse_backup_id(id).is_some()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneResult {
    /// 지운 백업 수
    pub removed: usize,
    /// 지금 남아 있는 백업 폴더 수
    pub kept: usize,
    /// 지운 백업 번호
    pub removed_ids: Vec<String>,
    /// 번호 모양이지만 링크 · 정션이거나 폴더가 아니라서 건너뛴 이름
    pub skipped_entries: Vec<String>,
    /// 지우려다 실패한 번호 (설치는 이미 성공했으니 오류로 올리지 않고 알린다)
    pub failed: Vec<String>,
    /// 정리를 아예 하지 않은 이유: `backups_is_link` (백업 폴더 자체가 링크) · `read_failed`
    pub skipped: Option<String>,
}

/// 최신 `keep` 개만 남기고 지운다. `protect` (방금 만든 백업)는 순서와 관계없이 남기고 `keep` 에 센다.
pub fn prune(harness_home: &Path, keep: usize, protect: Option<&str>) -> PruneResult {
    let mut result = PruneResult::default();
    let dir = harness_home.join("backups");
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.file_type().is_symlink() => {
            // 백업 폴더가 다른 곳으로 가는 링크면 그 안을 지우지 않는다
            result.skipped = Some("backups_is_link".into());
            return result;
        }
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            result.skipped = Some("read_failed".into());
            return result;
        }
        // 백업 폴더가 없으면 지울 것도 없다
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return result,
        Err(_) => {
            result.skipped = Some("read_failed".into());
            return result;
        }
    }
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => {
            result.skipped = Some("read_failed".into());
            return result;
        }
    };

    let mut folders: Vec<((String, u32), String)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(order) = parse_backup_id(&name) else {
            continue; // 번호 모양이 아닌 이름은 우리 것이 아니다 — 세지도 지우지도 않는다
        };
        match fs::symlink_metadata(entry.path()) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                folders.push((order, name))
            }
            _ => result.skipped_entries.push(name),
        }
    }
    result.skipped_entries.sort();
    // 최신이 앞 (날짜시각 → 같은 초의 순번)
    folders.sort_by(|a, b| b.0.cmp(&a.0));

    let protected = protect.filter(|id| folders.iter().any(|(_, name)| name == id));
    let room = keep.saturating_sub(usize::from(protected.is_some()));
    let mut kept_others = 0;
    let mut doomed: Vec<String> = Vec::new();
    for (_, name) in &folders {
        if Some(name.as_str()) == protected {
            continue;
        }
        if kept_others < room {
            kept_others += 1;
        } else {
            doomed.push(name.clone());
        }
    }
    result.kept = folders.len() - doomed.len();

    for name in doomed {
        let path = dir.join(&name);
        // 지우기 직전에 한 번 더 — 그 사이 링크로 바뀌었으면 건드리지 않는다
        let still_plain = fs::symlink_metadata(&path)
            .map(|m| m.is_dir() && !m.file_type().is_symlink())
            .unwrap_or(false);
        if !still_plain {
            result.skipped_entries.push(name);
            result.kept += 1;
            continue;
        }
        match fs::remove_dir_all(&path) {
            Ok(()) => {
                result.removed += 1;
                result.removed_ids.push(name);
            }
            Err(err) => {
                log::warn!("harness: could not remove the old backup {name}: {err}");
                result.failed.push(name);
                result.kept += 1;
            }
        }
    }
    result.removed_ids.sort();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    #[test]
    fn real_backup_ids_parse_and_sort_newest_last_by_key() {
        assert_eq!(
            parse_backup_id("2026-10-18_143205"),
            Some(("2026-10-18_143205".into(), 1))
        );
        assert_eq!(
            parse_backup_id("2026-10-18_143205-2"),
            Some(("2026-10-18_143205".into(), 2))
        );
        assert_eq!(
            parse_backup_id("2026-10-18_143205-10"),
            Some(("2026-10-18_143205".into(), 10))
        );
        // 같은 초 안에서는 숫자로 비교한다 (-10 이 -2 보다 새것)
        assert!(parse_backup_id("2026-10-18_143205-10") > parse_backup_id("2026-10-18_143205-2"));
        assert!(parse_backup_id("2026-10-18_143205-2") > parse_backup_id("2026-10-18_143205"));
        assert!(parse_backup_id("2026-10-19_000000") > parse_backup_id("2026-10-18_235959-9"));
    }

    #[test]
    fn lookalike_names_are_not_backup_ids() {
        for bad in [
            "",
            "2026-10-18",
            "2026-10-18_14320",
            "2026-10-18_1432055",
            "2026-10-18 143205",
            "2026/10/18_143205",
            "26-10-18_143205",
            "2026-13-18_143205",
            "2026-00-18_143205",
            "2026-10-00_143205",
            "2026-10-32_143205",
            "2026-10-18_243205",
            "2026-10-18_146205",
            "2026-10-18_143260",
            "2026-10-18_143205-",
            "2026-10-18_143205-0",
            "2026-10-18_143205-1",
            "2026-10-18_143205-02",
            "2026-10-18_143205-x",
            "2026-10-18_143205-2-3",
            "2026-10-18_143205-1234567",
            "2026-10-18_143205.bak",
            "2026-10-18_143205 ",
            " 2026-10-18_143205",
            "..",
            "../2026-10-18_143205",
            "2026-10-18_143205\\..",
            "２０２６-10-18_143205",
            "2026-10-18_143205\n",
            "2026-1a-18_143205",
            "+026-10-18_143205",
        ] {
            assert!(!is_backup_id(bad), "{bad:?}");
        }
    }

    fn make_backups(home: &Path, ids: &[&str]) {
        for id in ids {
            let dir = home.join("backups").join(id);
            fs::create_dir_all(dir.join("files")).unwrap();
            fs::write(dir.join("manifest.txt"), "# id: x\n").unwrap();
        }
    }

    fn names(home: &Path) -> Vec<String> {
        let mut out: Vec<String> = fs::read_dir(home.join("backups"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    fn ids(count: usize) -> Vec<String> {
        (1..=count)
            .map(|n| format!("2026-10-{n:02}_120000"))
            .collect()
    }

    #[test]
    fn thirteen_become_twelve_oldest_first() {
        let home = TempDir::new("prune-13");
        let all = ids(13);
        make_backups(&home, &all.iter().map(String::as_str).collect::<Vec<_>>());
        let result = prune(&home, 12, Some(all.last().unwrap()));
        assert_eq!(result.removed, 1);
        assert_eq!(result.removed_ids, vec![all[0].clone()]);
        assert_eq!(result.kept, 12);
        assert_eq!(names(&home), all[1..].to_vec());
    }

    #[test]
    fn twelve_or_fewer_are_left_alone() {
        let home = TempDir::new("prune-12");
        let all = ids(12);
        make_backups(&home, &all.iter().map(String::as_str).collect::<Vec<_>>());
        let result = prune(&home, 12, None);
        assert_eq!((result.removed, result.kept), (0, 12));
        assert_eq!(names(&home).len(), 12);
        // 폴더 자체가 없어도 조용히
        let empty = TempDir::new("prune-none");
        assert_eq!(prune(&empty, 12, None), PruneResult::default());
    }

    #[test]
    fn same_second_suffixes_sort_numerically_when_pruning() {
        let home = TempDir::new("prune-suffix");
        make_backups(
            &home,
            &[
                "2026-10-01_120000",
                "2026-10-01_120000-2",
                "2026-10-01_120000-10",
                "2026-10-01_120000-3",
            ],
        );
        let result = prune(&home, 2, None);
        assert_eq!(
            names(&home),
            vec!["2026-10-01_120000-10", "2026-10-01_120000-3"]
        );
        assert_eq!(result.removed, 2);
    }

    #[test]
    fn names_of_other_shapes_are_neither_counted_nor_deleted() {
        let home = TempDir::new("prune-shapes");
        let all = ids(14);
        make_backups(&home, &all.iter().map(String::as_str).collect::<Vec<_>>());
        for odd in [
            "notes",
            "2026-10-18",
            "my-backup",
            "2026-13-01_120000",
            "latest",
        ] {
            fs::create_dir_all(home.join("backups").join(odd)).unwrap();
            fs::write(home.join("backups").join(odd).join("keep.txt"), "x").unwrap();
        }
        fs::write(home.join("backups").join("README.txt"), "x").unwrap();
        let result = prune(&home, 12, None);
        assert_eq!(result.removed, 2);
        for odd in [
            "notes",
            "2026-10-18",
            "my-backup",
            "2026-13-01_120000",
            "latest",
        ] {
            assert!(
                home.join("backups").join(odd).join("keep.txt").is_file(),
                "{odd}"
            );
        }
        assert!(home.join("backups").join("README.txt").is_file());
        // 번호 모양 12개만 남았다
        let remaining = names(&home).into_iter().filter(|n| is_backup_id(n)).count();
        assert_eq!(remaining, 12);
    }

    #[test]
    fn a_file_named_like_a_backup_is_skipped_and_reported() {
        let home = TempDir::new("prune-file");
        let all = ids(13);
        make_backups(&home, &all.iter().map(String::as_str).collect::<Vec<_>>());
        fs::write(home.join("backups").join("2026-01-01_000000"), "x").unwrap();
        let result = prune(&home, 12, None);
        assert_eq!(result.skipped_entries, vec!["2026-01-01_000000"]);
        assert!(home.join("backups").join("2026-01-01_000000").is_file());
        assert_eq!(result.removed, 1);
    }

    #[test]
    fn the_backup_just_made_is_kept_even_when_the_clock_put_it_among_the_oldest() {
        let home = TempDir::new("prune-protect");
        let all = ids(13);
        make_backups(&home, &all.iter().map(String::as_str).collect::<Vec<_>>());
        // 시계가 거꾸로 가서 방금 만든 백업이 가장 오래된 번호가 된 경우
        let result = prune(&home, 12, Some(&all[0]));
        assert_eq!(result.kept, 12);
        assert!(names(&home).contains(&all[0]));
        // 그 대신 가장 오래된 다른 것이 지워진다
        assert!(!names(&home).contains(&all[1]));
        // 없는 번호를 보호하라고 해도 아무 영향이 없다
        let home2 = TempDir::new("prune-protect-missing");
        make_backups(&home2, &all.iter().map(String::as_str).collect::<Vec<_>>());
        let result = prune(&home2, 12, Some("2026-12-31_235959"));
        assert_eq!(result.kept, 12);
        assert_eq!(result.removed_ids, vec![all[0].clone()]);
    }

    #[test]
    fn keep_zero_still_keeps_the_protected_one() {
        let home = TempDir::new("prune-zero");
        make_backups(&home, &["2026-10-01_120000", "2026-10-02_120000"]);
        let result = prune(&home, 0, Some("2026-10-02_120000"));
        assert_eq!(names(&home), vec!["2026-10-02_120000"]);
        assert_eq!(result.removed, 1);
    }
}
