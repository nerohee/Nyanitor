//! 프로젝트별 세션 ID (이어 하기용) — 앱 DB 의 `sessions` 표 (P6-03, D-20) + 옛 `claude-sessions.json` 가져오기.
//!
//! - 표: 프로젝트마다 CLI 세션 ID 여럿, 이어 하기는 `last_seen_at` 이 가장 늦은 것. 세션 ID 외에는 아무것도 저장하지 않는다 (대화 내용 · 계정 정보 없음).
//! - 옛 JSON (P3~P5 가 앱 데이터 폴더에 쓰던 `{ "version": 1, "projects": { "<폴더 키>": { "sessionId", "updatedAt" } } }`)은 앱을 켤 때 **한 번** 가져온다:
//!   등록된 프로젝트의 폴더 키(`project_key`)와 맞는 것만, 세션 ID 모양이 맞는 것만. 끝나면 파일 이름을 `.imported` 로 바꿔 다시 가져오지 않는다 (지우지 않는다).
//!   그때 등록되지 않은 폴더의 항목은 가져오지 못한다 (이름을 바꾼 파일에는 그대로 남아 있다).
//!   DB 를 못 써서 못 가져왔으면 파일을 그대로 두고 다음 실행에서 다시 한다 (이미 있는 항목은 건드리지 않아 몇 번을 해도 같다).
//!   이 앱보다 새 모양(`version` 이 큼)이거나 읽지 못한 파일은 건드리지 않는다. 깨진 파일은 `.corrupt` 로 옮겨 둔다.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use tauri_plugin_log::log;

use crate::db::AppDb;
use crate::error::AppError;

/// 옛 JSON 파일 이름 (앱 데이터 폴더 안)
pub const LEGACY_FILE: &str = "claude-sessions.json";

/// 옛 파일 모양의 가장 새 버전 — 이보다 큰 `version` 은 모르는 모양이라 건드리지 않는다
const LEGACY_VERSION: u32 = 1;

/// 같은 폴더를 가리키는 서로 다른 글자(`C:\Dev\App\` 와 `c:/dev/app`)를 한 키로 모은다.
pub fn project_key(dir: &Path) -> String {
    let text = dir.to_string_lossy();
    let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    if cfg!(windows) {
        let mut unified = text.replace('/', "\\");
        // `\\?\UNC\서버\공유` 는 `\\서버\공유` 와 같은 폴더다
        if unified
            .get(..4)
            .is_some_and(|head| head.eq_ignore_ascii_case("UNC\\"))
        {
            unified = format!("\\\\{}", &unified[4..]);
        }
        let (prefix, rest) = match unified.strip_prefix("\\\\") {
            Some(rest) => ("\\\\", rest),
            None => ("", unified.as_str()),
        };
        // 겹친 구분자 · 안쪽 `.` · 끝 구분자는 같은 폴더다
        let joined = rest
            .split('\\')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect::<Vec<_>>()
            .join("\\");
        // `C:\` 처럼 뿌리만 남으면 끝 `\` 를 살린다
        let key = if prefix.is_empty() && joined.len() == 2 && joined.ends_with(':') {
            format!("{joined}\\")
        } else {
            format!("{prefix}{joined}")
        };
        key.to_lowercase()
    } else {
        let trimmed = text.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    }
}

/// 세션 ID 로 쓸 수 있는 모양인가 — UUID(`8-4-4-4-12` 의 16진수)만. `--resume <ID>` 인자로 들어가므로 엄격하게:
/// `-` 로 시작하는 값(`--dangerously-skip-permissions` 등)은 CLI 가 옵션으로 읽을 수 있어 첫 글자부터 16진수여야 한다.
pub fn is_valid_session_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, &b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

// ───────────────────────── 앱 DB 의 `sessions` 표 ─────────────────────────

/// 이 프로젝트가 이 세션 ID 를 쓰고 있다고 적는다 — 처음이면 새 줄, 이미 있으면 마지막 때만 늦춘다 (거꾸로 가지 않는다).
/// 세션 ID 모양이 아니면 `invalid_input` (`--resume <ID>` 인자로 들어가므로).
pub fn remember(
    conn: &Connection,
    project_id: i64,
    session_id: &str,
    now: i64,
) -> Result<(), AppError> {
    if !is_valid_session_id(session_id) {
        return Err(AppError::InvalidInput(
            "session id has unexpected characters".into(),
        ));
    }
    conn.execute(
        "INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(project_id, session_id)
         DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)",
        params![project_id, session_id, now],
    )?;
    Ok(())
}

/// 이 프로젝트의 마지막 세션 ID (이어 하기용). 없으면 `None`. 모양이 이상한 ID (DB 를 손으로 고친 경우)는 건너뛰고 다음으로 새것을 찾는다.
pub fn last_for_project(conn: &Connection, project_id: i64) -> Result<Option<String>, AppError> {
    let mut statement = conn.prepare(
        "SELECT session_id FROM sessions WHERE project_id = ?1
         ORDER BY last_seen_at DESC, id DESC LIMIT 20",
    )?;
    let ids = statement
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids.into_iter().find(|id| is_valid_session_id(id)))
}

// ───────────────────────── 옛 JSON 가져오기 ─────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEntry {
    session_id: String,
    updated_at: u64,
}

#[derive(Debug, Deserialize)]
struct LegacyData {
    version: u32,
    projects: BTreeMap<String, LegacyEntry>,
}

/// 옛 파일 가져오기의 결과
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyImport {
    /// 옛 파일이 없다 (처음 쓰는 PC · 이미 가져옴)
    NoFile,
    /// 가져왔다. `imported`: 새로 들어간 항목 수 · `skipped`: 건너뛴 항목 수 (등록 안 된 폴더 · 모양이 이상한 세션 ID · 이미 있던 것)
    Imported { imported: usize, skipped: usize },
    /// 이 앱보다 새 모양이거나 읽지 못해 그대로 뒀다
    Left,
    /// 깨진 파일이라 `.corrupt` 로 옮겼다
    Corrupt,
    /// 앱 DB 를 쓸 수 없어 못 가져왔다 (파일은 그대로 — 다음 실행에서 다시)
    DbNotWritable,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// 가져온 파일의 새 이름 — `<파일>.imported` (이미 있으면 `.imported-<시각>[-번호]`)
fn imported_name(path: &Path, now: i64) -> PathBuf {
    let plain = with_suffix(path, ".imported");
    if !plain.exists() {
        return plain;
    }
    let mut attempt = 0;
    loop {
        let tail = if attempt == 0 {
            format!(".imported-{now}")
        } else {
            format!(".imported-{now}-{attempt}")
        };
        let candidate = with_suffix(path, &tail);
        if !candidate.exists() {
            return candidate;
        }
        attempt += 1;
    }
}

/// 옛 `claude-sessions.json` 을 한 번 가져온다 (위 설명). 앱을 켤 때 부른다. 실패해도 앱은 뜬다 — 결과를 돌려줄 뿐이다.
pub fn import_legacy(db: &AppDb, path: &Path) -> LegacyImport {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return LegacyImport::NoFile,
        // UTF-8 이 아니다 = 깨진 파일
        Err(err) if err.kind() == io::ErrorKind::InvalidData => return move_corrupt(path),
        Err(err) => {
            log::warn!("could not read the old session file: {err}");
            return LegacyImport::Left;
        }
    };
    // 새 버전 파일은 모양이 달라도 건드리지 않는다 — `version` 만 먼저 본다 (옛 앱이 새 앱의 파일을 깨진 것으로 옮겨 버리지 않게).
    let newer = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| value.get("version").and_then(serde_json::Value::as_u64))
        .is_some_and(|version| version > u64::from(LEGACY_VERSION));
    if newer {
        log::warn!("the old session file is newer than supported; leaving it untouched");
        return LegacyImport::Left;
    }
    let data = match serde_json::from_str::<LegacyData>(&text) {
        Ok(data) if data.version <= LEGACY_VERSION => data,
        Ok(_) => return LegacyImport::Left,
        Err(err) => {
            log::warn!("the old session file is corrupt ({err}); moving it aside");
            return move_corrupt(path);
        }
    };
    match db.write(|conn| import_entries(conn, &data)) {
        Ok((imported, skipped)) => {
            let target = imported_name(path, now_secs());
            if let Err(err) = fs::rename(path, &target) {
                // 이름을 못 바꿔도 다음 실행에서 다시 가져올 뿐이다 (이미 있는 항목은 그대로)
                log::warn!("could not mark the old session file as imported: {err}");
            }
            log::info!(
                "imported {imported} saved session(s) from the old file ({skipped} skipped)"
            );
            LegacyImport::Imported { imported, skipped }
        }
        Err(err) => {
            log::warn!("could not import the old session file: {err}");
            LegacyImport::DbNotWritable
        }
    }
}

fn move_corrupt(path: &Path) -> LegacyImport {
    let aside = path.with_extension("json.corrupt");
    match fs::rename(path, &aside) {
        Ok(()) => LegacyImport::Corrupt,
        Err(err) => {
            log::warn!("could not move the corrupt old session file aside: {err}");
            LegacyImport::Left
        }
    }
}

/// 한 트랜잭션으로: 폴더 키가 등록된 프로젝트와 맞고 세션 ID 모양이 맞는 항목만 넣는다. 이미 있는 (프로젝트, 세션 ID) 는 그대로 둔다.
fn import_entries(conn: &mut Connection, data: &LegacyData) -> Result<(usize, usize), AppError> {
    let tx = conn.transaction()?;
    let (mut imported, mut skipped) = (0, 0);
    for (key, entry) in &data.projects {
        if !is_valid_session_id(&entry.session_id) {
            skipped += 1;
            continue;
        }
        let project_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM projects WHERE path_key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?;
        let Some(project_id) = project_id else {
            skipped += 1;
            continue;
        };
        let at = i64::try_from(entry.updated_at).unwrap_or(i64::MAX);
        let added = tx.execute(
            "INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(project_id, session_id) DO NOTHING",
            params![project_id, entry.session_id, at],
        )?;
        if added == 0 {
            skipped += 1;
        } else {
            imported += 1;
        }
    }
    tx.commit()?;
    Ok((imported, skipped))
}

#[cfg(test)]
mod tests {
    use super::super::test_util::TempDir;
    use super::*;
    use crate::db::{AppDb, DB_FILE};
    use crate::projects::store as projects_store;

    const ID_A: &str = "00000000-0000-4000-8000-000000000001";
    const ID_B: &str = "00000000-0000-4000-8000-000000000002";

    /// 키 하나마다 프로젝트 하나 (번호는 1 부터 차례로)
    fn db_with_projects(dir: &TempDir, keys: &[&str]) -> AppDb {
        let db = AppDb::open(&dir.join(DB_FILE));
        for key in keys {
            db.write(|conn| projects_store::insert(conn, key, key, key, None, 1))
                .unwrap();
        }
        db
    }

    fn legacy_path(dir: &TempDir) -> PathBuf {
        dir.join(LEGACY_FILE)
    }

    fn sessions_of(db: &AppDb, project_id: i64) -> Vec<(String, i64, i64)> {
        db.read(|conn| {
            let mut statement = conn.prepare(
                "SELECT session_id, first_seen_at, last_seen_at FROM sessions WHERE project_id = ?1 ORDER BY id",
            )?;
            Ok(statement
                .query_map([project_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .unwrap()
    }

    fn last(db: &AppDb, project_id: i64) -> Option<String> {
        db.read(|conn| last_for_project(conn, project_id)).unwrap()
    }

    fn legacy_json(entries: &[(&str, &str, u64)]) -> String {
        let projects: Vec<String> = entries
            .iter()
            .map(|(key, id, at)| {
                format!(
                    "{}: {{\"sessionId\": \"{id}\", \"updatedAt\": {at}}}",
                    serde_json::to_string(key).unwrap()
                )
            })
            .collect();
        format!(
            "{{\"version\": 1, \"projects\": {{{}}}}}",
            projects.join(",")
        )
    }

    // ───────── sessions 표 ─────────

    #[test]
    fn the_last_session_is_the_one_seen_most_recently() {
        let dir = TempDir::new("sess-last");
        let db = db_with_projects(&dir, &["a", "b"]);
        assert_eq!(last(&db, 1), None);
        db.write(|conn| remember(conn, 1, ID_A, 100)).unwrap();
        db.write(|conn| remember(conn, 1, ID_B, 200)).unwrap();
        db.write(|conn| remember(conn, 2, ID_A, 50)).unwrap();
        assert_eq!(last(&db, 1).as_deref(), Some(ID_B));
        assert_eq!(last(&db, 2).as_deref(), Some(ID_A));
        // 앞 세션을 다시 쓰면(이어 하기) 그것이 마지막이 된다 — 처음 본 때는 그대로
        db.write(|conn| remember(conn, 1, ID_A, 300)).unwrap();
        assert_eq!(last(&db, 1).as_deref(), Some(ID_A));
        assert_eq!(
            sessions_of(&db, 1),
            [(ID_A.into(), 100, 300), (ID_B.into(), 200, 200)]
        );
        // 마지막 때는 거꾸로 가지 않는다
        db.write(|conn| remember(conn, 1, ID_A, 10)).unwrap();
        assert_eq!(sessions_of(&db, 1)[0], (ID_A.into(), 100, 300));
    }

    #[test]
    fn the_same_time_goes_to_the_one_written_later() {
        let dir = TempDir::new("sess-tie");
        let db = db_with_projects(&dir, &["a"]);
        db.write(|conn| remember(conn, 1, ID_A, 100)).unwrap();
        db.write(|conn| remember(conn, 1, ID_B, 100)).unwrap();
        assert_eq!(last(&db, 1).as_deref(), Some(ID_B));
    }

    #[test]
    fn bad_session_ids_are_refused_before_anything_is_written() {
        let dir = TempDir::new("sess-bad");
        let db = db_with_projects(&dir, &["a"]);
        for bad in [
            "",
            "short",
            "has space in it 123456",
            "--resume;rm -rf",
            "--dangerously-skip-permissions",
            &"x".repeat(65),
        ] {
            let err = db.write(|conn| remember(conn, 1, bad, 1)).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{bad}");
        }
        assert!(sessions_of(&db, 1).is_empty());
    }

    #[test]
    fn a_session_of_an_unregistered_project_is_refused_by_the_database() {
        let dir = TempDir::new("sess-fk");
        let db = db_with_projects(&dir, &["a"]);
        assert!(db.write(|conn| remember(conn, 9, ID_A, 1)).is_err());
    }

    #[test]
    fn an_id_that_became_odd_in_the_file_is_skipped_for_an_older_good_one() {
        let dir = TempDir::new("sess-tampered");
        let db = db_with_projects(&dir, &["a"]);
        db.write(|conn| remember(conn, 1, ID_A, 100)).unwrap();
        // 36 글자지만 UUID 모양이 아닌 글이 손으로 들어갔다 (CHECK 는 길이만 본다)
        db.write(|conn| {
            conn.execute(
                "INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at) VALUES (1, ?1, 200, 200)",
                [&"-".repeat(36)],
            )?;
            Ok(())
        })
        .unwrap();
        assert_eq!(last(&db, 1).as_deref(), Some(ID_A));
    }

    // ───────── 옛 JSON 가져오기 ─────────

    #[test]
    fn matching_entries_are_imported_once_and_the_file_is_renamed_not_deleted() {
        let dir = TempDir::new("legacy-ok");
        let db = db_with_projects(&dir, &["c:\\dev\\a", "c:\\dev\\b"]);
        let path = legacy_path(&dir);
        fs::write(
            &path,
            legacy_json(&[
                ("c:\\dev\\a", ID_A, 1_700_000_000),
                ("c:\\dev\\b", ID_B, 1_700_000_500),
            ]),
        )
        .unwrap();
        assert_eq!(
            import_legacy(&db, &path),
            LegacyImport::Imported {
                imported: 2,
                skipped: 0
            }
        );
        assert_eq!(
            sessions_of(&db, 1),
            [(ID_A.into(), 1_700_000_000, 1_700_000_000)]
        );
        assert_eq!(last(&db, 2).as_deref(), Some(ID_B));
        // 지우지 않고 이름만 바꿨다
        assert!(!path.exists());
        assert!(with_suffix(&path, ".imported").exists());
        // 두 번째 실행: 옛 파일이 없으니 아무 일도 없다
        assert_eq!(import_legacy(&db, &path), LegacyImport::NoFile);
        assert_eq!(sessions_of(&db, 1).len(), 1);
    }

    #[test]
    fn entries_of_unregistered_folders_and_odd_ids_are_skipped() {
        let dir = TempDir::new("legacy-skip");
        let db = db_with_projects(&dir, &["a"]);
        let path = legacy_path(&dir);
        fs::write(
            &path,
            legacy_json(&[
                ("a", ID_A, 10),
                ("not-registered", ID_B, 20),
                ("a2", "--dangerously-skip-permissions", 30),
            ]),
        )
        .unwrap();
        assert_eq!(
            import_legacy(&db, &path),
            LegacyImport::Imported {
                imported: 1,
                skipped: 2
            }
        );
        assert_eq!(last(&db, 1).as_deref(), Some(ID_A));
        let total: i64 = db
            .read(|c| Ok(c.query_row("SELECT count(*) FROM sessions", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(total, 1);
    }

    #[test]
    fn importing_the_same_file_again_changes_nothing() {
        // 이름을 못 바꿔 다시 가져오게 된 경우를 흉내 낸다 — 이미 있는 항목은 그대로, 새 세션이 마지막인 채로
        let dir = TempDir::new("legacy-twice");
        let db = db_with_projects(&dir, &["a"]);
        let path = legacy_path(&dir);
        let body = legacy_json(&[("a", ID_A, 100)]);
        fs::write(&path, &body).unwrap();
        import_legacy(&db, &path);
        db.write(|conn| remember(conn, 1, ID_B, 5000)).unwrap();
        fs::write(&path, &body).unwrap();
        assert_eq!(
            import_legacy(&db, &path),
            LegacyImport::Imported {
                imported: 0,
                skipped: 1
            }
        );
        assert_eq!(
            last(&db, 1).as_deref(),
            Some(ID_B),
            "옛 것이 새 세션을 밀어내지 않는다"
        );
        assert_eq!(sessions_of(&db, 1).len(), 2);
        // 이미 `.imported` 가 있어도 덮어쓰지 않고 새 이름으로 옮겼다
        assert!(with_suffix(&path, ".imported").exists());
        assert!(!path.exists());
    }

    #[test]
    fn a_broken_file_is_moved_aside_and_nothing_is_imported() {
        for (n, text) in [
            "",
            "   ",
            "null",
            "[]",
            "{}",
            "{ not json",
            "{\"version\":1}",
            "{\"version\":\"1\",\"projects\":{}}",
            "{\"version\":1,\"projects\":[]}",
            "{\"version\":1,\"projects\":{\"k\":5}}",
            "{\"version\":1,\"projects\":{\"k\":{\"sessionId\":\"x\"}}}",
            "{\"version\":-1,\"projects\":{}}",
        ]
        .into_iter()
        .enumerate()
        {
            let dir = TempDir::new(&format!("legacy-corrupt{n}"));
            let db = db_with_projects(&dir, &["k"]);
            let path = legacy_path(&dir);
            fs::write(&path, text).unwrap();
            assert_eq!(import_legacy(&db, &path), LegacyImport::Corrupt, "{text:?}");
            assert!(!path.exists(), "{text:?}");
            assert!(path.with_extension("json.corrupt").exists(), "{text:?}");
            assert_eq!(last(&db, 1), None);
        }
    }

    #[test]
    fn a_non_utf8_file_is_corrupt_too() {
        let dir = TempDir::new("legacy-binary");
        let db = db_with_projects(&dir, &["k"]);
        let path = legacy_path(&dir);
        fs::write(&path, [0xff, 0xfe, 0x00, 0x7b, 0x00]).unwrap();
        assert_eq!(import_legacy(&db, &path), LegacyImport::Corrupt);
        assert!(path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn a_newer_format_file_is_left_in_place_whatever_its_shape() {
        for (n, body) in [
            r#"{"version":2,"projects":[]}"#,
            r#"{"version":2}"#,
            r#"{"version":99,"data":"x"}"#,
            r#"{"version":2,"projects":{"k":5}}"#,
        ]
        .iter()
        .enumerate()
        {
            let dir = TempDir::new(&format!("legacy-newer{n}"));
            let db = db_with_projects(&dir, &["k"]);
            let path = legacy_path(&dir);
            fs::write(&path, body).unwrap();
            assert_eq!(import_legacy(&db, &path), LegacyImport::Left, "{body}");
            assert_eq!(fs::read_to_string(&path).unwrap(), *body);
            assert!(!path.with_extension("json.corrupt").exists(), "{body}");
        }
    }

    #[test]
    fn a_file_that_cannot_be_read_is_left_alone() {
        // 파일 자리에 폴더가 있다 → 읽을 수 없다 (옮기지도 지우지도 않는다)
        let dir = TempDir::new("legacy-isdir");
        let db = db_with_projects(&dir, &["k"]);
        let path = legacy_path(&dir);
        fs::create_dir(&path).unwrap();
        assert_eq!(import_legacy(&db, &path), LegacyImport::Left);
        assert!(path.is_dir());
    }

    #[test]
    fn extra_fields_and_version_zero_are_tolerated() {
        let dir = TempDir::new("legacy-extra");
        let db = db_with_projects(&dir, &["k"]);
        let path = legacy_path(&dir);
        fs::write(
            &path,
            format!(
                r#"{{"version":0,"future":true,"projects":{{"k":{{"sessionId":"{ID_A}","updatedAt":1,"note":"x"}}}}}}"#
            ),
        )
        .unwrap();
        assert!(matches!(
            import_legacy(&db, &path),
            LegacyImport::Imported { imported: 1, .. }
        ));
    }

    #[test]
    fn a_database_that_cannot_be_written_keeps_the_file_for_the_next_run() {
        let dir = TempDir::new("legacy-nodb");
        // 데이터 폴더 자리에 파일이 있어 DB 를 못 연다
        let blocker = dir.join("data");
        fs::write(&blocker, b"i am a file").unwrap();
        let db = AppDb::open(&blocker.join(DB_FILE));
        let path = legacy_path(&dir);
        let body = legacy_json(&[("k", ID_A, 1)]);
        fs::write(&path, &body).unwrap();
        assert_eq!(import_legacy(&db, &path), LegacyImport::DbNotWritable);
        assert_eq!(fs::read_to_string(&path).unwrap(), body);
        assert!(!with_suffix(&path, ".imported").exists());
    }

    #[test]
    fn a_read_only_newer_database_does_not_take_the_import() {
        let dir = TempDir::new("legacy-newerdb");
        let db_path = dir.join(DB_FILE);
        drop(db_with_projects(&dir, &["k"]));
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION + 1)
                .unwrap();
        }
        let db = AppDb::open(&db_path);
        let path = legacy_path(&dir);
        fs::write(&path, legacy_json(&[("k", ID_A, 1)])).unwrap();
        assert_eq!(import_legacy(&db, &path), LegacyImport::DbNotWritable);
        assert!(path.exists());
    }

    #[test]
    fn the_imported_name_never_overwrites_an_earlier_imported_file() {
        let dir = TempDir::new("legacy-names");
        let path = legacy_path(&dir);
        fs::write(with_suffix(&path, ".imported"), "old one").unwrap();
        let name = imported_name(&path, 42);
        assert_eq!(name, with_suffix(&path, ".imported-42"));
        fs::write(&name, "second").unwrap();
        assert_eq!(
            imported_name(&path, 42),
            with_suffix(&path, ".imported-42-1")
        );
    }

    // ───────── 폴더 키 · 세션 ID 모양 (옛 저장소 시험에서 옮김) ─────────

    #[test]
    fn keys_unify_slashes_case_and_trailing_separators_on_windows() {
        if cfg!(windows) {
            assert_eq!(project_key(Path::new("C:\\Dev\\App\\")), "c:\\dev\\app");
            assert_eq!(project_key(Path::new("c:/dev/app")), "c:\\dev\\app");
            assert_eq!(
                project_key(Path::new("\\\\?\\C:\\Dev\\App")),
                "c:\\dev\\app"
            );
            assert_eq!(project_key(Path::new("C:\\")), "c:\\");
        } else {
            assert_eq!(project_key(Path::new("/home/a/")), "/home/a");
            assert_eq!(project_key(Path::new("/")), "/");
        }
    }

    #[cfg(windows)]
    #[test]
    fn every_spelling_of_the_same_windows_folder_gets_one_key() {
        let key = project_key(Path::new("C:\\Users\\Me\\Proj"));
        for same in [
            "c:\\users\\me\\proj",
            "C:\\USERS\\ME\\PROJ\\",
            "C:/Users/Me/Proj",
            "C:/Users/Me/Proj/",
            "c:/users/me/proj//",
            "\\\\?\\C:\\Users\\Me\\Proj",
            "\\\\?\\c:\\users\\me\\proj\\",
        ] {
            assert_eq!(project_key(Path::new(same)), key, "{same}");
        }
        assert_ne!(project_key(Path::new("C:\\Users\\Me\\Proj2")), key);
        assert_ne!(project_key(Path::new("D:\\Users\\Me\\Proj")), key);
        assert_ne!(project_key(Path::new("C:\\Users\\Me")), key);
    }

    #[cfg(windows)]
    #[test]
    fn drive_roots_unc_paths_and_non_ascii_names_make_sensible_keys() {
        assert_eq!(project_key(Path::new("C:")), project_key(Path::new("C:\\")));
        assert_eq!(project_key(Path::new("c:/")), "c:\\");
        assert_eq!(
            project_key(Path::new("\\\\Srv\\Share\\Proj\\")),
            project_key(Path::new("\\\\srv\\share\\proj"))
        );
        assert_eq!(
            project_key(Path::new("C:\\내 프로젝트")),
            project_key(Path::new("c:/내 프로젝트/"))
        );
        // 유니코드 대소문자 (NTFS 도 같은 폴더로 본다)
        assert_eq!(
            project_key(Path::new("C:\\Ärger")),
            project_key(Path::new("c:\\ärger"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_unc_and_dotted_spellings_of_the_same_folder_share_a_key() {
        assert_eq!(
            project_key(Path::new("\\\\?\\UNC\\srv\\share\\proj")),
            project_key(Path::new("\\\\srv\\share\\proj"))
        );
        assert_eq!(
            project_key(Path::new("C:\\p\\.\\x")),
            project_key(Path::new("C:\\p\\x"))
        );
        assert_eq!(
            project_key(Path::new("C:\\p\\\\x")),
            project_key(Path::new("C:\\p\\x"))
        );
    }

    #[test]
    fn session_id_shapes_at_the_edges() {
        // UUID (8-4-4-4-12 의 16진수) 만 — 대소문자는 가리지 않는다
        for ok in [
            "00000000-0000-4000-8000-000000000001",
            "123e4567-e89b-12d3-a456-426614174000",
            "123E4567-E89B-12D3-A456-426614174000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
        ] {
            assert!(is_valid_session_id(ok), "{ok}");
        }
        for bad in [
            "",
            "abcdefgh",
            "ABCDEF-12",
            &"a".repeat(36),
            &"a".repeat(64),
            "123e4567e89b12d3a456426614174000",      // 대시 없음
            "123e4567-e89b-12d3-a456-42661417400",   // 한 글자 모자람
            "123e4567-e89b-12d3-a456-4266141740000", // 한 글자 넘침
            "123e4567-e89b-12d3-a456-42661417400g",
            "123e4567_e89b_12d3_a456_426614174000",
            "123e4567-e89b-12d3-a456-426614174000\n",
            "123e4567-e89b-12d3-a456-426614174000\0",
            " 123e4567-e89b-12d3-a456-42661417400",
            "123e4567-e89b-12d3-a456-42661417400;",
            "$(calc)7-e89b-12d3-a456-426614174000",
            "０２３e4567-e89b-12d3-a456-426614174000", // 전각 숫자
            "아이디아이디아이디아이디",
            "---------------------------------------",
        ] {
            assert!(!is_valid_session_id(bad), "{bad:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn keys_survive_multibyte_names_and_odd_prefixes_without_panicking() {
        for text in [
            "내",
            "\\\\?\\내용",
            "UN내",
            "UNC",
            "UNC\\",
            "\\\\",
            "\\\\?\\UNC\\",
            "\\\\?\\UNC\\서버\\공유\\폴더",
            "\\\\서버\\공유\\폴더\\",
            "C:\\내\\.\\프로젝트\\\\",
            "",
            ".",
            "\\",
        ] {
            let _ = project_key(Path::new(text));
        }
        assert_eq!(
            project_key(Path::new("\\\\?\\UNC\\서버\\공유\\폴더")),
            project_key(Path::new("\\\\서버\\공유\\폴더\\"))
        );
        assert_eq!(
            project_key(Path::new("\\\\?\\unc\\Srv\\Share")),
            "\\\\srv\\share"
        );
        // 다른 서버 · 다른 드라이브는 다른 키
        assert_ne!(
            project_key(Path::new("\\\\a\\s\\p")),
            project_key(Path::new("\\\\b\\s\\p"))
        );
        assert_ne!(
            project_key(Path::new("\\\\srv\\share")),
            project_key(Path::new("C:\\srv\\share"))
        );
    }
}
