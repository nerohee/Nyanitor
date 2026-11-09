//! JSON 글에서 글 값 하나만 고치기 — 모르는 키 · 키 순서 · 들여쓰기를 그대로 둔다 (약속 3절: `custom/config.local.json` 은 모르는 키를 지켜야 한다).
//!
//! `serde_json` 의 맵은 키를 정렬해서 다시 쓰므로 (`preserve_order` 는 켜지 않았다) 글 위치만 찾아 그 부분만 바꾼다.
//! 입력은 이미 올바른 JSON 이라고 본다 (부르는 쪽이 `serde_json` 으로 먼저 읽어 본다). 깨진 글이면 `Err` 로 돌려줘 아무것도 바꾸지 않는다.

/// 고치지 못한 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditError {
    /// 글이 JSON 모양이 아니다 (읽다가 길을 잃었다)
    Malformed,
    /// 길 중간의 값이 객체가 아니다 (예: `planner` 가 글이다)
    NotAnObject,
}

struct Member {
    key: String,
    /// 키의 시작 (여는 따옴표)
    start: usize,
    value_start: usize,
    value_end: usize,
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    i
}

/// `"` 로 시작하는 글 값의 끝 (닫는 따옴표 다음 위치)
fn string_end(bytes: &[u8], start: usize) -> Result<usize, EditError> {
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' => return Ok(i + 1),
            _ => i += 1,
        }
    }
    Err(EditError::Malformed)
}

/// 값 하나의 끝 (그 다음 위치)
fn value_end(bytes: &[u8], start: usize) -> Result<usize, EditError> {
    let first = *bytes.get(start).ok_or(EditError::Malformed)?;
    match first {
        b'"' => string_end(bytes, start),
        b'{' | b'[' => {
            let mut depth = 0usize;
            let mut i = start;
            while i < bytes.len() {
                match bytes[i] {
                    b'"' => {
                        i = string_end(bytes, i)?;
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(i + 1);
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            Err(EditError::Malformed)
        }
        _ => {
            let mut i = start;
            while i < bytes.len()
                && !matches!(bytes[i], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n')
            {
                i += 1;
            }
            if i == start {
                Err(EditError::Malformed)
            } else {
                Ok(i)
            }
        }
    }
}

/// `open`(`{` 의 위치)에서 시작하는 객체의 멤버들과 닫는 `}` 의 위치
fn members(text: &str, open: usize) -> Result<(Vec<Member>, usize), EditError> {
    let bytes = text.as_bytes();
    if bytes.get(open) != Some(&b'{') {
        return Err(EditError::NotAnObject);
    }
    let mut out = Vec::new();
    let mut i = skip_ws(bytes, open + 1);
    loop {
        match bytes.get(i) {
            Some(b'}') => return Ok((out, i)),
            Some(b'"') => {
                let key_end = string_end(bytes, i)?;
                let key: String =
                    serde_json::from_str(&text[i..key_end]).map_err(|_| EditError::Malformed)?;
                let colon = skip_ws(bytes, key_end);
                if bytes.get(colon) != Some(&b':') {
                    return Err(EditError::Malformed);
                }
                let value_start = skip_ws(bytes, colon + 1);
                let end = value_end(bytes, value_start)?;
                out.push(Member {
                    key,
                    start: i,
                    value_start,
                    value_end: end,
                });
                i = skip_ws(bytes, end);
                match bytes.get(i) {
                    Some(b',') => i = skip_ws(bytes, i + 1),
                    Some(b'}') => {}
                    _ => return Err(EditError::Malformed),
                }
            }
            _ => return Err(EditError::Malformed),
        }
    }
}

/// 위치가 든 줄의 들여쓰기 (공백 · 탭)
fn line_indent(text: &str, at: usize) -> String {
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    text[line_start..at]
        .chars()
        .take_while(|c| *c == ' ' || *c == '\t')
        .collect()
}

fn quote(value: &str) -> String {
    serde_json::to_string(value).expect("a string always serializes")
}

/// 멤버를 객체 끝에 더한다. 객체가 여러 줄이면 같은 들여쓰기로 줄을 바꿔 더하고, 한 줄이면 `, "키": 값` 으로 더한다.
fn insert_member(
    text: &str,
    open: usize,
    close: usize,
    found: &[Member],
    key: &str,
    value_json: &str,
) -> String {
    let member = format!("{}: {}", quote(key), value_json);
    let mut out = String::with_capacity(text.len() + member.len() + 8);
    match found.last() {
        Some(last) => {
            let first = &found[0];
            let multi_line = text[open..first.start].contains('\n');
            out.push_str(&text[..last.value_end]);
            out.push(',');
            if multi_line {
                out.push('\n');
                out.push_str(&line_indent(text, first.start));
            } else {
                out.push(' ');
            }
            out.push_str(&member);
            out.push_str(&text[last.value_end..]);
        }
        None => {
            // 빈 객체 `{}` — 여러 줄로 쓴다
            let base = line_indent(text, open);
            out.push_str(&text[..open + 1]);
            out.push('\n');
            out.push_str(&base);
            out.push_str("  ");
            out.push_str(&member);
            out.push('\n');
            out.push_str(&base);
            out.push_str(&text[close..]);
        }
    }
    out
}

/// 멤버 하나를 지운다 (앞뒤 쉼표 · 공백까지)
fn remove_member(text: &str, found: &[Member], index: usize) -> String {
    let bytes = text.as_bytes();
    let member = &found[index];
    let (cut_from, cut_to) = if index + 1 < found.len() {
        // 뒤에 멤버가 있다 — 이 멤버 · 쉼표 · 다음 멤버 앞의 공백까지
        (member.start, found[index + 1].start)
    } else if index > 0 {
        // 마지막 멤버 — 앞 멤버 끝의 쉼표부터
        (found[index - 1].value_end, member.value_end)
    } else {
        // 하나뿐인 멤버 — 중괄호 안을 비운다
        let mut from = member.start;
        while from > 0 && matches!(bytes[from - 1], b' ' | b'\t' | b'\r' | b'\n') {
            from -= 1;
        }
        (from, skip_ws(bytes, member.value_end))
    };
    format!("{}{}", &text[..cut_from], &text[cut_to..])
}

/// 중첩한 값의 길(`["planner", "model"]`)에 글 값을 쓴다. `value` 가 `None` 이면 그 키를 지운다 (없으면 아무 일도 없다).
/// 길 중간의 객체가 없으면 만들고, 있는데 객체가 아니면 `NotAnObject`. 모르는 키 · 순서 · 들여쓰기는 그대로.
pub fn set_string(text: &str, path: &[&str], value: Option<&str>) -> Result<String, EditError> {
    let bytes = text.as_bytes();
    let mut open = skip_ws(bytes, 0);
    if bytes.get(open) != Some(&b'{') {
        return Err(EditError::NotAnObject);
    }
    for (depth, key) in path.iter().enumerate() {
        let (found, close) = members(text, open)?;
        let is_leaf = depth + 1 == path.len();
        let at = found.iter().position(|m| m.key == *key);
        if is_leaf {
            return Ok(match (at, value) {
                (Some(i), Some(v)) => format!(
                    "{}{}{}",
                    &text[..found[i].value_start],
                    quote(v),
                    &text[found[i].value_end..]
                ),
                (Some(i), None) => remove_member(text, &found, i),
                (None, Some(v)) => insert_member(text, open, close, &found, key, &quote(v)),
                (None, None) => text.to_string(),
            });
        }
        match at {
            Some(i) => {
                if bytes.get(found[i].value_start) != Some(&b'{') {
                    return Err(EditError::NotAnObject);
                }
                open = found[i].value_start;
            }
            None => {
                let Some(v) = value else {
                    return Ok(text.to_string());
                };
                // 없는 객체를 길 끝까지 한꺼번에 만든다
                let base = line_indent(text, open);
                let mut nested = quote(v);
                for (level, inner) in path.iter().enumerate().skip(depth + 1).rev() {
                    let pad = format!("{base}{}", "  ".repeat(level - depth + 1));
                    nested = format!(
                        "{{\n{pad}{}: {nested}\n{}}}",
                        quote(inner),
                        format_args!("{base}{}", "  ".repeat(level - depth))
                    );
                }
                return Ok(insert_member(text, open, close, &found, key, &nested));
            }
        }
    }
    Err(EditError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap_or_else(|e| panic!("{e}: {text}"))
    }

    const CONFIG: &str = "{\n  \"language\": \"ko\",\n  \"planner\": {\n    \"model\": \"opus\",\n    \"effort\": \"high\"\n  },\n  \"agents\": {\n    \"ui\": \"harness-builder-ui\"\n  },\n  \"zzz\": [1, 2, {\"a\": \"b\"}]\n}\n";

    #[test]
    fn replaces_one_value_and_keeps_everything_else_byte_for_byte() {
        let out = set_string(CONFIG, &["planner", "model"], Some("sonnet")).unwrap();
        assert_eq!(out, CONFIG.replace("\"opus\"", "\"sonnet\""));
        assert_eq!(parse(&out)["planner"]["model"], "sonnet");
    }

    #[test]
    fn adds_a_missing_key_with_the_same_indent_and_keeps_the_order() {
        let text = "{\n  \"planner\": {\n    \"model\": \"opus\"\n  },\n  \"b\": 1\n}";
        let out = set_string(text, &["planner", "effort"], Some("low")).unwrap();
        assert_eq!(
            out,
            "{\n  \"planner\": {\n    \"model\": \"opus\",\n    \"effort\": \"low\"\n  },\n  \"b\": 1\n}"
        );
        assert_eq!(parse(&out)["planner"]["effort"], "low");
    }

    #[test]
    fn adds_to_a_one_line_object_and_to_an_empty_one() {
        let out = set_string(
            "{\"planner\": {\"model\": \"opus\"}}",
            &["planner", "effort"],
            Some("low"),
        )
        .unwrap();
        assert_eq!(
            out,
            "{\"planner\": {\"model\": \"opus\", \"effort\": \"low\"}}"
        );
        let out = set_string(
            "{\n  \"planner\": {}\n}",
            &["planner", "model"],
            Some("haiku"),
        )
        .unwrap();
        assert_eq!(parse(&out)["planner"]["model"], "haiku");
        assert_eq!(out, "{\n  \"planner\": {\n    \"model\": \"haiku\"\n  }\n}");
    }

    #[test]
    fn creates_the_missing_parent_object() {
        let out = set_string(
            "{\n  \"language\": \"ko\"\n}\n",
            &["planner", "model"],
            Some("opus"),
        )
        .unwrap();
        let value = parse(&out);
        assert_eq!(value["planner"]["model"], "opus");
        assert_eq!(value["language"], "ko");
        let out = set_string("{}", &["agents", "ui"], Some("danchu")).unwrap();
        assert_eq!(parse(&out)["agents"]["ui"], "danchu");
        // 지우려는데 길이 없으면 아무 일도 없다
        assert_eq!(
            set_string("{\"a\": 1}", &["planner", "model"], None).unwrap(),
            "{\"a\": 1}"
        );
    }

    #[test]
    fn removes_first_middle_last_and_only_members() {
        let text = "{\n  \"a\": 1,\n  \"b\": \"x\",\n  \"c\": [1]\n}";
        assert_eq!(
            parse(&set_string(text, &["a"], None).unwrap()),
            parse("{\"b\":\"x\",\"c\":[1]}")
        );
        assert_eq!(
            parse(&set_string(text, &["b"], None).unwrap()),
            parse("{\"a\":1,\"c\":[1]}")
        );
        assert_eq!(
            parse(&set_string(text, &["c"], None).unwrap()),
            parse("{\"a\":1,\"b\":\"x\"}")
        );
        assert_eq!(
            parse(&set_string("{\"a\": \"x\"}", &["a"], None).unwrap()),
            parse("{}")
        );
        assert_eq!(
            parse(&set_string("{\n  \"a\": \"x\"\n}\n", &["a"], None).unwrap()),
            parse("{}")
        );
    }

    #[test]
    fn strings_with_escapes_braces_and_unicode_do_not_confuse_the_scanner() {
        let text = "{\n  \"note\": \"a \\\"quoted\\\" } { , value\",\n  \"한글\": \"값\",\n  \"planner\": {\"model\": \"opus\"}\n}";
        let out = set_string(text, &["planner", "model"], Some("haiku")).unwrap();
        assert_eq!(parse(&out)["planner"]["model"], "haiku");
        assert_eq!(parse(&out)["note"], "a \"quoted\" } { , value");
        assert_eq!(parse(&out)["한글"], "값");
        // 값이 따옴표 · 역슬래시를 품어도 올바른 JSON 으로 쓴다
        let out = set_string("{\"a\": \"x\"}", &["a"], Some("q\"b\\c\nd")).unwrap();
        assert_eq!(parse(&out)["a"], "q\"b\\c\nd");
    }

    #[test]
    fn replaces_a_non_string_value_and_refuses_a_non_object_parent() {
        let out = set_string(
            "{\"planner\": {\"model\": null, \"effort\": 3}}",
            &["planner", "model"],
            Some("opus"),
        )
        .unwrap();
        assert_eq!(parse(&out)["planner"]["model"], "opus");
        assert_eq!(
            set_string("{\"planner\": \"x\"}", &["planner", "model"], Some("a")),
            Err(EditError::NotAnObject)
        );
        assert_eq!(
            set_string("[1]", &["a"], Some("b")),
            Err(EditError::NotAnObject)
        );
        assert_eq!(
            set_string("{\"a\": ", &["a"], Some("b")),
            Err(EditError::Malformed)
        );
        assert_eq!(
            set_string("", &["a"], Some("b")),
            Err(EditError::NotAnObject)
        );
    }
}
