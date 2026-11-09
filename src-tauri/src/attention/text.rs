//! 알림 글 만들기 — 순수 함수 (D-50). 문구 자체는 `strings.rs`.
//!
//! 알림 본문은 OS 알림 기록에 남는다 — 그래서 **도구 이름까지만** 싣고 명령 · 경로 · 입력은 싣지 않는다 (D-48 과 같은 이유).
//! 이 파일의 함수는 받은 글을 그대로 두지 않고 한 줄로 다듬고 길이를 자른다.

use crate::strings;

/// 알림 본문 하나의 최대 글자 수 (끝의 `…` 포함). 글자 = 유니코드 스칼라 값.
pub const BODY_MAX_CHARS: usize = 80;
/// 알림 제목의 최대 글자 수 (프로젝트 이름이 길 때)
pub const TITLE_MAX_CHARS: usize = 60;

/// 줄바꿈 · 탭 · 제어 문자를 공백으로 바꾸고 공백 덩어리를 하나로 줄인다. 앞뒤 공백은 뗀다.
pub fn squash(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut gap = false;
    for ch in text.chars() {
        if ch.is_whitespace() || ch.is_control() {
            gap = true;
            continue;
        }
        if gap && !out.is_empty() {
            out.push(' ');
        }
        gap = false;
        out.push(ch);
    }
    out
}

/// 앞 글자와 한 덩어리로 붙어 다니는 글자인가 — 이 앞에서 자르면 글자가 깨진다.
fn sticks_to_previous(ch: char) -> bool {
    matches!(
        ch as u32,
        0x200D                      // 제로 폭 접합자 (👨‍👩‍👧)
        | 0xFE00..=0xFE0F           // 변형 선택자 (❤️)
        | 0x0300..=0x036F           // 결합 분음 부호
        | 0x1AB0..=0x1AFF
        | 0x1DC0..=0x1DFF
        | 0x20D0..=0x20FF
        | 0xFE20..=0xFE2F
        | 0x1160..=0x11FF           // 풀어 쓴 한글 가운데 · 끝소리
        | 0xD7B0..=0xD7FF
        | 0x3099..=0x309A           // 일본어 탁점
        | 0x1F3FB..=0x1F3FF         // 피부색
        | 0xE0020..=0xE007F         // 태그 글자 (깃발)
        | 0xE0100..=0xE01EF
    )
}

fn is_regional_indicator(ch: char) -> bool {
    matches!(ch as u32, 0x1F1E6..=0x1F1FF)
}

/// `chars[at - 1]` 과 `chars[at]` 사이를 잘라도 되는가.
fn can_cut_before(chars: &[char], at: usize) -> bool {
    if at == 0 || at >= chars.len() {
        return true;
    }
    if sticks_to_previous(chars[at]) || chars[at - 1] == '\u{200D}' {
        return false;
    }
    // 국기는 지역 표시 글자 두 개 — 앞에 이어진 개수가 홀수면 둘 사이다
    if is_regional_indicator(chars[at]) {
        let run = chars[..at]
            .iter()
            .rev()
            .take_while(|c| is_regional_indicator(**c))
            .count();
        if run % 2 == 1 {
            return false;
        }
    }
    true
}

/// 글자 수가 `max` 를 넘으면 `max` 안쪽(끝의 `…` 포함)에서 자른다. 한글 · 이모지(접합 · 변형 · 피부색 · 국기) 한가운데서 자르지 않는다.
pub fn truncate(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    // `…` 한 글자 자리를 남기고 자를 곳을 찾는다
    let mut end = max - 1;
    while end > 0 && !can_cut_before(&chars, end) {
        end -= 1;
    }
    let kept: String = chars[..end].iter().collect();
    format!("{}…", kept.trim_end())
}

/// 앞말 + ` — ` + 자세한 말. 자세한 말이 비면 앞말만. 전체를 `BODY_MAX_CHARS` 안으로 자른다.
pub fn with_detail(lead: &str, detail: &str) -> String {
    let detail = squash(detail);
    let body = if detail.is_empty() {
        lead.to_string()
    } else {
        format!("{lead}{}{detail}", strings::NOTICE_DETAIL_SEP)
    };
    truncate(&body, BODY_MAX_CHARS)
}

/// `Nyanitor · <프로젝트 이름>` (이름을 모르거나 비면 `Nyanitor`)
pub fn title(project_name: Option<&str>) -> String {
    let name = project_name.map(squash).unwrap_or_default();
    if name.is_empty() {
        return strings::NOTICE_TITLE.to_string();
    }
    format!(
        "{}{}{}",
        strings::NOTICE_TITLE,
        strings::NOTICE_TITLE_SEP,
        truncate(&name, TITLE_MAX_CHARS)
    )
}

/// 단계 승인 질문의 첫 줄 — `단계 승인 — P<번호> <이름>` (`src/workspace/chat/approval.ts` 의 `TITLE` 정규식과 같다).
/// 질문 글의 첫 번째 비지 않은 줄만 본다. 돌려주는 값은 (`P4`, `하네스 설치 · 업데이트`) — 이름이 없으면 빈 글.
pub fn approval_title(question: &str) -> Option<(String, String)> {
    let first = question.lines().find(|line| !line.trim().is_empty())?;
    let rest = first.trim_start();
    let rest = rest.strip_prefix("단계")?.trim_start();
    let rest = rest.strip_prefix("승인")?.trim_start();
    // `—` · `–` · `-` 가 하나 이상
    let after_dash = rest.trim_start_matches(['—', '–', '-']);
    if after_dash.len() == rest.len() {
        return None;
    }
    let rest = after_dash.trim_start().strip_prefix('P')?;
    let digits = rest.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    // 숫자는 ASCII 라 글자 수 = 바이트 수
    let (number, name) = rest.split_at(digits);
    Some((format!("P{number}"), squash(name)))
}

/// 질문 알림 본문의 자세한 말 — 질문 머리말(header), 없으면 질문 첫 줄.
pub fn question_detail(header: Option<&str>, question: &str) -> String {
    if let Some(header) = header {
        let header = squash(header);
        if !header.is_empty() {
            return header;
        }
    }
    question
        .lines()
        .map(squash)
        .find(|line| !line.is_empty())
        .unwrap_or_default()
}

/// `question` 알림 본문
pub fn question_body(header: Option<&str>, question: &str) -> String {
    with_detail(
        strings::NOTICE_QUESTION_LEAD,
        &question_detail(header, question),
    )
}

/// `approval` (단계) 알림 본문 — `승인을 기다려요 — P4 하네스 설치 · 업데이트`
pub fn stage_approval_body(phase: &str, name: &str) -> String {
    let detail = if name.is_empty() {
        phase.to_string()
    } else {
        format!("{phase} {name}")
    };
    with_detail(strings::NOTICE_APPROVAL_LEAD, &detail)
}

/// `approval` (권한) 알림 본문 — **도구 이름까지만**. 명령 · 경로 · 입력 · 작업 폴더는 받지도 않는다.
pub fn permission_body(tool: &str) -> String {
    with_detail(strings::NOTICE_PERMISSION_LEAD, tool)
}

/// `phase_done` 알림 본문 — `P4 하네스 설치 · 업데이트 단계가 끝났어요` (이름이 없으면 번호만)
pub fn phase_done_body(phase: &str, name: Option<&str>) -> String {
    let name = name.map(squash).unwrap_or_default();
    let head = if name.is_empty() {
        phase.to_string()
    } else {
        format!("{phase} {name}")
    };
    truncate(
        &format!("{head}{}", strings::NOTICE_PHASE_DONE_TAIL),
        BODY_MAX_CHARS,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squash_makes_one_line_and_drops_control_characters() {
        assert_eq!(squash("  a\n\n b\t\tc \r\n"), "a b c");
        assert_eq!(squash("a\u{0007}b"), "a b");
        assert_eq!(squash("   "), "");
    }

    #[test]
    fn short_text_is_kept_as_is() {
        assert_eq!(truncate("짧은 글", 80), "짧은 글");
        let exact = "가".repeat(80);
        assert_eq!(truncate(&exact, 80), exact);
    }

    #[test]
    fn long_hangul_is_cut_at_the_limit_with_an_ellipsis() {
        let long = "가".repeat(200);
        let cut = truncate(&long, 80);
        assert_eq!(cut.chars().count(), 80);
        assert!(cut.ends_with('…'));
        assert_eq!(&cut[..cut.len() - '…'.len_utf8()], "가".repeat(79));
    }

    #[test]
    fn a_cut_never_splits_an_emoji_sequence() {
        let family = "👨\u{200D}👩\u{200D}👧\u{200D}👦"; // 7 글자
        // 앞 글자 수를 바꿔 가며 어디서 잘려도 가족 이모지가 반쪽으로 남지 않는다
        for pad in 0..12 {
            let text = format!("{}{family}{}", "a".repeat(pad), "z".repeat(40));
            let cut = truncate(&text, 12);
            assert!(cut.chars().count() <= 12, "pad {pad}: {cut}");
            let after = cut.trim_end_matches('…');
            // 가족 이모지가 있다면 통째로, 아니라면 접합자로 끝나지 않는다
            assert!(!after.ends_with('\u{200D}'), "pad {pad}: {cut}");
            let zwj = after.chars().filter(|c| *c == '\u{200D}').count();
            let heads = after
                .chars()
                .filter(|c| matches!(*c, '👨' | '👩' | '👧' | '👦'))
                .count();
            assert!(
                heads == 0 || (heads == 4 && zwj == 3),
                "pad {pad}: split family in {cut}"
            );
        }
    }

    #[test]
    fn a_cut_keeps_variation_selectors_skin_tones_and_flags_whole() {
        // ❤️ = ❤ + U+FE0F, 👍🏽 = 👍 + 피부색, 🇰🇷 = 지역 표시 두 글자
        for emoji in ["❤\u{FE0F}", "👍\u{1F3FD}", "🇰🇷"] {
            for pad in 0..6 {
                let text = format!("{}{emoji}{}", "a".repeat(pad), "z".repeat(30));
                let cut = truncate(&text, 8);
                assert!(cut.chars().count() <= 8);
                let after = cut.trim_end_matches('…');
                let has_head = after.contains(['❤', '👍', '\u{1F1F0}']);
                let has_tail = after.contains(['\u{FE0F}', '\u{1F3FD}', '\u{1F1F7}']);
                assert_eq!(has_head, has_tail, "{emoji} pad {pad}: {cut}");
            }
        }
    }

    #[test]
    fn truncate_handles_tiny_limits() {
        assert_eq!(truncate("abc", 0), "");
        assert_eq!(truncate("abcdef", 1), "…");
        assert_eq!(truncate("abcdef", 2), "a…");
    }

    #[test]
    fn approval_title_reads_the_same_first_line_as_the_screen() {
        assert_eq!(
            approval_title("단계 승인 — P4 하네스 설치 · 업데이트\n- 무엇을: x"),
            Some(("P4".into(), "하네스 설치 · 업데이트".into()))
        );
        // 앞 빈 줄 · 공백 · 다른 줄표 · 이름 없음
        assert_eq!(
            approval_title("\n  \n  단계승인 –- P12\n"),
            Some(("P12".into(), String::new()))
        );
        assert_eq!(
            approval_title("단계 승인 - P0 뼈대"),
            Some(("P0".into(), "뼈대".into()))
        );
        // 첫 줄이 아니면 승인이 아니다
        assert_eq!(approval_title("뭔가 물어봐요\n단계 승인 — P4 x"), None);
        assert_eq!(approval_title("단계 승인 P4"), None);
        assert_eq!(approval_title("단계 승인 — 4 이름"), None);
        assert_eq!(approval_title("단계 승인 — P 이름"), None);
        assert_eq!(approval_title(""), None);
    }

    #[test]
    fn question_detail_prefers_the_header_then_the_first_line() {
        assert_eq!(question_detail(Some("범위"), "어디까지 할까요?"), "범위");
        assert_eq!(question_detail(None, "\n 어디까지\n 할까요?"), "어디까지");
        assert_eq!(question_detail(Some("  "), "첫 줄\n둘째"), "첫 줄");
        assert_eq!(question_detail(None, ""), "");
    }

    #[test]
    fn question_body_is_within_the_limit() {
        let body = question_body(None, &"매우 긴 질문 ".repeat(40));
        assert!(body.starts_with("먹물이 물어봐요 — 매우 긴 질문"));
        assert!(body.chars().count() <= BODY_MAX_CHARS);
        assert!(body.ends_with('…'));
        assert_eq!(question_body(None, ""), "먹물이 물어봐요");
    }

    #[test]
    fn fixed_bodies_match_the_wording() {
        assert_eq!(
            stage_approval_body("P4", "하네스 설치"),
            "승인을 기다려요 — P4 하네스 설치"
        );
        assert_eq!(stage_approval_body("P4", ""), "승인을 기다려요 — P4");
        assert_eq!(permission_body("Bash"), "허락을 기다려요 — Bash");
        assert_eq!(
            phase_done_body("P4", Some("하네스 설치")),
            "P4 하네스 설치 단계가 끝났어요"
        );
        assert_eq!(phase_done_body("P4", None), "P4 단계가 끝났어요");
        assert_eq!(phase_done_body("P4", Some("  ")), "P4 단계가 끝났어요");
    }

    #[test]
    fn title_names_the_project_when_known() {
        assert_eq!(title(Some("우리 집")), "Nyanitor · 우리 집");
        assert_eq!(title(None), "Nyanitor");
        assert_eq!(title(Some("  ")), "Nyanitor");
        let head = format!("{}{}", strings::NOTICE_TITLE, strings::NOTICE_TITLE_SEP);
        assert!(
            title(Some(&"길".repeat(200))).chars().count()
                <= head.chars().count() + TITLE_MAX_CHARS
        );
    }
}
