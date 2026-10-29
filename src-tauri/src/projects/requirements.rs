//! 프로젝트 폴더의 `requirements.md` 읽기 · 쓰기 · 바깥 변경 확인 (D-42 · D-47).
//!
//! 대상은 **그 폴더 바로 아래 `requirements.md` 하나**뿐이다. 이 파일의 함수는 "폴더 경로" 만 받는다 — 폴더는 등록된 프로젝트의 것이고
//! (화면은 프로젝트 번호만 보낸다), 파일 이름은 여기 고정이다.
//!
//! - 글은 UTF-8 만. 앞의 BOM 은 떼서 주고 쓸 때 되살린다(원래 있던 파일만). 줄바꿈(`CRLF`/`LF`)은 손대지 않는다.
//! - 1MB 를 넘는 파일은 읽지도 쓰지도 않는다 (`too_large`).
//! - 링크 · 정션: 폴더 밖을 가리키면 읽지도 쓰지도 않는다(`outside_folder`). 폴더 안을 가리키는 링크는 읽기만 되고, 쓰기는 거절(`link`) —
//!   이름을 바꿔 덮으면 링크가 끊어지기 때문이다.
//! - `version` = 파일 바이트(BOM 포함)의 `<길이 16진수>-<FNV-1a 64비트>`. 내용이 같으면 같은 값이고, 새 의존성 없이 실행마다 같다.
//!   화면이 읽을 때 받은 값을 쓸 때 `baseVersion` 으로 돌려주면, 그 사이에 파일이 바뀌었는지(터미널에서 고침 등) 알 수 있다.
//! - 쓰기: 지금 파일이 `baseVersion` 과 같을 때만. 같은 폴더의 임시 파일에 쓰고 디스크에 내린 뒤 이름을 바꿔 덮는다 —
//!   어느 단계에서 실패해도 옛 파일은 그대로 남고 임시 파일은 치운다.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::error::AppError;

pub const FILE_NAME: &str = "requirements.md";

/// 읽고 쓰는 최대 크기 (바이트)
pub const MAX_BYTES: u64 = 1024 * 1024;

const BOM: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// 수정 시각이 이만큼 최근이면 "크기 · 시각이 같다" 만으로 안 믿고 내용을 다시 본다 (시각 해상도가 거친 파일 시스템에서 같은 크기로 고친 경우).
const RACY_WINDOW: Duration = Duration::from_secs(2);

/// 읽을 수 없는(쓸 수 없는) 이유 — 화면이 문구를 고르는 열쇠
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Problem {
    /// UTF-8 이 아니다
    NotUtf8,
    /// 1MB 를 넘는다
    TooLarge,
    /// 링크가 폴더 밖을 가리킨다
    OutsideFolder,
    /// 폴더 안을 가리키는 링크라 쓰지 않는다 (읽기는 된다) — 또는 끊어진 링크
    Link,
    /// 프로젝트 폴더가 없다 (옮겼거나 지웠다)
    FolderMissing,
    /// `requirements.md` 가 파일이 아니다 (폴더 등)
    NotAFile,
    /// 그 밖의 읽기 실패 (권한 · 잠김 · 네트워크)
    ReadFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRead {
    /// BOM 을 뗀 글 (줄바꿈 그대로)
    pub text: String,
    pub version: String,
    /// 파일 앞에 BOM 이 있었다 (쓸 때 되살린다)
    pub has_bom: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProblemInfo {
    pub reason: Problem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VersionInfo {
    pub version: String,
}

/// 충돌 — 지금 파일의 `version` (파일이 없어졌으면 `None`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConflictInfo {
    pub version: Option<String>,
}

/// `project_requirements_read` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ReadResult {
    Ok(TextRead),
    Absent,
    Unreadable(ProblemInfo),
}

/// `project_requirements_version` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum VersionResult {
    Ok(VersionInfo),
    Absent,
    Unreadable(ProblemInfo),
}

/// `project_requirements_write` 의 결과 (디스크 · 권한 때문에 못 쓴 것은 결과가 아니라 `file_write_failed` 오류)
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WriteResult {
    /// 썼다 — 새 `version`
    Ok(VersionInfo),
    /// 그 사이 파일이 바뀌었다 (쓰지 않았다)
    Conflict(ConflictInfo),
    /// 쓰지 않는다 (링크 · 폴더 밖 · 너무 큼 · UTF-8 아님 · 폴더 없음 …)
    Refused(ProblemInfo),
}

fn unreadable(reason: Problem) -> ReadResult {
    ReadResult::Unreadable(ProblemInfo { reason })
}

fn refused(reason: Problem) -> WriteResult {
    WriteResult::Refused(ProblemInfo { reason })
}

/// 파일 바이트의 `version` (내용이 같으면 같다)
pub fn version_of(bytes: &[u8]) -> String {
    // FNV-1a 64 — 암호용이 아니다. 우연한 충돌만 막으면 되고, 길이를 같이 넣어 더 줄인다.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:x}-{hash:016x}", bytes.len())
}

/// 찾은 파일
enum Located {
    Absent,
    File {
        /// 실제로 읽을 경로 (링크면 가리키는 곳)
        path: PathBuf,
        /// `requirements.md` 가 링크인가 (폴더 안을 가리키는 것만 여기까지 온다)
        link: bool,
    },
}

/// 폴더 · 파일을 찾는다. 반환하는 폴더는 실제 위치(링크를 푼 것) — 임시 파일도 거기에 둔다.
fn locate(dir: &Path) -> Result<(PathBuf, Located), Problem> {
    let canon_dir = match fs::canonicalize(dir) {
        Ok(path) => path,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Err(Problem::FolderMissing),
        Err(_) => return Err(Problem::ReadFailed),
    };
    if !canon_dir.is_dir() {
        return Err(Problem::FolderMissing);
    }
    let file = canon_dir.join(FILE_NAME);
    let meta = match fs::symlink_metadata(&file) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            return Ok((canon_dir, Located::Absent));
        }
        Err(_) => return Err(Problem::ReadFailed),
    };
    if meta.file_type().is_symlink() {
        // 끊어진 링크는 가리키는 곳이 없다
        let target = fs::canonicalize(&file).map_err(|_| Problem::Link)?;
        if !target.starts_with(&canon_dir) {
            return Err(Problem::OutsideFolder);
        }
        return Ok((
            canon_dir,
            Located::File {
                path: target,
                link: true,
            },
        ));
    }
    if !meta.is_file() {
        return Err(Problem::NotAFile);
    }
    Ok((
        canon_dir,
        Located::File {
            path: file,
            link: false,
        },
    ))
}

/// 크기를 막아 읽는다 (파일이 읽는 사이 커져도 1MB 까지만 읽는다)
fn read_bytes(path: &Path) -> Result<Vec<u8>, Problem> {
    let meta = fs::metadata(path).map_err(|_| Problem::ReadFailed)?;
    if !meta.is_file() {
        return Err(Problem::NotAFile);
    }
    if meta.len() > MAX_BYTES {
        return Err(Problem::TooLarge);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| Problem::ReadFailed)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Problem::TooLarge);
    }
    Ok(bytes)
}

/// BOM 을 떼고 UTF-8 로 읽는다. 돌려주는 것: (글, BOM 이 있었나)
fn decode(bytes: &[u8]) -> Result<(&str, bool), Problem> {
    let (body, has_bom) = match bytes.strip_prefix(&BOM) {
        Some(rest) => (rest, true),
        None => (bytes, false),
    };
    std::str::from_utf8(body)
        .map(|text| (text, has_bom))
        .map_err(|_| Problem::NotUtf8)
}

pub fn read(dir: &Path) -> ReadResult {
    let path = match locate(dir) {
        Err(reason) => return unreadable(reason),
        Ok((_, Located::Absent)) => return ReadResult::Absent,
        Ok((_, Located::File { path, .. })) => path,
    };
    let bytes = match read_bytes(&path) {
        Ok(bytes) => bytes,
        Err(reason) => return unreadable(reason),
    };
    match decode(&bytes) {
        Ok((text, has_bom)) => ReadResult::Ok(TextRead {
            text: text.to_string(),
            version: version_of(&bytes),
            has_bom,
        }),
        Err(reason) => unreadable(reason),
    }
}

/// 마지막으로 본 파일 — 크기 · 수정 시각이 같으면 내용을 다시 읽지 않는다.
#[derive(Debug, Clone)]
pub struct VersionCache {
    len: u64,
    modified: SystemTime,
    version: String,
    /// 내용을 읽기 시작한 때
    checked_at: SystemTime,
}

/// 지금 파일의 `version`. 싸게: 크기 · 수정 시각이 지난번과 같고(그리고 그 시각이 충분히 옛날이면) 읽지 않고 기억한 값을 돌려준다.
pub fn version(dir: &Path, cache: &mut Option<VersionCache>, now: SystemTime) -> VersionResult {
    let path = match locate(dir) {
        Err(reason) => {
            *cache = None;
            return VersionResult::Unreadable(ProblemInfo { reason });
        }
        Ok((_, Located::Absent)) => {
            *cache = None;
            return VersionResult::Absent;
        }
        Ok((_, Located::File { path, .. })) => path,
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) if meta.is_file() => meta,
        Ok(_) => {
            *cache = None;
            return VersionResult::Unreadable(ProblemInfo {
                reason: Problem::NotAFile,
            });
        }
        Err(_) => {
            *cache = None;
            return VersionResult::Unreadable(ProblemInfo {
                reason: Problem::ReadFailed,
            });
        }
    };
    let modified = meta.modified().ok();
    if let (Some(cached), Some(modified)) = (cache.as_ref(), modified)
        && cached.len == meta.len()
        && cached.modified == modified
        && modified
            .checked_add(RACY_WINDOW)
            .is_some_and(|settled| settled <= cached.checked_at)
    {
        return VersionResult::Ok(VersionInfo {
            version: cached.version.clone(),
        });
    }
    match read_bytes(&path) {
        Ok(bytes) => {
            let version = version_of(&bytes);
            *cache = modified.map(|modified| VersionCache {
                len: bytes.len() as u64,
                modified,
                version: version.clone(),
                checked_at: now,
            });
            VersionResult::Ok(VersionInfo { version })
        }
        Err(reason) => {
            *cache = None;
            VersionResult::Unreadable(ProblemInfo { reason })
        }
    }
}

pub fn write(dir: &Path, text: &str, base_version: Option<&str>) -> Result<WriteResult, AppError> {
    write_with(dir, text, base_version, |from, to| fs::rename(from, to))
}

/// `write` 의 본체. 마지막 이름 바꾸기를 바꿔 끼울 수 있게 나눴다 (그 단계가 실패하는 경우를 시험하려고).
fn write_with(
    dir: &Path,
    text: &str,
    base_version: Option<&str>,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> Result<WriteResult, AppError> {
    let (canon_dir, located) = match locate(dir) {
        Ok(found) => found,
        Err(reason) => return Ok(refused(reason)),
    };
    let (has_bom, target, modes_from) = match located {
        Located::Absent => {
            if base_version.is_some() {
                // 화면은 파일이 있다고 알았는데 없어졌다
                return Ok(WriteResult::Conflict(ConflictInfo { version: None }));
            }
            (false, canon_dir.join(FILE_NAME), None)
        }
        Located::File { link: true, .. } => return Ok(refused(Problem::Link)),
        Located::File { path, link: false } => {
            let current = match read_bytes(&path) {
                Ok(bytes) => bytes,
                Err(reason) => return Ok(refused(reason)),
            };
            let current_version = version_of(&current);
            if base_version != Some(current_version.as_str()) {
                return Ok(WriteResult::Conflict(ConflictInfo {
                    version: Some(current_version),
                }));
            }
            // 쓰는 순간 이 파일은 UTF-8 로 바뀐다 — UTF-8 이 아닌 파일은 덮지 않는다 (글자가 깨지는 것을 막는다)
            let (_, has_bom) = match decode(&current) {
                Ok(decoded) => decoded,
                Err(reason) => return Ok(refused(reason)),
            };
            (has_bom, path.clone(), Some(path))
        }
    };

    let mut bytes = Vec::with_capacity(text.len() + BOM.len());
    if has_bom {
        bytes.extend_from_slice(&BOM);
    }
    bytes.extend_from_slice(text.as_bytes());
    if bytes.len() as u64 > MAX_BYTES {
        return Ok(refused(Problem::TooLarge));
    }

    write_atomically(&canon_dir, &target, &bytes, modes_from.as_deref(), rename)
        .map_err(|err| AppError::FileWriteFailed(err.to_string()))?;
    Ok(WriteResult::Ok(VersionInfo {
        version: version_of(&bytes),
    }))
}

static TMP_COUNTER: AtomicU32 = AtomicU32::new(0);

/// 같은 폴더의 임시 파일에 쓰고 → 디스크에 내리고 → 이름을 바꿔 덮는다. 실패하면 임시 파일을 지우고 옛 파일은 그대로 둔다.
fn write_atomically(
    dir: &Path,
    target: &Path,
    bytes: &[u8],
    keep_mode_of: Option<&Path>,
    rename: impl FnOnce(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let tmp = dir.join(format!(
        ".{FILE_NAME}.nyanitor-{}-{}.tmp",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        // `create_new` — 이미 있는 것(링크 포함)을 따라가 덮어쓰지 않는다
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        // 새 파일이 옛 파일의 권한을 잃지 않게 (Unix). Windows 는 읽기 전용 표시를 옮기면 임시 파일을 못 지워서 옮기지 않는다
        // (읽기 전용 파일은 이름 바꾸기에서 거절되어 오류로 올라온다).
        #[cfg(unix)]
        if let Some(old) = keep_mode_of {
            fs::set_permissions(&tmp, fs::metadata(old)?.permissions())?;
        }
        #[cfg(not(unix))]
        let _ = keep_mode_of;
        rename(&tmp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::test_util::TempDir;

    fn put(dir: &Path, bytes: &[u8]) {
        fs::write(dir.join(FILE_NAME), bytes).unwrap();
    }

    fn on_disk(dir: &Path) -> Vec<u8> {
        fs::read(dir.join(FILE_NAME)).unwrap()
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn read_ok(dir: &Path) -> TextRead {
        match read(dir) {
            ReadResult::Ok(read) => read,
            other => panic!("expected ok, got {other:?}"),
        }
    }

    fn written_version(result: Result<WriteResult, AppError>) -> String {
        match result.unwrap() {
            WriteResult::Ok(info) => info.version,
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn version_is_the_same_for_the_same_bytes_and_differs_otherwise() {
        assert_eq!(version_of(b"abc"), version_of(b"abc"));
        assert_ne!(version_of(b"abc"), version_of(b"abd"));
        assert_ne!(version_of(b""), version_of(b"\0"));
        // 값이 실행 · 버전마다 바뀌지 않는다 (고정 값)
        assert_eq!(version_of(b""), "0-cbf29ce484222325");
        assert_eq!(version_of(b"a"), "1-af63dc4c8601ec8c");
    }

    #[test]
    fn reads_text_with_its_version() {
        let dir = TempDir::new("req-read");
        put(&dir, "# 제목\n\n본문".as_bytes());
        let read = read_ok(&dir);
        assert_eq!(read.text, "# 제목\n\n본문");
        assert!(!read.has_bom);
        assert_eq!(read.version, version_of("# 제목\n\n본문".as_bytes()));
    }

    #[test]
    fn a_missing_file_is_absent() {
        let dir = TempDir::new("req-absent");
        assert_eq!(read(&dir), ReadResult::Absent);
        let mut cache = None;
        assert_eq!(
            version(&dir, &mut cache, SystemTime::now()),
            VersionResult::Absent
        );
    }

    #[test]
    fn a_missing_folder_is_unreadable() {
        let dir = TempDir::new("req-nofolder");
        let gone = dir.join("not-here");
        assert_eq!(read(&gone), unreadable(Problem::FolderMissing));
        let mut cache = None;
        assert_eq!(
            version(&gone, &mut cache, SystemTime::now()),
            VersionResult::Unreadable(ProblemInfo {
                reason: Problem::FolderMissing
            })
        );
        assert_eq!(
            write(&gone, "x", None).unwrap(),
            refused(Problem::FolderMissing)
        );
        assert!(!gone.exists(), "no folder is created");
    }

    #[test]
    fn a_bom_is_removed_on_read_and_restored_on_write() {
        let dir = TempDir::new("req-bom");
        let mut bytes = BOM.to_vec();
        bytes.extend_from_slice("첫 줄\n".as_bytes());
        put(&dir, &bytes);
        let read = read_ok(&dir);
        assert_eq!(read.text, "첫 줄\n");
        assert!(read.has_bom);
        assert_eq!(read.version, version_of(&bytes));

        let version = written_version(write(&dir, "바뀐 글\n", Some(&read.version)));
        let mut expected = BOM.to_vec();
        expected.extend_from_slice("바뀐 글\n".as_bytes());
        assert_eq!(on_disk(&dir), expected);
        assert_eq!(version, version_of(&expected));
        // 다시 읽으면 BOM 은 여전히 떼어서 준다
        assert_eq!(read_ok(&dir).text, "바뀐 글\n");
    }

    #[test]
    fn a_new_file_has_no_bom() {
        let dir = TempDir::new("req-new");
        let version = written_version(write(&dir, "처음\n", None));
        assert_eq!(on_disk(&dir), "처음\n".as_bytes());
        assert_eq!(version, version_of("처음\n".as_bytes()));
        assert_eq!(names(&dir), [FILE_NAME]);
    }

    #[test]
    fn line_endings_are_left_as_they_are() {
        let dir = TempDir::new("req-crlf");
        put(&dir, b"one\r\ntwo\r\nthree\n");
        let read = read_ok(&dir);
        assert_eq!(read.text, "one\r\ntwo\r\nthree\n");
        written_version(write(&dir, "a\r\nb\nc\r\n", Some(&read.version)));
        assert_eq!(on_disk(&dir), b"a\r\nb\nc\r\n");
    }

    #[test]
    fn a_file_that_is_not_utf8_is_unreadable_and_is_not_overwritten() {
        let dir = TempDir::new("req-latin1");
        // EUC-KR 로 "한글" — UTF-8 이 아니다
        let bytes = [0xC7, 0xD1, 0xB1, 0xDB];
        put(&dir, &bytes);
        assert_eq!(read(&dir), unreadable(Problem::NotUtf8));
        // 화면이 `version` 명령으로 받은 값을 들고 와도 덮지 않는다
        let mut cache = None;
        let VersionResult::Ok(info) = version(&dir, &mut cache, SystemTime::now()) else {
            panic!("version of a non-utf8 file is still reported");
        };
        assert_eq!(
            write(&dir, "새 글", Some(&info.version)).unwrap(),
            refused(Problem::NotUtf8)
        );
        assert_eq!(on_disk(&dir), bytes);
    }

    #[test]
    fn a_file_over_the_limit_is_unreadable_and_not_written() {
        let dir = TempDir::new("req-big");
        put(&dir, &vec![b'a'; MAX_BYTES as usize + 1]);
        assert_eq!(read(&dir), unreadable(Problem::TooLarge));
        let mut cache = None;
        assert_eq!(
            version(&dir, &mut cache, SystemTime::now()),
            VersionResult::Unreadable(ProblemInfo {
                reason: Problem::TooLarge
            })
        );
        assert_eq!(
            write(&dir, "x", Some("any")).unwrap(),
            refused(Problem::TooLarge)
        );
        assert_eq!(on_disk(&dir).len() as u64, MAX_BYTES + 1);
        // 정확히 한계인 파일은 된다
        put(&dir, &vec![b'a'; MAX_BYTES as usize]);
        assert_eq!(read_ok(&dir).text.len() as u64, MAX_BYTES);
    }

    #[test]
    fn writing_too_much_text_is_refused_and_leaves_the_file() {
        let dir = TempDir::new("req-bigwrite");
        put(&dir, b"small");
        let read = read_ok(&dir);
        let big = "a".repeat(MAX_BYTES as usize + 1);
        assert_eq!(
            write(&dir, &big, Some(&read.version)).unwrap(),
            refused(Problem::TooLarge)
        );
        assert_eq!(on_disk(&dir), b"small");
        // 글은 한계 안이어도 BOM 을 되살리면 넘는 경우도 거절
        let mut with_bom = BOM.to_vec();
        with_bom.extend_from_slice(b"small");
        put(&dir, &with_bom);
        let read = read_ok(&dir);
        let edge = "a".repeat(MAX_BYTES as usize - 2);
        assert_eq!(
            write(&dir, &edge, Some(&read.version)).unwrap(),
            refused(Problem::TooLarge)
        );
        assert_eq!(on_disk(&dir), with_bom);
        // 한계 안이면 된다
        written_version(write(
            &dir,
            &"a".repeat(MAX_BYTES as usize - 3),
            Some(&read.version),
        ));
    }

    #[test]
    fn a_changed_file_is_a_conflict_and_is_not_written() {
        let dir = TempDir::new("req-conflict");
        put(&dir, b"mine");
        let read = read_ok(&dir);
        // 화면이 모르는 사이 터미널에서 바뀜
        put(&dir, b"theirs");
        let result = write(&dir, "my edit", Some(&read.version)).unwrap();
        assert_eq!(
            result,
            WriteResult::Conflict(ConflictInfo {
                version: Some(version_of(b"theirs"))
            })
        );
        assert_eq!(on_disk(&dir), b"theirs");
        // 충돌에서 받은 값으로 다시 쓰면(사용자가 "내 것으로 덮기" 를 고름) 된다
        written_version(write(&dir, "my edit", Some(&version_of(b"theirs"))));
        assert_eq!(on_disk(&dir), b"my edit");
    }

    #[test]
    fn a_file_created_while_the_screen_thought_it_absent_is_a_conflict() {
        let dir = TempDir::new("req-appeared");
        put(&dir, b"someone made this");
        assert_eq!(
            write(&dir, "mine", None).unwrap(),
            WriteResult::Conflict(ConflictInfo {
                version: Some(version_of(b"someone made this"))
            })
        );
        assert_eq!(on_disk(&dir), b"someone made this");
    }

    #[test]
    fn a_file_deleted_while_the_screen_had_it_is_a_conflict_with_no_version() {
        let dir = TempDir::new("req-deleted");
        assert_eq!(
            write(&dir, "mine", Some("1-0000000000000000")).unwrap(),
            WriteResult::Conflict(ConflictInfo { version: None })
        );
        assert!(!dir.join(FILE_NAME).exists());
    }

    #[test]
    fn writing_the_same_text_keeps_the_same_version() {
        let dir = TempDir::new("req-same");
        let first = written_version(write(&dir, "same", None));
        let second = written_version(write(&dir, "same", Some(&first)));
        assert_eq!(first, second);
        assert_eq!(read_ok(&dir).version, first);
    }

    #[test]
    fn a_failing_rename_keeps_the_old_file_and_leaves_no_temp_file() {
        let dir = TempDir::new("req-fail");
        put(&dir, b"old content");
        let read = read_ok(&dir);
        let err = write_with(&dir, "new content", Some(&read.version), |_, _| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "boom"))
        })
        .unwrap_err();
        assert_eq!(err.kind(), "file_write_failed");
        assert_eq!(on_disk(&dir), b"old content");
        assert_eq!(names(&dir), [FILE_NAME], "temp file was cleaned up");
        // 새 파일을 만들다 실패해도 파일이 생기지 않는다
        let empty = TempDir::new("req-fail-new");
        write_with(&empty, "x", None, |_, _| Err(io::Error::other("boom"))).unwrap_err();
        assert!(names(&empty).is_empty());
    }

    #[test]
    fn a_temp_file_that_cannot_be_created_is_an_error_and_changes_nothing() {
        let dir = TempDir::new("req-tmpfail");
        put(&dir, b"old");
        let read = read_ok(&dir);
        // 임시 파일을 만들 수 없는 폴더(없는 폴더)를 주고 `write_atomically` 를 직접 부른다.
        let missing = dir.join("no-such-folder");
        let err = write_atomically(&missing, &dir.join(FILE_NAME), b"new", None, |from, to| {
            fs::rename(from, to)
        })
        .unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
        assert_eq!(on_disk(&dir), b"old");
        assert_eq!(read_ok(&dir).version, read.version);
    }

    #[test]
    fn requirements_md_as_a_folder_is_not_a_file() {
        let dir = TempDir::new("req-isdir");
        fs::create_dir(dir.join(FILE_NAME)).unwrap();
        assert_eq!(read(&dir), unreadable(Problem::NotAFile));
        assert_eq!(write(&dir, "x", None).unwrap(), refused(Problem::NotAFile));
        assert!(dir.join(FILE_NAME).is_dir());
    }

    #[test]
    fn the_version_command_follows_changes_and_skips_rereading_when_nothing_changed() {
        let dir = TempDir::new("req-version");
        put(&dir, b"one");
        let mut cache = None;
        // 시각이 옛날(지금보다 한참 뒤에 확인한 것처럼)이어야 기억을 믿는다
        let later = SystemTime::now() + Duration::from_secs(60);
        let first = version(&dir, &mut cache, later);
        assert_eq!(
            first,
            VersionResult::Ok(VersionInfo {
                version: version_of(b"one")
            })
        );
        assert!(cache.is_some());

        // 기억한 값을 믿는지 확인 — 기억을 일부러 틀린 값으로 바꿔 두면 그 값이 돌아온다 (내용을 다시 읽지 않았다는 뜻)
        if let Some(entry) = cache.as_mut() {
            entry.version = "planted".to_string();
        }
        assert_eq!(
            version(&dir, &mut cache, later),
            VersionResult::Ok(VersionInfo {
                version: "planted".to_string()
            })
        );

        // 크기가 바뀌면 다시 읽는다
        put(&dir, b"three");
        assert_eq!(
            version(&dir, &mut cache, later),
            VersionResult::Ok(VersionInfo {
                version: version_of(b"three")
            })
        );

        // 같은 크기로 고쳐도(시각이 바뀌면) 다시 읽는다
        std::thread::sleep(Duration::from_millis(30));
        put(&dir, b"THREE");
        assert_eq!(
            version(&dir, &mut cache, later),
            VersionResult::Ok(VersionInfo {
                version: version_of(b"THREE")
            })
        );

        // 지워지면 없음, 기억도 버린다
        fs::remove_file(dir.join(FILE_NAME)).unwrap();
        assert_eq!(version(&dir, &mut cache, later), VersionResult::Absent);
        assert!(cache.is_none());
    }

    #[test]
    fn a_file_changed_just_before_the_last_check_is_read_again() {
        // 수정 시각이 확인한 때와 너무 가까우면(해상도가 거친 파일 시스템에서 같은 크기로 고친 경우) 기억을 믿지 않는다
        let dir = TempDir::new("req-racy");
        put(&dir, b"one");
        let mut cache = None;
        let now = SystemTime::now();
        version(&dir, &mut cache, now);
        if let Some(entry) = cache.as_mut() {
            entry.version = "planted".to_string();
        }
        assert_eq!(
            version(&dir, &mut cache, now),
            VersionResult::Ok(VersionInfo {
                version: version_of(b"one")
            }),
            "read again instead of trusting the remembered value"
        );
    }

    #[test]
    fn the_version_matches_what_read_and_write_report() {
        let dir = TempDir::new("req-consistent");
        let written = written_version(write(&dir, "글\r\n", None));
        let mut cache = None;
        let VersionResult::Ok(info) = version(&dir, &mut cache, SystemTime::now()) else {
            panic!("ok");
        };
        assert_eq!(info.version, written);
        assert_eq!(read_ok(&dir).version, written);
    }

    /// 링크를 만든다 (권한이 없는 PC 면 `false` — 그 시험은 건너뛴다)
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            // 정션은 관리자 권한이 필요 없다
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .is_ok_and(|out| out.status.success())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    fn make_file_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn a_file_link_pointing_outside_the_folder_is_refused_both_ways() {
        let outside = TempDir::new("req-outside-target");
        let secret = outside.join("secret.txt");
        fs::write(&secret, "top secret").unwrap();
        let dir = TempDir::new("req-outside");
        if !make_file_link(&secret, &dir.join(FILE_NAME)) {
            eprintln!("skipped: cannot create file symlinks here (needs privilege)");
            return;
        }
        assert_eq!(read(&dir), unreadable(Problem::OutsideFolder));
        let mut cache = None;
        assert_eq!(
            version(&dir, &mut cache, SystemTime::now()),
            VersionResult::Unreadable(ProblemInfo {
                reason: Problem::OutsideFolder
            })
        );
        assert_eq!(
            write(&dir, "overwrite", Some("any")).unwrap(),
            refused(Problem::OutsideFolder)
        );
        assert_eq!(fs::read_to_string(&secret).unwrap(), "top secret");
    }

    #[test]
    fn a_file_link_inside_the_folder_reads_but_is_not_written() {
        let dir = TempDir::new("req-inside");
        fs::write(dir.join("real.md"), "real").unwrap();
        if !make_file_link(&dir.join("real.md"), &dir.join(FILE_NAME)) {
            eprintln!("skipped: cannot create file symlinks here (needs privilege)");
            return;
        }
        let read = read_ok(&dir);
        assert_eq!(read.text, "real");
        assert_eq!(
            write(&dir, "new", Some(&read.version)).unwrap(),
            refused(Problem::Link)
        );
        assert_eq!(fs::read_to_string(dir.join("real.md")).unwrap(), "real");
    }

    #[test]
    fn a_broken_link_is_not_followed() {
        let dir = TempDir::new("req-broken");
        if !make_file_link(&dir.join("nothing-here.md"), &dir.join(FILE_NAME)) {
            eprintln!("skipped: cannot create file symlinks here (needs privilege)");
            return;
        }
        assert_eq!(read(&dir), unreadable(Problem::Link));
        assert_eq!(write(&dir, "x", None).unwrap(), refused(Problem::Link));
        assert!(!dir.join("nothing-here.md").exists());
    }

    #[test]
    fn a_project_folder_that_is_a_junction_works_and_stays_where_it_points() {
        // 사용자가 정션 경로를 프로젝트로 골랐다 — 실제 폴더의 requirements.md 를 읽고 쓴다
        let real = TempDir::new("req-junction-real");
        let holder = TempDir::new("req-junction-holder");
        let link = holder.join("proj");
        if !make_dir_link(&real, &link) {
            eprintln!("skipped: cannot create directory links here");
            return;
        }
        let version = written_version(write(&link, "via link", None));
        assert_eq!(on_disk(&real), b"via link");
        assert_eq!(read_ok(&link).version, version);
    }

    #[test]
    fn a_directory_link_in_place_of_the_file_that_points_inside_is_not_written_and_not_read() {
        // 파일 링크를 못 만드는 PC(권한)에서도 링크 판단을 확인한다 — 정션 · 폴더 심볼릭 링크는 폴더를 가리킨다
        let dir = TempDir::new("req-dirlink-inside");
        fs::create_dir(dir.join("sub")).unwrap();
        if !make_dir_link(&dir.join("sub"), &dir.join(FILE_NAME)) {
            eprintln!("skipped: cannot create directory links here");
            return;
        }
        assert_eq!(read(&dir), unreadable(Problem::NotAFile));
        assert_eq!(
            write(&dir, "x", Some("any")).unwrap(),
            refused(Problem::Link)
        );
        assert!(names(&dir.join("sub")).is_empty());
    }

    #[test]
    fn a_dangling_directory_link_is_not_followed() {
        let dir = TempDir::new("req-dirlink-dangling");
        let target = dir.join("will-vanish");
        fs::create_dir(&target).unwrap();
        if !make_dir_link(&target, &dir.join(FILE_NAME)) {
            eprintln!("skipped: cannot create directory links here");
            return;
        }
        fs::remove_dir(&target).unwrap();
        assert_eq!(read(&dir), unreadable(Problem::Link));
        assert_eq!(write(&dir, "x", None).unwrap(), refused(Problem::Link));
        assert!(!target.exists());
    }

    #[test]
    fn a_junction_in_place_of_the_file_name_that_points_out_is_refused() {
        // 폴더 링크(정션)가 `requirements.md` 자리에 있으면 파일이 아니라 폴더를 가리킨다 — 밖이면 거절
        let outside = TempDir::new("req-junction-out");
        let dir = TempDir::new("req-junction-file");
        if !make_dir_link(&outside, &dir.join(FILE_NAME)) {
            eprintln!("skipped: cannot create directory links here");
            return;
        }
        assert_eq!(read(&dir), unreadable(Problem::OutsideFolder));
        assert_eq!(
            write(&dir, "x", Some("any")).unwrap(),
            refused(Problem::OutsideFolder)
        );
        assert!(names(&outside).is_empty());
    }
}
