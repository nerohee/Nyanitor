//! 앱 DB 구조 변경 — 번호를 붙여 차례대로 (D-47). 번호는 SQLite 의 `PRAGMA user_version` 에 둔다.
//!
//! - 새 구조 변경은 `MIGRATIONS` 맨 끝에 더한다. 이미 낸 것은 고치지 않는다 (번호 = 위치 + 1).
//! - 한 번호는 한 트랜잭션: 구조 변경과 `user_version` 올리기가 같이 끝나거나 같이 취소된다. 중간에 실패해도 이전 번호 그대로다.

use rusqlite::{Connection, TransactionBehavior};

/// 1번 — 프로젝트 등록 (P6-01).
/// - `id` 는 `AUTOINCREMENT`: 뺀 프로젝트의 번호를 다른 프로젝트가 물려받지 않는다 (화면에 남은 옛 번호가 엉뚱한 폴더를 가리키지 않게).
/// - `path_key` 는 `project_key(path)` — 같은 폴더를 다른 글자로 두 번 등록하지 못하게 겹치지 않는다.
/// - 시각은 초 단위 유닉스 시각. `last_opened_at` 은 만들 때 `created_at` 과 같다.
const V1_PROJECTS: &str = "
CREATE TABLE projects (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT    NOT NULL,
    path_key       TEXT    NOT NULL UNIQUE,
    name           TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    skill          TEXT    CHECK (skill IS NULL OR skill IN ('/desktop-app', '/web-full', '/web-lite')),
    created_at     INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
);
";

/// 번호 순서 (1번 = 0번째).
pub const MIGRATIONS: &[&str] = &[V1_PROJECTS];

/// 이 앱이 아는 가장 새 번호.
pub const SCHEMA_VERSION: u32 = MIGRATIONS.len() as u32;

/// `from` 번 다음부터 끝까지 차례대로 적용한다. 실패하면 그 번호는 취소되고(이전 번호 그대로) 오류를 돌려준다.
pub fn apply(conn: &mut Connection, from: u32, migrations: &[&str]) -> Result<(), rusqlite::Error> {
    for (index, sql) in migrations.iter().enumerate().skip(from as usize) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(conn: &Connection) -> u32 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn the_version_is_the_number_of_steps() {
        assert_eq!(SCHEMA_VERSION as usize, MIGRATIONS.len());
    }

    #[test]
    fn applies_every_step_to_a_new_database() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        assert_eq!(version(&conn), SCHEMA_VERSION);
        conn.execute(
            "INSERT INTO projects (path, path_key, name, created_at, last_opened_at) VALUES ('a', 'a', 'a', 1, 1)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn applying_from_the_current_number_changes_nothing() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        // 한 번 더 — 이미 있는 표를 다시 만들려 하면 실패한다. 건너뛰어야 한다.
        apply(&mut conn, SCHEMA_VERSION, MIGRATIONS).unwrap();
        assert_eq!(version(&conn), SCHEMA_VERSION);
    }

    #[test]
    fn a_step_that_fails_is_rolled_back_and_the_number_stays() {
        let mut conn = Connection::open_in_memory().unwrap();
        let steps = [
            "CREATE TABLE one (id INTEGER);",
            "CREATE TABLE two (id INTEGER); THIS IS NOT SQL;",
        ];
        assert!(apply(&mut conn, 0, &steps).is_err());
        // 1번은 끝났고, 2번은 표도 번호도 남지 않는다
        assert_eq!(version(&conn), 1);
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(tables, ["one"]);
    }

    #[test]
    fn the_projects_table_rejects_bad_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        let insert = |key: &str, name: &str, skill: Option<&str>| {
            conn.execute(
                "INSERT INTO projects (path, path_key, name, skill, created_at, last_opened_at) VALUES (?1, ?1, ?2, ?3, 1, 1)",
                rusqlite::params![key, name, skill],
            )
        };
        assert!(insert("k1", "ok", None).is_ok());
        assert!(insert("k1", "again", None).is_err(), "same key twice");
        assert!(insert("k2", "   ", None).is_err(), "blank name");
        assert!(insert("k3", "x", Some("/nope")).is_err(), "unknown skill");
        assert!(insert("k4", "x", Some("/web-lite")).is_ok());
    }
}
