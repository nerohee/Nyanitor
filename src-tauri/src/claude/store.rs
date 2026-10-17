//! 프로젝트 폴더별 마지막 세션 ID — 앱 데이터 폴더의 작은 JSON 파일 (이어 하기용).
//!
//! 파일 모양 (버전 1): `{ "version": 1, "projects": { "<폴더 키>": { "sessionId": "...", "updatedAt": <초> } } }`
//! - 세션 ID 외에는 아무것도 저장하지 않는다 (대화 내용 · 계정 정보 없음).
//! - 쓰기는 임시 파일에 쓴 뒤 이름을 바꿔 덮는다 (쓰다가 끊겨도 옛 파일이 남는다).
//! - 깨진 파일은 `.corrupt` 로 옮겨 두고 빈 상태로 시작한다. 이 앱보다 새 버전의 파일은 건드리지 않고(읽기 전용) 알린다.
//! - 이 파일은 P4 이후 앱 DB(SQLite, D-20)로 옮겨질 수 있다 — 그때 번호를 붙여 이전한다.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri_plugin_log::log;

const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    session_id: String,
    updated_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct StoreData {
    version: u32,
    projects: BTreeMap<String, Entry>,
}

impl Default for StoreData {
    fn default() -> Self {
        Self {
            version: FORMAT_VERSION,
            projects: BTreeMap::new(),
        }
    }
}

/// 같은 폴더를 가리키는 서로 다른 글자(`C:\Dev\App\` 와 `c:/dev/app`)를 한 키로 모은다.
pub fn project_key(dir: &Path) -> String {
    let text = dir.to_string_lossy();
    let text = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    if cfg!(windows) {
        let unified = text.replace('/', "\\");
        let trimmed = unified.trim_end_matches('\\');
        // `C:\` 처럼 뿌리만 남으면 끝 `\` 를 살린다
        let key = if trimmed.len() == 2 && trimmed.ends_with(':') {
            format!("{trimmed}\\")
        } else {
            trimmed.to_string()
        };
        key.to_lowercase()
    } else {
        let trimmed = text.trim_end_matches('/');
        if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        }
    }
}

/// 세션 ID 로 쓸 수 있는 글자 모양인가 (인자로 들어가므로 엄격하게).
pub fn is_valid_session_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Debug)]
pub struct ResumeStore {
    path: PathBuf,
    data: StoreData,
    /// 이 앱보다 새 버전 파일이라 쓰지 않는다
    read_only: bool,
}

impl ResumeStore {
    /// 파일을 읽는다. 없으면 빈 상태, 깨졌으면 `.corrupt` 로 옮기고 빈 상태.
    pub fn open(path: PathBuf) -> Self {
        let mut store = Self {
            path,
            data: StoreData::default(),
            read_only: false,
        };
        let text = match fs::read_to_string(&store.path) {
            Ok(text) => text,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return store,
            Err(err) => {
                log::warn!("could not read the session store: {err}");
                store.read_only = true; // 읽지 못한 파일을 빈 것으로 덮어쓰지 않는다
                return store;
            }
        };
        match serde_json::from_str::<StoreData>(&text) {
            Ok(data) if data.version <= FORMAT_VERSION => store.data = data,
            Ok(data) => {
                log::warn!(
                    "session store version {} is newer than supported {FORMAT_VERSION}; leaving it untouched",
                    data.version
                );
                store.read_only = true;
            }
            Err(err) => {
                log::warn!("session store is corrupt ({err}); moving it aside");
                let aside = store.path.with_extension("json.corrupt");
                if let Err(err) = fs::rename(&store.path, &aside) {
                    log::warn!("could not move the corrupt session store aside: {err}");
                    store.read_only = true;
                }
            }
        }
        store
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.data
            .projects
            .get(key)
            .map(|entry| entry.session_id.clone())
            .filter(|id| is_valid_session_id(id))
    }

    /// 저장한다. 같은 값이면 파일을 다시 쓰지 않는다. 쓰지 못하면 오류 (메모리에는 반영하지 않는다).
    pub fn set(&mut self, key: &str, session_id: &str) -> io::Result<()> {
        if !is_valid_session_id(session_id) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "session id has unexpected characters",
            ));
        }
        if self.read_only {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "session store is read-only (newer or unreadable file)",
            ));
        }
        if self.get(key).as_deref() == Some(session_id) {
            return Ok(());
        }
        let mut next = self.data.clone();
        next.projects.insert(
            key.to_string(),
            Entry {
                session_id: session_id.to_string(),
                updated_at: now_secs(),
            },
        );
        write_atomically(&self.path, &next)?;
        self.data = next;
        Ok(())
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn write_atomically(path: &Path, data: &StoreData) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(data).map_err(io::Error::other)?;
    fs::write(&tmp, text.as_bytes())?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_util::TempDir;
    use super::*;

    const ID_A: &str = "00000000-0000-4000-8000-000000000001";
    const ID_B: &str = "00000000-0000-4000-8000-000000000002";

    /// 시험마다 새 폴더 — 안에 쓸 저장 파일 경로. 폴더 손잡이를 쥐고 있는 동안만 남는다.
    fn temp_file(name: &str) -> (TempDir, PathBuf) {
        let dir = TempDir::new(name);
        let file = dir.join("data").join("claude-sessions.json");
        (dir, file)
    }

    #[test]
    fn keys_unify_slashes_case_and_trailing_separators_on_windows() {
        if cfg!(windows) {
            assert_eq!(project_key(Path::new("C:\\Dev\\App\\")), "c:\\dev\\app");
            assert_eq!(project_key(Path::new("c:/dev/app")), "c:\\dev\\app");
            assert_eq!(
                project_key(Path::new("\\\\?\\C:\\Dev\\App")),
                "c:\\dev\\app"
            );
            assert_eq!(project_key(Path::new("C:\\")), "c:\\");
        } else {
            assert_eq!(project_key(Path::new("/home/a/")), "/home/a");
            assert_eq!(project_key(Path::new("/")), "/");
        }
    }

    #[test]
    fn missing_file_is_an_empty_store_and_the_dir_is_created_on_first_write() {
        let (_dir, path) = temp_file("missing");
        let mut store = ResumeStore::open(path.clone());
        assert_eq!(store.get("k"), None);
        store.set("k", ID_A).unwrap();
        assert!(path.exists());
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(ResumeStore::open(path).get("k").as_deref(), Some(ID_A));
    }

    #[test]
    fn values_are_kept_per_project_and_replaced_on_change() {
        let (_dir, path) = temp_file("replace");
        let mut store = ResumeStore::open(path.clone());
        store.set("a", ID_A).unwrap();
        store.set("b", ID_B).unwrap();
        store.set("a", ID_B).unwrap();
        let reopened = ResumeStore::open(path);
        assert_eq!(reopened.get("a").as_deref(), Some(ID_B));
        assert_eq!(reopened.get("b").as_deref(), Some(ID_B));
    }

    #[test]
    fn the_file_holds_only_ids_and_times() {
        let (_dir, path) = temp_file("shape");
        ResumeStore::open(path.clone()).set("k", ID_A).unwrap();
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["projects"]["k"]["sessionId"], ID_A);
        assert!(value["projects"]["k"]["updatedAt"].is_u64());
        assert_eq!(value["projects"]["k"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_corrupt_file_is_moved_aside_and_the_store_starts_empty() {
        let (_dir, path) = temp_file("corrupt");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        let mut store = ResumeStore::open(path.clone());
        assert_eq!(store.get("k"), None);
        assert!(path.with_extension("json.corrupt").exists());
        store.set("k", ID_A).unwrap();
        assert_eq!(ResumeStore::open(path).get("k").as_deref(), Some(ID_A));
    }

    #[test]
    fn a_newer_version_file_is_left_alone() {
        let (_dir, path) = temp_file("newer");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original = r#"{"version":99,"projects":{"k":{"sessionId":"00000000-0000-4000-8000-000000000001","updatedAt":1}}}"#;
        fs::write(&path, original).unwrap();
        let mut store = ResumeStore::open(path.clone());
        let err = store.set("k", ID_B).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read_to_string(path).unwrap(), original);
    }

    #[test]
    fn bad_session_ids_are_refused_before_touching_the_file() {
        let (_dir, path) = temp_file("badid");
        let mut store = ResumeStore::open(path.clone());
        for bad in [
            "",
            "short",
            "has space in it 123456",
            "--resume;rm -rf",
            &"x".repeat(65),
        ] {
            assert!(store.set("k", bad).is_err(), "{bad}");
        }
        assert!(!path.exists());
    }

    #[test]
    fn a_stored_id_with_a_bad_shape_is_not_returned() {
        let (_dir, path) = temp_file("tampered");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{"version":1,"projects":{"k":{"sessionId":"--evil --flag","updatedAt":1}}}"#,
        )
        .unwrap();
        assert_eq!(ResumeStore::open(path).get("k"), None);
    }

    #[test]
    fn writing_the_same_value_again_does_not_rewrite_the_file() {
        let (_dir, path) = temp_file("same");
        let mut store = ResumeStore::open(path.clone());
        store.set("k", ID_A).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        store.set("k", ID_A).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }
}

/// P3-03 — 저장소 경계 시험 (파일 없음 · 깨짐 · 다른 버전 · 쓰기 실패 · 폴더 표기 · 세션 ID 모양).
#[cfg(test)]
mod edge_tests {
    use super::super::test_util::TempDir;
    use super::*;

    const ID_A: &str = "00000000-0000-4000-8000-000000000001";
    const ID_B: &str = "00000000-0000-4000-8000-000000000002";

    fn file_in(dir: &TempDir) -> PathBuf {
        dir.join("data").join("claude-sessions.json")
    }

    fn write_raw(path: &Path, text: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    // ───────── 폴더 표기 ─────────

    #[cfg(windows)]
    #[test]
    fn every_spelling_of_the_same_windows_folder_gets_one_key() {
        let key = project_key(Path::new("C:\\Users\\Me\\Proj"));
        for same in [
            "c:\\users\\me\\proj",
            "C:\\USERS\\ME\\PROJ\\",
            "C:/Users/Me/Proj",
            "C:/Users/Me/Proj/",
            "c:/users/me/proj//",
            "\\\\?\\C:\\Users\\Me\\Proj",
            "\\\\?\\c:\\users\\me\\proj\\",
        ] {
            assert_eq!(project_key(Path::new(same)), key, "{same}");
        }
        assert_ne!(project_key(Path::new("C:\\Users\\Me\\Proj2")), key);
        assert_ne!(project_key(Path::new("D:\\Users\\Me\\Proj")), key);
        assert_ne!(project_key(Path::new("C:\\Users\\Me")), key);
    }

    #[cfg(windows)]
    #[test]
    fn drive_roots_unc_paths_and_non_ascii_names_make_sensible_keys() {
        assert_eq!(project_key(Path::new("C:")), project_key(Path::new("C:\\")));
        assert_eq!(project_key(Path::new("c:/")), "c:\\");
        assert_eq!(
            project_key(Path::new("\\\\Srv\\Share\\Proj\\")),
            project_key(Path::new("\\\\srv\\share\\proj"))
        );
        assert_eq!(
            project_key(Path::new("C:\\내 프로젝트")),
            project_key(Path::new("c:/내 프로젝트/"))
        );
        // 유니코드 대소문자 (NTFS 도 같은 폴더로 본다)
        assert_eq!(
            project_key(Path::new("C:\\Ärger")),
            project_key(Path::new("c:\\ärger"))
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "P3-03 버그(낮음): `\\\\?\\UNC\\서버\\공유\\폴더` 와 `\\\\서버\\공유\\폴더` 는 같은 폴더인데 키가 다르다 — project_key 가 `\\\\?\\` 만 벗기고 `UNC\\` 를 `\\\\` 로 바꾸지 않아, 폴더 선택 창이 verbatim 경로를 주는 경우 이어 하기 기록이 따로 쌓인다 (같은 이유로 `C:\\p\\.\\x` · `C:\\p\\\\x` 처럼 안쪽 `.` · 겹친 구분자도 모으지 않는다)"]
    fn verbatim_unc_and_dotted_spellings_of_the_same_folder_share_a_key() {
        assert_eq!(
            project_key(Path::new("\\\\?\\UNC\\srv\\share\\proj")),
            project_key(Path::new("\\\\srv\\share\\proj"))
        );
        assert_eq!(
            project_key(Path::new("C:\\p\\.\\x")),
            project_key(Path::new("C:\\p\\x"))
        );
        assert_eq!(
            project_key(Path::new("C:\\p\\\\x")),
            project_key(Path::new("C:\\p\\x"))
        );
    }

    #[test]
    fn odd_keys_round_trip_through_the_file() {
        let dir = TempDir::new("odd-keys");
        let path = file_in(&dir);
        let keys = [
            String::new(),
            "c:\\내 프로젝트 (1)".to_string(),
            "quote\"and\\slash".to_string(),
            "line\nbreak".to_string(),
            "k".repeat(10_000),
        ];
        let mut store = ResumeStore::open(path.clone());
        for key in &keys {
            store.set(key, ID_A).unwrap();
        }
        let reopened = ResumeStore::open(path);
        for key in &keys {
            assert_eq!(reopened.get(key).as_deref(), Some(ID_A));
        }
    }

    // ───────── 세션 ID 모양 ─────────

    #[test]
    fn session_id_shapes_at_the_edges() {
        for ok in [
            "abcdefgh",
            &"a".repeat(64),
            "ABCDEF-12",
            "00000000-0000-4000-8000-000000000001",
        ] {
            assert!(is_valid_session_id(ok), "{ok}");
        }
        for bad in [
            "",
            "abcdefg",
            &"a".repeat(65),
            "abc_defgh",
            "abc defgh",
            "abcdefgh\n",
            "abcdefgh\0",
            " abcdefgh",
            "abc/defgh",
            "abc.defgh",
            "아이디아이디아이디아이디",
            "０１２３４５６７８", // 전각 숫자
            "abcdefgh;ls",
            "$(calc)xxxx",
        ] {
            assert!(!is_valid_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    #[ignore = "P3-03 버그(낮음, 방어): is_valid_session_id 가 `-` 로 시작하는 값도 통과시킨다 — `--dangerously-skip-permissions` 는 글자 · 길이 조건을 모두 만족한다. 저장 파일(앱 데이터)이나 CLI 가 준 ID 가 이런 값이면 `--resume <값>` 에서 옵션으로 읽힐 수 있다 (`--resume` 의 값이 선택이면 `--resume` 다음 인자가 그냥 옵션이 된다). 세션 ID 는 UUID 모양이니 첫 글자가 영숫자인 것만 받으면 된다"]
    fn an_id_that_starts_with_a_dash_cannot_be_read_as_an_option_by_the_cli() {
        for bad in [
            "--dangerously-skip-permissions",
            "--------",
            "-p-p-p-p-p",
            "--resume",
        ] {
            assert!(!is_valid_session_id(bad), "{bad}");
        }
        let dir = TempDir::new("dash-id");
        let mut store = ResumeStore::open(file_in(&dir));
        assert!(store.set("k", "--dangerously-skip-permissions").is_err());
    }

    #[test]
    fn a_stored_id_that_became_invalid_on_disk_is_hidden_but_does_not_break_other_projects() {
        let dir = TempDir::new("mixed");
        let path = file_in(&dir);
        write_raw(
            &path,
            format!(
                r#"{{"version":1,"projects":{{"bad":{{"sessionId":"x y","updatedAt":1}},"good":{{"sessionId":"{ID_A}","updatedAt":2}}}}}}"#
            )
            .as_bytes(),
        );
        let mut store = ResumeStore::open(path);
        assert_eq!(store.get("bad"), None);
        assert_eq!(store.get("good").as_deref(), Some(ID_A));
        // 나쁜 항목은 새 값으로 바꿀 수 있다
        store.set("bad", ID_B).unwrap();
        assert_eq!(store.get("bad").as_deref(), Some(ID_B));
    }

    // ───────── 파일 상태 ─────────

    #[test]
    fn files_with_the_wrong_shape_are_moved_aside_and_the_store_starts_empty() {
        for (n, text) in [
            "",
            "   ",
            "null",
            "[]",
            "{}",
            "[1,2,3]",
            "\"text\"",
            "{\"version\":1}",
            "{\"version\":\"1\",\"projects\":{}}",
            "{\"version\":1,\"projects\":[]}",
            "{\"version\":1,\"projects\":{\"k\":5}}",
            "{\"version\":1,\"projects\":{\"k\":{\"sessionId\":5,\"updatedAt\":1}}}",
            "{\"version\":-1,\"projects\":{}}",
            "{\"version\":1,\"projects\":{\"k\":{\"sessionId\":\"x\"}}}",
            "\u{0}\u{0}\u{0}",
            "{\"version\":1,\"projects\":{",
        ]
        .into_iter()
        .enumerate()
        {
            let dir = TempDir::new(&format!("shape{n}"));
            let path = file_in(&dir);
            write_raw(&path, text.as_bytes());
            let mut store = ResumeStore::open(path.clone());
            assert_eq!(store.get("k"), None, "{text:?}");
            assert!(
                path.with_extension("json.corrupt").exists(),
                "옛 파일을 옆으로 옮겨 두지 않았다: {text:?}"
            );
            assert!(!path.exists());
            // 그다음에는 평소처럼 저장된다
            store.set("k", ID_A).unwrap();
            assert_eq!(ResumeStore::open(path).get("k").as_deref(), Some(ID_A));
        }
    }

    #[test]
    fn a_non_utf8_file_is_treated_as_corrupt_not_as_a_crash() {
        let dir = TempDir::new("binary");
        let path = file_in(&dir);
        write_raw(&path, &[0xff, 0xfe, 0x00, 0x7b, 0x00]);
        let store = ResumeStore::open(path.clone());
        assert_eq!(store.get("k"), None);
        // 읽기 자체가 실패한 파일은 지우거나 덮어쓰지 않는다
        assert!(path.exists() || path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn a_second_corruption_keeps_the_latest_bad_file_aside_and_never_loses_the_good_one() {
        let dir = TempDir::new("twice");
        let path = file_in(&dir);
        write_raw(&path, b"first {");
        let mut store = ResumeStore::open(path.clone());
        store.set("k", ID_A).unwrap();
        // 좋은 파일이 생긴 뒤 다시 깨졌다
        fs::write(&path, b"second {").unwrap();
        let again = ResumeStore::open(path.clone());
        assert_eq!(again.get("k"), None);
        let aside = fs::read_to_string(path.with_extension("json.corrupt")).unwrap();
        assert_eq!(aside, "second {");
    }

    #[test]
    fn a_version_zero_file_is_still_read() {
        let dir = TempDir::new("versions");
        let path = file_in(&dir);
        write_raw(
            &path,
            format!(r#"{{"version":0,"projects":{{"k":{{"sessionId":"{ID_A}","updatedAt":1}}}}}}"#)
                .as_bytes(),
        );
        assert_eq!(ResumeStore::open(path).get("k").as_deref(), Some(ID_A));
    }

    #[test]
    #[ignore = "P3-03 버그(낮음): 이 앱보다 새 버전(version 2)의 파일은 \"건드리지 않는다\" 가 설계인데, 모양이 다르면(예: projects 가 배열) 읽기 오류로 보고 `.corrupt` 로 옮겨 버린다 — 새 앱이 쓴 파일을 옛 앱으로 열었을 때 이어 하기 기록이 새 앱에서 사라진다. `version` 만 먼저 읽어 > 1 이면 모양과 상관없이 읽기 전용으로 둬야 한다"]
    fn a_newer_format_with_a_different_shape_is_left_in_place_not_moved_aside() {
        let dir = TempDir::new("newer-shape");
        let path = file_in(&dir);
        let original = r#"{"version":2,"projects":[{"path":"C:\\p","sessionIds":["a","b"]}]}"#;
        write_raw(&path, original.as_bytes());
        let mut store = ResumeStore::open(path.clone());
        assert!(store.set("k", ID_A).is_err(), "읽기 전용이어야 한다");
        assert!(path.exists(), "새 형식 파일이 제자리에 있어야 한다");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!path.with_extension("json.corrupt").exists());
    }

    #[test]
    fn unknown_extra_fields_in_a_current_version_file_are_tolerated() {
        let dir = TempDir::new("extra");
        let path = file_in(&dir);
        write_raw(
            &path,
            format!(
                r#"{{"version":1,"future":true,"projects":{{"k":{{"sessionId":"{ID_A}","updatedAt":1,"note":"x"}}}}}}"#
            )
            .as_bytes(),
        );
        assert_eq!(ResumeStore::open(path).get("k").as_deref(), Some(ID_A));
    }

    // ───────── 쓰기 실패 ─────────

    #[test]
    fn when_the_data_folder_cannot_be_created_set_fails_and_the_memory_is_not_changed() {
        let dir = TempDir::new("no-folder");
        // `data` 자리에 폴더가 아닌 파일이 있다
        fs::write(dir.join("data"), b"i am a file").unwrap();
        let mut store = ResumeStore::open(file_in(&dir));
        assert!(store.set("k", ID_A).is_err());
        assert_eq!(store.get("k"), None);
        // 막힌 것이 풀리면 같은 저장소 객체로 다시 저장된다
        fs::remove_file(dir.join("data")).unwrap();
        store.set("k", ID_A).unwrap();
        assert_eq!(store.get("k").as_deref(), Some(ID_A));
    }

    #[test]
    fn a_blocked_temp_file_name_fails_the_write_without_touching_the_old_file() {
        let dir = TempDir::new("tmp-blocked");
        let path = file_in(&dir);
        let mut store = ResumeStore::open(path.clone());
        store.set("k", ID_A).unwrap();
        let before = fs::read_to_string(&path).unwrap();
        // 임시 파일 이름 자리에 폴더가 있다 → 쓰기 실패
        fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(store.set("k", ID_B).is_err());
        assert_eq!(store.get("k").as_deref(), Some(ID_A), "메모리도 옛 값");
        assert_eq!(fs::read_to_string(&path).unwrap(), before, "파일도 옛 값");
    }

    #[test]
    fn a_target_path_that_is_a_folder_fails_the_write_and_leaves_no_temp_file() {
        let dir = TempDir::new("target-dir");
        let path = file_in(&dir);
        // 저장 파일 자리가 폴더 — 읽을 수 없는 파일로 보고 읽기 전용이 된다 (빈 것으로 덮어쓰지 않는다)
        fs::create_dir_all(&path).unwrap();
        let mut store = ResumeStore::open(path.clone());
        assert_eq!(store.get("k"), None);
        let err = store.set("k", ID_A).unwrap_err();
        assert!(matches!(
            err.kind(),
            io::ErrorKind::PermissionDenied | io::ErrorKind::Other | io::ErrorKind::IsADirectory
        ));
        assert!(path.is_dir(), "폴더가 그대로");
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn a_read_only_file_makes_the_write_fail_cleanly() {
        let dir = TempDir::new("readonly");
        let path = file_in(&dir);
        let mut store = ResumeStore::open(path.clone());
        store.set("k", ID_A).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions.clone()).unwrap();
        let result = store.set("k", ID_B);
        // 읽기 전용 해제 (임시 폴더 정리를 위해)
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
        // Windows 에서는 읽기 전용 파일 위에 이름 바꾸기가 거절된다. 유닉스는 폴더 권한이 정하므로 성공할 수 있다.
        if cfg!(windows) {
            assert!(result.is_err());
            assert_eq!(store.get("k").as_deref(), Some(ID_A));
        }
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn writing_a_different_key_leaves_the_other_keys_and_the_file_stays_valid_json() {
        let dir = TempDir::new("others");
        let path = file_in(&dir);
        let mut store = ResumeStore::open(path.clone());
        for i in 0..50 {
            store.set(&format!("project-{i}"), ID_A).unwrap();
        }
        store.set("project-7", ID_B).unwrap();
        let reopened = ResumeStore::open(path.clone());
        assert_eq!(reopened.get("project-7").as_deref(), Some(ID_B));
        assert_eq!(reopened.get("project-8").as_deref(), Some(ID_A));
        assert!(
            serde_json::from_str::<serde_json::Value>(&fs::read_to_string(path).unwrap()).is_ok()
        );
    }

    #[test]
    fn two_stores_on_the_same_file_do_not_corrupt_it_but_the_last_writer_wins() {
        // 앱은 저장소를 하나만 쓰지만(관리자가 잠금으로 감싼다), 두 개가 열려도 파일이 깨지지는 않아야 한다.
        let dir = TempDir::new("two-stores");
        let path = file_in(&dir);
        let mut a = ResumeStore::open(path.clone());
        let mut b = ResumeStore::open(path.clone());
        a.set("from-a", ID_A).unwrap();
        b.set("from-b", ID_B).unwrap();
        let reopened = ResumeStore::open(path);
        assert_eq!(reopened.get("from-b").as_deref(), Some(ID_B));
        // 늦게 쓴 쪽이 옛 메모리 기준으로 덮으므로 앞 항목은 사라질 수 있다 — 깨지지만 않으면 된다
    }
}
