//! Claude Code 연결 (P3) — 찾기 · 세션 관리자 · 카드 이벤트.
//!
//! 앱은 사용자 PC 의 수정하지 않은 `claude` 를 `-p --input-format stream-json --output-format stream-json` 으로 띄워
//! 한 프로세스로 여러 턴 대화한다 (D-18, D-44). 근거 · 모양: `docs/02-development/notes/P3-01-cli-protocol.md`.
//!
//! - `discover` — 위치 · 버전 · 로그인 상태 · API 키 있음 · 로그인 창 띄우기
//! - `session` — 세션 관리자 (프로세스 · 스레드 · 요청 짝짓기 · 끝내기 · 이어 하기)
//! - `protocol` — 비공식 control protocol (이 파일들 밖에는 필드 이름을 두지 않는다)
//! - `events` — 화면으로 가는 이벤트 · 명령 입출력 모양
//! - `exec` · `process_tree` — 환경 정리 · 창 숨기기 · 프로세스 트리 끄기
//! - `store` — 프로젝트 폴더별 마지막 세션 ID
//! - `commands` — Tauri 명령 (얇게: 입력 확인 · 전달만)

pub mod commands;
pub mod discover;
pub mod events;
pub mod exec;
pub mod process_tree;
pub mod protocol;
pub mod session;
pub mod store;

/// 이 앱이 시험해 확인한 CLI 버전 (P3-01). 다르면 막지 않고 경고만 한다. CLI 를 올리면 `scripts/cli-probe` 를 다시 돌린다.
pub const KNOWN_CLI_VERSION: &str = "2.1.296";

/// 단위 시험이 쓰는 임시 폴더 — 버려지면 지운다 (OS 임시 폴더에 시험 흔적이 남지 않게).
#[cfg(test)]
pub(crate) mod test_util {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    pub struct TempDir(PathBuf);

    impl std::ops::Deref for TempDir {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    impl TempDir {
        pub fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nyanitor-unit-{name}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create a temp folder");
            Self(dir)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
