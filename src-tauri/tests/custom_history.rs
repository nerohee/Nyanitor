//! 내 수정 기록 시험 (P9-01, D-21 · D-51) — 로컬 git: 처음 쓸 때 시작 · 적용 안 한 것 · 차이 · 버리기 · 기록 목록 · 커밋 차이 · 고양이 연결(그 파일만 커밋) · git 없음.
//! 사용자 전역 git 설정(서명 켜짐 · 줄바꿈 변환 · 이름 없음 · hook · 무시 목록)과 상관없이 커밋돼야 한다 — `GIT_CONFIG_GLOBAL` 을 그런 임시 파일로 시험한다.

mod common;

use std::fs;

use common::*;
use nyanitor_lib::custom::model::{
    CatsState, CommitDiff, CommitKind, CommitOutcome, DiscardOutcome, FileStatus, HistoryState,
    WriteOutcome,
};
use nyanitor_lib::custom::values::Values;
use nyanitor_lib::custom::{Env, cats, flow, history};
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

fn apply(r: &CustomRoot, summary: Option<&str>) -> nyanitor_lib::custom::model::ApplyResult {
    flow::apply(&HarnessState::default(), &r.ctx(), summary).unwrap()
}

fn changes(ctx: &Context) -> nyanitor_lib::custom::model::ChangesList {
    history::changes(&Env::new(ctx))
}

fn log(ctx: &Context) -> nyanitor_lib::custom::model::HistoryList {
    history::list(&Env::new(ctx))
}

/// `git fast-import` 로 커밋을 한꺼번에 넣는다 (시험용)
fn fast_import(repo: &std::path::Path, stream: &str) {
    use std::io::Write;
    let mut child = std::process::Command::new(git_exe())
        .arg("-C")
        .arg(repo)
        .args(["fast-import", "--quiet"])
        .stdin(std::process::Stdio::piped())
        .spawn()
        .expect("run git fast-import");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(stream.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success());
}

fn unapplied_paths(r: &CustomRoot) -> Vec<(String, FileStatus)> {
    let ctx = r.ctx();
    let list = nyanitor_lib::custom::items::list(&Env::new(&ctx));
    list.unapplied
        .files
        .into_iter()
        .map(|f| (f.path, f.status))
        .collect()
}

#[test]
fn the_first_write_starts_the_history_with_what_was_already_there_as_the_first_commit() {
    let r = CustomRoot::new("hist-start");
    r.write_custom(
        "agent-cats.json",
        "{\"version\": 1, \"agents\": {\"main\": \"mukmul\"}}\n",
    );
    r.write_custom("shared/workflow.append.md", "- 먼저 있던 글\n");
    assert!(!r.custom_exists(".git"), "읽기는 시작하지 않는다");
    save(&r, "agent:harness-builder-ui", "opus");
    assert!(r.custom_exists(".git") && r.custom_exists(".gitignore"));
    // 첫 커밋은 있던 내용 그대로 — 방금 쓴 값 파일은 적용 안 한 것으로 남는다
    let tracked = r.git(&["ls-tree", "-r", "--name-only", "HEAD"]);
    let mut names: Vec<&str> = tracked.lines().collect();
    names.sort();
    assert_eq!(
        names,
        [".gitignore", "agent-cats.json", "shared/workflow.append.md"]
    );
    assert_eq!(r.subjects(), ["처음 기록"]);
    assert!(
        r.git(&["log", "-1", "--format=%B"])
            .contains("Nyanitor-Kind: start")
    );
    assert_eq!(
        unapplied_paths(&r),
        [(
            "agents/harness-builder-ui.values.yml".to_string(),
            FileStatus::Added
        )]
    );
    // 두 번째 쓰기는 다시 시작하지 않는다
    save(&r, "agent:harness-designer", "haiku");
    assert_eq!(r.subjects(), ["처음 기록"]);
    let ctx = r.ctx();
    let listing = log(&ctx);
    assert_eq!(listing.state, HistoryState::Ok);
    assert_eq!(listing.commits.len(), 1);
    assert_eq!(listing.commits[0].kind, CommitKind::Start);
    assert_eq!(listing.commits[0].message, "처음 기록");
}

#[test]
fn an_empty_custom_folder_still_gets_a_first_commit() {
    let r = CustomRoot::new("hist-start-empty");
    save(&r, "agent:harness-builder-ui", "opus");
    assert_eq!(r.subjects(), ["처음 기록"]);
    assert_eq!(
        r.git(&["ls-tree", "-r", "--name-only", "HEAD"]),
        ".gitignore"
    );
}

#[test]
fn a_hostile_global_git_config_does_not_stop_commits_or_change_the_files() {
    let r = CustomRoot::new("hist-hostile").with_script();
    let cfg_dir = unique_dir("hist-hostile-cfg");
    let marker = cfg_dir.join("hook-ran");
    let hooks = cfg_dir.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    for hook in ["pre-commit", "commit-msg", "post-commit"] {
        fs::write(
            hooks.join(hook),
            format!("#!/bin/sh\ntouch \"{}\"\nexit 1\n", as_url(&marker)),
        )
        .unwrap();
    }
    let excludes = cfg_dir.join("ignore");
    fs::write(&excludes, "*.yml\n*.md\n").unwrap();
    let global = cfg_dir.join("gitconfig");
    fs::write(
        &global,
        format!(
            "[commit]\n\tgpgsign = true\n[tag]\n\tgpgsign = true\n[gpg]\n\tprogram = /definitely/not/a/gpg\n[user]\n\tuseConfigOnly = true\n[core]\n\tautocrlf = true\n\tsafecrlf = true\n\thooksPath = {}\n\texcludesfile = {}\n[init]\n\tdefaultBranch = trunk\n",
            as_url(&hooks),
            as_url(&excludes)
        ),
    )
    .unwrap();
    let ctx = r
        .ctx()
        .with_env("GIT_CONFIG_GLOBAL", global.as_os_str())
        .with_env("GIT_CONFIG_NOSYSTEM", "1")
        .with_env("XDG_CONFIG_HOME", cfg_dir.join("xdg").as_os_str());
    let state = HarnessState::default();
    flow::save_values(
        &state,
        &ctx,
        "agent:harness-builder-ui",
        &values(Some("opus"), Some("low")),
    )
    .unwrap();
    flow::save_append(&state, &ctx, "agent:harness-builder-ui", "- 덧붙임\n").unwrap();
    let applied = flow::apply(&state, &ctx, Some("서명 · 줄바꿈 · hook 에 상관없이")).unwrap();
    assert_eq!(applied.commit, CommitOutcome::Committed, "{applied:?}");
    // 앱 전용 이름 · 메일, 서명 없음
    assert_eq!(
        r.git(&["log", "-1", "--format=%an <%ae>|%cn|%G?"]),
        "Nyanitor <nyanitor@localhost>|Nyanitor|N"
    );
    // 전역 무시 목록(`*.yml` · `*.md`)이 파일을 빼먹지 않았다
    let tracked = r.git(&["ls-tree", "-r", "--name-only", "HEAD"]);
    assert!(
        tracked.contains("agents/harness-builder-ui.values.yml")
            && tracked.contains("agents/harness-builder-ui.append.md"),
        "{tracked}"
    );
    // 전역 hook 이 돌지 않았다
    assert!(!marker.exists(), "hook 이 돌았다");
    // 줄바꿈 변환 없이 LF 그대로 들어갔다
    let blob = r.git(&["show", "HEAD:agents/harness-builder-ui.values.yml"]);
    assert_eq!(blob, "model: opus\neffort: low");
    assert!(
        !fs::read(r.custom.join("agents/harness-builder-ui.values.yml"))
            .unwrap()
            .contains(&b'\r')
    );
    // 기본 브랜치 이름도 사용자 설정에 기대지 않는다
    assert_eq!(r.git(&["symbolic-ref", "--short", "HEAD"]), "main");
    let _ = fs::remove_dir_all(&cfg_dir);
}

#[test]
fn unapplied_files_and_their_line_diffs_cover_changed_added_and_removed() {
    let r = CustomRoot::new("hist-diff").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    flow::save_values(
        &HarnessState::default(),
        &r.ctx(),
        "agent:harness-designer",
        &values(Some("haiku"), Some("low")),
    )
    .unwrap();
    assert_eq!(apply(&r, None).commit, CommitOutcome::Committed);
    assert!(unapplied_paths(&r).is_empty());

    // 바뀜 · 새 파일 · 지움
    save(&r, "agent:harness-builder-ui", "haiku");
    flow::save_append(
        &HarnessState::default(),
        &r.ctx(),
        "agent:harness-builder-ui",
        "- 첫째\n- 둘째\n",
    )
    .unwrap();
    flow::save_values(
        &HarnessState::default(),
        &r.ctx(),
        "agent:harness-designer",
        &Values::default(),
    )
    .unwrap();
    let mut paths = unapplied_paths(&r);
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        paths,
        [
            (
                "agents/harness-builder-ui.append.md".to_string(),
                FileStatus::Added
            ),
            (
                "agents/harness-builder-ui.values.yml".to_string(),
                FileStatus::Changed
            ),
            (
                "agents/harness-designer.values.yml".to_string(),
                FileStatus::Removed
            ),
        ]
    );
    let ctx = r.ctx();
    let list = changes(&ctx);
    assert_eq!(list.state, HistoryState::Ok);
    assert_eq!(list.files_total, 3);
    let file = |path: &str| {
        list.files
            .iter()
            .find(|f| f.path == path)
            .unwrap_or_else(|| panic!("{path}: {:#?}", list.files))
    };
    let changed = file("agents/harness-builder-ui.values.yml");
    assert_eq!(changed.status, FileStatus::Changed);
    assert_eq!((changed.added, changed.removed), (1, 1));
    let signs: Vec<(char, &str, Option<u32>, Option<u32>)> = changed
        .lines
        .iter()
        .map(|l| (l.sign, l.text.as_str(), l.old, l.new))
        .collect();
    assert_eq!(signs[0].0, '@');
    assert!(
        signs.contains(&('-', "model: opus", Some(1), None)),
        "{signs:?}"
    );
    assert!(
        signs.contains(&('+', "model: haiku", None, Some(1))),
        "{signs:?}"
    );
    let added = file("agents/harness-builder-ui.append.md");
    assert_eq!(added.status, FileStatus::Added);
    assert_eq!((added.added, added.removed), (2, 0));
    assert_eq!(added.lines[0].text, "@@ -0,0 +1,2 @@");
    assert_eq!(
        added.lines[1..]
            .iter()
            .map(|l| (l.sign, l.text.as_str(), l.new))
            .collect::<Vec<_>>(),
        [('+', "- 첫째", Some(1)), ('+', "- 둘째", Some(2))]
    );
    let removed = file("agents/harness-designer.values.yml");
    assert_eq!(removed.status, FileStatus::Removed);
    assert_eq!((removed.added, removed.removed), (0, 2));
}

#[test]
fn a_long_diff_is_cut_at_the_line_limit_and_says_so() {
    let r = CustomRoot::new("hist-diff-limit").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    let many: String = (1..=900).map(|n| format!("줄 {n}\n")).collect();
    flow::save_append(
        &HarnessState::default(),
        &r.ctx(),
        "agent:harness-builder-ui",
        &many,
    )
    .unwrap();
    let ctx = r.ctx();
    let list = changes(&ctx);
    let file = list
        .files
        .iter()
        .find(|f| f.path.ends_with(".append.md"))
        .unwrap();
    assert!(file.truncated);
    assert_eq!(file.lines.len(), 400);
    assert_eq!(file.added, 900, "전체 줄 수는 그대로 알려 준다");
}

#[test]
fn discarding_restores_changed_files_removes_new_ones_and_keeps_the_history() {
    let r = CustomRoot::new("hist-discard").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    apply(&r, None);
    let commits_before = r.subjects().len();
    save(&r, "agent:harness-builder-ui", "haiku");
    flow::save_append(
        &HarnessState::default(),
        &r.ctx(),
        "agent:harness-designer",
        "- 새 글\n",
    )
    .unwrap();
    r.write_custom("shared/new-by-hand.append.md", "x\n");
    flow::replace_start(&HarnessState::default(), &r.ctx(), "skill:web-full").unwrap();
    assert!(r.custom_exists("skills/web-full/SKILL.md"));
    let result = flow::discard(&HarnessState::default(), &r.ctx()).unwrap();
    assert_eq!(result.outcome, DiscardOutcome::Discarded);
    assert_eq!(
        result.files, 5,
        "값 바뀜 1 · 덧붙임 1 · 손으로 둔 파일 1 · 통째 글 · `.origin`"
    );
    assert_eq!(
        r.read_custom("agents/harness-builder-ui.values.yml"),
        "model: opus\n"
    );
    for rel in [
        "agents/harness-designer.append.md",
        "shared/new-by-hand.append.md",
        "skills/web-full/SKILL.md",
        "skills/web-full/SKILL.md.origin",
    ] {
        assert!(!r.custom_exists(rel), "{rel}");
    }
    assert!(
        !r.custom_exists("skills"),
        "비게 된 새 폴더는 git clean 이 지운다"
    );
    assert!(r.custom_exists(".git") && r.custom_exists(".gitignore"));
    assert_eq!(r.subjects().len(), commits_before, "이력은 그대로다");
    assert!(unapplied_paths(&r).is_empty());
    // 버릴 것이 없으면 아무 일도 없다
    assert_eq!(
        flow::discard(&HarnessState::default(), &r.ctx())
            .unwrap()
            .outcome,
        DiscardOutcome::Nothing
    );
}

#[test]
fn discarding_before_any_history_does_nothing() {
    let r = CustomRoot::new("hist-discard-notstarted");
    assert_eq!(
        flow::discard(&HarnessState::default(), &r.ctx())
            .unwrap()
            .outcome,
        DiscardOutcome::NotStarted
    );
}

#[test]
fn the_history_list_has_numbers_dates_messages_files_and_kinds() {
    let r = CustomRoot::new("hist-list").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    apply(&r, Some("첫 적용"));
    flow::create(
        &HarnessState::default(),
        &r.ctx(),
        &nyanitor_lib::custom::write::NewItem {
            kind: "agent".into(),
            name: "translator".into(),
            description: "번역".into(),
            model: None,
            effort: None,
        },
    )
    .unwrap();
    apply(&r, Some("새 에이전트"));
    flow::cats_write(
        &HarnessState::default(),
        &r.ctx(),
        "translator",
        Some("dubu"),
    )
    .unwrap();
    let ctx = r.ctx();
    let listing = log(&ctx);
    assert_eq!(listing.state, HistoryState::Ok);
    assert!(!listing.truncated);
    let kinds: Vec<CommitKind> = listing.commits.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            CommitKind::Cats,
            CommitKind::New,
            CommitKind::Apply,
            CommitKind::Start
        ]
    );
    let messages: Vec<&str> = listing.commits.iter().map(|c| c.message.as_str()).collect();
    assert_eq!(
        messages,
        ["고양이 연결 바꿈", "새 에이전트", "첫 적용", "처음 기록"]
    );
    let newest = &listing.commits[0];
    assert_eq!(newest.hash.len(), 40);
    assert_eq!(newest.short, &newest.hash[..7]);
    assert!(
        newest.date.contains('T') && newest.date.len() >= 20,
        "{}",
        newest.date
    );
    assert_eq!(newest.files, ["agent-cats.json"]);
    assert_eq!(listing.commits[1].files, ["agents/translator.md"]);
    assert_eq!(
        listing.commits[2].files,
        ["agents/harness-builder-ui.values.yml"]
    );
    // 앱이 만들지 않은 커밋은 종류 `other`
    r.git(&["commit", "-q", "--allow-empty", "-m", "손으로 한 커밋"]);
    let listing = log(&r.ctx());
    assert_eq!(listing.commits[0].kind, CommitKind::Other);
    assert_eq!(listing.commits[0].message, "손으로 한 커밋");
}

#[test]
fn the_history_list_is_capped_at_the_limit_and_says_it_was_cut() {
    let r = CustomRoot::new("hist-list-cap");
    save(&r, "agent:harness-builder-ui", "opus");
    // 빈 커밋 205 개를 한꺼번에 만든다 (`git fast-import` — 프로세스를 205번 띄우지 않으려고)
    let mut stream = String::new();
    for index in 0..205 {
        stream.push_str(
            "commit refs/heads/main\ncommitter T <t@example.com> 1700000000 +0000\ndata 1\nx\n",
        );
        if index == 0 {
            stream.push_str("from refs/heads/main^0\n");
        }
        stream.push('\n');
    }
    fast_import(&r.custom, &stream);
    let listing = log(&r.ctx());
    assert_eq!(listing.commits.len(), history::LOG_MAX);
    assert!(listing.truncated);
}

#[test]
fn a_commits_diff_is_readable_and_odd_or_unknown_numbers_are_handled() {
    let r = CustomRoot::new("hist-commit-diff").with_script();
    save(&r, "agent:harness-builder-ui", "opus");
    apply(&r, Some("값 적용"));
    let ctx = r.ctx();
    let env = Env::new(&ctx);
    let listing = history::list(&env);
    let apply_commit = &listing.commits[0];
    // 짧은 번호도 전체 번호도 받는다
    for reference in [apply_commit.short.as_str(), apply_commit.hash.as_str()] {
        match history::commit_diff(&env, reference).unwrap() {
            CommitDiff::Ok {
                commit,
                files,
                files_total,
            } => {
                assert_eq!(commit.hash, apply_commit.hash);
                assert_eq!(files_total, 1);
                assert_eq!(files[0].path, "agents/harness-builder-ui.values.yml");
                assert_eq!(files[0].status, FileStatus::Added);
                assert!(
                    files[0]
                        .lines
                        .iter()
                        .any(|l| l.sign == '+' && l.text == "model: opus")
                );
            }
            other => panic!("{other:?}"),
        }
    }
    // 첫 커밋(뿌리)도 보인다
    let root = listing.commits.last().unwrap();
    assert!(matches!(
        history::commit_diff(&env, &root.hash).unwrap(),
        CommitDiff::Ok { .. }
    ));
    // 모양이 틀린 번호는 오류, 없는 번호는 결과
    for bad in [
        "",
        "abc",
        "ABCDEF1",
        "../../x",
        "HEAD",
        "main",
        "g".repeat(7).as_str(),
        &"a".repeat(41),
        "abc def",
        "-abc1234",
        "abc1234 --all",
    ] {
        assert_eq!(
            history::commit_diff(&env, bad).unwrap_err().kind(),
            "invalid_input",
            "{bad:?}"
        );
    }
    assert!(matches!(
        history::commit_diff(&env, "deadbeef").unwrap(),
        CommitDiff::UnknownCommit
    ));
    assert!(matches!(
        history::commit_diff(&env, &"0".repeat(40)).unwrap(),
        CommitDiff::UnknownCommit
    ));
}

#[test]
fn without_git_everything_is_saved_and_applied_but_history_says_no_git() {
    let r = CustomRoot::new("hist-nogit").with_script();
    let ctx = r.ctx_without_git();
    let state = HarnessState::default();
    let saved = flow::save_values(
        &state,
        &ctx,
        "agent:harness-builder-ui",
        &values(Some("opus"), None),
    )
    .unwrap();
    assert_eq!(saved.outcome, WriteOutcome::Saved);
    assert!(r.custom_exists("agents/harness-builder-ui.values.yml"));
    assert!(
        !r.custom_exists(".git"),
        "git 이 없으면 저장소도 만들지 않는다"
    );
    let env = Env::new(&ctx);
    let list = nyanitor_lib::custom::items::list(&env);
    assert_eq!(list.history.state, HistoryState::NoGit);
    assert!(!list.unapplied.known && list.unapplied.count == 0);
    assert_eq!(history::list(&env).state, HistoryState::NoGit);
    assert_eq!(history::changes(&env).state, HistoryState::NoGit);
    assert!(matches!(
        history::commit_diff(&env, "abcdef1").unwrap(),
        CommitDiff::NoGit
    ));
    assert_eq!(
        flow::discard(&state, &ctx).unwrap().outcome,
        DiscardOutcome::NoGit
    );
    // 적용은 설치만 한다 (적용 안 한 것을 알 수 없어 늘 설치한다)
    let applied = flow::apply(&state, &ctx, None).unwrap();
    assert_eq!(
        applied.outcome,
        nyanitor_lib::custom::model::ApplyOutcome::Applied,
        "{applied:?}"
    );
    assert_eq!(applied.commit, CommitOutcome::NoGit);
    assert_eq!(r.install_calls(), 1);
    let restored = flow::restore_to(&state, &ctx, "abcdef1").unwrap();
    assert_eq!(
        restored.outcome,
        nyanitor_lib::custom::model::RestoreOutcome::NoGit
    );
    // 고양이 연결도 쓰이고 커밋만 없다
    let cat = flow::cats_write(&state, &ctx, "main", Some("mukmul")).unwrap();
    assert_eq!(cat.outcome, WriteOutcome::Saved);
    assert_eq!(cat.commit, CommitOutcome::NoGit);
    assert!(
        r.read_custom("agent-cats.json")
            .contains("\"main\": \"mukmul\"")
    );
}

// ───────────────────────────── 고양이 연결 ─────────────────────────────

#[test]
fn cats_are_read_written_and_committed_alone_leaving_other_unapplied_changes() {
    let r = CustomRoot::new("hist-cats");
    assert_eq!(cats::read(&Env::new(&r.ctx())).state, CatsState::Absent);
    save(&r, "agent:harness-builder-ui", "opus"); // 적용 안 한 것
    let state = HarnessState::default();
    let result = flow::cats_write(&state, &r.ctx(), "designer", Some("mulgam")).unwrap();
    assert_eq!(result.outcome, WriteOutcome::Saved);
    assert!(result.changed);
    assert_eq!(result.commit, CommitOutcome::Committed, "{result:?}");
    assert_eq!(
        r.read_custom("agent-cats.json"),
        "{\n  \"version\": 1,\n  \"agents\": {\n    \"designer\": \"mulgam\"\n  }\n}\n"
    );
    // 그 파일만 커밋됐고 다른 적용 안 한 것은 그대로
    assert_eq!(
        r.git(&["show", "--name-only", "--format=%s", "HEAD"])
            .lines()
            .collect::<Vec<_>>(),
        ["고양이 연결 바꿈", "", "agent-cats.json"]
    );
    assert_eq!(
        unapplied_paths(&r),
        [(
            "agents/harness-builder-ui.values.yml".to_string(),
            FileStatus::Added
        )]
    );
    let read = cats::read(&Env::new(&r.ctx()));
    assert_eq!(read.state, CatsState::Ok);
    assert_eq!(
        read.agents.get("designer").map(String::as_str),
        Some("mulgam")
    );
    // 같은 값을 다시 쓰면 커밋도 없다
    let again = flow::cats_write(&state, &r.ctx(), "designer", Some("mulgam")).unwrap();
    assert!(!again.changed);
    assert_eq!(again.commit, CommitOutcome::Skipped);
    // 다른 에이전트 추가 · 바꾸기 · 지우기
    flow::cats_write(&state, &r.ctx(), "main", Some("mukmul")).unwrap();
    flow::cats_write(&state, &r.ctx(), "designer", Some("nabi")).unwrap();
    let read = cats::read(&Env::new(&r.ctx()));
    assert_eq!(read.agents.len(), 2);
    assert_eq!(read.agents["designer"], "nabi");
    let removed = flow::cats_write(&state, &r.ctx(), "designer", None).unwrap();
    assert!(removed.changed && removed.commit == CommitOutcome::Committed);
    assert!(
        !cats::read(&Env::new(&r.ctx()))
            .agents
            .contains_key("designer")
    );
    // 그 사이 다른 커밋이 생기지 않았다 — 값 파일은 계속 적용 안 한 것
    assert_eq!(unapplied_paths(&r).len(), 1);
}

#[test]
fn cats_keep_unknown_keys_and_their_order_and_refuse_bad_ids() {
    let r = CustomRoot::new("hist-cats-keep");
    r.write_custom(
        "agent-cats.json",
        "{\n  \"zzz\": {\"future\": [1, 2]},\n  \"version\": 1,\n  \"agents\": {\n    \"ui\": \"danchu\",\n    \"future-agent\": \"someone\"\n  }\n}\n",
    );
    let state = HarnessState::default();
    flow::cats_write(&state, &r.ctx(), "system", Some("nabi")).unwrap();
    assert_eq!(
        r.read_custom("agent-cats.json"),
        "{\n  \"zzz\": {\"future\": [1, 2]},\n  \"version\": 1,\n  \"agents\": {\n    \"ui\": \"danchu\",\n    \"future-agent\": \"someone\",\n    \"system\": \"nabi\"\n  }\n}\n"
    );
    for (agent, cat) in [
        ("Bad", "x"),
        ("../x", "x"),
        ("a/b", "x"),
        ("", "x"),
        ("ui", "Bad Cat"),
        ("ui", "../x"),
        ("ui", ""),
        ("ui", "a/b"),
    ] {
        let error = flow::cats_write(&state, &r.ctx(), agent, Some(cat)).unwrap_err();
        assert_eq!(error.kind(), "invalid_input", "{agent:?} {cat:?}");
    }
    assert!(flow::cats_write(&state, &r.ctx(), "ui", Some(&"a".repeat(33))).is_err());
    flow::cats_write(&state, &r.ctx(), "ui", Some(&"a".repeat(32))).unwrap();
    // 깨진 파일은 덮어쓰지 않는다
    r.write_custom("agent-cats.json", "{ broken");
    let result = flow::cats_write(&state, &r.ctx(), "ui", Some("danchu")).unwrap();
    assert_eq!(result.outcome, WriteOutcome::Refused);
    assert_eq!(result.reason.as_deref(), Some("unreadable"));
    assert_eq!(r.read_custom("agent-cats.json"), "{ broken");
    assert_eq!(cats::read(&Env::new(&r.ctx())).state, CatsState::Unreadable);
}

#[test]
fn removing_a_cat_when_there_is_no_file_creates_nothing() {
    let r = CustomRoot::new("hist-cats-nofile");
    let result = flow::cats_write(&HarnessState::default(), &r.ctx(), "ui", None).unwrap();
    assert!(!result.changed);
    assert!(!r.custom.exists());
}
