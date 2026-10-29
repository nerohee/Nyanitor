//! 앱 DB (SQLite) — 앱 데이터 폴더의 `nyanitor.db` 하나 (D-20 · D-47).
//!
//! - 구조 변경은 번호를 붙여 차례대로 (`migrations`, `PRAGMA user_version`). 1번 = `projects`.
//! - 이 앱보다 **새 번호**의 DB 는 건드리지 않고 읽기만 한다 (`DbStatus::ReadOnly` — 쓰기는 `db_read_only`).
//! - **깨진** DB (SQLite 파일이 아님 · 속이 망가짐) 는 `nyanitor.db.corrupt-<시각>` 으로 옮겨 두고(곁 파일 `-journal` · `-wal` · `-shm` 도 같이) 새로 만든다. 로그에 남긴다.
//!   깨졌다고 보는 것은 "SQLite 파일이 아니다 · 망가졌다" 뿐이다 — 다른 프로그램이 잠갔거나 권한이 없어서 못 연 것은 옮기지 않고 `Unavailable` 로 둔다
//!   (멀쩡한 파일을 일시적 문제로 치워 버리지 않으려고).
//! - **DB 를 못 써도 앱은 뜬다.** `AppDb::open` 은 실패하지 않고, 못 쓰는 상태면 `read` · `write` 가 `db_unavailable` 을 돌려준다.
//!
//! 설정 (작업자 판단): 롤백 저널(기본 `DELETE`) + `synchronous=FULL`(기본) — 파일 하나만 남고, 전기가 나가도 안 깨진다. 이 앱은 한 프로세스(single-instance)가
//! 연결 하나를 `Mutex` 로 쓰므로 WAL 의 동시 읽기 이점이 없고, WAL 은 곁 파일이 늘어 옮기기 · 읽기 전용 열기가 까다롭다. `foreign_keys=ON`, `busy_timeout=2초`.

pub mod migrations;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, ErrorCode, OpenFlags};
use tauri_plugin_log::log;

use crate::error::AppError;

pub use migrations::SCHEMA_VERSION;

/// 앱 데이터 폴더 안 파일 이름
pub const DB_FILE: &str = "nyanitor.db";

const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// 곁 파일 이름 꼬리 (DB 와 같이 옮긴다)
const SIDE_FILES: [&str; 3] = ["-journal", "-wal", "-shm"];

/// 지금 DB 를 쓸 수 있는 정도
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbStatus {
    /// 읽고 쓴다
    Ready,
    /// 이 앱보다 새 번호(`version`)의 DB — 읽기만
    ReadOnly { version: u32 },
    /// 열 수 없다 (이유는 진단용 영어 글)
    Unavailable(String),
}

enum Slot {
    Ready(Connection),
    ReadOnly { conn: Connection, version: u32 },
    Unavailable(String),
}

/// 앱이 들고 있는 DB. 복제하면 같은 연결을 가리킨다 (명령이 블로킹 풀로 가져갈 수 있게).
#[derive(Clone)]
pub struct AppDb {
    slot: Arc<Mutex<Slot>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl AppDb {
    /// DB 를 연다 (없으면 만든다). 실패하지 않는다 — 못 쓰는 상태면 `status()` 가 `Unavailable`.
    pub fn open(path: &Path) -> Self {
        let slot = match open_slot(path) {
            Ok(slot) => slot,
            Err(reason) => {
                log::error!("app database is unavailable: {reason}");
                Slot::Unavailable(reason)
            }
        };
        Self {
            slot: Arc::new(Mutex::new(slot)),
        }
    }

    pub fn status(&self) -> DbStatus {
        match &*lock(&self.slot) {
            Slot::Ready(_) => DbStatus::Ready,
            Slot::ReadOnly { version, .. } => DbStatus::ReadOnly { version: *version },
            Slot::Unavailable(reason) => DbStatus::Unavailable(reason.clone()),
        }
    }

    /// 읽는다. 새 번호 DB(읽기 전용)에서도 된다. 연결을 쥐고 있는 동안 다른 DB 일은 기다리므로 짧게 쓴다 (파일 · 네트워크 일은 밖에서).
    pub fn read<T>(
        &self,
        work: impl FnOnce(&Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        match &*lock(&self.slot) {
            Slot::Ready(conn) | Slot::ReadOnly { conn, .. } => work(conn),
            Slot::Unavailable(reason) => Err(AppError::DbUnavailable(reason.clone())),
        }
    }

    /// 쓴다. 새 번호 DB 면 `db_read_only`, 못 쓰는 DB 면 `db_unavailable`.
    pub fn write<T>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        match &mut *lock(&self.slot) {
            Slot::Ready(conn) => work(conn),
            Slot::ReadOnly { .. } => Err(AppError::DbReadOnly),
            Slot::Unavailable(reason) => Err(AppError::DbUnavailable(reason.clone())),
        }
    }
}

enum OpenFailure {
    /// SQLite 파일이 아니거나 속이 망가졌다 — 옮겨 두고 새로 만든다
    Corrupt(String),
    /// 그 밖의 이유로 못 연다 (권한 · 잠김 · 폴더 · 구조 변경 실패) — 파일은 건드리지 않는다
    Other(String),
}

fn classify(err: rusqlite::Error) -> OpenFailure {
    match &err {
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(
                failure.code,
                ErrorCode::NotADatabase | ErrorCode::DatabaseCorrupt
            ) =>
        {
            OpenFailure::Corrupt(err.to_string())
        }
        _ => OpenFailure::Other(err.to_string()),
    }
}

fn open_slot(path: &Path) -> Result<Slot, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("could not create the data folder: {err}"))?;
    }
    match try_open(path) {
        Ok(slot) => Ok(slot),
        Err(OpenFailure::Other(reason)) => Err(reason),
        Err(OpenFailure::Corrupt(reason)) => {
            log::warn!("app database is corrupt ({reason}); moving it aside");
            let aside = move_aside(path).map_err(|err| {
                format!("the database is corrupt ({reason}) and could not be moved aside: {err}")
            })?;
            log::warn!("moved the corrupt app database to {}", aside.display());
            // 새로 만든다. 또 실패하면(디스크 문제 등) 더 시도하지 않는다.
            match try_open(path) {
                Ok(slot) => Ok(slot),
                Err(OpenFailure::Corrupt(reason) | OpenFailure::Other(reason)) => Err(reason),
            }
        }
    }
}

fn try_open(path: &Path) -> Result<Slot, OpenFailure> {
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(classify)?;
    conn.busy_timeout(BUSY_TIMEOUT).map_err(classify)?;
    // 첫 읽기에서 "SQLite 파일이 아니다" 가 드러난다.
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(classify)?;
    let version = u32::try_from(version)
        .map_err(|_| OpenFailure::Corrupt("negative schema version".into()))?;
    if version > SCHEMA_VERSION {
        // 새 앱이 만든 파일 — 점검도 구조 변경도 하지 않는다 (옛 앱이 새 앱의 파일을 깨진 것으로 옮겨 버리지 않게).
        drop(conn);
        log::warn!(
            "app database version {version} is newer than supported {SCHEMA_VERSION}; opening read-only"
        );
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|err| OpenFailure::Other(err.to_string()))?;
        conn.busy_timeout(BUSY_TIMEOUT)
            .map_err(|err| OpenFailure::Other(err.to_string()))?;
        return Ok(Slot::ReadOnly { conn, version });
    }
    // 속이 망가졌는지 빨리 본다 (작은 파일이라 짧다)
    let check: String = conn
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(classify)?;
    if check != "ok" {
        return Err(OpenFailure::Corrupt(format!("quick_check: {check}")));
    }
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(classify)?;
    migrations::apply(&mut conn, version, migrations::MIGRATIONS).map_err(classify)?;
    Ok(Slot::Ready(conn))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// `nyanitor.db` → `nyanitor.db.corrupt-<유닉스 시각>` (같은 이름이 있으면 `-<번호>`). 곁 파일도 같은 꼬리로 옮긴다 (남겨 두면 새 DB 에 섞인다).
/// 곁 파일을 못 옮기면 지운다 — 그것도 못 하면 오류.
fn move_aside(path: &Path) -> std::io::Result<PathBuf> {
    let stamp = now_secs();
    let mut tail = format!(".corrupt-{stamp}");
    let mut attempt = 1;
    while with_suffix(path, &tail).exists()
        || SIDE_FILES
            .iter()
            .any(|side| with_suffix(&with_suffix(path, side), &tail).exists())
    {
        tail = format!(".corrupt-{stamp}-{attempt}");
        attempt += 1;
    }
    let aside = with_suffix(path, &tail);
    fs::rename(path, &aside)?;
    for side in SIDE_FILES {
        let from = with_suffix(path, side);
        if from.exists() && fs::rename(&from, with_suffix(&from, &tail)).is_err() {
            fs::remove_file(&from)?;
        }
    }
    Ok(aside)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    fn user_version(path: &Path) -> u32 {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn count(db: &AppDb) -> i64 {
        db.read(|conn| Ok(conn.query_row("SELECT count(*) FROM projects", [], |r| r.get(0))?))
            .unwrap()
    }

    fn insert_row(db: &AppDb, key: &str) {
        db.write(|conn| {
            conn.execute(
                "INSERT INTO projects (path, path_key, name, created_at, last_opened_at) VALUES (?1, ?1, 'n', 1, 1)",
                [key],
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn corrupt_files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_new_database_is_created_at_the_latest_number() {
        let dir = TempDir::new("db-new");
        let path = dir.join("sub").join(DB_FILE); // 폴더도 만든다
        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::Ready);
        assert_eq!(count(&db), 0);
        drop(db);
        assert_eq!(user_version(&path), SCHEMA_VERSION);
    }

    #[test]
    fn an_existing_current_database_keeps_its_rows() {
        let dir = TempDir::new("db-again");
        let path = dir.join(DB_FILE);
        let db = AppDb::open(&path);
        insert_row(&db, "a");
        drop(db);
        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::Ready);
        assert_eq!(count(&db), 1);
        assert_eq!(user_version(&path), SCHEMA_VERSION);
        assert!(corrupt_files(&dir).is_empty());
    }

    #[test]
    fn an_empty_file_is_a_new_database() {
        // 0바이트 파일은 SQLite 에게 새 DB 다 — 앱이 만들다 끊긴 경우
        let dir = TempDir::new("db-empty");
        let path = dir.join(DB_FILE);
        fs::write(&path, b"").unwrap();
        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::Ready);
        assert!(corrupt_files(&dir).is_empty());
    }

    #[test]
    fn a_newer_database_is_read_only_and_left_untouched() {
        let dir = TempDir::new("db-newer");
        let path = dir.join(DB_FILE);
        {
            let db = AppDb::open(&path);
            insert_row(&db, "keep");
        }
        let newer = SCHEMA_VERSION + 4;
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", newer).unwrap();
        }
        let before = fs::read(&path).unwrap();

        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::ReadOnly { version: newer });
        // 읽기는 된다
        assert_eq!(count(&db), 1);
        // 쓰기는 알아볼 수 있는 오류로 거절
        let err = db.write(|_| Ok(())).unwrap_err();
        assert_eq!(err.kind(), "db_read_only");
        drop(db);
        // 파일은 그대로, 옮겨지지도 않았다
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(user_version(&path), newer);
        assert!(corrupt_files(&dir).is_empty());
    }

    #[test]
    fn a_file_that_is_not_a_database_is_moved_aside_and_replaced() {
        let dir = TempDir::new("db-garbage");
        let path = dir.join(DB_FILE);
        let garbage = b"this is certainly not a sqlite database, just some text".repeat(40);
        fs::write(&path, &garbage).unwrap();
        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::Ready);
        assert_eq!(count(&db), 0);
        let aside = corrupt_files(&dir);
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert!(aside[0].starts_with("nyanitor.db.corrupt-"));
        // 옛 내용은 그대로 옮겨져 있다
        assert_eq!(fs::read(dir.join(&aside[0])).unwrap(), garbage);
    }

    #[test]
    fn a_database_that_is_broken_inside_is_moved_aside_too() {
        let dir = TempDir::new("db-broken-inside");
        let path = dir.join(DB_FILE);
        {
            let db = AppDb::open(&path);
            for i in 0..40 {
                insert_row(
                    &db,
                    &format!("some-quite-long-project-key-number-{i}-{}", "x".repeat(200)),
                );
            }
        }
        // 머리(1쪽)는 두고 나머지 쪽을 망가뜨린다
        let mut bytes = fs::read(&path).unwrap();
        assert!(bytes.len() > 8192, "need more than the first page");
        for byte in &mut bytes[4096..] {
            *byte = 0xFF;
        }
        fs::write(&path, &bytes).unwrap();

        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::Ready);
        assert_eq!(count(&db), 0);
        assert_eq!(corrupt_files(&dir).len(), 1);
    }

    #[test]
    fn no_stale_side_files_stay_next_to_the_new_database() {
        // SQLite 가 열다가 스스로 치우는 곁 파일도 있다 — 어느 쪽이든 새 DB 옆에는 남지 않는다
        let dir = TempDir::new("db-side");
        let path = dir.join(DB_FILE);
        fs::write(
            &path,
            b"not a database at all, not at all, not at all, not at all",
        )
        .unwrap();
        for side in SIDE_FILES {
            fs::write(dir.join(format!("nyanitor.db{side}")), b"stale").unwrap();
        }
        let db = AppDb::open(&path);
        assert_eq!(db.status(), DbStatus::Ready);
        for side in SIDE_FILES {
            assert!(
                !dir.join(format!("nyanitor.db{side}")).exists(),
                "{side} left behind"
            );
        }
    }

    #[test]
    fn moving_aside_takes_the_side_files_along() {
        let dir = TempDir::new("db-move");
        let path = dir.join(DB_FILE);
        fs::write(&path, b"main").unwrap();
        for side in SIDE_FILES {
            fs::write(dir.join(format!("nyanitor.db{side}")), side.as_bytes()).unwrap();
        }
        let aside = move_aside(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(fs::read(&aside).unwrap(), b"main");
        let tail = aside
            .to_string_lossy()
            .rsplit_once(".corrupt-")
            .unwrap()
            .1
            .to_string();
        for side in SIDE_FILES {
            assert!(!dir.join(format!("nyanitor.db{side}")).exists());
            let moved = dir.join(format!("nyanitor.db{side}.corrupt-{tail}"));
            assert_eq!(fs::read(&moved).unwrap(), side.as_bytes());
        }
        // 같은 시각에 또 옮기면 이름이 겹치지 않는다
        fs::write(&path, b"second").unwrap();
        let second = move_aside(&path).unwrap();
        assert_ne!(second, aside);
        assert_eq!(fs::read(&aside).unwrap(), b"main");
    }

    #[test]
    fn two_corrupt_files_do_not_overwrite_each_other() {
        let dir = TempDir::new("db-twice");
        let path = dir.join(DB_FILE);
        for text in [
            "first garbage file, long enough to look like text",
            "second garbage file, also long enough to be text",
        ] {
            drop(AppDb::open(&path)); // 정상 DB 를 만든 뒤
            fs::write(&path, text).unwrap(); // 다시 망가뜨린다
            drop(AppDb::open(&path));
        }
        let aside = corrupt_files(&dir);
        assert_eq!(aside.len(), 2, "{aside:?}");
        let mut texts: Vec<String> = aside
            .iter()
            .map(|name| fs::read_to_string(dir.join(name)).unwrap())
            .collect();
        texts.sort();
        assert!(texts[0].starts_with("first"));
        assert!(texts[1].starts_with("second"));
    }

    #[test]
    fn a_database_that_cannot_be_opened_does_not_stop_the_app() {
        // 데이터 폴더 자리에 파일이 있다 → 폴더를 만들 수 없다
        let dir = TempDir::new("db-nofolder");
        let blocker = dir.join("data");
        fs::write(&blocker, b"i am a file").unwrap();
        let db = AppDb::open(&blocker.join(DB_FILE));
        assert!(matches!(db.status(), DbStatus::Unavailable(_)));
        for err in [
            db.read(|_| Ok(())).unwrap_err(),
            db.write(|_| Ok(())).unwrap_err(),
        ] {
            assert_eq!(err.kind(), "db_unavailable");
        }
    }

    #[test]
    fn a_folder_in_place_of_the_file_is_unavailable_and_not_moved() {
        let dir = TempDir::new("db-isdir");
        let path = dir.join(DB_FILE);
        fs::create_dir(&path).unwrap();
        let db = AppDb::open(&path);
        assert!(matches!(db.status(), DbStatus::Unavailable(_)));
        assert!(path.is_dir(), "left where it was");
        assert!(corrupt_files(&dir).is_empty());
    }

    #[test]
    fn domain_errors_from_the_closure_pass_through() {
        let dir = TempDir::new("db-pass");
        let db = AppDb::open(&dir.join(DB_FILE));
        let err = db
            .write::<()>(|_| Err(AppError::ProjectNotFound(9)))
            .unwrap_err();
        assert_eq!(err.kind(), "project_not_found");
    }
}
