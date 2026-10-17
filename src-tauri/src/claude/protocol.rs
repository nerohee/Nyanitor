//! Claude Code stream-json 주고받기의 **비공식 control protocol** 은 이 파일(과 `events.rs` 의 모양)에만 둔다 (D-18).
//!
//! 순수 함수만 있다 — 프로세스 · 스레드 · 파일을 모른다. 그래서 녹화본(`tests/fixtures/cli/*.jsonl`)을 그대로 먹여 시험한다.
//! 근거: `docs/02-development/notes/P3-01-cli-protocol.md` (확인된 CLI 버전 `KNOWN_CLI_VERSION`).
//!
//! - 받은 줄(`Value`) → [`Interpreter::handle`] → 화면 이벤트 · 새로 기다리는 요청 · 취소된 요청 · 되돌려 보낼 줄.
//! - 보낼 줄은 `*_line` 함수가 `serde_json` 으로 만든다. 항상 줄바꿈 없는 JSON 한 줄이다 (JSON 이 아닌 줄을 보내면 CLI 가 죽는다).

use std::path::Path;

use serde_json::{Map, Value, json};

use super::events::{
    AlwaysRule, AlwaysScope, PermissionRequestInfo, QuestionInfo, QuestionOption,
    QuestionRequestInfo, SessionEvent, TokenUsage, TurnOutcome, TurnSummary,
};

pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// 글 · 요약이 화면 이벤트에 실릴 때의 최대 글자 수.
const SUMMARY_CHARS: usize = 300;

/// 줄 하나를 JSON 객체로. JSON 이 아니거나 객체가 아니면 `None` (원본 로그에만 남는다).
/// 줄 맨 앞의 BOM(U+FEFF)은 무시한다 (`trim` 은 BOM 을 공백으로 보지 않는다).
pub fn parse_line(line: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(line.trim_start_matches('\u{feff}').trim()) {
        Ok(value @ Value::Object(_)) => Some(value),
        _ => None,
    }
}

// ───────────────────────── 기다리는 요청 ─────────────────────────

/// CLI 가 답을 기다리는 요청 하나 (`can_use_tool`).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingRequest {
    pub tool: String,
    pub kind: PendingKind,
    /// 화면에 보낸 요청 이벤트 (`claude_session_state` 가 다시 보여 줄 때 쓴다)
    pub event: SessionEvent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PendingKind {
    Permission {
        /// CLI 가 준 도구 입력 (허용할 때 `updatedInput` 으로 돌려준다)
        input: Value,
        /// "항상 허용" 때 실어 보낼 `updatedPermissions` 항목 하나. 화면이 아니라 여기서 정한다.
        always: Option<Value>,
    },
    Question {
        /// CLI 가 준 `questions` 배열 원본 (답과 함께 그대로 돌려준다)
        questions: Value,
        /// 질문 문장과 여러 개 고르기 여부 (답 검증용)
        shapes: Vec<QuestionShape>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuestionShape {
    pub question: String,
    pub multi_select: bool,
}

/// 줄 하나를 해석한 결과. 부르는 쪽은 `new_pending` · `cancelled` 를 먼저 반영한 뒤 `events` 를 순서대로 내보낸다
/// (화면이 이벤트를 받자마자 답해도 요청이 이미 등록돼 있게).
#[derive(Debug, Default, PartialEq)]
pub struct Interpretation {
    pub events: Vec<SessionEvent>,
    pub new_pending: Vec<(String, PendingRequest)>,
    pub cancelled: Vec<String>,
    /// `system/init` 의 세션 ID (이어 하기 저장용)
    pub session_id: Option<String>,
    pub turn_started: bool,
    pub turn_ended: bool,
    /// CLI 가 답을 기다리는데 앱이 모르는 요청이라 오류로 되돌려 줄 줄
    pub replies: Vec<String>,
    /// 결과에 "No conversation found" 가 있었다
    pub resume_not_found: bool,
}

/// 한 프로세스의 받는 쪽 상태. 프로세스마다 새로 만든다 (비용 기준이 0 부터 다시 시작하므로 — D-24).
#[derive(Debug)]
pub struct Interpreter {
    project_dir: String,
    baseline_cost: f64,
    last_rate_status: Option<String>,
}

impl Interpreter {
    pub fn new(project_dir: &Path) -> Self {
        Self {
            project_dir: project_dir.display().to_string(),
            baseline_cost: 0.0,
            last_rate_status: None,
        }
    }

    pub fn handle(&mut self, msg: &Value) -> Interpretation {
        let mut out = Interpretation::default();
        match str_at(msg, "type") {
            Some("system") => self.on_system(msg, &mut out),
            Some("assistant") => on_assistant(msg, &mut out),
            Some("user") => on_user(msg, &mut out),
            Some("control_request") => self.on_control_request(msg, &mut out),
            Some("control_cancel_request") => {
                if let Some(id) = str_at(msg, "request_id") {
                    out.cancelled.push(id.to_string());
                    out.events.push(SessionEvent::RequestCancelled {
                        request_id: id.to_string(),
                    });
                }
            }
            Some("control_response") => on_control_response(msg, &mut out),
            Some("result") => self.on_result(msg, &mut out),
            Some("rate_limit_event") => self.on_rate_limit(msg, &mut out),
            // 모르는 종류는 무시한다 (D-18). 원본 로그에는 부르는 쪽이 남긴다.
            _ => {}
        }
        out
    }

    fn on_system(&mut self, msg: &Value, out: &mut Interpretation) {
        // `thinking_tokens` · `task_started` · `permission_denied` 등은 화면에 쓸 일이 없다.
        if str_at(msg, "subtype") != Some("init") {
            return;
        }
        let Some(session_id) = str_at(msg, "session_id") else {
            return;
        };
        // 새 턴 — 앞 턴의 한도 상태가 이 턴의 오류에 번지지 않게 한다.
        self.last_rate_status = None;
        out.session_id = Some(session_id.to_string());
        out.turn_started = true;
        out.events.push(SessionEvent::TurnStarted {
            session_id: session_id.to_string(),
            model: str_at(msg, "model").map(str::to_string),
            cli_version: str_at(msg, "claude_code_version").map(str::to_string),
            permission_mode: str_at(msg, "permissionMode").map(str::to_string),
            api_key_source: str_at(msg, "apiKeySource").map(str::to_string),
        });
    }

    fn on_control_request(&self, msg: &Value, out: &mut Interpretation) {
        let Some(request_id) = str_at(msg, "request_id") else {
            return;
        };
        let Some(request) = msg.get("request") else {
            return;
        };
        match str_at(request, "subtype") {
            Some("can_use_tool") => self.on_can_use_tool(request_id, request, out),
            other => {
                // CLI 는 control 요청에는 답을 기다린다. 모르는 종류는 오류로 되돌려 멈추지 않게 한다.
                let subtype = other.unwrap_or("(none)");
                out.replies.push(error_response_line(
                    request_id,
                    &format!("Unsupported control request subtype: {subtype}"),
                ));
                out.events.push(SessionEvent::Warning {
                    code: "unknown_control_request".into(),
                    detail: Some(truncate_chars(subtype, 80)),
                });
            }
        }
    }

    fn on_can_use_tool(&self, request_id: &str, request: &Value, out: &mut Interpretation) {
        let tool = str_at(request, "tool_name").unwrap_or("").to_string();
        let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
        let tool_use_id = str_at(request, "tool_use_id").map(str::to_string);

        if tool == ASK_USER_QUESTION {
            let Some((questions, shapes, infos)) = parse_questions(&input) else {
                out.replies.push(deny_response_line(
                    request_id,
                    "The app could not read this question.",
                    false,
                ));
                out.events.push(SessionEvent::Warning {
                    code: "question_unreadable".into(),
                    detail: None,
                });
                return;
            };
            let event = SessionEvent::QuestionRequest(QuestionRequestInfo {
                request_id: request_id.to_string(),
                tool_use_id,
                questions: infos,
            });
            out.new_pending.push((
                request_id.to_string(),
                PendingRequest {
                    tool,
                    kind: PendingKind::Question { questions, shapes },
                    event: event.clone(),
                },
            ));
            out.events.push(event);
            return;
        }

        let suggestions = request
            .get("permission_suggestions")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let always = always_rule(&self.project_dir, &tool, &input, suggestions)
            // 파일 하나 규칙은 이름이 폴더면 그 폴더 아래 전부를 여는 규칙이 된다 — 있는 폴더를 가리키면 만들지 않는다.
            .filter(|(info, _)| {
                info.scope != AlwaysScope::File || !target_path(&input).is_some_and(names_a_folder)
            });
        let info = PermissionRequestInfo {
            request_id: request_id.to_string(),
            tool_use_id,
            display_name: str_at(request, "display_name").map(str::to_string),
            description: str_at(request, "description").map(|d| truncate_chars(d, 1000)),
            // 카드에 보이는 글도 같은 한계로 자른다 (원본은 `PendingKind::Permission` 이 쥔다). 잘렸으면 끝에 `…` 가 붙는다.
            command: match tool.as_str() {
                "WebFetch" => str_at(&input, "url"),
                _ => str_at(&input, "command"),
            }
            .map(|text| truncate_chars(text, INPUT_STRING_CHARS)),
            path: target_path(&input).map(|text| truncate_chars(text, INPUT_STRING_CHARS)),
            cwd: self.project_dir.clone(),
            input: display_input(&input),
            always_rule: always.as_ref().map(|(info, _)| info.clone()),
            tool: tool.clone(),
        };
        let event = SessionEvent::PermissionRequest(info);
        out.new_pending.push((
            request_id.to_string(),
            PendingRequest {
                tool,
                kind: PendingKind::Permission {
                    input,
                    always: always.map(|(_, value)| value),
                },
                event: event.clone(),
            },
        ));
        out.events.push(event);
    }

    fn on_result(&mut self, msg: &Value, out: &mut Interpretation) {
        out.turn_ended = true;
        let is_error = msg
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let terminal_reason = str_at(msg, "terminal_reason").map(str::to_string);
        let api_error_status = msg.get("api_error_status").and_then(Value::as_i64);
        let errors: Vec<String> = msg
            .get("errors")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(|e| truncate_chars(e, 500))
                    .collect()
            })
            .unwrap_or_default();

        // 한도 상태는 이 턴 몫이다 — 읽고 나면 지운다 (다음 턴의 무관한 오류가 한도로 보이지 않게).
        let rate_status = self.last_rate_status.take();
        let outcome = if !is_error {
            TurnOutcome::Success
        } else if terminal_reason
            .as_deref()
            .is_some_and(|reason| reason.starts_with("aborted"))
        {
            TurnOutcome::Interrupted
        } else if api_error_status == Some(429)
            || rate_status
                .as_deref()
                .is_some_and(|status| status.starts_with("rejected"))
        {
            TurnOutcome::Limit
        } else {
            TurnOutcome::Error
        };

        // 비용: CLI 의 `total_cost_usd` 는 그 프로세스가 사는 동안 누적이다. 이번 턴 몫 = 이번 값 − 앞 값.
        let total = msg
            .get("total_cost_usd")
            .and_then(Value::as_f64)
            .unwrap_or(self.baseline_cost);
        let cost = round9((total - self.baseline_cost).max(0.0));
        self.baseline_cost = total;

        if errors.iter().any(|e| e.contains("No conversation found")) {
            out.resume_not_found = true;
        }

        let usage = msg.get("usage");
        let count = |key: &str| {
            usage
                .and_then(|u| u.get(key))
                .and_then(Value::as_u64)
                .unwrap_or(0)
        };
        out.events.push(SessionEvent::TurnEnded(TurnSummary {
            outcome,
            subtype: str_at(msg, "subtype").map(str::to_string),
            is_error,
            terminal_reason,
            result: str_at(msg, "result").map(str::to_string),
            errors,
            api_error_status,
            duration_ms: msg.get("duration_ms").and_then(Value::as_u64),
            num_turns: msg.get("num_turns").and_then(Value::as_u64),
            usage: TokenUsage {
                input_tokens: count("input_tokens"),
                output_tokens: count("output_tokens"),
                cache_creation_input_tokens: count("cache_creation_input_tokens"),
                cache_read_input_tokens: count("cache_read_input_tokens"),
            },
            cost_usd: cost,
            total_cost_usd: round9(total),
        }));
    }

    fn on_rate_limit(&mut self, msg: &Value, out: &mut Interpretation) {
        let Some(info) = msg.get("rate_limit_info") else {
            return;
        };
        let status = str_at(info, "status").map(str::to_string);
        self.last_rate_status.clone_from(&status);
        let window = |name: &str| {
            info.get("unifiedWindows")
                .and_then(|w| w.get(name))
                .and_then(|w| w.get("utilization"))
                .and_then(Value::as_f64)
        };
        out.events.push(SessionEvent::RateLimit {
            status,
            rate_limit_type: str_at(info, "rateLimitType").map(str::to_string),
            resets_at: info.get("resetsAt").and_then(Value::as_i64),
            five_hour_utilization: window("five_hour"),
            seven_day_utilization: window("seven_day"),
        });
    }
}

fn on_assistant(msg: &Value, out: &mut Interpretation) {
    let Some(blocks) = msg
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in blocks {
        match str_at(block, "type") {
            Some("text") => {
                if let Some(text) = str_at(block, "text").filter(|t| !t.is_empty()) {
                    out.events.push(SessionEvent::Text {
                        text: text.to_string(),
                    });
                }
            }
            Some("tool_use") => {
                let (Some(id), Some(name)) = (str_at(block, "id"), str_at(block, "name")) else {
                    continue;
                };
                out.events.push(SessionEvent::ToolUse {
                    tool_use_id: id.to_string(),
                    tool: name.to_string(),
                    summary: summarize_tool_input(name, block.get("input")),
                });
            }
            // `thinking` 은 내용이 비어 서명만 온다 — 보이지 않는다.
            _ => {}
        }
    }
}

fn on_user(msg: &Value, out: &mut Interpretation) {
    let Some(blocks) = msg
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in blocks {
        if str_at(block, "type") != Some("tool_result") {
            continue;
        }
        let Some(id) = str_at(block, "tool_use_id") else {
            continue;
        };
        out.events.push(SessionEvent::ToolResult {
            tool_use_id: id.to_string(),
            is_error: block
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            summary: truncate_chars(&tool_result_text(block.get("content")), SUMMARY_CHARS),
        });
    }
}

fn on_control_response(msg: &Value, out: &mut Interpretation) {
    let Some(response) = msg.get("response") else {
        return;
    };
    if str_at(response, "subtype") == Some("error") {
        let detail = str_at(response, "error").map(|e| truncate_chars(e, 300));
        out.events.push(SessionEvent::Warning {
            code: "control_error".into(),
            detail,
        });
    }
}

fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| str_at(b, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// 도구 호출을 한 줄로 (카드 · 로그용).
pub fn summarize_tool_input(tool: &str, input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    let keys: &[&str] = match tool {
        "Bash" | "PowerShell" => &["command"],
        "Write" | "Edit" | "MultiEdit" | "Read" => &["file_path"],
        "NotebookEdit" => &["notebook_path"],
        "Glob" | "Grep" => &["pattern"],
        "WebFetch" => &["url"],
        "WebSearch" => &["query"],
        _ => &["description", "command", "file_path", "prompt"],
    };
    keys.iter()
        .find_map(|key| str_at(input, key))
        .map(|text| truncate_chars(text, SUMMARY_CHARS))
        .unwrap_or_default()
}

/// 글자(바이트가 아니라) 수로 자른다. 잘렸으면 끝에 `…`.
pub fn truncate_chars(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn round9(x: f64) -> f64 {
    (x * 1e9).round() / 1e9
}

// ───────────────────────── 질문 ─────────────────────────

type ParsedQuestions = (Value, Vec<QuestionShape>, Vec<QuestionInfo>);

/// `AskUserQuestion` 의 `input.questions` (1~4개)를 읽는다. 모양이 어긋나면 `None`.
fn parse_questions(input: &Value) -> Option<ParsedQuestions> {
    let raw = input.get("questions")?;
    let list = raw.as_array()?;
    if list.is_empty() {
        return None;
    }
    let mut shapes = Vec::new();
    let mut infos = Vec::new();
    for item in list {
        let question = str_at(item, "question")?.to_string();
        let multi_select = item
            .get("multiSelect")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = item
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|o| {
                        Some(QuestionOption {
                            label: str_at(o, "label")?.to_string(),
                            description: str_at(o, "description").map(str::to_string),
                            preview: str_at(o, "preview").map(str::to_string),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        shapes.push(QuestionShape {
            question: question.clone(),
            multi_select,
        });
        infos.push(QuestionInfo {
            question,
            header: str_at(item, "header").map(str::to_string),
            multi_select,
            options,
        });
    }
    Some((raw.clone(), shapes, infos))
}

// ───────────────────────── 도구 입력 (표시용) ─────────────────────────

/// 이벤트에 싣는 도구 입력의 한계 — 긴 값은 잘라 표시용으로만 쓴다 (허용할 때 CLI 에 돌려주는 것은 잘리지 않은 원본이다).
const INPUT_STRING_CHARS: usize = 10_000;
const INPUT_ARRAY_ITEMS: usize = 50;
const INPUT_TOTAL_BYTES: usize = 64 << 10;

/// 카드에 보일 도구 입력: 긴 글 · 긴 목록을 잘라 낸 복사본. 그래도 너무 크면 앞부분만 글로 남긴다.
pub fn display_input(input: &Value) -> Value {
    let trimmed = trim_value(input);
    let text = trimmed.to_string();
    if text.len() > INPUT_TOTAL_BYTES {
        return Value::String(truncate_chars(&text, INPUT_STRING_CHARS));
    }
    trimmed
}

fn trim_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(truncate_chars(text, INPUT_STRING_CHARS)),
        Value::Array(items) => {
            let mut kept: Vec<Value> = items
                .iter()
                .take(INPUT_ARRAY_ITEMS)
                .map(trim_value)
                .collect();
            if items.len() > INPUT_ARRAY_ITEMS {
                kept.push(Value::String("…".into()));
            }
            Value::Array(kept)
        }
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), trim_value(item)))
                .collect(),
        ),
        other => other.clone(),
    }
}

// ───────────────────────── "이 프로젝트에서 항상 허용" 규칙 ─────────────────────────

/// 파일을 고치는 도구들. CLI 의 권한 규칙에서는 모두 `Edit(...)` 한 이름으로 묶인다
/// (`Write` 이름으로 쓴 경로 규칙은 먹지 않고 `Edit` 은 Write · Edit 둘 다에 먹는다 — P3-02 실험 `permission-scope`).
const FILE_EDIT_TOOLS: &[&str] = &["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// "항상 허용" 규칙을 만들지 않는 폴더 · 파일 이름 — 모델이 이것을 고치면 권한 설정 · 훅이 바뀌어
/// 묻지 않고 명령이 돌 수 있다 (D-45). 경로 어느 칸에 있어도 (폴더이든 파일이든) 규칙을 만들지 않는다.
/// 대소문자를 가리지 않고 끝의 점 · 공백은 무시한다 (Windows 는 `.Claude.` 도 `.claude` 로 본다).
/// 설정 · 훅 자리를 더 알게 되면 여기에만 더한다.
const PROTECTED_NAMES: &[&str] = &[
    ".claude",
    ".git",
    ".githooks",
    ".husky",
    ".vscode",
    ".idea",
    ".github",
    ".gitlab",
    ".circleci",
    ".devcontainer",
    ".cargo",
    ".mcp.json",
    ".envrc",
];

fn is_protected_name(name: &str) -> bool {
    let plain = name.trim_end_matches(['.', ' ']).to_ascii_lowercase();
    PROTECTED_NAMES.contains(&plain.as_str())
}

/// 파일을 고치는 도구가 가리킨 파일 경로 (`file_path`, 노트북은 `notebook_path`).
fn target_path(input: &Value) -> Option<&str> {
    str_at(input, "file_path").or_else(|| str_at(input, "notebook_path"))
}

/// 권한 요청 하나에 "항상 허용" 으로 실어 보낼 규칙. 규칙을 정하는 것은 이 함수뿐이고 화면은 고르지 못한다.
/// - CLI 가 `addRules` · `localSettings` · `allow` 로 제안한 것이 있고 요청한 도구의 것이며 내용이 좁으면 그것 (알려진 필드만 다시 만든다).
/// - 없고 파일을 고치는 도구이며 파일이 프로젝트 안이면 `Edit(/폴더/**)` (그 파일이 든 폴더) 또는
///   프로젝트 맨 위 파일이면 `Edit(/파일이름)` (그 파일 하나). `Edit(/*)` 같은 프로젝트 전체 규칙은 만들지 않는다 (D-45).
/// - 그 밖에는 `None` — 버튼을 보이지 않는다.
pub fn always_rule(
    project_dir: &str,
    tool: &str,
    input: &Value,
    suggestions: &[Value],
) -> Option<(AlwaysRule, Value)> {
    if let Some(found) = suggested_rule(tool, suggestions) {
        return Some(found);
    }
    if !FILE_EDIT_TOOLS.contains(&tool) {
        return None;
    }
    let (content, scope, folder) = folder_rule(project_dir, target_path(input)?)?;
    let value = json!({
        "type": "addRules",
        "rules": [{ "toolName": "Edit", "ruleContent": content }],
        "behavior": "allow",
        "destination": "localSettings",
    });
    Some((
        AlwaysRule {
            rule: format!("Edit({content})"),
            scope,
            folder,
        },
        value,
    ))
}

/// 제안한 규칙의 도구가 요청한 도구와 같은 도구인가 (파일을 고치는 도구끼리는 한 묶음).
fn same_tool(requested: &str, rule_tool: &str) -> bool {
    requested == rule_tool
        || (FILE_EDIT_TOOLS.contains(&requested) && FILE_EDIT_TOOLS.contains(&rule_tool))
}

/// 내용이 비었거나 `*` · `/` 뿐이면 그 도구의 거의 모든 호출을 허용하게 된다.
fn is_broad_content(content: &str) -> bool {
    let content = content.trim();
    content.chars().all(|c| c == '*' || c == '/') || content == ":*"
}

fn suggested_rule(tool: &str, suggestions: &[Value]) -> Option<(AlwaysRule, Value)> {
    suggestions.iter().find_map(|suggestion| {
        if str_at(suggestion, "type") != Some("addRules")
            || str_at(suggestion, "destination") != Some("localSettings")
            || str_at(suggestion, "behavior") != Some("allow")
        {
            return None;
        }
        let rules = suggestion.get("rules")?.as_array()?;
        if rules.is_empty() {
            return None;
        }
        let mut shown = Vec::new();
        let mut rebuilt = Vec::new();
        for rule in rules {
            let rule_tool = str_at(rule, "toolName")?;
            if !same_tool(tool, rule_tool) {
                return None;
            }
            let content = str_at(rule, "ruleContent");
            match content {
                Some(content) if !is_broad_content(content) => {
                    shown.push(format!("{rule_tool}({content})"));
                    rebuilt.push(json!({ "toolName": rule_tool, "ruleContent": content }));
                }
                // 내용이 있는데 넓다 → 안 씀. 내용이 없는 규칙은 MCP 도구 하나를 이름으로 허용하는 경우만 쓴다.
                Some(_) => return None,
                None if rule_tool.starts_with("mcp__") && rule_tool == tool => {
                    shown.push(rule_tool.to_string());
                    rebuilt.push(json!({ "toolName": rule_tool }));
                }
                None => return None,
            }
        }
        Some((
            AlwaysRule {
                rule: shown.join(", "),
                scope: AlwaysScope::Suggested,
                folder: None,
            },
            // CLI 가 준 것 중 알려진 필드만 다시 만든다 (다른 필드는 싣지 않는다).
            json!({
                "type": "addRules",
                "rules": rebuilt,
                "behavior": "allow",
                "destination": "localSettings",
            }),
        ))
    })
}

/// 경로를 `/` 로 나눈 칸들로. 절대 경로가 아니거나 `..` 로 맨 위를 넘으면 `None`.
fn path_parts(path: &str) -> Option<Vec<String>> {
    let mut text = path.replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string(); // Windows `\\?\C:\…`
    }
    let drive = text.as_bytes().get(1) == Some(&b':') && text.as_bytes()[0].is_ascii_alphabetic();
    if !text.starts_with('/') && !drive {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other.to_string()),
        }
    }
    Some(parts)
}

fn same_part(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// 경로 글이 폴더 모양으로 끝나는가 (`\`, `/`, `\.`, `\..`). 파일이 아니므로 "그 파일 하나" 규칙을 만들 수 없다 —
/// 이름만 있는 규칙은 폴더를 가리키면 그 아래 전부가 된다.
fn ends_like_a_folder(path: &str) -> bool {
    let last = path.rsplit(['/', '\\']).next().unwrap_or("");
    last.is_empty() || last == "." || last == ".."
}

/// 있는 폴더를 가리키는가 (디스크를 본다 — 규칙을 만들 때 한 번).
fn names_a_folder(path: &str) -> bool {
    Path::new(path).is_dir()
}

/// 규칙 글자 안에 그대로 넣으면 뜻이 달라지거나, 다른 이름으로 읽힐 수 있는 이름인가.
/// gitignore 식 규칙 글자 · 괄호 · 제어 문자 · 끝의 점 · 공백, Windows 의 `:`(대체 스트림)과 8.3 짧은 이름(`CLAUDE~1`).
fn risky(name: &str) -> bool {
    name.contains(['*', '?', '[', ']', '{', '}', '!', '\\', '(', ')', ':'])
        || name.chars().any(char::is_control)
        || name.ends_with([' ', '.'])
        || name
            .as_bytes()
            .windows(2)
            .any(|pair| pair[0] == b'~' && pair[1].is_ascii_digit())
}

/// 프로젝트 안 파일에 대한 규칙 내용. 프로젝트 맨 위 파일은 그 파일 하나(`/이름`), 아니면 그 파일이 든 폴더(`/폴더/**`).
/// 프로젝트 밖 · 폴더 모양 경로 · 규칙 글자가 든 이름 · 설정 · 훅 폴더 아래이면 `None`.
fn folder_rule(project_dir: &str, file: &str) -> Option<(String, AlwaysScope, Option<String>)> {
    if ends_like_a_folder(file) {
        return None;
    }
    let project = path_parts(project_dir)?;
    let file = path_parts(file)?;
    if file.len() <= project.len() || !project.iter().zip(&file).all(|(p, f)| same_part(p, f)) {
        return None;
    }
    let inside = &file[project.len()..];
    if inside.iter().any(|part| is_protected_name(part)) {
        return None;
    }
    let (name, folders) = inside.split_last()?;
    if folders.iter().any(|folder| risky(folder)) {
        return None;
    }
    if folders.is_empty() {
        // 프로젝트 맨 위 파일 — 그 파일 하나만. 이름이 규칙에 들어가므로 이름도 확인한다.
        if risky(name) {
            return None;
        }
        return Some((format!("/{name}"), AlwaysScope::File, None));
    }
    let folder = folders.join("/");
    Some((format!("/{folder}/**"), AlwaysScope::Folder, Some(folder)))
}

// ───────────────────────── 보내는 줄 ─────────────────────────

fn to_line(value: &Value) -> String {
    // 압축 직렬화는 줄바꿈을 `\n` 으로 이스케이프하므로 한 줄이다. 다만 `serde_json` 은 U+2028 · U+2029 · U+0085 를
    // 그대로 내보내는데, 줄 단위로 읽는 쪽이 이 글자를 줄바꿈으로 보면 한 줄이 둘로 쪼개져 CLI 가 죽는다 (JSON 아닌 줄).
    // 이 글자들은 JSON 문자열 안에만 있을 수 있으니 같은 뜻의 이스케이프로 바꿔도 내용은 그대로다.
    let text = value.to_string();
    if !text.contains(['\u{2028}', '\u{2029}', '\u{85}']) {
        return text;
    }
    let mut escaped = String::with_capacity(text.len() + 16);
    for c in text.chars() {
        match c {
            '\u{2028}' => escaped.push_str("\\u2028"),
            '\u{2029}' => escaped.push_str("\\u2029"),
            '\u{85}' => escaped.push_str("\\u0085"),
            other => escaped.push(other),
        }
    }
    escaped
}

pub fn user_message_line(text: &str) -> String {
    to_line(&json!({
        "type": "user",
        "message": { "role": "user", "content": text },
    }))
}

pub fn interrupt_line(request_id: &str) -> String {
    to_line(&json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "interrupt" },
    }))
}

fn control_success(request_id: &str, response: Value) -> String {
    to_line(&json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    }))
}

/// 허용. `updatedInput` 에 원래 입력을 돌려주고, "항상 허용" 이면 `updatedPermissions` 를 싣는다.
pub fn allow_response_line(request_id: &str, input: &Value, always: Option<&Value>) -> String {
    let mut response = Map::new();
    response.insert("behavior".into(), json!("allow"));
    response.insert("updatedInput".into(), input.clone());
    if let Some(rule) = always {
        response.insert("updatedPermissions".into(), json!([rule]));
    }
    control_success(request_id, Value::Object(response))
}

/// 거부. `interrupt` 면 그 턴도 중단된다 ("다르게 하라고 말하기" — D-44).
pub fn deny_response_line(request_id: &str, message: &str, interrupt: bool) -> String {
    let mut response = Map::new();
    response.insert("behavior".into(), json!("deny"));
    response.insert("message".into(), json!(message));
    if interrupt {
        response.insert("interrupt".into(), json!(true));
    }
    control_success(request_id, Value::Object(response))
}

/// 질문 답. `questions` 는 CLI 가 준 원본 그대로, `answers` 는 질문 문장 → 글 · 글 배열.
pub fn answer_response_line(
    request_id: &str,
    questions: &Value,
    answers: &Map<String, Value>,
) -> String {
    control_success(
        request_id,
        json!({
            "behavior": "allow",
            "updatedInput": { "questions": questions, "answers": answers },
        }),
    )
}

/// 모르는 control 요청에 대한 오류 답.
pub fn error_response_line(request_id: &str, error: &str) -> String {
    to_line(&json!({
        "type": "control_response",
        "response": { "subtype": "error", "request_id": request_id, "error": error },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // ── 녹화본 도우미 ──

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cli")
    }

    /// 녹화본에서 CLI → 앱 메시지만 (JSON 인 것만) 순서대로.
    fn recv_messages(name: &str) -> Vec<Value> {
        let text = fs::read_to_string(fixtures_dir().join(format!("{name}.jsonl"))).unwrap();
        text.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|rec| rec["dir"] == "recv")
            .filter_map(|rec| rec.get("msg").cloned())
            .collect()
    }

    fn interpret_all(name: &str, project_dir: &str) -> Vec<Interpretation> {
        let mut interp = Interpreter::new(Path::new(project_dir));
        recv_messages(name)
            .iter()
            .map(|m| interp.handle(m))
            .collect()
    }

    fn events(all: &[Interpretation]) -> Vec<&SessionEvent> {
        all.iter().flat_map(|i| i.events.iter()).collect()
    }

    fn kinds(all: &[Interpretation]) -> Vec<String> {
        events(all)
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect()
    }

    // ── 녹화본 → 이벤트 ──

    #[test]
    fn a_plain_turn_becomes_start_text_rate_limit_end() {
        let all = interpret_all("start", "C:\\p");
        assert_eq!(
            kinds(&all),
            ["turn_started", "text", "rate_limit", "turn_ended"]
        );
        let ev = events(&all);
        let SessionEvent::TurnStarted {
            session_id,
            api_key_source,
            cli_version,
            ..
        } = ev[0]
        else {
            panic!()
        };
        assert_eq!(session_id, "00000000-0000-4000-8000-000000000001");
        assert_eq!(api_key_source.as_deref(), Some("none"));
        assert_eq!(cli_version.as_deref(), Some("2.1.296"));
        let SessionEvent::Text { text } = ev[1] else {
            panic!()
        };
        assert_eq!(text, "pong");
        let SessionEvent::RateLimit {
            status,
            five_hour_utilization,
            ..
        } = ev[2]
        else {
            panic!()
        };
        assert_eq!(status.as_deref(), Some("allowed"));
        assert_eq!(*five_hour_utilization, Some(0.1));
        let SessionEvent::TurnEnded(turn) = ev[3] else {
            panic!()
        };
        assert_eq!(turn.outcome, TurnOutcome::Success);
        assert!(!turn.is_error);
        assert_eq!(turn.result.as_deref(), Some("pong"));
        assert_eq!(turn.usage.output_tokens, 4);
        assert!((turn.cost_usd - 0.00244758).abs() < 1e-9);
        assert_eq!(turn.cost_usd, turn.total_cost_usd);
    }

    #[test]
    fn session_id_and_turn_flags_are_reported() {
        let all = interpret_all("start", "C:\\p");
        assert_eq!(
            all.iter().filter(|i| i.turn_started).count(),
            1,
            "init once"
        );
        assert_eq!(all.iter().filter(|i| i.turn_ended).count(), 1);
        assert_eq!(
            all.iter().find_map(|i| i.session_id.clone()).as_deref(),
            Some("00000000-0000-4000-8000-000000000001")
        );
    }

    #[test]
    fn cost_is_the_difference_from_the_previous_total() {
        let all = interpret_all("two-turns", "C:\\p");
        let turns: Vec<&TurnSummary> = events(&all)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some(t),
                _ => None,
            })
            .collect();
        assert_eq!(turns.len(), 2);
        assert!((turns[0].total_cost_usd - 0.00204).abs() < 1e-3);
        assert!(turns[1].total_cost_usd > turns[0].total_cost_usd);
        assert!(
            (turns[1].cost_usd - (turns[1].total_cost_usd - turns[0].total_cost_usd)).abs() < 1e-9
        );
        assert!(
            turns[1].cost_usd < turns[1].total_cost_usd,
            "delta, not cumulative"
        );
    }

    #[test]
    fn a_new_interpreter_starts_cost_from_zero_again() {
        let first = interpret_all("two-turns", "C:\\p");
        let second = interpret_all("resume.second", "C:\\p");
        let cost_of_first_turn_of_second_process = events(&second)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some((t.cost_usd, t.total_cost_usd)),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            cost_of_first_turn_of_second_process.0,
            cost_of_first_turn_of_second_process.1
        );
        drop(first);
    }

    #[test]
    fn a_permission_prompt_becomes_a_pending_request_and_a_card_event() {
        let all = interpret_all("permission-allow", "C:\\p");
        assert_eq!(
            kinds(&all),
            [
                "turn_started",
                "tool_use",
                "permission_request",
                "rate_limit",
                "tool_result",
                "text",
                "turn_ended"
            ]
        );
        let pending: Vec<_> = all.iter().flat_map(|i| i.new_pending.iter()).collect();
        assert_eq!(pending.len(), 1);
        let (id, request) = pending[0];
        assert_eq!(id, "00000000-0000-4000-8000-000000000004");
        assert_eq!(request.tool, "Write");
        let PendingKind::Permission { input, always } = &request.kind else {
            panic!()
        };
        assert!(input["file_path"].as_str().unwrap().ends_with("hello.txt"));
        // 프로젝트 폴더가 다르므로 폴더 규칙을 만들 수 없다 → 항상 허용 없음
        assert_eq!(*always, None);
        let SessionEvent::PermissionRequest(info) = &request.event else {
            panic!()
        };
        assert_eq!(info.tool, "Write");
        assert!(info.path.as_deref().unwrap().ends_with("hello.txt"));
        assert_eq!(info.cwd, "C:\\p");
        assert_eq!(info.always_rule, None);
    }

    #[test]
    fn write_at_the_top_of_the_project_gets_a_one_file_rule_that_the_cli_accepts() {
        // 녹화본의 임시 폴더를 프로젝트 폴더로 본다.
        let cwd = recv_messages("permission-allow")
            .iter()
            .find(|m| m["subtype"] == "init")
            .map(|m| m["cwd"].as_str().unwrap().to_string())
            .unwrap();
        let all = interpret_all("permission-allow", &cwd);
        let (_, request) = all
            .iter()
            .flat_map(|i| i.new_pending.iter())
            .next()
            .unwrap();
        let SessionEvent::PermissionRequest(info) = &request.event else {
            panic!()
        };
        let rule = info.always_rule.as_ref().unwrap();
        // 맨 위 파일은 그 파일 하나만 (D-45) — 실제 CLI 로 확인: `permission-root-file`
        assert_eq!(rule.rule, "Edit(/hello.txt)");
        assert_eq!(rule.scope, AlwaysScope::File);
        let PendingKind::Permission { always, .. } = &request.kind else {
            panic!()
        };
        assert_eq!(
            always.as_ref().unwrap(),
            &json!({
                "type": "addRules",
                "rules": [{ "toolName": "Edit", "ruleContent": "/hello.txt" }],
                "behavior": "allow",
                "destination": "localSettings"
            })
        );
    }

    #[test]
    fn bash_uses_the_rule_the_cli_suggested() {
        let all = interpret_all("permission-always", "C:\\p");
        let (_, request) = all
            .iter()
            .flat_map(|i| i.new_pending.iter())
            .next()
            .unwrap();
        assert_eq!(request.tool, "Bash");
        let SessionEvent::PermissionRequest(info) = &request.event else {
            panic!()
        };
        assert_eq!(info.command.as_deref(), Some("mkdir probe-dir"));
        let rule = info.always_rule.as_ref().unwrap();
        assert_eq!(rule.rule, "Bash(mkdir probe-dir *)");
        assert_eq!(rule.scope, AlwaysScope::Suggested);
        let PendingKind::Permission { always, .. } = &request.kind else {
            panic!()
        };
        // CLI 가 준 제안 그대로 (setMode · addDirectories 는 싣지 않는다)
        assert_eq!(
            always.as_ref().unwrap(),
            &json!({
                "type": "addRules",
                "rules": [{ "toolName": "Bash", "ruleContent": "mkdir probe-dir *" }],
                "behavior": "allow",
                "destination": "localSettings"
            })
        );
    }

    #[test]
    fn a_question_becomes_a_card_with_options_and_keeps_the_original_questions() {
        let all = interpret_all("question.multi", "C:\\p");
        let (id, request) = all
            .iter()
            .flat_map(|i| i.new_pending.iter())
            .next()
            .unwrap();
        assert!(!id.is_empty());
        assert_eq!(request.tool, ASK_USER_QUESTION);
        let PendingKind::Question { questions, shapes } = &request.kind else {
            panic!()
        };
        assert!(questions.as_array().is_some_and(|q| !q.is_empty()));
        assert!(!shapes.is_empty());
        let SessionEvent::QuestionRequest(info) = &request.event else {
            panic!()
        };
        assert_eq!(info.questions.len(), shapes.len());
        let first = &info.questions[0];
        assert_eq!(first.question, shapes[0].question);
        assert!(first.options.len() >= 2);
        assert!(first.options.iter().all(|o| !o.label.is_empty()));
    }

    #[test]
    fn a_pending_request_cancel_is_reported_with_its_id() {
        let all = interpret_all("interrupt.pending-permission", "C:\\p");
        let cancelled: Vec<_> = all.iter().flat_map(|i| i.cancelled.iter()).collect();
        assert_eq!(cancelled.len(), 1);
        let pending_id = &all
            .iter()
            .flat_map(|i| i.new_pending.iter())
            .next()
            .unwrap()
            .0;
        assert_eq!(cancelled[0], pending_id);
        assert!(events(&all).iter().any(|e| matches!(e, SessionEvent::RequestCancelled { request_id } if request_id == pending_id)));
    }

    #[test]
    fn interrupted_turns_are_reported_as_interrupted() {
        let all = interpret_all("interrupt.pending-permission", "C:\\p");
        let outcomes: Vec<_> = events(&all)
            .into_iter()
            .filter_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some(t.outcome),
                _ => None,
            })
            .collect();
        assert_eq!(outcomes, [TurnOutcome::Interrupted, TurnOutcome::Success]);
    }

    #[test]
    fn a_missing_session_is_an_error_turn_and_flags_resume_not_found() {
        let all = interpret_all("strange-bad-args.bad-resume", "C:\\p");
        assert!(all.iter().any(|i| i.resume_not_found));
        let turn = events(&all)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some(t.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(turn.outcome, TurnOutcome::Error);
        assert!(
            turn.errors
                .iter()
                .any(|e| e.contains("No conversation found"))
        );
        assert!(
            all.iter().all(|i| i.session_id.is_none()),
            "no init → nothing to save"
        );
    }

    #[test]
    fn api_errors_are_errors_even_though_the_subtype_says_success() {
        let all = interpret_all("strange-bad-args.bad-model", "C:\\p");
        let turn = events(&all)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some(t.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(turn.subtype.as_deref(), Some("success"));
        assert!(turn.is_error);
        assert_eq!(turn.outcome, TurnOutcome::Error);
        assert_eq!(turn.api_error_status, Some(404));
    }

    #[test]
    fn max_turns_is_an_error_outcome() {
        let all = interpret_all("strange-max-turns", "C:\\p");
        let turn = events(&all)
            .into_iter()
            .find_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some(t.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(turn.outcome, TurnOutcome::Error);
        assert_eq!(turn.subtype.as_deref(), Some("error_max_turns"));
    }

    #[test]
    fn a_rejected_rate_limit_followed_by_an_error_result_is_a_limit_outcome() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        interp.handle(&json!({
            "type": "rate_limit_event",
            "rate_limit_info": { "status": "rejected", "rateLimitType": "five_hour", "resetsAt": 1 }
        }));
        let out = interp.handle(&json!({
            "type": "result", "subtype": "success", "is_error": true, "terminal_reason": "api_error",
            "result": "limit reached", "total_cost_usd": 0.0
        }));
        let SessionEvent::TurnEnded(turn) = &out.events[0] else {
            panic!()
        };
        assert_eq!(turn.outcome, TurnOutcome::Limit);
        // 429 도 한도
        let out = interp.handle(&json!({
            "type": "result", "subtype": "success", "is_error": true, "api_error_status": 429
        }));
        let SessionEvent::TurnEnded(turn) = &out.events[0] else {
            panic!()
        };
        assert_eq!(turn.outcome, TurnOutcome::Limit);
    }

    #[test]
    fn unknown_message_types_and_system_noise_produce_nothing() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        for msg in [
            json!({ "type": "future_thing", "x": 1 }),
            json!({ "type": "system", "subtype": "thinking_tokens", "estimated_tokens": 5 }),
            json!({ "type": "system", "subtype": "task_started" }),
            json!({ "no_type": true }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "" }] } }),
        ] {
            assert_eq!(interp.handle(&msg), Interpretation::default(), "{msg}");
        }
    }

    #[test]
    fn unknown_control_requests_get_an_error_reply_so_the_cli_is_not_left_waiting() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let out = interp.handle(&json!({
            "type": "control_request", "request_id": "r9", "request": { "subtype": "hook_callback" }
        }));
        assert_eq!(out.replies.len(), 1);
        let reply: Value = serde_json::from_str(&out.replies[0]).unwrap();
        assert_eq!(reply["response"]["subtype"], "error");
        assert_eq!(reply["response"]["request_id"], "r9");
        assert!(out.new_pending.is_empty());
        assert!(matches!(
            &out.events[0],
            SessionEvent::Warning { code, .. } if code == "unknown_control_request"
        ));
    }

    #[test]
    fn an_unreadable_question_is_denied_instead_of_left_waiting() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let out = interp.handle(&json!({
            "type": "control_request", "request_id": "q1",
            "request": { "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": { "questions": [] } }
        }));
        assert!(out.new_pending.is_empty());
        let reply: Value = serde_json::from_str(&out.replies[0]).unwrap();
        assert_eq!(reply["response"]["response"]["behavior"], "deny");
    }

    #[test]
    fn control_errors_from_the_cli_become_warnings() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let out = interp.handle(&json!({
            "type": "control_response",
            "response": { "subtype": "error", "request_id": "x", "error": "Unsupported control request subtype: bogus" }
        }));
        assert!(matches!(
            &out.events[0],
            SessionEvent::Warning { code, detail } if code == "control_error" && detail.as_deref().is_some_and(|d| d.contains("bogus"))
        ));
        // 성공 응답은 조용하다
        let out = interp.handle(&json!({
            "type": "control_response", "response": { "subtype": "success", "request_id": "x", "response": {} }
        }));
        assert!(out.events.is_empty());
    }

    #[test]
    fn every_fixture_interprets_without_panicking() {
        let mut count = 0;
        for entry in fs::read_dir(fixtures_dir()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let name = path.file_stem().unwrap().to_string_lossy().into_owned();
            let all = interpret_all(&name, "C:\\p");
            let turns = all.iter().filter(|i| i.turn_ended).count();
            let results = recv_messages(&name)
                .iter()
                .filter(|m| m["type"] == "result")
                .count();
            assert_eq!(turns, results, "{name}");
            count += 1;
        }
        assert!(count >= 30, "found only {count} fixtures");
    }

    // ── 보내는 줄 ──

    #[test]
    fn outgoing_lines_are_single_line_json_even_with_newlines_in_the_text() {
        let line = user_message_line("first\nsecond \"quoted\"");
        assert!(!line.contains('\n'));
        let back: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(back["message"]["content"], "first\nsecond \"quoted\"");
        assert_eq!(back["type"], "user");
        assert_eq!(back["message"]["role"], "user");
    }

    #[test]
    fn allow_returns_the_original_input_and_optionally_the_rule() {
        let input = json!({ "command": "mkdir x", "description": "d" });
        let rule = json!({ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "mkdir x *" }], "behavior": "allow", "destination": "localSettings" });
        let plain: Value = serde_json::from_str(&allow_response_line("r", &input, None)).unwrap();
        assert_eq!(
            plain,
            json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "r",
                "response": { "behavior": "allow", "updatedInput": input } } })
        );
        let always: Value =
            serde_json::from_str(&allow_response_line("r", &input, Some(&rule))).unwrap();
        assert_eq!(
            always["response"]["response"]["updatedPermissions"],
            json!([rule])
        );
    }

    #[test]
    fn deny_may_carry_interrupt() {
        let plain: Value = serde_json::from_str(&deny_response_line("r", "no", false)).unwrap();
        assert_eq!(
            plain["response"]["response"],
            json!({ "behavior": "deny", "message": "no" })
        );
        let interrupted: Value =
            serde_json::from_str(&deny_response_line("r", "no", true)).unwrap();
        assert_eq!(interrupted["response"]["response"]["interrupt"], true);
    }

    #[test]
    fn answers_go_into_updated_input_with_the_original_questions() {
        let questions = json!([{ "question": "Color?", "options": [] }]);
        let mut answers = Map::new();
        answers.insert("Color?".into(), json!("Blue"));
        let line: Value =
            serde_json::from_str(&answer_response_line("q", &questions, &answers)).unwrap();
        assert_eq!(
            line["response"]["response"],
            json!({ "behavior": "allow", "updatedInput": { "questions": questions, "answers": { "Color?": "Blue" } } })
        );
    }

    #[test]
    fn interrupt_line_matches_the_recorded_shape() {
        let line: Value = serde_json::from_str(&interrupt_line("nyanitor-int-1")).unwrap();
        assert_eq!(
            line,
            json!({ "type": "control_request", "request_id": "nyanitor-int-1", "request": { "subtype": "interrupt" } })
        );
    }

    #[test]
    fn parse_line_accepts_only_json_objects() {
        assert!(parse_line("{\"type\":\"result\"}").is_some());
        assert!(parse_line("  {\"a\":1}\r").is_some());
        for bad in [
            "",
            "this is not json",
            "[1,2]",
            "42",
            "\"str\"",
            "{\"cut\":",
        ] {
            assert!(parse_line(bad).is_none(), "{bad}");
        }
    }

    // ── 규칙 ──

    #[test]
    fn folder_rules_narrow_to_the_files_folder() {
        let (content, scope, folder) =
            folder_rule("C:\\dev\\app", "C:\\dev\\app\\src\\lib\\a.ts").unwrap();
        assert_eq!(content, "/src/lib/**");
        assert_eq!(scope, AlwaysScope::Folder);
        assert_eq!(folder.as_deref(), Some("src/lib"));
        let (content, scope, folder) =
            folder_rule("C:\\dev\\app", "C:\\dev\\app\\README.md").unwrap();
        assert_eq!(content, "/README.md");
        assert_eq!(scope, AlwaysScope::File);
        assert_eq!(folder, None);
    }

    #[test]
    fn folder_rules_refuse_files_outside_the_project() {
        for file in [
            "C:\\dev\\other\\a.ts",
            "C:\\dev\\app",              // 프로젝트 폴더 자체
            "C:\\dev\\app\\..\\x\\a.ts", // `..` 로 빠져나감
            "D:\\dev\\app\\a.ts",
            "relative\\a.ts",
        ] {
            assert_eq!(folder_rule("C:\\dev\\app", file), None, "{file}");
        }
    }

    #[test]
    fn folder_rules_refuse_folder_names_with_rule_syntax() {
        for file in [
            "C:\\dev\\app\\a*b\\x.ts",
            "C:\\dev\\app\\a[1]\\x.ts",
            "C:\\dev\\app\\!bang\\x.ts",
            "C:\\dev\\app\\{a,b}\\x.ts",
            "C:\\dev\\app\\trail \\x.ts",
        ] {
            assert_eq!(folder_rule("C:\\dev\\app", file), None, "{file}");
        }
    }

    #[test]
    fn folder_rules_handle_slashes_and_verbatim_paths() {
        let (content, ..) = folder_rule("C:/dev/app/", "C:/dev/app/src/a.ts").unwrap();
        assert_eq!(content, "/src/**");
        let (content, ..) = folder_rule("C:\\dev\\app", "\\\\?\\C:\\dev\\app\\src\\a.ts").unwrap();
        assert_eq!(content, "/src/**");
        let (content, ..) =
            folder_rule("C:\\dev\\app", "C:\\dev\\app\\src\\..\\lib\\a.ts").unwrap();
        assert_eq!(content, "/lib/**");
    }

    #[cfg(windows)]
    #[test]
    fn folder_rules_compare_case_insensitively_on_windows_and_keep_the_files_case() {
        let (content, ..) = folder_rule("c:\\DEV\\App", "C:\\dev\\app\\Src\\a.ts").unwrap();
        assert_eq!(content, "/Src/**");
    }

    #[test]
    fn tools_without_file_paths_or_suggestions_get_no_always_rule() {
        assert_eq!(
            always_rule("C:\\p", "WebFetch", &json!({ "url": "http://x" }), &[]),
            None
        );
        assert_eq!(
            always_rule("C:\\p", "Bash", &json!({ "command": "rm x" }), &[]),
            None
        );
        assert_eq!(always_rule("C:\\p", "Write", &json!({}), &[]), None);
    }

    #[test]
    fn suggestions_that_would_allow_all_of_bash_are_not_used() {
        let broad = json!({ "type": "addRules", "rules": [{ "toolName": "Bash" }], "behavior": "allow", "destination": "localSettings" });
        assert_eq!(always_rule("C:\\p", "Bash", &json!({}), &[broad]), None);
        let session_only = json!({ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "ls *" }], "behavior": "allow", "destination": "session" });
        assert_eq!(
            always_rule("C:\\p", "Bash", &json!({}), &[session_only]),
            None
        );
        let deny_rule = json!({ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "ls *" }], "behavior": "deny", "destination": "localSettings" });
        assert_eq!(always_rule("C:\\p", "Bash", &json!({}), &[deny_rule]), None);
        let mode = json!({ "type": "setMode", "mode": "acceptEdits", "destination": "session" });
        assert_eq!(always_rule("C:\\p", "Bash", &json!({}), &[mode]), None);
    }

    #[test]
    fn summaries_pick_the_useful_field_and_truncate() {
        assert_eq!(
            summarize_tool_input("Bash", Some(&json!({ "command": "ls" }))),
            "ls"
        );
        assert_eq!(
            summarize_tool_input(
                "Write",
                Some(&json!({ "file_path": "a.txt", "content": "zzz" }))
            ),
            "a.txt"
        );
        assert_eq!(summarize_tool_input("Unknown", Some(&json!({}))), "");
        assert_eq!(summarize_tool_input("Bash", None), "");
        let long = "가".repeat(400);
        let summary = summarize_tool_input("Bash", Some(&json!({ "command": long })));
        assert_eq!(summary.chars().count(), SUMMARY_CHARS + 1);
        assert!(summary.ends_with('…'));
    }
}

/// P3-03 — 경계 · 실패 시험. (앞의 `tests` 모듈은 P3-02 가 녹화본으로 쓴 것.)
#[cfg(test)]
mod edge_tests {
    use super::*;

    fn rule_of(project: &str, tool: &str, input: Value) -> Option<String> {
        always_rule(project, tool, &input, &[]).map(|(info, _)| info.rule)
    }

    fn write_rule(project: &str, file: &str) -> Option<String> {
        rule_of(project, "Write", json!({ "file_path": file }))
    }

    // ───────── 항상 허용 규칙: 경로 ─────────

    #[test]
    fn mixed_slashes_dot_segments_and_trailing_separators_give_the_same_rule() {
        let expected = Some("Edit(/src/**)".to_string());
        for (project, file) in [
            ("C:\\p", "C:\\p\\src\\a.ts"),
            ("C:\\p\\", "C:\\p\\src\\a.ts"),
            ("C:/p", "C:\\p/src\\a.ts"),
            ("C:\\p", "C:/p/src/a.ts"),
            ("C:\\p", "C:\\p\\.\\src\\.\\a.ts"),
            ("C:\\p", "C:\\p\\\\src\\\\a.ts"),
            ("C:\\p", "C:\\p\\src\\sub\\..\\a.ts"),
            ("C:\\p\\.", "C:\\p\\src\\a.ts"),
        ] {
            assert_eq!(write_rule(project, file), expected, "{project} / {file}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_drive_and_folder_case_do_not_matter_but_the_rule_keeps_the_files_case() {
        assert_eq!(
            write_rule("c:\\USERS\\Me\\Proj", "C:\\users\\me\\proj\\Src\\A.ts").as_deref(),
            Some("Edit(/Src/**)")
        );
        assert_eq!(
            write_rule("C:\\p", "c:\\P\\a.ts").as_deref(),
            Some("Edit(/a.ts)")
        );
    }

    #[test]
    fn a_sibling_folder_whose_name_starts_the_same_is_outside_the_project() {
        for (project, file) in [
            ("C:\\p", "C:\\p2\\a.ts"),
            ("C:\\p", "C:\\p2\\src\\a.ts"),
            ("C:\\p", "C:\\p-old\\a.ts"),
            ("C:\\p", "C:\\pp\\p\\a.ts"),
            ("C:\\p2", "C:\\p\\a.ts"),
            ("C:\\proj", "C:\\pro\\a.ts"),
        ] {
            assert_eq!(write_rule(project, file), None, "{project} / {file}");
        }
    }

    #[test]
    fn dotdot_that_leaves_the_project_or_climbs_above_the_root_gives_no_rule() {
        for file in [
            "C:\\p\\..\\a.ts",
            "C:\\p\\src\\..\\..\\a.ts",
            "C:\\p\\src\\..\\..\\q\\a.ts",
            "C:\\..\\..\\..\\p\\a.ts",
            "C:\\p\\..\\p2\\a.ts",
        ] {
            assert_eq!(write_rule("C:\\p", file), None, "{file}");
        }
        // 밖으로 나갔다가 다시 들어오는 것은 같은 파일이다
        assert_eq!(
            write_rule("C:\\p", "C:\\p\\..\\p\\src\\a.ts").as_deref(),
            Some("Edit(/src/**)")
        );
    }

    #[test]
    fn other_drives_relative_paths_and_empty_values_give_no_rule() {
        for file in [
            "D:\\p\\a.ts",
            "a.ts",
            "./a.ts",
            "src\\a.ts",
            "..\\p\\a.ts",
            "",
            " ",
            "C:a.ts",
            "C:p\\a.ts",
            "~\\a.ts",
        ] {
            assert_eq!(write_rule("C:\\p", file), None, "{file:?}");
        }
    }

    #[test]
    fn the_project_folder_itself_and_its_root_marker_are_not_files() {
        for file in ["C:\\p", "C:\\p\\", "C:\\p\\.", "C:\\"] {
            assert_eq!(write_rule("C:\\p", file), None, "{file}");
        }
    }

    #[test]
    fn unc_projects_work_and_other_shares_are_outside() {
        let project = "\\\\srv\\share\\proj";
        assert_eq!(
            write_rule(project, "\\\\srv\\share\\proj\\src\\a.ts").as_deref(),
            Some("Edit(/src/**)")
        );
        assert_eq!(write_rule(project, "\\\\srv\\share\\proj2\\a.ts"), None);
        assert_eq!(write_rule(project, "\\\\srv\\share2\\proj\\a.ts"), None);
        assert_eq!(write_rule(project, "\\\\other\\share\\proj\\a.ts"), None);
        // 같은 이름의 로컬 드라이브 경로와 섞이지 않는다
        assert_eq!(
            write_rule("C:\\srv\\share\\proj", "\\\\srv\\share\\proj\\a.ts"),
            None
        );
    }

    #[test]
    fn korean_and_spaced_folder_names_are_kept_as_they_are() {
        assert_eq!(
            write_rule(
                "C:\\Users\\김 하나\\내 프로젝트",
                "C:\\Users\\김 하나\\내 프로젝트\\소스 코드\\화면\\a.tsx"
            )
            .as_deref(),
            Some("Edit(/소스 코드/화면/**)")
        );
    }

    #[test]
    fn a_very_deep_folder_still_gets_a_rule_without_trouble() {
        let deep = (0..300)
            .map(|i| format!("d{i}"))
            .collect::<Vec<_>>()
            .join("\\");
        let file = format!("C:\\p\\{deep}\\a.ts");
        let rule = write_rule("C:\\p", &file).expect("a rule for a deep folder");
        assert!(rule.starts_with("Edit(/d0/d1/d2/") && rule.ends_with("/d299/**)"));
        // 길이가 아주 긴 한 칸도 패닉 없이 처리한다
        let long = "가".repeat(5000);
        assert!(write_rule("C:\\p", &format!("C:\\p\\{long}\\a.ts")).is_some());
    }

    #[test]
    fn a_file_at_the_top_of_the_project_gets_that_one_file_and_never_the_whole_project() {
        let (info, value) = always_rule(
            "C:\\p",
            "Edit",
            &json!({ "file_path": "C:\\p\\README.md" }),
            &[],
        )
        .unwrap();
        assert_eq!(info.scope, AlwaysScope::File);
        assert_eq!(info.rule, "Edit(/README.md)");
        assert_eq!(info.folder, None);
        assert_eq!(value["rules"][0]["toolName"], "Edit");
        assert_eq!(value["rules"][0]["ruleContent"], "/README.md");
        assert_eq!(value["destination"], "localSettings");
        assert_eq!(value["behavior"], "allow");
    }

    #[test]
    fn every_file_editing_tool_asks_for_the_same_edit_rule_and_notebook_path_counts() {
        for tool in ["Write", "Edit", "MultiEdit"] {
            assert_eq!(
                rule_of("C:\\p", tool, json!({ "file_path": "C:\\p\\src\\a.ts" })).as_deref(),
                Some("Edit(/src/**)"),
                "{tool}"
            );
        }
        assert_eq!(
            rule_of(
                "C:\\p",
                "NotebookEdit",
                json!({ "notebook_path": "C:\\p\\nb\\a.ipynb" })
            )
            .as_deref(),
            Some("Edit(/nb/**)")
        );
        // 읽기 도구 · 모르는 도구는 파일 경로가 있어도 규칙을 만들지 않는다
        for tool in ["Read", "Glob", "Grep", "SomethingNew", "write", ""] {
            assert_eq!(
                rule_of("C:\\p", tool, json!({ "file_path": "C:\\p\\src\\a.ts" })),
                None,
                "{tool:?}"
            );
        }
    }

    #[test]
    fn file_path_missing_or_of_the_wrong_type_gives_no_rule() {
        for input in [
            json!({}),
            json!(null),
            json!("C:\\p\\a.ts"),
            json!({ "file_path": null }),
            json!({ "file_path": 5 }),
            json!({ "file_path": ["C:\\p\\a.ts"] }),
            json!({ "path": "C:\\p\\a.ts" }),
        ] {
            assert_eq!(rule_of("C:\\p", "Write", input.clone()), None, "{input}");
        }
    }

    #[test]
    fn rule_syntax_characters_anywhere_in_the_folder_chain_refuse_the_rule() {
        for name in ["a*", "?x", "[a]", "a]", "{a}", "!x", "x "] {
            let file = format!("C:\\p\\ok\\{name}\\deeper\\a.ts");
            assert_eq!(write_rule("C:\\p", &file), None, "{name}");
        }
        // 파일 이름(마지막 칸)에 있는 글자는 규칙에 들어가지 않으므로 상관없다
        assert_eq!(
            write_rule("C:\\p", "C:\\p\\src\\a*[1]!.ts").as_deref(),
            Some("Edit(/src/**)")
        );
    }

    #[test]
    fn parentheses_and_control_characters_in_folder_names_refuse_the_rule() {
        for name in ["a(1)", "(x", "x)", "a\nb", "a\u{0}b", "a\tb"] {
            let file = format!("C:\\p\\{name}\\a.ts");
            assert_eq!(write_rule("C:\\p", &file), None, "{name:?}");
        }
    }

    #[test]
    fn a_path_that_ends_with_a_separator_is_not_widened_to_the_whole_project() {
        // 폴더 모양 경로로는 어떤 규칙도 만들지 않는다 (`Edit(/src)` 도 폴더 아래 전부가 된다)
        for file in [
            "C:\\p\\src\\",
            "C:\\p\\src/",
            "C:\\p\\src\\.",
            "C:\\p\\a\\b\\..",
            "C:\\p\\",
        ] {
            assert_eq!(write_rule("C:\\p", file), None, "{file}");
        }
    }

    // ───────── 항상 허용 규칙: CLI 가 제안한 것 ─────────

    fn suggestion(rules: Value, destination: &str, behavior: &str) -> Value {
        json!({ "type": "addRules", "rules": rules, "behavior": behavior, "destination": destination })
    }

    #[test]
    fn bash_suggestions_need_rule_content_a_local_settings_destination_and_allow() {
        let bash = |content: Value| json!([{ "toolName": "Bash", "ruleContent": content }]);
        let cases = [
            // (제안, 쓸 수 있는가)
            (
                suggestion(bash(json!("ls *")), "localSettings", "allow"),
                true,
            ),
            (suggestion(bash(json!("")), "localSettings", "allow"), false),
            (
                suggestion(bash(json!(null)), "localSettings", "allow"),
                false,
            ),
            (
                suggestion(json!([{ "toolName": "Bash" }]), "localSettings", "allow"),
                false,
            ),
            (
                suggestion(
                    json!([{ "toolName": "PowerShell" }]),
                    "localSettings",
                    "allow",
                ),
                false,
            ),
            // 저장소에 올라가는 공용 파일 · 모든 프로젝트에 퍼지는 파일 · 세션 한정 · 모르는 곳
            (
                suggestion(bash(json!("ls *")), "projectSettings", "allow"),
                false,
            ),
            (
                suggestion(bash(json!("ls *")), "userSettings", "allow"),
                false,
            ),
            (suggestion(bash(json!("ls *")), "session", "allow"), false),
            (suggestion(bash(json!("ls *")), "cliArg", "allow"), false),
            (suggestion(bash(json!("ls *")), "", "allow"), false),
            (
                suggestion(bash(json!("ls *")), "localSettings", "deny"),
                false,
            ),
            (
                suggestion(bash(json!("ls *")), "localSettings", "ask"),
                false,
            ),
            (suggestion(json!([]), "localSettings", "allow"), false),
            (
                suggestion(json!("Bash(ls *)"), "localSettings", "allow"),
                false,
            ),
            (
                suggestion(
                    json!([{ "toolName": 5, "ruleContent": "x" }]),
                    "localSettings",
                    "allow",
                ),
                false,
            ),
            (
                suggestion(json!([{ "ruleContent": "x" }]), "localSettings", "allow"),
                false,
            ),
            (suggestion(json!([null]), "localSettings", "allow"), false),
            (
                json!({ "type": "setMode", "mode": "acceptEdits", "destination": "localSettings" }),
                false,
            ),
            (
                json!({ "type": "addDirectories", "directories": ["C:\\"], "destination": "localSettings" }),
                false,
            ),
            (
                json!({ "destination": "localSettings", "behavior": "allow" }),
                false,
            ),
            (json!("addRules"), false),
            (json!(null), false),
        ];
        for (suggested, ok) in cases {
            let found = always_rule(
                "C:\\p",
                "Bash",
                &json!({ "command": "ls" }),
                std::slice::from_ref(&suggested),
            );
            assert_eq!(found.is_some(), ok, "{suggested}");
        }
    }

    #[test]
    fn several_rules_in_one_suggestion_are_shown_together_and_sent_back_untouched() {
        let one = suggestion(
            json!([
                { "toolName": "Bash", "ruleContent": "ls *" },
                { "toolName": "Bash", "ruleContent": "cat *" }
            ]),
            "localSettings",
            "allow",
        );
        let (info, sent) =
            always_rule("C:\\p", "Bash", &json!({}), std::slice::from_ref(&one)).unwrap();
        assert_eq!(info.rule, "Bash(ls *), Bash(cat *)");
        assert_eq!(info.scope, AlwaysScope::Suggested);
        assert_eq!(sent, one);
    }

    #[test]
    fn one_broad_rule_among_several_makes_the_whole_suggestion_unusable() {
        let mixed = suggestion(
            json!([
                { "toolName": "Bash", "ruleContent": "ls *" },
                { "toolName": "Bash" }
            ]),
            "localSettings",
            "allow",
        );
        assert_eq!(always_rule("C:\\p", "Bash", &json!({}), &[mixed]), None);
    }

    #[test]
    fn the_first_usable_suggestion_wins_and_unusable_ones_before_it_are_skipped() {
        let bad = suggestion(json!([{ "toolName": "Bash" }]), "localSettings", "allow");
        let session = suggestion(
            json!([{ "toolName": "Bash", "ruleContent": "a *" }]),
            "session",
            "allow",
        );
        let first = suggestion(
            json!([{ "toolName": "Bash", "ruleContent": "b *" }]),
            "localSettings",
            "allow",
        );
        let second = suggestion(
            json!([{ "toolName": "Bash", "ruleContent": "c *" }]),
            "localSettings",
            "allow",
        );
        let (info, sent) = always_rule(
            "C:\\p",
            "Bash",
            &json!({}),
            &[bad, session, first.clone(), second],
        )
        .unwrap();
        assert_eq!(info.rule, "Bash(b *)");
        assert_eq!(sent, first);
    }

    #[test]
    fn a_suggestion_wins_over_the_folder_rule_for_file_tools_too() {
        let given = suggestion(
            json!([{ "toolName": "Edit", "ruleContent": "/docs/**" }]),
            "localSettings",
            "allow",
        );
        let (info, sent) = always_rule(
            "C:\\p",
            "Write",
            &json!({ "file_path": "C:\\p\\src\\a.ts" }),
            std::slice::from_ref(&given),
        )
        .unwrap();
        assert_eq!(info.rule, "Edit(/docs/**)");
        assert_eq!(sent, given);
    }

    #[test]
    fn file_and_web_tools_without_rule_content_are_not_accepted_from_suggestions() {
        for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch"] {
            let broad = suggestion(json!([{ "toolName": tool }]), "localSettings", "allow");
            assert_eq!(
                always_rule("C:\\p", tool, &json!({}), &[broad]),
                None,
                "{tool}"
            );
        }
    }

    #[test]
    fn a_permission_request_with_odd_suggestions_does_not_break_the_card() {
        for suggestions in [
            json!("x"),
            json!(5),
            json!(null),
            json!({ "a": 1 }),
            json!([null, 5, "x"]),
        ] {
            let mut interp = Interpreter::new(Path::new("C:\\p"));
            let out = interp.handle(&json!({
                "type": "control_request", "request_id": "r1",
                "request": {
                    "subtype": "can_use_tool", "tool_name": "Write",
                    "input": { "file_path": "C:\\p\\src\\a.ts" },
                    "permission_suggestions": suggestions
                }
            }));
            let Some(SessionEvent::PermissionRequest(info)) = out.events.first() else {
                panic!("expected a card for {suggestions}");
            };
            // 제안이 쓸모없으면 폴더 규칙으로
            assert_eq!(info.always_rule.as_ref().unwrap().rule, "Edit(/src/**)");
        }
    }
}

/// P3-03 — 받은 줄 해석 · 보내는 줄 경계 시험 (위 `edge_tests` 의 이어서).
#[cfg(test)]
mod edge_tests_lines {
    use super::*;

    fn handle(msg: Value) -> Interpretation {
        Interpreter::new(Path::new("C:\\p")).handle(&msg)
    }

    fn result_msg(extra: Value) -> Value {
        let mut base = json!({ "type": "result", "subtype": "success", "is_error": false, "result": "ok", "total_cost_usd": 0.5 });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    fn turn(out: &Interpretation) -> &TurnSummary {
        out.events
            .iter()
            .find_map(|e| match e {
                SessionEvent::TurnEnded(t) => Some(t),
                _ => None,
            })
            .expect("a turn_ended event")
    }

    // ───────── 받은 줄 해석: 모양이 이상한 것 ─────────

    #[test]
    fn result_with_fields_of_the_wrong_type_still_ends_the_turn_without_panicking() {
        let out = handle(result_msg(json!({
            "is_error": "yes",
            "total_cost_usd": "0.5",
            "duration_ms": "12",
            "num_turns": -3,
            "usage": { "input_tokens": "7", "output_tokens": -1, "cache_read_input_tokens": 1.5 },
            "errors": "oops",
            "terminal_reason": 7,
            "api_error_status": "429",
            "result": 42,
            "subtype": ["x"]
        })));
        assert!(out.turn_ended);
        let t = turn(&out);
        assert!(
            !t.is_error,
            "a string is not a boolean — treated as no error"
        );
        assert_eq!(t.outcome, TurnOutcome::Success);
        assert_eq!(t.cost_usd, 0.0);
        assert_eq!(t.duration_ms, None);
        assert_eq!(t.num_turns, None);
        assert_eq!(t.usage, TokenUsage::default());
        assert!(t.errors.is_empty());
        assert_eq!(t.result, None);
        assert_eq!(t.subtype, None);
    }

    #[test]
    fn a_result_with_nothing_in_it_is_still_a_turn_end() {
        let out = handle(json!({ "type": "result" }));
        assert!(out.turn_ended);
        let t = turn(&out);
        assert_eq!(t.outcome, TurnOutcome::Success);
        assert_eq!((t.cost_usd, t.total_cost_usd), (0.0, 0.0));
    }

    #[test]
    fn unknown_result_subtypes_are_reported_as_they_are() {
        let ok = handle(result_msg(json!({ "subtype": "brand_new_subtype" })));
        assert_eq!(turn(&ok).subtype.as_deref(), Some("brand_new_subtype"));
        assert_eq!(turn(&ok).outcome, TurnOutcome::Success);
        let err = handle(result_msg(
            json!({ "subtype": "brand_new_subtype", "is_error": true }),
        ));
        assert_eq!(turn(&err).outcome, TurnOutcome::Error);
    }

    #[test]
    fn an_error_result_is_a_limit_only_for_429_or_a_rejected_rate_event() {
        let limit = handle(result_msg(
            json!({ "is_error": true, "api_error_status": 429 }),
        ));
        assert_eq!(turn(&limit).outcome, TurnOutcome::Limit);
        let other = handle(result_msg(
            json!({ "is_error": true, "api_error_status": 500 }),
        ));
        assert_eq!(turn(&other).outcome, TurnOutcome::Error);
        let ok_429 = handle(result_msg(
            json!({ "is_error": false, "api_error_status": 429 }),
        ));
        assert_eq!(turn(&ok_429).outcome, TurnOutcome::Success);
        let aborted = handle(result_msg(
            json!({ "is_error": true, "terminal_reason": "aborted_tools", "api_error_status": 429 }),
        ));
        assert_eq!(turn(&aborted).outcome, TurnOutcome::Interrupted);
    }

    #[test]
    fn a_rejected_rate_limit_does_not_turn_a_later_unrelated_error_into_a_limit() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        interp.handle(
            &json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "rejected" } }),
        );
        let first = interp.handle(&result_msg(json!({ "is_error": true })));
        assert_eq!(turn(&first).outcome, TurnOutcome::Limit);
        // 다음 턴: 한도 이야기 없이 서버 오류
        interp.handle(&json!({ "type": "system", "subtype": "init", "session_id": "s" }));
        let second = interp.handle(&result_msg(
            json!({ "is_error": true, "api_error_status": 500 }),
        ));
        assert_eq!(turn(&second).outcome, TurnOutcome::Error);
    }

    #[test]
    fn cost_never_goes_negative_when_the_total_shrinks_and_the_new_total_becomes_the_base() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let a = interp.handle(&result_msg(json!({ "total_cost_usd": 0.50 })));
        assert_eq!(turn(&a).cost_usd, 0.5);
        // 새 프로세스처럼 누적이 줄어든 값이 왔다
        let b = interp.handle(&result_msg(json!({ "total_cost_usd": 0.10 })));
        assert_eq!(turn(&b).cost_usd, 0.0);
        assert_eq!(turn(&b).total_cost_usd, 0.1);
        // 그다음 턴은 줄어든 값을 기준으로 차이를 낸다
        let c = interp.handle(&result_msg(json!({ "total_cost_usd": 0.13 })));
        assert!(
            (turn(&c).cost_usd - 0.03).abs() < 1e-9,
            "{}",
            turn(&c).cost_usd
        );
    }

    #[test]
    fn a_missing_cost_keeps_the_running_total_and_charges_nothing() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        interp.handle(&result_msg(json!({ "total_cost_usd": 0.25 })));
        let mut no_cost = result_msg(json!({}));
        no_cost.as_object_mut().unwrap().remove("total_cost_usd");
        let out = interp.handle(&no_cost);
        assert_eq!(turn(&out).cost_usd, 0.0);
        assert_eq!(turn(&out).total_cost_usd, 0.25);
        let next = interp.handle(&result_msg(json!({ "total_cost_usd": 0.30 })));
        assert!((turn(&next).cost_usd - 0.05).abs() < 1e-9);
    }

    #[test]
    fn floating_point_noise_is_rounded_away_and_huge_or_zero_costs_survive() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        interp.handle(&result_msg(json!({ "total_cost_usd": 0.1 })));
        let out = interp.handle(&result_msg(
            json!({ "total_cost_usd": 0.30000000000000004 }),
        ));
        assert_eq!(turn(&out).cost_usd, 0.2);
        let mut fresh = Interpreter::new(Path::new("C:\\p"));
        let huge = fresh.handle(&result_msg(json!({ "total_cost_usd": 1.0e9 })));
        assert_eq!(turn(&huge).cost_usd, 1.0e9);
        let mut zero = Interpreter::new(Path::new("C:\\p"));
        assert_eq!(
            turn(&zero.handle(&result_msg(json!({ "total_cost_usd": 0 })))).cost_usd,
            0.0
        );
    }

    #[test]
    fn errors_are_trimmed_to_text_and_cut_at_500_chars() {
        let long = "오".repeat(900);
        let out = handle(result_msg(
            json!({ "is_error": true, "errors": [long, 5, null, "short"] }),
        ));
        let t = turn(&out);
        assert_eq!(t.errors.len(), 2);
        assert_eq!(t.errors[0].chars().count(), 501);
        assert_eq!(t.errors[1], "short");
    }

    #[test]
    fn the_resume_not_found_flag_needs_the_exact_cli_sentence_in_errors() {
        let hit = handle(result_msg(
            json!({ "is_error": true, "errors": ["No conversation found with session ID: x"] }),
        ));
        assert!(hit.resume_not_found);
        let miss = handle(result_msg(
            json!({ "is_error": true, "errors": ["no conversation found"] }),
        ));
        assert!(
            !miss.resume_not_found,
            "대소문자가 다르면 아니다 (CLI 문구 그대로만)"
        );
        let in_result_text = handle(result_msg(json!({ "result": "No conversation found" })));
        assert!(!in_result_text.resume_not_found);
    }

    #[test]
    fn control_requests_missing_pieces_are_ignored_or_answered_with_an_error() {
        // request_id 없음 · request 없음 → 답할 방법이 없으니 조용히 무시
        assert_eq!(
            handle(json!({ "type": "control_request" })),
            Interpretation::default()
        );
        assert_eq!(
            handle(json!({ "type": "control_request", "request_id": "r" })),
            Interpretation::default()
        );
        assert_eq!(
            handle(json!({ "type": "control_request", "request": { "subtype": "can_use_tool" } })),
            Interpretation::default()
        );
        assert_eq!(
            handle(json!({ "type": "control_request", "request_id": 7, "request": {} })),
            Interpretation::default()
        );
        // subtype 없음 · 모르는 subtype · 숫자 · request 가 객체가 아님 → CLI 가 기다리지 않게 오류로 답한다
        for request in [
            json!({}),
            json!({ "subtype": "hook_callback" }),
            json!({ "subtype": 5 }),
            json!("x"),
        ] {
            let out = handle(
                json!({ "type": "control_request", "request_id": "r9", "request": request }),
            );
            assert_eq!(out.replies.len(), 1, "{request}");
            let reply: Value = serde_json::from_str(&out.replies[0]).unwrap();
            assert_eq!(reply["response"]["subtype"], "error");
            assert_eq!(reply["response"]["request_id"], "r9");
            assert!(out.new_pending.is_empty());
        }
    }

    #[test]
    fn an_unknown_subtype_is_reported_without_echoing_a_huge_value() {
        let huge = "x".repeat(10_000);
        let out = handle(
            json!({ "type": "control_request", "request_id": "r", "request": { "subtype": huge } }),
        );
        let Some(SessionEvent::Warning { detail, .. }) = out.events.first() else {
            panic!("expected a warning");
        };
        assert!(detail.as_ref().unwrap().chars().count() <= 81);
    }

    #[test]
    fn a_tool_request_with_no_tool_name_or_input_still_makes_a_card_the_user_can_deny() {
        let out = handle(json!({
            "type": "control_request", "request_id": "r1",
            "request": { "subtype": "can_use_tool" }
        }));
        let Some(SessionEvent::PermissionRequest(info)) = out.events.first() else {
            panic!("expected a card");
        };
        assert_eq!(info.tool, "");
        assert_eq!(info.always_rule, None);
        assert_eq!(out.new_pending.len(), 1);
    }

    #[test]
    fn the_same_request_id_twice_is_handed_over_twice_so_the_caller_must_dedupe() {
        // `Interpreter` 는 상태 없이 요청을 건네줄 뿐이다. 같은 ID 가 두 번 오면 둘 다 새 요청으로 나온다 —
        // 세션 쪽 중복 처리는 `tests/session_edge_fake_cli.rs` 가 본다.
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let msg = json!({
            "type": "control_request", "request_id": "dup",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": "ls" } }
        });
        assert_eq!(interp.handle(&msg).new_pending.len(), 1);
        assert_eq!(interp.handle(&msg).new_pending.len(), 1);
    }

    #[test]
    fn questions_with_odd_shapes_are_denied_or_kept_whole() {
        let ask = |input: Value| {
            handle(json!({
                "type": "control_request", "request_id": "q",
                "request": { "subtype": "can_use_tool", "tool_name": ASK_USER_QUESTION, "input": input }
            }))
        };
        for bad in [
            json!({}),
            json!({ "questions": [] }),
            json!({ "questions": "x" }),
            json!({ "questions": [{ "header": "no question text" }] }),
            json!({ "questions": [{ "question": 5 }] }),
            json!({ "questions": [{ "question": "ok" }, 7] }),
        ] {
            let out = ask(bad.clone());
            assert!(out.new_pending.is_empty(), "{bad}");
            assert_eq!(out.replies.len(), 1, "{bad}");
        }
        // 라벨 없는 선택지는 걸러내고 카드는 연다
        let out = ask(
            json!({ "questions": [{ "question": "q?", "options": [{ "label": "A" }, { "description": "no label" }, 3] }] }),
        );
        let Some(SessionEvent::QuestionRequest(info)) = out.events.first() else {
            panic!("expected a question card");
        };
        assert_eq!(info.questions[0].options.len(), 1);
        assert!(!info.questions[0].multi_select);
        let no_options = ask(json!({ "questions": [{ "question": "free text?" }] }));
        assert_eq!(no_options.new_pending.len(), 1);
        // 질문이 5개 이상이어도(CLI 한도 밖) 막지 않고 그대로 전달한다
        let many: Vec<Value> = (0..9)
            .map(|i| json!({ "question": format!("q{i}") }))
            .collect();
        assert_eq!(ask(json!({ "questions": many })).new_pending.len(), 1);
    }

    #[test]
    fn assistant_and_user_messages_with_odd_content_produce_nothing_or_only_what_is_valid() {
        for msg in [
            json!({ "type": "assistant" }),
            json!({ "type": "assistant", "message": 5 }),
            json!({ "type": "assistant", "message": { "content": "plain string" } }),
            json!({ "type": "assistant", "message": { "content": [null, 5, "x", {}] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "text" }, { "type": "text", "text": "" }, { "type": "text", "text": 5 }] } }),
            json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use" }, { "type": "tool_use", "id": "x" }] } }),
            json!({ "type": "user", "message": { "content": "plain" } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result" }] } }),
            json!({ "type": 5 }),
            json!({ "type": null }),
            json!({}),
        ] {
            assert_eq!(handle(msg.clone()), Interpretation::default(), "{msg}");
        }
        let out = handle(json!({
            "type": "user",
            "message": { "content": [{ "type": "tool_result", "tool_use_id": "t", "is_error": "no", "content": [{ "text": "a" }, { "type": "image" }, { "text": "b" }] }] }
        }));
        assert_eq!(
            out.events,
            vec![SessionEvent::ToolResult {
                tool_use_id: "t".into(),
                is_error: false,
                summary: "a\nb".into()
            }]
        );
    }

    #[test]
    fn a_huge_assistant_text_is_passed_whole_but_tool_summaries_are_short() {
        let big = "가".repeat(200_000);
        let out = handle(json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": big },
            { "type": "tool_use", "id": "t", "name": "Bash", "input": { "command": big } }
        ] } }));
        assert!(
            matches!(&out.events[0], SessionEvent::Text { text } if text.chars().count() == 200_000)
        );
        assert!(
            matches!(&out.events[1], SessionEvent::ToolUse { summary, .. } if summary.chars().count() == SUMMARY_CHARS + 1)
        );
    }

    #[test]
    fn system_messages_other_than_init_or_without_a_session_id_start_no_turn() {
        for msg in [
            json!({ "type": "system", "subtype": "init" }),
            json!({ "type": "system", "subtype": "init", "session_id": 5 }),
            json!({ "type": "system", "subtype": "thinking_tokens", "session_id": "s" }),
            json!({ "type": "system" }),
        ] {
            let out = handle(msg.clone());
            assert!(!out.turn_started, "{msg}");
            assert_eq!(out.session_id, None);
        }
        let ok = handle(json!({ "type": "system", "subtype": "init", "session_id": "s-1" }));
        assert!(ok.turn_started);
        assert_eq!(ok.session_id.as_deref(), Some("s-1"));
    }

    #[test]
    fn a_cancel_without_an_id_is_ignored_and_a_cancel_for_an_unknown_id_is_passed_on() {
        assert_eq!(
            handle(json!({ "type": "control_cancel_request" })),
            Interpretation::default()
        );
        assert_eq!(
            handle(json!({ "type": "control_cancel_request", "request_id": 5 })),
            Interpretation::default()
        );
        let out = handle(json!({ "type": "control_cancel_request", "request_id": "never-seen" }));
        assert_eq!(out.cancelled, vec!["never-seen".to_string()]);
    }

    #[test]
    fn rate_limit_events_with_odd_values_keep_what_they_can() {
        let out = handle(json!({ "type": "rate_limit_event", "rate_limit_info": {
            "status": 5, "resetsAt": "soon", "unifiedWindows": { "five_hour": { "utilization": "high" }, "seven_day": 3 }
        } }));
        assert_eq!(
            out.events,
            vec![SessionEvent::RateLimit {
                status: None,
                rate_limit_type: None,
                resets_at: None,
                five_hour_utilization: None,
                seven_day_utilization: None
            }]
        );
        assert_eq!(
            handle(json!({ "type": "rate_limit_event" })),
            Interpretation::default()
        );
    }

    // ───────── 줄 읽기 (parse_line) ─────────

    #[test]
    fn parse_line_tolerates_crlf_and_surrounding_whitespace() {
        assert!(parse_line("{\"a\":1}\r").is_some());
        assert!(parse_line("  \t{\"a\":1}  \r\n").is_some());
        assert!(parse_line("").is_none());
        assert!(parse_line("   ").is_none());
        assert!(parse_line("\r").is_none());
    }

    #[test]
    fn parse_line_refuses_everything_that_is_not_one_json_object() {
        for line in [
            "[]",
            "5",
            "\"x\"",
            "null",
            "true",
            "{",
            "{\"a\":",
            "{\"a\":1}{\"b\":2}",
            "{\"a\":1} trailing",
            "{'a':1}",
            "{\"a\":1,}",
            "\u{0}",
            "{\"a\":\"\u{1}\"}",
        ] {
            assert!(parse_line(line).is_none(), "{line:?}");
        }
    }

    #[test]
    fn parse_line_handles_deep_nesting_without_overflowing_the_stack() {
        // serde_json 은 재귀 깊이 128 에서 오류를 낸다 — 아주 깊은 줄도 패닉 없이 거절한다
        let deep = format!("{}{}{}", "{\"a\":".repeat(5000), "1", "}".repeat(5000));
        assert!(parse_line(&deep).is_none());
        let shallow = format!("{}{}{}", "{\"a\":".repeat(50), "1", "}".repeat(50));
        assert!(parse_line(&shallow).is_some());
    }

    #[test]
    fn parse_line_ignores_a_byte_order_mark_at_the_start() {
        assert!(parse_line("\u{feff}{\"type\":\"system\"}").is_some());
    }

    #[test]
    fn parse_line_accepts_non_ascii_text_and_escaped_surrogates() {
        let value = parse_line("{\"text\":\"안녕 \\u2028 \\ud83d\\ude00 \u{1F600}\"}").unwrap();
        assert!(value["text"].as_str().unwrap().contains('😀'));
    }

    // ───────── 보내는 줄 ─────────

    fn assert_one_plain_line(line: &str) {
        for bad in [
            '\n', '\r', '\u{2028}', '\u{2029}', '\u{85}', '\u{b}', '\u{c}',
        ] {
            assert!(
                !line.contains(bad),
                "{bad:?} 가 날것으로 들어 있다: {line:?}"
            );
        }
        assert!(serde_json::from_str::<Value>(line).is_ok());
    }

    #[test]
    fn every_outgoing_line_survives_awkward_text_as_exactly_one_json_object() {
        let nasty =
            "줄\n바꿈\r\n과 \"따옴표\" \\ 역슬래시 \u{0} \u{1b}[31m 탭\t 이모지😀 ".repeat(3);
        let input = json!({ "q": nasty });
        let mut answers = Map::new();
        answers.insert(nasty.clone(), json!(nasty));
        let rule = json!({ "type": "addRules" });
        for line in [
            user_message_line(&nasty),
            interrupt_line(&nasty),
            allow_response_line(&nasty, &input, Some(&rule)),
            allow_response_line(&nasty, &input, None),
            deny_response_line(&nasty, &nasty, true),
            answer_response_line(&nasty, &json!([{ "question": nasty }]), &answers),
            error_response_line(&nasty, &nasty),
        ] {
            assert_one_plain_line(&line);
        }
    }

    #[test]
    fn user_text_with_unicode_line_separators_is_escaped_so_any_line_reader_keeps_one_line() {
        let line = user_message_line("앞\u{2028}가운데\u{2029}뒤\u{85}끝");
        assert_one_plain_line(&line);
        // 내용은 그대로 돌아온다
        let back: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            back["message"]["content"],
            "앞\u{2028}가운데\u{2029}뒤\u{85}끝"
        );
    }

    #[test]
    fn a_megabyte_message_becomes_one_line_of_about_that_size() {
        let text = "x".repeat(1 << 20);
        let line = user_message_line(&text);
        assert!(line.len() > text.len() && line.len() < text.len() + 200);
        assert!(!line.contains('\n'));
    }

    #[test]
    fn deny_and_answer_lines_have_the_shape_the_cli_was_recorded_to_expect() {
        let deny: Value = serde_json::from_str(&deny_response_line("r", "no", false)).unwrap();
        assert_eq!(
            deny["response"]["response"],
            json!({ "behavior": "deny", "message": "no" })
        );
        let tell: Value = serde_json::from_str(&deny_response_line("r", "no", true)).unwrap();
        assert_eq!(tell["response"]["response"]["interrupt"], true);
        let mut answers = Map::new();
        answers.insert("색?".into(), json!(["파랑", "빨강"]));
        let answer: Value = serde_json::from_str(&answer_response_line(
            "r",
            &json!([{ "question": "색?" }]),
            &answers,
        ))
        .unwrap();
        assert_eq!(
            answer["response"]["response"]["updatedInput"]["answers"]["색?"],
            json!(["파랑", "빨강"])
        );
        assert_eq!(answer["response"]["request_id"], "r");
    }

    #[test]
    fn truncate_chars_counts_characters_and_never_cuts_inside_one() {
        assert_eq!(truncate_chars("", 0), "");
        assert_eq!(truncate_chars("abc", 0), "…");
        assert_eq!(truncate_chars("abc", 3), "abc");
        assert_eq!(truncate_chars("abc", 2), "ab…");
        assert_eq!(truncate_chars("가나다", 2), "가나…");
        assert_eq!(truncate_chars("😀😀😀", 1), "😀…");
    }

    #[test]
    fn tool_summaries_skip_non_string_fields_and_fall_back_to_the_next_key() {
        assert_eq!(
            summarize_tool_input("Bash", Some(&json!({ "command": 5 }))),
            ""
        );
        assert_eq!(
            summarize_tool_input("Other", Some(&json!({ "description": 5, "command": "ls" }))),
            "ls"
        );
        assert_eq!(summarize_tool_input("Bash", Some(&json!(null))), "");
        assert_eq!(summarize_tool_input("Bash", Some(&json!("ls"))), "");
    }
}

/// P3-05 — "항상 허용" 범위 좁히기 (D-45) · 제안 규칙 거르기 · 입력 표시 한계 · 줄 읽기 고침.
#[cfg(test)]
mod fix_tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    fn rule_of(project: &str, tool: &str, input: Value) -> Option<String> {
        always_rule(project, tool, &input, &[]).map(|(info, _)| info.rule)
    }

    fn write_rule(project: &str, file: &str) -> Option<String> {
        rule_of(project, "Write", json!({ "file_path": file }))
    }

    fn suggestion(rules: Value) -> Value {
        json!({ "type": "addRules", "rules": rules, "behavior": "allow", "destination": "localSettings" })
    }

    // ───────── 프로젝트 전체 규칙은 없다 ─────────

    #[test]
    fn no_input_ever_produces_a_rule_that_opens_the_whole_project() {
        let files = [
            "C:\\p\\a.ts",
            "C:\\p\\.env",
            "C:\\p\\src\\a.ts",
            "C:\\p\\src\\",
            "C:\\p\\src\\.",
            "C:\\p\\",
            "C:\\p",
            "C:\\p\\*",
            "C:\\p\\**",
            "C:\\p\\a\\..\\b.ts",
            "C:\\p\\a\\..",
            "C:\\p\\.\\a.ts",
            "C:\\p\\\\a.ts",
            "C:/p/a.ts",
            "\\\\?\\C:\\p\\a.ts",
            "c:\\P\\A.TS",
        ];
        for tool in ["Write", "Edit", "MultiEdit", "NotebookEdit"] {
            for file in files {
                let key = if tool == "NotebookEdit" {
                    "notebook_path"
                } else {
                    "file_path"
                };
                let found = always_rule("C:\\p", tool, &json!({ key: file }), &[]);
                if let Some((info, value)) = found {
                    let content = value["rules"][0]["ruleContent"].as_str().unwrap();
                    for wide in ["/*", "/**", "*", "**", "/", "", "/**/*", "/*/**"] {
                        assert_ne!(content, wide, "{tool} {file}");
                    }
                    assert_ne!(info.rule, "Edit(/*)", "{tool} {file}");
                }
            }
        }
    }

    #[test]
    fn the_scope_names_are_suggested_folder_and_file() {
        for (scope, name) in [
            (AlwaysScope::Suggested, "suggested"),
            (AlwaysScope::Folder, "folder"),
            (AlwaysScope::File, "file"),
        ] {
            assert_eq!(serde_json::to_value(scope).unwrap(), json!(name));
        }
    }

    // ───────── 맨 위 파일 하나 ─────────

    #[test]
    fn a_top_level_file_gets_a_rule_for_that_file_only() {
        for (file, rule) in [
            ("C:\\p\\README.md", "Edit(/README.md)"),
            ("C:\\p\\.gitignore", "Edit(/.gitignore)"),
            ("C:\\p\\My Notes.md", "Edit(/My Notes.md)"),
            ("C:\\p\\메모.txt", "Edit(/메모.txt)"),
            ("C:\\p\\.\\README.md", "Edit(/README.md)"),
            ("C:\\p\\src\\..\\README.md", "Edit(/README.md)"),
        ] {
            assert_eq!(write_rule("C:\\p", file).as_deref(), Some(rule), "{file}");
        }
        let (info, value) = always_rule(
            "C:\\p",
            "Write",
            &json!({ "file_path": "C:\\p\\README.md" }),
            &[],
        )
        .unwrap();
        assert_eq!(info.scope, AlwaysScope::File);
        assert_eq!(info.folder, None);
        assert_eq!(value["rules"][0]["toolName"], "Edit");
        assert_eq!(value["rules"][0]["ruleContent"], "/README.md");
    }

    #[test]
    fn a_top_level_file_name_with_rule_syntax_or_alias_tricks_gets_no_rule() {
        for name in [
            "a*.md",
            "a?.md",
            "a[1].md",
            "a{1}.md",
            "!x.md",
            "a(1).md",
            "a).md",
            "x ",
            "x.",
            "a\tb",
            "a\nb",
            "a:b",
            "a.txt:stream",
            "PROGRA~1",
            "CLAUDE~1",
        ] {
            let file = format!("C:\\p\\{name}");
            assert_eq!(write_rule("C:\\p", &file), None, "{name:?}");
        }
    }

    #[test]
    fn a_path_naming_an_existing_folder_never_gets_a_one_file_rule() {
        let dir = TempDir::new("folder-as-file");
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("real.txt"), b"x").unwrap();
        let ask = |name: &str| {
            let mut interp = Interpreter::new(&dir);
            let out = interp.handle(&json!({
                "type": "control_request", "request_id": "r",
                "request": { "subtype": "can_use_tool", "tool_name": "Write",
                    "input": { "file_path": dir.join(name).display().to_string() } }
            }));
            let Some(SessionEvent::PermissionRequest(info)) = out.events.first() else {
                panic!()
            };
            info.always_rule.clone()
        };
        // 없는 파일과 있는 파일은 그 파일 하나, 있는 폴더는 (이름만 있는 규칙이 폴더 아래 전부가 되므로) 규칙 없음
        assert_eq!(
            ask("new.txt").map(|r| r.rule),
            Some("Edit(/new.txt)".to_string())
        );
        assert_eq!(
            ask("real.txt").map(|r| r.rule),
            Some("Edit(/real.txt)".to_string())
        );
        assert_eq!(ask("sub"), None);
    }

    // ───────── 설정 · 훅 폴더 ─────────

    #[test]
    fn nothing_under_or_naming_a_settings_or_hook_folder_gets_a_rule() {
        let names = [
            ".claude",
            ".git",
            ".githooks",
            ".husky",
            ".vscode",
            ".idea",
            ".github",
            ".gitlab",
            ".circleci",
            ".devcontainer",
            ".cargo",
        ];
        for name in names {
            for spelling in [
                name.to_string(),
                name.to_ascii_uppercase(),
                format!("{name}."),
                format!("{name}.."),
            ] {
                for file in [
                    format!("C:\\p\\{spelling}\\settings.local.json"),
                    format!("C:\\p\\{spelling}\\sub\\deeper\\x.json"),
                    format!("C:\\p\\src\\{spelling}\\x"),
                    format!("C:\\p\\{spelling}"),
                    format!("C:\\p\\{spelling}\\"),
                    format!("C:/p/{spelling}/x"),
                    format!("C:\\p\\a\\..\\{spelling}\\x"),
                ] {
                    assert_eq!(write_rule("C:\\p", &file), None, "{file}");
                }
            }
        }
    }

    #[test]
    fn well_known_config_files_at_the_top_get_no_rule_but_similar_names_do() {
        for file in ["C:\\p\\.mcp.json", "C:\\p\\.MCP.JSON", "C:\\p\\.envrc"] {
            assert_eq!(write_rule("C:\\p", file), None, "{file}");
        }
        for (file, rule) in [
            ("C:\\p\\mcp.json", "Edit(/mcp.json)"),
            ("C:\\p\\.gitignore", "Edit(/.gitignore)"),
            ("C:\\p\\.github-notes.md", "Edit(/.github-notes.md)"),
            ("C:\\p\\src\\.gitkeep", "Edit(/src/**)"),
            ("C:\\p\\docs\\claude\\a.md", "Edit(/docs/claude/**)"),
        ] {
            assert_eq!(write_rule("C:\\p", file).as_deref(), Some(rule), "{file}");
        }
    }

    #[test]
    fn eight_dot_three_short_names_and_stream_names_in_folders_are_refused() {
        for file in [
            "C:\\p\\CLAUDE~1\\settings.local.json",
            "C:\\p\\src\\GIT~1\\x",
            "C:\\p\\a:b\\x",
            "C:\\p\\a\\b::$DATA\\x",
        ] {
            assert_eq!(write_rule("C:\\p", file), None, "{file}");
        }
    }

    #[test]
    fn the_project_folder_itself_may_sit_inside_a_hidden_folder() {
        // 규칙은 프로젝트 기준 상대 경로만 보므로 프로젝트 위쪽 이름은 상관없다
        assert_eq!(
            write_rule("C:\\u\\.config\\app", "C:\\u\\.config\\app\\src\\a.ts").as_deref(),
            Some("Edit(/src/**)")
        );
        assert_eq!(
            write_rule("C:\\u\\.git\\app", "C:\\u\\.git\\app\\a.ts").as_deref(),
            Some("Edit(/a.ts)")
        );
    }

    // ───────── CLI 제안 규칙 ─────────

    #[test]
    fn a_suggestion_for_another_tool_is_not_used() {
        let read = suggestion(json!([{ "toolName": "Read", "ruleContent": "/secret/**" }]));
        assert_eq!(always_rule("C:\\p", "Bash", &json!({}), &[read]), None);
        let bash = suggestion(json!([{ "toolName": "Bash", "ruleContent": "ls *" }]));
        assert_eq!(always_rule("C:\\p", "WebFetch", &json!({}), &[bash]), None);
        // 같은 요청에 다른 도구 규칙이 하나라도 섞이면 통째로 안 쓴다
        let mixed = suggestion(json!([
            { "toolName": "Bash", "ruleContent": "ls *" },
            { "toolName": "PowerShell", "ruleContent": "ls *" }
        ]));
        assert_eq!(always_rule("C:\\p", "Bash", &json!({}), &[mixed]), None);
    }

    #[test]
    fn a_rule_of_only_stars_or_empty_is_refused_for_every_tool() {
        for tool in ["Bash", "PowerShell", "WebFetch", "Read", "Edit", "Write"] {
            for content in ["", " ", "*", "**", " * ", "/*", "/**", "**/*", ":*"] {
                let broad = suggestion(json!([{ "toolName": tool, "ruleContent": content }]));
                assert_eq!(
                    always_rule("C:\\p", tool, &json!({}), &[broad]),
                    None,
                    "{tool} {content:?}"
                );
            }
            let without = suggestion(json!([{ "toolName": tool }]));
            assert_eq!(
                always_rule("C:\\p", tool, &json!({}), &[without]),
                None,
                "{tool}"
            );
        }
    }

    #[test]
    fn narrow_rules_for_the_requested_tool_are_used_for_web_and_read_tools_too() {
        let web =
            suggestion(json!([{ "toolName": "WebFetch", "ruleContent": "domain:example.com" }]));
        let (info, _) = always_rule("C:\\p", "WebFetch", &json!({}), &[web]).unwrap();
        assert_eq!(info.rule, "WebFetch(domain:example.com)");
        let star_in_the_middle =
            suggestion(json!([{ "toolName": "Bash", "ruleContent": "git * --help" }]));
        assert!(always_rule("C:\\p", "Bash", &json!({}), &[star_in_the_middle]).is_some());
    }

    #[test]
    fn a_bare_mcp_tool_rule_is_used_only_for_that_exact_tool() {
        let rule = |name: &str| suggestion(json!([{ "toolName": name }]));
        let tool = "mcp__files__read";
        let (info, sent) = always_rule("C:\\p", tool, &json!({}), &[rule(tool)]).unwrap();
        assert_eq!(info.rule, tool);
        assert_eq!(sent["rules"], json!([{ "toolName": tool }]));
        // 서버 전체 · 다른 도구 · 같은 서버의 다른 도구는 안 쓴다
        for other in [
            "mcp__files",
            "mcp__files__write",
            "mcp__other__read",
            "Bash",
        ] {
            assert_eq!(
                always_rule("C:\\p", tool, &json!({}), &[rule(other)]),
                None,
                "{other}"
            );
        }
    }

    #[test]
    fn only_the_known_fields_of_a_suggestion_are_sent_back() {
        let given = json!({
            "type": "addRules",
            "behavior": "allow",
            "destination": "localSettings",
            "unexpected": { "mode": "bypassPermissions" },
            "rules": [
                { "toolName": "Bash", "ruleContent": "ls *", "also": true }
            ],
            "setMode": "bypassPermissions"
        });
        let (info, sent) = always_rule("C:\\p", "Bash", &json!({}), &[given]).unwrap();
        assert_eq!(info.rule, "Bash(ls *)");
        assert_eq!(
            sent,
            json!({
                "type": "addRules",
                "rules": [{ "toolName": "Bash", "ruleContent": "ls *" }],
                "behavior": "allow",
                "destination": "localSettings"
            })
        );
    }

    // ───────── 도구 입력 표시 한계 ─────────

    #[test]
    fn small_inputs_are_shown_as_they_are() {
        let input =
            json!({ "command": "ls", "list": [1, 2, 3], "nested": { "a": "b", "n": null } });
        assert_eq!(display_input(&input), input);
        assert_eq!(display_input(&json!(null)), json!(null));
        assert_eq!(display_input(&json!("x")), json!("x"));
    }

    #[test]
    fn long_strings_and_lists_are_cut_for_display() {
        let long = "가".repeat(30_000);
        let shown =
            display_input(&json!({ "content": long, "items": (0..500).collect::<Vec<_>>() }));
        let content = shown["content"].as_str().unwrap();
        assert_eq!(content.chars().count(), INPUT_STRING_CHARS + 1);
        assert!(content.ends_with('…'));
        let items = shown["items"].as_array().unwrap();
        assert_eq!(items.len(), INPUT_ARRAY_ITEMS + 1);
        assert_eq!(items.last().unwrap(), &json!("…"));
    }

    #[test]
    fn an_input_that_is_still_huge_after_cutting_becomes_a_short_text() {
        let many: serde_json::Map<String, Value> = (0..5000)
            .map(|i| (format!("key{i}"), json!("v".repeat(100))))
            .collect();
        let shown = display_input(&Value::Object(many));
        let text = shown.as_str().expect("a short text");
        assert!(text.chars().count() <= INPUT_STRING_CHARS + 1);
    }

    #[test]
    fn the_card_gets_the_cut_input_but_the_pending_request_keeps_the_original_for_allow() {
        let big = "x".repeat(1 << 20);
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let out = interp.handle(&json!({
            "type": "control_request", "request_id": "r1",
            "request": { "subtype": "can_use_tool", "tool_name": "Write",
                "input": { "file_path": "C:\\p\\src\\a.ts", "content": big } }
        }));
        let Some(SessionEvent::PermissionRequest(info)) = out.events.first() else {
            panic!()
        };
        assert!(info.input["content"].as_str().unwrap().chars().count() <= INPUT_STRING_CHARS + 1);
        assert!(serde_json::to_string(&out.events[0]).unwrap().len() < 20_000);
        let (_, pending) = &out.new_pending[0];
        let PendingKind::Permission { input, .. } = &pending.kind else {
            panic!()
        };
        assert_eq!(input["content"].as_str().unwrap().len(), 1 << 20);
        // 허용하면 CLI 에는 잘리지 않은 원본이 돌아간다
        let line = allow_response_line("r1", input, None);
        assert!(line.len() > 1 << 20);
        // 카드에 보이는 경로 · 요약은 그대로
        assert_eq!(info.path.as_deref(), Some("C:\\p\\src\\a.ts"));
    }

    #[test]
    fn a_huge_command_is_cut_on_the_card_with_a_mark_but_allow_still_sends_the_whole_command() {
        let command = format!("echo {}", "y".repeat(200_000));
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let out = interp.handle(&json!({
            "type": "control_request", "request_id": "r",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": { "command": command } }
        }));
        let Some(SessionEvent::PermissionRequest(info)) = out.events.first() else {
            panic!()
        };
        let shown = info.command.as_deref().unwrap();
        assert_eq!(shown.chars().count(), INPUT_STRING_CHARS + 1);
        assert!(shown.ends_with('…'));
        let PendingKind::Permission { input, .. } = &out.new_pending[0].1.kind else {
            panic!()
        };
        assert_eq!(input["command"].as_str().unwrap().len(), command.len());
    }

    // ───────── 줄 읽기 · 보내기 ─────────

    #[test]
    fn a_byte_order_mark_is_ignored_only_at_the_very_start() {
        let value = parse_line("\u{feff}{\"type\":\"system\"}").unwrap();
        assert_eq!(value["type"], "system");
        assert!(parse_line("\u{feff}\u{feff}  {\"a\":1}").is_some());
        assert!(parse_line("{\"a\":1}\u{feff}").is_none());
        assert!(parse_line("\u{feff}").is_none());
    }

    #[test]
    fn a_line_starting_with_a_byte_order_mark_still_starts_the_turn() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        let msg =
            parse_line("\u{feff}{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}")
                .unwrap();
        let out = interp.handle(&msg);
        assert!(out.turn_started);
        assert_eq!(out.session_id.as_deref(), Some("s1"));
    }

    #[test]
    fn unicode_line_separators_are_escaped_in_every_outgoing_line_and_decode_back() {
        let nasty = "앞\u{2028}가운데\u{2029}뒤\u{85}끝 \\u2028 그대로";
        let mut answers = Map::new();
        answers.insert(nasty.into(), json!([nasty]));
        for line in [
            user_message_line(nasty),
            interrupt_line(nasty),
            allow_response_line(nasty, &json!({ "q": nasty }), None),
            deny_response_line(nasty, nasty, true),
            answer_response_line(nasty, &json!([{ "question": nasty }]), &answers),
            error_response_line(nasty, nasty),
        ] {
            for raw in ['\u{2028}', '\u{2029}', '\u{85}', '\n', '\r'] {
                assert!(!line.contains(raw), "{raw:?} in {line:?}");
            }
            let back: Value = serde_json::from_str(&line).unwrap();
            let text = back.to_string();
            assert!(text.contains('\u{2028}') && text.contains('\u{85}'));
        }
        // 글자 그대로 `\u2028` 이라고 쓴 글(역슬래시)은 그대로 남는다
        let back: Value = serde_json::from_str(&user_message_line("\\u2028")).unwrap();
        assert_eq!(back["message"]["content"], "\\u2028");
    }

    // ───────── 한도 상태 ─────────

    fn rejected() -> Value {
        json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "rejected" } })
    }

    fn error_result(extra: Value) -> Value {
        let mut base =
            json!({ "type": "result", "subtype": "success", "is_error": true, "result": "x" });
        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        base
    }

    fn outcome(out: &Interpretation) -> TurnOutcome {
        let Some(SessionEvent::TurnEnded(turn)) = out.events.last() else {
            panic!()
        };
        turn.outcome
    }

    #[test]
    fn the_limit_state_belongs_to_one_turn_even_without_a_new_init() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        interp.handle(&rejected());
        assert_eq!(
            outcome(&interp.handle(&error_result(json!({})))),
            TurnOutcome::Limit
        );
        // init 이 없어도 (한 번 쓴 한도 상태는 지운다) 다음 오류는 한도가 아니다
        assert_eq!(
            outcome(&interp.handle(&error_result(json!({ "api_error_status": 500 })))),
            TurnOutcome::Error
        );
    }

    #[test]
    fn a_new_turn_clears_a_limit_state_that_was_never_followed_by_a_result() {
        let mut interp = Interpreter::new(Path::new("C:\\p"));
        interp.handle(&rejected());
        // 결과 없이 프로세스 안에서 다음 턴이 시작됐다
        interp.handle(&json!({ "type": "system", "subtype": "init", "session_id": "s" }));
        assert_eq!(
            outcome(&interp.handle(&error_result(json!({ "api_error_status": 500 })))),
            TurnOutcome::Error
        );
        // 같은 턴 안에서 init 다음에 온 거절은 그 턴에 적용된다
        interp.handle(&json!({ "type": "system", "subtype": "init", "session_id": "s" }));
        interp.handle(&rejected());
        assert_eq!(
            outcome(&interp.handle(&error_result(json!({})))),
            TurnOutcome::Limit
        );
    }
}
