//! 에이전트 파일 앞머리 읽기 — 첫 줄 `---` 부터 다음 `---` 까지, 한 줄에 `키: 값` (약속 문서 `app-contract.md` 5절).
//!
//! 순수 함수만 있다 (파일 · 프로세스를 모른다). 다음은 일부러 읽는다: BOM · CRLF · 따옴표 값 · `|` `>` 로 시작하는 여러 줄 글 (하네스 밖의 에이전트가 쓴다).
//! 그 밖의 YAML (중첩 · 목록 · 앵커)은 해석하지 않는다 — 들여쓴 줄은 건너뛰고, 값이 비면 빈 글이다.

/// 앞머리를 읽지 못한 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontmatterError {
    /// 첫 줄이 `---` 가 아니다
    Missing,
    /// 여는 `---` 는 있는데 닫는 `---` 가 없다
    Unclosed,
}

/// 읽은 키와 값 (파일에 나온 순서, 같은 키가 또 나오면 처음 것을 쓴다).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Fields(Vec<(String, String)>);

impl Fields {
    /// 값 (없으면 `None`). 빈 글은 "없음" 으로 치지 않는다 — 부르는 쪽이 `non_empty` 로 고른다.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// 비어 있지 않은 값
    pub fn non_empty(&self, key: &str) -> Option<&str> {
        self.get(key).filter(|v| !v.is_empty())
    }
}

fn is_key(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `|` · `>` · `|-` · `>+` · `|2` 같은 여러 줄 글 표시인가
fn is_block_indicator(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some('|' | '>')) && chars.all(|c| matches!(c, '+' | '-' | '0'..='9'))
}

/// 따옴표를 벗긴다: `"…"` 은 `\"` · `\\` 만, `'…'` 은 `''` 만 풀어 준다. 짝이 안 맞으면 그대로.
fn unquote(value: &str) -> String {
    // 따옴표는 ASCII 한 글자라서 바이트로 보고 자른다 (값 첫 글자가 한글이어도 글자 경계를 벗어나지 않는다)
    let bytes = value.as_bytes();
    if bytes.len() >= 2 {
        let (first, last) = (bytes[0], bytes[bytes.len() - 1]);
        if first == b'"' && last == b'"' {
            return value[1..value.len() - 1]
                .replace("\\\"", "\"")
                .replace("\\\\", "\\");
        }
        if first == b'\'' && last == b'\'' {
            return value[1..value.len() - 1].replace("''", "'");
        }
    }
    value.to_string()
}

pub fn parse(text: &str) -> Result<Fields, FrontmatterError> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = text.split('\n').map(|line| line.trim_end_matches('\r'));
    if lines.next().map(str::trim_end) != Some("---") {
        return Err(FrontmatterError::Missing);
    }
    let mut fields: Vec<(String, String)> = Vec::new();
    // 여러 줄 글을 모으는 중인 키의 위치 (`fields` 안)
    let mut block: Option<usize> = None;
    let mut closed = false;
    for line in lines {
        if line.trim_end() == "---" {
            closed = true;
            break;
        }
        if line.starts_with([' ', '\t']) {
            // 들여쓴 줄: 여러 줄 글이면 이어 붙이고, 아니면 (중첩 · 목록) 건너뛴다
            if let Some(index) = block {
                let piece = line.trim();
                if !piece.is_empty() {
                    let value = &mut fields[index].1;
                    if !value.is_empty() {
                        value.push(' ');
                    }
                    value.push_str(piece);
                }
            }
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue; // 빈 줄은 여러 줄 글 안에도 있을 수 있다
        }
        block = None;
        if trimmed.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim_end();
        if !is_key(key) {
            continue;
        }
        let value = value.trim();
        let duplicate = fields.iter().any(|(k, _)| k == key);
        if duplicate {
            // 같은 키가 또 나오면 처음 것을 쓴다 (모으던 글도 여기서 끝)
            continue;
        }
        if is_block_indicator(value) {
            fields.push((key.to_string(), String::new()));
            block = Some(fields.len() - 1);
        } else {
            fields.push((key.to_string(), unquote(value)));
        }
    }
    if !closed {
        return Err(FrontmatterError::Unclosed);
    }
    Ok(Fields(fields))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(text: &str) -> Fields {
        parse(text).unwrap()
    }

    #[test]
    fn reads_plain_lines_and_ignores_the_body() {
        let f = fields(
            "---\nname: harness-helper\ndescription: 정리 담당\nmodel: haiku\n---\n본문: 여기는 읽지 않는다\n",
        );
        assert_eq!(f.get("name"), Some("harness-helper"));
        assert_eq!(f.get("description"), Some("정리 담당"));
        assert_eq!(f.get("model"), Some("haiku"));
        assert_eq!(f.get("본문"), None);
    }

    #[test]
    fn values_starting_or_ending_with_korean_do_not_break_quote_handling() {
        // 버그 재현: 값의 끝 글자가 여러 바이트이면 따옴표 검사 전에 자르다가 패닉했다 (실제 한글 소개 글에서 발견)
        let f = fields("---\na: 가\nb: \"가\"\nc: '나다'\nd: 한\n---\n");
        assert_eq!(f.get("a"), Some("가"));
        assert_eq!(f.get("b"), Some("가"));
        assert_eq!(f.get("c"), Some("나다"));
        assert_eq!(f.get("d"), Some("한"));
    }

    #[test]
    fn a_value_keeps_colons_and_inner_spaces() {
        let f = fields("---\ndescription: 이렇게: 쓴다 — a: b   c\n---\n");
        assert_eq!(f.get("description"), Some("이렇게: 쓴다 — a: b   c"));
    }

    #[test]
    fn bom_and_crlf_are_fine() {
        let f = fields("\u{feff}---\r\nname: a\r\ndescription: b\r\n---\r\nbody\r\n");
        assert_eq!(f.get("name"), Some("a"));
        assert_eq!(f.get("description"), Some("b"));
    }

    #[test]
    fn no_opening_line_is_missing() {
        for text in [
            "",
            "name: a\n",
            "\n---\nname: a\n---\n",
            "-- -\n",
            "# title\n---\n",
        ] {
            assert_eq!(parse(text), Err(FrontmatterError::Missing), "{text:?}");
        }
    }

    #[test]
    fn no_closing_line_is_unclosed() {
        assert_eq!(parse("---\nname: a\n"), Err(FrontmatterError::Unclosed));
        assert_eq!(parse("---"), Err(FrontmatterError::Unclosed));
        assert_eq!(parse("---\n"), Err(FrontmatterError::Unclosed));
    }

    #[test]
    fn an_empty_frontmatter_is_valid_and_has_no_fields() {
        assert_eq!(fields("---\n---\n"), Fields::default());
    }

    #[test]
    fn quoted_values_lose_their_quotes() {
        let f = fields(
            "---\na: \"둘 중 하나: x\"\nb: 'it''s'\nc: \"say \\\"hi\\\"\"\nd: \"open\ne: 'x\n---\n",
        );
        assert_eq!(f.get("a"), Some("둘 중 하나: x"));
        assert_eq!(f.get("b"), Some("it's"));
        assert_eq!(f.get("c"), Some("say \"hi\""));
        // 짝이 안 맞는 따옴표는 그대로
        assert_eq!(f.get("d"), Some("\"open"));
        assert_eq!(f.get("e"), Some("'x"));
    }

    #[test]
    fn empty_values_are_empty_strings_not_missing() {
        let f = fields("---\nname:\ndescription:    \nmodel: \"\"\n---\n");
        assert_eq!(f.get("name"), Some(""));
        assert_eq!(f.non_empty("name"), None);
        assert_eq!(f.non_empty("description"), None);
        assert_eq!(f.non_empty("model"), None);
        assert_eq!(f.get("effort"), None);
    }

    #[test]
    fn nested_blocks_and_lists_are_skipped() {
        let f = fields(
            "---\nname: a\nhooks:\n  PreToolUse:\n    - matcher: \"Bash\"\n      hooks:\n        - type: command\ntools:\n- Read\n- Write\ncolor: blue\n---\n",
        );
        assert_eq!(f.get("name"), Some("a"));
        assert_eq!(f.get("hooks"), Some(""));
        // 들여쓴 줄의 `type: command` 가 위로 올라오지 않는다
        assert_eq!(f.get("type"), None);
        assert_eq!(f.get("matcher"), None);
        assert_eq!(f.get("color"), Some("blue"));
    }

    #[test]
    fn block_scalars_are_joined_into_one_line() {
        let f = fields(
            "---\nname: a\ndescription: >-\n  첫 줄\n  둘째 줄\n\n  셋째\nmodel: opus\ncolor: |\n  red\n---\n",
        );
        assert_eq!(f.get("description"), Some("첫 줄 둘째 줄 셋째"));
        assert_eq!(f.get("model"), Some("opus"));
        assert_eq!(f.get("color"), Some("red"));
    }

    #[test]
    fn the_first_of_a_repeated_key_wins() {
        let f = fields(
            "---\nname: first\nname: second\ndescription: >\n  one\ndescription: >\n  two\n---\n",
        );
        assert_eq!(f.get("name"), Some("first"));
        assert_eq!(f.get("description"), Some("one"));
    }

    #[test]
    fn comments_blank_lines_and_junk_lines_are_ignored() {
        let f = fields("---\n# 주석\n\nnot a key value\n: no key\nbad key: 1\nname: a\n---\n");
        assert_eq!(f.get("name"), Some("a"));
        assert_eq!(f.get("bad key"), None);
    }

    #[test]
    fn keys_are_case_sensitive() {
        let f = fields("---\ndisallowedTools: Write\n---\n");
        assert_eq!(f.get("disallowedTools"), Some("Write"));
        assert_eq!(f.get("disallowedtools"), None);
    }

    #[test]
    fn the_closing_line_may_have_trailing_spaces() {
        assert!(parse("---  \nname: a\n---\t\n").is_ok());
    }

    #[test]
    fn a_three_dash_line_closes_the_frontmatter_even_before_other_text() {
        let f = fields("---\nname: a\n---\nignored: x\n---\n");
        assert_eq!(f.get("ignored"), None);
    }
}
