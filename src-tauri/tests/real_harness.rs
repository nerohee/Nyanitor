//! 실제 하네스 설치 스크립트로 한 바퀴 (P4-02) — **기본으로는 돌지 않는다** (`#[ignore]`).
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test real_harness -- --ignored --nocapture --test-threads=1
//! ```
//!
//! - 하네스 원본 파일은 환경 변수 `NYANITOR_HARNESS_SRC` (claude-harness 클론 폴더 — 꼭 정한다, 예: `\\wsl.localhost\<배포판>\home\<사용자>\project\claude-harness`)
//!   에서 **읽기만** 한다 (그 저장소에는 git 도 쓰지 않는다 — 파일을 임시 폴더로 복사해 거기서 새 저장소를 만든다).
//! - 쓰는 곳은 전부 OS 임시 폴더 아래의 `CLAUDE_CONFIG_DIR` · `CLAUDE_HARNESS_HOME` 뿐이다. 실제 `~/.claude` · `~/.claude-harness` 는 읽기 전용으로
//!   시작 · 끝의 모양(이름 · 크기 · 수정 시각)만 비교한다.
//! - 흐름 A (보통): 로컬 원본 받기 → 미리보기 → 설치 → 다시 미리보기 = 같음 → 원본에 새 커밋 → 업데이트 확인 → 받기(확인 때 본 커밋까지만)
//!   → 미리보기 → 설치(백업) → 되돌리기 미리보기 → 되돌리기 = 원래대로. 확인 · 미리보기 → 받기 · 설치 · 되돌리기는 앱이 기억한 것(`HarnessState`)을
//!   거치는 `flow` 함수로 돈다 (Tauri 명령이 부르는 것과 같은 길).
//! - 흐름 B (개발자 모드): `~/.claude/harness` 의 복사 표시가 하네스 원본(UNC 경로)을 가리키는 PC — 그 원본의 실제 스크립트로 같은 일.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use common::*;
use nyanitor_lib::harness::git::{GitOutcome, clone_origin};
use nyanitor_lib::harness::locate::{OriginKind, same_path};
use nyanitor_lib::harness::script::{ScriptOutcome, backups_list, plan};
use nyanitor_lib::harness::status::status;
use nyanitor_lib::harness::{HarnessState, flow};

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

/// 폴더 안 모든 파일의 상대 경로 → 내용 (링크는 따라가지 않고 대상 글자만). 되돌리기 비교용.
fn content_snapshot(root: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .display()
                .to_string()
                .replace('\\', "/");
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                out.insert(
                    rel,
                    format!(
                        "link -> {}",
                        fs::read_link(&path)
                            .map(|p| p.display().to_string())
                            .unwrap_or_default()
                    ),
                );
            } else if meta.is_dir() {
                out.insert(format!("{rel}/"), "dir".into());
                walk(root, &path, out);
            } else {
                let bytes = fs::read(&path).unwrap_or_default();
                out.insert(
                    rel,
                    format!(
                        "{} bytes, sum {}",
                        bytes.len(),
                        bytes.iter().map(|b| u64::from(*b)).sum::<u64>()
                    ),
                );
            }
        }
    }
    walk(root, root, &mut out);
    out
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

fn first_agent(claude_dir: &Path) -> PathBuf {
    let agents = claude_dir.join("agents");
    let mut names: Vec<PathBuf> = fs::read_dir(&agents)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "md"))
        .collect();
    names.sort();
    names.into_iter().next().expect("an installed agent")
}

fn assert_installed(claude_dir: &Path) {
    let agents = fs::read_dir(claude_dir.join("agents"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("harness-"))
        .count();
    assert!(
        agents >= 6,
        "worker files should be installed, found {agents}"
    );
    // `/desktop-app` 스킬 — 링크 설치든 복사 설치든 읽을 수 있어야 한다
    let skill = claude_dir
        .join("skills")
        .join("desktop-app")
        .join("SKILL.md");
    let text = fs::read_to_string(&skill).unwrap_or_else(|e| panic!("{}: {e}", skill.display()));
    assert!(
        text.contains("desktop-app"),
        "the skill file should be the harness skill"
    );
    assert!(claude_dir.join("harness").exists());
}

#[test]
#[ignore = "runs the real harness install scripts (in temp folders) — see the header"]
fn flow_a_clone_local_origin_preview_install_same_update_restore() {
    let real_before = real_shape();
    let src = harness_src();
    let h = HarnessRoot::new("real-harness-a");
    println!("temp root: {}", h.root.display());

    // 1) 원본: 하네스 파일을 복사해 임시 로컬 저장소로 (원격 대신)
    let origin = h.root.join("origin");
    copy_tree(&src, &origin);
    git(&origin, &["init", "-q", "-b", "main"]);
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "-q", "-m", "feat: 시험용 하네스 원본"]);
    let ctx = h.ctx().with_origin_url(as_url(&origin));
    let state = HarnessState::default();

    // 2) 받기
    let cloned = clone_origin(&ctx);
    assert_eq!(cloned.outcome, GitOutcome::Cloned, "{cloned:?}");
    assert!(
        !h.locations.repo_dir().join("config.local.json").exists(),
        "받은 원본에는 설정 파일이 없다"
    );
    let st = status(&ctx);
    assert!(st.script_path.is_some() && !st.developer_mode, "{st:?}");
    assert_eq!(st.origin.kind, OriginKind::None);

    // 3) 미리보기 — 아무것도 쓰지 않는다
    let empty_claude = content_snapshot(&h.locations.claude_dir);
    // 미리보기 없이는 설치하지 않는다 (앱이 다시 막는다)
    let early = flow::install(&state, &ctx).unwrap();
    assert_eq!(early.outcome, ScriptOutcome::Refused, "{early:?}");
    assert_eq!(content_snapshot(&h.locations.claude_dir), empty_claude);
    let preview = flow::install_plan(&state, &ctx).unwrap();
    assert_eq!(preview.outcome, ScriptOutcome::Ran, "{preview:?}");
    let report = preview.report.as_ref().unwrap();
    assert!(report.ok && report.dry_run && !report.same, "{report:?}");
    assert!(report.counts.add > 0, "{:?}", report.counts);
    assert!(!report.developer_mode, "받은 원본은 개발자 모드가 아니다");
    assert!(same_path(
        Path::new(report.repo.as_deref().unwrap()),
        &h.locations.repo_dir()
    ));
    assert!(same_path(
        Path::new(report.claude_dir.as_deref().unwrap()),
        &h.locations.claude_dir
    ));
    assert_eq!(
        content_snapshot(&h.locations.claude_dir),
        empty_claude,
        "미리보기가 파일을 만들었다"
    );
    assert!(!h.locations.backups_dir().exists());

    // 4) 설치 (미리보기를 돌린 그 원본으로)
    let done = flow::install(&state, &ctx).unwrap();
    assert_eq!(done.outcome, ScriptOutcome::Ran, "{done:?}");
    assert_eq!(done.script, preview.script, "미리본 스크립트를 돌렸다");
    assert_eq!(done.exit_code, Some(0), "{done:?}");
    let report = done.report.as_ref().unwrap();
    assert!(report.ok && !report.dry_run, "{report:?}");
    assert_installed(&h.locations.claude_dir);
    println!(
        "install mode: {:?}, restartNeeded {}",
        report.mode, report.restart_needed
    );

    // 5) 다시 미리보기 = 같음, 원본 표시는 앱이 받은 repo
    let again = flow::install_plan(&state, &ctx).unwrap();
    assert!(again.report.as_ref().unwrap().same, "{again:?}");
    assert_eq!(again.report.as_ref().unwrap().changes.len(), 0);
    let st = status(&ctx);
    assert_eq!(st.origin.kind, OriginKind::Repo, "{:?}", st.origin);
    assert!(!st.developer_mode);

    // 6) 원본에 새 커밋 (작업자 파일 한 줄 바꿈) → 확인 → 받기 → 미리보기에 바뀜 → 설치(백업) → 되돌리기
    let before_update = content_snapshot(&h.locations.claude_dir);
    let target = origin
        .join("agents")
        .join(first_agent(&h.locations.claude_dir).file_name().unwrap());
    let mut text = fs::read_to_string(&target).unwrap();
    text.push_str("\n<!-- nyanitor test line -->\n");
    fs::write(&target, text).unwrap();
    git(&origin, &["add", "-A"]);
    git(&origin, &["commit", "-q", "-m", "docs: 작업자 한 줄 더"]);

    // 확인 없이는 받지 않고, 확인 때 본 커밋까지만 받는다
    let early = flow::update_pull(&state, &ctx).unwrap();
    assert_eq!(early.reason.as_deref(), Some("check_first"), "{early:?}");
    let checked = flow::update_check(&state, &ctx).unwrap();
    assert_eq!(checked.outcome, GitOutcome::Checked, "{checked:?}");
    let update = checked.update.as_ref().unwrap();
    assert_eq!(update.behind, 1);
    assert!(update.can_pull);
    assert_eq!(update.files.len(), 1);
    let pulled = flow::update_pull(&state, &ctx).unwrap();
    assert_eq!(pulled.outcome, GitOutcome::Updated, "{pulled:?}");
    assert_eq!(pulled.pulled_total, 1, "{pulled:?}");

    // 받은 뒤의 설치 미리보기만 설치할 수 있다 (받기 전에 본 미리보기는 낡았다)
    let stale = flow::install(&state, &ctx).unwrap();
    assert_eq!(stale.outcome, ScriptOutcome::Refused, "{stale:?}");
    let changed = flow::install_plan(&state, &ctx).unwrap();
    let changed_report = changed.report.as_ref().unwrap();
    assert!(
        !changed_report.same && changed_report.counts.change >= 1,
        "{changed_report:?}"
    );
    let updated = flow::install(&state, &ctx).unwrap();
    assert_eq!(updated.exit_code, Some(0), "{updated:?}");
    let backup = updated
        .report
        .as_ref()
        .unwrap()
        .backup
        .clone()
        .expect("a backup is made when files are overwritten");
    assert!(backup.files >= 1);
    assert!(updated.prune.is_some());
    assert_ne!(content_snapshot(&h.locations.claude_dir), before_update);

    let list = backups_list(&ctx);
    let ids: Vec<String> = list
        .report
        .as_ref()
        .unwrap()
        .backups
        .iter()
        .map(|b| b.id.clone())
        .collect();
    assert!(ids.contains(&backup.id), "{ids:?}");
    // 되돌리기 미리보기 없이는 되돌리지 않는다
    let early = flow::restore(&state, &ctx, &backup.id).unwrap();
    assert_eq!(early.outcome, ScriptOutcome::Refused, "{early:?}");
    let preview = flow::restore_plan(&state, &ctx, &backup.id).unwrap();
    assert!(preview.report.as_ref().unwrap().dry_run, "{preview:?}");
    let restored = flow::restore(&state, &ctx, &backup.id).unwrap();
    assert_eq!(restored.exit_code, Some(0), "{restored:?}");
    assert_eq!(
        content_snapshot(&h.locations.claude_dir),
        before_update,
        "되돌리기 뒤에는 업데이트 설치 전과 같아야 한다"
    );

    // 7) 실제 `~/.claude` · `~/.claude-harness` 는 그대로
    assert_eq!(real_shape(), real_before, "실제 폴더가 바뀌었다");
}

#[test]
#[ignore = "runs the real harness install scripts (in temp folders) — see the header"]
fn flow_b_developer_mode_with_the_real_origin_path() {
    let real_before = real_shape();
    let src = harness_src();
    let h = HarnessRoot::new("real-harness-b");
    println!("temp root: {}  origin: {}", h.root.display(), src.display());
    let ctx = h.ctx();
    let state = HarnessState::default();

    // 개발자 PC 처럼: `~/.claude/harness` 의 복사 표시가 다른 원본(하네스 저장소)을 가리킨다
    fs::create_dir_all(h.locations.installed_harness()).unwrap();
    fs::write(
        h.locations.installed_harness().join(".install-mode"),
        format!("copy\n{}\n", src.display()),
    )
    .unwrap();
    let st = status(&ctx);
    assert!(st.developer_mode, "{:?}", st.origin);
    assert_eq!(st.origin.kind, OriginKind::Developer);
    assert!(
        same_path(Path::new(st.source_dir.as_deref().unwrap()), &src),
        "{:?}",
        st.source_dir
    );
    assert!(st.script_path.is_some());
    // 개발자 모드에서는 받기 · 업데이트를 하지 않는다
    assert_eq!(clone_origin(&ctx).outcome, GitOutcome::DeveloperMode);
    for result in [
        flow::update_check(&state, &ctx).unwrap(),
        flow::update_pull(&state, &ctx).unwrap(),
    ] {
        assert_eq!(result.outcome, GitOutcome::DeveloperMode, "{result:?}");
    }
    assert!(!h.locations.repo_dir().exists());

    let before = content_snapshot(&h.locations.claude_dir);
    let preview = flow::install_plan(&state, &ctx).unwrap();
    assert_eq!(preview.outcome, ScriptOutcome::Ran, "{preview:?}");
    let report = preview.report.as_ref().unwrap();
    assert!(
        report.ok && report.dry_run && report.developer_mode,
        "{report:?}"
    );
    assert_eq!(content_snapshot(&h.locations.claude_dir), before);

    let done = flow::install(&state, &ctx).unwrap();
    assert_eq!(done.exit_code, Some(0), "{done:?}");
    assert!(done.report.as_ref().unwrap().ok);
    assert_installed(&h.locations.claude_dir);
    let again = flow::install_plan(&state, &ctx).unwrap();
    assert!(
        again.report.as_ref().unwrap().same,
        "다시 설치하면 같다: {again:?}"
    );

    // 되돌리기 = 설치 전(표시 파일만 있던 모습)과 같다
    let list = backups_list(&ctx);
    let newest = list
        .report
        .as_ref()
        .unwrap()
        .backups
        .first()
        .expect("a backup")
        .id
        .clone();
    flow::restore_plan(&state, &ctx, &newest).unwrap();
    let restored = flow::restore(&state, &ctx, &newest).unwrap();
    assert_eq!(restored.exit_code, Some(0), "{restored:?}");
    assert_eq!(
        content_snapshot(&h.locations.claude_dir),
        before,
        "되돌리기 뒤에는 설치 전과 같아야 한다"
    );

    assert_eq!(real_shape(), real_before, "실제 폴더가 바뀌었다");
}

/// 이 PC 의 실제 상태를 **읽기만** 해서 보인다 (`harness_status` 명령이 돌려줄 값). 아무것도 쓰지 않고 시작 · 끝의 모양을 비교한다.
#[test]
#[ignore = "reads this PC's real ~/.claude and ~/.claude-harness (read only) — see the header"]
fn this_pcs_real_status_is_read_only() {
    let real_before = real_shape();
    let st = nyanitor_lib::harness::status::status_here();
    println!("{}", serde_json::to_string_pretty(&st).unwrap());
    assert!(st.git.found, "git should be found on this PC");
    assert!(st.claude_dir.is_some() && st.harness_home.is_some());
    // 읽기 전용 미리보기 · 백업 목록도 돌려 본다 (아무것도 쓰지 않는다)
    let ctx = nyanitor_lib::harness::Context::here().unwrap();
    let preview = plan(&ctx);
    println!(
        "plan: outcome={:?} exit={:?} counts={:?} same={:?} developerMode={:?}",
        preview.outcome,
        preview.exit_code,
        preview.report.as_ref().map(|r| r.counts.clone()),
        preview.report.as_ref().map(|r| r.same),
        preview.report.as_ref().map(|r| r.developer_mode),
    );
    let list = backups_list(&ctx);
    println!(
        "backups: outcome={:?} ids={:?}",
        list.outcome,
        list.report
            .as_ref()
            .map(|r| r.backups.iter().map(|b| b.id.clone()).collect::<Vec<_>>())
    );
    assert_eq!(
        real_shape(),
        real_before,
        "읽기만 했는데 실제 폴더가 바뀌었다"
    );
}

/// 진짜 스크립트의 한글 오류 줄이 앱에서 깨지지 않고 읽히는가 — 번호 확인을 일부러 건너뛰어(시험 전용 직접 호출) 없는 백업을 되돌려 본다.
/// 임시 폴더만 쓰고, 아무것도 쓰지 않는다 (없는 백업은 거절된다).
#[test]
#[ignore = "runs the real harness install script (in temp folders) — see the header"]
fn real_script_korean_error_text_arrives_as_utf8() {
    use nyanitor_lib::claude::exec::ClaudeCommand;
    use nyanitor_lib::harness::script::{
        Op, Parsed, build_args, parse_output, system_powershell_exe,
    };
    let src = harness_src();
    let h = HarnessRoot::new("real-harness-utf8");
    let script = src.join(nyanitor_lib::harness::locate::script_name());
    let op = Op::Restore("2026-01-01_000000".into());
    let program = if cfg!(windows) {
        system_powershell_exe(std::env::var_os("SystemRoot").as_deref())
    } else {
        PathBuf::from("/bin/bash")
    };
    let out = ClaudeCommand::new(program)
        .with_extra_env("CLAUDE_CONFIG_DIR", h.locations.claude_dir.as_os_str())
        .with_extra_env("CLAUDE_HARNESS_HOME", h.locations.harness_home.as_os_str())
        .run_capture(
            build_args(&op, &script, cfg!(windows)),
            std::time::Duration::from_secs(120),
        )
        .expect("run the real script");
    println!("exit {:?}\nstdout: {}", out.code, out.stdout);
    assert_eq!(out.code, Some(2));
    let Parsed::Report { report, .. } = parse_output(&out.stdout, &out.stderr, "restore") else {
        panic!("the real script's JSON should be readable");
    };
    let error = report.error.expect("an error for a missing backup");
    assert_eq!(error.code, "noBackup");
    let detail = error.detail.unwrap();
    assert!(
        detail.contains("그런 백업이 없습니다"),
        "한글이 깨졌다: {detail}"
    );
    assert!(!detail.contains('\u{fffd}'), "대체 글자가 섞였다: {detail}");
    assert!(!h.locations.backups_dir().exists());
}
