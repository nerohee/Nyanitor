//! 로그에 찍히는 사용자 홈 경로를 `~` 로 바꾼다 (D-54 · D-55) — 로그 파일에 사용자 이름이 든 경로가 남지 않게.
//!
//! 홈 경로는 `C:\Users\이름` · `C:/Users/이름` · 디버그 출력의 `C:\\Users\\이름` 세 모양으로 올 수 있고,
//! Windows 는 대소문자를 가리지 않으므로 (ASCII 글자만) 대소문자를 무시하고 맞춘다.
//! 홈 경로 바로 뒤가 이름 글자(`이름2`)면 다른 폴더이므로 바꾸지 않는다. 마침표는 이름의 이어짐으로 보지 않는다 (문장 끝 `…\이름.` 이 새지 않게).

use std::borrow::Cow;
use std::path::Path;

/// 홈 경로를 `~` 로 바꾸는 도구
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HomeScrubber {
    /// 찾을 글자 세 모양 — `\` · `/` · `\\`
    patterns: [String; 3],
}

impl HomeScrubber {
    /// 이 PC 의 홈 경로 (`USERPROFILE` · `HOME`). 알 수 없으면 `None` — 바꿀 것이 없다.
    pub fn from_env() -> Option<Self> {
        let home = std::env::home_dir()?;
        Self::new(&home)
    }

    /// 홈 경로가 너무 짧으면(`/` · `C:\`) `None` — 로그 전체가 바뀌는 것을 막는다.
    pub fn new(home: &Path) -> Option<Self> {
        let text = home.to_string_lossy();
        let parts: Vec<&str> = text
            .split(['\\', '/'])
            .filter(|part| !part.is_empty())
            .collect();
        // `/root` · `C:\Users\이름` — 맨 앞이 `/` 였던 것은 아래 `leading` 으로 되살린다
        let leading = if text.starts_with('/') { "/" } else { "" };
        if parts.iter().map(|part| part.chars().count()).sum::<usize>() < 3 {
            return None;
        }
        let build = |sep: &str| format!("{leading}{}", parts.join(sep));
        Some(Self {
            patterns: [build("\\"), build("/"), build("\\\\")],
        })
    }

    /// 글 속의 홈 경로를 `~` 로 바꾼다. 없으면 그대로 돌려준다 (복사 없음).
    pub fn scrub<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut out: Option<String> = None;
        let mut copied_to = 0;
        let mut at = 0;
        while at < text.len() {
            if let Some(len) = self.match_at(text, at) {
                let out = out.get_or_insert_with(|| String::with_capacity(text.len()));
                out.push_str(&text[copied_to..at]);
                out.push('~');
                at += len;
                copied_to = at;
                continue;
            }
            at += text[at..].chars().next().map_or(1, char::len_utf8);
        }
        match out {
            Some(mut out) => {
                out.push_str(&text[copied_to..]);
                Cow::Owned(out)
            }
            None => Cow::Borrowed(text),
        }
    }

    /// `text[at..]` 가 홈 경로로 시작하면 그 길이(바이트)
    fn match_at(&self, text: &str, at: usize) -> Option<usize> {
        let rest = &text[at..];
        self.patterns.iter().find_map(|pattern| {
            let len = prefix_len_ignoring_ascii_case(rest, pattern)?;
            ends_the_name(&rest[len..]).then_some(len)
        })
    }
}

/// `text` 가 `pattern` 으로 시작하면(ASCII 대소문자 무시) `text` 에서 차지하는 바이트 수
fn prefix_len_ignoring_ascii_case(text: &str, pattern: &str) -> Option<usize> {
    let mut chars = text.chars();
    let mut len = 0;
    for expected in pattern.chars() {
        let actual = chars.next()?;
        if actual != expected && !actual.eq_ignore_ascii_case(&expected) {
            return None;
        }
        len += actual.len_utf8();
    }
    Some(len)
}

/// 홈 경로 바로 뒤가 이름의 이어짐이 아니다 (끝 · 구분자 · 따옴표 · 공백 · 마침표 등)
fn ends_the_name(after: &str) -> bool {
    after
        .chars()
        .next()
        .is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '-')))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrubber(home: &str) -> HomeScrubber {
        HomeScrubber::new(Path::new(home)).expect("홈 경로로 쓸 수 있다")
    }

    #[test]
    fn a_windows_home_path_becomes_a_tilde_in_all_three_shapes() {
        let s = scrubber(r"C:\Users\김희성");
        assert_eq!(
            s.scrub(r"open C:\Users\김희성\.claude\x.json failed"),
            r"open ~\.claude\x.json failed"
        );
        assert_eq!(
            s.scrub("open C:/Users/김희성/.claude/x.json failed"),
            "open ~/.claude/x.json failed"
        );
        // 디버그 출력(`{:?}`)은 역슬래시를 두 번 쓴다
        assert_eq!(
            s.scrub(r#"path "C:\\Users\\김희성\\AppData""#),
            r#"path "~\\AppData""#
        );
    }

    #[test]
    fn the_drive_letter_and_folder_case_do_not_matter() {
        let s = scrubber(r"C:\Users\Hee");
        assert_eq!(s.scrub(r"c:\users\hee\a"), r"~\a");
        assert_eq!(s.scrub(r"C:\USERS\HEE\a"), r"~\a");
        assert_eq!(s.scrub("c:/users/hee/a"), "~/a");
    }

    #[test]
    fn a_home_given_with_forward_slashes_or_a_trailing_separator_still_matches() {
        let s = scrubber("C:/Users/Hee/");
        assert_eq!(
            s.scrub(r"C:\Users\Hee\a and C:/Users/Hee/b"),
            r"~\a and ~/b"
        );
    }

    #[test]
    fn a_unix_home_keeps_its_leading_slash_in_the_pattern() {
        let s = scrubber("/home/hee");
        assert_eq!(s.scrub("read /home/hee/.claude/a"), "read ~/.claude/a");
        assert_eq!(
            s.scrub("read home/hee/a"),
            "read home/hee/a",
            "맨 앞 / 가 없으면 그 경로가 아니다"
        );
    }

    #[test]
    fn several_hits_in_one_line_are_all_replaced() {
        let s = scrubber(r"C:\Users\Hee");
        assert_eq!(
            s.scrub(r"copy C:\Users\Hee\a to C:\Users\Hee\b"),
            r"copy ~\a to ~\b"
        );
    }

    #[test]
    fn another_folder_that_only_starts_with_the_same_letters_is_left_alone() {
        let s = scrubber(r"C:\Users\Hee");
        assert_eq!(s.scrub(r"C:\Users\Hee2\a"), r"C:\Users\Hee2\a");
        assert_eq!(s.scrub(r"C:\Users\Heesung"), r"C:\Users\Heesung");
        assert_eq!(s.scrub(r"C:\Users\Hee_old"), r"C:\Users\Hee_old");
        assert_eq!(
            s.scrub(r"cannot open C:\Users\Hee."),
            "cannot open ~.",
            "문장 끝 마침표"
        );
        assert_eq!(s.scrub(r"C:\Users\Hee"), "~", "끝이면 바꾼다");
        assert_eq!(s.scrub(r#"dir="C:\Users\Hee""#), r#"dir="~""#);
    }

    #[test]
    fn text_without_the_home_path_comes_back_untouched_without_copying() {
        let s = scrubber(r"C:\Users\Hee");
        let text = "세션 시작 D:\\work\\proj 한글 \u{1F408}";
        assert!(matches!(s.scrub(text), Cow::Borrowed(same) if same == text));
    }

    #[test]
    fn multibyte_text_around_the_hit_survives() {
        let s = scrubber(r"C:\Users\Hee");
        assert_eq!(
            s.scrub("고양이 \u{1F408} C:\\Users\\Hee\\집 끝"),
            "고양이 \u{1F408} ~\\집 끝"
        );
    }

    #[test]
    fn a_home_that_is_too_short_is_not_used() {
        assert!(HomeScrubber::new(Path::new("/")).is_none());
        assert!(HomeScrubber::new(Path::new(r"C:\")).is_none());
        assert!(HomeScrubber::new(Path::new("")).is_none());
        assert!(HomeScrubber::new(Path::new("/r")).is_none());
        assert!(HomeScrubber::new(Path::new("/root")).is_some());
    }
}
