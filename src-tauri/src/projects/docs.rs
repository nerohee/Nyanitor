//! 프로젝트 `docsDir` 아래 마크다운 문서 **읽기 전용** 목록 · 읽기 (P7-01, D-49).
//!
//! - 읽는 것은 그 프로젝트의 `<docsDir>/` 안 `.md` 뿐이다. 쓰기 · 만들기 · 지우기 함수는 없다.
//! - 화면은 프로젝트 번호와 `docsDir` 안 상대 경로(`/` 구분)만 보낸다. **경로는 여기서 다시 확인한다** (`parse_path`): 빈 값 · 절대 경로 · 드라이브 글자 ·
//!   `..` · `\` · 숨은 이름(`.` 으로 시작) · 윈도 예약 이름 · `.md` 아님 · 너무 깊음 → `invalid_input`. 통과해도 **실제 경로**(링크를 푼 것)가
//!   `docsDir` 의 실제 경로 안이어야 읽는다 (`outside_folder`).
//! - `docsDir` 자체도 프로젝트 폴더 안을 가리켜야 한다 (밖으로 가는 링크 · 정션이면 `outside_folder`).
//! - 목록: 숨은 이름 · `.md` 아닌 파일 · 폴더 밖을 가리키는 링크는 건너뛴다. **폴더 링크 · 정션은 안쪽을 가리켜도 따라가지 않는다** (되돌아가는 링크로 같은 글이 겹치거나 끝없이
//!   도는 일을 막는다). 파일 링크는 폴더 안을 가리킬 때만 보인다. 깊이 · 개수 · 살펴본 수에 상한이 있고 넘으면 `truncated`.
//! - 파일 읽기 규칙(UTF-8 만 · BOM 떼기 · 1MB 제한 · `version` = 길이 + FNV-1a)은 `requirements` 와 같은 함수를 쓴다.
//!
//! 하네스 문서(단계 표 · 이어 하기 메모 · 지시서)를 읽는 `progress` 도 같은 `locate` · `read_text` 를 쓴다.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

use super::requirements::{self, Problem, ProblemInfo};
use super::{Env, requirements_dir};
use crate::db::AppDb;
use crate::error::AppError;

/// 목록의 한도 (넘으면 `truncated`)
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// 폴더를 내려가는 단 수 (`docsDir` 바로 아래가 0단, 그 안의 폴더는 1단 …)
    pub max_depth: usize,
    /// 목록에 담는 파일 수
    pub max_files: usize,
    /// 살펴보는 항목 수 (`.md` 가 아닌 것 포함 — 파일이 아주 많은 폴더가 있어도 느려지지 않게)
    pub max_visited: usize,
}

impl Limits {
    pub const DEFAULT: Limits = Limits {
        max_depth: 8,
        max_files: 2000,
        max_visited: 20_000,
    };
}

/// 경로 글자의 최대 길이 (바이트)
const PATH_MAX_BYTES: usize = 1024;

/// 이름 하나의 최대 길이 (바이트)
const NAME_MAX_BYTES: usize = 255;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFile {
    /// `docsDir` 안 상대 경로 (`/` 구분)
    pub path: String,
    pub size: u64,
    /// 수정 시각 (유닉스 초). 모르면 `null`
    pub modified: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsListing {
    /// 하네스 설정의 `docsDir` (기본 `docs`)
    pub docs_dir: String,
    /// 경로 순 (대소문자 가리지 않음)
    pub files: Vec<DocFile>,
    /// 목록이 다 담기지 않았다 (개수 · 깊이 · 살펴본 수 상한, 읽을 수 없던 폴더)
    pub truncated: bool,
}

/// `project_docs_list` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ListResult {
    Ok(DocsListing),
    /// `docsDir` 폴더가 없다 (아직 하네스 전)
    Absent,
    Unreadable(ProblemInfo),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DocText {
    /// BOM 을 뗀 글 (줄바꿈 그대로)
    pub text: String,
    pub version: String,
}

/// `project_doc_read` 의 결과
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DocReadResult {
    Ok(DocText),
    Absent,
    Unreadable(ProblemInfo),
}

fn problem(reason: Problem) -> ProblemInfo {
    ProblemInfo { reason }
}

fn not_found(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

// ───────────────────────── 이름 · 경로 ─────────────────────────

/// 윈도가 장치로 다루는 이름인가 (`CON.md` 도 장치다) — 모든 OS 에서 거른다 (저장소를 윈도로 옮길 수 있다).
/// 문서 경로 칸(`valid_component`)과 에이전트 · 스킬 · 고양이 이름(`custom::id`)이 같이 쓴다.
pub fn is_reserved_device(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(bytes[3], b'1'..=b'9')
}

/// 경로의 한 칸(폴더 · 파일 이름)으로 받는 이름인가. 목록은 이 이름만 담고 읽기는 이 이름만 받는다 — 둘이 어긋나지 않게 한 곳에 둔다.
/// 숨은 이름(`.` 으로 시작 — `..` 포함) · 끝의 점 · 공백 · 구분자 · 드라이브 `:` · 윈도에서 못 쓰는 글자 · 제어 문자 · 예약 이름은 아니다.
pub fn valid_component(name: &str) -> bool {
    if name.is_empty()
        || name.len() > NAME_MAX_BYTES
        || name.starts_with('.')
        || name.ends_with('.')
        || name.ends_with(' ')
    {
        return false;
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
    }) {
        return false;
    }
    !is_reserved_device(name)
}

/// 이름이 `.md` 로 끝나는가 (대소문자 가리지 않음, 확장자만 있는 이름은 아니다)
pub fn is_markdown_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() > 3 && bytes[bytes.len() - 3..].eq_ignore_ascii_case(b".md")
}

fn invalid_path(why: &str) -> AppError {
    AppError::InvalidInput(format!("doc path {why}"))
}

/// 화면이 보낸 문서 경로를 확인해 칸으로 나눈다. 목록이 내놓는 모양(`a/b/c.md`)만 받는다.
pub fn parse_path(path: &str) -> Result<Vec<&str>, AppError> {
    if path.trim().is_empty() {
        return Err(invalid_path("is empty"));
    }
    if path.len() > PATH_MAX_BYTES {
        return Err(invalid_path("is too long"));
    }
    let parts: Vec<&str> = path.split('/').collect();
    // 목록이 담는 가장 깊은 파일: 폴더 `max_depth` 단 + 파일 이름
    if parts.len() > Limits::DEFAULT.max_depth + 1 {
        return Err(invalid_path("is too deep"));
    }
    // 빈 칸(맨 앞 `/` · `//` · 끝 `/`) · `.` · `..` · `\` · `C:` 모두 여기서 걸린다
    if !parts.iter().all(|part| valid_component(part)) {
        return Err(invalid_path("has a part that is not allowed"));
    }
    if !parts.last().is_some_and(|name| is_markdown_name(name)) {
        return Err(invalid_path("is not a .md file"));
    }
    Ok(parts)
}

// ───────────────────────── docs 폴더 · 파일 찾기 ─────────────────────────

/// 프로젝트의 `docsDir` 의 **실제 경로**를 찾는다. 폴더가 없으면 `Ok(None)`. 프로젝트 폴더가 없으면 `FolderMissing`,
/// `docsDir` 가 프로젝트 폴더 밖을 가리키면 `OutsideFolder`, 폴더가 아니면 `NotAFile`.
pub fn locate(project_dir: &Path, docs_dir: &str) -> Result<Option<PathBuf>, Problem> {
    let canon_project = match fs::canonicalize(project_dir) {
        Ok(path) => path,
        Err(err) if not_found(&err) => return Err(Problem::FolderMissing),
        Err(_) => return Err(Problem::ReadFailed),
    };
    if !canon_project.is_dir() {
        return Err(Problem::FolderMissing);
    }
    // 하네스 설정에서 읽은 값은 이미 확인했지만(`folder::docs_dir_in`) 받는 쪽에서 한 번 더 — 상대 경로의 보통 이름뿐이어야 한다
    let relative = Path::new(docs_dir);
    if docs_dir.is_empty()
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(Problem::OutsideFolder);
    }
    let canon_docs = match fs::canonicalize(canon_project.join(relative)) {
        Ok(path) => path,
        Err(err) if not_found(&err) => return Ok(None),
        Err(_) => return Err(Problem::ReadFailed),
    };
    if !canon_docs.starts_with(&canon_project) {
        return Err(Problem::OutsideFolder);
    }
    if !canon_docs.is_dir() {
        return Err(Problem::NotAFile);
    }
    Ok(Some(canon_docs))
}

/// 읽은 글
pub struct Text {
    /// BOM 을 뗀 글
    pub text: String,
    pub version: String,
}

/// `docsDir`(실제 경로) 아래 `parts` 칸을 이어 만든 파일 하나를 읽는다. 없으면 `Ok(None)`.
/// 링크를 풀어 **실제 경로가 `docsDir` 안**일 때만 읽는다 (`OutsideFolder`). 끊어진 링크는 `Link`. 읽기 규칙은 `requirements` 와 같다.
pub fn read_text(canon_docs: &Path, parts: &[&str]) -> Result<Option<Text>, Problem> {
    let mut path = canon_docs.to_path_buf();
    path.extend(parts);
    let canon = match fs::canonicalize(&path) {
        Ok(path) => path,
        Err(err) if not_found(&err) => {
            // 항목은 있는데 가리키는 곳이 없다 = 끊어진 링크
            return if fs::symlink_metadata(&path).is_ok() {
                Err(Problem::Link)
            } else {
                Ok(None)
            };
        }
        Err(_) => return Err(Problem::ReadFailed),
    };
    if !canon.starts_with(canon_docs) {
        return Err(Problem::OutsideFolder);
    }
    let bytes = requirements::read_bytes(&canon)?;
    let (text, _) = requirements::decode(&bytes)?;
    Ok(Some(Text {
        text: text.to_string(),
        version: requirements::version_of(&bytes),
    }))
}

// ───────────────────────── 목록 ─────────────────────────

struct Scan {
    files: Vec<DocFile>,
    visited: usize,
    truncated: bool,
}

fn modified_secs(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|age| i64::try_from(age.as_secs()).ok())
}

fn walk(root: &Path, dir: &Path, prefix: &str, depth: usize, limits: &Limits, scan: &mut Scan) {
    let read = match fs::read_dir(dir) {
        Ok(read) => read,
        Err(_) => {
            // 읽을 수 없는 폴더 — 목록이 다 담기지 않았다고 알린다
            scan.truncated = true;
            return;
        }
    };
    let mut entries = Vec::new();
    for entry in read {
        scan.visited += 1;
        if scan.visited > limits.max_visited {
            scan.truncated = true;
            break;
        }
        match entry {
            Ok(entry) => entries.push(entry),
            Err(_) => scan.truncated = true,
        }
    }
    // 어느 항목까지 담을지가 PC 마다 같게 이름 순으로
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if scan.truncated && scan.visited > limits.max_visited {
            return;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue; // UTF-8 이 아닌 이름은 화면으로 보낼 수 없다
        };
        if !valid_component(&name) {
            continue; // 숨은 이름 · 읽기가 거절할 이름
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_symlink() {
            // 폴더 링크 · 정션은 따라가지 않는다. 파일 링크는 폴더 안을 가리킬 때만
            let Ok(target) = fs::canonicalize(&path) else {
                continue;
            };
            if !target.starts_with(root) || !is_markdown_name(&name) {
                continue;
            }
            if let Ok(meta) = fs::metadata(&target)
                && meta.is_file()
            {
                push(scan, limits, format!("{prefix}{name}"), &meta);
            }
        } else if kind.is_dir() {
            if depth >= limits.max_depth {
                scan.truncated = true;
                continue;
            }
            walk(
                root,
                &path,
                &format!("{prefix}{name}/"),
                depth + 1,
                limits,
                scan,
            );
        } else if kind.is_file()
            && is_markdown_name(&name)
            && let Ok(meta) = entry.metadata()
        {
            push(scan, limits, format!("{prefix}{name}"), &meta);
        }
    }
}

fn push(scan: &mut Scan, limits: &Limits, path: String, meta: &fs::Metadata) {
    if scan.files.len() >= limits.max_files {
        scan.truncated = true;
        return;
    }
    scan.files.push(DocFile {
        path,
        size: meta.len(),
        modified: modified_secs(meta),
    });
}

/// 프로젝트 폴더의 `docsDir` 아래 `.md` 목록
pub fn list_in(project_dir: &Path, docs_dir: &str, limits: &Limits) -> ListResult {
    let root = match locate(project_dir, docs_dir) {
        Err(reason) => return ListResult::Unreadable(problem(reason)),
        Ok(None) => return ListResult::Absent,
        Ok(Some(root)) => root,
    };
    let mut scan = Scan {
        files: Vec::new(),
        visited: 0,
        truncated: false,
    };
    // 맨 위 폴더를 못 읽으면 "목록이 짧다" 가 아니라 읽을 수 없음
    if fs::read_dir(&root).is_err() {
        return ListResult::Unreadable(problem(Problem::ReadFailed));
    }
    walk(&root, &root, "", 0, limits, &mut scan);
    scan.files.sort_by(|a, b| {
        a.path
            .to_lowercase()
            .cmp(&b.path.to_lowercase())
            .then_with(|| a.path.cmp(&b.path))
    });
    ListResult::Ok(DocsListing {
        docs_dir: docs_dir.to_string(),
        files: scan.files,
        truncated: scan.truncated,
    })
}

/// 문서 하나 읽기. 경로 모양이 틀리면 `invalid_input` (화면은 목록이 준 경로만 보낸다 — 틀린 경로는 화면의 버그이거나 우회 시도).
pub fn read_in(project_dir: &Path, docs_dir: &str, path: &str) -> Result<DocReadResult, AppError> {
    let parts = parse_path(path)?;
    let root = match locate(project_dir, docs_dir) {
        Err(reason) => return Ok(DocReadResult::Unreadable(problem(reason))),
        Ok(None) => return Ok(DocReadResult::Absent),
        Ok(Some(root)) => root,
    };
    Ok(match read_text(&root, &parts) {
        Ok(Some(Text { text, version })) => DocReadResult::Ok(DocText { text, version }),
        Ok(None) => DocReadResult::Absent,
        Err(reason) => DocReadResult::Unreadable(problem(reason)),
    })
}

// ───────────────────────── 명령이 부르는 것 ─────────────────────────

pub fn list(db: &AppDb, env: &Env, id: i64) -> Result<ListResult, AppError> {
    let dir = requirements_dir(db, env, id)?;
    Ok(list_in(&dir, &env.docs_dir, &Limits::DEFAULT))
}

pub fn read(db: &AppDb, env: &Env, id: i64, path: &str) -> Result<DocReadResult, AppError> {
    let dir = requirements_dir(db, env, id)?;
    read_in(&dir, &env.docs_dir, path)
}

/// 폴더 링크 · 파일 링크를 만드는 시험 도우미 (`progress` 의 시험도 쓴다). 링크를 못 만들었으면 `must_link` 가 시험을 **실패시킨다** (조용히 통과하지 않게).
#[cfg(test)]
pub(super) mod test_support {
    use std::path::Path;

    /// 폴더 링크를 만든다 (Windows 는 정션 — 관리자 권한이 필요 없다). 못 만들면 `false`
    pub fn make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            // `cmd` 는 `docs/x` 의 `/x` 를 옵션으로 읽는다 — 구분자를 `\` 로 통일해 넘긴다
            let backslashed = |path: &Path| path.to_string_lossy().replace('/', "\\");
            std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(backslashed(link))
                .arg(backslashed(target))
                .output()
                .is_ok_and(|out| out.status.success())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// 파일 심볼릭 링크를 만든다. Windows 는 개발자 모드나 관리자 권한이 있어야 한다 — 못 만들면 `false`
    pub fn make_file_link(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    pub fn must_link(made: bool, what: &str) {
        assert!(
            made,
            "could not create {what} here, so this test checked nothing. For file symlinks on Windows turn on Developer Mode or run as administrator"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{make_dir_link, make_file_link, must_link};
    use super::*;
    use crate::claude::test_util::TempDir;

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    /// 프로젝트 폴더 안에 `docs/` 를 만든 임시 폴더
    fn project() -> TempDir {
        let dir = TempDir::new("docs");
        fs::create_dir_all(dir.join("docs")).unwrap();
        dir
    }

    fn listed(project: &Path) -> DocsListing {
        match list_in(project, "docs", &Limits::DEFAULT) {
            ListResult::Ok(listing) => listing,
            other => panic!("expected ok, got {other:?}"),
        }
    }

    fn paths(listing: &DocsListing) -> Vec<&str> {
        listing
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect()
    }

    fn read_of(project: &Path, path: &str) -> DocReadResult {
        read_in(project, "docs", path).unwrap()
    }

    fn unreadable(reason: Problem) -> DocReadResult {
        DocReadResult::Unreadable(problem(reason))
    }

    // ── 경로 확인 ──

    #[test]
    fn a_path_the_list_could_give_is_accepted() {
        for path in [
            "a.md",
            "sub/a.md",
            "01-planning/decisions.md",
            "한글 폴더/문서 하나.MD",
            "a/b/c/d/e/f/g/h/i.md", // 폴더 8단 + 파일
        ] {
            assert!(parse_path(path).is_ok(), "{path}");
        }
        assert_eq!(
            parse_path("sub/a.md").unwrap(),
            vec!["sub", "a.md"],
            "split on /"
        );
    }

    #[test]
    fn a_path_that_could_leave_docs_or_is_not_markdown_is_refused() {
        let too_long = format!("{}.md", "a".repeat(PATH_MAX_BYTES));
        let too_deep = "d/".repeat(9) + "a.md";
        for path in [
            "",
            "   ",
            "/",
            "/a.md",               // 절대 경로
            "//server/share/a.md", // UNC
            "C:/a.md",             // 드라이브
            "C:\\a.md",
            "C:a.md",
            "../a.md",
            "sub/../a.md",
            "sub/./a.md",
            "./a.md",
            "..\\a.md",
            "sub\\a.md", // `\` 와 `/` 섞임
            "sub/sub\\a.md",
            "sub//a.md",
            "sub/",
            "a.md/",
            "a.txt",
            "a",
            ".md",
            "sub/.md",
            "a.md.",
            "a.md ",
            ".hidden/a.md", // 숨은 폴더
            "sub/.git/a.md",
            ".a.md",
            "CON.md", // 윈도 장치 이름
            "nul.md",
            "sub/COM1.md",
            "lpt9.md",
            "a:stream.md", // 윈도 대체 데이터 스트림
            "a.md:stream",
            "a?.md",
            "a*.md",
            "a\0b.md",
            "a\nb.md",
            too_long.as_str(),
            too_deep.as_str(),
        ] {
            let err = parse_path(path).unwrap_err();
            assert_eq!(err.kind(), "invalid_input", "{path:?}");
            // 화면이 보낸 경로 글자를 오류 글에 되울리지 않는다
            assert!(!err.to_string().contains("stream"), "{path:?}");
        }
    }

    #[test]
    fn the_list_and_the_reader_agree_on_names() {
        for name in [".git", "..", "CON", "a:b", "a\\b", "x.", "x ", "", "q?"] {
            assert!(!valid_component(name), "{name:?}");
        }
        for name in [
            "docs",
            "01-planning",
            "한글",
            "a b",
            "ab.c",
            "COM",
            "COM10.md",
        ] {
            assert!(valid_component(name), "{name:?}");
        }
        assert!(
            is_markdown_name("a.md") && is_markdown_name("A.MD") && is_markdown_name("한글.Md")
        );
        assert!(!is_markdown_name(".md") && !is_markdown_name("md") && !is_markdown_name("a.mdx"));
        // 한글 이름의 끝을 바이트로 잘라도 패닉이 없다
        assert!(!is_markdown_name("가나다"));
    }

    // ── docs 폴더 찾기 ──

    #[test]
    fn a_missing_docs_folder_is_absent_and_a_missing_project_folder_is_unreadable() {
        let dir = TempDir::new("docs-absent");
        assert_eq!(list_in(&dir, "docs", &Limits::DEFAULT), ListResult::Absent);
        assert_eq!(
            read_in(&dir, "docs", "a.md").unwrap(),
            DocReadResult::Absent
        );
        let gone = dir.join("not-here");
        assert_eq!(
            list_in(&gone, "docs", &Limits::DEFAULT),
            ListResult::Unreadable(problem(Problem::FolderMissing))
        );
        assert_eq!(
            read_in(&gone, "docs", "a.md").unwrap(),
            unreadable(Problem::FolderMissing)
        );
        assert!(!gone.exists(), "nothing is created");
    }

    #[test]
    fn docs_that_is_a_file_is_not_a_folder() {
        let dir = TempDir::new("docs-file");
        fs::write(dir.join("docs"), "x").unwrap();
        assert_eq!(
            list_in(&dir, "docs", &Limits::DEFAULT),
            ListResult::Unreadable(problem(Problem::NotAFile))
        );
    }

    #[test]
    fn the_docs_dir_setting_picks_the_folder_and_must_stay_inside_the_project() {
        let dir = TempDir::new("docs-setting");
        put(&dir, "documentation/a.md", b"x");
        put(&dir, "docs/b.md", b"y");
        match list_in(&dir, "documentation", &Limits::DEFAULT) {
            ListResult::Ok(listing) => {
                assert_eq!(listing.docs_dir, "documentation");
                assert_eq!(paths(&listing), ["a.md"]);
            }
            other => panic!("{other:?}"),
        }
        // 설정 값이 상대 경로의 보통 이름이 아니면 (받는 쪽에서 한 번 더 확인)
        for bad in ["", "..", "../docs", "/etc", "C:\\x", "a/../../b", "."] {
            assert_eq!(
                list_in(&dir, bad, &Limits::DEFAULT),
                ListResult::Unreadable(problem(Problem::OutsideFolder)),
                "{bad:?}"
            );
            assert_eq!(
                read_in(&dir, bad, "a.md").unwrap(),
                unreadable(Problem::OutsideFolder),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn a_docs_folder_that_is_a_link_going_outside_the_project_is_refused() {
        let outside = TempDir::new("docs-link-out");
        put(&outside, "secret.md", b"top secret");
        let dir = TempDir::new("docs-link-proj");
        must_link(
            make_dir_link(&outside, &dir.join("docs")),
            "a directory link (junction)",
        );
        assert_eq!(
            list_in(&dir, "docs", &Limits::DEFAULT),
            ListResult::Unreadable(problem(Problem::OutsideFolder))
        );
        assert_eq!(
            read_in(&dir, "docs", "secret.md").unwrap(),
            unreadable(Problem::OutsideFolder)
        );
    }

    #[test]
    fn a_docs_folder_that_is_a_link_to_another_place_inside_the_project_works() {
        let dir = TempDir::new("docs-link-in");
        put(&dir, "real-docs/a.md", b"inside");
        must_link(
            make_dir_link(&dir.join("real-docs"), &dir.join("docs")),
            "a directory link (junction)",
        );
        assert_eq!(paths(&listed(&dir)), ["a.md"]);
        assert!(matches!(read_of(&dir, "a.md"), DocReadResult::Ok(_)));
    }

    // ── 목록 ──

    #[test]
    fn lists_only_markdown_in_path_order_with_size_and_time() {
        let dir = project();
        put(&dir, "docs/b.md", b"bb");
        put(&dir, "docs/A.md", b"a");
        put(&dir, "docs/notes.txt", b"not markdown");
        put(&dir, "docs/image.png", b"png");
        put(&dir, "docs/UPPER.MD", b"upper");
        put(&dir, "docs/01-planning/decisions.md", b"decisions");
        put(&dir, "docs/01-planning/deep/er/x.md", b"x");
        put(&dir, "docs/02-development/dev-plan.md", b"plan");
        put(&dir, "docs/한글/문서.md", "가나다".as_bytes());
        fs::create_dir_all(dir.join("docs/empty-folder")).unwrap();
        let listing = listed(&dir);
        assert_eq!(listing.docs_dir, "docs");
        assert!(!listing.truncated);
        assert_eq!(
            paths(&listing),
            [
                "01-planning/decisions.md",
                "01-planning/deep/er/x.md",
                "02-development/dev-plan.md",
                "A.md",
                "b.md",
                "UPPER.MD",
                "한글/문서.md",
            ]
        );
        let korean = listing.files.last().unwrap();
        assert_eq!(korean.size, "가나다".len() as u64);
        assert!(korean.modified.is_some_and(|secs| secs > 1_500_000_000));
        // 목록에 나온 경로는 읽기가 받는다
        for file in &listing.files {
            assert!(
                matches!(read_of(&dir, &file.path), DocReadResult::Ok(_)),
                "{}",
                file.path
            );
        }
    }

    #[test]
    fn hidden_folders_and_files_are_skipped() {
        let dir = project();
        put(&dir, "docs/ok.md", b"ok");
        put(&dir, "docs/.git/config.md", b"hidden folder");
        put(&dir, "docs/.hidden.md", b"hidden file");
        put(&dir, "docs/sub/.obsidian/x.md", b"hidden folder deeper");
        put(&dir, "docs/CON/x.md", b"reserved folder name");
        let listing = listed(&dir);
        assert_eq!(paths(&listing), ["ok.md"]);
    }

    #[test]
    fn the_list_stops_at_the_file_limit_depth_and_visit_limit_and_says_so() {
        let dir = project();
        for n in 0..12 {
            put(&dir, &format!("docs/f{n:02}.md"), b"x");
        }
        let limits = Limits {
            max_files: 5,
            ..Limits::DEFAULT
        };
        let ListResult::Ok(listing) = list_in(&dir, "docs", &limits) else {
            panic!("ok");
        };
        assert_eq!(listing.files.len(), 5);
        assert!(listing.truncated);
        // 어느 5개인지가 정해져 있다 (이름 순)
        assert_eq!(
            paths(&listing),
            ["f00.md", "f01.md", "f02.md", "f03.md", "f04.md"]
        );

        let deep = project();
        put(&deep, "docs/a/b/c/d.md", b"x");
        put(&deep, "docs/top.md", b"x");
        let limits = Limits {
            max_depth: 2,
            ..Limits::DEFAULT
        };
        let ListResult::Ok(listing) = list_in(&deep, "docs", &limits) else {
            panic!("ok");
        };
        // 폴더 2단(`a/b`)까지만 — `c` 안은 내려가지 않는다
        assert_eq!(paths(&listing), ["top.md"]);
        assert!(listing.truncated);
        let limits = Limits {
            max_depth: 3,
            ..Limits::DEFAULT
        };
        let ListResult::Ok(listing) = list_in(&deep, "docs", &limits) else {
            panic!("ok");
        };
        assert_eq!(paths(&listing), ["a/b/c/d.md", "top.md"]);
        assert!(!listing.truncated);

        // 파일이 아주 많은 폴더(`.md` 가 아닌 것)가 있어도 살펴보는 수가 막힌다
        let many = project();
        for n in 0..30 {
            put(&many, &format!("docs/n{n:02}.txt"), b"x");
        }
        put(&many, "docs/z.md", b"x");
        let limits = Limits {
            max_visited: 10,
            ..Limits::DEFAULT
        };
        let ListResult::Ok(listing) = list_in(&many, "docs", &limits) else {
            panic!("ok");
        };
        assert!(listing.truncated);
        assert!(listing.files.len() <= 10);
    }

    #[test]
    fn the_default_limits_are_eight_levels_and_two_thousand_files() {
        assert_eq!(Limits::DEFAULT.max_depth, 8);
        assert_eq!(Limits::DEFAULT.max_files, 2000);
        let dir = project();
        // 폴더 8단 + 파일은 담기고, 9단은 담기지 않는다
        put(&dir, "docs/1/2/3/4/5/6/7/8/in.md", b"x");
        put(&dir, "docs/1/2/3/4/5/6/7/8/9/out.md", b"x");
        let listing = listed(&dir);
        assert_eq!(paths(&listing), ["1/2/3/4/5/6/7/8/in.md"]);
        assert!(listing.truncated);
        // 담긴 것은 읽히고, 안 담긴 것은 읽기가 깊이로 거절한다
        assert!(matches!(
            read_of(&dir, "1/2/3/4/5/6/7/8/in.md"),
            DocReadResult::Ok(_)
        ));
        assert_eq!(
            read_in(&dir, "docs", "1/2/3/4/5/6/7/8/9/out.md")
                .unwrap_err()
                .kind(),
            "invalid_input"
        );
    }

    #[test]
    fn folder_links_are_not_followed_even_when_they_point_inside() {
        let outside = TempDir::new("docs-list-out");
        put(&outside, "secret.md", b"top secret");
        let dir = project();
        put(&dir, "docs/real/a.md", b"inside");
        must_link(
            make_dir_link(&outside, &dir.join("docs/to-outside")),
            "a directory link (junction)",
        );
        must_link(
            make_dir_link(&dir.join("docs/real"), &dir.join("docs/to-inside")),
            "a directory link (junction)",
        );
        // 되돌아가는 링크 (끝없이 도는 길)
        must_link(
            make_dir_link(&dir.join("docs"), &dir.join("docs/real/loop")),
            "a directory link (junction)",
        );
        // 폴더 링크가 `.md` 로 끝나는 이름이어도 파일이 아니다 (목록에 안 나오고, 읽기는 파일이 아니라고 답한다)
        must_link(
            make_dir_link(&dir.join("docs/real"), &dir.join("docs/dirlink.md")),
            "a directory link (junction)",
        );
        let listing = listed(&dir);
        assert_eq!(paths(&listing), ["real/a.md"]);
        assert!(!listing.truncated);
        assert_eq!(read_of(&dir, "dirlink.md"), unreadable(Problem::NotAFile));
        // 읽기도 폴더 밖으로 나가는 링크는 거절한다 (밖의 파일은 그대로)
        assert_eq!(
            read_of(&dir, "to-outside/secret.md"),
            unreadable(Problem::OutsideFolder)
        );
        assert_eq!(fs::read(outside.join("secret.md")).unwrap(), b"top secret");
    }

    #[test]
    #[cfg_attr(
        windows,
        ignore = "needs file symlink privilege (Windows Developer Mode or admin); run: cargo test -- --ignored link"
    )]
    fn a_file_link_shows_only_when_it_points_inside_docs() {
        let outside = TempDir::new("docs-flink-out");
        put(&outside, "secret.md", b"top secret");
        let dir = project();
        put(&dir, "docs/real.md", b"inside");
        must_link(
            make_file_link(&dir.join("docs/real.md"), &dir.join("docs/inner-link.md")),
            "a file symlink",
        );
        must_link(
            make_file_link(&outside.join("secret.md"), &dir.join("docs/outer-link.md")),
            "a file symlink",
        );
        must_link(
            make_file_link(&dir.join("docs/gone.md"), &dir.join("docs/dangling.md")),
            "a file symlink",
        );
        assert_eq!(paths(&listed(&dir)), ["inner-link.md", "real.md"]);
        assert!(matches!(
            read_of(&dir, "inner-link.md"),
            DocReadResult::Ok(_)
        ));
        assert_eq!(
            read_of(&dir, "outer-link.md"),
            unreadable(Problem::OutsideFolder)
        );
        assert_eq!(read_of(&dir, "dangling.md"), unreadable(Problem::Link));
    }

    // ── 읽기 ──

    #[test]
    fn reads_text_with_its_version_and_leaves_the_bom_and_line_endings_alone() {
        let dir = project();
        put(&dir, "docs/a.md", "# 제목\r\n\r\n본문\r\n".as_bytes());
        let DocReadResult::Ok(read) = read_of(&dir, "a.md") else {
            panic!("ok");
        };
        assert_eq!(read.text, "# 제목\r\n\r\n본문\r\n");
        assert_eq!(
            read.version,
            requirements::version_of("# 제목\r\n\r\n본문\r\n".as_bytes())
        );

        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("첫 줄\n".as_bytes());
        put(&dir, "docs/bom.md", &bytes);
        let DocReadResult::Ok(read) = read_of(&dir, "bom.md") else {
            panic!("ok");
        };
        assert_eq!(read.text, "첫 줄\n");
        assert_eq!(read.version, requirements::version_of(&bytes));
    }

    #[test]
    fn the_version_changes_with_the_content() {
        let dir = project();
        put(&dir, "docs/a.md", b"one");
        let version = |dir: &Path| match read_of(dir, "a.md") {
            DocReadResult::Ok(read) => read.version,
            other => panic!("{other:?}"),
        };
        let first = version(&dir);
        assert_eq!(first, version(&dir));
        put(&dir, "docs/a.md", b"two");
        assert_ne!(first, version(&dir));
    }

    #[test]
    fn a_missing_file_a_folder_and_a_file_under_a_file_are_not_text() {
        let dir = project();
        put(&dir, "docs/a.md", b"x");
        fs::create_dir_all(dir.join("docs/folder.md")).unwrap();
        assert_eq!(read_of(&dir, "nothing.md"), DocReadResult::Absent);
        assert_eq!(read_of(&dir, "no-folder/x.md"), DocReadResult::Absent);
        assert_eq!(read_of(&dir, "a.md/inside.md"), DocReadResult::Absent);
        assert_eq!(read_of(&dir, "folder.md"), unreadable(Problem::NotAFile));
    }

    #[test]
    fn a_file_that_is_not_utf8_or_over_one_megabyte_is_unreadable() {
        let dir = project();
        put(&dir, "docs/euc-kr.md", &[0xC7, 0xD1, 0xB1, 0xDB]);
        assert_eq!(read_of(&dir, "euc-kr.md"), unreadable(Problem::NotUtf8));
        let limit = requirements::MAX_BYTES as usize;
        put(&dir, "docs/exact.md", &vec![b'a'; limit]);
        put(&dir, "docs/over.md", &vec![b'a'; limit + 1]);
        assert!(matches!(read_of(&dir, "exact.md"), DocReadResult::Ok(_)));
        assert_eq!(read_of(&dir, "over.md"), unreadable(Problem::TooLarge));
        // 못 읽는 파일이 있어도 목록은 그 파일을 보여 준다 (크기와 함께)
        let listing = listed(&dir);
        assert!(paths(&listing).contains(&"over.md"));
    }

    #[test]
    fn a_refused_path_does_not_touch_the_disk() {
        let dir = project();
        put(&dir, "docs/a.md", b"x");
        let outside = TempDir::new("docs-refused-out");
        put(&outside, "secret.md", b"top secret");
        let escape = format!(
            "../../{}/secret.md",
            outside.file_name().unwrap().to_str().unwrap()
        );
        assert!(read_in(&dir, "docs", &escape).is_err());
        let absolute = outside
            .join("secret.md")
            .to_string_lossy()
            .replace('\\', "/");
        assert!(read_in(&dir, "docs", &absolute).is_err());
        assert_eq!(fs::read(outside.join("secret.md")).unwrap(), b"top secret");
    }

    #[test]
    fn the_json_the_screen_gets_has_the_documented_shape() {
        let dir = project();
        put(&dir, "docs/sub/a.md", b"x");
        let json = serde_json::to_value(list_in(&dir, "docs", &Limits::DEFAULT)).unwrap();
        assert_eq!(json["state"], "ok");
        assert_eq!(json["docsDir"], "docs");
        assert_eq!(json["truncated"], false);
        assert_eq!(json["files"][0]["path"], "sub/a.md");
        assert_eq!(json["files"][0]["size"], 1);
        assert!(json["files"][0]["modified"].is_number());
        let json = serde_json::to_value(read_of(&dir, "sub/a.md")).unwrap();
        assert_eq!(json["state"], "ok");
        assert_eq!(json["text"], "x");
        assert!(json["version"].is_string());
        let json = serde_json::to_value(read_of(&dir, "sub/none.md")).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "absent" }));
        let json = serde_json::to_value(unreadable(Problem::TooLarge)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "state": "unreadable", "reason": "too_large" })
        );
    }

    #[test]
    fn listing_and_reading_leave_the_folder_as_it_was() {
        let dir = project();
        put(&dir, "docs/a.md", b"x");
        put(&dir, "docs/sub/b.md", b"y");
        let snapshot = |root: &Path| {
            let mut found = Vec::new();
            let mut stack = vec![root.to_path_buf()];
            while let Some(dir) = stack.pop() {
                for entry in fs::read_dir(dir).unwrap() {
                    let entry = entry.unwrap();
                    let path = entry.path();
                    let meta = entry.metadata().unwrap();
                    found.push((path.clone(), meta.len()));
                    if meta.is_dir() {
                        stack.push(path);
                    }
                }
            }
            found.sort();
            found
        };
        let before = snapshot(&dir);
        listed(&dir);
        read_of(&dir, "sub/b.md");
        read_of(&dir, "nothing.md");
        assert_eq!(before, snapshot(&dir));
    }
}
