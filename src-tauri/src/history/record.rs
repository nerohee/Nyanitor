//! 이벤트 → 저장할 한 줄. 어떤 이벤트를 저장하는지 정하고(`wants`), 긴 글을 자른다(`draft`). DB 를 모르는 순수 함수다.
//!
//! 저장하는 이벤트와 그 `kind` (이벤트의 `type` 과 같은 글):
//!
//! | 이벤트 | 저장 | 비고 |
//! |---|---|---|
//! | `session_started` · `session_ended` | 예 | 세션 시작 · 끝 (끝은 `stderrTail` 포함) |
//! | `user_message` · `text` | 예 | 사용자 메시지 · 오케스트레이터 글 (긴 글은 자름) |
//! | `tool_use` | 예 | 도구 사용 요약 (이미 짧은 요약) |
//! | `tool_result` | 오류만 | 성공한 결과는 저장하지 않는다 (원문 · 요약 모두) |
//! | `permission_request` · `question_request` | 예 | 카드 그대로 (도구 입력은 표시용 복사본, 너무 크면 뺀다) |
//! | `request_answered` · `request_cancelled` | 예 | 목록에는 따로 안 나오고 카드의 상태로 합쳐진다 (`chat::read_page`) |
//! | `turn_ended` | 예 | 결과 · 사용량 요약 (성공이면 최종 글은 뺀다 — 같은 글이 `text` 로 이미 있다). 토큰 · 비용은 `usage_turns` 에도 쌓는다 |
//! | `rate_limit` | `allowed` 가 아닐 때만 | 한도가 막혔거나 임박했을 때 (같은 값이 거듭 오면 보내는 쪽에서 한 번만) |
//! | `resume_not_found` | 예 | 이어 하기 못 찾음 |
//! | `turn_started` · `warning` · `raw_log` | 아니오 | 세션 ID 는 `sessions` 표로, 알림은 그때만, 원본은 메모리에만 |

use serde_json::Value;

use super::Limits;
use crate::claude::events::{SessionEvent, TurnOutcome};
use crate::claude::protocol::truncate_chars;

/// 저장할 한 줄
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Draft {
    /// 이벤트의 `type` (`user_message` …)
    pub kind: &'static str,
    /// 권한 · 질문 요청과 그 답 · 취소를 짝짓는 열쇠
    pub request_id: Option<String>,
    /// 이벤트의 JSON (긴 글만 잘림)
    pub body: String,
    /// 긴 글이 잘렸다
    pub truncated: bool,
}

/// 항목 하나의 JSON 상한 — 넘으면 모든 글을 500자로 더 줄이고, 그래도 넘으면 종류만 남긴다
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// 카드 · 도구 요약 같은 글자 하나의 상한
const CARD_TEXT_CHARS: usize = 4_000;
const QUESTION_TEXT_CHARS: usize = 2_000;
/// 실패한 턴의 오류 글 상한
const RESULT_CHARS: usize = 2_000;
/// 상한을 넘은 항목을 더 줄일 때의 글자 수
const SHRUNK_CHARS: usize = 500;

/// 이 이벤트를 저장하는가 (싸게 — 보내는 스레드가 이벤트마다 부른다). 위 표.
pub fn wants(event: &SessionEvent) -> bool {
    match event {
        SessionEvent::SessionStarted { .. }
        | SessionEvent::UserMessage { .. }
        | SessionEvent::Text { .. }
        | SessionEvent::ToolUse { .. }
        | SessionEvent::PermissionRequest(_)
        | SessionEvent::QuestionRequest(_)
        | SessionEvent::RequestAnswered { .. }
        | SessionEvent::RequestCancelled { .. }
        | SessionEvent::TurnEnded(_)
        | SessionEvent::ResumeNotFound { .. }
        | SessionEvent::SessionEnded { .. } => true,
        SessionEvent::ToolResult { is_error, .. } => *is_error,
        SessionEvent::RateLimit { status, .. } => {
            status.as_deref().is_some_and(|status| status != "allowed")
        }
        SessionEvent::Warning { .. }
        | SessionEvent::TurnStarted { .. }
        | SessionEvent::RawLog(_) => false,
    }
}

fn kind_of(event: &SessionEvent) -> &'static str {
    match event {
        SessionEvent::SessionStarted { .. } => "session_started",
        SessionEvent::Warning { .. } => "warning",
        SessionEvent::UserMessage { .. } => "user_message",
        SessionEvent::TurnStarted { .. } => "turn_started",
        SessionEvent::Text { .. } => "text",
        SessionEvent::ToolUse { .. } => "tool_use",
        SessionEvent::ToolResult { .. } => "tool_result",
        SessionEvent::PermissionRequest(_) => "permission_request",
        SessionEvent::QuestionRequest(_) => "question_request",
        SessionEvent::RequestAnswered { .. } => "request_answered",
        SessionEvent::RequestCancelled { .. } => "request_cancelled",
        SessionEvent::TurnEnded(_) => "turn_ended",
        SessionEvent::RateLimit { .. } => "rate_limit",
        SessionEvent::ResumeNotFound { .. } => "resume_not_found",
        SessionEvent::SessionEnded { .. } => "session_ended",
        SessionEvent::RawLog(_) => "raw_log",
    }
}

fn request_id_of(event: &SessionEvent) -> Option<String> {
    match event {
        SessionEvent::PermissionRequest(info) => Some(info.request_id.clone()),
        SessionEvent::QuestionRequest(info) => Some(info.request_id.clone()),
        SessionEvent::RequestAnswered { request_id, .. }
        | SessionEvent::RequestCancelled { request_id } => Some(request_id.clone()),
        _ => None,
    }
}

/// 객체의 글 칸 하나를 `max` 글자로 자른다. 잘렸으면 `true`.
fn cut_field(value: &mut Value, key: &str, max: usize) -> bool {
    let Some(Value::String(text)) = value.get_mut(key) else {
        return false;
    };
    if text.chars().nth(max).is_none() {
        return false;
    }
    *text = truncate_chars(text, max);
    true
}

/// 값 안의 모든 글을 `max` 글자로 자른다 (목록 · 객체 안까지). 하나라도 잘렸으면 `true`.
fn shrink_strings(value: &mut Value, max: usize) -> bool {
    match value {
        Value::String(text) => {
            if text.chars().nth(max).is_some() {
                *text = truncate_chars(text, max);
                true
            } else {
                false
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .fold(false, |cut, item| shrink_strings(item, max) | cut),
        Value::Object(map) => map
            .values_mut()
            .fold(false, |cut, item| shrink_strings(item, max) | cut),
        _ => false,
    }
}

/// 이벤트를 저장할 한 줄로 만든다. 저장하지 않는 이벤트면 `None`.
pub fn draft(event: &SessionEvent, limits: &Limits) -> Option<Draft> {
    if !wants(event) {
        return None;
    }
    let kind = kind_of(event);
    let mut value = serde_json::to_value(event).ok()?;
    let mut truncated = false;
    match event {
        SessionEvent::UserMessage { .. } | SessionEvent::Text { .. } => {
            truncated |= cut_field(&mut value, "text", limits.max_text_chars);
        }
        SessionEvent::ToolUse { .. } | SessionEvent::ToolResult { .. } => {
            truncated |= cut_field(&mut value, "summary", CARD_TEXT_CHARS);
        }
        SessionEvent::PermissionRequest(_) => {
            // 도구 입력(쓸 파일 내용 · 바꾸는 글)은 저장하지 않는다 — 비밀값이 들어 있을 수 있다 (2026-10-29 고객).
            // 다시 그릴 때는 명령 · 파일 경로 · 설명 · 항상 허용 규칙으로 충분하다.
            if let Some(object) = value.as_object_mut() {
                object.remove("input");
            }
            truncated |= shrink_strings(&mut value, CARD_TEXT_CHARS);
        }
        SessionEvent::QuestionRequest(_) => {
            truncated |= shrink_strings(&mut value, QUESTION_TEXT_CHARS);
        }
        SessionEvent::RequestAnswered { .. } => {
            truncated |= cut_field(&mut value, "text", limits.max_text_chars);
            if let Some(answers) = value.get_mut("answers") {
                truncated |= shrink_strings(answers, limits.max_text_chars);
            }
        }
        SessionEvent::TurnEnded(summary) => {
            if summary.outcome == TurnOutcome::Success {
                // 최종 글은 `text` 이벤트로 이미 저장했다 — 같은 글을 두 번 쌓지 않는다
                value["result"] = Value::Null;
            } else {
                truncated |= cut_field(&mut value, "result", RESULT_CHARS);
            }
        }
        _ => {}
    }
    let mut body = value.to_string();
    if body.len() > MAX_BODY_BYTES {
        shrink_strings(&mut value, SHRUNK_CHARS);
        truncated = true;
        body = value.to_string();
        if body.len() > MAX_BODY_BYTES {
            body = serde_json::json!({ "type": kind }).to_string();
        }
    }
    Some(Draft {
        kind,
        request_id: request_id_of(event),
        body,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::events::{
        AlwaysRule, AlwaysScope, AnswerKind, EndKind, PermissionRequestInfo, QuestionInfo,
        QuestionOption, QuestionRequestInfo, RawLogEntry, TokenUsage, TurnSummary,
    };
    use serde_json::json;
    use std::collections::BTreeMap;

    fn limits() -> Limits {
        Limits::default()
    }

    fn summary(outcome: TurnOutcome, result: Option<&str>) -> TurnSummary {
        TurnSummary {
            outcome,
            subtype: Some("success".into()),
            is_error: outcome != TurnOutcome::Success,
            terminal_reason: None,
            result: result.map(str::to_string),
            errors: vec![],
            api_error_status: None,
            duration_ms: Some(10),
            num_turns: Some(1),
            usage: TokenUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_creation_input_tokens: 3,
                cache_read_input_tokens: 4,
            },
            cost_usd: 0.5,
            total_cost_usd: 0.5,
        }
    }

    fn permission(input: Value) -> SessionEvent {
        SessionEvent::PermissionRequest(PermissionRequestInfo {
            request_id: "r1".into(),
            tool_use_id: Some("t1".into()),
            tool: "Bash".into(),
            display_name: None,
            description: None,
            command: Some("ls".into()),
            path: None,
            cwd: "C:\\p".into(),
            input,
            always_rule: Some(AlwaysRule {
                rule: "Bash(ls *)".into(),
                scope: AlwaysScope::Suggested,
                folder: None,
            }),
        })
    }

    fn parsed(draft: &Draft) -> Value {
        serde_json::from_str(&draft.body).unwrap()
    }

    #[test]
    fn only_the_events_the_screen_redraws_are_kept() {
        let kept = [
            SessionEvent::SessionStarted {
                project_id: 1,
                project_dir: "C:\\p".into(),
                pid: 1,
                resumed: false,
                resume_session_id: None,
                cli_version: None,
                model: None,
                effort: None,
            },
            SessionEvent::UserMessage {
                text: "hi".into(),
                deferred: false,
            },
            SessionEvent::Text {
                text: "hello".into(),
            },
            SessionEvent::ToolUse {
                tool_use_id: "t".into(),
                tool: "Bash".into(),
                summary: "ls".into(),
            },
            SessionEvent::ToolResult {
                tool_use_id: "t".into(),
                is_error: true,
                summary: "boom".into(),
            },
            permission(json!({})),
            SessionEvent::QuestionRequest(QuestionRequestInfo {
                request_id: "q".into(),
                tool_use_id: None,
                questions: vec![],
            }),
            SessionEvent::RequestAnswered {
                request_id: "r1".into(),
                kind: AnswerKind::Allow,
                text: None,
                answers: None,
            },
            SessionEvent::RequestCancelled {
                request_id: "r1".into(),
            },
            SessionEvent::TurnEnded(summary(TurnOutcome::Success, Some("done"))),
            SessionEvent::RateLimit {
                status: Some("rejected".into()),
                rate_limit_type: None,
                resets_at: None,
                five_hour_utilization: None,
                seven_day_utilization: None,
            },
            SessionEvent::RateLimit {
                status: Some("allowed_warning".into()),
                rate_limit_type: None,
                resets_at: None,
                five_hour_utilization: None,
                seven_day_utilization: None,
            },
            SessionEvent::ResumeNotFound {
                session_id: "s".into(),
            },
            SessionEvent::SessionEnded {
                ended: EndKind::Normal,
                exit_code: Some(0),
                forced: false,
                mid_turn: false,
                stderr_tail: vec![],
            },
        ];
        for event in &kept {
            let draft = draft(event, &limits()).unwrap_or_else(|| panic!("{event:?}"));
            // 종류 이름은 이벤트의 `type` 과 같다 — 기록을 읽는 화면이 그 이벤트로 그린다
            assert_eq!(parsed(&draft)["type"], draft.kind, "{event:?}");
        }
        let dropped = [
            SessionEvent::Warning {
                code: "x".into(),
                detail: None,
            },
            SessionEvent::TurnStarted {
                session_id: "s".into(),
                model: None,
                cli_version: None,
                permission_mode: None,
                api_key_source: None,
            },
            SessionEvent::ToolResult {
                tool_use_id: "t".into(),
                is_error: false,
                summary: "ok".into(),
            },
            SessionEvent::RateLimit {
                status: Some("allowed".into()),
                rate_limit_type: None,
                resets_at: None,
                five_hour_utilization: None,
                seven_day_utilization: None,
            },
            SessionEvent::RateLimit {
                status: None,
                rate_limit_type: None,
                resets_at: None,
                five_hour_utilization: None,
                seven_day_utilization: None,
            },
            SessionEvent::RawLog(RawLogEntry {
                seq: 1,
                dir: "recv",
                text: "{}".into(),
                truncated: false,
                original_len: 2,
                at_ms: 1,
            }),
        ];
        for event in &dropped {
            assert!(!wants(event), "{event:?}");
            assert_eq!(draft(event, &limits()), None, "{event:?}");
        }
    }

    #[test]
    fn requests_answers_and_cancels_carry_the_request_id() {
        let ids = [
            permission(json!({})),
            SessionEvent::RequestAnswered {
                request_id: "r1".into(),
                kind: AnswerKind::Deny,
                text: Some("no".into()),
                answers: None,
            },
            SessionEvent::RequestCancelled {
                request_id: "r1".into(),
            },
        ];
        for event in &ids {
            assert_eq!(
                draft(event, &limits()).unwrap().request_id.as_deref(),
                Some("r1")
            );
        }
        let text = SessionEvent::Text { text: "x".into() };
        assert_eq!(draft(&text, &limits()).unwrap().request_id, None);
    }

    #[test]
    fn long_text_is_cut_with_an_ellipsis_and_flagged() {
        let small = Limits {
            max_text_chars: 10,
            ..Limits::default()
        };
        let event = SessionEvent::UserMessage {
            text: "가".repeat(25),
            deferred: false,
        };
        let draft = draft(&event, &small).unwrap();
        assert!(draft.truncated);
        assert_eq!(parsed(&draft)["text"], format!("{}…", "가".repeat(10)));
        // 딱 맞으면 자르지 않는다
        let exact = SessionEvent::Text {
            text: "a".repeat(10),
        };
        let draft = super::draft(&exact, &small).unwrap();
        assert!(!draft.truncated);
        assert_eq!(parsed(&draft)["text"], "a".repeat(10));
        // 이모지 한가운데에서 자르지 않는다 (글자 단위)
        let emoji = SessionEvent::Text {
            text: "😀".repeat(12),
        };
        let draft = super::draft(&emoji, &small).unwrap();
        assert_eq!(parsed(&draft)["text"], format!("{}…", "😀".repeat(10)));
    }

    #[test]
    fn a_successful_turn_drops_the_final_text_but_a_failed_one_keeps_its_error() {
        let ok = draft(
            &SessionEvent::TurnEnded(summary(TurnOutcome::Success, Some("the answer"))),
            &limits(),
        )
        .unwrap();
        let value = parsed(&ok);
        assert_eq!(value["result"], Value::Null);
        assert!(!ok.truncated, "뺀 것은 잘린 것이 아니다");
        // 사용량 · 결과 종류는 남는다
        assert_eq!(value["outcome"], "success");
        assert_eq!(value["usage"]["outputTokens"], 2);
        assert_eq!(value["costUsd"], 0.5);

        let bad = draft(
            &SessionEvent::TurnEnded(summary(TurnOutcome::Error, Some(&"e".repeat(5_000)))),
            &limits(),
        )
        .unwrap();
        assert!(bad.truncated);
        let text = parsed(&bad)["result"].as_str().unwrap().to_string();
        assert_eq!(text.chars().count(), RESULT_CHARS + 1);
    }

    #[test]
    fn a_tool_input_is_never_stored_but_the_rest_of_the_card_stays() {
        for input in [
            json!({ "content": "SECRET=abc\n".repeat(5000) }),
            json!({ "command": "ls" }),
        ] {
            let draft = draft(&permission(input), &limits()).unwrap();
            assert!(!draft.truncated);
            let value = parsed(&draft);
            assert!(value.get("input").is_none());
            assert!(!draft.body.contains("SECRET"));
            assert_eq!(value["tool"], "Bash");
            assert_eq!(value["command"], "ls");
            assert_eq!(value["alwaysRule"]["rule"], "Bash(ls *)");
        }
    }

    #[test]
    fn a_long_command_in_a_card_is_cut() {
        let mut event = permission(json!({}));
        if let SessionEvent::PermissionRequest(info) = &mut event {
            info.command = Some("c".repeat(CARD_TEXT_CHARS + 50));
        }
        let draft = draft(&event, &limits()).unwrap();
        assert!(draft.truncated);
        assert_eq!(
            parsed(&draft)["command"].as_str().unwrap().chars().count(),
            CARD_TEXT_CHARS + 1
        );
    }

    #[test]
    fn question_cards_keep_every_option_with_cut_text() {
        let event = SessionEvent::QuestionRequest(QuestionRequestInfo {
            request_id: "q1".into(),
            tool_use_id: None,
            questions: vec![QuestionInfo {
                question: "Which?".into(),
                header: Some("h".into()),
                multi_select: false,
                options: vec![
                    QuestionOption {
                        label: "A".into(),
                        description: Some("d".repeat(QUESTION_TEXT_CHARS + 5)),
                        preview: None,
                    },
                    QuestionOption {
                        label: "B".into(),
                        description: None,
                        preview: None,
                    },
                ],
            }],
        });
        let draft = draft(&event, &limits()).unwrap();
        assert!(draft.truncated);
        let value = parsed(&draft);
        assert_eq!(
            value["questions"][0]["options"].as_array().unwrap().len(),
            2
        );
        assert_eq!(value["questions"][0]["question"], "Which?");
    }

    #[test]
    fn answers_keep_their_shape_and_a_long_written_answer_is_cut() {
        let mut answers = BTreeMap::new();
        answers.insert(
            "Q1".to_string(),
            crate::claude::events::AnswerValue::One("y".repeat(30)),
        );
        answers.insert(
            "Q2".to_string(),
            crate::claude::events::AnswerValue::Many(vec!["A".into(), "B".into()]),
        );
        let small = Limits {
            max_text_chars: 10,
            ..Limits::default()
        };
        let draft = draft(
            &SessionEvent::RequestAnswered {
                request_id: "q1".into(),
                kind: AnswerKind::Answer,
                text: None,
                answers: Some(answers),
            },
            &small,
        )
        .unwrap();
        assert!(draft.truncated);
        let value = parsed(&draft);
        assert_eq!(value["kind"], "answer");
        assert_eq!(value["answers"]["Q1"], format!("{}…", "y".repeat(10)));
        assert_eq!(value["answers"]["Q2"], json!(["A", "B"]));
    }

    #[test]
    fn an_item_over_the_body_cap_is_shrunk_and_finally_reduced_to_its_type() {
        // 글 칸마다는 상한 안이지만 모두 합치면 넘는다 → 모든 글을 500자로
        let long_options = SessionEvent::QuestionRequest(QuestionRequestInfo {
            request_id: "q0".into(),
            tool_use_id: None,
            questions: vec![QuestionInfo {
                question: "Which?".into(),
                header: None,
                multi_select: true,
                options: (0..40)
                    .map(|i| QuestionOption {
                        label: format!("{i}"),
                        description: Some("z".repeat(QUESTION_TEXT_CHARS - 100)),
                        preview: None,
                    })
                    .collect(),
            }],
        });
        let draft = draft(&long_options, &Limits::default()).unwrap();
        assert!(draft.truncated);
        assert!(draft.body.len() <= MAX_BODY_BYTES);
        let value = parsed(&draft);
        assert_eq!(
            value["questions"][0]["options"].as_array().unwrap().len(),
            40
        );
        assert_eq!(
            value["questions"][0]["options"][0]["description"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            SHRUNK_CHARS + 1
        );

        // 줄여도 넘는 것은 종류만 남는다
        let many_questions = SessionEvent::QuestionRequest(QuestionRequestInfo {
            request_id: "q".into(),
            tool_use_id: None,
            questions: (0..400)
                .map(|i| QuestionInfo {
                    question: format!("q{i}"),
                    header: None,
                    multi_select: false,
                    options: (0..10)
                        .map(|j| QuestionOption {
                            label: format!("option-{j}-{}", "l".repeat(150)),
                            description: None,
                            preview: None,
                        })
                        .collect(),
                })
                .collect(),
        });
        let draft = super::draft(&many_questions, &Limits::default()).unwrap();
        assert!(draft.truncated);
        assert!(draft.body.len() <= MAX_BODY_BYTES);
        assert_eq!(parsed(&draft), json!({ "type": "question_request" }));
        assert_eq!(
            draft.request_id.as_deref(),
            Some("q"),
            "카드의 열쇠는 남는다"
        );
    }
}
