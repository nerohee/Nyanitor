//! 화면으로 가는 값의 모양 (serde camelCase) — `src/lib/ipc-types.ts` 의 `Custom*` 타입과 같이 맞춘다 (`ipc-contract.test.ts` 가 필드 이름을 비교한다).
//!
//! 화면으로 가는 값에 경로는 없다 (표시용 상대 파일 이름 `agents/x.md` 뿐 — 다시 받지 않는다). 상태 때문에 안 되는 일은 오류가 아니라 결과의 `outcome` · `reason` 이다
//! (화면이 문구를 고른다). 오류(`AppError`)는 화면이 보낸 값의 모양이 틀렸거나(`invalid_input`) 파일을 쓰지 못했을 때(`file_write_failed`) · 잠겨 있을 때(`harness_busy`) 등이다.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::agents::AgentRole;
use crate::harness::script::ScriptResult;

use super::id::ItemKind;

// ───────────────────────────── 목록 · 항목 하나 ─────────────────────────────

/// 이 파일에 내가 한 것 — 값 바꿈 · 덧붙임 · 통째 · 내가 만든 파일 (값과 덧붙임은 함께일 수 있다). 화면 시제품의 `marks` 와 같다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mark {
    Values,
    Append,
    Replace,
    Mine,
}

/// 읽을 수 없는 이유 (D-22 — 그 항목만 "읽을 수 없음", 나머지는 그대로)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnreadableReason {
    /// 256KB 를 넘는다
    TooLarge,
    ReadFailed,
    NotUtf8,
    /// 첫 줄이 `---` 가 아니다
    NoFrontmatter,
    /// 닫는 `---` 가 없다
    UnclosedFrontmatter,
    /// 내가 만든 에이전트의 둘째 줄이 `name: <이름>` 이 아니다 (설치가 `invalidAgent` 로 멈춘다)
    NameMismatch,
    /// 값 파일이 설치 스크립트가 받아들이는 모양이 아니다
    BadValues,
    /// `.origin` 파일이 해시(16진수 64글자) 모양이 아니다
    BadOrigin,
    /// 내 수정 폴더 안에 링크가 있다
    LinkInCustom,
    /// 값 · 덧붙임만 남고 고칠 원본 파일이 없다 (원본에서 사라졌다)
    TargetGone,
    /// 하네스 설정(`custom/config.local.json`)이 JSON 객체가 아니다
    BadConfig,
}

/// 목록의 항목 하나 (읽을 수 있는 것)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    /// `main` · `agent:<이름>` · `skill:<이름>` — 화면이 다시 보내는 것은 이것뿐이다
    pub id: String,
    pub kind: ItemKind,
    pub name: String,
    pub description: Option<String>,
    /// 표시용 상대 파일 이름 (`agents/harness-builder-ui.md` · 오케스트레이터는 `config.local.json`) — 다시 받지 않는다
    pub file: String,
    /// 원본 값 (없으면 `null`). 내가 만든 것은 그 파일 자신의 앞머리 값
    pub model: Option<String>,
    pub effort: Option<String>,
    /// 내 값 (`values.yml` 의 것 · 오케스트레이터는 `custom/config.local.json` 의 `planner` 중 원본과 다른 것)
    pub my_model: Option<String>,
    pub my_effort: Option<String>,
    /// 지금 쓰이는 값 (내 값 → 원본 값. 오케스트레이터는 설치 스크립트와 같은 순서로 처음 찾은 설정의 `planner`)
    pub current_model: Option<String>,
    pub current_effort: Option<String>,
    pub marks: Vec<Mark>,
    /// 통째 바꾼(`.origin` 이 있는) 것만: `true` (원본 해시가 다름 · 원본에서 사라짐) · `false` · `null` (`.origin` 없음)
    pub origin_changed: Option<bool>,
}

/// 목록의 읽을 수 없는 항목
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemUnreadable {
    pub id: String,
    pub kind: ItemKind,
    pub name: String,
    pub file: String,
    pub reason: UnreadableReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ListEntry {
    Ok(ItemInfo),
    Unreadable(ItemUnreadable),
}

/// 기록(로컬 git)의 상태
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HistoryState {
    Ok,
    /// 이 PC 에 git 이 없다 — 저장 · 적용은 되고 기록만 없다 (오류 아님)
    NoGit,
    /// 아직 기록을 시작하지 않았다 (처음 저장할 때 시작한다) — 적용 안 한 것도 없다
    NotStarted,
    /// git 을 부르지 못했다 (`detail`)
    Failed,
}

/// 적용 안 한 파일 하나
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnappliedFile {
    /// 내 수정 폴더 기준 상대 경로 (표시용)
    pub path: String,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Changed,
    Removed,
}

/// 적용 안 한 것 = 커밋 안 된 변경 (새 파일 포함)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Unapplied {
    /// 알 수 있는가 (git 이 없거나 부르지 못했으면 `false` — 이때 적용은 늘 설치만 한다)
    pub known: bool,
    pub count: u32,
    /// 앞 `UNAPPLIED_FILES_MAX` 개까지
    pub files: Vec<UnappliedFile>,
}

impl Unapplied {
    pub fn unknown() -> Self {
        Self {
            known: false,
            count: 0,
            files: Vec::new(),
        }
    }

    pub fn none() -> Self {
        Self {
            known: true,
            count: 0,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryInfo {
    pub state: HistoryState,
    /// `Failed` 일 때 진단용 글 (주소 · 계정 정보 없음)
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomList {
    /// 원본 폴더가 있는가 — 없으면 `false` + `reason: "no_source"` (오류 아님, 목록은 비었다)
    pub available: bool,
    pub reason: Option<String>,
    /// 개발자 모드 (다른 원본을 쓰는 중)
    pub developer_mode: bool,
    pub history: HistoryInfo,
    pub unapplied: Unapplied,
    /// 오케스트레이터가 맨 앞, 그 뒤는 에이전트 · 스킬 (이름 순)
    pub items: Vec<ListEntry>,
    /// 하네스 작업자 이름 → 역할 (설정의 `agents` — 설치 전에도 있다)
    pub roles: BTreeMap<String, AgentRole>,
}

/// 글 한 덩이 (원본 글 · 덧붙임 글 · 통째 글)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TextPart {
    Absent,
    Text { text: String },
    TooLarge,
    Unreadable { reason: UnreadableReason },
}

/// 항목 하나 읽기 — 비교(원본 글 ↔ 내 통째 글)는 화면이 두 글로 한다
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub info: ItemInfo,
    /// 원본 글 (읽기 전용). 오케스트레이터 · 내가 만든 것은 없다
    pub origin_text: TextPart,
    /// 덧붙임 글 (`*.append.md`)
    pub append_text: TextPart,
    /// 통째 글 — 원본을 통째로 바꿨으면 그 글, 내가 만든 것이면 그 파일의 글
    pub replace_text: TextPart,
    /// 원본에서 파일이 사라졌다 (`.origin` 만 남음)
    pub origin_gone: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ItemRead {
    Ok(Box<ItemDetail>),
    Unreadable(ItemUnreadable),
    NotFound,
}

// ───────────────────────────── 쓰기 ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WriteOutcome {
    /// 쓰거나 지웠다 (`changed` 가 `false` 면 이미 그 모양이었다)
    Saved,
    /// 하지 않았다 (`reason`)
    Refused,
}

/// 저장 · 지움 · 새로 만들기 · 원본 바뀜 고르기의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub outcome: WriteOutcome,
    /// `Refused` 의 이유 (snake_case 짧은 이름 — 화면이 문구를 고른다). `no_source` · `not_found` · `link_in_path` · `too_large` · `bad_values` · `bad_config` ·
    /// `bad_frontmatter` · `invalid_agent` · `name_in_source` · `name_taken` · `not_mine` · `not_replaced` · `already_replaced` · `no_origin_file` · `not_supported` · `no_origin`
    pub reason: Option<String>,
    /// 거절의 진단용 글 (둘째 줄 `name` 이 다르다 등)
    pub detail: Option<String>,
    /// 실제로 파일이 바뀌었는가
    pub changed: bool,
    /// 새로 만들기: `~/.claude` 에 사용자 자신의 같은 이름 파일이 이미 있다 (설치가 `skip notOurs` 한다)
    pub not_ours: bool,
}

impl WriteResult {
    pub fn saved(changed: bool) -> Self {
        Self {
            outcome: WriteOutcome::Saved,
            reason: None,
            detail: None,
            changed,
            not_ours: false,
        }
    }

    pub fn refused(reason: &str) -> Self {
        Self {
            outcome: WriteOutcome::Refused,
            reason: Some(reason.to_string()),
            detail: None,
            changed: false,
            not_ours: false,
        }
    }

    pub fn refused_with(reason: &str, detail: impl Into<String>) -> Self {
        Self {
            detail: Some(detail.into()),
            ..Self::refused(reason)
        }
    }
}

// ───────────────────────────── 기록 · 적용 ─────────────────────────────

/// 줄 하나의 차이 — 화면 시제품(`DiffLine`)과 같은 모양
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DiffLine {
    /// `" "` 그대로 · `"+"` 더함 · `"-"` 뺌 · `"@"` 위치 표시
    pub sign: char,
    pub text: String,
    /// 옛 파일 · 새 파일 줄 번호
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub status: FileStatus,
    /// 글이 아니라서(바이너리) · 너무 커서 줄 차이를 못 준다
    pub binary: bool,
    pub lines: Vec<DiffLine>,
    /// 줄 수 상한 때문에 뒤를 잘랐다
    pub truncated: bool,
    /// 더한 줄 · 뺀 줄 수 (잘리기 전의 전체)
    pub added: u32,
    pub removed: u32,
}

/// 적용하면 바뀌는 것 (적용 안 한 것의 줄 단위 차이)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangesList {
    pub state: HistoryState,
    pub detail: Option<String>,
    pub files: Vec<FileDiff>,
    /// 파일 수 상한 때문에 뒤를 뺐다
    pub files_total: u32,
}

/// 커밋 종류 — 커밋 메시지 끝 표시 줄(`Nyanitor-Kind: <종류>`)로 알아본다. 앱이 만들지 않은 커밋은 `other`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitKind {
    /// 적용
    Apply,
    /// 새 에이전트 · 스킬을 만들어 넣은 적용
    New,
    /// 어느 때로 되돌림
    Restore,
    /// 원본 업데이트 받음 (빈 커밋)
    OriginUpdate,
    /// 고양이 연결
    Cats,
    /// 보이는 이름
    Labels,
    /// 처음 기록
    Start,
    Other,
}

impl CommitKind {
    /// 커밋 메시지 끝 표시 줄에 쓰는 글
    pub fn marker(self) -> &'static str {
        match self {
            CommitKind::Apply => "apply",
            CommitKind::New => "new",
            CommitKind::Restore => "restore",
            CommitKind::OriginUpdate => "origin_update",
            CommitKind::Cats => "cats",
            CommitKind::Labels => "labels",
            CommitKind::Start => "start",
            CommitKind::Other => "other",
        }
    }

    pub fn from_marker(text: &str) -> Self {
        [
            CommitKind::Apply,
            CommitKind::New,
            CommitKind::Restore,
            CommitKind::OriginUpdate,
            CommitKind::Cats,
            CommitKind::Labels,
            CommitKind::Start,
        ]
        .into_iter()
        .find(|kind| kind.marker() == text.trim())
        .unwrap_or(CommitKind::Other)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    /// 전체 번호 (40글자) — 화면은 이것이나 `short` 를 다시 보낸다
    pub hash: String,
    /// 짧은 번호 (7글자)
    pub short: String,
    /// 커밋한 때 (ISO 8601, 시간대 포함)
    pub date: String,
    /// 메시지 첫 줄
    pub message: String,
    pub kind: CommitKind,
    /// 바뀐 파일 (상한까지)
    pub files: Vec<String>,
    pub files_total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryList {
    pub state: HistoryState,
    pub detail: Option<String>,
    /// 최신이 먼저
    pub commits: Vec<CommitEntry>,
    /// 상한을 넘어 오래된 것을 뺐다
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CommitDiff {
    Ok {
        commit: CommitEntry,
        files: Vec<FileDiff>,
        files_total: u32,
    },
    /// 그런 커밋이 없다
    UnknownCommit,
    NoGit,
    NotStarted,
    Failed {
        detail: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscardOutcome {
    Discarded,
    /// 버릴 것이 없었다
    Nothing,
    NoGit,
    NotStarted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardResult {
    pub outcome: DiscardOutcome,
    /// 버린 파일 수
    pub files: u32,
}

/// 적용(또는 되돌리기)의 기록(커밋) 쪽 결과
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommitOutcome {
    /// 커밋을 만들었다
    Committed,
    /// git 이 없어 기록하지 않았다 (설치는 됐다)
    NoGit,
    /// 설치는 됐는데 커밋하지 못했다 — 적용 안 한 것으로 남는다 (`detail`)
    Failed,
    /// 설치하지 않아서 커밋도 없다
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// 설치가 성공했다 (`commit` 에 기록 결과)
    Applied,
    /// 적용 안 한 것이 없어 설치하지 않았다
    Nothing,
    /// 설치가 실패했다 (`script` 그대로) — 커밋하지 않았고 적용 안 한 것으로 남는다
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub outcome: ApplyOutcome,
    /// 설치를 돌렸으면 그 결과 (`ScriptResult` 그대로 — 설치 화면과 같은 모양)
    pub script: Option<ScriptResult>,
    pub commit: CommitOutcome,
    /// 만든 커밋의 짧은 번호
    pub commit_short: Option<String>,
    /// 적용한(하려던) 파일 수
    pub files: u32,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreOutcome {
    /// 그때 모습으로 되돌려 설치했고 새 커밋을 만들었다 (`commit` 에 기록 결과)
    Restored,
    /// 적용 안 한 것이 있어 하지 않았다 — 먼저 적용하거나 버려야 한다
    HasUnapplied,
    /// 그런 커밋이 없다
    UnknownCommit,
    /// 그 커밋의 모습이 지금과 같다 — 할 것이 없다
    SameAsNow,
    NoGit,
    NotStarted,
    /// 설치가 실패했다 — 작업 트리를 처음(HEAD) 모습으로 되돌려 놓았다 (`script` 그대로)
    Failed,
    /// 설치가 실패했는데 작업 트리를 되돌려 놓지도 못했다 (`detail`) — 적용 안 한 것으로 보인다
    RollbackFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub outcome: RestoreOutcome,
    pub script: Option<ScriptResult>,
    pub commit: CommitOutcome,
    pub commit_short: Option<String>,
    pub detail: Option<String>,
}

// ───────────────────────────── 고양이 연결 ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatsState {
    Ok,
    /// `custom/agent-cats.json` 이 아직 없다 (화면 기본 연결을 쓴다)
    Absent,
    /// 있는데 읽을 수 없다 (깨진 JSON · 객체가 아님 · 너무 큼)
    Unreadable,
}

/// 고양이 연결 — 키 = 에이전트 이름(또는 `main`), 값 = 고양이 id. 파일에 적힌 것만 (기본 연결은 화면이 안다).
/// 보이는 이름(`custom/agent-labels.json`)도 같은 모양으로 읽는다 — 키 = 에이전트 이름, 값 = 보이는 이름.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatsRead {
    pub state: CatsState,
    pub agents: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatsWriteResult {
    pub outcome: WriteOutcome,
    /// `Refused` 의 이유: `unreadable` (파일이 깨져 있다) · `too_large` · `link_in_path` · `bad_label` (보이는 이름이 규칙에 어긋난다 — 보이는 이름 쓰기만)
    pub reason: Option<String>,
    /// 실제로 파일이 바뀌었는가
    pub changed: bool,
    pub commit: CommitOutcome,
    pub commit_short: Option<String>,
    pub detail: Option<String>,
}
