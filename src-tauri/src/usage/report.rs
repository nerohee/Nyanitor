//! `usage_report` 읽기 — CLI 가 `/usage` 결과에 덧붙이는 구조화 결과 (실험 기능, D-24, 시험 근거 `tests/fixtures/cli/usage.jsonl`).
//!
//! 순수 함수만 있다. 이 파일 밖에는 `usage_report` 의 필드 이름을 두지 않는다.
//! 필드 뜻 (CLI 2.1.296 의 스키마 설명): `rate_limits.limits[]` 의 줄마다 `kind`(`session` · `weekly_all` · `weekly_scoped`),
//! `percent`(0~100, 100 을 넘을 수 있다), `resets_at`(ISO 8601), `severity`, `scope.model.display_name`.
//! 돌아가는 세션의 `rate_limit_event` 와 **같은 뜻 · 같은 단위**로 돌려준다: 사용률은 0~1 (`percent / 100`), 초기화 시각은 유닉스 초.
//!
//! 읽는 것만 읽는다 — 세션 합계 · 모델별 사용량 · 추가 사용 금액은 읽지 않는다 (계정 정보와 가깝다).
//! 모르는 `kind` · 모르는 필드는 건너뛰고, 줄 하나가 이상해도 그 줄만 건너뛴다.

use serde_json::Value;

use super::{ScopedWindow, UnavailableReason, UsageReading, UsageWindow};

/// 모델별 한도 줄의 최대 개수
const MAX_SCOPED: usize = 16;
/// 한도 줄을 훑는 최대 개수
const MAX_ROWS: usize = 64;
/// 사용률 상한 (`percent`) — 이보다 크면 이상한 값으로 보고 그 줄을 건너뛴다
const MAX_PERCENT: f64 = 1000.0;
const SHORT: usize = 64;

/// `usage_report` 값 하나에서 읽는다. `now` 는 읽은 때(유닉스 초).
///
/// 못 받는 경우의 이유:
/// - `rate_limits` 가 `null` — CLI 가 한도를 가져오지 못했다 (`failed`: 잠깐일 수 있다)
/// - 한도 줄이 없거나 읽을 수 있는 줄이 하나도 없다, 모양이 다르다 — `not_supported`
pub fn parse(report: &Value, now: i64) -> Result<UsageReading, UnavailableReason> {
    let rate_limits = match report.get("rate_limits") {
        Some(Value::Null) => return Err(UnavailableReason::Failed),
        Some(Value::Object(map)) => map,
        _ => return Err(UnavailableReason::NotSupported),
    };
    let rows = rate_limits
        .get("limits")
        .and_then(Value::as_array)
        .ok_or(UnavailableReason::NotSupported)?;

    let mut five_hour = None;
    let mut seven_day = None;
    let mut scoped = Vec::new();
    for row in rows.iter().take(MAX_ROWS) {
        let Some(kind) = row.get("kind").and_then(Value::as_str) else {
            continue;
        };
        let Some(utilization) = utilization_of(row) else {
            continue;
        };
        let resets_at = row
            .get("resets_at")
            .and_then(Value::as_str)
            .and_then(parse_iso8601);
        let severity = row
            .get("severity")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(SHORT).collect::<String>());
        match kind {
            "session" => {
                five_hour.get_or_insert(UsageWindow {
                    utilization,
                    resets_at,
                    severity,
                });
            }
            "weekly_all" => {
                seven_day.get_or_insert(UsageWindow {
                    utilization,
                    resets_at,
                    severity,
                });
            }
            "weekly_scoped" if scoped.len() < MAX_SCOPED => {
                if let Some(label) = scope_label(row) {
                    scoped.push(ScopedWindow {
                        label,
                        utilization,
                        resets_at,
                        severity,
                    });
                }
            }
            _ => {}
        }
    }
    if five_hour.is_none() && seven_day.is_none() && scoped.is_empty() {
        return Err(UnavailableReason::NotSupported);
    }
    let extra_usage_enabled = rate_limits
        .get("extra_usage")
        .and_then(|extra| extra.get("is_enabled"))
        .and_then(Value::as_bool);
    Ok(UsageReading {
        five_hour,
        seven_day,
        scoped,
        extra_usage_enabled,
        read_at: now,
    })
}

/// `percent`(0~100) → 사용률(0~1). 숫자가 아니거나 유한하지 않거나 음수이거나 너무 크면 `None`.
fn utilization_of(row: &Value) -> Option<f64> {
    let percent = row.get("percent").and_then(Value::as_f64)?;
    (percent.is_finite() && (0.0..=MAX_PERCENT).contains(&percent)).then(|| percent / 100.0)
}

/// 모델별 줄의 이름: 모델 이름, 없으면 표면(`surface`) 이름. 둘 다 없거나 비면 `None`.
fn scope_label(row: &Value) -> Option<String> {
    let scope = row.get("scope")?;
    ["model", "surface"].iter().find_map(|key| {
        let name = scope.get(key)?.get("display_name")?.as_str()?.trim();
        (!name.is_empty()).then(|| name.chars().take(SHORT).collect())
    })
}

/// 유닉스 초로 바꾼다: `YYYY-MM-DDTHH:MM:SS[.소수](Z|±HH:MM|±HHMM|±HH)`. 구분 `T` 는 소문자 · 공백도 받고, 시간대가 없으면 `None`.
pub fn parse_iso8601(text: &str) -> Option<i64> {
    if text.len() > 48 || !text.is_ascii() {
        return None;
    }
    let b = text.as_bytes();
    let digits = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        part.iter()
            .all(u8::is_ascii_digit)
            .then(|| part.iter().fold(0i64, |n, d| n * 10 + i64::from(d - b'0')))
    };
    let (year, month, day) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?);
    if b.get(4) != Some(&b'-') || b.get(7) != Some(&b'-') {
        return None;
    }
    if !matches!(b.get(10), Some(b'T' | b't' | b' ')) {
        return None;
    }
    let (hour, minute, second) = (digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if b.get(13) != Some(&b':') || b.get(16) != Some(&b':') {
        return None;
    }
    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) || year < 1970 {
        return None;
    }
    let mut at = 19;
    if b.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while b.get(at).is_some_and(u8::is_ascii_digit) {
            at += 1;
        }
        if at == start {
            return None;
        }
    }
    let offset = match b.get(at)? {
        b'Z' | b'z' => {
            at += 1;
            0
        }
        sign @ (b'+' | b'-') => {
            let hours = digits(at + 1, 2)?;
            at += 3;
            let minutes = if b.get(at) == Some(&b':') {
                let m = digits(at + 1, 2)?;
                at += 3;
                m
            } else if b.get(at).is_some_and(u8::is_ascii_digit) {
                let m = digits(at, 2)?;
                at += 2;
                m
            } else {
                0
            };
            if hours > 23 || minutes > 59 {
                return None;
            }
            let seconds = hours * 3600 + minutes * 60;
            if *sign == b'-' { -seconds } else { seconds }
        }
        _ => return None,
    };
    if at != b.len() {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        _ => 28,
    }
}

/// 1970-01-01 부터의 날수 (Howard Hinnant 의 `days_from_civil`)
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;

    /// 녹화본에서 `usage_report` 를 실은 줄의 값
    fn recorded_report() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cli/usage.jsonl");
        fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .find_map(|record| record.pointer("/msg/usage_report").cloned())
            .expect("the recording has a usage_report")
    }

    fn row(kind: &str, percent: Value, resets_at: Value) -> Value {
        json!({ "kind": kind, "group": "g", "percent": percent, "resets_at": resets_at,
                "scope": null, "severity": "normal", "is_active": false })
    }

    fn report(rows: Vec<Value>) -> Value {
        json!({ "session": { "total_cost_usd": 0 }, "rate_limits": { "limits": rows } })
    }

    #[test]
    fn the_recorded_report_gives_five_hour_and_seven_day_in_event_units() {
        let reading = parse(&recorded_report(), 1_000).unwrap();
        let five = reading.five_hour.unwrap();
        let seven = reading.seven_day.unwrap();
        // 녹화본은 사용률 숫자를 10 으로 가려 두었다 → 0.1 (`rate_limit_event` 의 `utilization` 과 같은 0~1)
        assert!((five.utilization - 0.1).abs() < 1e-9);
        assert!((seven.utilization - 0.1).abs() < 1e-9);
        // 2026-10-28T03:30:00Z · 2026-10-28T17:00:00Z (유닉스 초)
        assert_eq!(five.resets_at, Some(1_793_158_200));
        assert_eq!(seven.resets_at, Some(1_793_206_800));
        assert_eq!(five.severity.as_deref(), Some("normal"));
        assert_eq!(seven.severity.as_deref(), Some("warning"));
        assert!(reading.scoped.is_empty());
        assert_eq!(reading.extra_usage_enabled, Some(false));
        assert_eq!(reading.read_at, 1_000);
    }

    #[test]
    fn percent_becomes_a_fraction_and_can_pass_one() {
        let reading = parse(
            &report(vec![
                row("session", json!(19), json!("2026-10-28T03:30:00+00:00")),
                row("weekly_all", json!(125.5), json!(null)),
            ]),
            0,
        )
        .unwrap();
        assert!((reading.five_hour.unwrap().utilization - 0.19).abs() < 1e-9);
        let seven = reading.seven_day.unwrap();
        assert!((seven.utilization - 1.255).abs() < 1e-9);
        assert_eq!(seven.resets_at, None);
    }

    #[test]
    fn scoped_rows_keep_their_label_and_unknown_kinds_are_skipped() {
        let mut scoped = row("weekly_scoped", json!(40), json!("2026-10-30T00:00:00Z"));
        scoped["scope"] = json!({ "model": { "display_name": "Sonnet" }, "surface": null });
        let mut surface = row("weekly_scoped", json!(5), json!(null));
        surface["scope"] = json!({ "model": null, "surface": { "display_name": "Claude Code" } });
        let mut unlabeled = row("weekly_scoped", json!(5), json!(null));
        unlabeled["scope"] = json!({ "model": { "display_name": "  " } });
        let reading = parse(
            &report(vec![
                row("session", json!(1), json!(null)),
                scoped,
                surface,
                unlabeled,
                row("weekly_scoped", json!(5), json!(null)), // scope 없음
                row("some_future_meter", json!(99), json!(null)),
            ]),
            0,
        )
        .unwrap();
        let labels: Vec<_> = reading.scoped.iter().map(|w| w.label.as_str()).collect();
        assert_eq!(labels, ["Sonnet", "Claude Code"]);
        assert!((reading.scoped[0].utilization - 0.4).abs() < 1e-9);
        assert_eq!(reading.scoped[0].resets_at, Some(1_793_318_400));
    }

    #[test]
    fn the_first_row_of_a_kind_wins() {
        let reading = parse(
            &report(vec![
                row("session", json!(10), json!(null)),
                row("session", json!(90), json!(null)),
            ]),
            0,
        )
        .unwrap();
        assert!((reading.five_hour.unwrap().utilization - 0.1).abs() < 1e-9);
    }

    #[test]
    fn rows_with_odd_values_are_skipped_one_by_one() {
        let reading = parse(
            &report(vec![
                row("session", json!("lots"), json!(null)),
                row("session", json!(-5), json!(null)),
                row("session", json!(1e9), json!(null)),
                row("session", json!(null), json!(null)),
                json!({ "kind": "session" }),
                json!({ "percent": 5 }),
                json!(7),
                json!(null),
                row("weekly_all", json!(30), json!(123)),
            ]),
            0,
        )
        .unwrap();
        assert!(reading.five_hour.is_none());
        let seven = reading.seven_day.unwrap();
        assert!((seven.utilization - 0.3).abs() < 1e-9);
        assert_eq!(seven.resets_at, None, "숫자 resets_at 은 모양이 다르다");
    }

    #[test]
    fn a_bad_reset_time_keeps_the_row_without_a_time() {
        for bad in [
            json!("tomorrow"),
            json!("2026-13-01T00:00:00Z"),
            json!("2026-10-28T03:30:00"),
            json!(""),
        ] {
            let reading = parse(&report(vec![row("session", json!(50), bad)]), 0).unwrap();
            let five = reading.five_hour.unwrap();
            assert_eq!(five.resets_at, None);
            assert!((five.utilization - 0.5).abs() < 1e-9);
        }
    }

    #[test]
    fn unknown_fields_everywhere_are_ignored() {
        let mut value = report(vec![row("session", json!(50), json!(null))]);
        value["brand_new"] = json!({ "x": 1 });
        value["rate_limits"]["pace"] = json!("fast");
        value["rate_limits"]["limits"][0]["future"] = json!([1, 2]);
        assert!(parse(&value, 0).is_ok());
    }

    #[test]
    fn severity_is_cut_and_empty_is_none() {
        let mut long = row("session", json!(1), json!(null));
        long["severity"] = json!("s".repeat(500));
        let mut empty = row("weekly_all", json!(1), json!(null));
        empty["severity"] = json!("  ");
        let reading = parse(&report(vec![long, empty]), 0).unwrap();
        assert_eq!(
            reading.five_hour.unwrap().severity.unwrap().chars().count(),
            SHORT
        );
        assert_eq!(reading.seven_day.unwrap().severity, None);
    }

    #[test]
    fn too_many_scoped_rows_are_capped() {
        let rows: Vec<Value> = (0..40)
            .map(|i| {
                let mut r = row("weekly_scoped", json!(i), json!(null));
                r["scope"] = json!({ "model": { "display_name": format!("m{i}") } });
                r
            })
            .collect();
        let reading = parse(&report(rows), 0).unwrap();
        assert_eq!(reading.scoped.len(), MAX_SCOPED);
    }

    #[test]
    fn extra_usage_flag_is_read_only_when_it_is_a_bool() {
        let mut value = report(vec![row("session", json!(1), json!(null))]);
        value["rate_limits"]["extra_usage"] = json!({ "is_enabled": true, "used_credits": 123 });
        assert_eq!(parse(&value, 0).unwrap().extra_usage_enabled, Some(true));
        value["rate_limits"]["extra_usage"] = json!({ "is_enabled": "yes" });
        assert_eq!(parse(&value, 0).unwrap().extra_usage_enabled, None);
        value["rate_limits"]["extra_usage"] = json!(null);
        assert_eq!(parse(&value, 0).unwrap().extra_usage_enabled, None);
    }

    #[test]
    fn the_reading_never_carries_money_or_session_totals() {
        let mut value = report(vec![row("session", json!(1), json!(null))]);
        value["rate_limits"]["extra_usage"] =
            json!({ "is_enabled": true, "monthly_limit": 5000, "used_credits": 4321 });
        value["session"] = json!({ "total_cost_usd": 12.5, "model_usage": { "m": 1 } });
        let text = serde_json::to_string(&parse(&value, 0).unwrap()).unwrap();
        assert!(
            !text.contains("4321") && !text.contains("12.5") && !text.contains("5000"),
            "{text}"
        );
    }

    #[test]
    fn missing_or_null_pieces_map_to_a_reason() {
        // 한도를 못 가져옴 (null) → failed
        assert_eq!(
            parse(&json!({ "session": {}, "rate_limits": null }), 0),
            Err(UnavailableReason::Failed)
        );
        // 모양이 다르거나 비어 있음 → not_supported
        for value in [
            json!({}),
            json!(null),
            json!([]),
            json!({ "rate_limits": 5 }),
            json!({ "rate_limits": {} }),
            json!({ "rate_limits": { "limits": null } }),
            json!({ "rate_limits": { "limits": "x" } }),
            json!({ "rate_limits": { "limits": [] } }),
            json!({ "rate_limits": { "limits": [{ "kind": "future", "percent": 3 }] } }),
        ] {
            assert_eq!(
                parse(&value, 0),
                Err(UnavailableReason::NotSupported),
                "{value}"
            );
        }
    }

    #[test]
    fn iso_times_in_every_allowed_shape() {
        let utc = Some(1_793_158_200); // 2026-10-28T03:30:00Z
        for text in [
            "2026-10-28T03:30:00Z",
            "2026-10-28T03:30:00z",
            "2026-10-28t03:30:00Z",
            "2026-10-28 03:30:00Z",
            "2026-10-28T03:30:00.415777+00:00",
            "2026-10-28T03:30:00.5Z",
            "2026-10-28T12:30:00+09:00",
            "2026-10-28T12:30:00+0900",
            "2026-10-28T12:30:00+09",
            "2026-10-27T22:30:00-05:00",
        ] {
            assert_eq!(parse_iso8601(text), utc, "{text}");
        }
        assert_eq!(
            parse_iso8601("2026-10-28T03:30:00-05:30"),
            Some(1_793_158_200 + 19_800)
        );
    }

    #[test]
    fn iso_epoch_and_leap_days() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(parse_iso8601("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(parse_iso8601("2023-02-29T00:00:00Z"), None);
        assert_eq!(parse_iso8601("2100-02-29T00:00:00Z"), None);
        assert_eq!(parse_iso8601("2000-02-29T00:00:00Z"), Some(951_782_400));
        // 1970 이전은 받지 않는다
        assert_eq!(parse_iso8601("1969-12-31T23:59:59Z"), None);
    }

    #[test]
    fn iso_times_that_are_wrong_are_none() {
        for text in [
            "",
            "2026",
            "2026-10-28",
            "2026-10-28T03:30",
            "2026-10-28T03:30:00",
            "2026-10-28T03:30:00.Z",
            "2026-10-28T03:30:00+",
            "2026-10-28T03:30:00+9:00",
            "2026-10-28T03:30:00+24:00",
            "2026-10-28T03:30:00+09:60",
            "2026-10-28T03:30:00ZZ",
            "2026-10-28T03:30:00Z junk",
            "2026-10-28T24:00:00Z",
            "2026-10-28T03:60:00Z",
            "2026-10-28T03:30:61Z",
            "2026-00-28T03:30:00Z",
            "2026-10-00T03:30:00Z",
            "2026-10-32T03:30:00Z",
            "2026-04-31T00:00:00Z",
            "2026/10/28T03:30:00Z",
            "26-10-28T03:30:00Z",
            "２０２６-10-28T03:30:00Z",
            "2026-10-28T03:30:00Z\n",
        ] {
            assert_eq!(parse_iso8601(text), None, "{text:?}");
        }
        assert_eq!(parse_iso8601(&"2".repeat(500)), None);
    }

    #[test]
    fn the_print_json_output_has_no_usage_report_which_is_why_stream_json_is_used() {
        // `claude -p "/usage" --output-format json` 은 글(`result`)만 준다 — 한도 %는 글 속에 있어서 읽지 않는다 (시험 근거: P5-01 실험)
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/cli/usage.print-json.json");
        let text = fs::read_to_string(path).unwrap();
        assert!(!text.contains("usage_report"));
        assert!(text.contains("\"local_command\": \"usage\""));
    }
}
