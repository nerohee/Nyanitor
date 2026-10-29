//! `usage_turns` 표 — 턴이 끝날 때마다 한 줄(토큰 4종 · 그 턴 비용 · 결과 · 구독인지)을 쌓고, 합을 낸다 (D-24).
//!
//! 합은 **앱이 돌린 세션**만의 것이다 — CLI 기록 파일은 읽지 않는다. 구독자에게 비용은 "참고용 추정"이라, 합마다 구독 턴 수 · 키 턴 수를 같이 줘서
//! 화면이 표시를 고른다 (`reference_only`). 비용은 `TurnSummary.cost_usd` (이미 턴 몫 — D-44)의 합이다.
//!
//! "오늘" 은 이 PC 의 자정부터다 (`local_day_start`). 서머타임이 바뀐 날은 한 시간 어긋날 수 있다.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, Row, params};
use serde::Serialize;

use super::RecordCtx;
use crate::claude::events::{TurnOutcome, TurnSummary};
use crate::error::AppError;

/// `api_key_source` 글의 상한 (표에 이상한 긴 글이 들어가지 않게)
const SOURCE_CHARS: usize = 64;

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn outcome_name(outcome: TurnOutcome) -> &'static str {
    match outcome {
        TurnOutcome::Success => "success",
        TurnOutcome::Interrupted => "interrupted",
        TurnOutcome::Error => "error",
        TurnOutcome::Limit => "limit",
    }
}

/// 토큰 수 하나의 상한 (1조) — 이상한 값이 들어와도 합이 SQLite 의 정수 범위를 넘지 않게
const MAX_TOKENS: u64 = 1_000_000_000_000;

fn to_i64(value: u64) -> i64 {
    i64::try_from(value.min(MAX_TOKENS)).unwrap_or(i64::MAX)
}

/// 턴 하나를 쌓는다. 프로젝트가 이미 없으면(`FOREIGN KEY`) 오류 — 쓰는 쪽이 건너뛴다.
pub fn insert(conn: &Connection, ctx: &RecordCtx, summary: &TurnSummary) -> rusqlite::Result<()> {
    let source = ctx
        .api_key_source
        .as_deref()
        .map(|text| text.chars().take(SOURCE_CHARS).collect::<String>());
    conn.prepare_cached(
        "INSERT INTO usage_turns
            (project_id, session_id, run_id, at, input_tokens, output_tokens,
             cache_creation_tokens, cache_read_tokens, cost_usd, outcome, api_key_source)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?
    .execute(params![
        ctx.project_id,
        ctx.session_id,
        ctx.run_id,
        ctx.at,
        to_i64(summary.usage.input_tokens),
        to_i64(summary.usage.output_tokens),
        to_i64(summary.usage.cache_creation_input_tokens),
        to_i64(summary.usage.cache_read_input_tokens),
        if summary.cost_usd.is_finite() {
            summary.cost_usd.max(0.0)
        } else {
            0.0
        },
        outcome_name(summary.outcome),
        source,
    ])?;
    Ok(())
}

/// 턴들의 합
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSum {
    pub turns: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    /// 토큰 4종의 합 (화면의 "츄르 약 n")
    pub total_tokens: u64,
    /// 턴 비용의 합 (USD)
    pub cost_usd: f64,
    /// 구독으로 돌린 턴 수 (`apiKeySource` 가 `none`)
    pub subscription_turns: u64,
    /// 키로 과금된 턴 수 (구독이 아닌 값)
    pub api_key_turns: u64,
    /// 비용이 "참고용 추정" 으로 보여야 한다 — 키로 과금된 것이 아닌 턴(구독 · 모름)이 하나라도 있다
    pub reference_only: bool,
}

impl UsageSum {
    fn add(&mut self, other: &UsageSum) {
        self.turns += other.turns;
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
        self.cost_usd += other.cost_usd;
        self.subscription_turns += other.subscription_turns;
        self.api_key_turns += other.api_key_turns;
        self.finish();
    }

    /// 합에서 나오는 값을 채운다
    fn finish(&mut self) {
        self.total_tokens = self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens;
        self.cost_usd = (self.cost_usd * 1e9).round() / 1e9;
        self.reference_only = self.turns > self.api_key_turns;
    }
}

/// 합의 SQL 칸들 (`sum_of_row` 가 읽는다). `api_key_source` 가 `none` 이면 구독 턴, 그 밖의 값이면 키로 과금된 턴, 모르면(NULL) 어느 쪽도 아니다.
const SUM_COLUMNS: &str = "COUNT(*),
    COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
    COALESCE(SUM(cache_creation_tokens), 0), COALESCE(SUM(cache_read_tokens), 0),
    COALESCE(SUM(cost_usd), 0.0),
    COALESCE(SUM(api_key_source = 'none'), 0),
    COALESCE(SUM(api_key_source IS NOT NULL AND api_key_source <> 'none'), 0)";

fn count(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    Ok(u64::try_from(row.get::<_, i64>(index)?).unwrap_or(0))
}

/// `SUM_COLUMNS` 가 `from` 번째 칸부터 있는 줄에서 합을 읽는다
fn sum_of_row(row: &Row<'_>, from: usize) -> rusqlite::Result<UsageSum> {
    let mut sum = UsageSum {
        turns: count(row, from)?,
        input_tokens: count(row, from + 1)?,
        output_tokens: count(row, from + 2)?,
        cache_creation_input_tokens: count(row, from + 3)?,
        cache_read_input_tokens: count(row, from + 4)?,
        cost_usd: row.get(from + 5)?,
        subscription_turns: count(row, from + 6)?,
        api_key_turns: count(row, from + 7)?,
        ..UsageSum::default()
    };
    sum.finish();
    Ok(sum)
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    pub project_id: i64,
    /// 오늘(이 PC 의 자정부터) 이 프로젝트에서 쓴 합
    pub today: UsageSum,
    /// 지금까지 쓴 합
    pub total: UsageSum,
}

/// 지금 돌고 있는 세션 — 이번 실행(앱이 프로세스를 띄운 때부터)의 합을 낸다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveRun {
    pub project_id: i64,
    pub run_id: i64,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub project_id: i64,
    /// CLI 세션 ID (첫 턴이 시작되기 전에는 `null`)
    pub session_id: Option<String>,
    /// 이번 실행의 합 (이어 하기로 띄운 세션이면 앞 실행의 것은 빼고)
    pub usage: UsageSum,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    /// "오늘" 의 시작 (유닉스 시각(초) — 이 PC 의 자정)
    pub since: i64,
    /// 오늘 앱이 쓴 합 (모든 프로젝트)
    pub today: UsageSum,
    /// 쓴 적이 있는 프로젝트마다 — 번호 순
    pub projects: Vec<ProjectUsage>,
    /// 지금 돌고 있는 세션 (없으면 `null`)
    pub session: Option<SessionUsage>,
}

fn grouped(conn: &Connection, since: Option<i64>) -> Result<BTreeMap<i64, UsageSum>, AppError> {
    let sql = format!(
        "SELECT project_id, {SUM_COLUMNS} FROM usage_turns {} GROUP BY project_id",
        if since.is_some() {
            "WHERE at >= ?1"
        } else {
            ""
        }
    );
    let mut statement = conn.prepare(&sql)?;
    let map = |row: &Row<'_>| Ok((row.get::<_, i64>(0)?, sum_of_row(row, 1)?));
    let rows = match since {
        Some(since) => statement.query_map([since], map)?,
        None => statement.query_map([], map)?,
    };
    Ok(rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()?)
}

/// 합을 낸다. `since` 이후(그때 포함)가 "오늘" 이다.
pub fn summarize(
    conn: &Connection,
    since: i64,
    live: Option<&LiveRun>,
) -> Result<UsageSummary, AppError> {
    let total = grouped(conn, None)?;
    let today_by_project = grouped(conn, Some(since))?;
    let mut today = UsageSum::default();
    for sum in today_by_project.values() {
        today.add(sum);
    }
    let projects = total
        .into_iter()
        .map(|(project_id, total)| ProjectUsage {
            project_id,
            today: today_by_project
                .get(&project_id)
                .copied()
                .unwrap_or_default(),
            total,
        })
        .collect();
    let session = live
        .map(|live| -> Result<SessionUsage, AppError> {
            let usage = conn.query_row(
                &format!(
                    "SELECT {SUM_COLUMNS} FROM usage_turns WHERE project_id = ?1 AND run_id = ?2"
                ),
                params![live.project_id, live.run_id],
                |row| sum_of_row(row, 0),
            )?;
            Ok(SessionUsage {
                project_id: live.project_id,
                session_id: live.session_id.clone(),
                usage,
            })
        })
        .transpose()?;
    Ok(UsageSummary {
        since,
        today,
        projects,
        session,
    })
}

// ───────────────────────── 오늘의 시작 (이 PC 의 자정) ─────────────────────────

/// 이 PC 의 시간대로 `now`(유닉스 초)가 그날 자정에서 몇 초 지났나. 못 알아내면 `None`.
#[cfg(windows)]
fn local_seconds_into_day(now: i64) -> Option<i64> {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};

    // 1601-01-01 부터 100 나노초 단위
    let ticks = u64::try_from(now)
        .ok()?
        .checked_add(11_644_473_600)?
        .checked_mul(10_000_000)?;
    let file_time = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    // SAFETY: 입력은 위에서 만든 값이고, 출력은 0 으로 채운 구조체다. 이 함수들은 읽기 전용 질의다.
    let local = unsafe {
        let mut utc: SYSTEMTIME = std::mem::zeroed();
        let mut local: SYSTEMTIME = std::mem::zeroed();
        if FileTimeToSystemTime(&file_time, &mut utc) == 0 {
            return None;
        }
        if SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) == 0 {
            return None;
        }
        local
    };
    Some(i64::from(local.wHour) * 3600 + i64::from(local.wMinute) * 60 + i64::from(local.wSecond))
}

#[cfg(unix)]
fn local_seconds_into_day(now: i64) -> Option<i64> {
    let time = libc::time_t::try_from(now).ok()?;
    // SAFETY: `localtime_r` 는 `tm` 에만 쓰고 (스레드에 안전한 판) 시간대 정보를 읽을 뿐이다.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&time, &mut tm).is_null() {
            return None;
        }
        tm
    };
    Some(i64::from(tm.tm_hour) * 3600 + i64::from(tm.tm_min) * 60 + i64::from(tm.tm_sec))
}

#[cfg(not(any(windows, unix)))]
fn local_seconds_into_day(_now: i64) -> Option<i64> {
    None
}

/// "오늘" 의 시작 — `now` 가 든 날의 이 PC 시간대 자정 (유닉스 초). 시간대를 못 알아내면 UTC 자정으로 대신한다.
pub fn local_day_start(now: i64) -> i64 {
    match local_seconds_into_day(now) {
        Some(secs) if (0..86_400).contains(&secs) => now - secs,
        _ => now - now.rem_euclid(86_400),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::events::TokenUsage;
    use crate::db::migrations::{MIGRATIONS, apply};

    fn conn() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        apply(&mut conn, 0, MIGRATIONS).unwrap();
        for key in ["a", "b", "c"] {
            conn.execute(
                "INSERT INTO projects (path, path_key, name, created_at, last_opened_at) VALUES (?1, ?1, ?1, 1, 1)",
                [key],
            )
            .unwrap();
        }
        conn
    }

    fn turn(input: u64, output: u64, creation: u64, read: u64, cost: f64) -> TurnSummary {
        TurnSummary {
            outcome: TurnOutcome::Success,
            subtype: None,
            is_error: false,
            terminal_reason: None,
            result: None,
            errors: vec![],
            api_error_status: None,
            duration_ms: None,
            num_turns: None,
            usage: TokenUsage {
                input_tokens: input,
                output_tokens: output,
                cache_creation_input_tokens: creation,
                cache_read_input_tokens: read,
            },
            cost_usd: cost,
            total_cost_usd: cost,
        }
    }

    fn ctx(project_id: i64, run_id: i64, at: i64, source: Option<&str>) -> RecordCtx {
        RecordCtx {
            project_id,
            run_id,
            session_id: Some("s".into()),
            at,
            api_key_source: source.map(str::to_string),
        }
    }

    const SINCE: i64 = 10_000;

    #[test]
    fn the_sum_matches_the_turns_with_all_four_token_kinds() {
        let conn = conn();
        insert(
            &conn,
            &ctx(1, 1, SINCE + 1, Some("none")),
            &turn(1, 2, 3, 4, 0.25),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(1, 1, SINCE + 2, Some("none")),
            &turn(10, 20, 30, 40, 0.5),
        )
        .unwrap();
        let summary = summarize(&conn, SINCE, None).unwrap();
        let expected = UsageSum {
            turns: 2,
            input_tokens: 11,
            output_tokens: 22,
            cache_creation_input_tokens: 33,
            cache_read_input_tokens: 44,
            total_tokens: 110,
            cost_usd: 0.75,
            subscription_turns: 2,
            api_key_turns: 0,
            reference_only: true,
        };
        assert_eq!(summary.today, expected);
        assert_eq!(summary.projects.len(), 1);
        assert_eq!(summary.projects[0].project_id, 1);
        assert_eq!(summary.projects[0].today, expected);
        assert_eq!(summary.projects[0].total, expected);
        assert_eq!(summary.since, SINCE);
        assert_eq!(summary.session, None);
    }

    #[test]
    fn nothing_is_a_zero_sum_not_an_error() {
        let conn = conn();
        let summary = summarize(&conn, SINCE, None).unwrap();
        assert_eq!(summary.today, UsageSum::default());
        assert!(summary.projects.is_empty());
        assert!(
            !summary.today.reference_only,
            "턴이 없으면 표시할 것도 없다"
        );
    }

    #[test]
    fn the_day_boundary_includes_the_start_second_and_excludes_the_one_before() {
        let conn = conn();
        insert(&conn, &ctx(1, 1, SINCE - 1, None), &turn(100, 0, 0, 0, 1.0)).unwrap();
        insert(&conn, &ctx(1, 1, SINCE, None), &turn(1, 0, 0, 0, 0.1)).unwrap();
        insert(
            &conn,
            &ctx(1, 1, SINCE + 86_399, None),
            &turn(2, 0, 0, 0, 0.2),
        )
        .unwrap();
        let summary = summarize(&conn, SINCE, None).unwrap();
        assert_eq!(
            summary.today.input_tokens, 3,
            "어제 마지막 초는 오늘이 아니다"
        );
        assert_eq!(summary.today.turns, 2);
        // 프로젝트 합: 오늘은 오늘 것만, 전체는 모두
        assert_eq!(summary.projects[0].today.input_tokens, 3);
        assert_eq!(summary.projects[0].total.input_tokens, 103);
        assert_eq!(summary.projects[0].total.turns, 3);
    }

    #[test]
    fn sums_are_kept_per_project_and_a_project_without_today_still_has_its_total() {
        let conn = conn();
        insert(
            &conn,
            &ctx(1, 1, SINCE + 5, Some("none")),
            &turn(5, 0, 0, 0, 0.5),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(2, 2, SINCE + 6, Some("none")),
            &turn(7, 0, 0, 0, 0.7),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(3, 3, SINCE - 500, Some("none")),
            &turn(9, 0, 0, 0, 0.9),
        )
        .unwrap();
        let summary = summarize(&conn, SINCE, None).unwrap();
        assert_eq!(summary.today.input_tokens, 12);
        assert_eq!(summary.today.cost_usd, 1.2);
        let ids: Vec<i64> = summary.projects.iter().map(|p| p.project_id).collect();
        assert_eq!(ids, [1, 2, 3]);
        assert_eq!(summary.projects[2].today, UsageSum::default());
        assert_eq!(summary.projects[2].total.input_tokens, 9);
    }

    #[test]
    fn the_live_session_sums_only_its_own_run() {
        let conn = conn();
        // 같은 프로젝트의 앞 실행 · 이번 실행 · 다른 프로젝트의 실행
        insert(
            &conn,
            &ctx(1, 100, SINCE + 1, Some("none")),
            &turn(1000, 0, 0, 0, 1.0),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(1, 200, SINCE + 2, Some("none")),
            &turn(3, 0, 0, 0, 0.3),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(1, 200, SINCE + 3, Some("none")),
            &turn(4, 1, 0, 0, 0.4),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(2, 200, SINCE + 4, Some("none")),
            &turn(5000, 0, 0, 0, 5.0),
        )
        .unwrap();
        let live = LiveRun {
            project_id: 1,
            run_id: 200,
            session_id: Some("sess".into()),
        };
        let summary = summarize(&conn, SINCE, Some(&live)).unwrap();
        let session = summary.session.unwrap();
        assert_eq!(session.project_id, 1);
        assert_eq!(session.session_id.as_deref(), Some("sess"));
        assert_eq!(session.usage.turns, 2);
        assert_eq!(session.usage.input_tokens, 7);
        assert_eq!(session.usage.total_tokens, 8);
        assert_eq!(session.usage.cost_usd, 0.7);
        // 아직 턴이 없는 새 세션은 0
        let fresh = LiveRun {
            project_id: 1,
            run_id: 999,
            session_id: None,
        };
        let session = summarize(&conn, SINCE, Some(&fresh))
            .unwrap()
            .session
            .unwrap();
        assert_eq!(session.usage, UsageSum::default());
    }

    #[test]
    fn subscription_and_key_turns_are_counted_apart_and_decide_the_estimate_mark() {
        let conn = conn();
        insert(
            &conn,
            &ctx(1, 1, SINCE, Some("none")),
            &turn(1, 0, 0, 0, 0.1),
        )
        .unwrap();
        insert(
            &conn,
            &ctx(1, 1, SINCE, Some("ANTHROPIC_API_KEY")),
            &turn(1, 0, 0, 0, 0.1),
        )
        .unwrap();
        insert(&conn, &ctx(1, 1, SINCE, None), &turn(1, 0, 0, 0, 0.1)).unwrap();
        let sum = summarize(&conn, SINCE, None).unwrap().today;
        assert_eq!(
            (sum.turns, sum.subscription_turns, sum.api_key_turns),
            (3, 1, 1),
            "모르는 턴은 어느 쪽도 아니다"
        );
        assert!(sum.reference_only);
        // 키로만 쓴 프로젝트는 참고용이 아니다
        insert(
            &conn,
            &ctx(2, 2, SINCE, Some("ANTHROPIC_API_KEY")),
            &turn(1, 0, 0, 0, 0.1),
        )
        .unwrap();
        let summary = summarize(&conn, SINCE, None).unwrap();
        assert!(!summary.projects[1].today.reference_only);
        assert!(summary.projects[0].today.reference_only);
    }

    #[test]
    fn every_outcome_is_stored_and_a_bad_cost_is_stored_as_zero() {
        let conn = conn();
        for (n, outcome) in [
            TurnOutcome::Success,
            TurnOutcome::Interrupted,
            TurnOutcome::Error,
            TurnOutcome::Limit,
        ]
        .into_iter()
        .enumerate()
        {
            let mut summary = turn(1, 1, 0, 0, 0.1);
            summary.outcome = outcome;
            insert(&conn, &ctx(1, 1, SINCE + n as i64, None), &summary).unwrap();
        }
        insert(&conn, &ctx(1, 1, SINCE, None), &turn(0, 0, 0, 0, f64::NAN)).unwrap();
        insert(&conn, &ctx(1, 1, SINCE, None), &turn(0, 0, 0, 0, -3.0)).unwrap();
        let outcomes: Vec<String> = conn
            .prepare("SELECT outcome FROM usage_turns ORDER BY id LIMIT 4")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(outcomes, ["success", "interrupted", "error", "limit"]);
        let sum = summarize(&conn, SINCE, None).unwrap().today;
        assert_eq!(sum.turns, 6);
        assert_eq!(sum.cost_usd, 0.4);
    }

    #[test]
    fn a_turn_for_a_removed_project_is_refused_and_removing_a_project_drops_its_turns() {
        let conn = conn();
        assert!(insert(&conn, &ctx(9, 1, SINCE, None), &turn(1, 0, 0, 0, 0.1)).is_err());
        insert(&conn, &ctx(1, 1, SINCE, None), &turn(1, 0, 0, 0, 0.1)).unwrap();
        conn.execute("DELETE FROM projects WHERE id = 1", [])
            .unwrap();
        assert!(summarize(&conn, SINCE, None).unwrap().projects.is_empty());
    }

    #[test]
    fn huge_token_counts_do_not_overflow_the_sum() {
        let conn = conn();
        insert(
            &conn,
            &ctx(1, 1, SINCE, None),
            &turn(u64::MAX, 0, 0, 0, 0.0),
        )
        .unwrap();
        let sum = summarize(&conn, SINCE, None).unwrap().today;
        assert_eq!(sum.input_tokens, MAX_TOKENS, "상한으로 고정");
        insert(
            &conn,
            &ctx(1, 1, SINCE, None),
            &turn(u64::MAX, u64::MAX, 0, 0, 0.0),
        )
        .unwrap();
        assert_eq!(
            summarize(&conn, SINCE, None).unwrap().today.input_tokens,
            2 * MAX_TOKENS
        );
    }

    #[test]
    fn the_local_day_start_is_at_most_a_day_before_now_and_on_a_time_zone_boundary() {
        for now in [
            1_767_225_600_i64, // 2026-01-01T00:00:00Z
            1_768_478_400,     // 2026-01-15T12:00:00Z
            1_784_116_800,     // 2026-07-15T12:00:00Z
            now_secs(),
        ] {
            let start = local_day_start(now);
            assert!(start <= now, "{now}");
            assert!(now - start < 86_400, "{now}");
            // 시간대 차이는 15분의 배수라 자정도 그렇다
            assert_eq!(start.rem_euclid(900), 0, "{now}");
        }
        // 같은 날 안에서는 같은 자정
        let noon = 1_768_478_400;
        assert_eq!(local_day_start(noon), local_day_start(noon + 60));
    }
}
