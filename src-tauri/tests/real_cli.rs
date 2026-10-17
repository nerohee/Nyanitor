//! 실제 `claude` 로 완료 기준 한 바퀴 (P3-02) — **기본으로는 돌지 않는다** (`#[ignore]`, 구독 사용량이 쓰인다).
//!
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --test real_cli -- --ignored --nocapture --test-threads=1
//! ```
//!
//! - OS 임시 폴더 아래 새 폴더에서만 돈다 (저장소 안이면 거부). 기본 모델 `haiku`, 허용하는 것은 임시 폴더 안 파일 만들기 · `sleep` 뿐.
//! - 인증 정보 · 토큰은 읽지 않는다. `--dangerously-skip-permissions` · `bypassPermissions` 는 쓰지 않는다 (세션 관리자가 못 쓴다).
//! - 끝나면 띄운 `claude` 와 그 밑 프로세스가 남지 않았는지 확인한다. CLI 가 `~/.claude/projects/` 에 남긴 폴더 이름은 출력에 적는다 (지우지 않는다).
//! - 모델이 시킨 대로 안 하면 (예: 질문 도구를 안 씀) 실패한다 — 한 번 더 돌려 본다.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::claude::discover;
use nyanitor_lib::claude::events::{AnswerValue, Response, SessionEvent, TurnOutcome, TurnSummary};
use nyanitor_lib::claude::exec::ClaudeCommand;

const MODEL: &str = "haiku";

fn real_command() -> ClaudeCommand {
    let program = discover::locate_here(None).expect("claude is installed on this PC");
    ClaudeCommand::new(program)
}

fn assert_outside_repo(dir: &std::path::Path) {
    let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    assert!(
        !dir.starts_with(repo.parent().unwrap()),
        "the experiment folder must be outside the repository: {}",
        dir.display()
    );
}

fn start_real(h: &Harness, resume: bool) -> nyanitor_lib::claude::events::StartInfo {
    assert_outside_repo(&h.project);
    let mut request = h.request();
    request.model = Some(MODEL.into());
    request.resume = resume;
    h.manager
        .start(request, real_command())
        .expect("start the real claude")
}

fn wait_turn(h: &mut Harness, what: &str) -> TurnSummary {
    println!("  … waiting for the end of the turn: {what}");
    h.wait_for(what, |e| match e {
        SessionEvent::TurnEnded(t) => Some(t.clone()),
        _ => None,
    })
}

fn next_permission(
    h: &mut Harness,
    what: &str,
) -> nyanitor_lib::claude::events::PermissionRequestInfo {
    h.wait_for(what, |e| match e {
        SessionEvent::PermissionRequest(p) => Some(p.clone()),
        _ => None,
    })
}

fn projects_dir_names() -> Vec<String> {
    let Some(home) = std::env::home_dir() else {
        return Vec::new();
    };
    // 폴더 이름만 본다 (안의 기록은 읽지 않는다 — D-24)
    fs::read_dir(home.join(".claude").join("projects"))
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.contains("nyanitor-test-real"))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
#[ignore = "uses the real claude (haiku) and subscription usage"]
fn completion_criteria_with_the_real_cli() {
    let status = discover::status_here();
    println!(
        "discover: found={} version={:?} loggedIn={:?} method={:?} apiKeyPresent={}",
        status.found, status.version, status.logged_in, status.auth_method, status.api_key_present
    );
    assert!(
        status.found && status.logged_in == Some(true),
        "needs claude installed and logged in"
    );

    let mut h = Harness::with_config(
        "real",
        nyanitor_lib::claude::session::ManagerConfig::default(),
    );
    let before = projects_dir_names();
    println!("project folder: {}", h.project.display());
    let info = start_real(&h, false);
    println!("started pid {} (version {:?})", info.pid, info.cli_version);
    let pid = info.pid;

    // ── 1) 두 턴 대화 ──
    h.manager
        .send_message("Reply with only the word: pong")
        .unwrap();
    let first = wait_turn(&mut h, "turn 1");
    assert_eq!(first.outcome, TurnOutcome::Success, "{first:?}");
    assert!(
        first
            .result
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("pong"),
        "{first:?}"
    );
    h.manager
        .send_message("Now reply with only the word: ping")
        .unwrap();
    let second = wait_turn(&mut h, "turn 2");
    assert_eq!(second.outcome, TurnOutcome::Success, "{second:?}");
    assert!(
        second
            .result
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("ping"),
        "{second:?}"
    );
    println!(
        "turn costs: {:.5} then {:.5} (total {:.5})",
        first.cost_usd, second.cost_usd, second.total_cost_usd
    );
    assert!(second.total_cost_usd > first.total_cost_usd);
    assert!((second.cost_usd - (second.total_cost_usd - first.total_cost_usd)).abs() < 1e-9);
    let session_id = h
        .manager
        .last_session(&h.project.display().to_string())
        .unwrap()
        .expect("the session id was saved");
    println!("saved session id: {session_id}");

    // ── 2) 권한 허용 ──
    h.manager
        .send_message("Use the Write tool to create a file named hello.txt containing exactly: hi. Then reply done.")
        .unwrap();
    let ask = next_permission(&mut h, "permission for hello.txt");
    println!(
        "permission: tool={} path={:?} always={:?}",
        ask.tool, ask.path, ask.always_rule
    );
    assert_eq!(ask.tool, "Write");
    assert_eq!(ask.cwd, h.project.display().to_string());
    h.manager.respond(&ask.request_id, Response::Allow).unwrap();
    assert_eq!(
        wait_turn(&mut h, "allow turn").outcome,
        TurnOutcome::Success
    );
    assert!(
        h.project.join("hello.txt").exists(),
        "allowed write happened"
    );

    // ── 3) 권한 거부 ──
    h.manager
        .send_message("Use the Write tool to create a file named nope.txt containing exactly: no. Then reply done.")
        .unwrap();
    let ask = next_permission(&mut h, "permission for nope.txt");
    h.manager
        .respond(
            &ask.request_id,
            Response::Deny {
                message: Some("The user does not want this file.".into()),
            },
        )
        .unwrap();
    let denied_turn = wait_turn(&mut h, "deny turn");
    println!("deny turn outcome: {:?}", denied_turn.outcome);
    assert!(
        !h.project.join("nope.txt").exists(),
        "denied write did not happen"
    );

    // ── 4) 항상 허용 (폴더로 좁힌 규칙) ──
    fs::create_dir_all(h.project.join("sub")).unwrap();
    h.manager
        .send_message("Use the Write tool to create the file sub/a.txt containing exactly: hi. Then reply done.")
        .unwrap();
    let ask = next_permission(&mut h, "permission for sub/a.txt");
    let rule = ask
        .always_rule
        .clone()
        .expect("a folder rule for a file inside the project");
    println!(
        "always rule shown on the card: {} ({:?})",
        rule.rule, rule.scope
    );
    assert_eq!(rule.rule, "Edit(/sub/**)");
    h.manager
        .respond(&ask.request_id, Response::AlwaysAllow)
        .unwrap();
    assert_eq!(
        wait_turn(&mut h, "always turn").outcome,
        TurnOutcome::Success
    );
    let settings = fs::read_to_string(h.project.join(".claude").join("settings.local.json"))
        .expect("the CLI wrote settings.local.json");
    println!(
        "settings.local.json: {}",
        settings.split_whitespace().collect::<Vec<_>>().join(" ")
    );
    assert!(settings.contains("Edit(/sub/**)"));
    // 같은 폴더의 두 번째 쓰기는 이제 묻지 않는다 (같은 프로세스에서도)
    h.manager
        .send_message("Use the Write tool to create the file sub/b.txt containing exactly: hi. Then reply done.")
        .unwrap();
    let mut asked_again = false;
    let outcome = loop {
        let event = h.wait_for("turn end or permission", |e| match e {
            SessionEvent::PermissionRequest(_) | SessionEvent::TurnEnded(_) => Some(e.clone()),
            _ => None,
        });
        match event {
            SessionEvent::PermissionRequest(p) => {
                asked_again = true;
                h.manager.respond(&p.request_id, Response::Allow).unwrap();
            }
            SessionEvent::TurnEnded(t) => break t.outcome,
            _ => unreachable!(),
        }
    };
    println!("second write in sub/: asked again = {asked_again}, outcome {outcome:?}");
    assert!(h.project.join("sub").join("b.txt").exists());

    // ── 5) 다르게 하라고 말하기 (거부 + 중단 + 새 메시지) ──
    h.manager
        .send_message("Use the Write tool to create a file named draft.txt containing exactly: hi. Then reply done.")
        .unwrap();
    let ask = next_permission(&mut h, "permission for draft.txt");
    h.manager
        .respond(&ask.request_id, Response::Tell { text: "Do not use draft.txt. Use the Write tool to create notes.txt containing exactly: hi. Then reply done.".into() })
        .unwrap();
    assert_eq!(
        wait_turn(&mut h, "interrupted turn").outcome,
        TurnOutcome::Interrupted
    );
    let ask = next_permission(&mut h, "permission for notes.txt");
    assert!(
        ask.path.as_deref().unwrap_or("").ends_with("notes.txt"),
        "{:?}",
        ask.path
    );
    h.manager.respond(&ask.request_id, Response::Allow).unwrap();
    assert_eq!(
        wait_turn(&mut h, "after tell").outcome,
        TurnOutcome::Success
    );
    assert!(h.project.join("notes.txt").exists() && !h.project.join("draft.txt").exists());

    // ── 6) AskUserQuestion 답하기 ──
    h.manager
        .send_message("Use the AskUserQuestion tool to ask me which color I prefer, with exactly the options Red and Blue. After my answer, reply with only the color I chose.")
        .unwrap();
    let q = h.wait_for("question", |e| match e {
        SessionEvent::QuestionRequest(q) => Some(q.clone()),
        _ => None,
    });
    println!(
        "question: {:?}",
        q.questions
            .iter()
            .map(|x| (
                &x.question,
                x.options.iter().map(|o| &o.label).collect::<Vec<_>>()
            ))
            .collect::<Vec<_>>()
    );
    let mut answers = BTreeMap::new();
    for question in &q.questions {
        let pick = question
            .options
            .iter()
            .find(|o| o.label.eq_ignore_ascii_case("blue"))
            .unwrap_or(&question.options[0]);
        answers.insert(
            question.question.clone(),
            AnswerValue::One(pick.label.clone()),
        );
    }
    h.manager
        .respond(&q.request_id, Response::Answer { answers })
        .unwrap();
    let answered = wait_turn(&mut h, "question turn");
    println!("answer turn result: {:?}", answered.result);
    assert_eq!(answered.outcome, TurnOutcome::Success);
    assert!(
        answered
            .result
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("blue")
    );

    // ── 7) 중단 (도는 중인 도구) ──
    h.manager
        .send_message("Run exactly this command with the Bash tool: mkdir slowdir && sleep 40")
        .unwrap();
    let ask = next_permission(&mut h, "permission for the slow command");
    h.manager.respond(&ask.request_id, Response::Allow).unwrap();
    std::thread::sleep(Duration::from_secs(3));
    let t0 = Instant::now();
    h.manager.interrupt().unwrap();
    let stopped_turn = wait_turn(&mut h, "interrupted sleep");
    println!(
        "interrupt took {:?}, outcome {:?}",
        t0.elapsed(),
        stopped_turn.outcome
    );
    assert_eq!(stopped_turn.outcome, TurnOutcome::Interrupted);
    assert!(
        t0.elapsed() < Duration::from_secs(15),
        "did not wait for the 40 s command"
    );

    // ── 8) 끝내기 → 다시 열어 이어 하기 ──
    let stop = h.manager.stop().unwrap();
    println!("stop: {stop:?}");
    assert!(stop.was_running);
    let ended = h.wait_ended();
    println!("session ended: {ended:?}");
    assert!(
        wait_dead(pid, Duration::from_secs(10)),
        "claude is gone after stop"
    );

    let info = start_real(&h, true);
    println!("resumed pid {} from {:?}", info.pid, info.resume_session_id);
    assert_eq!(info.resume_session_id.as_deref(), Some(session_id.as_str()));
    h.manager
        .send_message("What were the two words I asked you to reply with in my first two messages? Answer with just the two words.")
        .unwrap();
    let resumed = wait_turn(&mut h, "resumed turn");
    println!("resumed answer: {:?}", resumed.result);
    assert_eq!(resumed.outcome, TurnOutcome::Success);
    let text = resumed.result.unwrap_or_default().to_lowercase();
    assert!(
        text.contains("pong") && text.contains("ping"),
        "the old conversation was remembered: {text}"
    );
    let pid2 = info.pid;
    h.manager.stop().unwrap();
    h.wait_ended();
    assert!(wait_dead(pid2, Duration::from_secs(10)));

    // ── 남은 것 ──
    let new_dirs: Vec<_> = projects_dir_names()
        .into_iter()
        .filter(|n| !before.contains(n))
        .collect();
    println!("new ~/.claude/projects folders made by the CLI: {new_dirs:?}");
}

#[test]
#[ignore = "uses the real claude (haiku) and subscription usage"]
fn a_made_up_session_id_is_reported_by_the_real_cli() {
    let mut h = Harness::with_saved_session("real-missing", "00000000-0000-4000-8000-00000000dead");
    let info = start_real(&h, true);
    h.manager.send_message("hello").unwrap();
    let id = h.wait_for("resume_not_found", |e| match e {
        SessionEvent::ResumeNotFound { session_id } => Some(session_id.clone()),
        _ => None,
    });
    println!("resume_not_found for {id}");
    let ended = h.wait_ended();
    println!("ended: {ended:?}");
    assert!(wait_dead(info.pid, Duration::from_secs(10)));
}
