//! `chat_items` 표의 SQL — 쓰기 · 세션 ID 채우기 · 오래된 것 지우기 · 쪽 단위 읽기. 연결을 받아 일하는 일반 함수들이다.
//!
//! 읽기 모양: 항목마다 `event`(저장한 이벤트 JSON — 실시간 이벤트와 같은 모양)가 있고, 권한 · 질문 요청 카드에는 `request`(상태 · 답)가 붙는다.
//! `request_answered` · `request_cancelled` 항목은 목록에 따로 나오지 않고 그 카드의 `request` 로 합쳐진다.
//! 카드 상태: `answered`(답함) · `cancelled`(취소됨) · `pending`(지금 살아 있는 세션이 기다리는 중) · `expired`(답 없이 지나감 — 앱을 다시 켰거나 세션이 끝난 뒤라 답할 수 없다).

use rusqlite::{Connection, params};
use serde::Serialize;
use serde_json::Value;
use tauri_plugin_log::log;

use super::RecordCtx;
use super::record::Draft;
use crate::error::AppError;

/// 목록에 따로 나오지 않는 종류 — 요청 카드의 상태로 합쳐진다
const RESOLUTION_KINDS: [&str; 2] = ["request_answered", "request_cancelled"];

/// 한 줄 쓴다. 프로젝트가 이미 없으면(`FOREIGN KEY`) 오류 — 쓰는 쪽이 건너뛴다.
pub fn insert(conn: &Connection, ctx: &RecordCtx, draft: &Draft) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "INSERT INTO chat_items (project_id, session_id, run_id, at, kind, request_id, body, truncated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        ctx.project_id,
        ctx.session_id,
        ctx.run_id,
        ctx.at,
        draft.kind,
        draft.request_id,
        draft.body,
        draft.truncated,
    ])?;
    Ok(())
}

/// 이 실행(`run_id`)에서 세션 ID 를 아직 몰라 비어 있던 항목에 채운다 (세션 ID 는 첫 `system/init` 이 와야 안다).
pub fn bind_session(
    conn: &Connection,
    project_id: i64,
    run_id: i64,
    session_id: &str,
) -> rusqlite::Result<()> {
    conn.prepare_cached(
        "UPDATE chat_items SET session_id = ?3
         WHERE project_id = ?1 AND run_id = ?2 AND session_id IS NULL",
    )?
    .execute(params![project_id, run_id, session_id])?;
    Ok(())
}

/// 프로젝트의 항목이 `max` 를 넘으면 오래된 것부터 지워 `max` 개만 남긴다. 지운 수를 돌려준다.
pub fn trim(conn: &Connection, project_id: i64, max: usize) -> rusqlite::Result<usize> {
    conn.prepare_cached(
        "DELETE FROM chat_items
         WHERE project_id = ?1
           AND id <= (SELECT id FROM chat_items WHERE project_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ?2)",
    )?
    .execute(params![project_id, i64::try_from(max).unwrap_or(i64::MAX)])
}

/// 지금 살아 있는 세션이 답을 기다리는 요청들 — 이것만 `pending` 으로 보인다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveRequests {
    pub project_id: i64,
    pub run_id: i64,
    pub request_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RequestStatus {
    /// 답함 — `answer` 에 답
    Answered,
    /// 취소됨 (중단 · 세션 끝)
    Cancelled,
    /// 지금 살아 있는 세션이 기다리는 중 — 카드에 답할 수 있다
    Pending,
    /// 답 없이 지나갔다 — 카드에 답할 수 없다
    Expired,
}

/// 요청 카드(권한 · 질문)에 붙는 상태
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestState {
    pub status: RequestStatus,
    /// `answered` 일 때 사용자의 답 — `request_answered` 이벤트 모양 그대로
    pub answer: Option<Value>,
}

/// 기록의 항목 하나
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    /// 순서 번호 — 클수록 나중. `before` 로 쓴다
    pub id: i64,
    /// 유닉스 시각(초)
    pub at: i64,
    pub session_id: Option<String>,
    /// 긴 글이 잘렸다
    pub truncated: bool,
    /// 저장한 이벤트 (`type` 이 있는 `ClaudeEvent` 모양)
    pub event: Value,
    /// 권한 · 질문 카드에만
    pub request: Option<RequestState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPage {
    /// 오래된 것이 앞 — 화면이 이미 가진 것 위에 이어 붙인다
    pub entries: Vec<ChatEntry>,
    /// 이 쪽보다 오래된 항목이 더 있다
    pub has_more: bool,
}

struct Row {
    id: i64,
    at: i64,
    session_id: Option<String>,
    run_id: i64,
    kind: String,
    request_id: Option<String>,
    body: String,
    truncated: bool,
}

/// 이 카드가 어떻게 되었나 — 카드 뒤에 온 `request_answered` · `request_cancelled` 를 찾고, 없으면 지금 살아 있는 세션이 기다리는지 본다.
fn resolve(
    conn: &Connection,
    project_id: i64,
    row: &Row,
    live: Option<&LiveRequests>,
) -> Result<RequestState, AppError> {
    let Some(request_id) = row.request_id.as_deref() else {
        return Ok(RequestState {
            status: RequestStatus::Expired,
            answer: None,
        });
    };
    let resolution: Option<(String, String)> = conn
        .prepare_cached(
            "SELECT kind, body FROM chat_items
             WHERE project_id = ?1 AND run_id = ?2 AND request_id = ?3 AND id > ?4
               AND kind IN ('request_answered', 'request_cancelled')
             ORDER BY id LIMIT 1",
        )?
        .query_map(params![project_id, row.run_id, request_id, row.id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .next()
        .transpose()?;
    if let Some((kind, body)) = resolution {
        return Ok(if kind == "request_answered" {
            RequestState {
                status: RequestStatus::Answered,
                answer: serde_json::from_str(&body).ok(),
            }
        } else {
            RequestState {
                status: RequestStatus::Cancelled,
                answer: None,
            }
        });
    }
    let waiting = live.is_some_and(|live| {
        live.project_id == project_id
            && live.run_id == row.run_id
            && live.request_ids.iter().any(|id| id == request_id)
    });
    Ok(RequestState {
        status: if waiting {
            RequestStatus::Pending
        } else {
            RequestStatus::Expired
        },
        answer: None,
    })
}

/// 프로젝트의 채팅 기록 한 쪽 — `before` 보다 앞선(번호가 작은) 것 중 가장 최근 `limit` 개를, 오래된 것이 앞이 되게.
pub fn read_page(
    conn: &Connection,
    project_id: i64,
    before: Option<i64>,
    limit: usize,
    live: Option<&LiveRequests>,
) -> Result<ChatPage, AppError> {
    let before = before.unwrap_or(i64::MAX);
    let want = i64::try_from(limit.saturating_add(1)).unwrap_or(i64::MAX);
    let mut statement = conn.prepare_cached(
        "SELECT id, at, session_id, run_id, kind, request_id, body, truncated FROM chat_items
         WHERE project_id = ?1 AND id < ?2 AND kind NOT IN (?3, ?4)
         ORDER BY id DESC LIMIT ?5",
    )?;
    let mut rows = statement
        .query_map(
            params![
                project_id,
                before,
                RESOLUTION_KINDS[0],
                RESOLUTION_KINDS[1],
                want
            ],
            |r| {
                Ok(Row {
                    id: r.get(0)?,
                    at: r.get(1)?,
                    session_id: r.get(2)?,
                    run_id: r.get(3)?,
                    kind: r.get(4)?,
                    request_id: r.get(5)?,
                    body: r.get(6)?,
                    truncated: r.get(7)?,
                })
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    rows.reverse();
    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let Ok(event) = serde_json::from_str::<Value>(&row.body) else {
            // 손으로 고쳐진 줄 — 그 항목만 건너뛴다
            log::warn!("a chat item could not be read back (id {})", row.id);
            continue;
        };
        let request = if matches!(row.kind.as_str(), "permission_request" | "question_request") {
            Some(resolve(conn, project_id, &row, live)?)
        } else {
            None
        };
        entries.push(ChatEntry {
            id: row.id,
            at: row.at,
            session_id: row.session_id,
            truncated: row.truncated,
            event,
            request,
        });
    }
    Ok(ChatPage { entries, has_more })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations::{MIGRATIONS, apply};
    use serde_json::json;

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        for key in ["a", "b"] {
            conn.execute(
                "INSERT INTO projects (path, path_key, name, created_at, last_opened_at) VALUES (?1, ?1, ?1, 1, 1)",
                [key],
            )
            .unwrap();
        }
        conn
    }

    fn ctx(project_id: i64, run_id: i64) -> RecordCtx {
        RecordCtx {
            project_id,
            run_id,
            session_id: None,
            at: 100,
            api_key_source: None,
        }
    }

    fn put(
        conn: &Connection,
        project_id: i64,
        run_id: i64,
        kind: &'static str,
        request_id: Option<&str>,
        body: Value,
    ) {
        let draft = Draft {
            kind,
            request_id: request_id.map(str::to_string),
            body: body.to_string(),
            truncated: false,
        };
        insert(conn, &ctx(project_id, run_id), &draft).unwrap();
    }

    fn text(conn: &Connection, project_id: i64, n: i64) {
        put(
            conn,
            project_id,
            1,
            "text",
            None,
            json!({ "type": "text", "text": format!("t{n}") }),
        );
    }

    fn texts(page: &ChatPage) -> Vec<String> {
        page.entries
            .iter()
            .map(|e| e.event["text"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn pages_go_from_the_newest_back_and_each_page_is_oldest_first() {
        let conn = conn();
        for n in 1..=7 {
            text(&conn, 1, n);
        }
        let page = read_page(&conn, 1, None, 3, None).unwrap();
        assert_eq!(texts(&page), ["t5", "t6", "t7"]);
        assert!(page.has_more);
        let before = page.entries[0].id;
        let page = read_page(&conn, 1, Some(before), 3, None).unwrap();
        assert_eq!(texts(&page), ["t2", "t3", "t4"]);
        assert!(page.has_more);
        let page = read_page(&conn, 1, Some(page.entries[0].id), 3, None).unwrap();
        assert_eq!(texts(&page), ["t1"]);
        assert!(!page.has_more);
        // 딱 맞는 쪽은 더 없다고 한다
        let exact = read_page(&conn, 1, None, 7, None).unwrap();
        assert_eq!(exact.entries.len(), 7);
        assert!(!exact.has_more);
        // 맨 앞보다 앞은 비었다
        let none = read_page(&conn, 1, Some(page.entries[0].id), 3, None).unwrap();
        assert!(none.entries.is_empty() && !none.has_more);
    }

    #[test]
    fn projects_do_not_see_each_others_items() {
        let conn = conn();
        text(&conn, 1, 1);
        text(&conn, 2, 2);
        assert_eq!(texts(&read_page(&conn, 1, None, 10, None).unwrap()), ["t1"]);
        assert_eq!(texts(&read_page(&conn, 2, None, 10, None).unwrap()), ["t2"]);
        assert!(
            read_page(&conn, 9, None, 10, None)
                .unwrap()
                .entries
                .is_empty()
        );
    }

    #[test]
    fn answers_and_cancels_are_folded_into_their_cards_and_not_listed() {
        let conn = conn();
        put(
            &conn,
            1,
            7,
            "permission_request",
            Some("r1"),
            json!({"type":"permission_request","requestId":"r1"}),
        );
        put(
            &conn,
            1,
            7,
            "permission_request",
            Some("r2"),
            json!({"type":"permission_request","requestId":"r2"}),
        );
        put(
            &conn,
            1,
            7,
            "permission_request",
            Some("r3"),
            json!({"type":"permission_request","requestId":"r3"}),
        );
        put(
            &conn,
            1,
            7,
            "request_answered",
            Some("r1"),
            json!({"type":"request_answered","requestId":"r1","kind":"allow","text":null,"answers":null}),
        );
        put(
            &conn,
            1,
            7,
            "request_cancelled",
            Some("r2"),
            json!({"type":"request_cancelled","requestId":"r2"}),
        );
        let page = read_page(&conn, 1, None, 10, None).unwrap();
        assert_eq!(page.entries.len(), 3, "답 · 취소 항목은 따로 나오지 않는다");
        let state = |n: usize| page.entries[n].request.clone().unwrap();
        assert_eq!(state(0).status, RequestStatus::Answered);
        assert_eq!(state(0).answer.unwrap()["kind"], "allow");
        assert_eq!(state(1).status, RequestStatus::Cancelled);
        assert_eq!(
            state(2).status,
            RequestStatus::Expired,
            "답 없고 살아 있는 세션도 아니다"
        );
    }

    #[test]
    fn an_answer_on_a_newer_page_still_resolves_a_card_on_an_older_page() {
        let conn = conn();
        put(
            &conn,
            1,
            7,
            "question_request",
            Some("q1"),
            json!({"type":"question_request","requestId":"q1"}),
        );
        for n in 1..=5 {
            text(&conn, 1, n);
        }
        put(
            &conn,
            1,
            7,
            "request_answered",
            Some("q1"),
            json!({"type":"request_answered","requestId":"q1","kind":"answer","text":null,"answers":{"Q":"A"}}),
        );
        text(&conn, 1, 6);
        let newest = read_page(&conn, 1, None, 3, None).unwrap();
        let older = read_page(&conn, 1, Some(newest.entries[0].id), 10, None).unwrap();
        let card = older.entries.iter().find(|e| e.request.is_some()).unwrap();
        let state = card.request.clone().unwrap();
        assert_eq!(state.status, RequestStatus::Answered);
        assert_eq!(state.answer.unwrap()["answers"]["Q"], "A");
    }

    #[test]
    fn only_the_live_sessions_waiting_requests_are_pending_the_rest_expire() {
        let conn = conn();
        put(
            &conn,
            1,
            7,
            "permission_request",
            Some("old"),
            json!({"type":"permission_request"}),
        );
        put(
            &conn,
            1,
            8,
            "permission_request",
            Some("old"),
            json!({"type":"permission_request"}),
        );
        put(
            &conn,
            1,
            8,
            "permission_request",
            Some("other"),
            json!({"type":"permission_request"}),
        );
        let live = LiveRequests {
            project_id: 1,
            run_id: 8,
            request_ids: vec!["old".into()],
        };
        let page = read_page(&conn, 1, None, 10, Some(&live)).unwrap();
        let status = |n: usize| page.entries[n].request.clone().unwrap().status;
        // 앞 실행에서 같은 ID 였던 카드는 지나갔다
        assert_eq!(status(0), RequestStatus::Expired);
        assert_eq!(status(1), RequestStatus::Pending);
        assert_eq!(
            status(2),
            RequestStatus::Expired,
            "이 실행의 카드라도 세션이 기다리지 않는 것은 지나감"
        );
        // 다른 프로젝트의 세션이 살아 있어도 이 프로젝트의 카드는 기다림이 아니다
        let elsewhere = LiveRequests {
            project_id: 2,
            ..live
        };
        let page = read_page(&conn, 1, None, 10, Some(&elsewhere)).unwrap();
        assert!(
            page.entries
                .iter()
                .all(|e| e.request.as_ref().unwrap().status == RequestStatus::Expired)
        );
    }

    #[test]
    fn a_row_that_is_not_json_is_skipped_without_failing_the_page() {
        let conn = conn();
        text(&conn, 1, 1);
        conn.execute(
            "INSERT INTO chat_items (project_id, run_id, at, kind, body) VALUES (1, 1, 1, 'text', 'not json {')",
            [],
        )
        .unwrap();
        text(&conn, 1, 2);
        let page = read_page(&conn, 1, None, 10, None).unwrap();
        assert_eq!(texts(&page), ["t1", "t2"]);
    }

    #[test]
    fn trimming_keeps_only_the_newest_and_only_for_that_project() {
        let conn = conn();
        for n in 1..=10 {
            text(&conn, 1, n);
        }
        text(&conn, 2, 99);
        assert_eq!(trim(&conn, 1, 4).unwrap(), 6);
        assert_eq!(
            texts(&read_page(&conn, 1, None, 50, None).unwrap()),
            ["t7", "t8", "t9", "t10"]
        );
        assert_eq!(
            texts(&read_page(&conn, 2, None, 50, None).unwrap()),
            ["t99"]
        );
        // 이미 한도 안이면 아무것도 안 지운다
        assert_eq!(trim(&conn, 1, 4).unwrap(), 0);
        assert_eq!(trim(&conn, 1, 100).unwrap(), 0);
        // 한도 0 은 다 지운다
        assert_eq!(trim(&conn, 1, 0).unwrap(), 4);
    }

    #[test]
    fn ids_keep_growing_after_everything_is_trimmed() {
        let conn = conn();
        text(&conn, 1, 1);
        let first = read_page(&conn, 1, None, 5, None).unwrap().entries[0].id;
        trim(&conn, 1, 0).unwrap();
        text(&conn, 1, 2);
        let second = read_page(&conn, 1, None, 5, None).unwrap().entries[0].id;
        assert!(
            second > first,
            "지운 번호를 다시 쓰지 않는다 (화면이 쥔 `before` 가 거꾸로 가지 않게)"
        );
    }

    #[test]
    fn binding_fills_only_the_empty_session_ids_of_that_run() {
        let conn = conn();
        put(&conn, 1, 5, "text", None, json!({"type":"text","text":"a"}));
        put(&conn, 1, 6, "text", None, json!({"type":"text","text":"b"}));
        conn.execute(
            "INSERT INTO chat_items (project_id, session_id, run_id, at, kind, body) VALUES (1, 'keep', 5, 1, 'text', '{}')",
            [],
        )
        .unwrap();
        bind_session(&conn, 1, 5, "s-new").unwrap();
        let ids: Vec<(i64, Option<String>)> = conn
            .prepare("SELECT run_id, session_id FROM chat_items ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            ids,
            [
                (5, Some("s-new".to_string())),
                (6, None),
                (5, Some("keep".to_string()))
            ]
        );
    }

    #[test]
    fn a_removed_project_takes_its_items_along_and_new_writes_for_it_fail() {
        let conn = conn();
        text(&conn, 1, 1);
        conn.execute("DELETE FROM projects WHERE id = 1", [])
            .unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM chat_items", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let draft = Draft {
            kind: "text",
            request_id: None,
            body: "{}".into(),
            truncated: false,
        };
        assert!(insert(&conn, &ctx(1, 1), &draft).is_err());
    }
}
