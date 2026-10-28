//! 이 PC 의 실제 설치 · 실제 `claude` 로 (P5-01) — **기본으로는 돌지 않는다** (`#[ignore]`).
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test real_agents_usage -- --ignored --nocapture --test-threads=1
//! ```
//!
//! - `real_agents_list`: 실제 `~/.claude` (또는 `CLAUDE_CONFIG_DIR`)의 `agents/*.md` · `harness/config.local.json` 을 **읽기만** 한다 (구독 사용량 없음).
//! - `real_usage_read`: 실제 `claude` 로 `/usage` 를 한 번 읽는다 — 모델을 부르지 않지만(비용 0) 구독 한도를 읽는 호출이라 자주 돌리지 않는다.
//!   출력에는 한도 숫자와 시각만 적는다 (계정 정보 없음).

use nyanitor_lib::agents::{AgentEntry, AgentRole, AgentsState, list_here};
use nyanitor_lib::usage::{UsageResult, fetch};

/// 개인 경로 없이 한 줄 요약
fn describe(entry: &AgentEntry) -> String {
    match entry {
        AgentEntry::Ok(info) => format!(
            "ok         {:<8} {:<28} model={:<8} effort={:<7} color={:<7} readOnly={}",
            info.role.map_or("-", AgentRole::key),
            info.name,
            info.model.as_deref().unwrap_or("-"),
            info.effort.as_deref().unwrap_or("-"),
            info.color.as_deref().unwrap_or("-"),
            info.read_only
        ),
        AgentEntry::Unreadable(u) => format!(
            "unreadable {:<8} {:<28} reason={:?}",
            u.role.map_or("-", AgentRole::key),
            u.file,
            u.reason
        ),
    }
}

#[test]
#[ignore = "이 PC 의 실제 ~/.claude 를 읽는다"]
fn real_agents_list() {
    let list = list_here();
    println!(
        "state={:?} config={:?} missingRoles={:?}",
        list.state, list.config, list.missing_roles
    );
    for entry in &list.agents {
        println!("{}", describe(entry));
    }
    assert_eq!(list.state, AgentsState::Ok, "하네스가 설치된 PC 여야 한다");
    assert!(matches!(&list.agents[0], AgentEntry::Ok(info) if info.role == Some(AgentRole::Main)));
    assert!(list.missing_roles.is_empty(), "{:?}", list.missing_roles);
    for role in AgentRole::WORKERS {
        let found = list.agents.iter().any(|entry| match entry {
            AgentEntry::Ok(info) => info.role == Some(role),
            AgentEntry::Unreadable(u) => u.role == Some(role),
        });
        assert!(found, "역할 {role:?} 의 에이전트가 없다");
    }
    assert!(
        list.agents
            .iter()
            .all(|entry| matches!(entry, AgentEntry::Ok(_))),
        "읽을 수 없는 항목이 있다"
    );
}

#[test]
#[ignore = "실제 claude 로 /usage 를 읽는다 (구독 한도를 읽는 호출)"]
fn real_usage_read() {
    let started = std::time::Instant::now();
    let result = fetch::read_here();
    println!("걸린 시간: {:?}", started.elapsed());
    match &result {
        UsageResult::Ok(reading) => println!(
            "ok five_hour={:?} seven_day={:?} scoped={} extra_usage_enabled={:?} read_at={}",
            reading.five_hour,
            reading.seven_day,
            reading.scoped.len(),
            reading.extra_usage_enabled,
            reading.read_at
        ),
        UsageResult::Unavailable(u) => println!("unavailable reason={:?}", u.reason),
    }
    let UsageResult::Ok(reading) = result else {
        panic!("구독 로그인 PC 에서는 한도를 받아야 한다");
    };
    assert!(reading.five_hour.is_some() && reading.seven_day.is_some());
}
