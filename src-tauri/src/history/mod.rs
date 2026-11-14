//! 채팅 기록 · 세션 츄르 (P6-03) — 앱이 돌린 세션의 이벤트를 앱 DB 에 쌓고, 다시 켜도 채팅이 그대로 보이게 읽고, 턴마다의 토큰 · 비용을 합한다.
//!
//! 결정: D-20 (앱 자체 데이터는 앱 DB) · D-24 (토큰 · 비용은 앱이 돌린 세션의 `result` 만 쌓는다 — `~/.claude/projects` 의 CLI 기록 파일은 읽지 않는다,
//! 구독자에게는 "참고용 추정") · D-44 (`TurnSummary.cost_usd` 가 이미 턴 몫) · D-47 (화면은 프로젝트 번호로만).
//!
//! - `record` — 이벤트 → 저장할 한 줄 (고르기 · 긴 글 자르기)
//! - `chat` — `chat_items` 표의 쓰기 · 읽기 · 오래된 것 지우기 · 요청 카드의 상태(답함 · 취소 · 기다림 · 지나감)
//! - `usage` — `usage_turns` 표의 쓰기 · 합 · "오늘" 의 시작 (이 PC 의 자정)
//! - `writer` — 배경 쓰기 스레드 (이벤트를 보내는 스레드는 큐에 넣기만 한다)
//! - `commands` — Tauri 명령 (얇게)
//!
//! 기록은 **앱이 받은 이벤트에서만** 만든다 — 저장하는 것은 화면으로 가는 이벤트의 JSON 그대로(긴 글만 잘림)라서, 화면은 실시간 이벤트와 같은 모양으로 기록을 읽는다.
//! 원본 출력(`RawLog`) · 도구 결과 원문은 저장하지 않는다.

pub mod chat;
pub mod commands;
pub mod record;
pub mod usage;
pub mod writer;

use std::time::Duration;

use crate::claude::session::SessionManager;
use crate::db::AppDb;
use crate::error::AppError;
use crate::projects::store as projects_store;

pub use chat::{ChatEntry, ChatPage, LiveRequests, RequestState, RequestStatus};
pub use usage::{LiveRun, ProjectUsage, SessionUsage, UsageSum, UsageSummary};
pub use writer::Recorder;

/// 기록 한도 — 값은 작업자 판단 (`P6-03` 보고). 시험에서 바꿔 쓸 수 있게 묶었다.
#[derive(Debug, Clone)]
pub struct Limits {
    /// 프로젝트마다 남기는 채팅 항목 수. 넘치면 오래된 것부터 지운다 (쓸 때마다 확인).
    /// 도구 사용 한 번도 한 항목이라 세션 몇 개 분량이다 — 항목 평균 0.5KB 로 프로젝트당 5MB 안팎.
    pub max_items_per_project: usize,
    /// 항목 하나의 긴 글(사용자 메시지 · 오케스트레이터 글 · 사용자의 답)을 자르는 글자 수. 잘리면 `…` 가 붙고 항목에 `truncated` 표시.
    pub max_text_chars: usize,
    /// 사용량 줄(`usage_turns`)을 보관하는 기간(초). 턴이 끝나 줄을 쓸 때 그 줄의 시각보다 이만큼 더 오래된 줄을 지운다 (`usage::KEEP_SECS` 90일 — 근거는 거기).
    pub usage_keep_secs: i64,
    /// 쓰기를 기다리는 항목 수의 상한. DB 가 오래 막혀도 메모리가 불어나지 않게 — 넘으면 새 항목을 버리고 로그에 남긴다.
    pub max_queued: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_items_per_project: 10_000,
            max_text_chars: 8_000,
            usage_keep_secs: usage::KEEP_SECS,
            max_queued: 5_000,
        }
    }
}

/// 이벤트 하나를 기록할 때 같이 남는 것 — 보내는 스레드가 이벤트를 낸 순간에 채운다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordCtx {
    pub project_id: i64,
    /// 앱이 세션 프로세스를 띄운 때(밀리초) — 앱 실행마다 겹치지 않는다
    pub run_id: i64,
    /// CLI 세션 ID (아직 모르면 `None` — 곧 `Bind` 로 채워진다)
    pub session_id: Option<String>,
    /// 유닉스 시각(초)
    pub at: i64,
    /// 이 턴의 `TurnStarted.apiKeySource` (`none` = 구독)
    pub api_key_source: Option<String>,
}

/// 기록을 읽기 전에 쓰고 있는 것이 끝나기를 기다리는 시간
pub const FLUSH_WAIT: Duration = Duration::from_secs(3);

/// 채팅 기록 쪽 하나의 최대 크기 (명령이 거꾸로 너무 많이 읽지 않게)
pub const MAX_PAGE: u32 = 200;

/// `project_chat_history` — 프로젝트의 채팅 기록을 최근 것부터 쪽 단위로. `before` 는 이미 가진 가장 오래된 항목의 번호(`id`) — 없으면 가장 최근부터.
/// 쪽 안에서는 오래된 것이 앞이다 (화면이 위에 이어 붙인다). 등록된 프로젝트가 아니면 `project_not_found`.
/// 읽기 전에 쓰는 중인 것을 먼저 기다린다. 지금 살아 있는 세션이 기다리는 요청만 `pending`, 답 없이 지나간 카드는 `expired`.
pub fn chat_history(
    db: &AppDb,
    manager: &SessionManager,
    project_id: i64,
    before: Option<i64>,
    limit: u32,
) -> Result<ChatPage, AppError> {
    if limit == 0 {
        return Err(AppError::InvalidInput("limit must be at least 1".into()));
    }
    let limit = limit.min(MAX_PAGE) as usize;
    db.read(|conn| projects_store::get(conn, project_id))?
        .ok_or(AppError::ProjectNotFound(project_id))?;
    manager.flush_history(FLUSH_WAIT);
    let live = manager.live_requests();
    db.read(|conn| chat::read_page(conn, project_id, before, limit, live.as_ref()))
}

/// `app_usage_summary` — 오늘(이 PC 의 자정부터) 앱이 쓴 합 · 프로젝트별 합 · 지금 돌고 있는 세션의 이번 실행 합.
pub fn usage_summary(db: &AppDb, manager: &SessionManager) -> Result<UsageSummary, AppError> {
    manager.flush_history(FLUSH_WAIT);
    let live = manager.live_run();
    let since = usage::local_day_start(usage::now_secs());
    db.read(|conn| usage::summarize(conn, since, live.as_ref()))
}
