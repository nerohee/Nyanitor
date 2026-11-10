//! 보이는 이름 · 고양이 여러 줄 시험 (P9-03, D-41 · D-52) — `custom/agent-labels.json` 읽기 · 쓰기(그 파일만 바로 커밋, 종류 `labels`) · 규칙 어긋남 거절 · git 없음,
//! `agent-cats.json` 여러 줄 한 번에 쓰기(커밋 하나 · 하나라도 틀리면 아무것도 안 씀).

mod common;

use std::fs;

use common::*;
use nyanitor_lib::custom::cats::{self, CatChange};
use nyanitor_lib::custom::labels;
use nyanitor_lib::custom::model::{CatsState, CommitKind, CommitOutcome, FileStatus, WriteOutcome};
use nyanitor_lib::custom::values::Values;
use nyanitor_lib::custom::{Env, flow, history, items};
use nyanitor_lib::harness::HarnessState;

fn label(
    r: &CustomRoot,
    agent: &str,
    label: Option<&str>,
) -> nyanitor_lib::custom::model::CatsWriteResult {
    flow::labels_write(&HarnessState::default(), &r.ctx(), agent, label).unwrap()
}

fn change(agent: &str, cat: Option<&str>) -> CatChange {
    CatChange {
        agent: agent.to_string(),
        cat: cat.map(str::to_string),
    }
}

fn cats_many(
    r: &CustomRoot,
    changes: &[CatChange],
) -> nyanitor_lib::custom::model::CatsWriteResult {
    flow::cats_write_many(&HarnessState::default(), &r.ctx(), changes).unwrap()
}

/// 적용 안 한 값 파일 하나 (다른 적용 안 한 것이 그대로인지 보려고)
fn leave_one_unapplied(r: &CustomRoot) {
    let result = flow::save_values(
        &HarnessState::default(),
        &r.ctx(),
        "agent:harness-builder-ui",
        &Values {
            model: Some("opus".into()),
            effort: None,
        },
    )
    .unwrap();
    assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
}

fn unapplied_paths(r: &CustomRoot) -> Vec<(String, FileStatus)> {
    let ctx = r.ctx();
    items::list(&Env::new(&ctx))
        .unapplied
        .files
        .into_iter()
        .map(|f| (f.path, f.status))
        .collect()
}

fn commit_count(r: &CustomRoot) -> usize {
    r.subjects().len()
}

const ONLY_UI_UNAPPLIED: &str = "agents/harness-builder-ui.values.yml";

// ───────────────────────────── 보이는 이름 ─────────────────────────────

#[test]
fn a_label_is_written_and_committed_alone_with_the_labels_kind_leaving_other_unapplied_changes() {
    let r = CustomRoot::new("labels-write");
    assert_eq!(labels::read(&Env::new(&r.ctx())).state, CatsState::Absent);
    leave_one_unapplied(&r);
    let result = label(&r, "translator", Some("번역"));
    assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
    assert!(result.changed);
    assert_eq!(result.commit, CommitOutcome::Committed, "{result:?}");
    assert_eq!(
        r.read_custom("agent-labels.json"),
        "{\n  \"version\": 1,\n  \"agents\": {\n    \"translator\": \"번역\"\n  }\n}\n"
    );
    // 처음 기록 + 이 커밋 하나, 그 파일만, 종류 `labels`
    assert_eq!(r.subjects(), ["보이는 이름을 바꿈", "처음 기록"]);
    assert_eq!(
        r.git(&["show", "--name-only", "--format=%s", "HEAD"])
            .lines()
            .collect::<Vec<_>>(),
        ["보이는 이름을 바꿈", "", "agent-labels.json"]
    );
    assert!(
        r.git(&["log", "-1", "--format=%B"])
            .contains("Nyanitor-Kind: labels")
    );
    let ctx = r.ctx();
    let listing = history::list(&Env::new(&ctx));
    assert_eq!(listing.commits[0].kind, CommitKind::Labels);
    assert_eq!(listing.commits[0].files, ["agent-labels.json"]);
    // 다른 적용 안 한 것은 그대로
    assert_eq!(
        unapplied_paths(&r),
        [(ONLY_UI_UNAPPLIED.to_string(), FileStatus::Added)]
    );
    let read = labels::read(&Env::new(&ctx));
    assert_eq!(read.state, CatsState::Ok);
    assert_eq!(
        read.agents.get("translator").map(String::as_str),
        Some("번역")
    );
    // 같은 이름을 다시 쓰면 바뀐 것이 없다 — 커밋도 없다
    let again = label(&r, "translator", Some("번역"));
    assert!(!again.changed && again.commit == CommitOutcome::Skipped);
    assert_eq!(commit_count(&r), 2);
    // 다른 에이전트 추가 · 바꾸기
    label(&r, "summarizer", Some("요약"));
    label(&r, "translator", Some("번역가"));
    let read = labels::read(&Env::new(&ctx));
    assert_eq!(read.agents.len(), 2);
    assert_eq!(read.agents["translator"], "번역가");
    assert_eq!(commit_count(&r), 4);
    // 설치 스크립트가 보는 파일이 아니다 — 고양이 파일은 건드리지 않았다
    assert!(!r.custom_exists("agent-cats.json"));
}

#[test]
fn a_label_is_trimmed_and_an_empty_or_null_one_removes_the_line() {
    let r = CustomRoot::new("labels-trim");
    label(&r, "translator", Some("  번역 \t"));
    assert_eq!(
        labels::read(&Env::new(&r.ctx())).agents["translator"],
        "번역"
    );
    assert!(r.read_custom("agent-labels.json").contains("\"번역\""));
    label(&r, "summarizer", Some("요약"));
    // 뗀 뒤 빈 글 = 지움
    let removed = label(&r, "translator", Some("   "));
    assert!(removed.changed && removed.commit == CommitOutcome::Committed);
    let read = labels::read(&Env::new(&r.ctx()));
    assert_eq!(read.agents.len(), 1);
    assert!(!read.agents.contains_key("translator"));
    // `null` = 지움
    let removed = label(&r, "summarizer", None);
    assert!(removed.changed && removed.commit == CommitOutcome::Committed);
    let read = labels::read(&Env::new(&r.ctx()));
    assert_eq!(read.state, CatsState::Ok);
    assert!(read.agents.is_empty());
    // 이미 없는 것을 지우면 바뀐 것이 없다
    let before = commit_count(&r);
    let nothing = label(&r, "summarizer", None);
    assert!(!nothing.changed && nothing.commit == CommitOutcome::Skipped);
    assert_eq!(commit_count(&r), before);
}

#[test]
fn removing_a_label_when_there_is_no_file_creates_nothing() {
    let r = CustomRoot::new("labels-nofile");
    for wanted in [None, Some(""), Some("  ")] {
        let result = label(&r, "translator", wanted);
        assert_eq!(result.outcome, WriteOutcome::Saved);
        assert!(!result.changed, "{wanted:?}");
    }
    assert!(!r.custom.exists(), "파일도 기록도 만들지 않는다");
}

#[test]
fn a_label_that_breaks_the_rule_is_refused_and_nothing_is_written() {
    let r = CustomRoot::new("labels-bad");
    label(&r, "translator", Some("번역"));
    let before_file = r.read_custom("agent-labels.json");
    let before_commits = commit_count(&r);
    let too_long = "가".repeat(21);
    for bad in [
        too_long.as_str(),
        "줄\n바꿈",
        "줄\r\n바꿈",
        "탭\t안",
        "제어\u{1b}문자",
        "문단\u{2029}나눔",
    ] {
        let result = label(&r, "translator", Some(bad));
        assert_eq!(result.outcome, WriteOutcome::Refused, "{bad:?}");
        assert_eq!(result.reason.as_deref(), Some("bad_label"), "{bad:?}");
        assert!(!result.changed && result.commit == CommitOutcome::Skipped);
    }
    assert_eq!(r.read_custom("agent-labels.json"), before_file);
    assert_eq!(commit_count(&r), before_commits);
    // 20 글자(문자 수)는 된다 — 바이트가 아니다
    let max = "가".repeat(20);
    assert!(label(&r, "translator", Some(&max)).changed);
    // 파일이 없을 때 어긋난 이름은 파일도 만들지 않는다
    let r = CustomRoot::new("labels-bad-nofile");
    let result = label(&r, "translator", Some("a\nb"));
    assert_eq!(result.reason.as_deref(), Some("bad_label"));
    assert!(!r.custom.exists());
}

#[test]
fn a_wrong_agent_name_is_an_input_error_and_main_is_not_taken() {
    let r = CustomRoot::new("labels-agent");
    let state = HarnessState::default();
    for agent in ["main", "Bad", "../x", "a/b", "", "a b", &"a".repeat(65)] {
        let error = flow::labels_write(&state, &r.ctx(), agent, Some("이름")).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{agent:?}");
    }
    flow::labels_write(&state, &r.ctx(), &"a".repeat(64), Some("이름")).unwrap();
    // 하네스 작업자 이름이라도 모양만 본다 (화면이 직접 만든 에이전트에만 칸을 둔다)
    assert!(label(&r, "harness-designer", Some("물감")).changed);
}

#[test]
fn labels_keep_unknown_keys_and_their_order_and_refuse_a_broken_oversized_or_non_utf8_file() {
    let r = CustomRoot::new("labels-keep");
    r.write_custom(
        "agent-labels.json",
        "{\n  \"zzz\": {\"future\": [1, 2]},\n  \"version\": 1,\n  \"agents\": {\n    \"translator\": \"번역\",\n    \"future-agent\": \"미래\"\n  }\n}\n",
    );
    label(&r, "summarizer", Some("요약"));
    assert_eq!(
        r.read_custom("agent-labels.json"),
        "{\n  \"zzz\": {\"future\": [1, 2]},\n  \"version\": 1,\n  \"agents\": {\n    \"translator\": \"번역\",\n    \"future-agent\": \"미래\",\n    \"summarizer\": \"요약\"\n  }\n}\n"
    );
    // 깨진 파일은 덮어쓰지 않는다
    r.write_custom("agent-labels.json", "{ broken");
    let result = label(&r, "translator", Some("번역"));
    assert_eq!(result.outcome, WriteOutcome::Refused);
    assert_eq!(result.reason.as_deref(), Some("unreadable"));
    assert_eq!(r.read_custom("agent-labels.json"), "{ broken");
    assert_eq!(
        labels::read(&Env::new(&r.ctx())).state,
        CatsState::Unreadable
    );
    // 객체가 아닌 파일 · agents 가 객체가 아닌 파일
    for text in ["[]", "{\"agents\": 3}", "{\"agents\": [1]}"] {
        r.write_custom("agent-labels.json", text);
        let result = label(&r, "translator", Some("번역"));
        assert_eq!(result.reason.as_deref(), Some("unreadable"), "{text}");
        assert_eq!(r.read_custom("agent-labels.json"), text);
    }
    // 256KB 를 넘는 파일
    let big = format!("{{\"pad\": \"{}\"}}", "x".repeat(300 * 1024));
    r.write_custom("agent-labels.json", &big);
    let result = label(&r, "translator", Some("번역"));
    assert_eq!(result.outcome, WriteOutcome::Refused);
    assert_eq!(result.reason.as_deref(), Some("too_large"));
    assert_eq!(r.read_custom("agent-labels.json"), big);
    assert_eq!(
        labels::read(&Env::new(&r.ctx())).state,
        CatsState::Unreadable
    );
    // UTF-8 이 아닌 파일
    fs::write(r.custom.join("agent-labels.json"), [0xff, 0xfe, 0x00, 0x7b]).unwrap();
    let result = label(&r, "translator", Some("번역"));
    assert_eq!(result.reason.as_deref(), Some("unreadable"));
    assert_eq!(
        fs::read(r.custom.join("agent-labels.json")).unwrap(),
        [0xff, 0xfe, 0x00, 0x7b]
    );
}

#[test]
fn reading_labels_skips_hand_edited_lines_that_break_the_rule() {
    let r = CustomRoot::new("labels-read");
    let long = "가".repeat(21);
    r.write_custom(
        "agent-labels.json",
        &format!(
            "{{\"version\":1,\"agents\":{{\"translator\":\" 번역 \",\"main\":\"먹물\",\"Bad\":\"x\",\"long\":\"{long}\",\"multi\":\"a\\nb\",\"empty\":\"  \",\"num\":3,\"ok-one\":\"좋아\"}}}}"
        ),
    );
    let read = labels::read(&Env::new(&r.ctx()));
    assert_eq!(read.state, CatsState::Ok);
    let got: Vec<(&str, &str)> = read
        .agents
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(got, [("ok-one", "좋아"), ("translator", "번역")]);
    // 읽기는 기록을 시작하지 않는다
    assert!(!r.custom_exists(".git"));
}

#[test]
fn labels_are_written_without_git_and_the_commit_says_no_git() {
    let r = CustomRoot::new("labels-nogit");
    let ctx = r.ctx_without_git();
    let result =
        flow::labels_write(&HarnessState::default(), &ctx, "translator", Some("번역")).unwrap();
    assert_eq!(result.outcome, WriteOutcome::Saved);
    assert!(result.changed);
    assert_eq!(result.commit, CommitOutcome::NoGit, "{result:?}");
    assert!(
        r.read_custom("agent-labels.json")
            .contains("\"translator\": \"번역\"")
    );
    assert!(
        !r.custom_exists(".git"),
        "git 이 없으면 저장소도 만들지 않는다"
    );
    assert_eq!(labels::read(&Env::new(&ctx)).agents["translator"], "번역");
}

// ───────────────────────────── 고양이 여러 줄 ─────────────────────────────

#[test]
fn a_cat_swap_of_two_lines_is_one_write_and_one_commit_leaving_other_unapplied_changes() {
    let r = CustomRoot::new("cats-swap");
    cats::write(&Env::new(&r.ctx()), "ui", Some("danchu")).unwrap();
    cats::write(&Env::new(&r.ctx()), "designer", Some("mulgam")).unwrap();
    leave_one_unapplied(&r);
    let before = commit_count(&r);
    let result = cats_many(
        &r,
        &[
            change("ui", Some("mulgam")),
            change("designer", Some("danchu")),
        ],
    );
    assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
    assert!(result.changed);
    assert_eq!(result.commit, CommitOutcome::Committed, "{result:?}");
    // 파일은 한 번에 바뀌었고 커밋은 하나 늘었다 (맞바꿈이 중간 모습으로 남지 않는다)
    assert_eq!(commit_count(&r), before + 1);
    assert_eq!(
        r.git(&["show", "--name-only", "--format=%s", "HEAD"])
            .lines()
            .collect::<Vec<_>>(),
        ["고양이 연결 바꿈", "", "agent-cats.json"]
    );
    assert!(
        r.git(&["log", "-1", "--format=%B"])
            .contains("Nyanitor-Kind: cats")
    );
    assert_eq!(
        r.read_custom("agent-cats.json"),
        "{\n  \"version\": 1,\n  \"agents\": {\n    \"ui\": \"mulgam\",\n    \"designer\": \"danchu\"\n  }\n}\n"
    );
    assert_eq!(
        result.commit_short.as_deref(),
        Some(&r.git(&["rev-parse", "HEAD"])[..7])
    );
    assert_eq!(
        unapplied_paths(&r),
        [(ONLY_UI_UNAPPLIED.to_string(), FileStatus::Added)]
    );
}

#[test]
fn many_cat_lines_can_mix_setting_and_removing_and_unchanged_lines() {
    let r = CustomRoot::new("cats-mix");
    cats_many(
        &r,
        &[
            change("main", Some("mukmul")),
            change("ui", Some("danchu")),
            change("system", Some("nabi")),
        ],
    );
    assert_eq!(commit_count(&r), 2, "처음 기록 + 커밋 하나");
    // 지움 + 바꿈 + 그대로 + 새 줄
    let result = cats_many(
        &r,
        &[
            change("ui", None),
            change("system", Some("dubu")),
            change("main", Some("mukmul")),
            change("tester", Some("kkaebi")),
        ],
    );
    assert!(result.changed && result.commit == CommitOutcome::Committed);
    assert_eq!(commit_count(&r), 3);
    let read = cats::read(&Env::new(&r.ctx()));
    let got: Vec<(&str, &str)> = read
        .agents
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(
        got,
        [("main", "mukmul"), ("system", "dubu"), ("tester", "kkaebi")]
    );
    // 모두 기본값으로 — 줄을 모두 지운다 (파일은 남고 agents 는 비어 있다)
    let reset = cats_many(
        &r,
        &[
            change("main", None),
            change("system", None),
            change("tester", None),
        ],
    );
    assert!(reset.changed && reset.commit == CommitOutcome::Committed);
    assert_eq!(commit_count(&r), 4);
    let read = cats::read(&Env::new(&r.ctx()));
    assert_eq!(read.state, CatsState::Ok);
    assert!(read.agents.is_empty());
}

#[test]
fn many_cat_lines_keep_unknown_keys_and_their_order() {
    let r = CustomRoot::new("cats-many-keep");
    r.write_custom(
        "agent-cats.json",
        "{\n  \"zzz\": {\"future\": [1, 2]},\n  \"version\": 1,\n  \"agents\": {\n    \"ui\": \"danchu\",\n    \"future-agent\": \"someone\"\n  }\n}\n",
    );
    cats_many(&r, &[change("system", Some("nabi")), change("ui", None)]);
    assert_eq!(
        r.read_custom("agent-cats.json"),
        "{\n  \"zzz\": {\"future\": [1, 2]},\n  \"version\": 1,\n  \"agents\": {\n    \"future-agent\": \"someone\",\n    \"system\": \"nabi\"\n  }\n}\n"
    );
}

#[test]
fn nothing_changed_means_no_write_and_no_commit_and_removing_from_no_file_creates_nothing() {
    let r = CustomRoot::new("cats-same");
    // 파일이 없는데 모두 지우라는 것 — 아무것도 만들지 않는다
    let none = cats_many(&r, &[change("ui", None), change("system", None)]);
    assert_eq!(none.outcome, WriteOutcome::Saved);
    assert!(!none.changed);
    assert!(!r.custom.exists());
    cats_many(
        &r,
        &[change("ui", Some("danchu")), change("system", Some("nabi"))],
    );
    let before = commit_count(&r);
    let file = r.read_custom("agent-cats.json");
    let same = cats_many(
        &r,
        &[change("system", Some("nabi")), change("ui", Some("danchu"))],
    );
    assert_eq!(same.outcome, WriteOutcome::Saved);
    assert!(!same.changed);
    assert_eq!(same.commit, CommitOutcome::Skipped);
    assert_eq!(same.commit_short, None);
    assert_eq!(commit_count(&r), before);
    assert_eq!(r.read_custom("agent-cats.json"), file);
    // 이미 없는 줄을 지우는 것도 바뀐 것이 없다
    assert!(!cats_many(&r, &[change("helper", None)]).changed);
    assert_eq!(commit_count(&r), before);
}

#[test]
fn one_wrong_line_writes_nothing_at_all() {
    let r = CustomRoot::new("cats-wrong");
    cats_many(&r, &[change("ui", Some("danchu"))]);
    let file = r.read_custom("agent-cats.json");
    let before = commit_count(&r);
    let state = HarnessState::default();
    let many: Vec<CatChange> = (0..65)
        .map(|i| change(&format!("agent-{i}"), Some("nabi")))
        .collect();
    let cases: Vec<(&str, Vec<CatChange>)> = vec![
        ("빈 목록", vec![]),
        ("65 줄", many),
        (
            "같은 agent 두 번",
            vec![change("ui", Some("nabi")), change("ui", Some("mulgam"))],
        ),
        (
            "같은 agent 지움과 바꿈",
            vec![change("ui", None), change("ui", Some("mulgam"))],
        ),
        (
            "뒤의 줄만 틀린 이름",
            vec![change("system", Some("nabi")), change("Bad", Some("nabi"))],
        ),
        (
            "뒤의 줄만 틀린 고양이",
            vec![
                change("system", Some("nabi")),
                change("ui", Some("Bad Cat")),
            ],
        ),
        (
            "경로 모양 이름",
            vec![change("system", Some("nabi")), change("../x", None)],
        ),
        (
            "빈 고양이 id",
            vec![change("system", Some("nabi")), change("ui", Some(""))],
        ),
    ];
    for (name, changes) in cases {
        let error = flow::cats_write_many(&state, &r.ctx(), &changes).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{name}");
        assert_eq!(r.read_custom("agent-cats.json"), file, "{name}");
        assert_eq!(commit_count(&r), before, "{name}");
    }
    // 64 줄은 된다
    let ok: Vec<CatChange> = (0..64)
        .map(|i| change(&format!("agent-{i}"), Some("nabi")))
        .collect();
    assert!(cats_many(&r, &ok).changed);
}

#[test]
fn a_broken_cats_file_is_not_overwritten_by_many_lines() {
    let r = CustomRoot::new("cats-broken");
    r.write_custom("agent-cats.json", "{ broken");
    let result = cats_many(&r, &[change("ui", Some("danchu")), change("system", None)]);
    assert_eq!(result.outcome, WriteOutcome::Refused);
    assert_eq!(result.reason.as_deref(), Some("unreadable"));
    assert!(!result.changed);
    assert_eq!(r.read_custom("agent-cats.json"), "{ broken");
    // 길 중간이 객체가 아닌 파일은 줄을 하나도 쓰지 않는다
    r.write_custom("agent-cats.json", "{\"agents\": 3}");
    let result = cats_many(&r, &[change("ui", Some("danchu"))]);
    assert_eq!(result.reason.as_deref(), Some("unreadable"));
    assert_eq!(r.read_custom("agent-cats.json"), "{\"agents\": 3}");
}

#[test]
fn many_cat_lines_are_written_without_git_and_the_commit_says_no_git() {
    let r = CustomRoot::new("cats-many-nogit");
    let ctx = r.ctx_without_git();
    let result = flow::cats_write_many(
        &HarnessState::default(),
        &ctx,
        &[
            change("ui", Some("mulgam")),
            change("designer", Some("danchu")),
        ],
    )
    .unwrap();
    assert_eq!(result.outcome, WriteOutcome::Saved);
    assert!(result.changed);
    assert_eq!(result.commit, CommitOutcome::NoGit, "{result:?}");
    let file = r.read_custom("agent-cats.json");
    assert!(file.contains("\"ui\": \"mulgam\"") && file.contains("\"designer\": \"danchu\""));
    assert!(!r.custom_exists(".git"));
}

#[test]
fn the_single_line_cat_write_still_works_on_top_of_the_shared_path() {
    let r = CustomRoot::new("cats-single");
    let state = HarnessState::default();
    let result = flow::cats_write(&state, &r.ctx(), "designer", Some("mulgam")).unwrap();
    assert!(result.changed && result.commit == CommitOutcome::Committed);
    assert_eq!(
        r.read_custom("agent-cats.json"),
        "{\n  \"version\": 1,\n  \"agents\": {\n    \"designer\": \"mulgam\"\n  }\n}\n"
    );
    assert_eq!(r.subjects(), ["고양이 연결 바꿈", "처음 기록"]);
}
