//! 값 바꾸기 — `*.values.yml` 읽기 · 쓰기 (약속 3-1절)와 앞머리(`---` 사이)의 한 줄 값 고치기 (내가 만든 파일은 값 파일 대신 앞머리를 직접 고친다).
//!
//! 읽기는 설치 스크립트(`Get-ValueRows`)와 같은 규칙이라, 스크립트가 받아들이는 파일은 앱도 읽고 그 반대도 같다: 빈 줄 · `#` 줄은 무시, 나머지는 `키: 값`
//! (키 `[A-Za-z][A-Za-z0-9_-]*`, `name` · `hooks` 금지, 값은 한 줄 · 비어 있지 않음 · 탭 없음, 같은 키 두 번 금지). CRLF 도 읽는다.
//! 쓰기는 `model` · `effort` 두 키만 바꾼다 — 주석 · 다른 키 · 순서는 그대로 두고 LF 로 쓴다.

/// 앱이 바꾸는 값의 키와 고를 수 있는 값 (한 곳의 상수 — 나중에 늘릴 수 있게)
pub const MODELS: [&str; 3] = ["opus", "sonnet", "haiku"];
pub const EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// 앱이 다루는 값 둘 — 화면이 보내는 "바라는 값 전체" 이기도 하다 (`None` = 원본 값으로). 모르는 필드는 거절한다.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Values {
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl Values {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.effort.is_none()
    }
}

/// 값 파일이 스크립트가 받아들이는 모양이 아니다
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadValues(pub String);

fn lines_of(text: &str) -> Vec<&str> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines: Vec<&str> = text.split('\n').collect();
    // 마지막 줄바꿈 뒤의 빈 조각은 줄이 아니다
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
        .into_iter()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect()
}

fn is_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 값 파일의 `키: 값` 줄들 (줄 번호 · 키 · 값). 스크립트와 같은 규칙으로 모양을 확인한다.
fn rows(text: &str) -> Result<Vec<(usize, String, String)>, BadValues> {
    let mut out: Vec<(usize, String, String)> = Vec::new();
    for (index, line) in lines_of(text).into_iter().enumerate() {
        let number = index + 1;
        let trimmed = line.trim_matches([' ', '\t']);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(colon) = line.find(':').filter(|i| *i >= 1) else {
            return Err(BadValues(format!("line {number} is not `key: value`")));
        };
        let key = &line[..colon];
        let value = line[colon + 1..].trim_matches([' ', '\t']);
        if !is_key(key) {
            return Err(BadValues(format!("line {number}: bad key")));
        }
        if key == "name" || key == "hooks" {
            return Err(BadValues(format!("line {number}: {key} cannot be changed")));
        }
        if value.is_empty() || value.contains('\t') {
            return Err(BadValues(format!("line {number}: bad value for {key}")));
        }
        if out.iter().any(|(_, k, _)| k == key) {
            return Err(BadValues(format!("line {number}: {key} appears twice")));
        }
        out.push((number, key.to_string(), value.to_string()));
    }
    Ok(out)
}

/// 값 파일에서 `model` · `effort` 를 읽는다 (그 밖의 키는 건너뛴다)
pub fn parse_values(text: &str) -> Result<Values, BadValues> {
    let rows = rows(text)?;
    let pick = |key: &str| {
        rows.iter()
            .find(|(_, k, _)| k == key)
            .map(|(_, _, v)| v.clone())
    };
    Ok(Values {
        model: pick("model"),
        effort: pick("effort"),
    })
}

/// 값 파일의 새 글 — `existing` 에서 `model` · `effort` 줄만 바꾼다 (`None` 이면 그 줄을 지운다, 없던 키는 끝에 더한다).
/// `key: value` 줄이 하나도 안 남으면 `None` (파일을 지운다). `existing` 이 스크립트가 받아들이는 모양이 아니면 `BadValues`.
pub fn render_values(existing: Option<&str>, wanted: &Values) -> Result<Option<String>, BadValues> {
    let mut lines: Vec<String> = match existing {
        Some(text) => {
            rows(text)?; // 모양 확인
            lines_of(text).into_iter().map(str::to_string).collect()
        }
        None => Vec::new(),
    };
    for (key, value) in [("model", &wanted.model), ("effort", &wanted.effort)] {
        let at = lines.iter().position(|line| {
            line.strip_prefix(key)
                .is_some_and(|rest| rest.starts_with(':'))
        });
        match (at, value) {
            (Some(i), Some(v)) => lines[i] = format!("{key}: {v}"),
            (Some(i), None) => {
                lines.remove(i);
            }
            (None, Some(v)) => lines.push(format!("{key}: {v}")),
            (None, None) => {}
        }
    }
    let text = lines.join("\n") + "\n";
    // 남은 키가 없으면 (주석뿐이어도) 파일은 필요 없다
    if rows(&text)?.is_empty() {
        return Ok(None);
    }
    Ok(Some(text))
}

/// 앞머리를 고칠 수 없는 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontError {
    /// 첫 줄이 `---` 가 아니다
    NoFrontmatter,
    /// 닫는 `---` 가 없다
    Unclosed,
    /// 그 키의 값이 여러 줄이다 (줄 하나만 바꿀 수 없다)
    MultiLine,
}

/// 앞머리의 `key: value` 한 줄을 바꾼다 (`None` 이면 줄을 지운다, 없던 키는 닫는 `---` 앞에 더한다). 글 전체를 LF 로 돌려준다.
pub fn set_front_value(text: &str, key: &str, value: Option<&str>) -> Result<String, FrontError> {
    let text = text
        .strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n");
    let mut lines: Vec<&str> = text.split('\n').collect();
    // 마지막 줄바꿈 뒤의 빈 조각은 줄이 아니다 (다시 붙일 때 돌려놓는다)
    let had_final_newline = lines.last() == Some(&"");
    if had_final_newline {
        lines.pop();
    }
    if lines.first().map(|l| l.trim_end()) != Some("---") {
        return Err(FrontError::NoFrontmatter);
    }
    let close = lines
        .iter()
        .skip(1)
        .position(|l| l.trim_end() == "---")
        .map(|i| i + 1)
        .ok_or(FrontError::Unclosed)?;
    let prefix = format!("{key}:");
    let at = lines[1..close]
        .iter()
        .position(|l| l.starts_with(&prefix))
        .map(|i| i + 1);
    let mut out: Vec<String> = lines.iter().map(|l| (*l).to_string()).collect();
    match (at, value) {
        (Some(i), Some(v)) => {
            reject_multi_line(&lines, i, close)?;
            out[i] = format!("{key}: {v}");
        }
        (Some(i), None) => {
            reject_multi_line(&lines, i, close)?;
            out.remove(i);
        }
        (None, Some(v)) => out.insert(close, format!("{key}: {v}")),
        (None, None) => {}
    }
    let mut joined = out.join("\n");
    if had_final_newline {
        joined.push('\n');
    }
    Ok(joined)
}

/// 값이 다음 줄로 이어지는 키(들여쓴 줄 · `- ` 목록)는 줄 하나만 바꿀 수 없다
fn reject_multi_line(lines: &[&str], at: usize, close: usize) -> Result<(), FrontError> {
    let continues = lines
        .get(at + 1)
        .filter(|_| at + 1 < close)
        .is_some_and(|next| next.starts_with([' ', '\t']) || next.starts_with("- "));
    if continues {
        Err(FrontError::MultiLine)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(model: Option<&str>, effort: Option<&str>) -> Values {
        Values {
            model: model.map(str::to_string),
            effort: effort.map(str::to_string),
        }
    }

    #[test]
    fn reads_comments_blank_lines_crlf_bom_and_any_key_order() {
        let text = "\u{feff}# 값만 바꾼다\r\n\r\neffort: high\r\n  # 들여쓴 주석\r\nmodel:   opus  \r\nextra-key: 1\r\n";
        assert_eq!(
            parse_values(text).unwrap(),
            values(Some("opus"), Some("high"))
        );
        assert_eq!(parse_values("").unwrap(), Values::default());
        assert_eq!(parse_values("# 주석뿐\n").unwrap(), Values::default());
        assert_eq!(
            parse_values("model: sonnet").unwrap(),
            values(Some("sonnet"), None)
        );
    }

    #[test]
    fn refuses_the_shapes_the_install_script_refuses() {
        for bad in [
            "model opus",
            ": opus",
            "mo del: x",
            "1model: x",
            "name: x",
            "hooks: x",
            "model:",
            "model:   ",
            "model: a\nmodel: b",
            "model: a\tb",
            " model: opus",
        ] {
            assert!(parse_values(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rendering_keeps_comments_other_keys_and_order_and_writes_lf() {
        let existing = "# 메모\r\neffort: high\r\ncolor: blue\r\nmodel: opus\r\n";
        let out = render_values(Some(existing), &values(Some("sonnet"), Some("low")))
            .unwrap()
            .unwrap();
        assert_eq!(out, "# 메모\neffort: low\ncolor: blue\nmodel: sonnet\n");
        // 한 키만 지우면 나머지는 그대로
        let out = render_values(Some(existing), &values(None, Some("high")))
            .unwrap()
            .unwrap();
        assert_eq!(out, "# 메모\neffort: high\ncolor: blue\n");
    }

    #[test]
    fn rendering_adds_new_keys_at_the_end_and_creates_from_nothing() {
        assert_eq!(
            render_values(None, &values(Some("haiku"), Some("low")))
                .unwrap()
                .unwrap(),
            "model: haiku\neffort: low\n"
        );
        assert_eq!(
            render_values(Some("effort: low\n"), &values(Some("opus"), Some("low")))
                .unwrap()
                .unwrap(),
            "effort: low\nmodel: opus\n"
        );
    }

    #[test]
    fn no_keys_left_means_the_file_goes_away() {
        assert_eq!(render_values(None, &Values::default()).unwrap(), None);
        assert_eq!(
            render_values(Some("model: opus\neffort: low\n"), &Values::default()).unwrap(),
            None
        );
        // 주석만 남아도 지운다
        assert_eq!(
            render_values(Some("# 메모\nmodel: opus\n"), &Values::default()).unwrap(),
            None
        );
        // 다른 키가 남으면 지우지 않는다
        assert!(
            render_values(Some("color: blue\nmodel: opus\n"), &Values::default())
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn rendering_refuses_a_file_the_script_would_refuse() {
        assert!(render_values(Some("model opus\n"), &values(Some("opus"), None)).is_err());
        assert!(render_values(Some("name: x\n"), &values(Some("opus"), None)).is_err());
    }

    #[test]
    fn the_rendered_file_is_read_back_the_same() {
        let out = render_values(None, &values(Some("opus"), None))
            .unwrap()
            .unwrap();
        assert_eq!(parse_values(&out).unwrap(), values(Some("opus"), None));
    }

    #[test]
    fn front_values_replace_insert_and_remove_one_line() {
        let text = "---\nname: x\ndescription: d\nmodel: sonnet\n---\n\n본문\n";
        assert_eq!(
            set_front_value(text, "model", Some("opus")).unwrap(),
            "---\nname: x\ndescription: d\nmodel: opus\n---\n\n본문\n"
        );
        assert_eq!(
            set_front_value(text, "effort", Some("high")).unwrap(),
            "---\nname: x\ndescription: d\nmodel: sonnet\neffort: high\n---\n\n본문\n"
        );
        assert_eq!(
            set_front_value(text, "model", None).unwrap(),
            "---\nname: x\ndescription: d\n---\n\n본문\n"
        );
        assert_eq!(set_front_value(text, "effort", None).unwrap(), text);
        // 본문의 같은 글자는 건드리지 않는다
        let body = "---\nname: x\n---\nmodel: 본문\n";
        assert_eq!(
            set_front_value(body, "model", Some("opus")).unwrap(),
            "---\nname: x\nmodel: opus\n---\nmodel: 본문\n"
        );
    }

    #[test]
    fn front_values_refuse_broken_or_multi_line_fronts() {
        assert_eq!(
            set_front_value("본문\n", "model", Some("opus")),
            Err(FrontError::NoFrontmatter)
        );
        assert_eq!(
            set_front_value("---\nname: x\n", "model", Some("opus")),
            Err(FrontError::Unclosed)
        );
        assert_eq!(
            set_front_value("---\nname: x\nmodel:\n  - a\n---\n", "model", Some("opus")),
            Err(FrontError::MultiLine)
        );
        assert_eq!(
            set_front_value("---\nname: x\nmodel: a\n- b\n---\n", "model", None),
            Err(FrontError::MultiLine)
        );
    }

    #[test]
    fn front_values_turn_crlf_into_lf() {
        let out = set_front_value(
            "---\r\nname: x\r\nmodel: a\r\n---\r\n본문\r\n",
            "model",
            Some("b"),
        )
        .unwrap();
        assert_eq!(out, "---\nname: x\nmodel: b\n---\n본문\n");
    }
}
