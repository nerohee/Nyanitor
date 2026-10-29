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

/// 2번 — 세션 기록 (P6-03): 이어 하기 세션 ID · 채팅 기록 · 턴마다의 토큰 · 비용.
/// - 세 표 모두 프로젝트에 묶인다 (`ON DELETE CASCADE` — 프로젝트를 빼면 같이 지워진다. 폴더 · 파일은 그대로).
/// - `sessions`: 프로젝트마다 CLI 세션 ID 여럿 (이어 하기는 그중 `last_seen_at` 이 가장 늦은 것). 시각은 초 단위 유닉스 시각.
///   `session_id` 는 UUID 모양(36자)만 — `--resume <ID>` 인자로 들어가므로 한 번 더 막는다 (코드도 읽을 때 모양을 다시 본다).
/// - `chat_items`: 화면이 다시 그릴 이벤트의 JSON(`body`)을 순서대로(`id`, `AUTOINCREMENT` — 지운 뒤에도 거꾸로 가지 않는다).
///   `run_id` 는 앱이 세션 프로세스를 띄운 때(밀리초, 앱 실행마다 겹치지 않음) — 지금 살아 있는 세션의 카드인지 가리는 데 쓴다.
///   `request_id` 는 권한 · 질문 요청과 그 답 · 취소를 짝짓는 열쇠.
/// - `usage_turns`: 턴이 끝날 때마다 한 줄 — 토큰 4종 · 그 턴 비용 · 결과 · 그때 구독인지(`api_key_source`: `none` = 구독).
const V2_SESSION_RECORDS: &str = "
CREATE TABLE sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id    TEXT    NOT NULL CHECK (length(session_id) = 36),
    first_seen_at INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    UNIQUE (project_id, session_id)
);
CREATE INDEX sessions_last ON sessions (project_id, last_seen_at DESC, id DESC);

CREATE TABLE chat_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id TEXT,
    run_id     INTEGER NOT NULL,
    at         INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    request_id TEXT,
    body       TEXT    NOT NULL,
    truncated  INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1))
);
CREATE INDEX chat_items_by_project ON chat_items (project_id, id);
CREATE INDEX chat_items_by_request ON chat_items (project_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE usage_turns (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    session_id            TEXT,
    run_id                INTEGER NOT NULL,
    at                    INTEGER NOT NULL,
    input_tokens          INTEGER NOT NULL,
    output_tokens         INTEGER NOT NULL,
    cache_creation_tokens INTEGER NOT NULL,
    cache_read_tokens     INTEGER NOT NULL,
    cost_usd              REAL    NOT NULL,
    outcome               TEXT    NOT NULL CHECK (outcome IN ('success', 'interrupted', 'error', 'limit')),
    api_key_source        TEXT
);
CREATE INDEX usage_turns_by_time ON usage_turns (at);
CREATE INDEX usage_turns_by_project ON usage_turns (project_id, at);
";

/// 번호 순서 (1번 = 0번째).
pub const MIGRATIONS: &[&str] = &[V1_PROJECTS, V2_SESSION_RECORDS];

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

    fn tables(conn: &Connection) -> Vec<String> {
        conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn conn_with_foreign_keys() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        conn
    }

    #[test]
    fn step_two_adds_the_session_record_tables_on_top_of_a_number_one_database() {
        // 1번까지만 적용된 DB (이 앱의 앞 판이 만든 것) 에 프로젝트가 있다
        let mut conn = conn_with_foreign_keys();
        apply(&mut conn, 0, &MIGRATIONS[..1]).unwrap();
        assert_eq!(version(&conn), 1);
        assert_eq!(tables(&conn), ["projects"]);
        conn.execute(
            "INSERT INTO projects (path, path_key, name, created_at, last_opened_at) VALUES ('p', 'p', 'keep me', 5, 6)",
            [],
        )
        .unwrap();

        apply(&mut conn, 1, MIGRATIONS).unwrap();
        assert_eq!(version(&conn), 2);
        assert_eq!(SCHEMA_VERSION, 2);
        assert_eq!(
            tables(&conn),
            ["chat_items", "projects", "sessions", "usage_turns"]
        );
        // 앞 번호의 데이터는 그대로
        let row: (String, i64, i64) = conn
            .query_row(
                "SELECT name, created_at, last_opened_at FROM projects WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row, ("keep me".to_string(), 5, 6));
        // 새 표는 비어 있고 쓸 수 있다
        conn.execute(
            "INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at) VALUES (1, '00000000-0000-4000-8000-000000000001', 1, 1)",
            [],
        )
        .unwrap();
    }

    #[test]
    fn a_new_database_gets_both_numbers_in_one_go() {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        assert_eq!(version(&conn), SCHEMA_VERSION);
        assert_eq!(
            tables(&conn),
            ["chat_items", "projects", "sessions", "usage_turns"]
        );
    }

    #[test]
    fn the_record_tables_reject_bad_rows_and_follow_their_project() {
        let mut conn = conn_with_foreign_keys();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        conn.execute(
            "INSERT INTO projects (path, path_key, name, created_at, last_opened_at) VALUES ('p', 'p', 'p', 1, 1)",
            [],
        )
        .unwrap();
        let id36 = "00000000-0000-4000-8000-000000000001";
        let insert_session = |project: i64, id: &str| {
            conn.execute(
                "INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at) VALUES (?1, ?2, 1, 1)",
                rusqlite::params![project, id],
            )
        };
        assert!(insert_session(1, id36).is_ok());
        assert!(insert_session(1, id36).is_err(), "same session twice");
        assert!(insert_session(1, "short").is_err(), "not 36 characters");
        assert!(insert_session(9, id36).is_err(), "unregistered project");

        assert!(
            conn.execute(
                "INSERT INTO chat_items (project_id, run_id, at, kind, body) VALUES (9, 1, 1, 'text', '{}')",
                [],
            )
            .is_err()
        );
        assert!(
            conn.execute(
                "INSERT INTO chat_items (project_id, run_id, at, kind, body, truncated) VALUES (1, 1, 1, 'text', '{}', 2)",
                [],
            )
            .is_err()
        );
        conn.execute(
            "INSERT INTO chat_items (project_id, run_id, at, kind, body) VALUES (1, 1, 1, 'text', '{}')",
            [],
        )
        .unwrap();
        let usage = |outcome: &str| {
            conn.execute(
                "INSERT INTO usage_turns (project_id, run_id, at, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, outcome)
                 VALUES (1, 1, 1, 0, 0, 0, 0, 0.0, ?1)",
                [outcome],
            )
        };
        assert!(usage("success").is_ok());
        assert!(usage("limit").is_ok());
        assert!(usage("nope").is_err());

        // 프로젝트를 지우면 셋 모두 같이 지워진다
        conn.execute("DELETE FROM projects WHERE id = 1", [])
            .unwrap();
        for table in ["sessions", "chat_items", "usage_turns"] {
            let left: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(left, 0, "{table}");
        }
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
