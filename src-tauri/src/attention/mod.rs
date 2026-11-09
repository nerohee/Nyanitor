//! 알림 · 트레이 상태 (P8, D-50) — 창을 닫아(숨겨) 두어도 내가 할 일이 생기면 OS 알림이 오고, 트레이 아이콘이 쉬는 중 · 일하는 중 · 기다림을 보인다.
//!
//! 전부 Rust 쪽에서 한다 — 화면은 알림을 띄울 수 없다 (`capabilities/` 에 notification 을 열지 않는다, D-47 의 dialog 와 같은 방식).
//!
//! - `text` — 알림 글 (순수). 도구 이름까지만 싣고, 한 줄로 다듬고, 80자 안쪽에서 자른다.
//! - `decide` — 세션 이벤트 → 트레이 상태 · 띄울 알림 · 읽을 진행 문서 (순수). 창 상태 · 프로젝트 이름은 `Host` 로 바꿔 끼운다.
//! - `hub` — Tauri 쪽 (얇게): 세션 이벤트를 받아 두는 스레드, 창 상태 묻기, 알림 띄우기, 진행 문서를 따로 읽기, 트레이에 반영.
//!
//! 세션의 읽기 스레드는 이벤트를 `emit_gate` 를 쥔 채 내보낸다 — 그래서 `AttentionHandle::session_event` 는 줄에 넣기만 하고 바로 돌아온다.
//! 창 · 파일 · DB · OS 알림은 모두 `hub` 의 스레드가 한다.

pub mod decide;
pub mod hub;
pub mod text;

pub use decide::Mood;
pub use hub::{AttentionHandle, quit_needs_warning, start};
