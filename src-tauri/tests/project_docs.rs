//! 하네스 문서 읽기 시험 (P7-01) — 고정 문서 파일(`tests/fixtures/docs/`, 실제 프로젝트 문서가 아니라 모양만 본뜬 가짜)을 폴더에 놓고 공개 함수로 읽는다.
//! 글 조각 하나하나의 읽기 경계는 `src/projects/progress.rs` · `docs.rs` 의 단위 시험이 본다.
//! 실제 프로젝트로 한 번 돌려 보려면: `NYANITOR_REAL_PROJECT=<프로젝트 폴더> cargo test --test project_docs real_project -- --ignored --nocapture`

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use common::*;
use nyanitor_lib::projects::docs::{DocReadResult, Limits, ListResult, list_in, read_in};
use nyanitor_lib::projects::progress::{
    HandoffResult, NowState, PhaseStatus, PlanResult, Section, TaskStatus, read_in as read_progress,
};

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/docs")
        .join(name);
    fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()))
}

/// 고정 문서를 놓은 프로젝트 폴더 (`docs/02-development/` + `docs/` 의 다른 문서들)
fn project() -> TestDir {
    let root = unique_dir("project-docs");
    let dev = root.join("docs").join("02-development");
    fs::create_dir_all(dev.join("briefs")).unwrap();
    for name in [
        "dev-plan.md",
        "handoff.md",
        "briefs/P7-01-project-docs.md",
        "briefs/P7-02-session-events.md",
        "briefs/P6-12-cards.md",
    ] {
        fs::write(dev.join(name), fixture(name)).unwrap();
    }
    fs::create_dir_all(root.join("docs").join("01-planning")).unwrap();
    fs::write(root.join("docs/01-planning/plan.md"), "# 기획\n").unwrap();
    fs::write(root.join("docs/01-planning/image.png"), [0u8; 4]).unwrap();
    fs::create_dir_all(root.join("docs/.obsidian")).unwrap();
    fs::write(root.join("docs/.obsidian/workspace.md"), "숨김").unwrap();
    root
}

#[test]
fn fixture_plan_has_twelve_phases_with_the_right_states() {
    let root = project();
    let result = read_progress(&root, "docs", SystemTime::now());
    let PlanResult::Ok(plan) = result.plan else {
        panic!("plan: {:?}", result.plan);
    };
    let ids: Vec<&str> = plan.phases.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"
        ]
    );
    let done = plan
        .phases
        .iter()
        .filter(|p| p.status == PhaseStatus::Done)
        .count();
    assert_eq!(done, 7, "P0 ~ P6");
    assert_eq!(plan.phases[7].status, PhaseStatus::Now);
    assert!(
        plan.phases[8..]
            .iter()
            .all(|p| p.status == PhaseStatus::Todo)
    );
    // 칸 안의 이스케이프 안 된 `|` 와 끝의 `|` 가 없는 줄
    assert_eq!(
        plan.phases[6].status_text,
        "완료 (2026-11-07) — 작업 공간 [채팅 | 요구사항] 탭 · 카드 하나씩"
    );
    assert_eq!(plan.phases[11].gate, "설치본 확인");
    assert_eq!(plan.phases[11].status, PhaseStatus::Todo);
    // 담당 → · 함께
    assert_eq!(plan.phases[5].owners.len(), 3);
    assert_eq!(plan.phases[5].owners[1], ["ui", "system"]);
    assert_eq!(plan.phases[7].name.as_deref(), Some("진행 보기"));
    assert_eq!(
        plan.phases[7].goal.as_deref(),
        Some("지금 무엇이 진행 중인지 한눈에 (D-13).")
    );
}

#[test]
fn fixture_handoff_reads_the_state_the_tasks_and_the_progress() {
    let root = project();
    let HandoffResult::Ok(handoff) = read_progress(&root, "docs", SystemTime::now()).handoff else {
        panic!("handoff");
    };
    assert_eq!(handoff.skill.as_deref(), Some("desktop-app"));
    assert_eq!(handoff.updated.as_deref(), Some("2026-11-07"));
    let Section::Ok { value: now } = &handoff.current else {
        panic!("current");
    };
    assert_eq!(now.state, NowState::Working);
    let Section::Ok { value: tasks } = &handoff.tasks else {
        panic!("tasks");
    };
    assert_eq!(tasks.len(), 9, "경로가 없는 줄도 한 줄로 센다");
    let progress = |id: &str| {
        tasks
            .iter()
            .find(|t| t.id.as_deref() == Some(id))
            .unwrap()
            .progress
            .map(|p| (p.done, p.total))
    };
    assert_eq!(progress("P7-01"), Some((2, 3)));
    assert_eq!(progress("P7-02"), Some((0, 2)));
    // 끝난 작업은 읽지 않는다 — 파일이 있어도 `null`
    assert_eq!(progress("P6-12"), None);
    // 파일이 없는 지시서
    assert_eq!(progress("P6-11"), None);
    let status = |id: &str| {
        tasks
            .iter()
            .find(|t| t.id.as_deref() == Some(id))
            .unwrap()
            .status
    };
    assert_eq!(status("P7-02"), TaskStatus::Redo);
    assert_eq!(status("P6-11"), TaskStatus::Passed);
    assert_eq!(status("P6-09"), TaskStatus::Unknown);
    assert_eq!(handoff.waiting, Section::Ok { value: vec![] });
    let Section::Ok { value: next } = &handoff.next else {
        panic!("next");
    };
    assert_eq!(next.len(), 2);
}

#[test]
fn the_version_is_cheap_and_follows_the_files() {
    let root = project();
    let result = read_progress(&root, "docs", SystemTime::now());
    assert!(!result.version.is_empty());
    let later = SystemTime::now() + std::time::Duration::from_secs(3600);
    let before = nyanitor_lib::projects::progress::version_in(&root, "docs", later);
    assert_eq!(
        before,
        nyanitor_lib::projects::progress::version_in(&root, "docs", later)
    );
    let handoff = root.join("docs/02-development/handoff.md");
    fs::write(&handoff, fixture("handoff.md") + "\n- 한 줄 더\n").unwrap();
    assert_ne!(
        before,
        nyanitor_lib::projects::progress::version_in(&root, "docs", later)
    );
}

#[test]
fn the_docs_list_and_read_work_on_the_fixture_project() {
    let root = project();
    let ListResult::Ok(listing) = list_in(&root, "docs", &Limits::DEFAULT) else {
        panic!("list");
    };
    let paths: Vec<&str> = listing.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "01-planning/plan.md",
            "02-development/briefs/P6-12-cards.md",
            "02-development/briefs/P7-01-project-docs.md",
            "02-development/briefs/P7-02-session-events.md",
            "02-development/dev-plan.md",
            "02-development/handoff.md",
        ]
    );
    assert!(!listing.truncated);
    let DocReadResult::Ok(text) = read_in(&root, "docs", "01-planning/plan.md").unwrap() else {
        panic!("read");
    };
    assert_eq!(text.text, "# 기획\n");
    // 숨은 폴더의 문서 · 밖으로 나가는 경로는 읽지 않는다
    assert!(read_in(&root, "docs", ".obsidian/workspace.md").is_err());
    assert!(read_in(&root, "docs", "../requirements.md").is_err());
    assert!(read_in(&root, "docs", "01-planning/image.png").is_err());
}

/// 실제 프로젝트의 문서로 한 번 돌려 본다 (`NYANITOR_REAL_PROJECT` 가 가리키는 폴더, 하네스 설정 `docsDir` 는 `docs` 로 본다). 읽기만 한다.
#[test]
#[ignore = "needs NYANITOR_REAL_PROJECT (a project folder with harness docs)"]
fn real_project_reads_without_unreadable_surprises() {
    let Some(root) = std::env::var_os("NYANITOR_REAL_PROJECT") else {
        panic!("set NYANITOR_REAL_PROJECT to a project folder");
    };
    let root = Path::new(&root);
    let result = read_progress(root, "docs", SystemTime::now());
    println!("version: {}", result.version);
    match &result.plan {
        PlanResult::Ok(plan) => {
            println!("plan: {} phases", plan.phases.len());
            for phase in &plan.phases {
                println!(
                    "  {} {:?} owners={:?} name={:?} status_text={:?}",
                    phase.id, phase.status, phase.owners, phase.name, phase.status_text
                );
            }
        }
        other => println!("plan: {other:?}"),
    }
    match &result.handoff {
        HandoffResult::Ok(handoff) => {
            println!(
                "handoff: skill={:?} phase={:?} updated={:?}",
                handoff.skill, handoff.phase, handoff.updated
            );
            println!("  current: {:?}", handoff.current);
            match &handoff.tasks {
                Section::Ok { value } => {
                    println!("  tasks: {} rows", value.len());
                    for task in value {
                        println!(
                            "    {:?} id={:?} owner={:?} {:?} {:?} progress={:?}",
                            task.brief,
                            task.id,
                            task.owner,
                            task.status,
                            task.status_text,
                            task.progress
                        );
                    }
                }
                other => println!("  tasks: {other:?}"),
            }
            println!("  waiting: {:?}", handoff.waiting);
            println!("  next: {:?}", handoff.next);
        }
        other => println!("handoff: {other:?}"),
    }
    match list_in(root, "docs", &Limits::DEFAULT) {
        ListResult::Ok(listing) => println!(
            "docs: {} files, truncated={}",
            listing.files.len(),
            listing.truncated
        ),
        other => println!("docs: {other:?}"),
    }
}
