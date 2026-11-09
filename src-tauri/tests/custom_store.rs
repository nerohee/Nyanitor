//! 내 수정 저장 시험 (P9-01, D-51) — 목록 · 읽기 · 값 · 덧붙임 · 통째 · 새로 만들기 · 지우기 · 원본 바뀜 · 오케스트레이터 설정.
//! 모두 임시 폴더 (`CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME` 에 해당하는 위치를 `Locations` 로 직접 준다) — 실제 `~/.claude` · `~/.claude-harness` 는 건드리지 않는다.
//! 쓰는 일은 앱이 부르는 `flow` 함수로 (잠금 포함). git 은 이 PC 의 것을 쓴다.

mod common;

use std::fs;

use common::*;
use nyanitor_lib::custom::items;
use nyanitor_lib::custom::model::{
    CustomList, ItemInfo, ItemRead, ListEntry, Mark, TextPart, UnreadableReason, WriteOutcome,
    WriteResult,
};
use nyanitor_lib::custom::values::Values;
use nyanitor_lib::custom::write::NewItem;
use nyanitor_lib::custom::{Env, flow};
use nyanitor_lib::error::AppError;
use nyanitor_lib::harness::HarnessState;

fn list(r: &CustomRoot) -> CustomList {
    let ctx = r.ctx();
    items::list(&Env::new(&ctx))
}

fn info(list: &CustomList, id: &str) -> ItemInfo {
    list.items
        .iter()
        .find_map(|entry| match entry {
            ListEntry::Ok(info) if info.id == id => Some(info.clone()),
            _ => None,
        })
        .unwrap_or_else(|| panic!("{id} 가 목록에 없다: {:#?}", list.items))
}

fn unreadable(list: &CustomList, id: &str) -> UnreadableReason {
    list.items
        .iter()
        .find_map(|entry| match entry {
            ListEntry::Unreadable(item) if item.id == id => Some(item.reason),
            _ => None,
        })
        .unwrap_or_else(|| panic!("{id} 가 읽을 수 없음으로 목록에 없다: {:#?}", list.items))
}

fn read(r: &CustomRoot, id: &str) -> Result<ItemRead, AppError> {
    let ctx = r.ctx();
    items::read_item(&Env::new(&ctx), id)
}

fn detail(r: &CustomRoot, id: &str) -> nyanitor_lib::custom::model::ItemDetail {
    match read(r, id).unwrap() {
        ItemRead::Ok(detail) => *detail,
        other => panic!("{id}: {other:?}"),
    }
}

fn values(model: Option<&str>, effort: Option<&str>) -> Values {
    Values {
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
    }
}

fn save_values(r: &CustomRoot, id: &str, wanted: &Values) -> Result<WriteResult, AppError> {
    flow::save_values(&HarnessState::default(), &r.ctx(), id, wanted)
}

fn save_append(r: &CustomRoot, id: &str, text: &str) -> WriteResult {
    flow::save_append(&HarnessState::default(), &r.ctx(), id, text).unwrap()
}

fn replace_start(r: &CustomRoot, id: &str) -> WriteResult {
    flow::replace_start(&HarnessState::default(), &r.ctx(), id).unwrap()
}

fn save_text(r: &CustomRoot, id: &str, text: &str) -> WriteResult {
    flow::save_text(&HarnessState::default(), &r.ctx(), id, text).unwrap()
}

fn replace_stop(r: &CustomRoot, id: &str) -> WriteResult {
    flow::replace_stop(&HarnessState::default(), &r.ctx(), id).unwrap()
}

fn origin_keep(r: &CustomRoot, id: &str) -> WriteResult {
    flow::origin_keep(&HarnessState::default(), &r.ctx(), id).unwrap()
}

fn delete_mine(r: &CustomRoot, id: &str) -> WriteResult {
    flow::delete_mine(&HarnessState::default(), &r.ctx(), id).unwrap()
}

fn new_item(
    kind: &str,
    name: &str,
    description: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> NewItem {
    NewItem {
        kind: kind.into(),
        name: name.into(),
        description: description.into(),
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
    }
}

fn create(r: &CustomRoot, request: &NewItem) -> Result<WriteResult, AppError> {
    flow::create(&HarnessState::default(), &r.ctx(), request)
}

fn saved(result: &WriteResult) -> bool {
    result.outcome == WriteOutcome::Saved
}

fn refused(result: &WriteResult) -> &str {
    assert_eq!(result.outcome, WriteOutcome::Refused, "{result:?}");
    result.reason.as_deref().unwrap()
}

// ───────────────────────────── 목록 ─────────────────────────────

#[test]
fn without_a_source_folder_the_list_is_empty_and_unavailable_not_an_error() {
    let r = CustomRoot::empty("custom-nosource");
    let list = list(&r);
    assert!(!list.available);
    assert_eq!(list.reason.as_deref(), Some("no_source"));
    assert!(list.items.is_empty());
    assert!(!r.custom.exists(), "읽기는 아무것도 만들지 않는다");
}

#[test]
fn the_list_has_main_first_then_agents_then_skills_by_name_and_skips_the_common_folder() {
    let r = CustomRoot::new("custom-list");
    let list = list(&r);
    assert!(list.available && list.reason.is_none() && !list.developer_mode);
    let ids: Vec<String> = list
        .items
        .iter()
        .map(|entry| match entry {
            ListEntry::Ok(info) => info.id.clone(),
            ListEntry::Unreadable(item) => item.id.clone(),
        })
        .collect();
    assert_eq!(
        ids,
        [
            "main",
            "agent:harness-builder-ui",
            "agent:harness-designer",
            "skill:desktop-app",
            "skill:web-full"
        ]
    );
    let ui = info(&list, "agent:harness-builder-ui");
    assert_eq!(ui.name, "harness-builder-ui");
    assert_eq!(ui.description.as_deref(), Some("화면 구현자"));
    assert_eq!(ui.file, "agents/harness-builder-ui.md");
    assert_eq!(ui.model.as_deref(), Some("sonnet"));
    assert_eq!(ui.effort.as_deref(), Some("medium"));
    assert_eq!((ui.my_model.clone(), ui.my_effort.clone()), (None, None));
    assert_eq!(ui.current_model.as_deref(), Some("sonnet"));
    assert!(ui.marks.is_empty());
    assert_eq!(ui.origin_changed, None);
    let main = info(&list, "main");
    assert_eq!(main.model.as_deref(), Some("opus"));
    assert_eq!(main.effort.as_deref(), Some("high"));
    assert_eq!(main.file, "config.local.json");
    let web = info(&list, "skill:web-full");
    assert_eq!(web.file, "skills/web-full/SKILL.md");
    assert_eq!(web.model, None);
    // 아직 기록을 시작하지 않았다 — 적용 안 한 것도 없다
    assert_eq!(
        serde_json::to_value(&list.history).unwrap(),
        serde_json::json!({"state": "not_started", "detail": null})
    );
    assert!(list.unapplied.known && list.unapplied.count == 0);
    assert!(!r.custom.exists());
}

#[test]
fn a_broken_item_is_unreadable_but_the_rest_still_shows() {
    let r = CustomRoot::new("custom-broken");
    r.write_source("agents/harness-broken.md", "앞머리가 없다\n");
    r.write_source("agents/harness-unclosed.md", "---\nname: x\n본문\n");
    r.write_source("agents/harness-big.md", &"a".repeat(300 * 1024));
    fs::write(
        r.source.join("agents").join("harness-binary.md"),
        [0xff, 0xfe, 0x00],
    )
    .unwrap();
    let list = list(&r);
    assert_eq!(
        unreadable(&list, "agent:harness-broken"),
        UnreadableReason::NoFrontmatter
    );
    assert_eq!(
        unreadable(&list, "agent:harness-unclosed"),
        UnreadableReason::UnclosedFrontmatter
    );
    assert_eq!(
        unreadable(&list, "agent:harness-big"),
        UnreadableReason::TooLarge
    );
    assert_eq!(
        unreadable(&list, "agent:harness-binary"),
        UnreadableReason::NotUtf8
    );
    assert_eq!(
        info(&list, "agent:harness-designer").model.as_deref(),
        Some("opus")
    );
}

#[test]
fn names_that_do_not_fit_the_pattern_are_not_items() {
    let r = CustomRoot::new("custom-oddnames");
    r.write_source("agents/Harness_Odd.md", SOURCE_AGENT_UI);
    r.write_source("agents/notes.txt", "x");
    r.write_source("skills/Bad_Name/SKILL.md", SOURCE_SKILL_WEB);
    r.write_source("skills/no-skill-file/readme.md", "x");
    let list = list(&r);
    assert_eq!(list.items.len(), 5, "{:#?}", list.items);
}

#[test]
fn reading_an_item_gives_origin_text_values_and_nothing_for_unknown_or_odd_ids() {
    let r = CustomRoot::new("custom-read");
    let d = detail(&r, "agent:harness-builder-ui");
    assert_eq!(
        d.origin_text,
        TextPart::Text {
            text: SOURCE_AGENT_UI.into()
        }
    );
    assert_eq!(d.append_text, TextPart::Absent);
    assert_eq!(d.replace_text, TextPart::Absent);
    assert!(!d.origin_gone);
    assert!(matches!(
        read(&r, "agent:nothing-here").unwrap(),
        ItemRead::NotFound
    ));
    let main = detail(&r, "main");
    assert_eq!(main.origin_text, TextPart::Absent);
    for bad in [
        "",
        "agent:",
        "agent:../x",
        "agent:A",
        "skill:a/b",
        "agent:_common",
        "main ",
        "x",
        "agent:main",
    ] {
        let error = read(&r, bad).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{bad:?}");
    }
}

#[test]
fn a_text_over_256kb_is_too_large_only_for_that_part() {
    let r = CustomRoot::new("custom-toolarge-part");
    save_values(&r, "agent:harness-builder-ui", &values(Some("opus"), None)).unwrap();
    r.write_custom(
        "agents/harness-builder-ui.append.md",
        &"b".repeat(300 * 1024),
    );
    let d = detail(&r, "agent:harness-builder-ui");
    assert_eq!(d.append_text, TextPart::TooLarge);
    assert_eq!(d.info.my_model.as_deref(), Some("opus"));
    assert!(d.info.marks.contains(&Mark::Append));
}

#[test]
fn an_original_over_256kb_is_unreadable_in_the_list_but_item_read_shows_the_other_parts() {
    let r = CustomRoot::new("custom-toolarge-source");
    r.write_source("agents/harness-big.md", &"a".repeat(300 * 1024));
    r.write_custom("agents/harness-big.append.md", "- 덧붙임\n");
    assert_eq!(
        unreadable(&list(&r), "agent:harness-big"),
        UnreadableReason::TooLarge
    );
    let d = detail(&r, "agent:harness-big");
    assert_eq!(d.origin_text, TextPart::TooLarge);
    assert_eq!(
        d.append_text,
        TextPart::Text {
            text: "- 덧붙임\n".into()
        }
    );
    assert_eq!(d.replace_text, TextPart::Absent);
}

// ───────────────────────────── 값 ─────────────────────────────

#[test]
fn values_go_original_to_mine_to_original_and_the_file_comes_and_goes() {
    let r = CustomRoot::new("custom-values");
    let result = save_values(
        &r,
        "agent:harness-builder-ui",
        &values(Some("opus"), Some("high")),
    )
    .unwrap();
    assert!(saved(&result) && result.changed, "{result:?}");
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: opus\neffort: high\n"
    );
    let ui = info(&list(&r), "agent:harness-builder-ui");
    assert_eq!(
        (ui.my_model.as_deref(), ui.my_effort.as_deref()),
        (Some("opus"), Some("high"))
    );
    assert_eq!(
        (ui.current_model.as_deref(), ui.current_effort.as_deref()),
        (Some("opus"), Some("high"))
    );
    assert_eq!(ui.model.as_deref(), Some("sonnet"), "원본 값은 그대로");
    assert_eq!(ui.marks, [Mark::Values]);
    // 같은 값을 다시 저장해도 바뀌지 않는다
    assert!(
        !save_values(
            &r,
            "agent:harness-builder-ui",
            &values(Some("opus"), Some("high"))
        )
        .unwrap()
        .changed
    );
    // 한 키만 원본으로
    save_values(&r, "agent:harness-builder-ui", &values(None, Some("high"))).unwrap();
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "effort: high\n"
    );
    // 둘 다 원본으로 — 파일이 사라진다
    let result = save_values(&r, "agent:harness-builder-ui", &Values::default()).unwrap();
    assert!(saved(&result) && result.changed);
    assert!(!r.custom_exists("agents/harness-builder-ui.values.yml"));
    assert!(info(&list(&r), "agent:harness-builder-ui").marks.is_empty());
    // 이미 없는데 지우라는 것은 아무 일도 아니다
    assert!(
        !save_values(&r, "agent:harness-builder-ui", &Values::default())
            .unwrap()
            .changed
    );
}

#[test]
fn values_outside_the_lists_are_refused_and_nothing_is_written() {
    let r = CustomRoot::new("custom-values-bad");
    for (model, effort) in [
        ("banana", None),
        ("OPUS", None),
        ("", None),
        ("opus\nname: x", None),
    ] {
        let error =
            save_values(&r, "agent:harness-builder-ui", &values(Some(model), effort)).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{model:?}");
    }
    for effort in ["xhigh", "max", "HIGH", "inherit"] {
        let error =
            save_values(&r, "agent:harness-builder-ui", &values(None, Some(effort))).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{effort:?}");
    }
    let error = save_values(&r, "main", &values(Some("gpt"), None)).unwrap_err();
    assert_eq!(error.kind(), "invalid_input");
    assert!(
        !r.custom.exists(),
        "거절은 아무것도 만들지 않는다 (기록도 시작하지 않는다)"
    );
}

#[test]
fn a_hand_written_values_file_with_comments_crlf_and_odd_order_is_read_and_kept() {
    let r = CustomRoot::new("custom-values-hand");
    r.write_custom(
        "agents/harness-builder-ui.values.yml",
        "# 내가 적은 메모\r\neffort: high\r\ncolor: red\r\nmodel: haiku\r\n",
    );
    let ui = info(&list(&r), "agent:harness-builder-ui");
    assert_eq!(
        (ui.my_model.as_deref(), ui.my_effort.as_deref()),
        (Some("haiku"), Some("high"))
    );
    // 모델만 바꾸면 메모 · 다른 키 · 순서가 그대로고 LF 로 쓰인다
    save_values(
        &r,
        "agent:harness-builder-ui",
        &values(Some("opus"), Some("high")),
    )
    .unwrap();
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "# 내가 적은 메모\neffort: high\ncolor: red\nmodel: opus\n"
    );
    // 목록에 없는 옛 값(`xhigh`)이 이미 들어 있으면 다른 값만 바꿀 때 그대로 돌려보내도 거절하지 않는다
    r.write_custom("agents/harness-designer.values.yml", "effort: xhigh\n");
    save_values(
        &r,
        "agent:harness-designer",
        &values(Some("haiku"), Some("xhigh")),
    )
    .unwrap();
    assert_eq!(
        r.read_custom("agents/harness-designer.values.yml"),
        "effort: xhigh\nmodel: haiku\n"
    );
}

#[test]
fn a_values_file_the_install_script_would_refuse_is_unreadable_and_not_overwritten() {
    let r = CustomRoot::new("custom-values-broken");
    r.write_custom("agents/harness-builder-ui.values.yml", "model opus\n");
    let list = list(&r);
    assert_eq!(
        unreadable(&list, "agent:harness-builder-ui"),
        UnreadableReason::BadValues
    );
    let result = save_values(&r, "agent:harness-builder-ui", &values(Some("opus"), None)).unwrap();
    assert_eq!(refused(&result), "bad_values");
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model opus\n"
    );
    // 다른 항목은 영향이 없다
    assert!(saved(
        &save_values(&r, "agent:harness-designer", &values(Some("haiku"), None)).unwrap()
    ));
}

#[test]
fn skills_take_values_too() {
    let r = CustomRoot::new("custom-values-skill");
    save_values(&r, "skill:web-full", &values(Some("haiku"), Some("low"))).unwrap();
    assert_eq!(
        r.read_custom("skills/web-full/SKILL.values.yml"),
        "model: haiku\neffort: low\n"
    );
    save_values(&r, "skill:web-full", &Values::default()).unwrap();
    assert!(!r.custom_exists("skills/web-full/SKILL.values.yml"));
    assert!(
        !r.custom_exists("skills/web-full"),
        "비게 된 스킬 폴더는 남기지 않는다"
    );
}

#[test]
fn values_of_something_that_does_not_exist_are_refused_as_not_found() {
    let r = CustomRoot::new("custom-values-nothing");
    let result = save_values(&r, "agent:no-such-agent", &values(Some("opus"), None)).unwrap();
    assert_eq!(refused(&result), "not_found");
}

// ───────────────────────────── 오케스트레이터 ─────────────────────────────

#[test]
fn main_values_keep_unknown_keys_and_order_and_only_planner_changes() {
    let r = CustomRoot::new("custom-main-keep");
    // 원본의 설정 (개발자가 둔 것) — 모르는 키 · 순서 · 들여쓰기 4칸
    r.write_source(
        "config.local.json",
        "{\n    \"zeta\": [1, 2, {\"k\": \"v\"}],\n    \"planner\": {\n        \"model\": \"sonnet\",\n        \"effort\": \"medium\"\n    },\n    \"alpha\": \"한글\"\n}\n",
    );
    let before = info(&list(&r), "main");
    assert_eq!(before.model.as_deref(), Some("opus"), "원본 값 = 예시");
    assert_eq!(
        before.current_model.as_deref(),
        Some("sonnet"),
        "지금 값 = 원본의 설정"
    );
    assert_eq!(
        (before.my_model.clone(), before.my_effort.clone()),
        (None, None)
    );

    let result = save_values(&r, "main", &values(Some("haiku"), Some("medium"))).unwrap();
    assert!(saved(&result) && result.changed, "{result:?}");
    assert_eq!(
        r.read_custom("config.local.json"),
        "{\n    \"zeta\": [1, 2, {\"k\": \"v\"}],\n    \"planner\": {\n        \"model\": \"haiku\",\n        \"effort\": \"medium\"\n    },\n    \"alpha\": \"한글\"\n}\n"
    );
    let after = info(&list(&r), "main");
    assert_eq!(after.my_model.as_deref(), Some("haiku"));
    assert_eq!(
        after.my_effort.as_deref(),
        Some("medium"),
        "원본(high)과 다르므로 내 값"
    );
    assert_eq!(after.marks, [Mark::Values]);
    assert_eq!(after.current_model.as_deref(), Some("haiku"));
}

#[test]
fn main_values_back_to_the_original_write_the_example_values() {
    let r = CustomRoot::new("custom-main-origin");
    save_values(&r, "main", &values(Some("haiku"), Some("low"))).unwrap();
    // 바탕은 처음 찾은 설정 — 없으면 예시 (언어 · 에이전트 키가 그대로 들어온다)
    let text = r.read_custom("config.local.json");
    assert!(
        text.contains("\"language\": \"ko\"") && text.contains("\"ui\": \"harness-builder-ui\""),
        "{text}"
    );
    save_values(&r, "main", &Values::default()).unwrap();
    let main = info(&list(&r), "main");
    assert_eq!((main.my_model, main.my_effort), (None, None));
    assert_eq!(main.current_model.as_deref(), Some("opus"));
    assert!(main.marks.is_empty());
    let parsed: serde_json::Value =
        serde_json::from_str(&r.read_custom("config.local.json")).unwrap();
    assert_eq!(
        parsed["planner"],
        serde_json::json!({"model": "opus", "effort": "high"})
    );
}

#[test]
fn main_values_that_already_hold_do_not_create_the_custom_config() {
    let r = CustomRoot::new("custom-main-noop");
    let result = save_values(&r, "main", &Values::default()).unwrap();
    assert!(saved(&result) && !result.changed);
    let result = save_values(&r, "main", &values(Some("opus"), Some("high"))).unwrap();
    assert!(!result.changed);
    assert!(!r.custom.exists());
}

#[test]
fn the_current_planner_comes_from_custom_then_source_then_installed_then_the_example() {
    let r = CustomRoot::new("custom-main-order");
    let planner =
        |model: &str| format!("{{\"planner\": {{\"model\": \"{model}\", \"effort\": \"low\"}}}}\n");
    let current = |r: &CustomRoot| info(&list(r), "main").current_model;
    assert_eq!(current(&r).as_deref(), Some("opus"), "예시");
    r.write_claude("harness/config.local.json", &planner("haiku"));
    assert_eq!(current(&r).as_deref(), Some("haiku"), "설치본");
    r.write_source("config.local.json", &planner("sonnet"));
    assert_eq!(current(&r).as_deref(), Some("sonnet"), "원본");
    r.write_custom("config.local.json", &planner("opus"));
    let list_now = list(&r);
    assert_eq!(
        info(&list_now, "main").current_model.as_deref(),
        Some("opus"),
        "내 수정"
    );
    // 내 값은 예시와 다른 것만 (예시도 opus)
    assert_eq!(info(&list_now, "main").my_model, None);
    assert_eq!(info(&list_now, "main").my_effort.as_deref(), Some("low"));
}

#[test]
fn a_broken_custom_config_makes_main_unreadable_and_is_not_overwritten() {
    let r = CustomRoot::new("custom-main-broken");
    r.write_custom("config.local.json", "{ not json");
    let list = list(&r);
    assert_eq!(unreadable(&list, "main"), UnreadableReason::BadConfig);
    let result = save_values(&r, "main", &values(Some("haiku"), None)).unwrap();
    assert_eq!(refused(&result), "bad_config");
    assert_eq!(r.read_custom("config.local.json"), "{ not json");
}

#[test]
fn a_crlf_config_is_rewritten_with_lf_and_a_bom_is_dropped() {
    let r = CustomRoot::new("custom-main-crlf");
    r.write_custom(
        "config.local.json",
        "\u{feff}{\r\n  \"planner\": {\r\n    \"model\": \"opus\",\r\n    \"effort\": \"high\"\r\n  }\r\n}\r\n",
    );
    save_values(&r, "main", &values(Some("sonnet"), Some("high"))).unwrap();
    let bytes = fs::read(r.custom.join("config.local.json")).unwrap();
    assert!(!bytes.contains(&b'\r') && !bytes.starts_with(&[0xef, 0xbb, 0xbf]));
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        "{\n  \"planner\": {\n    \"model\": \"sonnet\",\n    \"effort\": \"high\"\n  }\n}\n"
    );
}

// ───────────────────────────── 덧붙임 ─────────────────────────────

#[test]
fn append_saves_as_lf_and_blank_text_removes_the_file() {
    let r = CustomRoot::new("custom-append");
    let result = save_append(&r, "agent:harness-builder-ui", "- 첫째\r\n- 둘째\r\n");
    assert!(saved(&result) && result.changed);
    assert_eq!(
        fs::read(r.custom.join("agents/harness-builder-ui.append.md")).unwrap(),
        "- 첫째\n- 둘째\n".as_bytes()
    );
    let ui = info(&list(&r), "agent:harness-builder-ui");
    assert_eq!(ui.marks, [Mark::Append]);
    assert_eq!(
        detail(&r, "agent:harness-builder-ui").append_text,
        TextPart::Text {
            text: "- 첫째\n- 둘째\n".into()
        }
    );
    // 같은 글은 바뀌지 않는다
    assert!(!save_append(&r, "agent:harness-builder-ui", "- 첫째\n- 둘째\n").changed);
    // 공백뿐인 글 = 지움
    let result = save_append(&r, "agent:harness-builder-ui", " \n\t\r\n ");
    assert!(saved(&result) && result.changed);
    assert!(!r.custom_exists("agents/harness-builder-ui.append.md"));
    assert!(!save_append(&r, "agent:harness-builder-ui", "").changed);
}

#[test]
fn append_for_a_skill_goes_next_to_its_skill_file_and_the_empty_folder_goes_away() {
    let r = CustomRoot::new("custom-append-skill");
    save_append(&r, "skill:web-full", "- 배포는 사용자가 한다\n");
    assert_eq!(
        r.read_custom("skills/web-full/SKILL.append.md"),
        "- 배포는 사용자가 한다\n"
    );
    save_append(&r, "skill:web-full", "");
    assert!(!r.custom_exists("skills/web-full"));
}

#[test]
fn append_has_limits_main_and_mine_and_size() {
    let r = CustomRoot::new("custom-append-limits");
    assert_eq!(refused(&save_append(&r, "main", "x")), "not_supported");
    assert_eq!(refused(&save_append(&r, "agent:nothing", "x")), "not_found");
    create(&r, &new_item("agent", "translator", "번역", None, None)).unwrap();
    assert_eq!(
        refused(&save_append(&r, "agent:translator", "x")),
        "not_supported",
        "내가 만든 것은 글을 직접 고친다"
    );
    let big = "a".repeat(300 * 1024);
    assert_eq!(
        refused(&save_append(&r, "agent:harness-designer", &big)),
        "too_large"
    );
    assert!(!r.custom_exists("agents/harness-designer.append.md"));
}

// ───────────────────────────── 통째 ─────────────────────────────

#[test]
fn replace_start_copies_the_source_and_records_the_hash_of_the_lf_text() {
    let r = CustomRoot::new("custom-replace");
    // CRLF 원본 — 해시는 LF 로 맞춘 글(`a\nb\n`)의 sha256
    fs::write(
        r.source.join("agents").join("harness-crlf.md"),
        "---\r\nname: harness-crlf\r\ndescription: d\r\n---\r\na\r\nb\r\n",
    )
    .unwrap();
    let result = replace_start(&r, "agent:harness-crlf");
    assert!(saved(&result) && result.changed, "{result:?}");
    assert_eq!(
        r.read_custom("agents/harness-crlf.md"),
        "---\nname: harness-crlf\ndescription: d\n---\na\nb\n"
    );
    let expected = {
        // 같은 규칙으로 따로 낸 값 — 줄바꿈을 LF 로 맞춘 글의 sha256 (`sha256sum` 으로 확인한 값)
        let lf = "---\nname: harness-crlf\ndescription: d\n---\na\nb\n";
        nyanitor_lib::custom::hash::sha256_hex(lf.as_bytes())
    };
    assert_eq!(
        r.read_custom("agents/harness-crlf.md.origin"),
        format!("{expected}\n")
    );
    let item = info(&list(&r), "agent:harness-crlf");
    assert_eq!(item.marks, [Mark::Replace]);
    assert_eq!(item.origin_changed, Some(false));
    let d = detail(&r, "agent:harness-crlf");
    assert!(
        matches!(d.replace_text, TextPart::Text { .. })
            && matches!(d.origin_text, TextPart::Text { .. })
    );
}

#[test]
fn the_known_hash_of_a_simple_file_matches_the_standard_value() {
    let r = CustomRoot::new("custom-replace-known");
    r.write_source("agents/harness-hash.md", "a\r\nb\r\n");
    // 앞머리 없는 원본이라 목록에는 못 읽지만 통째 시작의 해시 규칙은 원본 바이트로 낸다
    let ctx = r.ctx();
    let env = Env::new(&ctx);
    let parts = items::load(
        &env,
        &nyanitor_lib::custom::id::ItemId::agent("harness-hash"),
    );
    // `printf 'a\nb\n' | sha256sum`
    assert_eq!(
        parts.source_hash.as_deref(),
        Some("911169ddaaf146aff539f58c26c489af3b892dff0fe283c1c264c65ae5aa59a2")
    );
}

#[test]
fn replace_start_refuses_when_there_is_no_source_or_it_is_already_replaced() {
    let r = CustomRoot::new("custom-replace-refuse");
    assert_eq!(refused(&replace_start(&r, "agent:nothing")), "not_found");
    assert_eq!(refused(&replace_start(&r, "main")), "not_supported");
    assert!(saved(&replace_start(&r, "skill:web-full")));
    assert_eq!(
        refused(&replace_start(&r, "skill:web-full")),
        "already_replaced"
    );
    assert!(r.custom_exists("skills/web-full/SKILL.md.origin"));
}

#[test]
fn original_changed_is_true_when_the_hash_differs_or_the_source_is_gone_false_when_kept_and_null_without_origin()
 {
    let r = CustomRoot::new("custom-origin-changed");
    replace_start(&r, "agent:harness-designer");
    assert_eq!(
        info(&list(&r), "agent:harness-designer").origin_changed,
        Some(false)
    );
    // 원본이 바뀌었다
    r.write_source(
        "agents/harness-designer.md",
        &SOURCE_AGENT_DESIGNER.replace("디자이너다", "아트 디렉터다"),
    );
    let changed = list(&r);
    assert_eq!(
        info(&changed, "agent:harness-designer").origin_changed,
        Some(true)
    );
    // CRLF 로 줄바꿈만 바뀐 원본은 바뀐 것이 아니다 (LF 로 맞춘 해시)
    r.write_source(
        "agents/harness-designer.md",
        &SOURCE_AGENT_DESIGNER.replace('\n', "\r\n"),
    );
    assert_eq!(
        info(&list(&r), "agent:harness-designer").origin_changed,
        Some(false)
    );
    // 원본에서 사라졌다 — 새 파일처럼 남지만 `true`
    fs::remove_file(r.source.join("agents").join("harness-designer.md")).unwrap();
    let gone = list(&r);
    let item = info(&gone, "agent:harness-designer");
    assert_eq!(item.origin_changed, Some(true));
    assert_eq!(item.marks, [Mark::Mine]);
    assert!(detail(&r, "agent:harness-designer").origin_gone);
    // `.origin` 이 없으면 알 수 없음
    fs::remove_file(r.custom.join("agents/harness-designer.md.origin")).unwrap();
    assert_eq!(
        info(&list(&r), "agent:harness-designer").origin_changed,
        None
    );
}

#[test]
fn keeping_mine_rewrites_the_origin_hash_and_a_gone_source_just_drops_the_origin_file() {
    let r = CustomRoot::new("custom-origin-keep");
    replace_start(&r, "agent:harness-designer");
    let old = r.read_custom("agents/harness-designer.md.origin");
    r.write_source(
        "agents/harness-designer.md",
        &SOURCE_AGENT_DESIGNER.replace("디자이너다", "아트 디렉터다"),
    );
    assert_eq!(
        info(&list(&r), "agent:harness-designer").origin_changed,
        Some(true)
    );
    let result = origin_keep(&r, "agent:harness-designer");
    assert!(saved(&result) && result.changed);
    assert_ne!(r.read_custom("agents/harness-designer.md.origin"), old);
    assert_eq!(
        info(&list(&r), "agent:harness-designer").origin_changed,
        Some(false)
    );
    assert!(
        !origin_keep(&r, "agent:harness-designer").changed,
        "이미 같다"
    );
    // 내 글은 그대로
    assert!(
        r.read_custom("agents/harness-designer.md")
            .contains("디자이너다")
    );

    // 원본에서 사라졌다 → `.origin` 만 지운다
    fs::remove_file(r.source.join("agents").join("harness-designer.md")).unwrap();
    let result = origin_keep(&r, "agent:harness-designer");
    assert!(saved(&result) && result.changed);
    assert!(!r.custom_exists("agents/harness-designer.md.origin"));
    assert!(r.custom_exists("agents/harness-designer.md"));
    assert_eq!(
        info(&list(&r), "agent:harness-designer").origin_changed,
        None
    );
    assert_eq!(refused(&origin_keep(&r, "agent:nothing")), "not_replaced");
}

#[test]
fn replace_stop_goes_back_to_the_original_but_keeps_values_and_append() {
    let r = CustomRoot::new("custom-replace-stop");
    save_values(&r, "agent:harness-designer", &values(Some("haiku"), None)).unwrap();
    save_append(&r, "agent:harness-designer", "- 덧붙임\n");
    replace_start(&r, "agent:harness-designer");
    assert_eq!(
        info(&list(&r), "agent:harness-designer").marks,
        [Mark::Values, Mark::Append, Mark::Replace]
    );
    let result = replace_stop(&r, "agent:harness-designer");
    assert!(saved(&result) && result.changed);
    assert!(!r.custom_exists("agents/harness-designer.md"));
    assert!(!r.custom_exists("agents/harness-designer.md.origin"));
    assert!(r.custom_exists("agents/harness-designer.values.yml"));
    assert!(r.custom_exists("agents/harness-designer.append.md"));
    assert_eq!(
        info(&list(&r), "agent:harness-designer").marks,
        [Mark::Values, Mark::Append]
    );
    assert_eq!(
        refused(&replace_stop(&r, "agent:harness-designer")),
        "not_replaced"
    );
    // 원본에서 사라진 것은 "원본으로" 가 없다
    replace_start(&r, "agent:harness-designer");
    fs::remove_file(r.source.join("agents").join("harness-designer.md")).unwrap();
    assert_eq!(
        refused(&replace_stop(&r, "agent:harness-designer")),
        "no_origin"
    );
}

#[test]
fn saving_replaced_text_checks_the_agent_template_and_only_works_on_replaced_or_mine() {
    let r = CustomRoot::new("custom-replace-save");
    assert_eq!(
        refused(&save_text(&r, "agent:harness-designer", "x")),
        "not_replaced"
    );
    replace_start(&r, "agent:harness-designer");
    let good = "---\nname: harness-designer\ndescription: 새 소개\nmodel: opus\n---\n\n내 본문\r\n";
    let result = save_text(&r, "agent:harness-designer", good);
    assert!(saved(&result) && result.changed);
    assert_eq!(
        r.read_custom("agents/harness-designer.md"),
        good.replace("\r\n", "\n")
    );
    assert!(
        r.read_custom("agents/harness-designer.md.origin")
            .trim()
            .len()
            == 64,
        ".origin 은 그대로"
    );
    assert!(!save_text(&r, "agent:harness-designer", good).changed);
    // 둘째 줄 `name` 이 다르다 · 순서가 바뀌었다 · `hooks:` 가 있다 · 앞머리가 없다
    for bad in [
        "---\nname: other\ndescription: d\n---\n",
        "---\ndescription: d\nname: harness-designer\n---\n",
        "---\nname: harness-designer\nhooks:\n  x: y\n---\n",
        "앞머리 없음",
    ] {
        let result = save_text(&r, "agent:harness-designer", bad);
        assert!(
            matches!(refused(&result), "invalid_agent" | "bad_frontmatter"),
            "{bad:?}: {result:?}"
        );
        assert_eq!(
            r.read_custom("agents/harness-designer.md"),
            good.replace("\r\n", "\n"),
            "거절하면 글이 그대로다"
        );
    }
    // 스킬은 `name` 이 있으면 폴더 이름과 같아야 한다
    replace_start(&r, "skill:web-full");
    assert_eq!(
        refused(&save_text(
            &r,
            "skill:web-full",
            "---\nname: other\ndescription: d\n---\n"
        )),
        "invalid_agent"
    );
    assert!(saved(&save_text(
        &r,
        "skill:web-full",
        "---\nname: web-full\ndescription: 새 소개\n---\n새 글\n"
    )));
    assert_eq!(
        refused(&save_text(
            &r,
            "agent:harness-designer",
            &"a".repeat(300 * 1024)
        )),
        "too_large"
    );
}

// ───────────────────────────── 새로 만들기 · 지우기 ─────────────────────────────

#[test]
fn a_new_agent_is_one_template_file_that_keeps_the_install_scripts_rules() {
    let r = CustomRoot::new("custom-new-agent");
    let result = create(
        &r,
        &new_item(
            "agent",
            "translator",
            "문서를 영어로 옮긴다",
            Some("sonnet"),
            Some("medium"),
        ),
    )
    .unwrap();
    assert!(
        saved(&result) && result.changed && !result.not_ours,
        "{result:?}"
    );
    let text = r.read_custom("agents/translator.md");
    assert!(text.starts_with("---\nname: translator\ndescription: 문서를 영어로 옮긴다\nmodel: sonnet\neffort: medium\n---\n"), "{text}");
    assert!(!text.contains("hooks:") && !text.contains('\r'));
    // 설치 스크립트의 틀 검사 — 둘째 줄 `name: <이름>`
    assert_eq!(text.lines().nth(1), Some("name: translator"));
    let list = list(&r);
    let item = info(&list, "agent:translator");
    assert_eq!(item.marks, [Mark::Mine]);
    assert_eq!(item.model.as_deref(), Some("sonnet"));
    assert_eq!(item.description.as_deref(), Some("문서를 영어로 옮긴다"));
}

#[test]
fn a_new_skill_is_a_folder_with_a_skill_file_and_delete_removes_the_whole_folder() {
    let r = CustomRoot::new("custom-new-skill");
    let result = create(
        &r,
        &new_item("skill", "translate-docs", "문서 번역", None, None),
    )
    .unwrap();
    assert!(saved(&result));
    let text = r.read_custom("skills/translate-docs/SKILL.md");
    assert!(
        text.starts_with("---\nname: translate-docs\ndescription: 문서 번역\n---\n"),
        "{text}"
    );
    assert!(!text.contains("model:"));
    // 폴더 안의 다른 파일도 같이 지운다
    r.write_custom("skills/translate-docs/notes/extra.md", "더 있다\n");
    let result = delete_mine(&r, "skill:translate-docs");
    assert!(saved(&result) && result.changed, "{result:?}");
    assert!(!r.custom_exists("skills/translate-docs"));
    assert!(matches!(
        read(&r, "skill:translate-docs").unwrap(),
        ItemRead::NotFound
    ));
}

#[test]
fn a_new_item_is_refused_for_an_original_name_or_a_name_already_in_my_changes() {
    let r = CustomRoot::new("custom-new-refuse");
    assert_eq!(
        refused(&create(&r, &new_item("agent", "harness-designer", "x", None, None)).unwrap()),
        "name_in_source"
    );
    assert_eq!(
        refused(&create(&r, &new_item("skill", "web-full", "x", None, None)).unwrap()),
        "name_in_source"
    );
    assert!(saved(
        &create(&r, &new_item("agent", "translator", "x", None, None)).unwrap()
    ));
    assert_eq!(
        refused(&create(&r, &new_item("agent", "translator", "y", None, None)).unwrap()),
        "name_taken"
    );
    // 값 파일만 남은 이름도 이미 있는 것으로 본다
    r.write_custom("agents/orphan.values.yml", "model: opus\n");
    assert_eq!(
        refused(&create(&r, &new_item("agent", "orphan", "x", None, None)).unwrap()),
        "name_taken"
    );
    // 같은 이름이라도 에이전트와 스킬은 다르다
    assert!(saved(
        &create(&r, &new_item("skill", "translator", "x", None, None)).unwrap()
    ));
    // 원본을 아직 안 받았으면 이름이 겹치는지 모른다
    let empty = CustomRoot::empty("custom-new-nosource");
    assert_eq!(
        refused(&create(&empty, &new_item("agent", "a", "x", None, None)).unwrap()),
        "no_source"
    );
}

#[test]
fn a_new_item_with_a_bad_shape_is_an_invalid_input_error() {
    let r = CustomRoot::new("custom-new-badshape");
    let too_long = "a".repeat(301);
    for (kind, name, description, model, effort) in [
        ("agent", "Bad", "x", None, None),
        ("agent", "main", "x", None, None),
        ("agent", "_common", "x", None, None),
        ("agent", "a/b", "x", None, None),
        ("agent", "..", "x", None, None),
        ("agent", "", "x", None, None),
        ("agent", "x", "", None, None),
        ("agent", "x", "   ", None, None),
        ("agent", "x", "두 줄\n입니다", None, None),
        ("agent", "x", too_long.as_str(), None, None),
        ("agent", "x", "ok", Some("banana"), None),
        ("agent", "x", "ok", None, Some("max")),
        ("team", "x", "ok", None, None),
        ("main", "x", "ok", None, None),
    ] {
        let error = create(&r, &new_item(kind, name, description, model, effort)).unwrap_err();
        assert_eq!(
            error.kind(),
            "invalid_input",
            "{kind} {name:?} {description:?}"
        );
    }
    let long_name = format!("a{}", "b".repeat(64));
    assert!(
        create(&r, &new_item("agent", &long_name, "x", None, None)).is_err(),
        "65글자"
    );
    assert!(!r.custom.exists(), "거절은 아무것도 만들지 않는다");
}

#[test]
fn a_description_with_a_colon_is_quoted_so_the_front_still_reads() {
    let r = CustomRoot::new("custom-new-quote");
    create(
        &r,
        &new_item("agent", "colon", "문서: 번역 # 메모", None, None),
    )
    .unwrap();
    let list = list(&r);
    assert_eq!(
        info(&list, "agent:colon").description.as_deref(),
        Some("문서: 번역 # 메모")
    );
}

#[test]
fn a_users_own_file_in_the_claude_folder_is_reported_but_the_item_is_still_made() {
    let r = CustomRoot::new("custom-new-notours");
    r.write_claude(
        "agents/translator.md",
        "---\nname: translator\n---\n내 파일\n",
    );
    let result = create(&r, &new_item("agent", "translator", "x", None, None)).unwrap();
    assert!(saved(&result) && result.not_ours, "{result:?}");
    assert!(r.custom_exists("agents/translator.md"));
    // 스킬 폴더도 같다
    r.write_claude("skills/mine-skill/SKILL.md", "내 스킬\n");
    assert!(
        create(&r, &new_item("skill", "mine-skill", "x", None, None))
            .unwrap()
            .not_ours
    );
    // 설치가 적어 둔 우리 것이면 알리지 않는다 (`.harness-installed`)
    r.write_claude("agents/ours.md", "x\n");
    r.write_claude(".harness-installed", "agent ours.md\nskill other\n");
    assert!(
        !create(&r, &new_item("agent", "ours", "x", None, None))
            .unwrap()
            .not_ours
    );
    // 없으면 알릴 것이 없다
    assert!(
        !create(&r, &new_item("agent", "fresh", "x", None, None))
            .unwrap()
            .not_ours
    );
}

#[test]
fn what_i_made_can_be_edited_as_text_its_values_go_to_its_own_front_and_it_can_be_deleted() {
    let r = CustomRoot::new("custom-mine");
    create(
        &r,
        &new_item("agent", "translator", "번역", Some("sonnet"), None),
    )
    .unwrap();
    // 값은 그 파일의 앞머리 줄을 고친다 (값 파일은 고칠 원본이 없어 설치가 거절한다)
    let result = save_values(&r, "agent:translator", &values(Some("opus"), Some("low"))).unwrap();
    assert!(saved(&result) && result.changed, "{result:?}");
    assert!(!r.custom_exists("agents/translator.values.yml"));
    assert_eq!(
        r.read_custom("agents/translator.md")
            .lines()
            .take(6)
            .collect::<Vec<_>>(),
        [
            "---",
            "name: translator",
            "description: 번역",
            "model: opus",
            "effort: low",
            "---"
        ]
    );
    let item = info(&list(&r), "agent:translator");
    assert_eq!(
        (item.model.as_deref(), item.effort.as_deref()),
        (Some("opus"), Some("low"))
    );
    assert_eq!((item.my_model, item.my_effort), (None, None));
    // 원본 값으로 = 그 줄을 지운다
    save_values(&r, "agent:translator", &Values::default()).unwrap();
    assert!(!r.read_custom("agents/translator.md").contains("model:"));
    // 글 저장
    let text = "---\nname: translator\ndescription: 번역가\n---\n\n새 본문\n";
    assert!(saved(&save_text(&r, "agent:translator", text)));
    assert_eq!(r.read_custom("agents/translator.md"), text);
    assert_eq!(
        refused(&save_text(&r, "agent:translator", "---\nname: x\n---\n")),
        "invalid_agent"
    );
    // 지우기 — 원본에 있는 것은 못 지운다
    assert_eq!(
        refused(&delete_mine(&r, "agent:harness-designer")),
        "not_mine"
    );
    assert!(saved(&delete_mine(&r, "agent:translator")));
    assert!(!r.custom_exists("agents/translator.md"));
    assert_eq!(refused(&delete_mine(&r, "agent:translator")), "not_found");
}

#[test]
fn deleting_a_gone_replaced_file_removes_it_with_its_origin_and_values() {
    let r = CustomRoot::new("custom-delete-gone");
    save_values(&r, "agent:harness-designer", &values(Some("haiku"), None)).unwrap();
    replace_start(&r, "agent:harness-designer");
    fs::remove_file(r.source.join("agents").join("harness-designer.md")).unwrap();
    assert!(saved(&delete_mine(&r, "agent:harness-designer")));
    for rel in [
        "agents/harness-designer.md",
        "agents/harness-designer.md.origin",
        "agents/harness-designer.values.yml",
    ] {
        assert!(!r.custom_exists(rel), "{rel}");
    }
}

#[test]
fn a_values_file_left_without_its_source_is_listed_as_unreadable_target_gone() {
    let r = CustomRoot::new("custom-target-gone");
    r.write_custom("agents/vanished.values.yml", "model: opus\n");
    assert_eq!(
        unreadable(&list(&r), "agent:vanished"),
        UnreadableReason::TargetGone
    );
}

// ───────────────────────────── 경로 안전 · 형식 ─────────────────────────────

#[test]
fn a_linked_agents_folder_inside_custom_is_never_written_through() {
    let r = CustomRoot::new("custom-link");
    let outside = unique_dir("custom-link-outside");
    fs::write(
        outside.join("harness-builder-ui.values.yml"),
        "model: haiku\n",
    )
    .unwrap();
    fs::create_dir_all(&r.custom).unwrap();
    assert!(
        make_dir_link(&r.custom.join("agents"), &outside),
        "이 PC 에서 폴더 링크를 만들 수 없다"
    );
    for result in [
        save_values(&r, "agent:harness-builder-ui", &values(Some("opus"), None)).unwrap(),
        save_append(&r, "agent:harness-builder-ui", "x"),
        replace_start(&r, "agent:harness-builder-ui"),
        create(&r, &new_item("agent", "linked", "x", None, None)).unwrap(),
    ] {
        assert_eq!(refused(&result), "link_in_path", "{result:?}");
    }
    assert_eq!(
        fs::read_to_string(outside.join("harness-builder-ui.values.yml")).unwrap(),
        "model: haiku\n",
        "링크 밖은 그대로"
    );
    assert_eq!(
        fs::read_dir(&outside).unwrap().count(),
        1,
        "링크 밖에 새 파일이 생기지 않았다"
    );
    // 그 폴더를 지나야 읽는 항목은 읽을 수 없음
    let list = list(&r);
    assert_eq!(
        unreadable(&list, "agent:harness-builder-ui"),
        UnreadableReason::LinkInCustom
    );
    // 스킬 쪽은 링크가 아니라 쓸 수 있다
    assert!(saved(
        &save_values(&r, "skill:web-full", &values(Some("opus"), None)).unwrap()
    ));
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn a_linked_custom_folder_itself_is_not_written_through() {
    let r = CustomRoot::new("custom-link-root");
    let outside = unique_dir("custom-link-root-outside");
    assert!(make_dir_link(&r.custom, &outside));
    let result = save_values(&r, "agent:harness-builder-ui", &values(Some("opus"), None)).unwrap();
    assert_eq!(refused(&result), "link_in_path");
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&outside);
}

#[test]
fn files_are_written_without_bom_and_with_lf_and_leave_no_temp_file() {
    let r = CustomRoot::new("custom-bytes");
    save_values(
        &r,
        "agent:harness-builder-ui",
        &values(Some("opus"), Some("low")),
    )
    .unwrap();
    save_append(&r, "agent:harness-builder-ui", "\u{feff}가\r\n나\r\n");
    create(&r, &new_item("agent", "tr", "번역", None, None)).unwrap();
    for rel in [
        "agents/harness-builder-ui.values.yml",
        "agents/harness-builder-ui.append.md",
        "agents/tr.md",
    ] {
        let bytes = fs::read(r.custom.join(rel)).unwrap();
        assert!(!bytes.contains(&b'\r'), "{rel}: CR");
        assert!(!bytes.starts_with(&[0xef, 0xbb, 0xbf]), "{rel}: BOM");
        assert!(String::from_utf8(bytes).is_ok());
    }
    let temp: Vec<_> = walk(&r.custom)
        .into_iter()
        .filter(|p| p.ends_with(".tmp"))
        .collect();
    assert!(temp.is_empty(), "{temp:?}");
}

fn walk(dir: &std::path::Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path.display().to_string());
        }
    }
    out
}

#[test]
fn the_ipc_values_input_refuses_unknown_fields_and_takes_missing_ones_as_original() {
    let ok: Values = serde_json::from_str("{\"model\": \"opus\"}").unwrap();
    assert_eq!((ok.model.as_deref(), ok.effort), (Some("opus"), None));
    assert!(serde_json::from_str::<Values>("{\"model\": \"opus\", \"path\": \"/x\"}").is_err());
    let item: Result<NewItem, _> = serde_json::from_str(
        "{\"kind\":\"agent\",\"name\":\"a\",\"description\":\"d\",\"path\":\"/etc\"}",
    );
    assert!(item.is_err(), "새 항목 요청도 모르는 필드를 거절한다");
    let item: NewItem =
        serde_json::from_str("{\"kind\":\"agent\",\"name\":\"a\",\"description\":\"d\"}").unwrap();
    assert_eq!((item.model, item.effort), (None, None));
}
