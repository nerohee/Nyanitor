//! 설치 스크립트 실행 · JSON 읽기 시험 (P4-02 · P4-06) — 가짜 설치 스크립트(`tests/fixtures/harness/install.*`)가
//! 실제 스크립트가 낸 출력을 녹화해 둔 파일(`*.json`)을 그대로 내보낸다. 실제 `~/.claude` 는 어디에도 쓰이지 않는다.
//! 미리보기 → 설치 · 되돌리기 미리보기 → 되돌리기 순서는 앱이 기억한 것(`HarnessState`)을 거치는 `flow` 함수로 시험한다.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::harness::locate::script_name;
use nyanitor_lib::harness::script::{
    ScriptOutcome, ScriptResult, UnreadableReason, backups_list, install, plan, restore,
    restore_plan,
};
use nyanitor_lib::harness::{Context, HarnessState, flow};

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/harness")
        .join(name)
}

/// 가짜 원본(`<하네스 폴더>/repo`) — 가짜 스크립트와 `<명령>.out` 파일들이 들어 있다.
struct FakeRepo {
    h: HarnessRoot,
    ctx: Context,
    dir: PathBuf,
}

impl FakeRepo {
    fn new(name: &str, outs: &[(&str, &str)]) -> Self {
        let h = HarnessRoot::new(name);
        let dir = h.locations.repo_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::copy(fixture(script_name()), dir.join(script_name())).unwrap();
        for (op, file) in outs {
            fs::copy(fixture(file), dir.join(format!("{op}.out"))).unwrap();
        }
        let ctx = h.ctx_without_git();
        Self { h, ctx, dir }
    }

    fn exit_code(&self, op: &str, code: i32) {
        fs::write(self.dir.join(format!("{op}.exit")), format!("{code}\n")).unwrap();
    }

    fn sleep(&self, op: &str, seconds: u32) {
        fs::write(self.dir.join(format!("{op}.sleep")), format!("{seconds}\n")).unwrap();
    }

    /// 스크립트가 받은 호출들: `명령|인자|CFG=…|HOME=…`
    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }
}

fn windows_or<'a>(win: &'a str, other: &'a str) -> &'a str {
    if cfg!(windows) { win } else { other }
}

#[test]
fn plan_runs_the_fixed_options_with_our_locations_and_reads_the_recorded_json() {
    let fr = FakeRepo::new("script-plan", &[("plan", "plan-fresh.json")]);
    let result = plan(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    assert_eq!(result.exit_code, Some(0));
    let report = result.report.as_ref().unwrap();
    assert!(report.dry_run && report.ok);
    assert_eq!(report.counts.add, 74);
    assert_eq!(report.changes.len(), 74);
    assert!(report.developer_mode);
    assert!(
        result
            .raw
            .as_deref()
            .unwrap()
            .starts_with("{\"contract\":1")
    );
    assert!(result.script.as_deref().unwrap().ends_with(script_name()));
    assert!(result.prune.is_none());

    // 스크립트가 받은 것: 정해 둔 옵션 둘 + 앱이 정한 위치 (환경 변수로)
    let calls = fr.calls();
    assert_eq!(calls.len(), 1);
    let expected_args = windows_or("-Plan -Json", "--plan --json");
    assert_eq!(
        calls[0],
        format!(
            "plan|{expected_args}|CFG={}|HOME={}",
            fr.h.locations.claude_dir.display(),
            fr.h.locations.harness_home.display()
        )
    );
    // 미리보기는 아무것도 쓰지 않는다 (백업 폴더 · ~/.claude 모두)
    assert!(!fr.h.locations.backups_dir().exists());
    assert_eq!(fs::read_dir(&fr.h.locations.claude_dir).unwrap().count(), 0);
}

#[test]
fn folders_with_spaces_and_korean_names_work_for_the_script_and_the_locations() {
    // 사용자 이름 · 폴더에 공백 · 한글이 있어도 스크립트 경로와 위치 환경 변수가 그대로 간다
    let fr = FakeRepo::new("스크립트 시험 공간", &[("plan", "plan-same.json")]);
    let result = plan(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    let calls = fr.calls();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(
        calls[0].contains(&format!("CFG={}", fr.h.locations.claude_dir.display())),
        "{calls:?}"
    );
    assert!(
        calls[0].contains(&format!("HOME={}", fr.h.locations.harness_home.display())),
        "{calls:?}"
    );
    assert!(fr.dir.display().to_string().contains("스크립트 시험 공간"));
}

#[test]
fn korean_text_in_the_output_survives_as_utf8() {
    let fr = FakeRepo::new("script-utf8", &[("restore", "restore-nobackup.json")]);
    fr.exit_code("restore", 2);
    // 번호 확인 단계를 건너뛰려고 목록도 준비
    fs::copy(fixture("backups.json"), fr.dir.join("backups.out")).unwrap();
    let result = restore(&fr.ctx, "2026-10-22_134952").unwrap();
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    assert_eq!(result.exit_code, Some(2));
    let error = result.report.unwrap().error.unwrap();
    assert_eq!(error.code, "noBackup");
    assert!(error.detail.unwrap().contains("그런 백업이 없습니다"));
}

#[test]
fn exit_codes_1_2_and_3_with_json_are_normal_results_and_3_advises_a_restore() {
    for (code, file, advised) in [
        (1, "plan-same.json", false),
        (2, "install-problems.json", false),
        (3, "install-exit3.json", true),
    ] {
        let fr = FakeRepo::new(
            &format!("script-exit-{code}"),
            &[("install", file), ("plan", file)],
        );
        fr.exit_code("install", code);
        let result = install(&fr.ctx);
        assert_eq!(result.outcome, ScriptOutcome::Ran, "{code}: {result:?}");
        assert_eq!(result.exit_code, Some(code));
        assert_eq!(result.restore_advised, advised, "{code}");
        assert!(result.report.is_some() && result.raw.is_some());
        // 같은 녹화가 미리보기에서도 읽힌다
        fr.exit_code("plan", code);
        assert_eq!(plan(&fr.ctx).outcome, ScriptOutcome::Ran, "{code}");
    }
}

#[test]
fn an_exit_3_report_keeps_rolled_back_and_the_error_text() {
    let fr = FakeRepo::new("script-exit3", &[("install", "install-exit3.json")]);
    fr.exit_code("install", 3);
    let result = install(&fr.ctx);
    let report = result.report.unwrap();
    assert!(!report.ok);
    assert_eq!(report.rolled_back, Some(false));
    assert_eq!(report.error.unwrap().code, "writeFailed");
    assert!(
        result.prune.is_none(),
        "실패한 설치는 백업을 정리하지 않는다"
    );
}

#[test]
fn problems_origin_changes_and_warnings_are_carried_through() {
    let fr = FakeRepo::new("script-problems", &[("plan", "install-problems.json")]);
    fr.exit_code("plan", 2);
    let report = plan(&fr.ctx).report.unwrap();
    assert!(!report.ok);
    assert_eq!(report.problems[0].reason, "symlinkInCustom");
    assert_eq!(report.warnings[0].reason, "noOriginHash");
    assert_eq!(report.origin_changed[0].path, "agents/harness-designer.md");
    assert_eq!(report.origin_changed[0].current, None);
    let custom = report.custom.unwrap();
    assert_eq!(custom.items[0].kind, "replace");
    assert_eq!(custom.items[0].origin_changed, Some(true));
}

#[test]
fn broken_json_is_unreadable_with_the_text_and_the_exit_code_not_a_crash() {
    let fr = FakeRepo::new("script-garbage", &[("plan", "garbage.txt")]);
    fr.exit_code("plan", 5);
    let result = plan(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Unreadable, "{result:?}");
    assert_eq!(result.exit_code, Some(5));
    assert!(result.report.is_none() && result.raw.is_none());
    let why = result.unreadable.unwrap();
    assert_eq!(why.reason, UnreadableReason::BadJson);
    assert!(why.head.contains("Something went wrong"), "{why:?}");
}

#[test]
fn a_writing_command_that_ends_unreadable_advises_a_restore_and_a_reading_one_does_not() {
    // 깨진 출력 · JSON 없이 종료 코드 1 / 5 · 약속 버전 모름 — 설치와 되돌리기는 어디까지 썼는지 모른다
    for (name, file, code) in [
        ("garbage-5", "garbage.txt", 5),
        ("garbage-1", "garbage.txt", 1),
        ("contract2", "contract2.json", 0),
        ("empty-1", "backups-empty.json", 1),
    ] {
        let fr = restore_repo(&format!("advise-{name}"));
        // `backups-empty.json` 은 읽히지만 부른 명령(`install`)이 아니라서 읽을 수 없는 결과다
        fs::copy(fixture(file), fr.dir.join("install.out")).unwrap();
        fs::copy(fixture(file), fr.dir.join("restore.out")).unwrap();
        fs::copy(fixture(file), fr.dir.join("restore-plan.out")).unwrap();
        fs::copy(fixture(file), fr.dir.join("plan.out")).unwrap();
        for op in ["install", "restore", "restore-plan", "plan"] {
            fr.exit_code(op, code);
        }
        let installed = install(&fr.ctx);
        assert_eq!(
            installed.outcome,
            ScriptOutcome::Unreadable,
            "{name}: {installed:?}"
        );
        assert!(installed.restore_advised, "{name}: install");
        let restored = restore(&fr.ctx, LISTED).unwrap();
        assert_eq!(
            restored.outcome,
            ScriptOutcome::Unreadable,
            "{name}: {restored:?}"
        );
        assert!(restored.restore_advised, "{name}: restore");
        // 아무것도 쓰지 않는 일은 권하지 않는다
        let planned = plan(&fr.ctx);
        assert_eq!(planned.outcome, ScriptOutcome::Unreadable, "{name}");
        assert!(!planned.restore_advised, "{name}: plan");
        let previewed = restore_plan(&fr.ctx, LISTED).unwrap();
        assert!(!previewed.restore_advised, "{name}: restore plan");
    }
    // 백업 목록이 읽을 수 없으면 되돌리기까지 가지 않는다 (그 결과가 돌아오고 권하지 않는다)
    let fr = restore_repo("advise-list");
    fs::copy(fixture("garbage.txt"), fr.dir.join("backups.out")).unwrap();
    let listed = backups_list(&fr.ctx);
    assert_eq!(listed.outcome, ScriptOutcome::Unreadable);
    assert!(!listed.restore_advised);
}

#[test]
fn empty_output_is_unreadable_no_json() {
    let fr = FakeRepo::new("script-empty", &[]);
    let result = plan(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Unreadable);
    assert_eq!(result.unreadable.unwrap().reason, UnreadableReason::NoJson);
}

#[test]
fn an_unknown_contract_version_is_unreadable_and_names_the_version() {
    let fr = FakeRepo::new("script-contract2", &[("plan", "contract2.json")]);
    let result = plan(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Unreadable, "{result:?}");
    let why = result.unreadable.unwrap();
    assert_eq!(why.reason, UnreadableReason::UnknownContract);
    assert_eq!(why.contract.as_deref(), Some("2"));
    assert!(why.head.starts_with("{\"contract\":2"));
}

#[test]
fn unknown_codes_are_passed_on_as_plain_text() {
    let fr = FakeRepo::new("script-unknown", &[("plan", "unknown-codes.json")]);
    fr.exit_code("plan", 2);
    let result = plan(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    let report = result.report.unwrap();
    assert_eq!(report.mode.as_deref(), Some("hologram"));
    assert_eq!(report.changes[0].action, "teleport");
    assert_eq!(report.problems[0].reason, "neverSeenBefore");
    assert_eq!(report.error.unwrap().code, "neverSeenCode");
    // 원문도 그대로 있다 (모르는 키 `future` 포함)
    assert!(result.raw.unwrap().contains("\"future\""));
}

#[test]
fn a_script_that_prints_json_for_another_command_is_not_trusted() {
    // 설치를 불렀는데 백업 목록 JSON 이 나온다
    let fr = FakeRepo::new("script-wrong-command", &[("install", "backups.json")]);
    let result = install(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Unreadable);
    assert_eq!(
        result.unreadable.unwrap().reason,
        UnreadableReason::UnexpectedCommand
    );
    assert!(result.prune.is_none());
    // 무엇을 썼는지 알 수 없는 결과다 — 되돌리기를 권한다
    assert!(result.restore_advised);
}

#[test]
fn without_a_script_nothing_runs_and_nothing_is_created() {
    let h = HarnessRoot::new("script-none");
    let ctx = h.ctx_without_git();
    for result in [plan(&ctx), backups_list(&ctx), install(&ctx)] {
        assert_eq!(result.outcome, ScriptOutcome::NoScript, "{result:?}");
        assert!(result.exit_code.is_none());
    }
    assert_eq!(
        restore(&ctx, "2026-10-22_134952").unwrap().outcome,
        ScriptOutcome::NoScript
    );
    assert!(!h.locations.repo_dir().exists());
}

#[test]
fn a_script_that_does_not_finish_is_stopped_at_the_time_limit() {
    let fr = FakeRepo::new(
        "script-timeout",
        &[
            ("plan", "plan-same.json"),
            ("install", "install-change.json"),
        ],
    );
    fr.sleep("plan", 30);
    fr.sleep("install", 30);
    let ctx = fr.ctx.clone().with_timeout(Duration::from_secs(2));
    let started = Instant::now();
    let result = plan(&ctx);
    assert_eq!(result.outcome, ScriptOutcome::TimedOut, "{result:?}");
    assert!(!result.restore_advised);
    let result = install(&ctx);
    assert_eq!(result.outcome, ScriptOutcome::TimedOut);
    assert!(result.restore_advised, "설치가 중간에 끊겼을 수 있다");
    assert!(result.prune.is_none());
    assert!(
        started.elapsed() < Duration::from_secs(25),
        "{:?}",
        started.elapsed()
    );
}

// ───────────────────────────── 백업 번호 (되돌리기) ─────────────────────────────

const LISTED: &str = "2026-10-22_134952";

fn restore_repo(name: &str) -> FakeRepo {
    FakeRepo::new(
        name,
        &[
            ("backups", "backups.json"),
            ("restore-plan", "restore-plan.json"),
            ("restore", "restore.json"),
        ],
    )
}

#[test]
fn a_listed_backup_id_is_previewed_and_restored_after_the_list_is_checked_again() {
    let fr = restore_repo("restore-ok");
    let preview = restore_plan(&fr.ctx, LISTED).unwrap();
    assert_eq!(preview.outcome, ScriptOutcome::Ran, "{preview:?}");
    assert!(preview.report.as_ref().unwrap().dry_run);
    let done = restore(&fr.ctx, LISTED).unwrap();
    assert_eq!(done.outcome, ScriptOutcome::Ran);
    assert!(!done.report.as_ref().unwrap().dry_run);
    assert_eq!(done.report.unwrap().command, "restore");

    let calls: Vec<String> = fr
        .calls()
        .iter()
        .map(|c| c.split("|CFG=").next().unwrap().to_string())
        .collect();
    assert_eq!(
        calls,
        [
            format!(
                "backups|{}",
                windows_or("-Backups -Json", "--backups --json")
            ),
            format!(
                "restore-plan|{} {LISTED} {}",
                windows_or("-Restore", "--restore"),
                windows_or("-Plan -Json", "--plan --json")
            ),
            format!(
                "backups|{}",
                windows_or("-Backups -Json", "--backups --json")
            ),
            format!(
                "restore|{} {LISTED} {}",
                windows_or("-Restore", "--restore"),
                windows_or("-Json", "--json")
            ),
        ]
    );
}

#[test]
fn wrong_shaped_backup_ids_are_refused_before_any_script_runs() {
    let fr = restore_repo("restore-bad-shape");
    for bad in [
        "",
        "..",
        "..\\x",
        "../x",
        "2026-10-22_134952\\..\\..",
        "2026-10-22_134952; calc",
        "2026-10-22_134952 -Plan",
        "2026-10-22_134952\n",
        "2026-10-22",
        "-Json",
        "$(whoami)",
        "latest",
        "C:\\Windows",
    ] {
        for work in [restore_plan(&fr.ctx, bad), restore(&fr.ctx, bad)] {
            let error = work.unwrap_err();
            assert_eq!(error.kind(), "invalid_input", "{bad:?}");
        }
    }
    assert!(
        fr.calls().is_empty(),
        "스크립트는 한 번도 안 돌았다: {:?}",
        fr.calls()
    );
}

#[test]
fn a_well_shaped_id_that_is_not_in_the_current_list_is_refused_and_not_restored() {
    let fr = restore_repo("restore-not-listed");
    let error = restore(&fr.ctx, "2026-01-01_000000").unwrap_err();
    assert_eq!(error.kind(), "invalid_input");
    let error = restore_plan(&fr.ctx, "2026-10-22_134952-2").unwrap_err();
    assert_eq!(error.kind(), "invalid_input");
    // 목록만 불렀고 되돌리기는 부르지 않았다
    assert!(
        fr.calls().iter().all(|c| c.starts_with("backups|")),
        "{:?}",
        fr.calls()
    );
}

#[test]
fn when_the_backup_list_itself_is_unreadable_that_is_what_comes_back() {
    let fr = restore_repo("restore-list-garbage");
    fs::copy(fixture("garbage.txt"), fr.dir.join("backups.out")).unwrap();
    let result = restore(&fr.ctx, LISTED).unwrap();
    assert_eq!(result.outcome, ScriptOutcome::Unreadable);
    assert!(fr.calls().iter().all(|c| c.starts_with("backups|")));
}

#[test]
fn an_empty_backup_list_refuses_every_id() {
    let fr = restore_repo("restore-empty-list");
    fs::copy(fixture("backups-empty.json"), fr.dir.join("backups.out")).unwrap();
    assert_eq!(
        restore(&fr.ctx, LISTED).unwrap_err().kind(),
        "invalid_input"
    );
}

// ───────────────────────────── 설치 뒤 백업 정리 ─────────────────────────────

fn make_backup_folders(home: &Path, ids: &[String]) {
    for id in ids {
        let dir = home.join("backups").join(id);
        fs::create_dir_all(dir.join("files")).unwrap();
        fs::write(dir.join("manifest.txt"), "# id\n").unwrap();
    }
}

fn old_ids(n: usize) -> Vec<String> {
    (1..=n).map(|d| format!("2026-10-{d:02}_090000")).collect()
}

fn backup_names(home: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(home.join("backups"))
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_successful_install_that_made_a_backup_trims_thirteen_to_twelve() {
    let fr = FakeRepo::new("prune-after-install", &[("install", "install-change.json")]);
    // 녹화된 설치가 만들었다고 말하는 백업(`LISTED`) + 오래된 12개 = 13개
    let mut all = old_ids(12);
    all.push(LISTED.to_string());
    make_backup_folders(&fr.h.locations.harness_home, &all);
    let result = install(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    let pruned = result.prune.expect("백업을 정리했다");
    assert_eq!(pruned.removed, 1);
    assert_eq!(pruned.removed_ids, vec!["2026-10-01_090000"]);
    assert_eq!(pruned.kept, 12);
    let names = backup_names(&fr.h.locations.harness_home);
    assert_eq!(names.len(), 12);
    assert!(names.contains(&LISTED.to_string()));
    assert!(!names.contains(&"2026-10-01_090000".to_string()));
}

#[test]
fn a_preview_or_a_failed_install_never_trims_backups() {
    let fr = FakeRepo::new(
        "prune-never",
        &[
            ("plan", "install-change.json"),
            ("install", "install-exit3.json"),
        ],
    );
    let mut all = old_ids(12);
    all.push(LISTED.to_string());
    make_backup_folders(&fr.h.locations.harness_home, &all);
    fr.exit_code("install", 3);
    assert!(plan(&fr.ctx).prune.is_none());
    assert!(install(&fr.ctx).prune.is_none());
    assert_eq!(backup_names(&fr.h.locations.harness_home).len(), 13);
}

#[test]
fn an_install_that_changed_nothing_and_made_no_backup_does_not_trim() {
    // 바뀐 것이 없으면 스크립트는 백업을 만들지 않는다 (`backup: null`)
    let fr = FakeRepo::new("prune-no-backup", &[("install", "install-same.json")]);
    make_backup_folders(&fr.h.locations.harness_home, &old_ids(14));
    let result = install(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    assert!(result.report.as_ref().unwrap().ok);
    assert!(result.prune.is_none());
    assert_eq!(backup_names(&fr.h.locations.harness_home).len(), 14);
}

#[test]
fn trimming_follows_the_install_even_when_the_backup_folder_is_missing() {
    let fr = FakeRepo::new(
        "prune-missing-folder",
        &[("install", "install-change.json")],
    );
    let result = install(&fr.ctx);
    let pruned = result.prune.expect("정리 결과는 있다");
    assert_eq!((pruned.removed, pruned.kept), (0, 0));
    assert_eq!(pruned.skipped, None);
}

// ───────────────────────────── 정리와 스크립트 잠금 ─────────────────────────────

#[test]
fn the_backup_prune_waits_while_the_install_script_lock_exists() {
    let fr = FakeRepo::new("prune-locked", &[("install", "install-change.json")]);
    let mut all = old_ids(12);
    all.push(LISTED.to_string());
    make_backup_folders(&fr.h.locations.harness_home, &all);
    // 터미널의 설치 · 되돌리기가 돌고 있다 — 스크립트의 잠금이 남아 있다 (파일이든 폴더든)
    let lock = fr.h.locations.install_lock();
    assert!(lock.starts_with(&fr.h.locations.claude_dir));
    fs::create_dir_all(&lock).unwrap();
    let result = install(&fr.ctx);
    assert_eq!(result.outcome, ScriptOutcome::Ran, "{result:?}");
    let pruned = result.prune.expect("정리 결과는 알린다");
    assert_eq!(pruned.skipped.as_deref(), Some("locked"));
    assert_eq!((pruned.removed, pruned.kept), (0, 0));
    assert_eq!(backup_names(&fr.h.locations.harness_home).len(), 13);

    // 잠금이 풀리면 다음 설치부터 정리한다
    fs::remove_dir_all(&lock).unwrap();
    fs::write(&lock, "pid").unwrap();
    let still_locked = install(&fr.ctx);
    assert_eq!(
        still_locked.prune.unwrap().skipped.as_deref(),
        Some("locked")
    );
    fs::remove_file(&lock).unwrap();
    let after = install(&fr.ctx);
    let pruned = after.prune.unwrap();
    assert_eq!(pruned.skipped, None);
    assert_eq!(pruned.removed, 1);
    assert_eq!(backup_names(&fr.h.locations.harness_home).len(), 12);
}

// ───────────────────────────── 본 것만 한다 (미리보기 → 설치 · 되돌리기) ─────────────────────────────

fn assert_refused(result: &ScriptResult, reason: &str) {
    assert_eq!(result.outcome, ScriptOutcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some(reason), "{result:?}");
    assert!(result.report.is_none() && result.raw.is_none() && result.prune.is_none());
    assert!(!result.restore_advised);
}

fn install_repo(name: &str) -> FakeRepo {
    FakeRepo::new(
        name,
        &[
            ("plan", "plan-fresh.json"),
            ("install", "install-change.json"),
        ],
    )
}

#[test]
fn install_without_a_preview_is_refused_and_the_script_never_runs() {
    let fr = install_repo("flow-install-no-plan");
    let state = HarnessState::default();
    let result = flow::install(&state, &fr.ctx).unwrap();
    assert_refused(&result, "plan_first");
    assert!(fr.calls().is_empty(), "{:?}", fr.calls());
    // 읽기만 하는 일(백업 목록)은 미리보기를 대신하지 않는다
    flow::backups_list(&state, &fr.ctx).unwrap();
    assert_refused(&flow::install(&state, &fr.ctx).unwrap(), "plan_first");
    assert!(fr.calls().iter().all(|c| c.starts_with("backups|")));
}

#[test]
fn one_preview_allows_one_install_then_a_new_preview_is_needed() {
    let fr = install_repo("flow-install-once");
    let state = HarnessState::default();
    let planned = flow::install_plan(&state, &fr.ctx).unwrap();
    assert_eq!(planned.outcome, ScriptOutcome::Ran, "{planned:?}");
    let done = flow::install(&state, &fr.ctx).unwrap();
    assert_eq!(done.outcome, ScriptOutcome::Ran, "{done:?}");
    assert!(done.report.as_ref().unwrap().ok);
    assert_eq!(done.script, planned.script, "미리본 그 스크립트를 돌렸다");
    // 설치 뒤에는 본 것이 낡았다
    assert_refused(&flow::install(&state, &fr.ctx).unwrap(), "plan_first");
    let ops: Vec<String> = fr
        .calls()
        .iter()
        .map(|c| c.split('|').next().unwrap().to_string())
        .collect();
    assert_eq!(ops, ["plan", "install"]);
    // 다시 미리보면 다시 설치할 수 있다
    flow::install_plan(&state, &fr.ctx).unwrap();
    assert_eq!(
        flow::install(&state, &fr.ctx).unwrap().outcome,
        ScriptOutcome::Ran
    );
}

#[test]
fn a_preview_that_could_not_be_read_is_not_a_preview() {
    let fr = install_repo("flow-install-bad-plan");
    fs::copy(fixture("garbage.txt"), fr.dir.join("plan.out")).unwrap();
    let state = HarnessState::default();
    let planned = flow::install_plan(&state, &fr.ctx).unwrap();
    assert_eq!(planned.outcome, ScriptOutcome::Unreadable);
    assert_refused(&flow::install(&state, &fr.ctx).unwrap(), "plan_first");
    // 읽을 수 있던 미리보기 뒤에 읽을 수 없는 미리보기가 오면 앞의 것도 지운다
    fs::copy(fixture("plan-fresh.json"), fr.dir.join("plan.out")).unwrap();
    flow::install_plan(&state, &fr.ctx).unwrap();
    fs::copy(fixture("garbage.txt"), fr.dir.join("plan.out")).unwrap();
    flow::install_plan(&state, &fr.ctx).unwrap();
    assert_refused(&flow::install(&state, &fr.ctx).unwrap(), "plan_first");
}

/// 개발자 모드 원본 하나 (복사 표시가 가리킬 폴더): 가짜 스크립트 + 정해 둔 출력들
fn dev_source(h: &HarnessRoot, name: &str, outs: &[(&str, &str)]) -> PathBuf {
    let dir = h.root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::copy(fixture(script_name()), dir.join(script_name())).unwrap();
    for (op, file) in outs {
        fs::copy(fixture(file), dir.join(format!("{op}.out"))).unwrap();
    }
    dir
}

/// `~/.claude/harness` 의 복사 표시가 `source` 를 가리키게 한다 (개발자 모드)
fn point_at(h: &HarnessRoot, source: &Path) {
    let harness = h.locations.installed_harness();
    fs::create_dir_all(&harness).unwrap();
    fs::write(
        harness.join(".install-mode"),
        format!("copy\n{}\n", source.display()),
    )
    .unwrap();
}

fn calls_in(dir: &Path) -> Vec<String> {
    fs::read_to_string(dir.join("calls.log"))
        .unwrap_or_default()
        .lines()
        .map(|c| c.split('|').next().unwrap().to_string())
        .collect()
}

#[test]
fn an_install_refuses_when_the_source_changed_after_the_preview() {
    let h = HarnessRoot::new("flow-source-changed");
    let outs = [
        ("plan", "plan-fresh.json"),
        ("install", "install-change.json"),
    ];
    let first = dev_source(&h, "dev-a", &outs);
    let second = dev_source(&h, "dev-b", &outs);
    point_at(&h, &first);
    let ctx = h.ctx_without_git();
    let state = HarnessState::default();

    let planned = flow::install_plan(&state, &ctx).unwrap();
    assert_eq!(planned.outcome, ScriptOutcome::Ran, "{planned:?}");
    // 미리보기를 본 뒤에 표시가 다른 원본을 가리키게 바뀌었다
    point_at(&h, &second);
    let result = flow::install(&state, &ctx).unwrap();
    assert_refused(&result, "source_changed");
    assert_eq!(calls_in(&first), ["plan"]);
    assert!(
        calls_in(&second).is_empty(),
        "바뀐 원본의 스크립트는 돌지 않았다"
    );

    // 바뀐 원본으로 다시 미리보면 그 원본으로 설치할 수 있다
    flow::install_plan(&state, &ctx).unwrap();
    assert_eq!(
        flow::install(&state, &ctx).unwrap().outcome,
        ScriptOutcome::Ran
    );
    assert_eq!(calls_in(&second), ["plan", "install"]);
}

#[test]
fn an_install_refuses_when_the_previewed_script_is_gone() {
    let h = HarnessRoot::new("flow-source-gone");
    let outs = [
        ("plan", "plan-fresh.json"),
        ("install", "install-change.json"),
    ];
    let dev = dev_source(&h, "dev-a", &outs);
    point_at(&h, &dev);
    let ctx = h.ctx_without_git();
    let state = HarnessState::default();
    flow::install_plan(&state, &ctx).unwrap();
    fs::remove_file(dev.join(script_name())).unwrap();
    assert_refused(&flow::install(&state, &ctx).unwrap(), "source_changed");
}

#[test]
fn a_repo_source_that_turns_into_a_developer_source_after_the_preview_is_a_changed_source() {
    let fr = install_repo("flow-source-mode");
    let state = HarnessState::default();
    flow::install_plan(&state, &fr.ctx).unwrap();
    // 보통 흐름(`repo`)으로 미리본 뒤에 개발자 원본을 가리키게 됐다
    let dev = dev_source(&fr.h, "dev-x", &[("install", "install-change.json")]);
    point_at(&fr.h, &dev);
    assert_refused(&flow::install(&state, &fr.ctx).unwrap(), "source_changed");
    assert!(calls_in(&dev).is_empty());
    assert_eq!(calls_in(&fr.dir), ["plan"]);
}

#[test]
fn a_restore_needs_the_restore_preview_of_the_same_backup() {
    let fr = restore_repo("flow-restore-gate");
    let state = HarnessState::default();
    let other = "2026-10-21_101112";
    // 미리보기 없이는 안 된다 (스크립트는 번호 확인용 목록조차 부르지 않는다)
    assert_refused(
        &flow::restore(&state, &fr.ctx, LISTED).unwrap(),
        "plan_first",
    );
    assert!(fr.calls().is_empty(), "{:?}", fr.calls());

    // 다른 번호의 미리보기는 소용없다
    let planned = flow::restore_plan(&state, &fr.ctx, LISTED).unwrap();
    assert_eq!(planned.outcome, ScriptOutcome::Ran, "{planned:?}");
    assert_refused(
        &flow::restore(&state, &fr.ctx, other).unwrap(),
        "plan_first",
    );
    assert!(
        fr.calls().iter().all(|c| !c.starts_with("restore|")),
        "{:?}",
        fr.calls()
    );

    // 같은 번호면 된다 — 한 번만
    let done = flow::restore(&state, &fr.ctx, LISTED).unwrap();
    assert_eq!(done.outcome, ScriptOutcome::Ran, "{done:?}");
    assert!(!done.report.as_ref().unwrap().dry_run);
    assert_refused(
        &flow::restore(&state, &fr.ctx, LISTED).unwrap(),
        "plan_first",
    );
}

#[test]
fn a_newer_restore_preview_replaces_the_older_one_and_a_failed_one_clears_it() {
    let fr = restore_repo("flow-restore-replace");
    let state = HarnessState::default();
    flow::restore_plan(&state, &fr.ctx, LISTED).unwrap();
    // 번호를 잘못 넘긴 미리보기는 오류이고, 앞의 미리보기도 지운다
    assert_eq!(
        flow::restore_plan(&state, &fr.ctx, "../x")
            .unwrap_err()
            .kind(),
        "invalid_input"
    );
    assert_refused(
        &flow::restore(&state, &fr.ctx, LISTED).unwrap(),
        "plan_first",
    );
    // 설치 미리보기는 되돌리기 미리보기를 대신하지 않는다 (서로 다른 기억)
    flow::restore_plan(&state, &fr.ctx, LISTED).unwrap();
    flow::install_plan(&state, &fr.ctx).unwrap();
    assert_eq!(
        flow::restore(&state, &fr.ctx, LISTED).unwrap().outcome,
        ScriptOutcome::Ran
    );
}

#[test]
fn a_restore_refuses_when_the_source_changed_after_its_preview() {
    let h = HarnessRoot::new("flow-restore-source");
    let outs = [
        ("backups", "backups.json"),
        ("restore-plan", "restore-plan.json"),
        ("restore", "restore.json"),
    ];
    let first = dev_source(&h, "dev-a", &outs);
    let second = dev_source(&h, "dev-b", &outs);
    point_at(&h, &first);
    let ctx = h.ctx_without_git();
    let state = HarnessState::default();
    assert_eq!(
        flow::restore_plan(&state, &ctx, LISTED).unwrap().outcome,
        ScriptOutcome::Ran
    );
    point_at(&h, &second);
    assert_refused(
        &flow::restore(&state, &ctx, LISTED).unwrap(),
        "source_changed",
    );
    assert!(calls_in(&second).is_empty());
    assert!(!calls_in(&first).contains(&"restore".to_string()));
}

#[test]
fn a_restore_or_install_that_ran_makes_both_earlier_previews_stale() {
    let fr = FakeRepo::new(
        "flow-forget-all",
        &[
            ("plan", "plan-fresh.json"),
            ("install", "install-change.json"),
            ("backups", "backups.json"),
            ("restore-plan", "restore-plan.json"),
            ("restore", "restore.json"),
        ],
    );
    let state = HarnessState::default();
    flow::install_plan(&state, &fr.ctx).unwrap();
    flow::restore_plan(&state, &fr.ctx, LISTED).unwrap();
    assert_eq!(
        flow::install(&state, &fr.ctx).unwrap().outcome,
        ScriptOutcome::Ran
    );
    // 설치가 끝났으니 앞서 본 되돌리기 미리보기도 낡았다
    assert_refused(
        &flow::restore(&state, &fr.ctx, LISTED).unwrap(),
        "plan_first",
    );

    flow::install_plan(&state, &fr.ctx).unwrap();
    flow::restore_plan(&state, &fr.ctx, LISTED).unwrap();
    assert_eq!(
        flow::restore(&state, &fr.ctx, LISTED).unwrap().outcome,
        ScriptOutcome::Ran
    );
    assert_refused(&flow::install(&state, &fr.ctx).unwrap(), "plan_first");
}

// ───────────────────────────── 한 번에 하나: 명령이 거치는 잠금 ─────────────────────────────

#[test]
fn every_flow_function_takes_its_turn_first_and_a_busy_app_runs_nothing() {
    let fr = FakeRepo::new(
        "flow-busy",
        &[
            ("plan", "plan-fresh.json"),
            ("install", "install-change.json"),
            ("backups", "backups.json"),
            ("restore-plan", "restore-plan.json"),
            ("restore", "restore.json"),
        ],
    );
    let state = HarnessState::default();
    // 미리보기까지 본 상태에서도 — 다른 일이 도는 중이면 설치도 되돌리기도 시작하지 않는다
    flow::install_plan(&state, &fr.ctx).unwrap();
    flow::restore_plan(&state, &fr.ctx, LISTED).unwrap();
    let calls_before = fr.calls();

    let busy = state.begin().unwrap();
    let kinds = [
        flow::clone_origin(&state, &fr.ctx).map(|_| ()),
        flow::update_check(&state, &fr.ctx).map(|_| ()),
        flow::update_pull(&state, &fr.ctx).map(|_| ()),
        flow::install_plan(&state, &fr.ctx).map(|_| ()),
        flow::install(&state, &fr.ctx).map(|_| ()),
        flow::backups_list(&state, &fr.ctx).map(|_| ()),
        flow::restore_plan(&state, &fr.ctx, LISTED).map(|_| ()),
        flow::restore(&state, &fr.ctx, LISTED).map(|_| ()),
    ]
    .map(|result| result.unwrap_err().kind());
    assert_eq!(kinds, ["harness_busy"; 8]);
    assert_eq!(fr.calls(), calls_before, "스크립트는 한 번도 안 돌았다");
    // 잠금을 못 잡은 시도는 기억을 건드리지 않는다
    drop(busy);
    assert_eq!(
        flow::install(&state, &fr.ctx).unwrap().outcome,
        ScriptOutcome::Ran
    );
}
