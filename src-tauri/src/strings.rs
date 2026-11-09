//! Rust 쪽에서 화면 밖(트레이 메뉴 등)에 보이는 문구는 여기에만 둔다 (D-08).
//! 화면 안의 문구는 `src/i18n/ko.ts`.

pub const TRAY_OPEN: &str = "열기";
pub const TRAY_QUIT: &str = "종료";
pub const PICK_FOLDER_TITLE: &str = "프로젝트 폴더 고르기";

// 트레이 상태 (P8, D-50) — 툴팁과 메뉴 맨 위 상태 줄(누를 수 없음)
pub const TRAY_TOOLTIP_IDLE: &str = "Nyanitor — 쉬는 중";
pub const TRAY_TOOLTIP_WORKING: &str = "Nyanitor — 일하는 중";
pub const TRAY_TOOLTIP_WAITING: &str = "Nyanitor — 기다리고 있어요";
pub const TRAY_STATUS_IDLE: &str = "쉬는 중";
pub const TRAY_STATUS_WORKING: &str = "일하는 중";
pub const TRAY_STATUS_WAITING: &str = "답을 기다려요";

// 알림 (P8, D-50). 제목은 `Nyanitor · <프로젝트 이름>` (이름을 모르면 `Nyanitor`), 본문은 앞말 + ` — ` + 자세한 말.
pub const NOTICE_TITLE: &str = "Nyanitor";
pub const NOTICE_TITLE_SEP: &str = " · ";
pub const NOTICE_DETAIL_SEP: &str = " — ";
pub const NOTICE_QUESTION_LEAD: &str = "먹물이 물어봐요";
pub const NOTICE_APPROVAL_LEAD: &str = "승인을 기다려요";
pub const NOTICE_PERMISSION_LEAD: &str = "허락을 기다려요";
pub const NOTICE_RUN_CHECK: &str = "실행해서 확인해 주세요 — 창을 열면 볼 것이 있어요";
pub const NOTICE_WAITING_ANSWER: &str = "먹물이 답을 기다려요";
pub const NOTICE_PHASE_DONE_TAIL: &str = " 단계가 끝났어요";
pub const NOTICE_ERROR: &str = "먹물이 멈췄어요 — 창을 열어 확인해 주세요";
pub const NOTICE_LIMIT: &str = "사용량 한도에 닿았어요 — 창을 열어 확인해 주세요";

// 종료 전 경고 (트레이 "종료" 때 일하는 중이면)
pub const QUIT_TITLE: &str = "Nyanitor 끝내기";
pub const QUIT_MESSAGE: &str = "먹물이 아직 일하고 있어요. 끝내면 지금 하던 일이 멈춰요.";
pub const QUIT_CONFIRM: &str = "끝내기";
pub const QUIT_CANCEL: &str = "취소";
