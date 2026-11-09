//! 실제 하네스 설치 스크립트로 내 수정 한 바퀴 (P9-01) — **기본으로는 돌지 않는다** (`#[ignore]`).
//!
//! ```text
//! $env:NYANITOR_HARNESS_SRC = '\\wsl.localhost\<배포판>\home\<사용자>\project\claude-harness'
//! cargo test --manifest-path src-tauri/Cargo.toml --test real_custom -- --ignored --nocapture --test-threads=1
//! ```
//!
//! - 하네스 원본 파일은 `NYANITOR_HARNESS_SRC` (claude-harness 클론 폴더)에서 **읽기만** 한다 — 파일을 임시 폴더(`<하네스 폴더>/repo`)로 복사해서 쓴다 (그 저장소에는 아무것도 쓰지 않는다).
//! - 쓰는 곳은 전부 OS 임시 폴더 아래의 `CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME` 뿐이다. 실제 `~/.claude` · `~/.claude-harness` 는 읽기 전용으로 시작 · 끝의 모양(이름 · 크기 · 수정 시각)만 비교한다.
//! - 확인하는 것: 앱이 쓴 값 파일 · 덧붙임 · 통째(+ 앱이 계산한 `.origin` 해시) · 새 에이전트 · 새 스킬 틀을 **실제 설치 스크립트가 받아들이는가** (`--plan` 의 `problems` 가 없고
//!   `originChanged` 가 false = 앱의 해시가 스크립트의 해시와 같다, CRLF 원본 포함), 적용(실제 설치)이 `~/.claude` 에 반영하는가, 원본이 바뀌면 `originChanged` 가 true 가 되고 "내 것 유지" 가 풀어 주는가,
//!   내가 만든 것을 지우면 다음 설치가 `~/.claude` 에서도 지우는가, 되돌리기가 그때 모습으로 설치하는가.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use nyanitor_lib::custom::model::{
    ApplyOutcome, CommitOutcome, ListEntry, Mark, RestoreOutcome, WriteOutcome,
};
use nyanitor_lib::custom::values::Values;
use nyanitor_lib::custom::write::NewItem;
use nyanitor_lib::custom::{Env, flow, items};
use nyanitor_lib::harness::HarnessState;
use nyanitor_lib::harness::script::{ScriptOutcome, plan};

fn harness_src() -> PathBuf {
    let path = std::env::var_os("NYANITOR_HARNESS_SRC")
        .map(PathBuf::from)
        .expect("set NYANITOR_HARNESS_SRC to a claude-harness checkout");
    assert!(
        path.join("install.ps1").is_file() && path.join("install.sh").is_file(),
        "NYANITOR_HARNESS_SRC must point at a claude-harness checkout: {}",
        path.display()
    );
    path
}

/// 실제 폴더의 모양 — 이름 · 크기 · 수정 시각 (내용은 읽지 않는다). 시작과 끝을 비교한다.
fn real_shape() -> BTreeMap<String, (u64, u128)> {
    let mut out = BTreeMap::new();
    let Some(home) = std::env::home_dir() else {
        return out;
    };
    for root in [
        home.join(".claude").join("harness"),
        home.join(".claude").join("agents"),
        home.join(".claude").join("skills"),
        home.join(".claude-harness"),
    ] {
        walk_shape(&root, &mut out);
    }
    out
}

fn walk_shape(path: &Path, out: &mut BTreeMap<String, (u64, u128)>) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    out.insert(path.display().to_string(), (meta.len(), modified));
    if meta.is_dir()
        && !meta.file_type().is_symlink()
        && let Ok(entries) = fs::read_dir(path)
    {
        for entry in entries.flatten() {
            walk_shape(&entry.path(), out);
        }
    }
}

/// 하네스 파일을 임시 폴더로 복사한다 (`.git` · 개인 설정 `config.local.json` 은 뺀다). 원본은 읽기만 한다.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap().flatten() {
        let name = entry.file_name();
        if name == ".git" || name == "config.local.json" {
            continue;
        }
        let src = entry.path();
        let dst = to.join(&name);
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&src, &dst);
        } else {
            fs::copy(&src, &dst).unwrap();
        }
    }
}

fn values(model: Option<&str>, effort: Option<&str>) -> Values {
    Values {
        model: model.map(str::to_string),
        effort: effort.map(str::to_string),
    }
}

#[test]
#[ignore = "runs the real harness install script (in temp folders) — see the header"]
fn the_real_install_script_accepts_what_the_app_writes_and_applying_installs_it() {
    let real_before = real_shape();
    let src = harness_src();
    let r = CustomRoot::empty("real-custom");
    println!("temp root: {}", r.h.root.display());
    copy_tree(&src, &r.source);
    // 줄바꿈이 CRLF 인 원본도 같은 해시가 나와야 한다 (LF 로 맞춘 뒤의 sha256)
    let helper = r.source.join("agents").join("harness-helper.md");
    let helper_text = fs::read_to_string(&helper).unwrap().replace("\r\n", "\n");
    fs::write(&helper, helper_text.replace('\n', "\r\n")).unwrap();

    let ctx = r.ctx();
    let state = HarnessState::default();
    let saved = |result: nyanitor_lib::custom::model::WriteResult| {
        assert_eq!(result.outcome, WriteOutcome::Saved, "{result:?}");
        result
    };

    // 1) 앱이 쓴다 — 값 · 덧붙임 · 통째(원본이 LF 인 것 · CRLF 인 것) · 새 에이전트 · 새 스킬 · 오케스트레이터 설정
    saved(
        flow::save_values(
            &state,
            &ctx,
            "agent:harness-builder-ui",
            &values(Some("opus"), Some("low")),
        )
        .unwrap(),
    );
    saved(
        flow::save_append(
            &state,
            &ctx,
            "agent:harness-designer",
            "- 시험으로 덧붙인 줄\n",
        )
        .unwrap(),
    );
    saved(flow::save_append(&state, &ctx, "skill:web-lite", "- 스킬에 덧붙인 줄\n").unwrap());
    saved(flow::replace_start(&state, &ctx, "agent:harness-reviewer").unwrap());
    saved(flow::replace_start(&state, &ctx, "agent:harness-helper").unwrap()); // CRLF 원본
    saved(flow::replace_start(&state, &ctx, "skill:harness-resume").unwrap());
    let created = flow::create(
        &state,
        &ctx,
        &NewItem {
            kind: "agent".into(),
            name: "translator".into(),
            description: "문서를 영어로 옮긴다: 시험".into(),
            model: Some("sonnet".into()),
            effort: Some("medium".into()),
        },
    )
    .unwrap();
    saved(created);
    saved(
        flow::create(
            &state,
            &ctx,
            &NewItem {
                kind: "skill".into(),
                name: "translate-docs".into(),
                description: "문서 번역".into(),
                model: None,
                effort: None,
            },
        )
        .unwrap(),
    );
    saved(
        flow::save_values(
            &state,
            &ctx,
            "main",
            &values(Some("sonnet"), Some("medium")),
        )
        .unwrap(),
    );

    // 2) 실제 설치 스크립트의 미리보기 — 문제 없이 받아들이고, 앱의 해시가 스크립트의 해시와 같다
    let preview = plan(&ctx);
    assert_eq!(preview.outcome, ScriptOutcome::Ran, "{preview:?}");
    let report = preview.report.as_ref().unwrap();
    assert!(
        report.ok && report.problems.is_empty(),
        "스크립트가 거절했다: {report:?}"
    );
    assert!(
        !report.warnings.iter().any(|w| w.reason == "noOriginHash"
            || w.reason == "originGone"
            || w.reason == "orphanOrigin"),
        "{:?}",
        report.warnings
    );
    let kinds: Vec<(String, String, Option<bool>)> = report
        .custom
        .as_ref()
        .unwrap()
        .items
        .iter()
        .map(|item| (item.path.clone(), item.kind.clone(), item.origin_changed))
        .collect();
    println!("custom items seen by the script: {kinds:#?}");
    for (path, kind) in [
        ("agents/harness-builder-ui.md", "values"),
        ("agents/harness-designer.md", "append"),
        ("skills/web-lite/SKILL.md", "append"),
        ("agents/harness-reviewer.md", "replace"),
        ("agents/harness-helper.md", "replace"),
        ("skills/harness-resume/SKILL.md", "replace"),
        ("agents/translator.md", "new"),
        ("skills/translate-docs/SKILL.md", "new"),
        ("config.local.json", "config"),
    ] {
        let found = kinds.iter().find(|(p, k, _)| p == path && k == kind);
        assert!(
            found.is_some(),
            "{path} ({kind}) 를 스크립트가 알아보지 못했다: {kinds:?}"
        );
        if kind == "replace" {
            // 원본 해시가 스크립트가 낸 값과 같다 → 원본 바뀜 아님
            assert_eq!(
                found.unwrap().2,
                Some(false),
                "{path}: 앱의 해시가 스크립트의 해시와 다르다"
            );
        }
    }
    assert!(
        report.origin_changed.is_empty(),
        "{:?}",
        report.origin_changed
    );

    // 3) 앱의 목록도 같은 생각이다 (원본 바뀜 없음)
    let list = items::list(&Env::new(&ctx));
    assert!(list.unapplied.count >= 9, "{:?}", list.unapplied);
    for entry in &list.items {
        if let ListEntry::Ok(item) = entry
            && item.marks.contains(&Mark::Replace)
        {
            assert_eq!(item.origin_changed, Some(false), "{}", item.id);
        }
    }

    // 4) 적용 = 실제 설치 → 커밋
    let applied = flow::apply(&state, &ctx, Some("실제 스크립트 시험")).unwrap();
    assert_eq!(applied.outcome, ApplyOutcome::Applied, "{applied:?}");
    assert_eq!(applied.commit, CommitOutcome::Committed);
    assert_eq!(items::list(&Env::new(&ctx)).unapplied.count, 0);
    let claude = &r.h.locations.claude_dir;
    let installed =
        |rel: &str| fs::read_to_string(claude.join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
    let ui = installed("agents/harness-builder-ui.md");
    assert!(
        ui.contains("model: opus") && ui.contains("effort: low"),
        "{ui}"
    );
    assert!(installed("agents/harness-designer.md").contains("- 시험으로 덧붙인 줄"));
    let translator = installed("agents/translator.md");
    assert!(
        translator.contains("name: translator") && translator.contains("model: sonnet"),
        "{translator}"
    );
    assert!(translator.contains("hooks:"), "설치가 가드 hook 을 붙인다");
    assert!(installed("skills/translate-docs/SKILL.md").contains("name: translate-docs"));
    assert!(installed(".harness-installed").contains("agent translator.md"));
    let config = installed("harness/config.local.json");
    assert!(
        config.contains("\"sonnet\""),
        "내 설정(planner)이 설치본 설정으로 갔다: {config}"
    );

    // 5) 원본이 바뀌었다 — 통째 바꾼 파일이 `true` 가 되고 설치는 내 것을 그대로 쓴다
    let reviewer = r.source.join("agents").join("harness-reviewer.md");
    let mut changed = fs::read_to_string(&reviewer).unwrap();
    changed.push_str("\n원본이 새로 더한 줄.\n");
    fs::write(&reviewer, changed).unwrap();
    let preview = plan(&ctx);
    let report = preview.report.as_ref().unwrap();
    assert!(report.ok && report.problems.is_empty(), "{report:?}");
    assert_eq!(
        report.origin_changed.len(),
        1,
        "{:?}",
        report.origin_changed
    );
    assert_eq!(report.origin_changed[0].path, "agents/harness-reviewer.md");
    let list = items::list(&Env::new(&ctx));
    let reviewer_item = list.items.iter().find_map(|e| match e {
        ListEntry::Ok(i) if i.id == "agent:harness-reviewer" => Some(i.clone()),
        _ => None,
    });
    assert_eq!(reviewer_item.unwrap().origin_changed, Some(true));
    // 내 것 유지 → 스크립트도 더는 바뀜이라고 하지 않는다
    saved(flow::origin_keep(&state, &ctx, "agent:harness-reviewer").unwrap());
    let preview = plan(&ctx);
    assert!(
        preview.report.as_ref().unwrap().origin_changed.is_empty(),
        "{:?}",
        preview.report
    );
    assert_eq!(
        flow::apply(&state, &ctx, None).unwrap().outcome,
        ApplyOutcome::Applied
    );

    // 6) 내가 만든 것을 지우고 적용하면 `~/.claude` 에서도 사라진다
    saved(flow::delete_mine(&state, &ctx, "agent:translator").unwrap());
    let before_delete = r.git(&["rev-parse", "HEAD"]);
    let applied = flow::apply(&state, &ctx, Some("번역가 지움")).unwrap();
    assert_eq!(applied.outcome, ApplyOutcome::Applied, "{applied:?}");
    assert!(
        !claude.join("agents").join("translator.md").exists(),
        "다음 설치가 지웠어야 한다"
    );

    // 7) 어느 때로 되돌리기 — 번역가가 있던 때로 (실제 설치가 다시 만든다)
    let ctx = r.ctx();
    let history = nyanitor_lib::custom::history::list(&Env::new(&ctx));
    let with_translator = history
        .commits
        .iter()
        .find(|c| c.message == "실제 스크립트 시험")
        .expect("그때의 커밋");
    let restored = flow::restore_to(&state, &ctx, &with_translator.hash).unwrap();
    assert_eq!(restored.outcome, RestoreOutcome::Restored, "{restored:?}");
    assert!(claude.join("agents").join("translator.md").exists());
    assert_ne!(r.git(&["rev-parse", "HEAD"]), before_delete);

    // 실제 홈 폴더는 그대로다
    assert_eq!(
        real_shape(),
        real_before,
        "실제 ~/.claude · ~/.claude-harness 가 바뀌었다"
    );
}
