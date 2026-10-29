//! 스킬 목록 시험 (P6-02) — 하네스를 링크(Windows 는 정션)로 설치한 모양. 파일 하나하나의 읽기 경계는 `src/skills/` 의 단위 시험이 본다.

mod common;

use std::fs;

use common::*;
use nyanitor_lib::skills::{SkillEntry, SkillOrigin, SkillsState, list};

fn skill(name: &str) -> String {
    format!(
        "---\nname: {name}\ndescription: {name} 소개\nargument-hint: \"[인자]\"\ndisable-model-invocation: true\n---\n본문 $ARGUMENTS\n"
    )
}

#[test]
fn a_link_installed_harness_gives_harness_skills_through_the_links_and_my_own_stay_mine() {
    // 원본 저장소(`repo`): skills/<이름>/SKILL.md 와 설정
    let repo = unique_dir("skills-repo");
    for name in ["web-full", "web-lite"] {
        fs::create_dir_all(repo.join("skills").join(name)).unwrap();
        fs::write(repo.join("skills").join(name).join("SKILL.md"), skill(name)).unwrap();
    }
    // `~/.claude`: harness 가 저장소로 이어지고(링크 설치), skills/<이름> 은 저장소의 skills/<이름> 으로 이어진다. 내 스킬은 그냥 폴더
    let claude = unique_dir("skills-claude");
    fs::create_dir_all(claude.join("skills").join("my-own")).unwrap();
    fs::write(
        claude.join("skills").join("my-own").join("SKILL.md"),
        skill("my-own"),
    )
    .unwrap();
    let linked_harness = make_dir_link(&claude.join("harness"), &repo);
    let linked_web_full = make_dir_link(
        &claude.join("skills").join("web-full"),
        &repo.join("skills").join("web-full"),
    );
    let linked_web_lite = make_dir_link(
        &claude.join("skills").join("web-lite"),
        &repo.join("skills").join("web-lite"),
    );
    if !linked_harness || !linked_web_full || !linked_web_lite {
        eprintln!("폴더 링크를 만들 수 없는 PC — 건너뜀");
        return;
    }
    let result = list(&claude);
    assert_eq!(result.state, SkillsState::Ok);
    let summary: Vec<_> = result
        .skills
        .iter()
        .map(|entry| match entry {
            SkillEntry::Ok(info) => (info.name.clone(), info.origin),
            SkillEntry::Unreadable(u) => panic!("readable: {u:?}"),
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("my-own".to_string(), SkillOrigin::Mine),
            ("web-full".to_string(), SkillOrigin::Harness),
            ("web-lite".to_string(), SkillOrigin::Harness),
        ]
    );
}

#[test]
fn a_link_to_a_folder_outside_the_skills_and_the_harness_is_not_followed() {
    let outside = unique_dir("skills-outside");
    fs::create_dir_all(outside.join("secret-skill")).unwrap();
    fs::write(
        outside.join("secret-skill").join("SKILL.md"),
        skill("secret-skill"),
    )
    .unwrap();
    let claude = unique_dir("skills-claude-out");
    fs::create_dir_all(claude.join("harness").join("skills")).unwrap();
    fs::create_dir_all(claude.join("skills")).unwrap();
    if !make_dir_link(
        &claude.join("skills").join("secret-skill"),
        &outside.join("secret-skill"),
    ) {
        eprintln!("폴더 링크를 만들 수 없는 PC — 건너뜀");
        return;
    }
    let result = list(&claude);
    assert_eq!(result.state, SkillsState::Ok);
    assert!(result.skills.is_empty(), "{:?}", result.skills);
}

#[test]
fn a_harness_link_that_points_nowhere_means_no_harness() {
    let real = unique_dir("skills-gone-real");
    fs::create_dir_all(real.join("target")).unwrap();
    let claude = unique_dir("skills-gone");
    if !make_dir_link(&claude.join("harness"), &real.join("target")) {
        return;
    }
    fs::remove_dir_all(real.join("target")).unwrap();
    let result = list(&claude);
    assert_eq!(result.state, SkillsState::NoHarness);
    assert!(result.skills.is_empty());
}
