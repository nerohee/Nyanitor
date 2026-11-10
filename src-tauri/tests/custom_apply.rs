//! 내 수정 적용 · 되돌리기 · 원본 업데이트 받음 시험 (P9-01, D-51) — 가짜 설치 스크립트(`tests/fixtures/custom/install.*`)가 녹화한 JSON 을 내보낸다.
//! 설치가 성공일 때만 커밋하고, 실패하면 커밋 없이 적용 안 한 것으로 남고, 잠겨 있으면 `harness_busy` 이며, 어느 때로 되돌리기는 새 커밋(이력은 그대로)이다.
//! 실제 `~/.claude` · `~/.claude-harness` 는 건드리지 않는다.

mod common;

use std::fs;

use common::*;
use nyanitor_lib::custom::cats;
use nyanitor_lib::custom::model::{
    ApplyOutcome, ApplyResult, CommitKind, CommitOutcome, FileStatus, HistoryState, RestoreOutcome,
    RestoreResult, WriteOutcome,
};
use nyanitor_lib::custom::values::Values;
use nyanitor_lib::custom::write::NewItem;
use nyanitor_lib::custom::{Env, flow, history, items};
use nyanitor_lib::harness::git::GitOutcome;
use nyanitor_lib::harness::script::ScriptOutcome;
use nyanitor_lib::harness::{Context, HarnessState};

fn values(model: Option<&str>, effort: Option<&str>) -> Values {
    Values {
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
    }
}

fn save(r: &CustomRoot, id: &str, model: &str) {
    let result = flow::save_values(
        &HarnessState::default(),
        &r.ctx(),
        id,
        &values(Some(model), None),
    )
    .unwrap();
    assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
}

fn apply(r: &CustomRoot, summary: Option<&str>) -> ApplyResult {
    flow::apply(&HarnessState::default(), &r.ctx(), summary).unwrap()
}

fn restore(r: &CustomRoot, hash: &str) -> RestoreResult {
    flow::restore_to(&HarnessState::default(), &r.ctx(), hash).unwrap()
}

fn unapplied_count(r: &CustomRoot) -> u32 {
    let ctx = r.ctx();
    items::list(&Env::new(&ctx)).unapplied.count
}

fn head(r: &CustomRoot) -> String {
    r.git(&["rev-parse", "HEAD"])
}

fn history_list(r: &CustomRoot) -> Vec<nyanitor_lib::custom::model::CommitEntry> {
    let ctx = r.ctx();
    history::list(&Env::new(&ctx)).commits
}

// ───────────────────────────── 적용 ─────────────────────────────

#[test]
fn a_successful_install_makes_one_commit_and_leaves_nothing_unapplied() {
    let r = CustomRoot::new("apply-ok").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    assert_eq!(unapplied_count(&r), 1);
    let before = head(&r);
    let result = apply(&r, None);
    assert_eq!(result.outcome, ApplyOutcome::Applied, "{result:?}");
    assert_eq!(result.commit, CommitOutcome::Committed);
    assert_eq!(result.files, 1);
    let script = result.script.as_ref().unwrap();
    assert_eq!(script.outcome, ScriptOutcome::Ran);
    assert!(script.report.as_ref().unwrap().ok);
    assert_eq!(unapplied_count(&r), 0);
    assert_ne!(head(&r), before);
    assert_eq!(result.commit_short.as_deref(), Some(&head(&r)[..7]));
    assert_eq!(r.subjects(), ["적용 — 파일 1개", "처음 기록"]);
    assert_eq!(history_list(&r)[0].kind, CommitKind::Apply);
    // 설치는 한 번, 그때 내 수정 폴더에 값 파일이 있었다
    assert_eq!(
        r.script_calls(),
        [(
            "install".to_string(),
            vec!["agents/harness-builder-ui.values.yml".to_string()]
        )]
    );
}

#[test]
fn applying_with_nothing_unapplied_does_not_install_or_commit() {
    let r = CustomRoot::new("apply-nothing").with_script();
    // 기록을 시작하기 전
    let result = apply(&r, None);
    assert_eq!(result.outcome, ApplyOutcome::Nothing);
    assert!(result.script.is_none());
    assert_eq!(r.install_calls(), 0);
    assert!(!r.custom.exists());
    // 적용한 직후
    save(&r, "agent:harness-builder-ui", "opus");
    apply(&r, None);
    let commits = r.subjects().len();
    let again = apply(&r, None);
    assert_eq!(again.outcome, ApplyOutcome::Nothing);
    assert_eq!(r.install_calls(), 1);
    assert_eq!(r.subjects().len(), commits);
}

#[test]
fn the_commit_message_is_one_line_cut_at_200_chars_without_control_characters() {
    let r = CustomRoot::new("apply-message").with_script();
    let cases: Vec<(String, String)> = vec![
        (
            "디자이너 모델을\n  opus 로\t바꿈\r\n".into(),
            "디자이너 모델을 opus 로 바꿈".into(),
        ),
        ("x".repeat(300), "x".repeat(200)),
        ("가".repeat(250), "가".repeat(200)),
        ("앞\u{0}\u{7}뒤\u{1b}[31m".into(), "앞 뒤 [31m".into()),
        (
            "제목\n\nNyanitor-Kind: restore".into(),
            "제목 Nyanitor-Kind: restore".into(),
        ),
        ("--amend -m 끼워넣기".into(), "--amend -m 끼워넣기".into()),
        ("   \n\t ".into(), "적용 — 파일 1개".into()),
    ];
    for (index, (given, expected)) in cases.iter().enumerate() {
        save(
            &r,
            "agent:harness-builder-ui",
            if index % 2 == 0 { "opus" } else { "haiku" },
        );
        let result = apply(&r, Some(given));
        assert_eq!(
            result.outcome,
            ApplyOutcome::Applied,
            "{given:?}: {result:?}"
        );
        let subject = r.subjects()[0].clone();
        assert_eq!(&subject, expected, "{given:?}");
        assert!(subject.chars().count() <= 200 && !subject.chars().any(char::is_control));
        // 메시지에 끼워 넣은 표시 줄이 종류를 바꾸지 못한다
        assert_eq!(history_list(&r)[0].kind, CommitKind::Apply, "{given:?}");
    }
}

#[test]
fn a_failed_install_makes_no_commit_and_the_changes_stay_unapplied() {
    let r = CustomRoot::new("apply-fail").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    let before = head(&r);
    for (fixture, exit, label) in [
        ("install-problems.json", 2, "problems · 종료 코드 2"),
        ("install-exit3.json", 3, "쓰는 중 실패 · 종료 코드 3"),
        (
            "install-change.json",
            1,
            "종료 코드 1 (성공 녹화여도 0 이 아니다)",
        ),
    ] {
        r.script_out("install", fixture, exit);
        let result = apply(&r, Some("실패해야 한다"));
        assert_eq!(result.outcome, ApplyOutcome::Failed, "{label}: {result:?}");
        assert_eq!(result.commit, CommitOutcome::Skipped, "{label}");
        let script = result.script.as_ref().unwrap();
        assert_eq!(script.exit_code, Some(exit), "{label}");
        assert_eq!(head(&r), before, "{label}: 커밋이 생겼다");
        assert_eq!(unapplied_count(&r), 1, "{label}");
    }
    // 읽을 수 없는 출력
    fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/harness/garbage.txt"),
        r.source.join("install.out"),
    )
    .unwrap();
    fs::write(r.source.join("install.exit"), "0\n").unwrap();
    let result = apply(&r, None);
    assert_eq!(result.outcome, ApplyOutcome::Failed);
    assert_eq!(
        result.script.as_ref().unwrap().outcome,
        ScriptOutcome::Unreadable
    );
    assert_eq!(head(&r), before);
    // 설치 스크립트가 없다
    fs::remove_file(r.source.join(nyanitor_lib::harness::locate::script_name())).unwrap();
    let result = apply(&r, None);
    assert_eq!(result.outcome, ApplyOutcome::Failed);
    assert_eq!(
        result.script.as_ref().unwrap().outcome,
        ScriptOutcome::NoScript
    );
    assert_eq!(head(&r), before);
    assert_eq!(unapplied_count(&r), 1);
    // 고친 뒤 다시 적용하면 그동안 모인 것이 한 번에 커밋된다
    fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/custom")
            .join(nyanitor_lib::harness::locate::script_name()),
        r.source.join(nyanitor_lib::harness::locate::script_name()),
    )
    .unwrap();
    r.script_out("install", "install-change.json", 0);
    let result = apply(&r, None);
    assert_eq!(result.outcome, ApplyOutcome::Applied);
    assert_eq!(unapplied_count(&r), 0);
}

#[test]
fn the_commit_kind_is_new_only_when_a_new_agent_or_skill_goes_in() {
    let r = CustomRoot::new("apply-kind").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    apply(&r, None);
    // 통째 시작은 원본에 있는 경로의 새 파일이라 `new` 가 아니다
    flow::replace_start(&HarnessState::default(), &r.ctx(), "agent:harness-designer").unwrap();
    apply(&r, None);
    flow::create(
        &HarnessState::default(),
        &r.ctx(),
        &NewItem {
            kind: "skill".into(),
            name: "translate-docs".into(),
            description: "번역".into(),
            model: None,
            effort: None,
        },
    )
    .unwrap();
    apply(&r, None);
    let kinds: Vec<CommitKind> = history_list(&r).iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            CommitKind::New,
            CommitKind::Apply,
            CommitKind::Apply,
            CommitKind::Start
        ]
    );
}

#[test]
fn applying_clears_what_the_app_remembered_about_the_install_preview() {
    let r = CustomRoot::new("apply-forget").with_script();
    r.script_out("plan", "plan-same.json", 0);
    let state = HarnessState::default();
    let ctx = r.ctx();
    let plan = nyanitor_lib::harness::flow::install_plan(&state, &ctx).unwrap();
    assert_eq!(plan.outcome, ScriptOutcome::Ran);
    // 미리보기를 본 뒤라면 설치할 수 있다 (같은 상태에서 한 번 시험)
    flow::save_values(
        &state,
        &ctx,
        "agent:harness-builder-ui",
        &values(Some("opus"), None),
    )
    .unwrap();
    // 적용이 설치를 돌리면 본 것이 낡았다 — 설치 화면의 설치는 미리보기를 다시 보게 한다
    let applied = flow::apply(&state, &ctx, None).unwrap();
    assert_eq!(applied.outcome, ApplyOutcome::Applied);
    let install = nyanitor_lib::harness::flow::install(&state, &ctx).unwrap();
    assert_eq!(install.outcome, ScriptOutcome::Refused);
    assert_eq!(install.reason.as_deref(), Some("plan_first"));
}

// ───────────────────────────── 한 번에 하나 ─────────────────────────────

#[test]
fn every_writing_call_is_refused_with_harness_busy_while_another_harness_task_holds_the_lock() {
    let r = CustomRoot::new("apply-busy").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    let state = HarnessState::default();
    let ctx = r.ctx();
    let guard = state.begin().unwrap();
    let id = "agent:harness-designer";
    let request = NewItem {
        kind: "agent".into(),
        name: "busy-one".into(),
        description: "x".into(),
        model: None,
        effort: None,
    };
    let errors = [
        flow::save_values(&state, &ctx, id, &values(Some("haiku"), None)).err(),
        flow::save_append(&state, &ctx, id, "x").err(),
        flow::replace_start(&state, &ctx, id).err(),
        flow::save_text(&state, &ctx, id, "x").err(),
        flow::replace_stop(&state, &ctx, id).err(),
        flow::origin_keep(&state, &ctx, id).err(),
        flow::create(&state, &ctx, &request).err(),
        flow::delete_mine(&state, &ctx, id).err(),
        flow::discard(&state, &ctx).err(),
        flow::apply(&state, &ctx, None).err(),
        flow::restore_to(&state, &ctx, "abcdef1").err(),
        flow::cats_write(&state, &ctx, "main", Some("mukmul")).err(),
        flow::cats_write_many(
            &state,
            &ctx,
            &[cats::CatChange {
                agent: "main".into(),
                cat: Some("mukmul".into()),
            }],
        )
        .err(),
        flow::labels_write(&state, &ctx, "translator", Some("번역")).err(),
    ];
    for (index, error) in errors.into_iter().enumerate() {
        assert_eq!(
            error
                .unwrap_or_else(|| panic!("{index} 번째 호출이 잠금을 무시했다"))
                .kind(),
            "harness_busy",
            "{index}"
        );
    }
    assert_eq!(r.install_calls(), 0, "설치가 돌지 않았다");
    assert!(
        !r.custom_exists("agents/harness-designer.values.yml")
            && !r.custom_exists("agent-cats.json")
            && !r.custom_exists("agent-labels.json")
    );
    assert_eq!(unapplied_count(&r), 1, "아무것도 바뀌지 않았다");
    // 읽기는 잠기지 않는다
    let list = items::list(&Env::new(&ctx));
    assert!(list.available);
    drop(guard);
    assert_eq!(
        flow::apply(&state, &ctx, None).unwrap().outcome,
        ApplyOutcome::Applied
    );
}

#[test]
fn the_lock_is_released_after_each_call_even_when_it_refuses() {
    let r = CustomRoot::new("apply-release").with_script();
    let state = HarnessState::default();
    let ctx = r.ctx();
    assert!(flow::apply(&state, &ctx, None).is_ok());
    assert!(!state.is_busy());
    assert!(flow::save_values(&state, &ctx, "agent:nothing", &values(Some("opus"), None)).is_ok());
    assert!(!state.is_busy());
    assert!(flow::save_values(&state, &ctx, "agent:../x", &values(Some("opus"), None)).is_err());
    assert!(!state.is_busy());
}

// ───────────────────────────── 어느 때로 되돌리기 ─────────────────────────────

/// 시작 → A (값 파일 하나) → B (값 바꿈 + 새 값 파일) 까지 만든 시험 폴더. `(r, A 번호, B 번호)`.
fn two_applies(name: &str) -> (CustomRoot, String, String) {
    let r = CustomRoot::new(name).with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    assert_eq!(apply(&r, Some("A")).outcome, ApplyOutcome::Applied);
    let a = head(&r);
    save(&r, "agent:harness-builder-ui", "haiku");
    save(&r, "agent:harness-designer", "sonnet");
    assert_eq!(apply(&r, Some("B")).outcome, ApplyOutcome::Applied);
    let b = head(&r);
    (r, a, b)
}

#[test]
fn restoring_puts_an_old_commits_files_back_installs_and_adds_a_new_commit_without_shrinking_the_history()
 {
    let (r, a, b) = two_applies("restore-ok");
    let commits_before = history_list(&r).len();
    let calls_before = r.script_calls().len();
    let result = restore(&r, &a);
    assert_eq!(result.outcome, RestoreOutcome::Restored, "{result:?}");
    assert_eq!(result.commit, CommitOutcome::Committed);
    // 그때 모습: B 가 더한 값 파일은 사라지고, 바꾼 값은 돌아왔다
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: opus\n"
    );
    assert!(!r.custom_exists("agents/harness-designer.values.yml"));
    assert_eq!(
        r.git(&["rev-parse", "HEAD^{tree}"]),
        r.git(&["rev-parse", &format!("{a}^{{tree}}")]),
        "작업 트리 · 새 커밋이 그 커밋의 모습과 같다"
    );
    // 이력은 그대로고 새 커밋이 하나 더해졌다 (`reset` 을 쓰지 않았다)
    let history = history_list(&r);
    assert_eq!(history.len(), commits_before + 1);
    assert_eq!(history[0].kind, CommitKind::Restore);
    assert_eq!(history[0].message, format!("{} 때로 되돌림", &a[..7]));
    assert_eq!(history[1].hash, b, "B 가 그대로 남아 있다");
    assert!(history.iter().any(|c| c.hash == a));
    assert_eq!(result.commit_short.as_deref(), Some(&head(&r)[..7]));
    // 설치는 그 모습을 보고 한 번 더 돌았다
    let calls = r.script_calls();
    assert_eq!(calls.len(), calls_before + 1);
    assert_eq!(
        calls.last().unwrap().1,
        ["agents/harness-builder-ui.values.yml"]
    );
    assert_eq!(unapplied_count(&r), 0);
    // 번호는 짧은 번호도 받는다 — B 로 다시 (이번에는 짧은 번호)
    let again = restore(&r, &b[..7]);
    assert_eq!(again.outcome, RestoreOutcome::Restored, "{again:?}");
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: haiku\n"
    );
    assert_eq!(
        r.read_custom("agents/harness-designer.values.yml"),
        "model: sonnet\n"
    );
}

#[test]
fn restoring_is_refused_while_there_are_unapplied_changes() {
    let (r, a, _b) = two_applies("restore-unapplied");
    save(&r, "agent:harness-builder-ui", "opus");
    let head_before = head(&r);
    let calls_before = r.script_calls().len();
    let result = restore(&r, &a);
    assert_eq!(result.outcome, RestoreOutcome::HasUnapplied);
    assert!(result.script.is_none());
    assert_eq!(head(&r), head_before);
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: opus\n",
        "쓰던 것이 그대로다"
    );
    assert_eq!(r.script_calls().len(), calls_before);
    assert_eq!(unapplied_count(&r), 1);
}

#[test]
fn restoring_to_what_is_already_there_or_to_an_unknown_commit_changes_nothing() {
    let (r, a, b) = two_applies("restore-same");
    let calls_before = r.script_calls().len();
    let same = restore(&r, &b);
    assert_eq!(same.outcome, RestoreOutcome::SameAsNow);
    assert!(same.script.is_none());
    let unknown = restore(&r, "deadbeef");
    assert_eq!(unknown.outcome, RestoreOutcome::UnknownCommit);
    assert_eq!(
        restore(&r, &"0".repeat(40)).outcome,
        RestoreOutcome::UnknownCommit
    );
    for bad in [
        "",
        "abc",
        "HEAD",
        "HEAD~1",
        "ABCDEF1",
        "--all",
        "abc1234 abc1234",
        "../x",
    ] {
        let error = flow::restore_to(&HarnessState::default(), &r.ctx(), bad).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{bad:?}");
    }
    assert_eq!(head(&r), b);
    assert_eq!(r.script_calls().len(), calls_before);
    // 첫 기록으로도 돌아갈 수 있다 (값 파일이 하나도 없던 때)
    let start = history_list(&r).last().unwrap().hash.clone();
    let result = restore(&r, &start);
    assert_eq!(result.outcome, RestoreOutcome::Restored);
    assert!(
        !r.custom_exists("agents/harness-builder-ui.values.yml")
            && !r.custom_exists("agents/harness-designer.values.yml")
    );
    let _ = a;
}

#[test]
fn a_failed_install_while_restoring_puts_the_work_tree_back_to_where_it_was() {
    let (r, a, b) = two_applies("restore-fail");
    for (fixture, exit) in [("install-problems.json", 2), ("install-exit3.json", 3)] {
        r.script_out("install", fixture, exit);
        let result = restore(&r, &a);
        assert_eq!(result.outcome, RestoreOutcome::Failed, "{result:?}");
        assert_eq!(result.script.as_ref().unwrap().exit_code, Some(exit));
        assert_eq!(result.commit, CommitOutcome::Skipped);
        // 되돌려 놓았다: 새 커밋 없음 · 파일은 B 그대로 · 적용 안 한 것도 없다
        assert_eq!(head(&r), b);
        assert_eq!(
            r.read_custom("agents/harness-builder-ui.values.yml"),
            "model: haiku\n"
        );
        assert_eq!(
            r.read_custom("agents/harness-designer.values.yml"),
            "model: sonnet\n"
        );
        assert_eq!(unapplied_count(&r), 0);
        assert_eq!(r.git(&["status", "--porcelain"]), "");
    }
    // 그때 설치는 A 의 모습을 보고 실패했다 (되돌려 놓기 전에 돌았다)
    assert!(r.script_calls().iter().any(|(op, files)| op == "install"
        && files == &["agents/harness-builder-ui.values.yml".to_string()]));
    // 실패 뒤에도 잠금은 풀렸고 다시 시도하면 된다
    r.script_out("install", "install-change.json", 0);
    assert_eq!(restore(&r, &a).outcome, RestoreOutcome::Restored);
}

#[test]
fn restoring_under_a_global_crlf_conversion_does_not_turn_files_into_crlf() {
    let (r, a, _b) = two_applies("restore-crlf");
    let cfg_dir = unique_dir("restore-crlf-cfg");
    let global = cfg_dir.join("gitconfig");
    fs::write(&global, "[core]\n\tautocrlf = true\n\teol = crlf\n").unwrap();
    let ctx: Context = r
        .ctx()
        .with_env("GIT_CONFIG_GLOBAL", global.as_os_str())
        .with_env("GIT_CONFIG_NOSYSTEM", "1");
    let result = flow::restore_to(&HarnessState::default(), &ctx, &a).unwrap();
    assert_eq!(result.outcome, RestoreOutcome::Restored, "{result:?}");
    let bytes = fs::read(r.custom.join("agents/harness-builder-ui.values.yml")).unwrap();
    assert_eq!(bytes, b"model: opus\n", "CRLF 로 바뀌었다: {bytes:?}");
    let _ = fs::remove_dir_all(&cfg_dir);
}

#[test]
fn restoring_brings_back_a_whole_replaced_file_and_removes_one_that_was_not_there_yet() {
    let r = CustomRoot::new("restore-replace").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    apply(&r, None);
    let plain = head(&r);
    flow::replace_start(&HarnessState::default(), &r.ctx(), "skill:web-full").unwrap();
    flow::save_append(
        &HarnessState::default(),
        &r.ctx(),
        "skill:web-full",
        "- 덧붙임\n",
    )
    .unwrap();
    apply(&r, None);
    assert!(r.custom_exists("skills/web-full/SKILL.md.origin"));
    let result = restore(&r, &plain);
    assert_eq!(result.outcome, RestoreOutcome::Restored, "{result:?}");
    assert!(
        !r.custom_exists("skills/web-full/SKILL.md")
            && !r.custom_exists("skills/web-full/SKILL.md.origin")
            && !r.custom_exists("skills/web-full/SKILL.append.md")
    );
    assert!(!r.custom_exists("skills/web-full"), "비게 된 폴더도 없다");
}

// ───────────────────────────── 원본 업데이트 받음 ─────────────────────────────

struct Origin {
    h: HarnessRoot,
    origin: std::path::PathBuf,
    ctx: Context,
    state: HarnessState,
}

impl Origin {
    fn new(name: &str) -> Self {
        let h = HarnessRoot::new(name);
        let origin = h.root.join("origin");
        make_origin_repo(&origin);
        commit_file(
            &origin,
            "agents/harness-builder-ui.md",
            SOURCE_AGENT_UI,
            "feat: 에이전트",
        );
        let ctx = h.ctx().with_origin_url(as_url(&origin));
        let state = HarnessState::default();
        let cloned = nyanitor_lib::harness::flow::clone_origin(&state, &ctx).unwrap();
        assert_eq!(cloned.outcome, GitOutcome::Cloned, "{cloned:?}");
        Self {
            h,
            origin,
            ctx,
            state,
        }
    }

    fn update(&self) -> nyanitor_lib::harness::git::GitResult {
        let checked = nyanitor_lib::harness::flow::update_check(&self.state, &self.ctx).unwrap();
        assert_eq!(checked.outcome, GitOutcome::Checked, "{checked:?}");
        nyanitor_lib::harness::flow::update_pull(&self.state, &self.ctx).unwrap()
    }
}

#[test]
fn pulling_a_harness_update_leaves_an_empty_origin_update_commit_when_the_history_has_started() {
    let o = Origin::new("origin-update");
    // 내 수정 기록을 시작한다
    let result = flow::save_values(
        &o.state,
        &o.ctx,
        "agent:harness-builder-ui",
        &values(Some("opus"), None),
    )
    .unwrap();
    assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
    let custom = o.h.locations.harness_home.join("custom");
    let commits_before = git(&custom, &["rev-list", "--count", "HEAD"]);
    commit_file(
        &o.origin,
        "agents/harness-designer.md",
        SOURCE_AGENT_DESIGNER,
        "feat: 새 에이전트",
    );
    let pulled = o.update();
    assert_eq!(pulled.outcome, GitOutcome::Updated, "{pulled:?}");
    let short = pulled.head.clone().unwrap();
    // 빈 커밋 하나 — 파일 변경이 없고, 적용 안 한 것(값 파일)은 그대로
    assert_eq!(
        git(&custom, &["log", "-1", "--format=%s"]),
        format!("원본 업데이트 받음 ({short})")
    );
    assert_eq!(
        git(&custom, &["rev-list", "--count", "HEAD"]),
        (commits_before.parse::<u32>().unwrap() + 1).to_string()
    );
    assert_eq!(
        git(&custom, &["show", "--name-only", "--format=", "HEAD"]),
        ""
    );
    assert!(git(&custom, &["log", "-1", "--format=%B"]).contains("Nyanitor-Kind: origin_update"));
    let list = items::list(&Env::new(&o.ctx));
    assert_eq!(list.unapplied.count, 1);
    assert_eq!(list.unapplied.files[0].status, FileStatus::Added);
    assert_eq!(
        history::list(&Env::new(&o.ctx)).commits[0].kind,
        CommitKind::OriginUpdate
    );
}

#[test]
fn pulling_an_update_without_a_started_history_makes_no_repository() {
    let o = Origin::new("origin-update-nohistory");
    commit_file(
        &o.origin,
        "agents/harness-designer.md",
        SOURCE_AGENT_DESIGNER,
        "feat: 새 에이전트",
    );
    let pulled = o.update();
    assert_eq!(pulled.outcome, GitOutcome::Updated);
    assert!(!o.h.locations.harness_home.join("custom").exists());
    let list = items::list(&Env::new(&o.ctx));
    assert_eq!(list.history.state, HistoryState::NotStarted);
}

#[test]
fn an_update_that_did_not_pull_leaves_no_commit() {
    let o = Origin::new("origin-update-refused");
    flow::save_values(
        &o.state,
        &o.ctx,
        "agent:harness-builder-ui",
        &values(Some("opus"), None),
    )
    .unwrap();
    let custom = o.h.locations.harness_home.join("custom");
    let commits_before = git(&custom, &["rev-list", "--count", "HEAD"]);
    // 확인 없이 받기 → 거절
    let refused = nyanitor_lib::harness::flow::update_pull(&o.state, &o.ctx).unwrap();
    assert_eq!(refused.outcome, GitOutcome::Refused);
    // 확인했는데 받을 것이 없다
    let checked = nyanitor_lib::harness::flow::update_check(&o.state, &o.ctx).unwrap();
    assert_eq!(checked.outcome, GitOutcome::Checked);
    let none = nyanitor_lib::harness::flow::update_pull(&o.state, &o.ctx).unwrap();
    assert_ne!(none.outcome, GitOutcome::Updated);
    assert_eq!(
        git(&custom, &["rev-list", "--count", "HEAD"]),
        commits_before
    );
}
