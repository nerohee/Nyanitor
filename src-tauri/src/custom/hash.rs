//! 통째 바꾼 파일의 "만들 때의 원본 해시" (약속 3-5절) — 앱이 직접 계산한다 (`install --origin-hash` 를 저장마다 띄우지 않으려고, D-51).
//!
//! 규칙은 설치 스크립트와 같다: `.md` 는 줄바꿈을 LF 로 맞춘 뒤 (줄 끝 CR 을 지우고 마지막 줄에 줄바꿈을 보장 — 스크립트가 그렇게 한다) sha256,
//! 그 밖의 파일은 바이트 그대로. 결과는 16진수 소문자 64글자. SHA-256 은 `sha2` (이미 Tauri 쪽 의존성으로 들어 있던 판) 를 쓴다.

use sha2::{Digest, Sha256};

/// 바이트의 sha256 (16진수 소문자 64글자)
pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 줄바꿈을 LF 로 맞춘다 — 줄 끝(다음이 LF 이거나 파일 끝)의 CR 을 지우고, 비어 있지 않으면 마지막에 줄바꿈을 보장한다 (설치 스크립트 `Get-NormBytes` · `norm_text` 와 같다).
pub fn normalize_lf(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + 1);
    for (i, &byte) in bytes.iter().enumerate() {
        if byte == b'\r' && (i + 1 == bytes.len() || bytes[i + 1] == b'\n') {
            continue;
        }
        out.push(byte);
    }
    if out.last().is_some_and(|&last| last != b'\n') {
        out.push(b'\n');
    }
    out
}

/// 원본 파일의 "만들 때의 해시" — `.md` 는 LF 로 맞춘 뒤, 그 밖은 바이트 그대로 (`install --origin-hash` 와 같다).
pub fn origin_hash(rel_path: &str, bytes: &[u8]) -> String {
    if rel_path.ends_with(".md") {
        sha256_hex(&normalize_lf(bytes))
    } else {
        sha256_hex(bytes)
    }
}

/// `.origin` 파일 글 → 해시 (공백 · 줄바꿈을 지우고 소문자로, 16진수 64글자가 아니면 `None`) — 설치 스크립트의 읽기와 같다.
pub fn parse_recorded(text: &str) -> Option<String> {
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\r' | '\n'))
        .map(|c| c.to_ascii_lowercase())
        .collect();
    (cleaned.len() == 64
        && cleaned
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_test_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }

    #[test]
    fn padding_edges_around_one_block() {
        // 55 · 56 · 63 · 64 · 65 바이트 — 끝 채우기가 블록 경계를 넘는 경우 (다른 도구로 낸 값)
        let a55 = "a".repeat(55);
        let a56 = "a".repeat(56);
        let a64 = "a".repeat(64);
        assert_eq!(
            sha256_hex(a55.as_bytes()),
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318"
        );
        assert_eq!(
            sha256_hex(a56.as_bytes()),
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a"
        );
        assert_eq!(
            sha256_hex(a64.as_bytes()),
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb"
        );
    }

    #[test]
    fn million_a() {
        let data = vec![b'a'; 1_000_000];
        assert_eq!(
            sha256_hex(&data),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn md_hash_ignores_crlf_and_adds_the_final_newline_but_other_files_are_bytes() {
        let lf = b"a\nb\n";
        let crlf = b"a\r\nb\r\n";
        let no_final = b"a\r\nb";
        assert_eq!(
            origin_hash("agents/x.md", lf),
            origin_hash("agents/x.md", crlf)
        );
        assert_eq!(
            origin_hash("agents/x.md", lf),
            origin_hash("agents/x.md", no_final)
        );
        assert_eq!(origin_hash("agents/x.md", lf), sha256_hex(lf));
        assert_ne!(
            origin_hash("agents/x.txt", lf),
            origin_hash("agents/x.txt", crlf)
        );
        assert_eq!(origin_hash("agents/x.txt", crlf), sha256_hex(crlf));
        // 줄 한가운데의 CR 은 그대로다
        assert_eq!(normalize_lf(b"a\rb\n"), b"a\rb\n");
        assert_eq!(normalize_lf(b""), b"");
    }

    #[test]
    fn recorded_hash_is_read_like_the_script_does() {
        let hex = "ab".repeat(32);
        assert_eq!(parse_recorded(&format!("{hex}\n")), Some(hex.clone()));
        assert_eq!(
            parse_recorded(&format!(" {}\r\n", hex.to_uppercase())),
            Some(hex.clone())
        );
        assert_eq!(parse_recorded("abc"), None);
        assert_eq!(parse_recorded(&format!("{hex}0")), None);
        assert_eq!(parse_recorded(&"g".repeat(64)), None);
        assert_eq!(parse_recorded(""), None);
    }
}
