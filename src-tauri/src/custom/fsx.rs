//! 내 수정 폴더(`custom/`) 안의 파일 읽기 · 쓰기 (약속 3절의 쓰기 규칙) — 경로의 어느 단계도 링크가 아닌지 다시 확인하고,
//! 글은 UTF-8(BOM 없음) · LF 로, 파일 하나씩 통째로 (임시 파일에 쓰고 바꿔 넣기) 쓴다. 파일 하나 256KB 까지.
//!
//! 경로는 항목 id 에서 Rust 가 만든 `/` 로 이은 상대 경로(`agents/x.md`)뿐이다 — 이 모듈이 부분마다 다시 확인한다 (`..` · 빈 부분 · `\` · `:` 거절).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

/// 글 파일 하나의 최대 크기 (읽기 · 쓰기 모두)
pub const TEXT_MAX_BYTES: u64 = 256 * 1024;

/// 경로를 쓸 수 없는 이유
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    /// 경로의 어느 단계가 링크(심볼릭 링크 · 정션)다, 또는 폴더여야 할 곳이 파일이다
    Link,
    /// 256KB 를 넘는다
    TooLarge,
    /// 글이 UTF-8 이 아니다
    NotUtf8,
    /// 그 밖의 입출력 오류 (진단용 글)
    Io(String),
}

impl From<io::Error> for FsError {
    fn from(error: io::Error) -> Self {
        FsError::Io(error.to_string())
    }
}

/// 링크 · 정션인가 (Windows 는 재해석 지점이면 모두 링크로 본다)
pub fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// 상대 경로의 부분들 (`/` 로 나눈다). 빈 부분 · `.` · `..` · `\` · `:` · 제어 문자가 있으면 `None`.
fn parts(rel: &str) -> Option<Vec<&str>> {
    let parts: Vec<&str> = rel.split('/').collect();
    parts
        .iter()
        .all(|part| {
            !part.is_empty()
                && *part != "."
                && *part != ".."
                && !part.contains(['\\', ':'])
                && !part.chars().any(char::is_control)
        })
        .then_some(parts)
}

/// `root`(내 수정 폴더)부터 `rel` 까지 어느 단계도 링크가 아닌지, 중간 단계가 폴더인지 확인한다. 아직 없는 곳부터는 확인할 것이 없다.
pub fn check_plain(root: &Path, rel: &str) -> Result<(), FsError> {
    let Some(parts) = parts(rel) else {
        return Err(FsError::Link);
    };
    let mut current = root.to_path_buf();
    match fs::symlink_metadata(&current) {
        Ok(meta) if is_link(&meta) => return Err(FsError::Link),
        Ok(meta) if !meta.is_dir() => return Err(FsError::Link),
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    }
    let last = parts.len() - 1;
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        match fs::symlink_metadata(&current) {
            Ok(meta) if is_link(&meta) => return Err(FsError::Link),
            Ok(meta) if index < last && !meta.is_dir() => return Err(FsError::Link),
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
        }
    }
    // 마지막으로, 실제로 가리키는 곳이 `root` 안인지 (링크가 없으니 같아야 하지만 한 번 더 본다)
    let (Ok(real_root), Ok(real)) = (fs::canonicalize(root), fs::canonicalize(&current)) else {
        return Ok(());
    };
    if real.starts_with(&real_root) {
        Ok(())
    } else {
        Err(FsError::Link)
    }
}

/// `root` 아래 `rel` 의 실제 경로 (확인은 `check_plain` 이 한다)
pub fn join(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

/// 파일이 있는가 (링크 · 폴더 단계 확인 포함). 없으면 `false`.
pub fn exists(root: &Path, rel: &str) -> Result<bool, FsError> {
    check_plain(root, rel)?;
    match fs::symlink_metadata(join(root, rel)) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

/// 바이트를 256KB 까지 읽는다 (넘으면 `TooLarge`). 파일이 없으면 `None`.
fn read_capped(path: &Path) -> Result<Option<Vec<u8>>, FsError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    if file.metadata()?.is_dir() {
        return Err(FsError::Io("is a directory".into()));
    }
    let mut bytes = Vec::new();
    file.take(TEXT_MAX_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > TEXT_MAX_BYTES {
        return Err(FsError::TooLarge);
    }
    Ok(Some(bytes))
}

/// 바이트 → 글 (UTF-8 이 아니면 `NotUtf8`, BOM 은 뗀다)
pub fn utf8(bytes: Vec<u8>) -> Result<String, FsError> {
    let text = String::from_utf8(bytes).map_err(|_| FsError::NotUtf8)?;
    Ok(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_string(),
        None => text,
    })
}

/// 내 수정 폴더 안의 파일을 읽는다 (링크가 끼어 있으면 `Link`). 없으면 `None`. BOM 은 떼서 돌려준다.
pub fn read_text(root: &Path, rel: &str) -> Result<Option<String>, FsError> {
    check_plain(root, rel)?;
    read_capped(&join(root, rel))?.map(utf8).transpose()
}

/// 원본 폴더 안의 파일을 바이트 그대로 읽는다 (해시는 BOM 까지 바이트 그대로 계산한다). 링크는 따라가되 원본 폴더 밖을 가리키면 없는 것으로 본다 (`agents` · `skills` 목록과 같은 규칙).
pub fn read_source_bytes(source: &Path, rel: &str) -> Result<Option<Vec<u8>>, FsError> {
    if parts(rel).is_none() {
        return Err(FsError::Link);
    }
    let path = join(source, rel);
    match fs::symlink_metadata(&path) {
        Ok(meta) if is_link(&meta) => {
            let (Ok(base), Ok(real)) = (fs::canonicalize(source), fs::canonicalize(&path)) else {
                return Ok(None); // 끊어진 링크
            };
            if !real.starts_with(&base) || !real.is_file() {
                return Ok(None);
            }
        }
        Ok(meta) if meta.is_dir() => return Ok(None),
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    }
    read_capped(&path)
}

/// 원본 폴더 안의 파일을 글로 읽는다 (BOM 은 떼서). 읽는 규칙은 `read_source_bytes` 와 같다.
pub fn read_source(source: &Path, rel: &str) -> Result<Option<String>, FsError> {
    read_source_bytes(source, rel)?.map(utf8).transpose()
}

/// 쓸 글을 맞춘다 — BOM 떼기 · CRLF → LF
pub fn normalize_text(text: &str) -> String {
    text.strip_prefix('\u{feff}')
        .unwrap_or(text)
        .replace("\r\n", "\n")
}

static TMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// 같은 폴더의 임시 파일에 쓰고 → 디스크에 내리고 → 이름을 바꿔 덮는다. 실패하면 임시 파일을 지우고 옛 파일은 그대로 둔다.
/// 임시 파일 이름은 `.<파일>.nyanitor-<번호>.tmp` — 기록(`.gitignore`)이 무시한다.
fn write_atomically(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = target.parent().unwrap_or(Path::new("."));
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(
        ".{name}.nyanitor-{}-{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        // `create_new` — 이미 있는 것(링크 포함)을 따라가 덮어쓰지 않는다
        let mut file = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// 글을 쓴다 (BOM 없음 · LF · 통째로 새로). 폴더는 알아서 만든다. 256KB 를 넘으면 `TooLarge`.
pub fn write_text(root: &Path, rel: &str, text: &str) -> Result<(), FsError> {
    let text = normalize_text(text);
    if text.len() as u64 > TEXT_MAX_BYTES {
        return Err(FsError::TooLarge);
    }
    check_plain(root, rel)?;
    let target = join(root, rel);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    // 폴더를 만든 뒤 한 번 더 — 만든 것이 링크 위가 아닌지
    check_plain(root, rel)?;
    write_atomically(&target, text.as_bytes())?;
    Ok(())
}

/// 파일을 지운다 (없으면 아무 일도 없다)
pub fn remove_file(root: &Path, rel: &str) -> Result<(), FsError> {
    check_plain(root, rel)?;
    match fs::remove_file(join(root, rel)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// 비어 있으면 폴더를 지운다 (비어 있지 않거나 없으면 아무 일도 없다)
pub fn remove_dir_if_empty(root: &Path, rel: &str) -> Result<(), FsError> {
    check_plain(root, rel)?;
    let path = join(root, rel);
    if let Ok(mut entries) = fs::read_dir(&path)
        && entries.next().is_none()
    {
        fs::remove_dir(&path)?;
    }
    Ok(())
}

/// 폴더를 안에 든 것째 지운다. 안에 링크가 하나라도 있으면 지우지 않고 `Link`.
pub fn remove_dir_all(root: &Path, rel: &str) -> Result<(), FsError> {
    check_plain(root, rel)?;
    let path = join(root, rel);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => return Err(FsError::Link),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    }
    fn no_links(dir: &Path) -> Result<(), FsError> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if is_link(&meta) {
                return Err(FsError::Link);
            }
            if meta.is_dir() {
                no_links(&entry.path())?;
            }
        }
        Ok(())
    }
    no_links(&path)?;
    fs::remove_dir_all(&path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;
    use crate::custom::test_support::make_dir_link;

    #[test]
    fn writes_utf8_lf_without_bom_and_replaces_in_place() {
        let dir = TempDir::new("fsx-write");
        write_text(&dir, "agents/a.md", "\u{feff}첫째\r\n둘째\r\n").unwrap();
        let bytes = fs::read(dir.join("agents").join("a.md")).unwrap();
        assert_eq!(bytes, "첫째\n둘째\n".as_bytes());
        write_text(&dir, "agents/a.md", "새 글\n").unwrap();
        assert_eq!(read_text(&dir, "agents/a.md").unwrap().unwrap(), "새 글\n");
        // 임시 파일이 남지 않는다
        let names: Vec<String> = fs::read_dir(dir.join("agents"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["a.md"]);
    }

    #[test]
    fn a_text_over_256kb_is_refused_before_anything_is_written() {
        let dir = TempDir::new("fsx-big");
        let big = "a".repeat(TEXT_MAX_BYTES as usize + 1);
        assert_eq!(
            write_text(&dir, "agents/a.md", &big),
            Err(FsError::TooLarge)
        );
        assert!(!dir.join("agents").exists());
        let exact = "a".repeat(TEXT_MAX_BYTES as usize);
        write_text(&dir, "agents/a.md", &exact).unwrap();
        // 파일이 커서 못 읽는 경우
        fs::write(dir.join("agents").join("b.md"), &big).unwrap();
        assert_eq!(read_text(&dir, "agents/b.md"), Err(FsError::TooLarge));
        fs::write(dir.join("agents").join("c.md"), [0xff, 0xfe, 0xfd]).unwrap();
        assert_eq!(read_text(&dir, "agents/c.md"), Err(FsError::NotUtf8));
    }

    #[test]
    fn odd_relative_paths_are_refused() {
        let dir = TempDir::new("fsx-odd");
        for bad in [
            "", "..", "../x", "a/../b", "a//b", "/a", "a\\b", "c:/x", "./a", "a/\n",
        ] {
            assert_eq!(write_text(&dir, bad, "x"), Err(FsError::Link), "{bad:?}");
        }
    }

    #[test]
    fn a_link_in_any_step_stops_reading_and_writing() {
        let dir = TempDir::new("fsx-link");
        let outside = TempDir::new("fsx-outside");
        fs::write(outside.join("secret.md"), "비밀").unwrap();
        let custom = dir.join("custom");
        fs::create_dir_all(&custom).unwrap();
        assert!(
            make_dir_link(&custom.join("agents"), &outside),
            "이 PC 에서 폴더 링크를 만들 수 없다"
        );
        assert_eq!(write_text(&custom, "agents/a.md", "x"), Err(FsError::Link));
        assert!(!outside.join("a.md").exists());
        assert_eq!(read_text(&custom, "agents/secret.md"), Err(FsError::Link));
        assert_eq!(remove_file(&custom, "agents/secret.md"), Err(FsError::Link));
        assert!(outside.join("secret.md").exists());
        assert_eq!(remove_dir_all(&custom, "agents"), Err(FsError::Link));
        assert!(outside.join("secret.md").exists());
    }

    #[test]
    fn a_linked_custom_folder_itself_is_refused() {
        let dir = TempDir::new("fsx-root-link");
        let real = dir.join("real");
        fs::create_dir_all(&real).unwrap();
        let link = dir.join("custom");
        assert!(make_dir_link(&link, &real));
        assert_eq!(write_text(&link, "agents/a.md", "x"), Err(FsError::Link));
        assert!(!real.join("agents").exists());
    }

    #[test]
    fn removing_a_folder_with_a_link_inside_is_refused_and_leaves_the_target() {
        let dir = TempDir::new("fsx-inner-link");
        let outside = TempDir::new("fsx-inner-outside");
        fs::write(outside.join("keep.txt"), "x").unwrap();
        let skill = dir.join("skills").join("s");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "x").unwrap();
        assert!(make_dir_link(&skill.join("inner"), &outside));
        assert_eq!(remove_dir_all(&dir, "skills/s"), Err(FsError::Link));
        assert!(skill.join("SKILL.md").exists());
        assert!(outside.join("keep.txt").exists());
    }

    #[test]
    fn removing_a_missing_file_is_fine_and_empty_folders_can_be_pruned() {
        let dir = TempDir::new("fsx-remove");
        remove_file(&dir, "agents/none.md").unwrap();
        write_text(&dir, "skills/s/SKILL.append.md", "x").unwrap();
        remove_dir_if_empty(&dir, "skills/s").unwrap();
        assert!(dir.join("skills").join("s").exists(), "안이 비어 있지 않다");
        remove_file(&dir, "skills/s/SKILL.append.md").unwrap();
        remove_dir_if_empty(&dir, "skills/s").unwrap();
        assert!(!dir.join("skills").join("s").exists());
    }

    #[test]
    fn source_reading_handles_missing_and_odd_paths() {
        let dir = TempDir::new("fsx-source");
        let source = dir.join("src");
        fs::create_dir_all(source.join("agents")).unwrap();
        fs::write(source.join("agents").join("a.md"), "안").unwrap();
        fs::write(dir.join("outside.md"), "밖").unwrap();
        assert_eq!(read_source(&source, "agents/a.md").unwrap().unwrap(), "안");
        assert_eq!(read_source(&source, "agents/none.md").unwrap(), None);
        assert!(read_source(&source, "../outside.md").is_err());
    }
}
