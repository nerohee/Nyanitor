//! 내 수정 (P9-01, D-51) — 앱이 하네스 **내 수정 폴더**(`<하네스 폴더>/custom/`)에 에이전트 · 스킬 · 오케스트레이터 수정을 저장하고,
//! **적용**(설치 스크립트로 `~/.claude` 에 반영 + 로컬 git 커밋) · 기록 보기 · 어느 때로 되돌리기 · 원본 바뀜 고르기 · 에이전트 ↔ 고양이 연결을 한다.
//!
//! 약속 문서: 하네스 저장소 `shared/app-contract.md` (버전 1) 3절(내 수정 모양)과 2-4절(설정 파일 순서). 결정: D-05 · D-20 · D-21 · D-22 · D-46 · D-47 · D-51.
//!
//! - `id` — 항목 id (`main` · `agent:<이름>` · `skill:<이름>`) · 이름 규칙 · 이름에서 만드는 상대 경로
//! - `hash` · `values` · `json_edit` · `template` — 원본 해시(3-5절) · 값 파일 · 앞머리 · JSON 한 값 고치기 · 새 에이전트 · 스킬 틀 (순수 함수)
//! - `fsx` — 내 수정 폴더 안 읽기 · 쓰기 (경로의 어느 단계도 링크가 아님, UTF-8 · LF · 바꿔 넣기, 256KB)
//! - `items` — 목록 · 항목 하나 읽기 (읽기만, 잠금 없음) / `main_config` — 오케스트레이터(`planner`) 설정
//! - `write` — 값 · 덧붙임 · 통째 · 새로 만들기 · 지우기 · 원본 바뀜 고르기 (검사 포함)
//! - `history` — 로컬 git (적용 안 한 것 · 차이 · 버리기 · 기록 · 커밋)
//! - `apply` — 적용 · 어느 때로 되돌리기 (설치 + 커밋) / `cats` — 고양이 연결
//! - `flow` — 한 번에 하나 잠금(`HarnessState::begin`)을 잡고 위 함수를 부른다 (쓰는 일은 모두 여기를 거친다)
//! - `commands` — Tauri 명령 (얇게)
//!
//! **화면은 항목 id · 값 · 글 · 커밋 번호 · 고양이 id 만 보낸다.** 경로 · 파일 이름을 받는 길은 없다 — 경로는 Rust 가 하네스 폴더 안에서 만들고 (`id`),
//! 쓰기 전에 어느 단계도 링크가 아닌지 다시 확인한다 (`fsx`). 하네스 위치는 환경 변수(`CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME`)로만 바뀐다.

pub mod apply;
pub mod cats;
pub mod commands;
pub mod flow;
pub mod fsx;
pub mod hash;
pub mod history;
pub mod id;
pub mod items;
pub mod json_edit;
pub mod main_config;
pub mod model;
pub mod template;
pub mod values;
pub mod write;

use std::path::PathBuf;

use crate::harness::Context;
use crate::harness::locate::resolve_source;

/// 한 번의 일이 쓰는 위치 — 내 수정 폴더 · 쓸 원본 폴더 (개발자 모드면 그 원본)
pub struct Env<'a> {
    pub ctx: &'a Context,
    /// `<하네스 폴더>/custom`
    pub custom: PathBuf,
    /// 쓸 원본 폴더 (`resolve_source` — 개발자 모드면 그 원본, 아니면 `<하네스 폴더>/repo`)
    pub source: PathBuf,
    pub developer: bool,
}

impl<'a> Env<'a> {
    pub fn new(ctx: &'a Context) -> Self {
        let source = resolve_source(&ctx.locations);
        Self {
            ctx,
            custom: ctx.locations.harness_home.join("custom"),
            developer: source.developer(),
            source: source.dir,
        }
    }

    /// 원본 폴더가 있는가 (없으면 하네스를 아직 받지 않은 것)
    pub fn source_present(&self) -> bool {
        self.source.is_dir()
    }
}

/// 단위 시험 도우미
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;

    /// 폴더 링크 만들기 — Windows 는 정션(`mklink /J`, 권한이 필요 없다), 그 밖은 심볼릭 링크. 실패하면 `false`.
    pub fn make_dir_link(link: &Path, target: &Path) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd")
                .raw_arg(format!(
                    "/C mklink /J \"{}\" \"{}\"",
                    link.display(),
                    target.display()
                ))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }
}
