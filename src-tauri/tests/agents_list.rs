//! 에이전트 목록 시험 (P5-01) — 폴더 링크(Windows 는 정션)로 설치된 모양. 파일 하나하나의 읽기 경계는 `src/agents/` 의 단위 시험이 본다.

mod common;

use std::fs;

use common::*;
use nyanitor_lib::agents::config::ConfigState;
use nyanitor_lib::agents::{AgentEntry, AgentRole, AgentsState, list};

fn agent(name: &str) -> String {
    format!("---\nname: {name}\ndescription: {name} 소개\nmodel: sonnet\n---\n본문\n")
}

#[test]
fn a_linked_harness_folder_and_a_linked_agents_folder_are_read_through_the_link() {
    let real = unique_dir("agents-real");
    fs::create_dir_all(real.join("harness-src")).unwrap();
    fs::write(
        real.join("harness-src").join("config.local.json"),
        r#"{"planner":{"model":"opus","effort":"high"},"agents":{"helper":"harness-helper"}}"#,
    )
    .unwrap();
    fs::create_dir_all(real.join("agents-src")).unwrap();
    fs::write(
        real.join("agents-src").join("harness-helper.md"),
        agent("harness-helper"),
    )
    .unwrap();

    // `~/.claude/harness` · `~/.claude/agents` 가 둘 다 링크 (링크 설치 · 정리해 둔 개인 설정 저장소)
    let claude = unique_dir("agents-linked");
    let linked_harness = make_dir_link(&claude.join("harness"), &real.join("harness-src"));
    let linked_agents = make_dir_link(&claude.join("agents"), &real.join("agents-src"));
    if !linked_harness || !linked_agents {
        eprintln!("폴더 링크를 만들 수 없는 PC — 건너뜀");
        return;
    }
    let result = list(&claude);
    assert_eq!(result.state, AgentsState::Ok);
    assert_eq!(result.config, ConfigState::Local);
    assert_eq!(result.agents.len(), 2);
    let AgentEntry::Ok(main) = &result.agents[0] else {
        panic!("main first");
    };
    assert_eq!(main.model.as_deref(), Some("opus"));
    let AgentEntry::Ok(helper) = &result.agents[1] else {
        panic!("helper readable: {:?}", result.agents[1]);
    };
    assert_eq!(helper.role, Some(AgentRole::Helper));
    assert_eq!(helper.model.as_deref(), Some("sonnet"));
}

#[test]
fn a_harness_link_that_points_nowhere_means_no_harness() {
    let real = unique_dir("agents-gone-real");
    fs::create_dir_all(real.join("target")).unwrap();
    let claude = unique_dir("agents-gone");
    if !make_dir_link(&claude.join("harness"), &real.join("target")) {
        return;
    }
    // 대상을 지우면 끊어진 링크 — 오류가 아니라 "하네스 없음"
    fs::remove_dir_all(real.join("target")).unwrap();
    let result = list(&claude);
    assert_eq!(result.state, AgentsState::NoHarness);
    assert!(result.agents.is_empty());
}
