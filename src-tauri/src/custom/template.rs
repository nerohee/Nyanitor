//! 내가 만드는 에이전트 · 스킬의 틀 (약속 3-3절 · 5절) — 새로 만들 때의 틀 글, 그리고 설치 스크립트가 받아들이는 모양인지 확인.
//!
//! 설치 스크립트가 에이전트에 요구하는 것 (`Test-AgentSource`): 둘째 줄이 정확히 `name: <파일 이름에서 .md 를 뺀 것>`, 앞머리에 `hooks:` 로 시작하는 줄이 없다
//! (가드 hook 은 설치가 붙인다). 틀이 틀리면 설치가 `invalidAgent` 로 멈추므로 앱이 저장 전에 거절한다.

use crate::agents::frontmatter::{self, FrontmatterError};
use crate::strings;

/// 앞머리에 쓸 한 줄 글 값 — 글 그대로 써도 YAML 이 되는 모양이면 그대로, 아니면 큰따옴표로 감싼다
/// (`description: 문서: 번역` 처럼 `: ` 가 든 글을 그대로 두면 Claude Code 의 앞머리 읽기가 실패한다).
pub fn yaml_scalar(text: &str) -> String {
    let first_ok = text
        .chars()
        .next()
        .is_some_and(|c| c.is_alphanumeric() || c == '/' || c == '.' || c == '(');
    let risky = text.contains(": ")
        || text.contains(" #")
        || text.ends_with(':')
        || text.starts_with(' ')
        || text.ends_with(' ');
    if first_ok && !risky {
        return text.to_string();
    }
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// 새로 만든 에이전트의 글 — 둘째 줄 `name`, `hooks` 없음 (3-3절)
pub fn new_agent_text(
    name: &str,
    description: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> String {
    new_text(
        name,
        description,
        model,
        effort,
        strings::CUSTOM_NEW_AGENT_BODY,
    )
}

/// 새로 만든 스킬의 글
pub fn new_skill_text(
    name: &str,
    description: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> String {
    new_text(
        name,
        description,
        model,
        effort,
        strings::CUSTOM_NEW_SKILL_BODY,
    )
}

fn new_text(
    name: &str,
    description: &str,
    model: Option<&str>,
    effort: Option<&str>,
    body: &str,
) -> String {
    let mut text = format!(
        "---\nname: {name}\ndescription: {}\n",
        yaml_scalar(description)
    );
    if let Some(model) = model {
        text.push_str(&format!("model: {model}\n"));
    }
    if let Some(effort) = effort {
        text.push_str(&format!("effort: {effort}\n"));
    }
    text.push_str("---\n\n");
    text.push_str(body);
    if !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// 에이전트 글이 설치 스크립트의 틀을 지키는가. 어기면 이유(진단용 글), 지키면 `None`.
pub fn agent_problem(name: &str, text: &str) -> Option<String> {
    // 스크립트는 CRLF 를 LF 로 맞춘 글을 본다
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() < 2 || lines[1] != format!("name: {name}") {
        return Some(format!("the second line must be `name: {name}`"));
    }
    for line in lines.iter().skip(1) {
        if *line == "---" {
            break;
        }
        if line.starts_with("hooks:") {
            return Some("`hooks:` must not be used (the install adds the guard hook)".into());
        }
    }
    None
}

/// 앞머리를 읽을 수 있는가 (첫 줄 `---`, 닫는 `---`). 못 읽으면 이유.
pub fn front_problem(text: &str) -> Option<&'static str> {
    match frontmatter::parse(text) {
        Ok(_) => None,
        Err(FrontmatterError::Missing) => Some("no frontmatter"),
        Err(FrontmatterError::Unclosed) => Some("unclosed frontmatter"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_agent_keeps_the_install_scripts_template() {
        let text = new_agent_text(
            "translator",
            "문서를 영어로 옮긴다",
            Some("sonnet"),
            Some("medium"),
        );
        assert!(text.starts_with("---\nname: translator\ndescription: 문서를 영어로 옮긴다\nmodel: sonnet\neffort: medium\n---\n\n"));
        assert_eq!(agent_problem("translator", &text), None);
        assert_eq!(front_problem(&text), None);
        assert!(!text.contains("hooks:"));
        assert!(text.ends_with('\n'));
        let fields = frontmatter::parse(&text).unwrap();
        assert_eq!(fields.get("name"), Some("translator"));
        assert_eq!(fields.get("model"), Some("sonnet"));
    }

    #[test]
    fn values_left_out_are_not_written_and_the_skill_has_the_same_front() {
        let text = new_skill_text("web-notes", "웹 메모", None, None);
        assert!(text.starts_with("---\nname: web-notes\ndescription: 웹 메모\n---\n\n"));
        assert!(!text.contains("model:") && !text.contains("effort:"));
        assert_eq!(front_problem(&text), None);
    }

    #[test]
    fn a_description_that_would_break_yaml_is_quoted_and_read_back_the_same() {
        for description in [
            "문서: 번역",
            "# 제목처럼",
            "끝이 콜론:",
            "\"따옴표\" 로 시작",
            "백슬래시 \\ 와 \"따옴표\"",
            "- 목록처럼",
            "[대괄호]",
        ] {
            let text = new_agent_text("x", description, None, None);
            let fields = frontmatter::parse(&text).unwrap();
            assert_eq!(fields.get("description"), Some(description), "{text}");
        }
        assert_eq!(yaml_scalar("문서를 영어로 옮긴다"), "문서를 영어로 옮긴다");
    }

    #[test]
    fn the_agent_check_catches_a_wrong_name_a_moved_name_and_hooks() {
        let good = "---\nname: a\ndescription: d\n---\n본문\n";
        assert_eq!(agent_problem("a", good), None);
        assert_eq!(agent_problem("a", &good.replace('\n', "\r\n")), None);
        assert!(agent_problem("b", good).is_some());
        assert!(agent_problem("a", "---\ndescription: d\nname: a\n---\n").is_some());
        assert!(agent_problem("a", "").is_some());
        assert!(agent_problem("a", "---\nname: a\nhooks:\n  x: y\n---\n").is_some());
        // 본문에 `hooks:` 가 있는 것은 괜찮다
        assert_eq!(agent_problem("a", "---\nname: a\n---\nhooks: 설명\n"), None);
    }
}
