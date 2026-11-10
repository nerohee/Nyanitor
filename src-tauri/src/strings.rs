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

// 내 수정 (P9-01, D-51) — 기록(로컬 git)의 커밋 메시지와, 새로 만든 에이전트 · 스킬 파일의 본문 틀. 화면 밖(파일 · 기록)에 남는 글이라 여기에 둔다.
pub const CUSTOM_COMMIT_START: &str = "처음 기록";
pub const CUSTOM_COMMIT_CATS: &str = "고양이 연결 바꿈";
pub const CUSTOM_COMMIT_LABELS: &str = "보이는 이름을 바꿈";
pub fn custom_commit_apply(files: usize) -> String {
    format!("적용 — 파일 {files}개")
}
pub fn custom_commit_restore(short: &str) -> String {
    format!("{short} 때로 되돌림")
}
pub fn custom_commit_origin_update(source_short: &str) -> String {
    format!("원본 업데이트 받음 ({source_short})")
}
pub const CUSTOM_NEW_AGENT_BODY: &str =
    "너는 이 프로젝트의 도우미다. 여기에 맡은 일과 지킬 규칙을 한두 줄로 적는다.";
pub const CUSTOM_NEW_SKILL_BODY: &str = "이 스킬이 하는 일과 쓰는 때를 한두 줄로 적는다.";
