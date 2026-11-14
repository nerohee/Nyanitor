//! 내 수정 충돌 경우 시험 (P9-06, D-51 · D-52) — 원본(하네스)과 내 수정이 **시간 순서로 부딪히는** 흐름을 여러 단계 이어서 본다.
//! 하나씩 따로 보는 경우는 `custom_store` · `custom_apply` · `custom_history` · `custom_labels` 에 있다 (겹치지 않게 뺐다).
//!
//! 가짜 설치 스크립트(`tests/fixtures/custom/install.*`)는 기본으로는 아무것도 설치하지 않는다. 이 파일은 스크립트 옆에 표시 파일을 두어 켠다:
//! `mirror` (설치가 `~/.claude/agents` 를 원본 + 내 수정으로 다시 만든다), `strict` (원본에 없는 에이전트의 값 · 덧붙임이 있으면 종료 코드 3),
//! `install.sleep` (느린 설치 — 초). 환경 변수가 아니라 파일이라 시험끼리 섞이지 않는다.
//! 실제 `~/.claude` · `~/.claude-harness` 는 건드리지 않는다 (모두 임시 폴더).
//!
//! 버그로 보이는 것은 `#[ignore = "P9-06 버그 n — …"]` 시험으로 남겼다 (`--ignored` 로 돌리면 실패한다).

mod common;

use std::fs;

use common::*;
use nyanitor_lib::custom::cats::{self, CatChange};
use nyanitor_lib::custom::hash;
use nyanitor_lib::custom::labels;
use nyanitor_lib::custom::model::{
    ApplyOutcome, ApplyResult, CatsState, CommitKind, CommitOutcome, CustomList, DiscardOutcome,
    FileStatus, ItemInfo, ListEntry, Mark, RestoreOutcome, RestoreResult, UnreadableReason,
    WriteOutcome, WriteResult,
};
use nyanitor_lib::custom::values::Values;
use nyanitor_lib::custom::write::NewItem;
use nyanitor_lib::custom::{Env, flow, history, items};
use nyanitor_lib::harness::HarnessState;

// ───────────────────────────── 도우미 ─────────────────────────────

fn state() -> HarnessState {
    HarnessState::default()
}

fn values(model: Option<&str>) -> Values {
    Values {
        model: model.map(str::to_string),
        effort: None,
    }
}

/// 가짜 설치가 `~/.claude/agents` 를 만들고 (`mirror`), 원본에 없는 에이전트의 값 · 덧붙임을 거절하게 (`strict`) 한 시험 폴더
fn root(name: &str) -> CustomRoot {
    let r = CustomRoot::new(name).with_script();
    fs::write(r.source.join("mirror"), "").unwrap();
    fs::write(r.source.join("strict"), "").unwrap();
    r
}

fn list(r: &CustomRoot) -> CustomList {
    let ctx = r.ctx();
    items::list(&Env::new(&ctx))
}

fn info(r: &CustomRoot, id: &str) -> ItemInfo {
    match list(r).items.into_iter().find_map(|entry| match entry {
        ListEntry::Ok(info) if info.id == id => Some(Ok(info)),
        ListEntry::Unreadable(item) if item.id == id => Some(Err(item.reason)),
        _ => None,
    }) {
        Some(Ok(info)) => info,
        Some(Err(reason)) => panic!("{id} 는 읽을 수 없음 ({reason:?})"),
        None => panic!("{id} 가 목록에 없다"),
    }
}

fn unreadable(r: &CustomRoot, id: &str) -> Option<UnreadableReason> {
    list(r).items.into_iter().find_map(|entry| match entry {
        ListEntry::Unreadable(item) if item.id == id => Some(item.reason),
        _ => None,
    })
}

fn count_of(r: &CustomRoot, id: &str) -> usize {
    list(r)
        .items
        .iter()
        .filter(|entry| match entry {
            ListEntry::Ok(info) => info.id == id,
            ListEntry::Unreadable(item) => item.id == id,
        })
        .count()
}

fn unapplied(r: &CustomRoot) -> Vec<(String, FileStatus)> {
    list(r)
        .unapplied
        .files
        .into_iter()
        .map(|f| (f.path, f.status))
        .collect()
}

fn unapplied_count(r: &CustomRoot) -> u32 {
    list(r).unapplied.count
}

fn saved(result: &WriteResult) {
    assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
}

fn refused(result: &WriteResult) -> String {
    assert_eq!(result.outcome, WriteOutcome::Refused, "{result:?}");
    result.reason.clone().unwrap_or_default()
}

fn save_values(r: &CustomRoot, id: &str, model: &str) -> WriteResult {
    flow::save_values(&state(), &r.ctx(), id, &values(Some(model))).unwrap()
}

fn save_append(r: &CustomRoot, id: &str, text: &str) -> WriteResult {
    flow::save_append(&state(), &r.ctx(), id, text).unwrap()
}

fn apply(r: &CustomRoot) -> ApplyResult {
    flow::apply(&state(), &r.ctx(), None).unwrap()
}

fn restore(r: &CustomRoot, hash: &str) -> RestoreResult {
    flow::restore_to(&state(), &r.ctx(), hash).unwrap()
}

fn create_agent(r: &CustomRoot, name: &str) -> WriteResult {
    flow::create(
        &state(),
        &r.ctx(),
        &NewItem {
            kind: "agent".into(),
            name: name.into(),
            description: format!("{name} 설명"),
            model: None,
            effort: None,
        },
    )
    .unwrap()
}

fn head(r: &CustomRoot) -> String {
    r.git(&["rev-parse", "HEAD"])
}

fn kinds(r: &CustomRoot) -> Vec<CommitKind> {
    let ctx = r.ctx();
    history::list(&Env::new(&ctx))
        .commits
        .into_iter()
        .map(|c| c.kind)
        .collect()
}

/// 가짜 설치가 `~/.claude/agents` 에 둔 파일 (없으면 `None`)
fn installed(r: &CustomRoot, name: &str) -> Option<String> {
    fs::read_to_string(
        r.h.locations
            .claude_dir
            .join("agents")
            .join(format!("{name}.md")),
    )
    .ok()
}

fn cats_of(r: &CustomRoot) -> (CatsState, Vec<(String, String)>) {
    let ctx = r.ctx();
    let read = cats::read(&Env::new(&ctx));
    (read.state, read.agents.into_iter().collect())
}

fn labels_of(r: &CustomRoot) -> (CatsState, Vec<(String, String)>) {
    let ctx = r.ctx();
    let read = labels::read(&Env::new(&ctx));
    (read.state, read.agents.into_iter().collect())
}

const SOURCE_TRANSLATOR: &str = "---\nname: translator\ndescription: 원본 번역가\nmodel: haiku\n---\n\n원본이 새로 만든 번역가.\n";

fn agent_text(name: &str, body: &str) -> String {
    format!("---\nname: {name}\ndescription: {name} 설명\nmodel: sonnet\n---\n\n{body}\n")
}

// ───────────────────────────── 경우 1 — 원본 업데이트가 내가 만든 이름과 겹침 ─────────────────────────────

#[test]
fn a_source_agent_that_appears_with_the_name_of_my_own_keeps_my_text_installed_and_listed_once() {
    let r = root("conflict-new-name");
    saved(&create_agent(&r, "translator"));
    let mine = r.read_custom("agents/translator.md");
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert_eq!(installed(&r, "translator").as_deref(), Some(mine.as_str()));
    assert_eq!(info(&r, "agent:translator").marks, [Mark::Mine]);

    // 원본 업데이트 받음 — 같은 이름이 원본에 생긴다
    r.write_source("agents/translator.md", SOURCE_TRANSLATOR);
    history::record_origin_update(&r.ctx(), "abc1234");

    assert_eq!(count_of(&r, "agent:translator"), 1, "목록에 하나로 나온다");
    let now = info(&r, "agent:translator");
    // 통째로 바꾼 것과 같은 모양(내 글이 원본을 덮는다)으로 보이고, `.origin` 이 없으니 원본 바뀜으로 고르게 한다 (버그 1 고침)
    assert_eq!(now.marks, [Mark::Replace]);
    assert_eq!(now.origin_changed, Some(true));
    assert_eq!(
        now.description.as_deref(),
        Some("translator 설명"),
        "보이는 소개는 내 글"
    );
    assert_eq!(now.model.as_deref(), Some("haiku"), "원본 값은 원본 글에서");

    // 다음 적용 · 설치도 내 글을 지킨다 — 내 글은 한 글자도 안 바뀌고 설치된 것도 내 글이다
    assert_eq!(r.read_custom("agents/translator.md"), mine);
    saved(&save_values(&r, "agent:harness-designer", "haiku"));
    let applied = apply(&r);
    assert_eq!(applied.outcome, ApplyOutcome::Applied, "{applied:?}");
    assert_eq!(r.read_custom("agents/translator.md"), mine);
    assert_eq!(installed(&r, "translator").as_deref(), Some(mine.as_str()));
    // 원본 바뀜 탭(`origin_changed == Some(true)`)에 나와 사용자가 고를 수 있다 (버그 1 고침) — 내 것 유지면 `.origin` 을 쓰고 탭에서 빠진다
    let in_origin_tab = |r: &CustomRoot| {
        list(r)
            .items
            .iter()
            .any(|e| matches!(e, ListEntry::Ok(i) if i.name == "translator" && i.origin_changed == Some(true)))
    };
    assert!(in_origin_tab(&r));
    // 원본 바뀜 탭이 "같은 이름이 새로 생김" 으로 머리 글을 바꾸도록 알린다 — 내 것 유지 뒤에는 기록(`.origin`)이 생겨 꺼진다
    let unrecorded = |r: &CustomRoot| {
        let ctx = r.ctx();
        match items::read_item(&Env::new(&ctx), "agent:translator").unwrap() {
            nyanitor_lib::custom::model::ItemRead::Ok(detail) => detail.origin_unrecorded,
            other => panic!("{other:?}"),
        }
    };
    assert!(unrecorded(&r));
    saved(&flow::origin_keep(&state(), &r.ctx(), "agent:translator").unwrap());
    assert!(!unrecorded(&r));
    assert!(!in_origin_tab(&r));
    assert_eq!(r.read_custom("agents/translator.md"), mine);
}

#[test]
fn values_on_a_name_that_just_appeared_in_the_source_go_to_a_values_file_and_leave_my_text_alone() {
    let r = root("conflict-new-name-values");
    saved(&create_agent(&r, "translator"));
    let mine = r.read_custom("agents/translator.md");
    apply(&r);
    r.write_source("agents/translator.md", SOURCE_TRANSLATOR);

    // 원본이 생긴 뒤에는 값이 앞머리가 아니라 값 파일로 간다 (내 글은 그대로)
    saved(&save_values(&r, "agent:translator", "opus"));
    assert_eq!(r.read_custom("agents/translator.md"), mine);
    assert_eq!(
        r.read_custom("agents/translator.values.yml"),
        "model: opus\n"
    );
    // 덧붙임도 된다 (원본이 있으니)
    saved(&save_append(&r, "agent:translator", "덧붙임"));
    assert_eq!(r.read_custom("agents/translator.md"), mine);
    // 내가 만든 것을 지우는 길은 막힌다 (원본에 있으니 `not_mine`) — 글을 없애려면 "원본으로" 뿐이다
    let delete = flow::delete_mine(&state(), &r.ctx(), "agent:translator").unwrap();
    assert_eq!(refused(&delete), "not_mine");
    assert_eq!(r.read_custom("agents/translator.md"), mine);
}

#[test]
fn going_back_to_the_original_after_the_name_collision_removes_my_text_only_by_an_explicit_choice()
{
    let r = root("conflict-new-name-stop");
    saved(&create_agent(&r, "translator"));
    apply(&r);
    r.write_source("agents/translator.md", SOURCE_TRANSLATOR);
    // "원본으로" 는 사용자가 고른 일이다 — 내 글이 지워지고 원본이 보이는 것이 맞다. 되돌릴 길 = 기록
    saved(&flow::replace_stop(&state(), &r.ctx(), "agent:translator").unwrap());
    assert!(!r.custom_exists("agents/translator.md"));
    assert_eq!(
        unapplied(&r),
        [("agents/translator.md".into(), FileStatus::Removed)]
    );
    // 적용 안 한 것 버리기로 내 글이 돌아온다
    let discard = flow::discard(&state(), &r.ctx()).unwrap();
    assert_eq!(discard.outcome, DiscardOutcome::Discarded);
    assert!(r.custom_exists("agents/translator.md"));
}

/// 버그 후보 — 원본에 같은 이름이 새로 생겨도 화면은 알 길이 없다: `.origin` 이 없는 내가 만든 글이 "통째 바꿈" 으로 바뀌어 보이는데
/// `originChanged` 는 비어 있어 "원본 바뀜" 탭에도 안 나온다 (내 글은 그대로 지켜지므로 데이터를 잃지는 않는다).
/// 기대: 사용자가 알 수 있다 (예: `origin_changed == Some(true)`).
#[test]
fn a_source_agent_with_the_name_of_my_own_is_flagged_so_the_user_can_tell() {
    let r = root("conflict-new-name-flag");
    saved(&create_agent(&r, "translator"));
    apply(&r);
    r.write_source("agents/translator.md", SOURCE_TRANSLATOR);
    assert_eq!(
        info(&r, "agent:translator").origin_changed,
        Some(true),
        "원본에 같은 이름이 생겼다는 것을 사용자가 알 길이 없다"
    );
}

// ───────────────────────────── 경우 2 — 원본에서 사라진 에이전트에 내 값 · 덧붙임이 남음 ─────────────────────────────

/// 값 · 덧붙임을 저장해 적용한 뒤 원본에서 그 에이전트 파일을 지운 상태
fn gone_ui() -> CustomRoot {
    let r = root("conflict-gone");
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    saved(&save_append(
        &r,
        "agent:harness-builder-ui",
        "항상 한국어로",
    ));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert!(installed(&r, "harness-builder-ui").is_some());
    fs::remove_file(r.source.join("agents/harness-builder-ui.md")).unwrap();
    r
}

#[test]
fn values_and_append_left_without_their_source_are_listed_as_target_gone_and_cannot_be_saved_again()
{
    let r = gone_ui();
    assert_eq!(
        unreadable(&r, "agent:harness-builder-ui"),
        Some(UnreadableReason::TargetGone)
    );
    // 다른 항목은 그대로 읽힌다
    assert!(info(&r, "agent:harness-designer").marks.is_empty());
    // 새로 저장은 거절 (고칠 원본이 없다) — 그리고 파일은 그대로
    assert_eq!(
        refused(&save_values(&r, "agent:harness-builder-ui", "haiku")),
        "not_found"
    );
    assert_eq!(
        refused(&save_append(&r, "agent:harness-builder-ui", "다른 글")),
        "not_found"
    );
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: opus\n"
    );
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.append.md"),
        "항상 한국어로"
    );
    assert_eq!(unapplied_count(&r), 0);
}

#[test]
fn an_apply_that_the_install_refuses_because_of_the_gone_target_makes_no_commit_and_keeps_the_unapplied_changes()
 {
    let r = gone_ui();
    saved(&save_values(&r, "agent:harness-designer", "haiku"));
    let before = head(&r);
    let result = apply(&r);
    assert_eq!(result.outcome, ApplyOutcome::Failed, "{result:?}");
    assert_eq!(result.commit, CommitOutcome::Skipped);
    assert_eq!(result.script.as_ref().unwrap().exit_code, Some(3));
    assert_eq!(head(&r), before, "커밋이 생겼다");
    assert_eq!(
        unapplied(&r),
        [(
            "agents/harness-designer.values.yml".into(),
            FileStatus::Added
        )],
        "적용 안 한 것이 그대로"
    );
    // 다시 해도 같다 — 갇힌다 (아래 길로만 빠져나온다)
    assert_eq!(apply(&r).outcome, ApplyOutcome::Failed);
    assert_eq!(r.install_calls(), 3, "첫 적용 + 실패 2번");
}

#[test]
fn deleting_the_leftovers_is_the_way_out_of_a_gone_target_and_the_next_apply_goes_through() {
    let r = gone_ui();
    saved(&save_values(&r, "agent:harness-designer", "haiku"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Failed);
    // 내가 만든 것 지우기 = 남은 값 · 덧붙임 지우기 (원본이 없으니 가능하다)
    saved(&flow::delete_mine(&state(), &r.ctx(), "agent:harness-builder-ui").unwrap());
    assert!(!r.custom_exists("agents/harness-builder-ui.values.yml"));
    assert!(!r.custom_exists("agents/harness-builder-ui.append.md"));
    assert_eq!(
        count_of(&r, "agent:harness-builder-ui"),
        0,
        "목록에서 사라진다"
    );
    let mut files: Vec<String> = unapplied(&r).into_iter().map(|f| f.0).collect();
    files.sort();
    assert_eq!(
        files,
        [
            "agents/harness-builder-ui.append.md",
            "agents/harness-builder-ui.values.yml",
            "agents/harness-designer.values.yml",
        ]
    );
    let result = apply(&r);
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    assert_eq!(result.files, 3);
    assert_eq!(unapplied_count(&r), 0);
}

#[test]
fn going_back_in_the_history_is_another_way_out_of_a_gone_target() {
    let r = gone_ui();
    saved(&save_values(&r, "agent:harness-designer", "haiku"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Failed);
    // 적용 안 한 것이 있는 동안은 되돌리기가 막힌다 → 버리고 → 값 · 덧붙임이 없던 처음 기록으로
    let blocked = restore(&r, &head(&r));
    assert_eq!(blocked.outcome, RestoreOutcome::HasUnapplied);
    assert_eq!(
        flow::discard(&state(), &r.ctx()).unwrap().outcome,
        DiscardOutcome::Discarded
    );
    let ctx = r.ctx();
    let commits = history::list(&Env::new(&ctx)).commits;
    let start = commits.last().unwrap();
    assert_eq!(start.kind, CommitKind::Start);
    let result = restore(&r, &start.hash);
    assert_eq!(result.outcome, RestoreOutcome::Restored, "{result:?}");
    assert!(!r.custom_exists("agents/harness-builder-ui.values.yml"));
    assert_eq!(count_of(&r, "agent:harness-builder-ui"), 0);
    assert_eq!(unapplied_count(&r), 0);
}

// ───────────────────────────── 경우 3 — 통째 바꾼 파일, 원본이 두 번 바뀜 ─────────────────────────────

fn source_ui(body: &str) -> String {
    agent_text("harness-builder-ui", body)
}

#[test]
fn a_replaced_file_follows_the_source_changing_twice_and_keeping_mine_resets_the_flag_each_time() {
    let r = root("conflict-twice");
    let id = "agent:harness-builder-ui";
    saved(&flow::replace_start(&state(), &r.ctx(), id).unwrap());
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert_eq!(info(&r, id).origin_changed, Some(false));

    // 원본이 바뀜
    r.write_source("agents/harness-builder-ui.md", &source_ui("둘째 글"));
    assert_eq!(info(&r, id).origin_changed, Some(true));
    // 내 것 유지 → 적용
    saved(&flow::origin_keep(&state(), &r.ctx(), id).unwrap());
    assert_eq!(info(&r, id).origin_changed, Some(false));
    assert_eq!(
        unapplied(&r),
        [(
            "agents/harness-builder-ui.md.origin".into(),
            FileStatus::Changed
        )]
    );
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert!(
        r.read_custom("agents/harness-builder-ui.md")
            .contains("화면 구현자"),
        "내 것은 처음 복사한 글 그대로"
    );
    assert_eq!(info(&r, id).origin_changed, Some(false));

    // 원본이 또 바뀜 → 다시 true
    r.write_source("agents/harness-builder-ui.md", &source_ui("셋째 글"));
    assert_eq!(info(&r, id).origin_changed, Some(true));
    // 원본으로 → 적용 → 설치된 것이 새 원본과 같다
    saved(&flow::replace_stop(&state(), &r.ctx(), id).unwrap());
    assert!(!r.custom_exists("agents/harness-builder-ui.md"));
    assert!(!r.custom_exists("agents/harness-builder-ui.md.origin"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert_eq!(
        installed(&r, "harness-builder-ui").unwrap(),
        source_ui("셋째 글")
    );
    let now = info(&r, id);
    assert!(now.marks.is_empty());
    assert_eq!(now.origin_changed, None);
    assert_eq!(
        kinds(&r),
        [
            CommitKind::Apply,
            CommitKind::Apply,
            CommitKind::Apply,
            CommitKind::Start
        ]
    );
}

#[test]
fn a_replaced_file_whose_source_changes_then_disappears_then_comes_back_follows_the_hash_each_step()
{
    let r = root("conflict-vanish");
    let id = "agent:harness-builder-ui";
    saved(&flow::replace_start(&state(), &r.ctx(), id).unwrap());
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    let path = r.source.join("agents/harness-builder-ui.md");

    fs::write(&path, source_ui("바뀐 글")).unwrap();
    assert_eq!(info(&r, id).origin_changed, Some(true));
    // 사라짐 — 내 파일은 남고 (새 파일처럼), 원본 바뀜은 true, 원본이 없다
    fs::remove_file(&path).unwrap();
    let gone = info(&r, id);
    assert_eq!(gone.origin_changed, Some(true));
    assert_eq!(gone.marks, [Mark::Mine]);
    let detail = {
        let ctx = r.ctx();
        items::read_item(&Env::new(&ctx), id).unwrap()
    };
    match detail {
        nyanitor_lib::custom::model::ItemRead::Ok(detail) => assert!(detail.origin_gone),
        other => panic!("{other:?}"),
    }
    // 바뀐 채 다시 생김 → 아직 true, 처음 글로 다시 생김 → false
    fs::write(&path, source_ui("바뀐 글")).unwrap();
    assert_eq!(info(&r, id).origin_changed, Some(true));
    fs::write(&path, SOURCE_AGENT_UI).unwrap();
    assert_eq!(info(&r, id).origin_changed, Some(false));
    // 내 파일은 한 번도 안 바뀌었다
    assert!(
        r.read_custom("agents/harness-builder-ui.md")
            .contains("화면 구현자")
    );
}

#[test]
fn keeping_mine_while_the_source_is_gone_drops_the_origin_file_and_the_file_stays_as_a_new_one() {
    let r = root("conflict-vanish-keep");
    let id = "agent:harness-builder-ui";
    saved(&flow::replace_start(&state(), &r.ctx(), id).unwrap());
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    fs::remove_file(r.source.join("agents/harness-builder-ui.md")).unwrap();
    saved(&flow::origin_keep(&state(), &r.ctx(), id).unwrap());
    assert!(!r.custom_exists("agents/harness-builder-ui.md.origin"));
    assert!(r.custom_exists("agents/harness-builder-ui.md"));
    let now = info(&r, id);
    assert_eq!(now.marks, [Mark::Mine]);
    assert_eq!(now.origin_changed, None);
    // 이제는 내가 만든 것처럼 지울 수도 있다
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    saved(&flow::delete_mine(&state(), &r.ctx(), id).unwrap());
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert!(installed(&r, "harness-builder-ui").is_none());
}

// ───────────────────────────── 경우 4 — 업데이트와 적용 안 한 것이 섞임 ─────────────────────────────

#[test]
fn an_origin_update_between_saving_and_applying_leaves_the_unapplied_files_alone_and_the_next_apply_takes_all()
 {
    let r = root("conflict-mixed");
    // 적용된 값 하나 (추적되는 파일) → 그것을 고쳐 적용 안 함 + 새 파일 하나 (추적 안 되는 파일)
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    saved(&save_values(&r, "agent:harness-builder-ui", "haiku"));
    saved(&save_append(&r, "agent:harness-designer", "덧붙임"));
    let before = unapplied(&r);
    assert_eq!(before.len(), 2);

    // 원본 업데이트 받음 (원본도 바뀐다)
    r.write_source(
        "agents/harness-designer.md",
        &agent_text("harness-designer", "새 글"),
    );
    history::record_origin_update(&r.ctx(), "9f8e7d6");

    assert_eq!(unapplied(&r), before, "적용 안 한 것이 그대로");
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: haiku\n"
    );
    // 빈 커밋 — 적용 안 한 것을 끼워 넣지 않았다
    assert_eq!(r.git(&["show", "--stat", "--format=", "HEAD"]), "");
    assert_eq!(kinds(&r)[0], CommitKind::OriginUpdate);
    assert_eq!(
        r.subjects()[0],
        nyanitor_lib::strings::custom_commit_origin_update("9f8e7d6")
    );

    // 다음 적용이 둘 다 반영
    let result = apply(&r);
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    assert_eq!(result.files, 2);
    assert_eq!(unapplied_count(&r), 0);
    assert_eq!(
        kinds(&r),
        [
            CommitKind::Apply,
            CommitKind::OriginUpdate,
            CommitKind::Apply,
            CommitKind::Start
        ]
    );
    let shown = r.git(&["show", "--stat", "--format=", "HEAD"]);
    assert!(
        shown.contains("harness-builder-ui.values.yml")
            && shown.contains("harness-designer.append.md"),
        "{shown}"
    );
}

#[test]
fn two_origin_updates_in_a_row_make_two_empty_commits_and_the_install_is_not_run() {
    let r = root("conflict-two-updates");
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    let calls = r.install_calls();
    history::record_origin_update(&r.ctx(), "1111111");
    history::record_origin_update(&r.ctx(), "2222222");
    assert_eq!(
        kinds(&r)[..2],
        [CommitKind::OriginUpdate, CommitKind::OriginUpdate]
    );
    assert_eq!(
        r.install_calls(),
        calls,
        "업데이트 받음 기록은 설치하지 않는다"
    );
    assert_eq!(unapplied_count(&r), 1);
}

// ───────────────────────────── 경우 5 — 기록 되돌리기가 새로 만든 것 · 고양이 · 이름을 함께 되돌림 ─────────────────────────────

#[test]
fn restoring_to_before_an_agent_was_made_takes_its_cat_and_label_with_it_and_restoring_to_now_brings_all_back()
 {
    let r = root("conflict-restore-all");
    // 처음 기록은 첫 저장 때 (만들기 전) 생긴다
    saved(&create_agent(&r, "translator"));
    let mine = r.read_custom("agents/translator.md");
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert_eq!(installed(&r, "translator").as_deref(), Some(mine.as_str()));
    let cat = flow::cats_write(&state(), &r.ctx(), "translator", Some("mukmul")).unwrap();
    assert_eq!(cat.commit, CommitOutcome::Committed, "{cat:?}");
    let label = flow::labels_write(&state(), &r.ctx(), "translator", Some("번역가")).unwrap();
    assert_eq!(label.commit, CommitOutcome::Committed, "{label:?}");
    assert_eq!(
        kinds(&r),
        [
            CommitKind::Labels,
            CommitKind::Cats,
            CommitKind::New,
            CommitKind::Start
        ]
    );
    let now = head(&r);
    let cats_text = r.read_custom("agent-cats.json");
    let labels_text = r.read_custom("agent-labels.json");
    let start = r.git(&["rev-list", "--max-parents=0", "HEAD"]);

    // 만들기 전 커밋으로
    let back = restore(&r, &start);
    assert_eq!(back.outcome, RestoreOutcome::Restored, "{back:?}");
    assert_eq!(back.commit, CommitOutcome::Committed);
    assert!(!r.custom_exists("agents/translator.md"));
    assert!(!r.custom_exists("agent-cats.json"), "그때는 파일이 없었다");
    assert!(!r.custom_exists("agent-labels.json"));
    assert_eq!(installed(&r, "translator"), None, "설치된 것도 사라졌다");
    assert!(
        installed(&r, "harness-designer").is_some(),
        "원본 에이전트는 그대로"
    );
    assert_eq!(cats_of(&r), (CatsState::Absent, vec![]));
    assert_eq!(labels_of(&r), (CatsState::Absent, vec![]));
    assert_eq!(count_of(&r, "agent:translator"), 0);
    assert_eq!(unapplied_count(&r), 0);
    assert_eq!(kinds(&r)[0], CommitKind::Restore);

    // 다시 "지금" 으로 — 모두 돌아온다
    let forward = restore(&r, &now);
    assert_eq!(forward.outcome, RestoreOutcome::Restored, "{forward:?}");
    assert_eq!(r.read_custom("agents/translator.md"), mine);
    assert_eq!(r.read_custom("agent-cats.json"), cats_text);
    assert_eq!(r.read_custom("agent-labels.json"), labels_text);
    assert_eq!(installed(&r, "translator").as_deref(), Some(mine.as_str()));
    assert_eq!(
        cats_of(&r).1,
        [("translator".to_string(), "mukmul".to_string())]
    );
    assert_eq!(
        labels_of(&r).1,
        [("translator".to_string(), "번역가".to_string())]
    );
    assert_eq!(count_of(&r, "agent:translator"), 1);
    // 이력은 줄지 않았다 (되돌리기도 새 커밋)
    assert_eq!(r.subjects().len(), 6);
}

#[test]
fn restoring_to_the_commit_between_the_apply_and_the_cat_gives_the_agent_without_its_cat_and_label()
{
    let r = root("conflict-restore-mid");
    saved(&create_agent(&r, "translator"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    let applied = head(&r);
    flow::cats_write(&state(), &r.ctx(), "translator", Some("mukmul")).unwrap();
    flow::labels_write(&state(), &r.ctx(), "translator", Some("번역가")).unwrap();
    // 적용 직후의 모습으로 — 에이전트는 있고 고양이 · 이름만 사라진다
    assert_eq!(restore(&r, &applied).outcome, RestoreOutcome::Restored);
    assert!(r.custom_exists("agents/translator.md"));
    assert!(installed(&r, "translator").is_some());
    assert_eq!(cats_of(&r).0, CatsState::Absent);
    assert_eq!(labels_of(&r).0, CatsState::Absent);
}

#[test]
fn restoring_is_refused_while_a_cat_or_label_or_agent_change_is_unapplied_and_nothing_moves() {
    let r = root("conflict-restore-refuse");
    saved(&create_agent(&r, "translator"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    let target = head(&r);
    saved(&save_values(&r, "agent:harness-designer", "haiku"));
    flow::cats_write(&state(), &r.ctx(), "translator", Some("mukmul")).unwrap();
    let start = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let calls = r.install_calls();
    let refused_restore = restore(&r, &start);
    assert_eq!(refused_restore.outcome, RestoreOutcome::HasUnapplied);
    assert_eq!(r.install_calls(), calls, "설치하지 않았다");
    assert!(r.custom_exists("agents/translator.md"));
    assert_eq!(cats_of(&r).1.len(), 1, "바로 커밋된 고양이는 그대로");
    assert_eq!(unapplied_count(&r), 1, "적용 안 한 값은 그대로");
    assert_ne!(head(&r), target);
}

// ───────────────────────────── 경우 7 — 손으로 깨뜨린 내 수정 파일이 있을 때 ─────────────────────────────

const BROKEN_JSON: &str = "{ not json";

/// 깨진 값 파일 · 짝 없는 `.origin` · 깨진 고양이 · 이름 · 설정 파일이 든 내 수정 폴더 (기록을 시작하기 전에 놓아 처음 기록에 들어간다)
fn broken_root(name: &str) -> CustomRoot {
    let r = root(name);
    r.write_custom("agents/harness-designer.values.yml", "model opus\n");
    r.write_custom("agents/ghost.md.origin", &format!("{}\n", "a".repeat(64)));
    r.write_custom("agent-cats.json", BROKEN_JSON);
    r.write_custom("agent-labels.json", BROKEN_JSON);
    r.write_custom("config.local.json", BROKEN_JSON);
    r
}

fn broken_bytes(r: &CustomRoot) -> Vec<String> {
    [
        "agents/harness-designer.values.yml",
        "agents/ghost.md.origin",
        "agent-cats.json",
        "agent-labels.json",
        "config.local.json",
    ]
    .iter()
    .map(|rel| r.read_custom(rel))
    .collect()
}

#[test]
fn broken_files_stop_only_their_own_items_and_other_items_still_save_apply_discard_and_restore() {
    let r = broken_root("conflict-broken");
    let broken = broken_bytes(&r);
    // 목록: 깨진 것만 읽을 수 없음, 나머지는 정상 (원본 쪽 항목은 모두 보인다)
    assert_eq!(
        unreadable(&r, "agent:harness-designer"),
        Some(UnreadableReason::BadValues)
    );
    assert_eq!(
        unreadable(&r, "agent:ghost"),
        Some(UnreadableReason::TargetGone)
    );
    assert_eq!(unreadable(&r, "main"), Some(UnreadableReason::BadConfig));
    assert!(info(&r, "agent:harness-builder-ui").marks.is_empty());
    assert!(info(&r, "skill:web-full").marks.is_empty());

    // 다른 항목 저장 · 적용은 된다
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    saved(&save_append(&r, "agent:harness-builder-ui", "덧붙임"));
    saved(&save_values(&r, "skill:web-full", "haiku"));
    assert_eq!(unapplied_count(&r), 3);
    // 깨진 파일 자체에는 저장이 거절되고 파일은 그대로
    assert_eq!(
        refused(&save_values(&r, "agent:harness-designer", "opus")),
        "bad_values"
    );
    let main = flow::save_values(&state(), &r.ctx(), "main", &values(Some("opus"))).unwrap();
    assert_eq!(refused(&main), "bad_config");
    assert_eq!(broken_bytes(&r), broken);

    // 버리기 — 저장한 것만 사라지고 깨진 파일은 그대로
    let discard = flow::discard(&state(), &r.ctx()).unwrap();
    assert_eq!(
        (discard.outcome, discard.files),
        (DiscardOutcome::Discarded, 3)
    );
    assert_eq!(broken_bytes(&r), broken);
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    let applied = apply(&r);
    assert_eq!(applied.outcome, ApplyOutcome::Applied, "{applied:?}");
    assert_eq!(broken_bytes(&r), broken);

    // 되돌리기 — 적용 전 모습으로 (깨진 파일은 처음부터 그 모습)
    let start = r.git(&["rev-list", "--max-parents=0", "HEAD"]);
    let restored = restore(&r, &start);
    assert_eq!(restored.outcome, RestoreOutcome::Restored, "{restored:?}");
    assert!(!r.custom_exists("agents/harness-builder-ui.values.yml"));
    assert_eq!(broken_bytes(&r), broken);
}

#[test]
fn cats_and_labels_and_the_main_config_refuse_to_overwrite_a_broken_file_and_each_says_why() {
    let r = broken_root("conflict-broken-json");
    let broken = broken_bytes(&r);
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    let cat = flow::cats_write(&state(), &r.ctx(), "harness-builder-ui", Some("mukmul")).unwrap();
    assert_eq!(cat.outcome, WriteOutcome::Refused);
    assert_eq!(cat.reason.as_deref(), Some("unreadable"));
    assert_eq!(cat.commit, CommitOutcome::Skipped);
    let many = flow::cats_write_many(
        &state(),
        &r.ctx(),
        &[CatChange {
            agent: "harness-builder-ui".into(),
            cat: Some("mukmul".into()),
        }],
    )
    .unwrap();
    assert_eq!(many.reason.as_deref(), Some("unreadable"));
    let label = flow::labels_write(&state(), &r.ctx(), "harness-builder-ui", Some("화면")).unwrap();
    assert_eq!(label.reason.as_deref(), Some("unreadable"));
    assert_eq!(broken_bytes(&r), broken);
    assert_eq!(cats_of(&r).0, CatsState::Unreadable);
    assert_eq!(labels_of(&r).0, CatsState::Unreadable);
    // 같은 때에 값 저장은 된다 (고양이 파일이 깨졌다고 전부 멈추지 않는다)
    assert_eq!(unapplied_count(&r), 1);
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
}

#[test]
fn a_file_broken_by_hand_after_the_history_started_is_not_overwritten_by_restoring_and_is_unapplied()
 {
    let r = root("conflict-broken-late");
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    let applied = head(&r);
    saved(&save_values(&r, "agent:harness-builder-ui", "haiku"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    // 메모장으로 값 파일을 깨뜨림
    r.write_custom("agents/harness-builder-ui.values.yml", "model opus\n");
    assert_eq!(
        unapplied(&r),
        [(
            "agents/harness-builder-ui.values.yml".into(),
            FileStatus::Changed
        )]
    );
    assert_eq!(
        unreadable(&r, "agent:harness-builder-ui"),
        Some(UnreadableReason::BadValues)
    );
    // 되돌리기는 거절 — 손으로 고친 것을 덮어쓰지 않는다
    assert_eq!(restore(&r, &applied).outcome, RestoreOutcome::HasUnapplied);
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model opus\n"
    );
    // 적용은 설치가 거절하지 않는 이상 (가짜 설치는 값을 안 읽는다) 커밋한다 — 깨진 채로 기록에 들어간다. 되돌리기는 그 앞 모습으로 갈 수 있다
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    assert_eq!(restore(&r, &applied).outcome, RestoreOutcome::Restored);
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: opus\n"
    );
}

// ───────────────────────────── 경우 8 — 동시에 ─────────────────────────────

#[test]
fn while_a_slow_apply_runs_every_other_writing_call_is_busy_and_the_apply_commit_has_only_its_own_files()
 {
    let r = root("conflict-concurrent");
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    fs::write(r.source.join("install.sleep"), "4").unwrap();
    let shared = state();
    let ctx = r.ctx();
    let files_before = {
        let mut v: Vec<String> = walk(&r.custom);
        v.sort();
        v
    };
    let request = NewItem {
        kind: "agent".into(),
        name: "late-one".into(),
        description: "x".into(),
        model: None,
        effort: None,
    };
    let busy_errors = std::thread::scope(|scope| {
        let worker = scope.spawn(|| flow::apply(&shared, &ctx, Some("느린 적용")).unwrap());
        // 가짜 설치가 시작했다 (calls.log) — 그 뒤 잠자는 동안 다른 쓰기를 시도한다
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while r.install_calls() == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "설치가 시작하지 않았다"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let id = "agent:harness-designer";
        let errors = [
            flow::save_values(&shared, &ctx, id, &values(Some("haiku"))).err(),
            flow::save_append(&shared, &ctx, id, "늦게 쓴 글").err(),
            flow::replace_start(&shared, &ctx, id).err(),
            flow::create(&shared, &ctx, &request).err(),
            flow::cats_write(&shared, &ctx, "harness-designer", Some("mukmul")).err(),
            flow::cats_write_many(
                &shared,
                &ctx,
                &[CatChange {
                    agent: "main".into(),
                    cat: Some("mukmul".into()),
                }],
            )
            .err(),
            flow::labels_write(&shared, &ctx, "harness-designer", Some("디자인")).err(),
            flow::discard(&shared, &ctx).err(),
            flow::restore_to(&shared, &ctx, &head(&r)).err(),
            flow::apply(&shared, &ctx, None).err(),
            nyanitor_lib::harness::flow::update_pull(&shared, &ctx).err(),
            nyanitor_lib::harness::flow::install(&shared, &ctx).err(),
        ];
        let result = worker.join().unwrap();
        assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
        assert_eq!(result.files, 1);
        errors
    });
    for (index, error) in busy_errors.into_iter().enumerate() {
        assert_eq!(
            error
                .unwrap_or_else(|| panic!("{index} 번째 호출이 잠금을 무시했다"))
                .kind(),
            "harness_busy",
            "{index}"
        );
    }
    // 늦게 쓴 파일이 하나도 없다 — 적용 커밋에는 처음 저장한 값 파일 하나뿐
    assert_eq!(r.install_calls(), 1, "느린 설치 하나만 돌았다");
    assert!(!r.custom_exists("agents/harness-designer.values.yml"));
    assert!(!r.custom_exists("agents/harness-designer.append.md"));
    assert!(!r.custom_exists("agents/late-one.md"));
    assert!(!r.custom_exists("agent-cats.json") && !r.custom_exists("agent-labels.json"));
    let shown = r.git(&["show", "--stat", "--format=", "HEAD"]);
    assert!(
        shown.contains("harness-builder-ui.values.yml") && shown.lines().count() == 2,
        "{shown}"
    );
    assert_eq!(unapplied_count(&r), 0);
    assert_eq!(kinds(&r), [CommitKind::Apply, CommitKind::Start]);
    assert_eq!(r.subjects()[0], "느린 적용");
    let mut files_after = walk(&r.custom);
    files_after.sort();
    assert_eq!(
        files_after.len(),
        files_before.len(),
        "{files_before:?} -> {files_after:?}"
    );
    // 잠금은 풀렸다 — 이제는 쓰기가 된다
    saved(
        &flow::save_values(
            &shared,
            &ctx,
            "agent:harness-designer",
            &values(Some("haiku")),
        )
        .unwrap(),
    );
}

/// 내 수정 폴더 안 파일 이름들 (`.git` 은 뺀다)
fn walk(dir: &std::path::Path) -> Vec<String> {
    fn go(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(base)
                .unwrap()
                .display()
                .to_string()
                .replace('\\', "/");
            if rel == ".git" {
                continue;
            }
            if path.is_dir() {
                go(base, &path, out);
            } else {
                out.push(rel);
            }
        }
    }
    let mut out = Vec::new();
    go(dir, dir, &mut out);
    out
}

#[test]
fn a_failed_slow_install_is_not_confused_by_a_late_write_and_leaves_everything_unapplied_after_the_lock_is_free()
 {
    let r = root("conflict-concurrent-fail");
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    r.script_out("install", "install-exit3.json", 3);
    fs::write(r.source.join("install.sleep"), "3").unwrap();
    let shared = state();
    let ctx = r.ctx();
    let busy = std::thread::scope(|scope| {
        let worker = scope.spawn(|| flow::apply(&shared, &ctx, None).unwrap());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while r.install_calls() == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "설치가 시작하지 않았다"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let busy = flow::save_values(
            &shared,
            &ctx,
            "agent:harness-designer",
            &values(Some("haiku")),
        )
        .err();
        assert_eq!(worker.join().unwrap().outcome, ApplyOutcome::Failed);
        busy
    });
    assert_eq!(busy.unwrap().kind(), "harness_busy");
    assert_eq!(
        unapplied(&r),
        [(
            "agents/harness-builder-ui.values.yml".into(),
            FileStatus::Added
        )]
    );
    assert_eq!(kinds(&r), [CommitKind::Start]);
}

/// P10-08 — 적용 · 어느 때로 되돌리기가 설치를 도는 동안은 앱을 끄려 할 때 물어야 하고(`quit_task`), 끝나면 묻지 않는다. 짧은 저장은 묻지 않는다.
#[test]
fn the_quit_warning_is_on_while_an_apply_or_a_restore_installs_and_off_when_it_ends() {
    let r = root("conflict-quit-warning");
    let shared = state();
    let ctx = r.ctx();
    // 저장 · 첫 적용은 빠르다 — 일이 없을 때 · 짧은 일 뒤에는 묻지 않는다
    assert_eq!(shared.quit_task(), None);
    saved(&save_values(&r, "agent:harness-builder-ui", "opus"));
    assert_eq!(shared.quit_task(), None);
    assert_eq!(
        flow::apply(&shared, &ctx, Some("처음")).unwrap().outcome,
        ApplyOutcome::Applied
    );
    assert_eq!(shared.quit_task(), None);
    let first = head(&r);
    saved(&save_values(&r, "agent:harness-builder-ui", "haiku"));
    assert_eq!(
        flow::apply(&shared, &ctx, Some("둘째")).unwrap().outcome,
        ApplyOutcome::Applied
    );

    // 느린 설치를 돌리는 동안의 `quit_task` 를 본다
    let seen_while = |run: &(dyn Fn() + Sync)| {
        let before = r.install_calls();
        fs::write(r.source.join("install.sleep"), "3").unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(run);
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
            while r.install_calls() == before {
                assert!(
                    std::time::Instant::now() < deadline,
                    "설치가 시작하지 않았다"
                );
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            let seen = shared.quit_task();
            worker.join().unwrap();
            seen
        })
    };

    // 어느 때로 되돌리기
    let seen = seen_while(&|| {
        let result = flow::restore_to(&shared, &ctx, &first).unwrap();
        assert_eq!(result.outcome, RestoreOutcome::Restored, "{result:?}");
    });
    assert_eq!(seen, Some(nyanitor_lib::harness::HarnessTask::Install));
    assert_eq!(shared.quit_task(), None, "되돌리기가 끝났다");

    // 적용
    saved(&save_values(&r, "agent:harness-builder-ui", "sonnet"));
    let seen = seen_while(&|| {
        assert_eq!(
            flow::apply(&shared, &ctx, None).unwrap().outcome,
            ApplyOutcome::Applied
        );
    });
    assert_eq!(seen, Some(nyanitor_lib::harness::HarnessTask::Install));
    assert_eq!(shared.quit_task(), None, "적용이 끝났다");
    fs::remove_file(r.source.join("install.sleep")).unwrap();
}

// ───────────────────────────── 경우 9 — Windows 편집기 흔적 (CRLF + BOM) ─────────────────────────────

fn crlf(text: &str) -> String {
    text.replace('\n', "\r\n")
}

#[test]
fn a_crlf_source_does_not_make_the_replaced_file_look_changed_and_the_copy_is_lf() {
    let r = root("conflict-crlf-source");
    let id = "agent:harness-builder-ui";
    // 원본이 CRLF 로 받아졌다 (git 의 줄바꿈 변환 · 메모장) — 같은 글
    fs::write(
        r.source.join("agents/harness-builder-ui.md"),
        crlf(SOURCE_AGENT_UI),
    )
    .unwrap();
    saved(&flow::replace_start(&state(), &r.ctx(), id).unwrap());
    let copy = fs::read(r.custom.join("agents/harness-builder-ui.md")).unwrap();
    assert!(!copy.contains(&b'\r'), "복사본은 LF");
    assert_eq!(info(&r, id).origin_changed, Some(false));
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.md.origin").trim(),
        hash::sha256_hex(SOURCE_AGENT_UI.as_bytes()),
        "해시는 LF 로 맞춘 글의 것"
    );
    // 원본이 LF 로 다시 저장돼도 (같은 글) 바뀜으로 뜨지 않는다 · BOM 이 붙어도 읽힌다 (해시는 바이트 그대로라 이 경우는 바뀜 — 설치 스크립트와 같은 규칙)
    fs::write(
        r.source.join("agents/harness-builder-ui.md"),
        SOURCE_AGENT_UI,
    )
    .unwrap();
    assert_eq!(info(&r, id).origin_changed, Some(false));
    fs::write(
        r.source.join("agents/harness-builder-ui.md"),
        crlf(SOURCE_AGENT_UI),
    )
    .unwrap();
    assert_eq!(info(&r, id).origin_changed, Some(false));
    let with_bom = format!("\u{feff}{}", crlf(SOURCE_AGENT_UI));
    fs::write(r.source.join("agents/harness-builder-ui.md"), with_bom).unwrap();
    let now = info(&r, id); // 읽을 수 있어야 한다 (앞머리가 BOM 에 막히지 않는다)
    assert_eq!(now.description.as_deref(), Some("화면 구현자"));
}

#[test]
fn a_notepad_saved_replaced_text_and_append_with_crlf_and_bom_read_fine_and_saving_writes_lf_without_bom()
 {
    let r = root("conflict-crlf-mine");
    let id = "agent:harness-builder-ui";
    saved(&flow::replace_start(&state(), &r.ctx(), id).unwrap());
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    // 메모장이 통째 글 · 덧붙임을 CRLF + BOM 으로 저장했다
    let edited = SOURCE_AGENT_UI.replace("화면 구현자다", "화면 구현자다 (고침)");
    fs::write(
        r.custom.join("agents/harness-builder-ui.md"),
        format!("\u{feff}{}", crlf(&edited)),
    )
    .unwrap();
    fs::write(
        r.custom.join("agents/harness-builder-ui.append.md"),
        format!("\u{feff}{}", crlf("덧붙임\n둘째 줄\n")),
    )
    .unwrap();
    let now = info(&r, id);
    // 원본 바뀜은 원본 쪽 해시만 본다 — 내 글의 줄바꿈 · BOM 때문에 거짓으로 뜨지 않는다
    assert_eq!(now.origin_changed, Some(false));
    assert_eq!(now.marks, [Mark::Append, Mark::Replace]);
    let ctx = r.ctx();
    match items::read_item(&Env::new(&ctx), id).unwrap() {
        nyanitor_lib::custom::model::ItemRead::Ok(detail) => {
            use nyanitor_lib::custom::model::TextPart;
            let TextPart::Text { text } = &detail.replace_text else {
                panic!("{:?}", detail.replace_text)
            };
            assert!(!text.starts_with('\u{feff}'), "통째 글에 BOM");
            // 통째 글의 CR 은 그대로 읽힌다 (아래 버그 2 시험) — 여기서는 내용이 같은지만 본다
            assert_eq!(text.replace("\r\n", "\n"), edited);
            let TextPart::Text { text } = &detail.append_text else {
                panic!("{:?}", detail.append_text)
            };
            assert_eq!(text.replace("\r\n", "\n"), "덧붙임\n둘째 줄\n");
        }
        other => panic!("{other:?}"),
    }
    // 글을 바꿔 저장하면 LF · BOM 없음
    saved(&flow::save_text(&state(), &r.ctx(), id, &format!("{edited}한 줄 더\n")).unwrap());
    saved(&save_append(&r, id, "새 덧붙임\r\n둘째\r\n"));
    for rel in [
        "agents/harness-builder-ui.md",
        "agents/harness-builder-ui.append.md",
    ] {
        let bytes = fs::read(r.custom.join(rel)).unwrap();
        assert!(!bytes.contains(&b'\r'), "{rel} 가 LF 가 아니다");
        assert!(
            !bytes.starts_with(&[0xEF, 0xBB, 0xBF]),
            "{rel} 에 BOM 이 남았다"
        );
    }
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.append.md"),
        "새 덧붙임\n둘째\n"
    );
}

/// 버그 후보(작음) — 메모장이 CRLF 로 저장한 통째 글을 화면 읽기(`read_item`)가 CR 그대로 준다 (BOM 은 뗀다 · 덧붙임은 LF 로 맞춰 읽는 것과 다르다).
/// 그래서 같은 글을 그대로 저장해도 `changed: true` 로 파일을 다시 쓴다. 데이터를 잃지는 않는다 (저장하면 LF).
#[test]
fn a_crlf_replaced_text_is_read_as_lf_and_saving_the_same_text_changes_nothing() {
    let r = root("conflict-crlf-read");
    let id = "agent:harness-builder-ui";
    saved(&flow::replace_start(&state(), &r.ctx(), id).unwrap());
    fs::write(
        r.custom.join("agents/harness-builder-ui.md"),
        crlf(SOURCE_AGENT_UI),
    )
    .unwrap();
    let ctx = r.ctx();
    match items::read_item(&Env::new(&ctx), id).unwrap() {
        nyanitor_lib::custom::model::ItemRead::Ok(detail) => {
            use nyanitor_lib::custom::model::TextPart;
            let TextPart::Text { text } = &detail.replace_text else {
                panic!("{:?}", detail.replace_text)
            };
            assert!(!text.contains('\r'), "CR 이 남았다: {text:?}");
        }
        other => panic!("{other:?}"),
    }
    let same = flow::save_text(&state(), &r.ctx(), id, SOURCE_AGENT_UI).unwrap();
    saved(&same);
    assert!(!same.changed, "같은 글인데 다시 썼다");
}

#[test]
fn a_notepad_saved_crlf_file_with_the_same_text_is_a_git_change_that_applies_cleanly_and_never_grows_the_origin_flag()
 {
    let r = root("conflict-crlf-apply");
    let id = "agent:harness-builder-ui";
    saved(&save_append(&r, id, "덧붙임\n"));
    assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    // 메모장이 같은 글을 CRLF 로 다시 저장
    fs::write(
        r.custom.join("agents/harness-builder-ui.append.md"),
        "덧붙임\r\n",
    )
    .unwrap();
    // 같은 글을 저장하려 하면 바뀐 것이 없다 — 파일은 건드리지 않는다
    let again = save_append(&r, id, "덧붙임\n");
    saved(&again);
    assert!(!again.changed);
    // 줄바꿈만 다른 파일이 적용 안 한 것으로 잡혀도 적용은 된다
    let count = unapplied_count(&r);
    assert!(count <= 1, "{count}");
    if count == 1 {
        assert_eq!(apply(&r).outcome, ApplyOutcome::Applied);
    }
    assert_eq!(unapplied_count(&r), 0);
}
