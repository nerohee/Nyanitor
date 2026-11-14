//! 프로젝트 표(`projects`)의 SQL — 연결을 받아 읽고 쓰는 일반 함수들. 시각은 호출하는 쪽이 정해 준다 (시험에서 고정할 수 있게).

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::Skill;
use crate::error::AppError;

/// 표의 한 줄
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub id: i64,
    /// 사람에게 보이는 폴더 경로 (고른 그대로)
    pub path: String,
    pub name: String,
    pub skill: Option<Skill>,
    pub created_at: i64,
    pub last_opened_at: i64,
}

const COLUMNS: &str = "id, path, name, skill, created_at, last_opened_at";

fn row_of(row: &Row<'_>) -> rusqlite::Result<ProjectRow> {
    let skill: Option<String> = row.get(3)?;
    Ok(ProjectRow {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        // 새 앱이 더한 스킬 이름은 모르는 값 — 없음으로 보인다 (읽기 전용으로 열었을 때)
        skill: skill.as_deref().and_then(Skill::parse),
        created_at: row.get(4)?,
        last_opened_at: row.get(5)?,
    })
}

/// 최근에 연 순서 (같은 때면 나중에 만든 것이 먼저)
pub fn list(conn: &Connection) -> Result<Vec<ProjectRow>, AppError> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM projects ORDER BY last_opened_at DESC, id DESC"
    ))?;
    let rows = statement
        .query_map([], row_of)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: i64) -> Result<Option<ProjectRow>, AppError> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM projects WHERE id = ?1"),
            [id],
            row_of,
        )
        .optional()?)
}

pub fn find_by_key(conn: &Connection, key: &str) -> Result<Option<ProjectRow>, AppError> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM projects WHERE path_key = ?1"),
            [key],
            row_of,
        )
        .optional()?)
}

/// 등록한다. 같은 폴더 키가 이미 있으면 새로 만들지 않고 있던 줄을 돌려준다 (이름 · 스킬도 바꾸지 않는다).
pub fn insert(
    conn: &Connection,
    path: &str,
    key: &str,
    name: &str,
    skill: Option<Skill>,
    now: i64,
) -> Result<ProjectRow, AppError> {
    conn.execute(
        "INSERT INTO projects (path, path_key, name, skill, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(path_key) DO NOTHING",
        params![path, key, name, skill.map(Skill::as_str), now],
    )?;
    find_by_key(conn, key)?.ok_or_else(|| {
        AppError::DbUnavailable("the project row is missing right after inserting it".into())
    })
}

/// 이름 · 스킬을 고친다. `skill` 은 `None` = 그대로, `Some(None)` = 스킬 없음으로.
pub fn update(
    conn: &Connection,
    id: i64,
    name: Option<&str>,
    skill: Option<Option<Skill>>,
) -> Result<ProjectRow, AppError> {
    if let Some(name) = name {
        conn.execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
    }
    if let Some(skill) = skill {
        conn.execute(
            "UPDATE projects SET skill = ?1 WHERE id = ?2",
            params![skill.map(Skill::as_str), id],
        )?;
    }
    get(conn, id)?.ok_or(AppError::ProjectNotFound(id))
}

/// 등록을 지운다 — 그 프로젝트의 세션 ID · 채팅 기록 · 츄르도 같이 (앱 데이터라서). 폴더 · 파일은 건드리지 않는다.
/// 표의 `ON DELETE CASCADE` 가 같은 일을 하지만 연결이 외래 키를 켜지 않았어도 남지 않게 먼저 직접 지운다. 한 트랜잭션이라 일부만 지워지지 않는다.
pub fn remove(conn: &Connection, id: i64) -> Result<(), AppError> {
    let tx = conn.unchecked_transaction()?;
    for table in ["sessions", "chat_items", "usage_turns", "project_trust"] {
        tx.execute(&format!("DELETE FROM {table} WHERE project_id = ?1"), [id])?;
    }
    match tx.execute("DELETE FROM projects WHERE id = ?1", [id])? {
        0 => Err(AppError::ProjectNotFound(id)),
        _ => {
            tx.commit()?;
            Ok(())
        }
    }
}

/// 마지막으로 연 때를 지금으로
pub fn touch(conn: &Connection, id: i64, now: i64) -> Result<(), AppError> {
    match conn.execute(
        "UPDATE projects SET last_opened_at = ?1 WHERE id = ?2",
        params![now, id],
    )? {
        0 => Err(AppError::ProjectNotFound(id)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations::{MIGRATIONS, apply};

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        conn
    }

    #[test]
    fn insert_then_get_and_list() {
        let conn = conn();
        let row = insert(
            &conn,
            "C:\\dev\\a",
            "c:\\dev\\a",
            "a",
            Some(Skill::WebLite),
            100,
        )
        .unwrap();
        assert_eq!(row.id, 1);
        assert_eq!(row.path, "C:\\dev\\a");
        assert_eq!(row.name, "a");
        assert_eq!(row.skill, Some(Skill::WebLite));
        assert_eq!((row.created_at, row.last_opened_at), (100, 100));
        assert_eq!(get(&conn, 1).unwrap(), Some(row.clone()));
        assert_eq!(list(&conn).unwrap(), vec![row]);
        assert_eq!(get(&conn, 2).unwrap(), None);
    }

    #[test]
    fn the_same_key_is_registered_once_and_returns_the_existing_row() {
        let conn = conn();
        let first = insert(&conn, "C:\\dev\\a", "c:\\dev\\a", "first", None, 100).unwrap();
        // 다른 글자(대소문자) 로 같은 키 — 새 줄이 생기지 않고 이름 · 스킬도 그대로
        let second = insert(
            &conn,
            "c:/DEV/a",
            "c:\\dev\\a",
            "second",
            Some(Skill::WebFull),
            200,
        )
        .unwrap();
        assert_eq!(second, first);
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn list_is_most_recently_opened_first_with_ties_newest_first() {
        let conn = conn();
        insert(&conn, "a", "a", "a", None, 100).unwrap();
        insert(&conn, "b", "b", "b", None, 100).unwrap();
        insert(&conn, "c", "c", "c", None, 50).unwrap();
        let names = |conn: &Connection| -> Vec<String> {
            list(conn).unwrap().into_iter().map(|r| r.name).collect()
        };
        assert_eq!(names(&conn), ["b", "a", "c"]);
        touch(&conn, 3, 500).unwrap();
        assert_eq!(names(&conn), ["c", "b", "a"]);
        assert_eq!(get(&conn, 3).unwrap().unwrap().last_opened_at, 500);
        assert_eq!(get(&conn, 3).unwrap().unwrap().created_at, 50);
    }

    #[test]
    fn update_changes_only_what_is_given() {
        let conn = conn();
        insert(&conn, "a", "a", "old", Some(Skill::DesktopApp), 1).unwrap();
        let row = update(&conn, 1, Some("new"), None).unwrap();
        assert_eq!(
            (row.name.as_str(), row.skill),
            ("new", Some(Skill::DesktopApp))
        );
        let row = update(&conn, 1, None, Some(Some(Skill::WebFull))).unwrap();
        assert_eq!(
            (row.name.as_str(), row.skill),
            ("new", Some(Skill::WebFull))
        );
        let row = update(&conn, 1, None, Some(None)).unwrap();
        assert_eq!((row.name.as_str(), row.skill), ("new", None));
        let row = update(&conn, 1, None, None).unwrap();
        assert_eq!(row.name, "new");
    }

    #[test]
    fn unknown_ids_are_not_found() {
        let conn = conn();
        assert_eq!(
            update(&conn, 7, Some("x"), None).unwrap_err().kind(),
            "project_not_found"
        );
        assert_eq!(remove(&conn, 7).unwrap_err().kind(), "project_not_found");
        assert_eq!(touch(&conn, 7, 1).unwrap_err().kind(), "project_not_found");
    }

    #[test]
    fn remove_deletes_only_that_row_and_ids_are_not_reused() {
        let conn = conn();
        insert(&conn, "a", "a", "a", None, 1).unwrap();
        insert(&conn, "b", "b", "b", None, 1).unwrap();
        remove(&conn, 2).unwrap();
        assert_eq!(list(&conn).unwrap().len(), 1);
        // 뺀 번호를 새 프로젝트가 물려받지 않는다 (화면에 남은 옛 번호가 엉뚱한 폴더를 가리키지 않게)
        let row = insert(&conn, "c", "c", "c", None, 1).unwrap();
        assert_eq!(row.id, 3);
        // 같은 폴더를 다시 등록할 수 있다
        remove(&conn, 1).unwrap();
        assert!(insert(&conn, "a", "a", "a", None, 1).is_ok());
    }

    #[test]
    fn remove_also_drops_the_projects_sessions_history_and_chure_even_with_foreign_keys_off() {
        // 이 시험의 연결은 외래 키를 켜지 않았다 — `ON DELETE CASCADE` 에만 기대지 않고 직접 지운다
        let conn = conn();
        insert(&conn, "a", "a", "a", None, 1).unwrap();
        insert(&conn, "b", "b", "b", None, 1).unwrap();
        for project in [1, 2] {
            conn.execute(
                "INSERT INTO sessions (project_id, session_id, first_seen_at, last_seen_at) VALUES (?1, '00000000-0000-4000-8000-000000000001', 1, 1)",
                [project],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO chat_items (project_id, run_id, at, kind, body) VALUES (?1, 1, 1, 'text', '{}')",
                [project],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO usage_turns (project_id, run_id, at, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd, outcome)
                 VALUES (?1, 1, 1, 1, 1, 0, 0, 0.1, 'success')",
                [project],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project_trust (project_id, settings_hash, trusted_at) VALUES (?1, ?2, 1)",
                rusqlite::params![project, "b".repeat(64)],
            )
            .unwrap();
        }
        remove(&conn, 1).unwrap();
        for table in ["sessions", "chat_items", "usage_turns", "project_trust"] {
            let count = |project: i64| -> i64 {
                conn.query_row(
                    &format!("SELECT count(*) FROM {table} WHERE project_id = ?1"),
                    [project],
                    |r| r.get(0),
                )
                .unwrap()
            };
            assert_eq!(count(1), 0, "{table}");
            assert_eq!(count(2), 1, "{table} of the other project");
        }
        // 없는 번호는 아무것도 지우지 않고 오류
        assert_eq!(remove(&conn, 9).unwrap_err().kind(), "project_not_found");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn a_skill_name_this_app_does_not_know_reads_as_none() {
        let conn = conn();
        insert(&conn, "a", "a", "a", None, 1).unwrap();
        // CHECK 가 막으므로 검사 없이 넣어 새 앱이 만든 줄을 흉내 낸다
        conn.execute_batch(
            "PRAGMA ignore_check_constraints = ON; UPDATE projects SET skill = '/future-skill';",
        )
        .unwrap();
        assert_eq!(get(&conn, 1).unwrap().unwrap().skill, None);
    }
}
