//! 프로젝트의 하네스 문서 읽기 — 단계 표(`dev-plan.md`) · 이어 하기 메모(`handoff.md`) · 지시서 진행률 (P7-01, D-22 · D-49).
//! 약속은 하네스 `shared/app-contract.md` §6. 사람이 고치는 파일이라 **모르는 줄은 건너뛰고, 못 읽는 곳만 "읽을 수 없음"** 으로 돌려준다 — 어떤 글이 와도 패닉 · 오류가 없다.
//!
//! - 글을 받아 결과를 돌려주는 순수 함수(`parse_plan` · `parse_handoff` · `count_checks`)와, 파일을 찾아 읽는 얇은 함수(`read_in`)로 나눴다.
//! - **단계 표**는 `## 단계 개요` 아래 첫 표. 머리 줄이 `단계 | 내용 | 담당 | 승인 게이트 | 상태` 와 다르면 읽을 수 없음. 행은 앞 네 칸을 차례로, **다섯째부터 끝까지는 합쳐 상태
//!   한 칸**으로 읽는다 (` | ` 로 이어 붙임 — 상태 글 안의 이스케이프 안 된 `|` 를 받으려고). 끝의 `|` 는 없어도 된다. 칸 안의 `**` 는 지운다.
//! - **이어 하기 메모**는 절마다 따로 읽는다 (한 절을 못 읽어도 나머지는 준다). `## 지금 상태` 는 약속은 "첫 글머리" 지만 틀 · 실제 파일 모두 글머리 없는 문단이라
//!   **첫 줄**(글머리 표시가 있으면 뗀 것)을 읽는다.
//! - **지시서 진행률**: 메모의 작업 중 `briefs/<이름>.md` 가 적힌 것의 `- [ ]` / `- [x]` 수. 끝난 작업(`검수 통과`)은 읽지 않는다 (`progress` 는 `null`).
//! - `version`: 읽는 파일들의 이름 · 크기 · 수정 시각만으로 만든 값 (내용을 읽지 않는다 — 화면이 몇 초마다 부른다).

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::docs::{self, is_markdown_name, valid_component};
use super::requirements::{self, Problem};
use super::{Env, requirements_dir};
use crate::db::AppDb;
use crate::error::AppError;

/// 한 번에 읽는 지시서의 최대 수 (끝나지 않은 작업은 보통 몇 개뿐이다)
const MAX_BRIEF_READS: usize = 40;

/// 이름 · 크기 · 수정 시각을 보는 지시서 파일의 최대 수 (`version`)
const MAX_VERSION_BRIEFS: usize = 5000;

/// 수정 시각이 이만큼 최근이면 크기 · 시각이 같아도 안 믿는다 (시각 해상도가 거친 파일 시스템에서 같은 크기로 고친 경우 — `requirements` 와 같은 값)
const RACY_WINDOW: Duration = Duration::from_secs(2);

const PLAN_FILE: &str = "dev-plan.md";
const HANDOFF_FILE: &str = "handoff.md";
const DEV_DIR: &str = "02-development";
const BRIEFS_DIR: &str = "briefs";

/// 읽을 수 없는 이유 — 화면이 문구를 고르는 열쇠. 앞 일곱은 `requirements::Problem` 과 같은 이름이다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    NotUtf8,
    TooLarge,
    OutsideFolder,
    Link,
    FolderMissing,
    NotAFile,
    ReadFailed,
    /// 찾는 `## 절` 제목이 없다
    NoSection,
    /// 절은 있는데 표가 없다
    NoTable,
    /// 표 머리 줄이 약속과 다르다
    HeaderMismatch,
    /// 절에서 읽을 글(첫 줄 · 글머리 · 번호 목록)이 없다
    NoItem,
}

impl From<Problem> for Reason {
    fn from(problem: Problem) -> Self {
        match problem {
            Problem::NotUtf8 => Reason::NotUtf8,
            Problem::TooLarge => Reason::TooLarge,
            Problem::OutsideFolder => Reason::OutsideFolder,
            Problem::Link => Reason::Link,
            Problem::FolderMissing => Reason::FolderMissing,
            Problem::NotAFile => Reason::NotAFile,
            Problem::ReadFailed => Reason::ReadFailed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReasonInfo {
    pub reason: Reason,
}

fn reason(reason: Reason) -> ReasonInfo {
    ReasonInfo { reason }
}

/// 단계 상태: 빈 칸 `todo` · `완료` 로 시작 `done` · `진행 중` 으로 시작 `now` · 그 밖 `unknown` (글은 `statusText` 에)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PhaseStatus {
    Done,
    Now,
    Todo,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseInfo {
    /// `P0`, `P1` …
    pub id: String,
    /// 내용 칸
    pub summary: String,
    /// 담당 칸: `→` 로 차례, `·` 로 함께 (`system → tester → reviewer` = `[["system"],["tester"],["reviewer"]]`). 모르는 말도 글 그대로 담는다
    pub owners: Vec<Vec<String>>,
    /// 담당 칸의 원래 글
    pub owners_text: String,
    /// 승인 게이트 칸
    pub gate: String,
    pub status: PhaseStatus,
    /// 상태 칸의 원래 글 (`**` 뗌)
    pub status_text: String,
    /// `## P<n>. 이름` 절의 이름 (절이 없으면 `null`)
    pub name: Option<String>,
    /// 그 절의 `- 목표:` 한 줄 (없으면 `null`)
    pub goal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlanInfo {
    pub phases: Vec<PhaseInfo>,
}

/// `## 지금 상태` 의 값: 약속 낱말로 시작하면 그 상태, 아니면 `unknown`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NowState {
    /// 작업자 일하는 중
    Working,
    /// 검수 중
    Reviewing,
    /// 사용자 답 기다림
    WaitingAnswer,
    /// 실행 확인 기다림
    WaitingRun,
    /// 단계 사이
    Between,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NowInfo {
    pub state: NowState,
    /// 그 줄의 글 (`**` 뗌)
    pub text: String,
}

/// 작업(지시서) 상태: `맡김` → `돌아옴` → `검수 통과` / `다시 맡김`. 앞의 `<n>차 ` 는 떼고 읽는다. 그 밖은 `unknown`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Assigned,
    Back,
    Passed,
    Redo,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TaskProgress {
    pub done: u32,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    /// 지시서 칸의 글 (경로가 아니어도 그대로 — `(P2-01 ~ P2-03 검수 통과 — 지시서 끝)`)
    pub label: String,
    /// `briefs/<이름>.md` 모양일 때만 (아니면 `null` — `../` 가 적혀 있어도 `null`)
    pub brief: Option<String>,
    /// 파일 이름 앞부분 (`P7-01`)
    pub id: Option<String>,
    /// 그 앞부분의 단계 (`P7`)
    pub phase: Option<String>,
    /// 담당 칸의 글 (`system` …)
    pub owner: String,
    pub status: TaskStatus,
    /// 상태 칸의 원래 글 (`**` 뗌)
    pub status_text: String,
    /// 지시서의 `- [x]` 수 / 전체. 지시서가 없거나 못 읽었거나 끝난 작업(`검수 통과`, 읽지 않는다)이면 `null`
    pub progress: Option<TaskProgress>,
}

/// 메모의 한 절 — 읽었으면 값, 못 읽었으면 이유 (다른 절은 그대로 읽힌다)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Section<T> {
    Ok { value: T },
    Unreadable { reason: Reason },
}

fn ok<T>(value: T) -> Section<T> {
    Section::Ok { value }
}

fn bad<T>(why: Reason) -> Section<T> {
    Section::Unreadable { reason: why }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HandoffInfo {
    /// 머리 목록 `- 스킬:` (없으면 `null`). 값은 첫 줄만, 백틱 · `**` 는 뗀다
    pub skill: Option<String>,
    /// `- 요구사항:`
    pub requirements: Option<String>,
    /// `- 지금 단계:`
    pub phase: Option<String>,
    /// `- 마지막 갱신:`
    pub updated: Option<String>,
    /// `## 지금 상태`
    pub current: Section<NowInfo>,
    /// `## 진행 중인 작업`
    pub tasks: Section<Vec<TaskInfo>>,
    /// `## 사용자에게 기다리는 것` (`없음` 이면 빈 목록)
    pub waiting: Section<Vec<String>>,
    /// `## 다음 할 일`
    pub next: Section<Vec<String>>,
}

/// `plan` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum PlanResult {
    Ok(PlanInfo),
    /// 파일이 없다 (아직 하네스 전)
    Absent,
    Unreadable(ReasonInfo),
}

/// `handoff` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HandoffResult {
    Ok(HandoffInfo),
    Absent,
    Unreadable(ReasonInfo),
}

/// `project_progress_read` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProgressResult {
    /// 읽기 **전에** 만든 `version` (읽는 사이 바뀌면 다음 물음에서 다르게 나와 다시 읽는다)
    pub version: String,
    pub plan: PlanResult,
    pub handoff: HandoffResult,
}

// ───────────────────────── 글 나누기 (마크다운 조각) ─────────────────────────

/// `**` 를 지우고 앞뒤 공백을 뗀다
fn plain(text: &str) -> String {
    text.replace("**", "").trim().to_string()
}

/// `plain` + 백틱도 지운다 (이름 · 낱말 · 경로를 읽을 때)
fn bare(text: &str) -> String {
    plain(text).replace('`', "").trim().to_string()
}

/// 줄 앞뒤의 코드 울타리(```` ``` ```` · `~~~`) 안은 빈 줄로 바꾼다 — 울타리 안의 제목 · 표 · 글머리를 읽지 않는다
fn clean_lines(text: &str) -> Vec<&str> {
    let mut fenced = false;
    text.lines()
        .map(|line| {
            let head = line.trim_start();
            if head.starts_with("```") || head.starts_with("~~~") {
                fenced = !fenced;
                ""
            } else if fenced {
                ""
            } else {
                line
            }
        })
        .collect()
}

struct Part<'a> {
    title: &'a str,
    body: &'a [&'a str],
}

/// `## 제목` 으로 나눈다. 돌려주는 것: (첫 제목 앞의 줄들, 절들)
fn split_parts<'a>(lines: &'a [&'a str]) -> (&'a [&'a str], Vec<Part<'a>>) {
    let starts: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.strip_prefix("## ").map(|title| (index, title.trim())))
        .collect();
    let head_end = starts.first().map_or(lines.len(), |start| start.0);
    let parts = starts
        .iter()
        .enumerate()
        .map(|(n, &(index, title))| {
            let end = starts.get(n + 1).map_or(lines.len(), |next| next.0);
            Part {
                title,
                body: &lines[index + 1..end],
            }
        })
        .collect();
    (&lines[..head_end], parts)
}

/// 표 줄을 칸으로 나눈다 (`|` 로 시작하지 않으면 `None`). 앞뒤 `|` 는 한 쌍만 떼고, 칸 안의 `\|` 는 `|` 글자다. 끝의 `|` 는 없어도 된다.
fn split_cells(line: &str) -> Option<Vec<String>> {
    let body = line.trim().strip_prefix('|')?;
    let mut cells = Vec::new();
    let mut current = String::new();
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\\' if chars.peek() == Some(&'|') => {
                current.push('|');
                chars.next();
            }
            '|' => {
                cells.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(c),
        }
    }
    // 줄이 `|` 로 끝났으면 남은 것이 없다 (끝의 `|` 는 칸이 아니라 닫는 표시)
    if !current.trim().is_empty() {
        cells.push(current.trim().to_string());
    }
    Some(cells)
}

/// `---` · `:---:` 로만 된 줄인가
fn is_separator(cells: &[String]) -> bool {
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let core = cell.trim_matches(':');
            !core.is_empty() && core.bytes().all(|b| b == b'-')
        })
}

struct Table {
    header: Vec<String>,
    rows: Vec<Vec<String>>,
}

/// 줄들에서 첫 표(머리 줄 + 구분 줄 + 행들)를 찾는다
fn first_table(lines: &[&str]) -> Option<Table> {
    let mut index = 0;
    while index < lines.len() {
        let Some(header) = split_cells(lines[index]) else {
            index += 1;
            continue;
        };
        let separated = lines
            .get(index + 1)
            .and_then(|line| split_cells(line))
            .is_some_and(|cells| is_separator(&cells));
        if separated {
            let rows = lines[index + 2..]
                .iter()
                .map_while(|line| split_cells(line))
                .collect();
            return Some(Table { header, rows });
        }
        // 구분 줄이 없는 `|` 줄 묶음은 표가 아니다 — 묶음을 건너뛴다
        while index < lines.len() && split_cells(lines[index]).is_some() {
            index += 1;
        }
    }
    None
}

/// 앞 `fixed` 칸은 그대로(모자라면 빈 칸), 나머지는 ` | ` 로 이어 붙여 한 칸으로 (끝의 빈 칸은 뗀다)
fn fixed_and_rest(cells: &[String], fixed: usize) -> (Vec<String>, String) {
    let mut head: Vec<String> = cells.iter().take(fixed).cloned().collect();
    head.resize(fixed, String::new());
    let mut rest: Vec<&str> = cells.iter().skip(fixed).map(String::as_str).collect();
    while rest.last().is_some_and(|cell| cell.is_empty()) {
        rest.pop();
    }
    (head, rest.join(" | "))
}

/// 글머리(`- ` · `* ` · `+ `) 한 줄의 글 (들여쓰기 3칸까지 — 더 들어가면 하위 글머리다)
fn bullet_text(line: &str) -> Option<&str> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    rest.strip_prefix("- ")
        .or_else(|| rest.strip_prefix("* "))
        .or_else(|| rest.strip_prefix("+ "))
}

/// 번호 목록(`1. ` · `1) `) 한 줄의 글
fn numbered_text(line: &str) -> Option<&str> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    // `1.` 만 있는 줄(틀의 빈 항목 — 편집기가 뒤 공백을 지운다)도 번호 항목이다
    let marker = rest[digits..]
        .strip_prefix('.')
        .or_else(|| rest[digits..].strip_prefix(')'))?;
    (marker.is_empty() || marker.starts_with(' ')).then_some(marker)
}

fn is_blank(lines: &[&str]) -> bool {
    lines.iter().all(|line| line.trim().is_empty())
}

fn find_part<'a, 'b>(parts: &'b [Part<'a>], title: &str) -> Option<&'b Part<'a>> {
    parts.iter().find(|part| part.title == title)
}

// ───────────────────────── 단계 표 ─────────────────────────

fn phase_status(text: &str) -> PhaseStatus {
    if text.is_empty() {
        PhaseStatus::Todo
    } else if text.starts_with("완료") {
        PhaseStatus::Done
    } else if text.starts_with("진행 중") || text.starts_with("진행중") {
        PhaseStatus::Now
    } else {
        PhaseStatus::Unknown
    }
}

/// `P0` · `P12` 모양인가
fn is_phase_id(text: &str) -> bool {
    text.strip_prefix('P')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn parse_owners(text: &str) -> Vec<Vec<String>> {
    bare(&text.replace("->", "→"))
        .split('→')
        .map(|group| {
            group
                .split('·')
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|group| !group.is_empty())
        .collect()
}

/// `## P1. 앱 뼈대` → (`P1`, `앱 뼈대`)
fn phase_heading(title: &str) -> Option<(String, String)> {
    let rest = title.strip_prefix('P')?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let name = rest[digits.len()..].strip_prefix('.')?;
    Some((format!("P{digits}"), plain(name)))
}

/// 절의 `- 목표:` 한 줄
fn goal_of(body: &[&str]) -> Option<String> {
    body.iter().find_map(|line| {
        let line = line.replace("**", "");
        let value = bullet_text(&line)?
            .strip_prefix("목표:")?
            .trim()
            .to_string();
        (!value.is_empty()).then_some(value)
    })
}

/// `dev-plan.md` 의 단계 표를 읽는다. 표를 못 찾으면 `NoSection`(제목 없음) · `NoTable`(표 없음), 머리 줄이 다르면 `HeaderMismatch`.
pub fn parse_plan(text: &str) -> Result<PlanInfo, Reason> {
    let lines = clean_lines(text);
    let (_, parts) = split_parts(&lines);
    let overview = find_part(&parts, "단계 개요").ok_or(Reason::NoSection)?;
    let table = first_table(overview.body).ok_or(Reason::NoTable)?;

    let (head, status) = fixed_and_rest(&table.header, 4);
    let expected = ["단계", "내용", "담당", "승인 게이트"];
    if !head.iter().map(|cell| plain(cell)).eq(expected) || plain(&status) != "상태" {
        return Err(Reason::HeaderMismatch);
    }

    // 단계 상세 절 (`## P1. 이름`) — 같은 번호가 또 나오면 처음 것
    let mut details: HashMap<String, (String, Option<String>)> = HashMap::new();
    for part in &parts {
        if let Some((id, name)) = phase_heading(part.title) {
            details
                .entry(id)
                .or_insert_with(|| (name, goal_of(part.body)));
        }
    }

    let mut phases: Vec<PhaseInfo> = Vec::new();
    for cells in &table.rows {
        let (fixed, status) = fixed_and_rest(cells, 4);
        let id = bare(&fixed[0]);
        // 첫 칸이 `P0` 모양이 아닌 줄은 단계가 아니다. 같은 번호가 또 나오면 처음 것만
        if !is_phase_id(&id) || phases.iter().any(|phase| phase.id == id) {
            continue;
        }
        let status_text = plain(&status);
        let detail = details.get(&id);
        phases.push(PhaseInfo {
            summary: plain(&fixed[1]),
            owners: parse_owners(&fixed[2]),
            owners_text: plain(&fixed[2]),
            gate: plain(&fixed[3]),
            status: phase_status(&status_text),
            status_text,
            name: detail
                .map(|(name, _)| name.clone())
                .filter(|name| !name.is_empty()),
            goal: detail.and_then(|(_, goal)| goal.clone()),
            id,
        });
    }
    Ok(PlanInfo { phases })
}

// ───────────────────────── 이어 하기 메모 ─────────────────────────

/// 머리 목록 `- 키: 값` 에서 키의 값 (첫 줄만 — 값이 비어 있고 하위 글머리가 이어지면 그 첫 글머리)
fn head_value(head: &[&str], key: &str) -> Option<String> {
    for (index, line) in head.iter().enumerate() {
        let Some((name, value)) = bullet_text(line).and_then(|text| text.split_once(':')) else {
            continue;
        };
        if bare(name) != key {
            continue;
        }
        let value = bare(value);
        if !value.is_empty() {
            return Some(value);
        }
        // 값이 다음 줄들(하위 글머리)에 있다 — 그 첫 줄
        for next in &head[index + 1..] {
            if next.trim().is_empty() {
                continue;
            }
            if !next.starts_with(' ') && !next.starts_with('\t') {
                break;
            }
            let child = next.trim_start();
            let child = child
                .strip_prefix("- ")
                .or_else(|| child.strip_prefix("* "))
                .unwrap_or(child);
            let child = bare(child);
            return (!child.is_empty()).then_some(child);
        }
        return None;
    }
    None
}

fn now_state(text: &str) -> NowState {
    const WORDS: [(&str, NowState); 5] = [
        ("작업자 일하는 중", NowState::Working),
        ("검수 중", NowState::Reviewing),
        ("사용자 답 기다림", NowState::WaitingAnswer),
        ("실행 확인 기다림", NowState::WaitingRun),
        ("단계 사이", NowState::Between),
    ];
    WORDS
        .iter()
        .find(|(word, _)| text.starts_with(word))
        .map_or(NowState::Unknown, |&(_, state)| state)
}

fn read_current(body: &[&str]) -> Section<NowInfo> {
    let Some(&line) = body.iter().find(|line| !line.trim().is_empty()) else {
        return bad(Reason::NoItem);
    };
    let text = bullet_text(line)
        .or_else(|| numbered_text(line))
        .unwrap_or(line);
    let text = plain(text);
    ok(NowInfo {
        state: now_state(&bare(&text)),
        text,
    })
}

/// `briefs/<이름>.md` 모양의 지시서 경로 (`../` · 다른 폴더 · 이름에 쓸 수 없는 글자가 있으면 `None`)
fn brief_path(text: &str) -> Option<String> {
    let (dir, name) = text.split_once('/')?;
    (dir == BRIEFS_DIR && valid_component(name) && is_markdown_name(name)).then(|| text.to_string())
}

/// 지시서 파일 이름의 앞부분 (`P7-01-project-docs.md` → `P7-01`)
fn brief_id(brief: &str) -> Option<String> {
    let name = brief.strip_prefix("briefs/")?;
    let rest = name.strip_prefix('P')?;
    let phase: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let after = rest[phase.len()..].strip_prefix('-')?;
    let number: String = after.chars().take_while(char::is_ascii_digit).collect();
    (!phase.is_empty() && !number.is_empty()).then(|| format!("P{phase}-{number}"))
}

fn task_status(text: &str) -> TaskStatus {
    let text = bare(text);
    // 앞의 `<n>차 ` 는 뗀다 (`2차 검수 통과`)
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    let text = match text[digits..].strip_prefix('차') {
        Some(rest) if digits > 0 => rest.trim_start(),
        _ => text.as_str(),
    };
    if text.starts_with("다시 맡김") {
        TaskStatus::Redo
    } else if text.starts_with("맡김") {
        TaskStatus::Assigned
    } else if text.starts_with("돌아옴") {
        TaskStatus::Back
    } else if text.starts_with("검수 통과") {
        TaskStatus::Passed
    } else {
        TaskStatus::Unknown
    }
}

/// 작업 표의 한 행. 앞 세 칸(지시서 · 담당 · 상태)만 읽고, 칸이 모자라면 빈 칸으로 본다. 다 비었으면 `None`.
fn parse_task(cells: &[String]) -> Option<TaskInfo> {
    let cell = |index: usize| cells.get(index).map_or("", String::as_str);
    let label = bare(cell(0));
    let owner = bare(cell(1));
    let status_text = plain(cell(2));
    if label.is_empty() && owner.is_empty() && status_text.is_empty() {
        return None;
    }
    let brief = brief_path(&label);
    let id = brief.as_deref().and_then(brief_id);
    let phase = id
        .as_deref()
        .and_then(|id| id.split_once('-'))
        .map(|(phase, _)| phase.to_string());
    Some(TaskInfo {
        label,
        brief,
        id,
        phase,
        owner,
        status: task_status(&status_text),
        status_text,
        progress: None,
    })
}

fn read_tasks(body: &[&str]) -> Section<Vec<TaskInfo>> {
    let Some(table) = first_table(body) else {
        return bad(Reason::NoTable);
    };
    let head: Vec<String> = table.header.iter().take(3).map(|c| plain(c)).collect();
    if head != ["지시서", "담당", "상태"] {
        return bad(Reason::HeaderMismatch);
    }
    ok(table
        .rows
        .iter()
        .filter_map(|cells| parse_task(cells))
        .collect())
}

/// `없음` 으로 시작하는(`없음 (설명)`) 글머리는 "기다리는 것이 없다" 는 뜻이다
fn means_nothing(item: &str) -> bool {
    item.strip_prefix("없음")
        .is_some_and(|rest| !rest.chars().next().is_some_and(char::is_alphanumeric))
}

fn read_list(body: &[&str], item_of: fn(&str) -> Option<&str>) -> Section<Vec<String>> {
    let items: Vec<String> = body
        .iter()
        .filter_map(|line| item_of(line))
        .map(plain)
        .filter(|item| !item.is_empty() && !means_nothing(item))
        .collect();
    if items.is_empty() && !is_blank(body) && !body.iter().any(|line| item_of(line).is_some()) {
        // 글은 있는데 목록 모양이 아니다
        return bad(Reason::NoItem);
    }
    ok(items)
}

/// `handoff.md` 를 읽는다. 절마다 따로 — 한 절을 못 읽어도 나머지는 준다. 아는 절 · 머리 목록이 하나도 없으면 `NoSection`.
/// 작업의 `progress` 는 여기서 채우지 않는다 (`null`) — 지시서를 읽는 것은 파일이 필요해서 `read_in` 이 한다.
pub fn parse_handoff(text: &str) -> Result<HandoffInfo, Reason> {
    let lines = clean_lines(text);
    let (head, parts) = split_parts(&lines);

    let skill = head_value(head, "스킬");
    let requirements = head_value(head, "요구사항");
    let phase = head_value(head, "지금 단계");
    let updated = head_value(head, "마지막 갱신");

    let section = |title: &str| find_part(&parts, title);
    let current =
        section("지금 상태").map_or_else(|| bad(Reason::NoSection), |p| read_current(p.body));
    let tasks =
        section("진행 중인 작업").map_or_else(|| bad(Reason::NoSection), |p| read_tasks(p.body));
    let waiting = section("사용자에게 기다리는 것").map_or_else(
        || bad(Reason::NoSection),
        |p| read_list(p.body, bullet_text),
    );
    let next = section("다음 할 일").map_or_else(
        || bad(Reason::NoSection),
        |p| read_list(p.body, numbered_text),
    );

    let nothing_known = [&skill, &requirements, &phase, &updated]
        .iter()
        .all(|value| value.is_none())
        && parts.iter().all(|part| {
            ![
                "지금 상태",
                "진행 중인 작업",
                "사용자에게 기다리는 것",
                "다음 할 일",
            ]
            .contains(&part.title)
        });
    if nothing_known {
        return Err(Reason::NoSection);
    }
    Ok(HandoffInfo {
        skill,
        requirements,
        phase,
        updated,
        current,
        tasks,
        waiting,
        next,
    })
}

// ───────────────────────── 지시서 진행률 ─────────────────────────

/// 지시서의 `- [ ]` / `- [x]` 줄 수 (코드 울타리 안은 세지 않는다)
pub fn count_checks(text: &str) -> TaskProgress {
    let (mut done, mut total) = (0u32, 0u32);
    for line in clean_lines(text) {
        let head = line.trim_start();
        let Some(rest) = head
            .strip_prefix("- [")
            .or_else(|| head.strip_prefix("* ["))
        else {
            continue;
        };
        let mut chars = rest.chars();
        let (mark, close, after) = (chars.next(), chars.next(), chars.next());
        let boxed = close == Some(']') && after.is_none_or(char::is_whitespace);
        match mark {
            Some(' ') if boxed => total += 1,
            Some('x' | 'X') if boxed => {
                total += 1;
                done += 1;
            }
            _ => {}
        }
    }
    TaskProgress { done, total }
}

/// 끝나지 않은 작업의 지시서를 읽어 진행률을 채운다. 파일이 없거나 못 읽으면 `null`.
fn attach_progress(root: &Path, tasks: &mut [TaskInfo]) {
    let mut reads = 0;
    for task in tasks.iter_mut() {
        let Some(brief) = task.brief.as_deref() else {
            continue;
        };
        // 끝난 작업은 읽지 않는다 (`검수 통과` — 몇 십 개가 쌓여도 느려지지 않게)
        if task.status == TaskStatus::Passed {
            continue;
        }
        if reads >= MAX_BRIEF_READS {
            break;
        }
        reads += 1;
        // `brief_path` 가 `briefs/<이름>.md` 한 모양만 통과시켰다 — 그래도 읽을 때는 실제 경로가 `docsDir` 안인지 다시 본다
        let Some(name) = brief.strip_prefix("briefs/") else {
            continue;
        };
        if let Ok(Some(text)) = docs::read_text(root, &[DEV_DIR, BRIEFS_DIR, name]) {
            task.progress = Some(count_checks(&text.text));
        }
    }
}

// ───────────────────────── 파일 읽기 ─────────────────────────

fn read_plan(root: &Path) -> PlanResult {
    match docs::read_text(root, &[DEV_DIR, PLAN_FILE]) {
        Err(problem) => PlanResult::Unreadable(reason(problem.into())),
        Ok(None) => PlanResult::Absent,
        Ok(Some(file)) => match parse_plan(&file.text) {
            Ok(plan) => PlanResult::Ok(plan),
            Err(why) => PlanResult::Unreadable(reason(why)),
        },
    }
}

fn read_handoff(root: &Path) -> HandoffResult {
    match docs::read_text(root, &[DEV_DIR, HANDOFF_FILE]) {
        Err(problem) => HandoffResult::Unreadable(reason(problem.into())),
        Ok(None) => HandoffResult::Absent,
        Ok(Some(file)) => match parse_handoff(&file.text) {
            Ok(mut handoff) => {
                if let Section::Ok { value } = &mut handoff.tasks {
                    attach_progress(root, value);
                }
                HandoffResult::Ok(handoff)
            }
            Err(why) => HandoffResult::Unreadable(reason(why)),
        },
    }
}

/// 프로젝트 폴더의 하네스 문서를 읽는다 (`docsDir` 는 하네스 설정의 값)
pub fn read_in(project_dir: &Path, docs_dir: &str, now: SystemTime) -> ProgressResult {
    // `version` 을 먼저 — 읽는 사이 파일이 바뀌면 화면의 다음 물음에서 값이 달라 다시 읽는다
    let version = version_in(project_dir, docs_dir, now);
    let (plan, handoff) = match docs::locate(project_dir, docs_dir) {
        Err(problem) => (
            PlanResult::Unreadable(reason(problem.into())),
            HandoffResult::Unreadable(reason(problem.into())),
        ),
        Ok(None) => (PlanResult::Absent, HandoffResult::Absent),
        Ok(Some(root)) => (read_plan(&root), read_handoff(&root)),
    };
    ProgressResult {
        version,
        plan,
        handoff,
    }
}

// ───────────────────────── version (내용을 읽지 않는다) ─────────────────────────

/// 파일 하나의 (크기, 수정 시각 나노초). 없으면 `None`
fn stat(meta: &fs::Metadata) -> (u64, u128) {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |age| age.as_nanos());
    (meta.len(), nanos)
}

/// 읽는 파일(`dev-plan.md` · `handoff.md` · `briefs/` 안 `.md`)의 이름 · 크기 · 수정 시각으로 만든 값. 내용을 읽지 않고 링크를 따라가지도 않는다.
/// 수정 시각이 `now` 에 가까우면(시각 해상도 때문에 같은 크기의 고침을 놓칠 수 있다) 값에 `now` 를 섞어 **그동안은 매번 다르게** 한다 —
/// 화면이 한두 번 더 읽을 뿐이고, 시각이 충분히 옛날이 되면 값이 고정된다.
pub fn version_in(project_dir: &Path, docs_dir: &str, now: SystemTime) -> String {
    let base = project_dir.join(docs_dir).join(DEV_DIR);
    let mut items: Vec<(String, Option<(u64, u128)>)> = [PLAN_FILE, HANDOFF_FILE]
        .iter()
        .map(|name| {
            let meta = fs::symlink_metadata(base.join(name)).ok();
            ((*name).to_string(), meta.as_ref().map(stat))
        })
        .collect();
    if let Ok(read) = fs::read_dir(base.join(BRIEFS_DIR)) {
        for entry in read.take(MAX_VERSION_BRIEFS).flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if !is_markdown_name(&name) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                items.push((format!("{BRIEFS_DIR}/{name}"), Some(stat(&meta))));
            }
        }
    }
    items.sort_by(|a, b| a.0.cmp(&b.0));

    let now_nanos = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |age| age.as_nanos());
    let mut bytes = Vec::new();
    let mut racy = false;
    for (name, found) in &items {
        bytes.extend_from_slice(name.as_bytes());
        bytes.push(0);
        match found {
            None => bytes.push(b'-'),
            Some((len, nanos)) => {
                bytes.extend_from_slice(format!("{len}:{nanos}").as_bytes());
                // 방금 고쳤거나(시각이 `now` 보다 뒤인 것 포함) 시계가 어긋난 파일
                racy |= nanos.saturating_add(RACY_WINDOW.as_nanos()) > now_nanos;
            }
        }
        bytes.push(b'\n');
    }
    if racy {
        bytes.extend_from_slice(format!("racy:{now_nanos}").as_bytes());
    }
    requirements::version_of(&bytes)
}

// ───────────────────────── 명령이 부르는 것 ─────────────────────────

pub fn read(db: &AppDb, env: &Env, id: i64) -> Result<ProgressResult, AppError> {
    let dir = requirements_dir(db, env, id)?;
    Ok(read_in(&dir, &env.docs_dir, SystemTime::now()))
}

pub fn version(db: &AppDb, env: &Env, id: i64) -> Result<String, AppError> {
    let dir = requirements_dir(db, env, id)?;
    Ok(version_in(&dir, &env.docs_dir, SystemTime::now()))
}

#[cfg(test)]
mod tests {
    use super::super::docs::test_support::{make_dir_link, must_link};
    use super::super::folder::{ForbiddenReason, ForbiddenSet};
    use super::super::{AddRequest, ProjectsState, add, handle_picked};
    use super::*;
    use crate::claude::test_util::TempDir;
    use crate::db::DB_FILE;

    // ── 가짜 문서 (이 저장소의 실제 docs/ 는 비공개라 복사하지 않고 모양만 본떴다) ──

    /// 하네스 틀(`templates/dev-plan.md`) 그대로
    const TEMPLATE_PLAN: &str = "# <프로젝트 이름> 개발 계획

## 작업 규칙
1. 모든 단계는 시작 전 승인을 받는다 (무엇을 / 왜 지금 / 산출물 / 하지 않는 것).
2. 범위가 바뀌면 이 문서를 먼저 고치고 다시 승인받는다.

## 단계 개요
| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |
|---|---|---|---|---|
| P0 | 셋업 · 기획 확정 | 직접 | 기획 승인 | |
| P1 | | ui | | |

담당: `designer` = 디자인 (Opus · high), `ui` = 화면 (Sonnet · medium)

## P1. <단계 이름>
- 목표:
- 작업:
- 완료 기준:
- 확인 명령:

## 진행 로그
| 날짜 | 단계 | 한 일 | 결과 |
|---|---|---|---|
";

    /// 사람이 고친 것처럼 지저분한 단계 표
    const MESSY_PLAN: &str = "# 가짜 앱 개발 계획

## 단계 개요
| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |
|---|---|---|---|---|
| P0 | 셋업 | 직접 | 기획 승인 | 완료 (2026-01-01) |
| P1 | **굵은** 내용 | `system` | 실행 확인 | **완료 (2026-01-02)** — 요약 |
| P2 | 시안 | designer | **시안 고르기** · 그림 확인 | **완료** — 시안 a |
| P3 | 연결 | system → tester → reviewer | 실행 확인 | 진행 중 (2026-01-05) |
| P4 | 화면 | ui · system | 실행 확인 | 완료 (2026-01-09) — 작업 공간 [채팅 | 요구사항] 탭 · 카드 |
| P5 | 알림 | system -> reviewer | 실행 확인
| P6 | 마무리 | reviewer · tester → 고침은 담당별 | 점검 승인 | 보류 중 |
| P2-T | 테마 | designer | 고르기 | 완료 |
| 설명 줄 | 단계가 아님 | | | |
| P7 | | | | |
| P1 | 같은 번호가 또 | ui | | |
| P8 | 이스케이프 | helper | 확인 | 완료 \\| 끝 |

표 아래 글.

## P1. 앱 뼈대
- 목표: 빈 앱이 뜬다.
- 작업:
  - 하위 글머리

## P3. Claude 연결
- **목표**: 대화 세션을 연다.

## P3. 같은 번호의 또 다른 절
- 목표: 이건 무시된다.

## P2-T 테마
- 목표: 단계 번호가 아니다.

## P6. 이름만 있는 절
- 작업: 목표 줄이 없다
";

    /// 하네스 틀(`templates/handoff.md`) 그대로
    const TEMPLATE_HANDOFF: &str = "# 이어 하기 메모

> 메인 대화가 덮어쓴다.

- 스킬: `<web-full | web-lite | desktop-app>`
- 요구사항: `<경로>`
- 저장소: `<경로>` (여럿이면 모두)
- 지금 단계: <P2 — 목록 화면> (`dev-plan.md`)
- 마지막 갱신: YYYY-MM-DD HH:MM

## 지금 상태

<하나만: 작업자 일하는 중 / 검수 중 / 사용자 답 기다림 / 실행 확인 기다림 / 단계 사이>

## 진행 중인 작업

| 지시서 | 담당 | 상태 | 맡길 때 git | 보고 |
|---|---|---|---|---|
| `briefs/<P2-03-목록화면>.md` | <ui> | 맡김 | `<커밋 번호>` · 이미 바뀌어 있던 파일: <없음> | - |

- 상태: `맡김` → `돌아옴` → `검수 통과` / `다시 맡김`

## 사용자에게 기다리는 것

- <질문 · 승인 · 실행 확인 — 없으면 \"없음\">

## 다음 할 일

1.
";

    /// 지저분한 이어 하기 메모
    const MESSY_HANDOFF: &str = "# 이어 하기 메모

> 메모.

- 스킬: `desktop-app`
- 요구사항: `requirements.md` (프로젝트 루트, 고치지 않음)
- 저장소:
  - `C:\\dev\\fake` — 이 앱 — 커밋 `abc1234`
  - `\\\\wsl.localhost\\x` — 원본
- 지금 단계:
  - **P7 진행 보기 — 진행 중 (2026-11-07 승인)**, 배치 탭
  - 이전: P6 완료
- 마지막 갱신: 2026-11-07

## 지금 상태

**작업자 일하는 중 — P7-01 (system, 2026-11-07)** — 설명이 이어진다.

이전: **P6 완료** — 두 번째 문단.

## 진행 중인 작업

| 지시서 | 담당 | 상태 | 맡길 때 git | 보고 |
|---|---|---|---|---|
| `briefs/P7-01-docs.md` | system | 맡김 (2026-11-07) | 앱 `641fd73` — 이미 바뀌어 있던 파일: 없음 | |
| `briefs/P6-12-cards.md` | ui | 검수 통과 · 고객 확인 · 커밋 `641fd73` — 지시서 끝 | 앱 `bd42742` | |
| `briefs/P6-11-fixes.md` | ui | 2차 검수 통과 — 지시서 끝 | x | |
| `briefs/P6-09-review.md` | reviewer | 끝 — 고객 고름 (실패함만 저장) | x | |
| (P2-01 ~ P2-03 검수 통과 — 지시서 끝) | | | | |
| `briefs/P2-11-theme.md` | designer | 검수 통과 · 고객 고름 (①) — 지시서 끝 |
| `briefs/P3-02-session.md` | system | **1차 검수 통과** |
| `briefs/P2-05-art.md` | system | 검수 통과 (4차 포함) | `ecd13c5` | 지시서 끝
| `briefs/../secret.md` | system | 맡김 | | |
| `briefs/sub/x.md` | system | 돌아옴 | | |
| `briefs/P8-01-redo.md` | tester | 다시 맡김 (2026-11-08) | | |
| briefs\\P8-02-win.md | tester | 돌아옴 |
| `briefs/P9-03-gone.md` | ui | 맡김 | | |

## 사용자에게 기다리는 것

- 없음 (P7-01 작업자 일하는 중). 하네스 할 일: 문장 맞추기

## 다음 할 일

1. P7-01 검수.
2. P7-02 지시서 (먼저 실제 CLI 로 녹화)
   - 하위 글머리는 항목이 아니다
3. P7-03 · P7-04
";

    fn plan_of(text: &str) -> PlanInfo {
        parse_plan(text).unwrap_or_else(|why| panic!("plan unreadable: {why:?}"))
    }

    fn handoff_of(text: &str) -> HandoffInfo {
        parse_handoff(text).unwrap_or_else(|why| panic!("handoff unreadable: {why:?}"))
    }

    fn tasks_of(handoff: &HandoffInfo) -> &[TaskInfo] {
        match &handoff.tasks {
            Section::Ok { value } => value,
            other => panic!("tasks: {other:?}"),
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    fn owners(groups: &[&[&str]]) -> Vec<Vec<String>> {
        groups.iter().map(|group| strings(group)).collect()
    }

    // ── 단계 표 ──

    #[test]
    fn the_template_plan_reads_as_written() {
        let plan = plan_of(TEMPLATE_PLAN);
        assert_eq!(plan.phases.len(), 2);
        let p0 = &plan.phases[0];
        assert_eq!(p0.id, "P0");
        assert_eq!(p0.summary, "셋업 · 기획 확정");
        assert_eq!(p0.owners, owners(&[&["직접"]]));
        assert_eq!(p0.owners_text, "직접");
        assert_eq!(p0.gate, "기획 승인");
        assert_eq!(
            (p0.status, p0.status_text.as_str()),
            (PhaseStatus::Todo, "")
        );
        assert_eq!((p0.name.as_deref(), p0.goal.as_deref()), (None, None));
        let p1 = &plan.phases[1];
        assert_eq!(p1.summary, "");
        assert_eq!(p1.owners, owners(&[&["ui"]]));
        assert_eq!(p1.status, PhaseStatus::Todo);
        // 단계 상세 절은 있는데 `- 목표:` 가 비어 있다
        assert_eq!(p1.name.as_deref(), Some("<단계 이름>"));
        assert_eq!(p1.goal, None);
    }

    #[test]
    fn messy_plan_rows_are_read_one_by_one() {
        let plan = plan_of(MESSY_PLAN);
        let ids: Vec<&str> = plan.phases.iter().map(|p| p.id.as_str()).collect();
        // `P2-T` · 설명 줄은 단계가 아니고, 같은 번호는 처음 것만
        assert_eq!(ids, ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
        let by = |id: &str| plan.phases.iter().find(|p| p.id == id).unwrap();

        assert_eq!(
            (by("P0").status, by("P0").status_text.as_str()),
            (PhaseStatus::Done, "완료 (2026-01-01)")
        );
        // 굵게 · 백틱은 벗긴다
        assert_eq!(by("P1").summary, "굵은 내용");
        assert_eq!(by("P1").owners, owners(&[&["system"]]));
        assert_eq!(
            (by("P1").status, by("P1").status_text.as_str()),
            (PhaseStatus::Done, "완료 (2026-01-02) — 요약")
        );
        assert_eq!(by("P2").gate, "시안 고르기 · 그림 확인");
        assert_eq!(by("P2").status_text, "완료 — 시안 a");
        // 진행 중
        assert_eq!(by("P3").status, PhaseStatus::Now);
        assert_eq!(
            by("P3").owners,
            owners(&[&["system"], &["tester"], &["reviewer"]])
        );
        // 칸 안의 이스케이프 안 된 `|` — 다섯째부터 끝까지가 상태 한 칸
        assert_eq!(by("P4").status, PhaseStatus::Done);
        assert_eq!(
            by("P4").status_text,
            "완료 (2026-01-09) — 작업 공간 [채팅 | 요구사항] 탭 · 카드"
        );
        assert_eq!(by("P4").owners, owners(&[&["ui", "system"]]));
        // 끝의 `|` 가 없고 상태 칸도 없다
        assert_eq!(by("P5").gate, "실행 확인");
        assert_eq!(
            (by("P5").status, by("P5").status_text.as_str()),
            (PhaseStatus::Todo, "")
        );
        assert_eq!(by("P5").owners, owners(&[&["system"], &["reviewer"]]));
        // 약속 밖 상태 글은 그대로 두고 상태는 모름
        assert_eq!(
            (by("P6").status, by("P6").status_text.as_str()),
            (PhaseStatus::Unknown, "보류 중")
        );
        assert_eq!(
            by("P6").owners,
            owners(&[&["reviewer", "tester"], &["고침은 담당별"]])
        );
        assert_eq!(by("P6").owners_text, "reviewer · tester → 고침은 담당별");
        // 모든 칸이 빈 단계도 단계다
        assert_eq!(by("P7").status, PhaseStatus::Todo);
        assert!(by("P7").owners.is_empty());
        // `\\|` 는 칸 안의 `|` 글자
        assert_eq!(by("P8").status_text, "완료 | 끝");
        // 같은 번호가 또 나와도 처음 행이 남는다
        assert_eq!(by("P1").summary, "굵은 내용");
    }

    #[test]
    fn plan_details_attach_a_name_and_a_goal_line() {
        let plan = plan_of(MESSY_PLAN);
        let by = |id: &str| plan.phases.iter().find(|p| p.id == id).unwrap();
        assert_eq!(by("P1").name.as_deref(), Some("앱 뼈대"));
        assert_eq!(by("P1").goal.as_deref(), Some("빈 앱이 뜬다."));
        // `**목표**:` 도 읽고, 같은 번호의 둘째 절은 무시한다
        assert_eq!(by("P3").name.as_deref(), Some("Claude 연결"));
        assert_eq!(by("P3").goal.as_deref(), Some("대화 세션을 연다."));
        // 이름만 있는 절 · 절이 없는 단계
        assert_eq!(by("P6").name.as_deref(), Some("이름만 있는 절"));
        assert_eq!(by("P6").goal, None);
        assert_eq!(
            (by("P0").name.as_deref(), by("P0").goal.as_deref()),
            (None, None)
        );
    }

    #[test]
    fn plan_status_words() {
        let status = |text: &str| {
            let plan = plan_of(&format!(
                "## 단계 개요\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P0 | a | b | c | {text} |\n"
            ));
            plan.phases[0].status
        };
        assert_eq!(status(""), PhaseStatus::Todo);
        assert_eq!(status("완료"), PhaseStatus::Done);
        assert_eq!(status("**완료 (2026-10-18)** — 요약"), PhaseStatus::Done);
        assert_eq!(status("진행 중"), PhaseStatus::Now);
        assert_eq!(status("진행 중 (2026-11-07) — 탭"), PhaseStatus::Now);
        assert_eq!(status("진행중"), PhaseStatus::Now);
        assert_eq!(status("보류"), PhaseStatus::Unknown);
        assert_eq!(status("다음에 완료"), PhaseStatus::Unknown);
    }

    #[test]
    fn a_different_header_is_unreadable() {
        for header in [
            "| 단계 | 내용 | 담당 | 상태 |",               // 승인 게이트 칸 없음
            "| 단계 | 내용 | 담당 | 승인 게이트 |",        // 상태 칸 없음
            "| Phase | Summary | Owner | Gate | Status |", // 영어
            "| 내용 | 단계 | 담당 | 승인 게이트 | 상태 |", // 순서
            "| 단계 | 내용 | 담당 | 승인 게이트 | 상태 | 비고 |", // 열이 더 있다
        ] {
            let text =
                format!("## 단계 개요\n{header}\n|---|---|---|---|---|\n| P0 | a | b | c | d |\n");
            assert_eq!(parse_plan(&text), Err(Reason::HeaderMismatch), "{header}");
        }
        // 머리 줄의 `**` 는 지우고 본다
        let bold = "## 단계 개요\n| **단계** | **내용** | **담당** | **승인 게이트** | **상태** |\n|---|---|---|---|---|\n| P0 | a | b | c | d |\n";
        assert_eq!(plan_of(bold).phases.len(), 1);
    }

    #[test]
    fn a_plan_without_a_table_is_unreadable_with_the_reason() {
        assert_eq!(parse_plan(""), Err(Reason::NoSection));
        assert_eq!(parse_plan("\n\n  \n"), Err(Reason::NoSection));
        assert_eq!(parse_plan("# 계획\n\n내용 없음\n"), Err(Reason::NoSection));
        assert_eq!(
            parse_plan("## 단계 개요\n\n표가 아직 없다.\n"),
            Err(Reason::NoTable)
        );
        // 구분 줄이 없으면 표가 아니다
        assert_eq!(
            parse_plan(
                "## 단계 개요\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n| P0 | a | b | c | d |\n"
            ),
            Err(Reason::NoTable)
        );
        // 다른 절의 표는 보지 않는다
        assert_eq!(
            parse_plan(
                "## 작업 규칙\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P0 | a | b | c | d |\n"
            ),
            Err(Reason::NoSection)
        );
        // 코드 울타리 안의 제목 · 표는 읽지 않는다
        assert_eq!(
            parse_plan(
                "```\n## 단계 개요\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P0 | a | b | c | d |\n```\n"
            ),
            Err(Reason::NoSection)
        );
    }

    #[test]
    fn a_table_with_a_header_and_no_rows_is_an_empty_plan() {
        let plan = plan_of(
            "## 단계 개요\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n",
        );
        assert!(plan.phases.is_empty());
    }

    #[test]
    fn the_first_table_under_the_heading_is_the_plan_table() {
        let text = "## 단계 개요\n\n앞 글.\n\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P0 | 첫 표 | 직접 | 승인 | |\n\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P9 | 둘째 표 | 직접 | 승인 | |\n";
        let plan = plan_of(text);
        assert_eq!(plan.phases.len(), 1);
        assert_eq!(plan.phases[0].summary, "첫 표");
    }

    #[test]
    fn crlf_and_lf_read_the_same() {
        assert_eq!(
            plan_of(&MESSY_PLAN.replace('\n', "\r\n")),
            plan_of(MESSY_PLAN)
        );
        assert_eq!(
            handoff_of(&MESSY_HANDOFF.replace('\n', "\r\n")),
            handoff_of(MESSY_HANDOFF)
        );
        assert_eq!(
            plan_of(&TEMPLATE_PLAN.replace('\n', "\r\n")),
            plan_of(TEMPLATE_PLAN)
        );
    }

    // ── 이어 하기 메모 ──

    #[test]
    fn the_template_handoff_reads_as_written() {
        let handoff = handoff_of(TEMPLATE_HANDOFF);
        assert_eq!(
            handoff.skill.as_deref(),
            Some("<web-full | web-lite | desktop-app>")
        );
        assert_eq!(handoff.requirements.as_deref(), Some("<경로>"));
        assert_eq!(
            handoff.phase.as_deref(),
            Some("<P2 — 목록 화면> (dev-plan.md)")
        );
        assert_eq!(handoff.updated.as_deref(), Some("YYYY-MM-DD HH:MM"));
        // 자리 표시 글은 약속 낱말이 아니다 — 상태는 모름, 글은 그대로
        let Section::Ok { value } = &handoff.current else {
            panic!("current");
        };
        assert_eq!(value.state, NowState::Unknown);
        assert!(value.text.starts_with("<하나만:"));
        // 지시서 칸이 자리 표시(`<…>`)라 경로가 아니다
        let tasks = tasks_of(&handoff);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].brief, None);
        assert_eq!(tasks[0].id, None);
        assert_eq!(tasks[0].label, "briefs/<P2-03-목록화면>.md");
        assert_eq!(tasks[0].owner, "<ui>");
        assert_eq!(tasks[0].status, TaskStatus::Assigned);
        // 글머리는 "<질문 · 승인 …>" 하나, 번호 목록의 항목은 비어 있다
        let Section::Ok { value } = &handoff.waiting else {
            panic!("waiting");
        };
        assert_eq!(value.len(), 1);
        assert_eq!(handoff.next, Section::Ok { value: vec![] });
    }

    #[test]
    fn messy_handoff_header_values_take_the_first_line() {
        let handoff = handoff_of(MESSY_HANDOFF);
        assert_eq!(handoff.skill.as_deref(), Some("desktop-app"));
        assert_eq!(
            handoff.requirements.as_deref(),
            Some("requirements.md (프로젝트 루트, 고치지 않음)")
        );
        // 값이 하위 글머리에 있으면 그 첫 줄
        assert_eq!(
            handoff.phase.as_deref(),
            Some("P7 진행 보기 — 진행 중 (2026-11-07 승인), 배치 탭")
        );
        assert_eq!(handoff.updated.as_deref(), Some("2026-11-07"));
    }

    #[test]
    fn the_current_state_reads_the_first_line_and_maps_the_words() {
        let handoff = handoff_of(MESSY_HANDOFF);
        assert_eq!(
            handoff.current,
            Section::Ok {
                value: NowInfo {
                    state: NowState::Working,
                    text: "작업자 일하는 중 — P7-01 (system, 2026-11-07) — 설명이 이어진다.".into(),
                }
            }
        );
        let state_of = |first: &str| {
            let text = format!("## 지금 상태\n\n{first}\n\n## 다음 할 일\n\n1. 가\n");
            match handoff_of(&text).current {
                Section::Ok { value } => (value.state, value.text),
                other => panic!("{other:?}"),
            }
        };
        assert_eq!(state_of("작업자 일하는 중").0, NowState::Working);
        assert_eq!(state_of("검수 중 — P7-01").0, NowState::Reviewing);
        assert_eq!(state_of("사용자 답 기다림").0, NowState::WaitingAnswer);
        assert_eq!(state_of("실행 확인 기다림 (P7)").0, NowState::WaitingRun);
        assert_eq!(state_of("단계 사이").0, NowState::Between);
        // 글머리 · 굵게가 붙어도 낱말로 시작하면 읽는다
        assert_eq!(state_of("- **검수 중** — 2차").0, NowState::Reviewing);
        assert_eq!(state_of("1. 단계 사이").0, NowState::Between);
        // 약속 낱말이 아닌 글은 그대로, 상태는 모름
        assert_eq!(
            state_of("**P6 완료 (2026-11-07)** — 연습 폴더 확인"),
            (
                NowState::Unknown,
                "P6 완료 (2026-11-07) — 연습 폴더 확인".into()
            )
        );
        assert_eq!(state_of("쉬는 중").0, NowState::Unknown);
    }

    #[test]
    fn handoff_tasks_read_the_first_three_cells_of_every_row() {
        let handoff = handoff_of(MESSY_HANDOFF);
        let tasks = tasks_of(&handoff);
        let by_label = |label: &str| tasks.iter().find(|t| t.label == label).unwrap();

        let p701 = by_label("briefs/P7-01-docs.md");
        assert_eq!(p701.brief.as_deref(), Some("briefs/P7-01-docs.md"));
        assert_eq!(p701.id.as_deref(), Some("P7-01"));
        assert_eq!(p701.phase.as_deref(), Some("P7"));
        assert_eq!(p701.owner, "system");
        assert_eq!(p701.status, TaskStatus::Assigned);
        assert_eq!(p701.status_text, "맡김 (2026-11-07)");

        // 설명이 붙은 상태 · `<n>차` 접두
        assert_eq!(by_label("briefs/P6-12-cards.md").status, TaskStatus::Passed);
        let second = by_label("briefs/P6-11-fixes.md");
        assert_eq!(second.status, TaskStatus::Passed);
        assert_eq!(
            second.status_text, "2차 검수 통과 — 지시서 끝",
            "원래 글은 그대로"
        );
        assert_eq!(
            by_label("briefs/P3-02-session.md").status,
            TaskStatus::Passed
        );
        assert_eq!(
            by_label("briefs/P3-02-session.md").status_text,
            "1차 검수 통과"
        );
        // 약속 낱말로 시작하지 않으면 모름 + 글 그대로
        let ended = by_label("briefs/P6-09-review.md");
        assert_eq!(ended.status, TaskStatus::Unknown);
        assert_eq!(ended.status_text, "끝 — 고객 고름 (실패함만 저장)");
        // 3칸뿐인 줄 · 끝의 `|` 가 없는 줄
        assert_eq!(by_label("briefs/P2-11-theme.md").status, TaskStatus::Passed);
        assert_eq!(by_label("briefs/P2-05-art.md").status, TaskStatus::Passed);
        assert_eq!(by_label("briefs/P2-05-art.md").owner, "system");
        // 경로가 없는 줄은 글만 있다
        let label_only = by_label("(P2-01 ~ P2-03 검수 통과 — 지시서 끝)");
        assert_eq!(
            (label_only.brief.as_deref(), label_only.id.as_deref()),
            (None, None)
        );
        assert_eq!(label_only.owner, "");
        assert_eq!(label_only.status, TaskStatus::Unknown);
        assert_eq!(label_only.status_text, "");
        // 다시 맡김은 맡김이 아니다
        assert_eq!(by_label("briefs/P8-01-redo.md").status, TaskStatus::Redo);
        assert_eq!(
            by_label("briefs/P9-03-gone.md").status,
            TaskStatus::Assigned
        );
        // 이 줄들은 `briefs/<이름>.md` 가 아니다 — `brief` 는 없다
        for label in [
            "briefs/../secret.md",
            "briefs/sub/x.md",
            "briefs\\P8-02-win.md",
        ] {
            assert_eq!(by_label(label).brief, None, "{label}");
            assert_eq!(by_label(label).id, None, "{label}");
        }
        assert_eq!(tasks.len(), 13);
    }

    #[test]
    fn brief_paths_and_ids() {
        assert_eq!(brief_path("briefs/a.md").as_deref(), Some("briefs/a.md"));
        assert_eq!(
            brief_path("briefs/한글 이름.MD").as_deref(),
            Some("briefs/한글 이름.MD")
        );
        for bad in [
            "a.md",
            "briefs/",
            "briefs/.md",
            "briefs/a.txt",
            "briefs/../a.md",
            "briefs/./a.md",
            "briefs/x/a.md",
            "briefs//a.md",
            "/briefs/a.md",
            "docs/briefs/a.md",
            "Briefs/a.md",
            "briefs/a.md ",
            "briefs/a:b.md",
            "briefs/.hidden.md",
            "briefs/CON.md",
            "C:/briefs/a.md",
            "briefs\\a.md",
            "../briefs/a.md",
        ] {
            assert_eq!(brief_path(bad), None, "{bad}");
        }
        assert_eq!(
            brief_id("briefs/P7-01-project-docs.md").as_deref(),
            Some("P7-01")
        );
        assert_eq!(brief_id("briefs/P10-12-x.md").as_deref(), Some("P10-12"));
        assert_eq!(brief_id("briefs/P2-T-theme.md"), None);
        assert_eq!(brief_id("briefs/notes.md"), None);
        assert_eq!(brief_id("briefs/P7.md"), None);
        assert_eq!(brief_id("briefs/P-01.md"), None);
    }

    #[test]
    fn the_waiting_list_and_the_next_list() {
        let handoff = handoff_of(MESSY_HANDOFF);
        // `없음 (…)` 은 기다리는 것이 없다는 뜻
        assert_eq!(handoff.waiting, Section::Ok { value: vec![] });
        // 번호 목록은 항목마다 한 줄 (하위 글머리는 항목이 아니다)
        assert_eq!(
            handoff.next,
            Section::Ok {
                value: strings(&[
                    "P7-01 검수.",
                    "P7-02 지시서 (먼저 실제 CLI 로 녹화)",
                    "P7-03 · P7-04"
                ])
            }
        );
        let with_items = handoff_of(
            "## 사용자에게 기다리는 것\n\n- **P7 승인**: 배치를 골라 주세요\n- 없음\n- 실행 확인\n\n## 다음 할 일\n\n(없음)\n",
        );
        assert_eq!(
            with_items.waiting,
            Section::Ok {
                value: strings(&["P7 승인: 배치를 골라 주세요", "실행 확인"])
            }
        );
        // 글은 있는데 번호 목록이 아니면 읽을 수 없음
        assert_eq!(
            with_items.next,
            Section::Unreadable {
                reason: Reason::NoItem
            }
        );
        // 비어 있는 절은 빈 목록
        let empty = handoff_of("## 사용자에게 기다리는 것\n\n## 다음 할 일\n");
        assert_eq!(empty.waiting, Section::Ok { value: vec![] });
        assert_eq!(empty.next, Section::Ok { value: vec![] });
        // `없음` 으로 시작하는 낱말(없음에도 …)은 "없다" 가 아니다
        assert!(!means_nothing("없음에도 확인 필요"));
        assert!(means_nothing("없음"));
        assert!(means_nothing("없음 (설명)"));
        assert!(means_nothing("없음."));
    }

    #[test]
    fn one_broken_section_does_not_hide_the_others() {
        // 작업 표 머리가 다르다 — 나머지 절은 읽힌다
        let text = "- 스킬: `web-lite`\n\n## 지금 상태\n\n검수 중\n\n## 진행 중인 작업\n\n| Brief | Owner | State |\n|---|---|---|\n| a | b | c |\n\n## 사용자에게 기다리는 것\n\n- 승인\n\n## 다음 할 일\n\n1. 하나\n";
        let handoff = handoff_of(text);
        assert_eq!(handoff.skill.as_deref(), Some("web-lite"));
        assert!(matches!(handoff.current, Section::Ok { .. }));
        assert_eq!(
            handoff.tasks,
            Section::Unreadable {
                reason: Reason::HeaderMismatch
            }
        );
        assert_eq!(
            handoff.waiting,
            Section::Ok {
                value: strings(&["승인"])
            }
        );
        assert_eq!(
            handoff.next,
            Section::Ok {
                value: strings(&["하나"])
            }
        );

        // 작업 절에 표가 없다 · 절이 없다 · 지금 상태 절이 비었다
        let text = "## 지금 상태\n\n## 진행 중인 작업\n\n아직 없다.\n\n## 다음 할 일\n\n1. 하나\n";
        let handoff = handoff_of(text);
        assert_eq!(
            handoff.current,
            Section::Unreadable {
                reason: Reason::NoItem
            }
        );
        assert_eq!(
            handoff.tasks,
            Section::Unreadable {
                reason: Reason::NoTable
            }
        );
        assert_eq!(
            handoff.waiting,
            Section::Unreadable {
                reason: Reason::NoSection
            }
        );
        assert_eq!(
            handoff.next,
            Section::Ok {
                value: strings(&["하나"])
            }
        );
        assert_eq!(
            (
                &handoff.skill,
                &handoff.requirements,
                &handoff.phase,
                &handoff.updated
            ),
            (&None, &None, &None, &None)
        );
    }

    #[test]
    fn a_task_table_only_needs_its_first_three_columns() {
        let text = "## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n| `briefs/P1-01-a.md` | ui | 돌아옴 |\n";
        let handoff = handoff_of(text);
        assert_eq!(tasks_of(&handoff)[0].status, TaskStatus::Back);
        // 표 아래의 설명 글머리는 행이 아니다
        let text = "## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 | 맡길 때 git | 보고 |\n|---|---|---|---|---|\n| `briefs/P1-01-a.md` | ui | 맡김 | x | y |\n\n- 상태: `맡김` → `돌아옴`\n";
        assert_eq!(tasks_of(&handoff_of(text)).len(), 1);
        // 줄이 다 빈 행은 건너뛴다
        let text =
            "## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n| | | |\n|  |  |  |\n";
        assert!(tasks_of(&handoff_of(text)).is_empty());
    }

    #[test]
    fn a_memo_with_nothing_known_is_unreadable() {
        assert_eq!(parse_handoff(""), Err(Reason::NoSection));
        assert_eq!(parse_handoff("   \n\n"), Err(Reason::NoSection));
        assert_eq!(
            parse_handoff("# 다른 문서\n\n## 개요\n\n- 아무 글\n"),
            Err(Reason::NoSection)
        );
        // 머리 목록 하나만 있어도 읽는다 (절은 모두 "절 없음")
        let only_head = handoff_of("- 스킬: `web-lite`\n");
        assert_eq!(only_head.skill.as_deref(), Some("web-lite"));
        assert_eq!(
            only_head.current,
            Section::Unreadable {
                reason: Reason::NoSection
            }
        );
        // 울타리 안의 절은 읽지 않는다
        assert_eq!(
            parse_handoff("```\n## 지금 상태\n\n검수 중\n```\n"),
            Err(Reason::NoSection)
        );
    }

    // ── 지시서 진행률 ──

    #[test]
    fn counts_checkbox_lines() {
        let text = "# 지시서\n\n- [ ] 하나\n- [x] 둘\n- [X] 셋\n  - [ ] 들여쓴 것도\n* [x] 별표도\n- [] 칸이 비었다\n- [y] 모르는 표시\n- [x]붙여 쓴 글\n- [ ]\n\n```\n- [ ] 울타리 안\n- [x] 울타리 안\n```\n\n문장 속 `- [ ]` 는 아니다. 작업자는 `[ ]` 를 `[x]` 로 바꾼다.\n- [ ] 끝\n";
        // 세는 줄: `[ ]` 하나 · 들여쓴 것 · 끝 = 3, `[x]` 둘 · 셋 · 별표 = 3, `- [ ]` (글 없음) 도 칸이다 → 전체 7
        assert_eq!(count_checks(text), TaskProgress { done: 3, total: 7 });
        assert_eq!(count_checks(""), TaskProgress { done: 0, total: 0 });
        assert_eq!(
            count_checks("글만 있다\n"),
            TaskProgress { done: 0, total: 0 }
        );
    }

    // ── 파일 · 폴더 ──

    /// 프로젝트 폴더 (`docs/02-development/` 가 있는)
    fn project() -> TempDir {
        let dir = TempDir::new("progress");
        fs::create_dir_all(dir.join("docs").join("02-development").join("briefs")).unwrap();
        dir
    }

    fn put(project: &Path, rel: &str, bytes: &[u8]) {
        let path = project.join("docs").join("02-development").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn read_project(project: &Path) -> ProgressResult {
        read_in(project, "docs", SystemTime::now())
    }

    #[test]
    fn nothing_yet_means_absent_for_both_files() {
        let dir = TempDir::new("progress-none");
        let result = read_in(&dir, "docs", SystemTime::now());
        assert_eq!(result.plan, PlanResult::Absent);
        assert_eq!(result.handoff, HandoffResult::Absent);
        // docs 는 있는데 02-development 가 없다
        fs::create_dir_all(dir.join("docs")).unwrap();
        let result = read_in(&dir, "docs", SystemTime::now());
        assert_eq!(
            (result.plan, result.handoff),
            (PlanResult::Absent, HandoffResult::Absent)
        );
        // 파일 하나만 있다
        put(&dir, "handoff.md", MESSY_HANDOFF.as_bytes());
        let result = read_in(&dir, "docs", SystemTime::now());
        assert_eq!(result.plan, PlanResult::Absent);
        assert!(matches!(result.handoff, HandoffResult::Ok(_)));
    }

    #[test]
    fn a_missing_project_folder_is_unreadable() {
        let dir = TempDir::new("progress-gone");
        let result = read_in(&dir.join("not-here"), "docs", SystemTime::now());
        let expected = ReasonInfo {
            reason: Reason::FolderMissing,
        };
        assert_eq!(result.plan, PlanResult::Unreadable(expected.clone()));
        assert_eq!(result.handoff, HandoffResult::Unreadable(expected));
    }

    #[test]
    fn files_are_read_with_a_bom_and_crlf() {
        let dir = project();
        let mut plan = vec![0xEF, 0xBB, 0xBF];
        plan.extend_from_slice(MESSY_PLAN.replace('\n', "\r\n").as_bytes());
        put(&dir, "dev-plan.md", &plan);
        let mut memo = vec![0xEF, 0xBB, 0xBF];
        memo.extend_from_slice(MESSY_HANDOFF.replace('\n', "\r\n").as_bytes());
        put(&dir, "handoff.md", &memo);
        let result = read_project(&dir);
        let PlanResult::Ok(read_plan) = result.plan else {
            panic!("plan");
        };
        assert_eq!(read_plan, plan_of(MESSY_PLAN));
        let HandoffResult::Ok(read_memo) = result.handoff else {
            panic!("handoff");
        };
        assert_eq!(read_memo.skill.as_deref(), Some("desktop-app"));
    }

    #[test]
    fn unreadable_files_say_why_and_do_not_hide_the_other_file() {
        let dir = project();
        // UTF-8 이 아닌 단계 표 · 정상 메모
        put(&dir, "dev-plan.md", &[0xC7, 0xD1, 0xB1, 0xDB]);
        put(&dir, "handoff.md", MESSY_HANDOFF.as_bytes());
        let result = read_project(&dir);
        assert_eq!(
            result.plan,
            PlanResult::Unreadable(ReasonInfo {
                reason: Reason::NotUtf8
            })
        );
        assert!(matches!(result.handoff, HandoffResult::Ok(_)));
        // 1MB 를 넘는 메모 · 빈 단계 표 파일
        let big = vec![b'a'; requirements::MAX_BYTES as usize + 1];
        put(&dir, "handoff.md", &big);
        put(&dir, "dev-plan.md", b"");
        let result = read_project(&dir);
        assert_eq!(
            result.handoff,
            HandoffResult::Unreadable(ReasonInfo {
                reason: Reason::TooLarge
            })
        );
        assert_eq!(
            result.plan,
            PlanResult::Unreadable(ReasonInfo {
                reason: Reason::NoSection
            })
        );
        // 표가 없는 단계 표 · 아는 절이 없는 메모
        put(
            &dir,
            "dev-plan.md",
            "## 단계 개요\n\n(작성 중)\n".as_bytes(),
        );
        put(&dir, "handoff.md", "# 메모\n\n그냥 글\n".as_bytes());
        let result = read_project(&dir);
        assert_eq!(
            result.plan,
            PlanResult::Unreadable(ReasonInfo {
                reason: Reason::NoTable
            })
        );
        assert_eq!(
            result.handoff,
            HandoffResult::Unreadable(ReasonInfo {
                reason: Reason::NoSection
            })
        );
        // 파일 자리에 폴더가 있다
        fs::remove_file(dir.join("docs").join("02-development").join("handoff.md")).unwrap();
        fs::create_dir_all(dir.join("docs").join("02-development").join("handoff.md")).unwrap();
        assert_eq!(
            read_project(&dir).handoff,
            HandoffResult::Unreadable(ReasonInfo {
                reason: Reason::NotAFile
            })
        );
    }

    #[test]
    fn a_folder_link_that_leaves_docs_is_never_read() {
        let outside = TempDir::new("progress-out");
        fs::write(outside.join("dev-plan.md"), MESSY_PLAN).unwrap();
        fs::write(outside.join("handoff.md"), MESSY_HANDOFF).unwrap();
        // 02-development 자체가 밖으로 가는 정션
        let dir = TempDir::new("progress-link");
        fs::create_dir_all(dir.join("docs")).unwrap();
        must_link(
            make_dir_link(&outside, &dir.join("docs").join("02-development")),
            "a directory link (junction)",
        );
        let result = read_project(&dir);
        let expected = ReasonInfo {
            reason: Reason::OutsideFolder,
        };
        assert_eq!(result.plan, PlanResult::Unreadable(expected.clone()));
        assert_eq!(result.handoff, HandoffResult::Unreadable(expected.clone()));
        // briefs 폴더만 밖으로 가는 정션 — 지시서는 읽지 않는다
        let dir = project();
        let secret = TempDir::new("progress-secret");
        fs::write(secret.join("P7-01-secret.md"), "- [x] a\n- [x] b\n").unwrap();
        fs::remove_dir(dir.join("docs").join("02-development").join("briefs")).unwrap();
        must_link(
            make_dir_link(
                &secret,
                &dir.join("docs").join("02-development").join("briefs"),
            ),
            "a directory link (junction)",
        );
        put(
            &dir,
            "handoff.md",
            "## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n| `briefs/P7-01-secret.md` | system | 맡김 |\n".as_bytes(),
        );
        let HandoffResult::Ok(handoff) = read_project(&dir).handoff else {
            panic!("handoff");
        };
        assert_eq!(tasks_of(&handoff)[0].progress, None);
    }

    #[test]
    fn brief_progress_counts_open_work_and_skips_finished_or_unsafe_paths() {
        let dir = project();
        put(
            &dir,
            "briefs/P7-01-docs.md",
            "- [x] a\n- [x] b\n- [ ] c\n".as_bytes(),
        );
        put(&dir, "briefs/P7-02-redo.md", "- [ ] a\n".as_bytes());
        put(&dir, "briefs/P7-03-back.md", "- [x] a\n".as_bytes());
        put(
            &dir,
            "briefs/P7-04-unknown.md",
            "- [x] a\n- [x] b\n".as_bytes(),
        );
        put(&dir, "briefs/P7-05-empty.md", "체크 항목 없음\n".as_bytes());
        put(
            &dir,
            "briefs/P6-01-passed.md",
            "- [x] a\n- [x] b\n".as_bytes(),
        );
        put(&dir, "briefs/P7-06-binary.md", &[0xC7, 0xD1]);
        // `briefs/` 밖의 파일 — 메모가 가리켜도 읽지 않는다
        put(&dir, "secret.md", "- [x] a\n- [x] b\n- [x] c\n".as_bytes());
        put(
            &dir,
            "handoff.md",
            "## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n\
| `briefs/P7-01-docs.md` | system | 맡김 |\n\
| `briefs/P7-02-redo.md` | system | 다시 맡김 |\n\
| `briefs/P7-03-back.md` | system | 돌아옴 |\n\
| `briefs/P7-04-unknown.md` | system | 끝 — 설명 |\n\
| `briefs/P7-05-empty.md` | system | 맡김 |\n\
| `briefs/P6-01-passed.md` | system | 검수 통과 |\n\
| `briefs/P7-06-binary.md` | system | 맡김 |\n\
| `briefs/P7-07-missing.md` | system | 맡김 |\n\
| `briefs/../secret.md` | system | 맡김 |\n\
| `../secret.md` | system | 맡김 |\n\
| `briefs/sub/../../secret.md` | system | 맡김 |\n"
                .as_bytes(),
        );
        let HandoffResult::Ok(handoff) = read_project(&dir).handoff else {
            panic!("handoff");
        };
        let progress: Vec<Option<(u32, u32)>> = tasks_of(&handoff)
            .iter()
            .map(|task| task.progress.map(|p| (p.done, p.total)))
            .collect();
        assert_eq!(
            progress,
            [
                Some((2, 3)), // 맡김
                Some((0, 1)), // 다시 맡김
                Some((1, 1)), // 돌아옴
                Some((2, 2)), // 모르는 상태도 읽는다
                Some((0, 0)), // 체크 항목이 없다
                None,         // 검수 통과 — 읽지 않는다 (파일은 있다)
                None,         // UTF-8 이 아님
                None,         // 파일이 없다
                None,         // 경로가 아님
                None,
                None,
            ]
        );
    }

    #[test]
    fn at_most_forty_briefs_are_read_per_call() {
        let dir = project();
        let mut rows = String::new();
        for n in 0..50 {
            put(&dir, &format!("briefs/P7-{n:02}-x.md"), b"- [x] a\n");
            rows.push_str(&format!("| `briefs/P7-{n:02}-x.md` | system | 맡김 |\n"));
        }
        put(
            &dir,
            "handoff.md",
            format!("## 진행 중인 작업\n\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n{rows}")
                .as_bytes(),
        );
        let HandoffResult::Ok(handoff) = read_project(&dir).handoff else {
            panic!("handoff");
        };
        let read = tasks_of(&handoff)
            .iter()
            .filter(|task| task.progress.is_some())
            .count();
        assert_eq!(read, MAX_BRIEF_READS);
        assert_eq!(tasks_of(&handoff).len(), 50);
    }

    // ── version ──

    fn later() -> SystemTime {
        // 방금 만든 파일의 수정 시각이 "최근" 이 아니게 먼 앞의 시각
        SystemTime::now() + Duration::from_secs(3600)
    }

    #[test]
    fn the_version_is_stable_and_changes_when_a_file_changes() {
        let dir = project();
        put(&dir, "dev-plan.md", b"plan");
        put(&dir, "handoff.md", b"memo");
        put(&dir, "briefs/P1-01-a.md", b"- [ ] x\n");
        let at = later();
        let base = version_in(&dir, "docs", at);
        assert_eq!(base, version_in(&dir, "docs", at), "변하지 않으면 같다");
        // 크기가 바뀐다
        put(&dir, "handoff.md", b"memo2");
        let after_memo = version_in(&dir, "docs", at);
        assert_ne!(base, after_memo);
        put(&dir, "dev-plan.md", b"plan!");
        let after_plan = version_in(&dir, "docs", at);
        assert_ne!(after_memo, after_plan);
        put(&dir, "briefs/P1-01-a.md", b"- [ ] x\n- [ ] y\n");
        let after_brief = version_in(&dir, "docs", at);
        assert_ne!(after_plan, after_brief);
        // 지시서가 생기고 사라진다
        put(&dir, "briefs/P1-02-b.md", b"x");
        let added = version_in(&dir, "docs", at);
        assert_ne!(after_brief, added);
        fs::remove_file(
            dir.join("docs")
                .join("02-development")
                .join("briefs")
                .join("P1-02-b.md"),
        )
        .unwrap();
        assert_eq!(version_in(&dir, "docs", at), after_brief);
        // `.md` 가 아닌 파일 · 다른 폴더의 파일은 보지 않는다
        put(&dir, "briefs/notes.txt", b"x");
        put(&dir, "other.md", b"x");
        assert_eq!(version_in(&dir, "docs", at), after_brief);
    }

    #[test]
    fn the_version_changes_when_only_the_modified_time_changes() {
        let dir = project();
        put(&dir, "handoff.md", b"memo");
        let at = later();
        let before = version_in(&dir, "docs", at);
        let file = fs::OpenOptions::new()
            .write(true)
            .open(dir.join("docs").join("02-development").join("handoff.md"))
            .unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(3000))
            .unwrap();
        drop(file);
        assert_ne!(
            before,
            version_in(&dir, "docs", at),
            "크기가 같아도 시각이 다르면 다르다"
        );
    }

    #[test]
    fn a_file_just_modified_makes_the_version_differ_every_time_until_it_settles() {
        let dir = project();
        put(&dir, "handoff.md", b"memo");
        let now = SystemTime::now();
        let first = version_in(&dir, "docs", now);
        let second = version_in(&dir, "docs", now + Duration::from_millis(5));
        assert_ne!(
            first, second,
            "시각 해상도가 거친 곳에서 같은 크기로 고친 것을 놓치지 않는다"
        );
        // 충분히 지나면 고정
        let settled = now + Duration::from_secs(10);
        assert_eq!(
            version_in(&dir, "docs", settled),
            version_in(&dir, "docs", settled + Duration::from_secs(5))
        );
    }

    #[test]
    fn the_version_does_not_read_the_files_or_fail_on_bad_ones() {
        let dir = project();
        // UTF-8 이 아닌 파일 · 1MB 가 넘는 파일 · 폴더 · 없는 폴더에서도 값이 나온다
        put(&dir, "dev-plan.md", &[0xC7, 0xD1]);
        put(
            &dir,
            "handoff.md",
            &vec![b'a'; requirements::MAX_BYTES as usize + 10],
        );
        let at = later();
        assert!(!version_in(&dir, "docs", at).is_empty());
        let nothing = TempDir::new("progress-version-none");
        assert!(!version_in(&nothing, "docs", at).is_empty());
        assert!(!version_in(&nothing.join("gone"), "docs", at).is_empty());
        // 하네스가 생기면 값이 달라진다
        let before = version_in(&nothing, "docs", at);
        fs::create_dir_all(nothing.join("docs").join("02-development")).unwrap();
        fs::write(
            nothing
                .join("docs")
                .join("02-development")
                .join("handoff.md"),
            "x",
        )
        .unwrap();
        assert_ne!(before, version_in(&nothing, "docs", at));
    }

    // ── 화면으로 가는 JSON 모양 (`src/lib/ipc-types.ts` 와 같아야 한다) ──

    #[test]
    fn the_json_the_screen_gets_has_the_documented_shape() {
        let dir = project();
        put(&dir, "dev-plan.md", MESSY_PLAN.as_bytes());
        put(&dir, "handoff.md", MESSY_HANDOFF.as_bytes());
        put(
            &dir,
            "briefs/P7-01-docs.md",
            b"- [x] a
- [ ] b
",
        );
        let json = serde_json::to_value(read_project(&dir)).unwrap();
        assert!(json["version"].is_string());
        assert_eq!(json["plan"]["state"], "ok");
        let p4 = &json["plan"]["phases"][4];
        assert_eq!(p4["id"], "P4");
        assert_eq!(p4["status"], "done");
        assert_eq!(p4["ownersText"], "ui · system");
        assert_eq!(p4["owners"], serde_json::json!([["ui", "system"]]));
        assert!(p4["name"].is_null() && p4["goal"].is_null());
        assert_eq!(json["plan"]["phases"][1]["name"], "앱 뼈대");
        assert_eq!(json["handoff"]["state"], "ok");
        assert_eq!(json["handoff"]["skill"], "desktop-app");
        assert_eq!(json["handoff"]["current"]["state"], "ok");
        assert_eq!(json["handoff"]["current"]["value"]["state"], "working");
        let task = &json["handoff"]["tasks"]["value"][0];
        assert_eq!(task["statusText"], "맡김 (2026-11-07)");
        assert_eq!(task["status"], "assigned");
        assert_eq!(
            task["progress"],
            serde_json::json!({ "done": 1, "total": 2 })
        );
        assert_eq!(
            json["handoff"]["waiting"],
            serde_json::json!({ "state": "ok", "value": [] })
        );
        // 읽을 수 없음 · 없음
        let broken = TempDir::new("progress-json");
        fs::create_dir_all(broken.join("docs").join("02-development")).unwrap();
        fs::write(
            broken
                .join("docs")
                .join("02-development")
                .join("dev-plan.md"),
            "## 단계 개요
",
        )
        .unwrap();
        let json = serde_json::to_value(read_project(&broken)).unwrap();
        assert_eq!(
            json["plan"],
            serde_json::json!({ "state": "unreadable", "reason": "no_table" })
        );
        assert_eq!(json["handoff"], serde_json::json!({ "state": "absent" }));
        let section = serde_json::to_value(read_current(&[])).unwrap();
        assert_eq!(
            section,
            serde_json::json!({ "state": "unreadable", "reason": "no_item" })
        );
        // 낱말은 snake_case
        let waiting = serde_json::to_value(read_current(&["사용자 답 기다림"])).unwrap();
        assert_eq!(waiting["value"]["state"], "waiting_answer");
    }

    // ── 깨진 글에서도 패닉이 없다 ──

    #[test]
    fn no_text_makes_the_readers_panic() {
        let mut samples: Vec<String> = vec![
            String::new(),
            "|".into(),
            "||".into(),
            "|||||".into(),
            "\\|".into(),
            "| \\| |".into(),
            "## ".into(),
            "## 단계 개요".into(),
            "## 단계 개요\n|".into(),
            "## 단계 개요\n|---|\n|---|".into(),
            "## 단계 개요\n| 단계 | 내용 | 담당 | 승인 게이트 | 상태 |\n|---|---|---|---|---|\n| P | | | | |\n| P99999999999999999999 | | | | |".into(),
            "## P. \n- 목표:".into(),
            "## P1.\n- 목표".into(),
            "- 스킬".into(),
            "- 스킬:".into(),
            "- 스킬:\n  ".into(),
            "- :\n".into(),
            "## 지금 상태\n- ".into(),
            "## 진행 중인 작업\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n|`briefs/`|".into(),
            "## 진행 중인 작업\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n|`briefs/가.md`|가|1차|".into(),
            "## 진행 중인 작업\n| 지시서 | 담당 | 상태 |\n|---|---|---|\n|x|y|99999999999999999999차 검수 통과|".into(),
            "## 다음 할 일\n99999999999999999999. x\n1.\n1)".into(),
            "```\n## 단계 개요".into(),
            "- [".into(),
            "- [x".into(),
            "- [x]".into(),
            "\u{feff}".into(),
            "\0\0\0".into(),
            "가나다".repeat(50),
        ];
        samples.push(MESSY_PLAN.into());
        samples.push(MESSY_HANDOFF.into());
        samples.push(TEMPLATE_PLAN.into());
        samples.push(TEMPLATE_HANDOFF.into());
        // 어느 곳에서 잘려도 (글자 경계마다) 패닉이 없다 — 쓰는 도중에 읽은 글처럼
        for full in [MESSY_PLAN, MESSY_HANDOFF, TEMPLATE_PLAN, TEMPLATE_HANDOFF] {
            for (index, _) in full.char_indices() {
                samples.push(full[..index].to_string());
                samples.push(full[index..].to_string());
            }
        }
        for sample in &samples {
            let _ = parse_plan(sample);
            let _ = parse_handoff(sample);
            let _ = count_checks(sample);
        }
    }

    // ── 등록된 프로젝트 번호로만 ──

    struct Registered {
        _dir: TempDir,
        db: AppDb,
        env: Env,
        id: i64,
        folder: std::path::PathBuf,
    }

    fn registered() -> Registered {
        let dir = TempDir::new("progress-registered");
        let data = dir.join("data");
        let folder = dir.join("work").join("proj");
        fs::create_dir_all(&folder).unwrap();
        let db = AppDb::open(&data.join(DB_FILE));
        let state = ProjectsState::new(data);
        let env = Env {
            forbidden: ForbiddenSet::new(),
            docs_dir: "docs".into(),
            inspect_deadline: Duration::from_secs(5),
        };
        handle_picked(&db, &state, &env, &folder).unwrap();
        let id = add(&db, &state, &env, AddRequest::default()).unwrap().id;
        Registered {
            _dir: dir,
            db,
            env,
            id,
            folder,
        }
    }

    #[test]
    fn commands_work_for_a_registered_project_only() {
        let reg = registered();
        // 문서가 없다
        let result = read(&reg.db, &reg.env, reg.id).unwrap();
        assert_eq!(result.plan, PlanResult::Absent);
        assert_eq!(result.handoff, HandoffResult::Absent);
        assert_eq!(
            docs::list(&reg.db, &reg.env, reg.id).unwrap(),
            docs::ListResult::Absent
        );
        assert_eq!(
            docs::read(&reg.db, &reg.env, reg.id, "a.md").unwrap(),
            docs::DocReadResult::Absent
        );
        // 문서가 생기면
        let dev = reg.folder.join("docs").join("02-development");
        fs::create_dir_all(&dev).unwrap();
        fs::write(dev.join("dev-plan.md"), MESSY_PLAN).unwrap();
        let first = version(&reg.db, &reg.env, reg.id).unwrap();
        let result = read(&reg.db, &reg.env, reg.id).unwrap();
        assert!(matches!(result.plan, PlanResult::Ok(_)));
        // 읽기가 준 `version` 은 그 뒤 물음의 값과 같다 (바뀌지 않았다면 화면이 다시 읽지 않는다 — 방금 고친 파일은 잠깐 다르다)
        assert_eq!(result.version.len(), first.len());
        match docs::list(&reg.db, &reg.env, reg.id).unwrap() {
            docs::ListResult::Ok(listing) => {
                assert_eq!(listing.files.len(), 1);
                assert_eq!(listing.files[0].path, "02-development/dev-plan.md");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            docs::read(&reg.db, &reg.env, reg.id, "02-development/dev-plan.md").unwrap(),
            docs::DocReadResult::Ok(_)
        ));
        // 경로 모양이 틀리면 invalid_input
        assert_eq!(
            docs::read(&reg.db, &reg.env, reg.id, "../x.md")
                .unwrap_err()
                .kind(),
            "invalid_input"
        );
    }

    #[test]
    fn an_unregistered_id_is_refused_by_every_command() {
        let reg = registered();
        let other = reg.id + 100;
        let kind = |err: AppError| err.kind();
        assert_eq!(
            kind(read(&reg.db, &reg.env, other).unwrap_err()),
            "project_not_found"
        );
        assert_eq!(
            kind(version(&reg.db, &reg.env, other).unwrap_err()),
            "project_not_found"
        );
        assert_eq!(
            kind(docs::list(&reg.db, &reg.env, other).unwrap_err()),
            "project_not_found"
        );
        assert_eq!(
            kind(docs::read(&reg.db, &reg.env, other, "a.md").unwrap_err()),
            "project_not_found"
        );
        assert_eq!(
            kind(read(&reg.db, &reg.env, -1).unwrap_err()),
            "project_not_found"
        );
    }

    #[test]
    fn a_folder_that_cannot_be_a_project_is_refused_by_every_command() {
        let reg = registered();
        // 등록한 뒤 위치 설정이 바뀌어 그 폴더가 고를 수 없는 폴더가 되었다
        let strict = Env {
            forbidden: ForbiddenSet::new().with_exact(ForbiddenReason::Home, &reg.folder),
            docs_dir: "docs".into(),
            inspect_deadline: Duration::from_secs(5),
        };
        let kind = |err: AppError| err.kind();
        assert_eq!(
            kind(read(&reg.db, &strict, reg.id).unwrap_err()),
            "project_folder_forbidden"
        );
        assert_eq!(
            kind(version(&reg.db, &strict, reg.id).unwrap_err()),
            "project_folder_forbidden"
        );
        assert_eq!(
            kind(docs::list(&reg.db, &strict, reg.id).unwrap_err()),
            "project_folder_forbidden"
        );
        assert_eq!(
            kind(docs::read(&reg.db, &strict, reg.id, "a.md").unwrap_err()),
            "project_folder_forbidden"
        );
    }

    #[test]
    fn a_project_folder_that_is_gone_is_unreadable_not_an_error() {
        let reg = registered();
        fs::remove_dir_all(&reg.folder).unwrap();
        let result = read(&reg.db, &reg.env, reg.id).unwrap();
        let gone = ReasonInfo {
            reason: Reason::FolderMissing,
        };
        assert_eq!(result.plan, PlanResult::Unreadable(gone.clone()));
        assert_eq!(result.handoff, HandoffResult::Unreadable(gone));
        assert!(version(&reg.db, &reg.env, reg.id).is_ok());
        assert_eq!(
            docs::list(&reg.db, &reg.env, reg.id).unwrap(),
            docs::ListResult::Unreadable(requirements::ProblemInfo {
                reason: Problem::FolderMissing
            })
        );
    }
}
