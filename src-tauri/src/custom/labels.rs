//! 보이는 이름 — `custom/agent-labels.json` 읽기 · 한 에이전트의 이름 쓰기 (D-52).
//!
//! 직접 만든 에이전트의 화면 이름(예: `translator` → 「번역」). 모양은 고양이 연결 파일과 같다: `{ "version": 1, "agents": { "<에이전트 이름>": "<보이는 이름>" } }`.
//! 설치 스크립트는 이 파일을 읽지 않는다 (앱 전용) — 그래서 고양이처럼 **그 파일만 바로 커밋한다** (종류 `labels`). 읽기 · 쓰기 · 커밋은 `cats.rs` 의 것을 그대로 쓴다
//! (모르는 키 · 순서 보존, 링크 · 큰 파일 · 깨진 파일 거절).
//!
//! 이름 규칙: 앞뒤 공백을 떼고 1~`LABEL_MAX_CHARS` 글자(문자 수), 줄바꿈 · 탭 · 제어 문자 없음. 뗀 뒤 빈 글 = 그 줄 지움.
//! 키는 에이전트 이름 규칙(`valid_name`)이고 `main` 은 받지 않는다 (오케스트레이터 이름은 앱이 정한다). 하네스 작업자인지는 보지 않는다 (화면이 직접 만든 에이전트에만 칸을 둔다).

use crate::error::AppError;
use crate::strings;

use super::Env;
use super::cats::{self, refused};
use super::id::valid_name;
use super::model::{CatsRead, CatsWriteResult, CommitKind};

pub const LABELS_FILE: &str = "agent-labels.json";
/// 보이는 이름의 최대 글자 수
pub const LABEL_MAX_CHARS: usize = 20;

/// 이름 규칙에 어긋난다
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BadLabel;

/// 줄바꿈 · 탭 · 제어 문자 — `char::is_control` 에 글 줄 · 문단 구분 문자(U+2028 · U+2029)를 더한다
fn is_forbidden(c: char) -> bool {
    c.is_control() || c == '\u{2028}' || c == '\u{2029}'
}

/// 이름 규칙 확인 — `Ok(Some(뗀 이름))` 쓸 수 있다 · `Ok(None)` 뗀 뒤 비었다(= 지움) · `Err` 어긋남
fn clean_label(raw: &str) -> Result<Option<String>, BadLabel> {
    let label = raw.trim();
    if label.is_empty() {
        return Ok(None);
    }
    if label.chars().count() > LABEL_MAX_CHARS || label.chars().any(is_forbidden) {
        return Err(BadLabel);
    }
    Ok(Some(label.to_string()))
}

/// 보이는 이름 읽기 (읽기만 한다 — 잠그지 않는다). 파일에 적힌 것만 돌려주되, 손으로 고쳐 규칙에 어긋난 줄(잘못된 에이전트 이름 · `main` · 긴 이름 · 줄바꿈이 든 이름 · 빈 이름)은 건너뛰고
/// 앞뒤 공백은 뗀 채로 준다 — 화면이 한 줄 칸에 그대로 그려도 깨지지 않게.
pub fn read(env: &Env) -> CatsRead {
    let mut read = cats::read_file(env, LABELS_FILE);
    read.agents = read
        .agents
        .into_iter()
        .filter(|(agent, _)| agent != "main" && valid_name(agent))
        .filter_map(|(agent, label)| match clean_label(&label) {
            Ok(Some(label)) => Some((agent, label)),
            _ => None,
        })
        .collect();
    read
}

/// 한 에이전트의 보이는 이름을 쓰고 (`None` 또는 뗀 뒤 빈 글 = 지움) 그 파일만 커밋한다.
/// 에이전트 이름이 규칙에 어긋나거나 `main` 이면 `invalid_input`, 이름이 규칙에 어긋나면 `refused` + `bad_label`.
pub fn write(env: &Env, agent: &str, label: Option<&str>) -> Result<CatsWriteResult, AppError> {
    if agent == "main" || !valid_name(agent) {
        return Err(AppError::InvalidInput(
            "agent name has the wrong shape".into(),
        ));
    }
    let wanted = match label.map(clean_label) {
        None | Some(Ok(None)) => None,
        Some(Ok(Some(label))) => Some(label),
        Some(Err(BadLabel)) => return Ok(refused("bad_label")),
    };
    cats::write_edits(
        env,
        LABELS_FILE,
        strings::CUSTOM_COMMIT_LABELS,
        CommitKind::Labels,
        &[(agent, wanted.as_deref())],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_and_counts_characters_not_bytes() {
        assert_eq!(clean_label("  번역  "), Ok(Some("번역".to_string())));
        assert_eq!(clean_label(&"가".repeat(20)), Ok(Some("가".repeat(20))));
        assert_eq!(clean_label(&"가".repeat(21)), Err(BadLabel));
        // 뗀 뒤 길이로 센다 — 앞뒤 공백이 글자 수에 들지 않는다
        assert!(clean_label(&format!(" {} ", "a".repeat(20))).is_ok());
        assert_eq!(clean_label(""), Ok(None));
        assert_eq!(clean_label(" \t\n "), Ok(None));
    }

    #[test]
    fn refuses_line_breaks_tabs_and_control_characters_inside() {
        for bad in [
            "a\nb",
            "a\r\nb",
            "a\tb",
            "a\u{0}b",
            "a\u{1b}b",
            "a\u{7f}b",
            "a\u{85}b",
            "a\u{2028}b",
            "a\u{2029}b",
        ] {
            assert_eq!(clean_label(bad), Err(BadLabel), "{bad:?}");
        }
        assert_eq!(clean_label("번 역"), Ok(Some("번 역".to_string())));
    }
}
