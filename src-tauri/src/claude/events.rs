//! 세션 관리자가 화면으로 내보내는 이벤트와 명령 입출력 모양.
//!
//! 모양을 바꾸면 `src/lib/ipc.ts` 의 `ClaudeEvent` 도 같이 바꾼다. 필드 이름은 camelCase, 종류는 `type` (snake_case).
//! 카드가 쓰는 필드(`src/variants/fixtures-workspace.ts`): 권한 카드 = tool · command · path · cwd · alwaysRule(쓰일 규칙),
//! 질문 카드 = questions[]{question, header, multiSelect, options[]{label, description, preview}}.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// "이 프로젝트에서 항상 허용" 을 눌렀을 때 CLI 가 `.claude/settings.local.json` 에 쓰게 될 규칙 (D-23, D-44).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlwaysRule {
    /// 카드에 보일 규칙 글 (예: `Bash(mkdir probe-dir *)`, `Edit(/src/**)`)
    pub rule: String,
    pub scope: AlwaysScope,
    /// `folder` 범위일 때 프로젝트 기준 폴더 (예: `src/lib`)
    pub folder: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AlwaysScope {
    /// CLI 가 제안한 규칙 그대로 (Bash 는 그 명령 접두)
    Suggested,
    /// 그 파일이 든 폴더 아래 전부 (Write · Edit)
    Folder,
    /// 파일이 프로젝트 맨 위에 있다 — 그 파일 하나만 (`Edit(/파일이름)`). 프로젝트 전체를 여는 규칙은 없다 (D-45).
    File,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequestInfo {
    pub request_id: String,
    pub tool_use_id: Option<String>,
    pub tool: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    /// 실행할 명령 (Bash) 또는 주소 (WebFetch)
    pub command: Option<String>,
    /// 고칠 · 만들 파일 (Write · Edit …)
    pub path: Option<String>,
    /// 어디에서 (작업 폴더 = 프로젝트 폴더)
    pub cwd: String,
    /// 도구 입력 (자세히 보기용). **표시용 복사본** — 긴 글 · 긴 목록은 잘려 있다. 허용할 때 CLI 에 돌려주는 것은 앱이 쥔 원본이다.
    pub input: Value,
    /// 없으면 "항상 허용" 을 보이지 않는다 (예: 파일이 프로젝트 밖)
    pub always_rule: Option<AlwaysRule>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
    /// `initialize` 로 미리보기를 켰을 때만 온다 (지금은 켜지 않는다)
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionInfo {
    pub question: String,
    pub header: Option<String>,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRequestInfo {
    pub request_id: String,
    pub tool_use_id: Option<String>,
    pub questions: Vec<QuestionInfo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Success,
    /// 중단 (`interrupt`, 거부 + 중단)
    Interrupted,
    Error,
    /// 한도 (API 429 이거나 `rate_limit_event` 가 막힘)
    Limit,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
}

/// 턴 끝 (`result`). 사용량 · 비용은 이번 턴 몫이다 (D-24).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub outcome: TurnOutcome,
    pub subtype: Option<String>,
    pub is_error: bool,
    pub terminal_reason: Option<String>,
    /// 최종 글 (오류일 때는 오류 글)
    pub result: Option<String>,
    pub errors: Vec<String>,
    pub api_error_status: Option<i64>,
    pub duration_ms: Option<u64>,
    pub num_turns: Option<u64>,
    /// 이번 턴 토큰 (`usage` 는 CLI 가 턴별로 준다)
    pub usage: TokenUsage,
    /// 이번 턴 비용 = 이번 `total_cost_usd` − 앞 값 (CLI 는 프로세스 누적으로 준다)
    pub cost_usd: f64,
    /// 이 프로세스가 시작한 뒤 누적 (프로세스를 새로 띄우면 0 부터)
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndKind {
    /// 앱이 끝냈거나 CLI 가 종료 코드 0 으로 끝났다
    Normal,
    /// CLI 가 스스로 죽었다 (코드가 0 이 아님)
    Died,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawLogEntry {
    pub seq: u64,
    /// `send`(앱→CLI) · `recv`(CLI→앱, 알려진 종류 포함 전부) · `stderr` · `note`
    pub dir: &'static str,
    /// 한 줄 (너무 길면 앞부분만)
    pub text: String,
    pub truncated: bool,
    pub original_len: usize,
    pub at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    SessionStarted {
        project_dir: String,
        pid: u32,
        resumed: bool,
        resume_session_id: Option<String>,
        cli_version: Option<String>,
    },
    /// 막지 않고 알리기만 하는 것. `code`: `cli_version_mismatch` · `session_store_failed` · `write_failed` ·
    /// `control_error` · `unknown_control_request` · `question_unreadable` · `duplicate_request` · `line_too_long` · `api_key_in_use`
    Warning {
        code: String,
        detail: Option<String>,
    },
    /// 앱이 CLI 에 사용자 메시지를 보냈다 (`deferred`: "다르게 하라고 말하기" 가 중단된 턴이 끝난 뒤 보낸 것)
    UserMessage {
        text: String,
        deferred: bool,
    },
    /// `system/init` — 매 턴 첫 메시지를 처리할 때 온다
    TurnStarted {
        session_id: String,
        model: Option<String>,
        cli_version: Option<String>,
        permission_mode: Option<String>,
        /// `none` = 구독, `ANTHROPIC_API_KEY` = 키로 과금
        api_key_source: Option<String>,
    },
    Text {
        text: String,
    },
    ToolUse {
        tool_use_id: String,
        tool: String,
        summary: String,
    },
    ToolResult {
        tool_use_id: String,
        is_error: bool,
        summary: String,
    },
    PermissionRequest(PermissionRequestInfo),
    QuestionRequest(QuestionRequestInfo),
    /// 기다리던 요청이 취소됐다 (중단 등) — 카드를 닫는다. 뒤늦게 답할 필요 없다.
    RequestCancelled {
        request_id: String,
    },
    TurnEnded(TurnSummary),
    RateLimit {
        status: Option<String>,
        rate_limit_type: Option<String>,
        resets_at: Option<i64>,
        five_hour_utilization: Option<f64>,
        seven_day_utilization: Option<f64>,
    },
    /// `--resume` 한 세션이 CLI 에 없다 — 새 세션으로 시작할지 묻는다
    ResumeNotFound {
        session_id: String,
    },
    SessionEnded {
        ended: EndKind,
        exit_code: Option<i32>,
        /// 정해진 시간 안에 안 끝나 프로세스 트리를 강제로 껐다
        forced: bool,
        /// 턴이 도는 중에 끝났다 (결과 없이)
        mid_turn: bool,
        /// CLI 가 마지막으로 stderr 에 쓴 줄 몇 개 (진단용)
        stderr_tail: Vec<String>,
    },
    RawLog(RawLogEntry),
}

/// `claude_session_start` 가 돌려주는 것.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInfo {
    pub project_dir: String,
    pub pid: u32,
    pub resumed: bool,
    pub resume_session_id: Option<String>,
    pub cli_version: Option<String>,
}

/// `claude_session_start` 의 입력. 실행 파일 · 인자를 고르는 칸은 없다.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    pub project_dir: String,
    /// `--model` 값 (없으면 CLI 기본). 이름 모양만 허용한다.
    #[serde(default)]
    pub model: Option<String>,
    /// 이 프로젝트의 마지막 세션을 `--resume` 으로 잇는다
    #[serde(default)]
    pub resume: bool,
    /// `ANTHROPIC_API_KEY` 를 CLI 에 넘긴다 (기본 안 넘김 — D-19)
    #[serde(default)]
    pub use_api_key: bool,
}

/// 질문 하나의 답: 고른 라벨 하나 · 여러 개 · 직접 쓴 글.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum AnswerValue {
    One(String),
    Many(Vec<String>),
}

/// 요청 하나에 대한 사용자의 답.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    /// 이번만 허용
    Allow,
    /// 이 프로젝트에서 항상 허용 (규칙은 요청 이벤트의 `alwaysRule` — 화면이 정하지 않는다)
    AlwaysAllow,
    /// 거부 (이유 글은 선택)
    Deny {
        #[serde(default)]
        message: Option<String>,
    },
    /// 다르게 하라고 말하기 = 거부 + 이번 턴 중단, 그 말을 새 사용자 메시지로 (D-44)
    Tell { text: String },
    /// 질문 답 (질문 문장 → 답)
    Answer {
        answers: BTreeMap<String, AnswerValue>,
    },
}

/// `claude_session_state` — 화면을 다시 열었을 때 상태를 되살리는 용도.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub running: bool,
    pub project_dir: Option<String>,
    pub pid: Option<u32>,
    pub session_id: Option<String>,
    /// 턴이 도는 중
    pub busy: bool,
    /// 답을 기다리는 요청들 (`permission_request` · `question_request` 이벤트 모양 그대로)
    pub pending: Vec<SessionEvent>,
}

/// `claude_session_stop` 이 돌려주는 것.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopInfo {
    pub was_running: bool,
    pub forced: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_serialize_with_a_type_tag_and_camel_case_fields() {
        let event = SessionEvent::RequestCancelled {
            request_id: "r1".into(),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "type": "request_cancelled", "requestId": "r1" })
        );
        let event = SessionEvent::TurnStarted {
            session_id: "s".into(),
            model: None,
            cli_version: Some("2.1.296".into()),
            permission_mode: None,
            api_key_source: Some("none".into()),
        };
        let value = serde_json::to_value(event).unwrap();
        assert_eq!(value["type"], "turn_started");
        assert_eq!(value["sessionId"], "s");
        assert_eq!(value["cliVersion"], "2.1.296");
        assert_eq!(value["apiKeySource"], "none");
    }

    #[test]
    fn struct_variants_are_flattened_into_the_tagged_object() {
        let event = SessionEvent::QuestionRequest(QuestionRequestInfo {
            request_id: "r".into(),
            tool_use_id: None,
            questions: vec![],
        });
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            json!({ "type": "question_request", "requestId": "r", "toolUseId": null, "questions": [] })
        );
    }

    #[test]
    fn responses_deserialize_from_the_screen_shape() {
        let allow: Response = serde_json::from_value(json!({ "kind": "allow" })).unwrap();
        assert_eq!(allow, Response::Allow);
        let always: Response = serde_json::from_value(json!({ "kind": "always_allow" })).unwrap();
        assert_eq!(always, Response::AlwaysAllow);
        let deny: Response = serde_json::from_value(json!({ "kind": "deny" })).unwrap();
        assert_eq!(deny, Response::Deny { message: None });
        let tell: Response =
            serde_json::from_value(json!({ "kind": "tell", "text": "do it differently" })).unwrap();
        assert_eq!(
            tell,
            Response::Tell {
                text: "do it differently".into()
            }
        );
        let answer: Response = serde_json::from_value(json!({
            "kind": "answer",
            "answers": { "Q1": "Blue", "Q2": ["A", "B"] }
        }))
        .unwrap();
        let Response::Answer { answers } = answer else {
            panic!("expected an answer");
        };
        assert_eq!(answers["Q1"], AnswerValue::One("Blue".into()));
        assert_eq!(
            answers["Q2"],
            AnswerValue::Many(vec!["A".into(), "B".into()])
        );
    }

    #[test]
    fn unknown_response_kind_is_rejected() {
        assert!(serde_json::from_value::<Response>(json!({ "kind": "bypass" })).is_err());
    }

    #[test]
    fn start_request_refuses_unknown_fields_like_an_executable_path() {
        let result = serde_json::from_value::<StartRequest>(
            json!({ "projectDir": "C:\\p", "executable": "C:\\evil.exe" }),
        );
        assert!(result.is_err());
    }

    #[test]
    fn start_request_takes_only_the_known_fields_with_safe_defaults() {
        let request: StartRequest =
            serde_json::from_value(json!({ "projectDir": "C:\\p" })).unwrap();
        assert_eq!(
            request,
            StartRequest {
                project_dir: "C:\\p".into(),
                model: None,
                resume: false,
                use_api_key: false
            }
        );
    }
}
