//! git 시험 — 받기 · 업데이트 확인 · 받기 (P4-02 · P4-06). 원격 대신 임시 폴더의 로컬 저장소를 쓴다 (인터넷 · 실제 홈 폴더를 쓰지 않는다).
//! 확인 → 받기는 앱이 기억한 확인(`HarnessState`)을 거치는 `flow` 함수로 시험한다 (명령이 부르는 것과 같다). git 이 설치돼 있어야 한다.

mod common;

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use common::*;
use nyanitor_lib::harness::git::{
    COMMITS_MAX, FILES_MAX, GitOutcome, GitResult, UpdateState, clone_origin,
};
use nyanitor_lib::harness::{Context, HarnessState, flow};

/// 원격 역할의 저장소 + 이 시험의 하네스 폴더 + 그 원격에서 받도록 맞춘 `Context`
struct Fixture {
    h: HarnessRoot,
    origin: PathBuf,
    ctx: Context,
    /// 앱이 기억하는 것 (확인 → 받기)
    state: HarnessState,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let h = HarnessRoot::new(name);
        let origin = h.root.join("origin");
        make_origin_repo(&origin);
        let ctx = h.ctx().with_origin_url(as_url(&origin));
        Self {
            h,
            origin,
            ctx,
            state: HarnessState::default(),
        }
    }

    /// 업데이트 확인 (명령과 같은 길 — 본 커밋을 기억한다)
    fn check(&self) -> GitResult {
        flow::update_check(&self.state, &self.ctx).unwrap()
    }

    /// 업데이트 받기 (명령과 같은 길 — 기억한 확인까지만)
    fn pull(&self) -> GitResult {
        flow::update_pull(&self.state, &self.ctx).unwrap()
    }

    fn repo(&self) -> PathBuf {
        self.h.locations.repo_dir()
    }

    fn cloned(name: &str) -> Self {
        let fx = Self::new(name);
        let result = clone_origin(&fx.ctx);
        assert_eq!(result.outcome, GitOutcome::Cloned, "{result:?}");
        fx
    }

    fn origin_head(&self) -> String {
        git(&self.origin, &["rev-parse", "--short", "HEAD"])
    }

    fn repo_head(&self) -> String {
        git(&self.repo(), &["rev-parse", "--short", "HEAD"])
    }
}

fn preview(result: &GitResult) -> &nyanitor_lib::harness::git::UpdatePreview {
    result
        .update
        .as_ref()
        .unwrap_or_else(|| panic!("no preview in {result:?}"))
}

// ───────────────────────────── 받기 ─────────────────────────────

#[test]
fn clones_the_origin_into_repo_and_keeps_line_endings_as_they_are() {
    let fx = Fixture::new("clone-ok");
    let result = clone_origin(&fx.ctx);
    assert_eq!(result.outcome, GitOutcome::Cloned, "{result:?}");
    assert_eq!(result.head.as_deref(), Some(fx.origin_head().as_str()));
    assert!(fx.repo().join(".git").exists());
    assert_eq!(
        fs::read_to_string(fx.repo().join("README.md")).unwrap(),
        "hello\n"
    );
    // Windows 의 기본 줄바꿈 변환이 `.sh` 를 망가뜨리지 않게 저장소 설정으로 꺼 둔다
    assert_eq!(
        git(&fx.repo(), &["config", "--local", "core.autocrlf"]),
        "false"
    );
    // 받는 중 폴더는 남지 않는다
    assert!(!fx.h.locations.harness_home.join("repo.cloning").exists());
}

#[test]
fn a_second_clone_changes_nothing_and_says_it_is_already_there() {
    let fx = Fixture::cloned("clone-twice");
    fs::write(fx.repo().join("local-note.txt"), "mine").unwrap();
    let before = fx.repo_head();
    let again = clone_origin(&fx.ctx);
    assert_eq!(again.outcome, GitOutcome::AlreadyPresent, "{again:?}");
    assert_eq!(again.head.as_deref(), Some(before.as_str()));
    assert!(
        fx.repo().join("local-note.txt").is_file(),
        "아무것도 지우지 않는다"
    );
}

#[test]
fn the_harness_folder_is_created_when_missing() {
    let fx = Fixture::new("clone-mkdir");
    fs::remove_dir_all(&fx.h.locations.harness_home).unwrap();
    assert_eq!(clone_origin(&fx.ctx).outcome, GitOutcome::Cloned);
    assert!(fx.repo().join(".git").exists());
}

#[test]
fn a_failing_clone_leaves_neither_repo_nor_a_half_cloned_folder() {
    let fx = Fixture::new("clone-fail");
    let nowhere = fx.h.root.join("no-such-origin");
    let ctx = fx.ctx.clone().with_origin_url(as_url(&nowhere));
    let result = clone_origin(&ctx);
    assert_eq!(result.outcome, GitOutcome::Failed, "{result:?}");
    assert!(result.detail.is_some(), "git 의 끝부분이 같이 온다");
    assert!(!fx.repo().exists());
    assert!(!fx.h.locations.harness_home.join("repo.cloning").exists());
    // 실패한 뒤 바로 다시 해도 된다
    assert_eq!(clone_origin(&fx.ctx).outcome, GitOutcome::Cloned);
}

#[test]
fn an_unreachable_server_fails_fast_without_prompting_and_hides_the_account_in_the_url() {
    let fx = Fixture::new("clone-refused");
    let ctx = fx
        .ctx
        .clone()
        .with_origin_url("http://user:topsecret@127.0.0.1:1/x/y.git");
    let started = Instant::now();
    let result = clone_origin(&ctx);
    assert_eq!(result.outcome, GitOutcome::Failed, "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "묻거나 기다리지 않고 바로 실패해야 한다"
    );
    let shown = format!("{result:?}");
    assert!(!shown.contains("topsecret"), "{shown}");
    assert!(!fx.repo().exists());
}

/// 계정을 묻는 서버 — 모든 요청에 `401 Unauthorized` + `WWW-Authenticate: Basic`. 받은 요청 수를 센다 (묻기 단계까지 갔는지 보려고).
struct AskingServer {
    port: u16,
    requests: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<thread::JoinHandle<()>>,
}

impl AskingServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a local port");
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (requests, stop) = (requests.clone(), stop.clone());
            thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            Self::answer(stream);
                            requests.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(_) => thread::sleep(Duration::from_millis(10)),
                    }
                }
            })
        };
        Self {
            port,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    /// 요청 머리를 끝까지 읽고 401 로 답한 뒤 닫는다
    fn answer(mut stream: TcpStream) {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut seen = Vec::new();
        let mut buf = [0u8; 1024];
        while !seen.windows(4).any(|w| w == b"\r\n\r\n") && seen.len() < 64 * 1024 {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => seen.extend_from_slice(&buf[..n]),
            }
        }
        let _ = stream.write_all(
            b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"harness\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/nerohee/claude-harness.git", self.port)
    }

    fn requests(&self) -> usize {
        self.requests.load(Ordering::Relaxed)
    }
}

impl Drop for AskingServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[test]
fn a_server_that_asks_for_an_account_fails_the_clone_fast_instead_of_waiting_for_input() {
    let server = AskingServer::start();
    let fx = Fixture::new("asks-clone");
    // 멈추면 이 시간 제한이 끝낸다 → `TimedOut` 이 되어 아래가 실패한다
    let ctx = fx
        .ctx
        .clone()
        .with_origin_url(server.url())
        .with_timeout(Duration::from_secs(25));
    let started = Instant::now();
    let result = clone_origin(&ctx);
    assert_eq!(result.outcome, GitOutcome::Failed, "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "묻지 않고 바로 실패해야 한다: {:?}",
        started.elapsed()
    );
    // 연결 거부가 아니라 서버가 계정을 묻는 데까지 갔다
    assert!(server.requests() >= 1, "서버가 요청을 받지 못했다");
    assert!(!fx.repo().exists());
    assert!(!fx.h.locations.harness_home.join("repo.cloning").exists());
}

#[test]
fn a_server_that_asks_for_an_account_fails_the_update_check_fast_and_changes_nothing() {
    let server = AskingServer::start();
    let fx = Fixture::cloned("asks-check");
    // 저장소의 원격을 그 서버로 (앱이 받을 주소도 같게 — 다른 원격으로 거절되지 않고 fetch 까지 가게)
    git(&fx.repo(), &["remote", "set-url", "origin", &server.url()]);
    let ctx = fx
        .ctx
        .clone()
        .with_origin_url(server.url())
        .with_timeout(Duration::from_secs(25));
    let before = fx.repo_head();
    let started = Instant::now();
    let result = flow::update_check(&fx.state, &ctx).unwrap();
    assert_eq!(result.outcome, GitOutcome::Failed, "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "묻지 않고 바로 실패해야 한다: {:?}",
        started.elapsed()
    );
    assert!(server.requests() >= 1, "서버가 요청을 받지 못했다");
    assert_eq!(fx.repo_head(), before);
    // 실패한 확인은 받기의 근거가 되지 않는다
    let pulled = flow::update_pull(&fx.state, &ctx).unwrap();
    assert_eq!(pulled.reason.as_deref(), Some("check_first"), "{pulled:?}");
}

#[test]
fn a_stale_cloning_folder_from_a_killed_run_is_cleared_first() {
    let fx = Fixture::new("clone-stale");
    let stale = fx.h.locations.harness_home.join("repo.cloning");
    fs::create_dir_all(stale.join("junk")).unwrap();
    fs::write(stale.join("junk").join("x"), "x").unwrap();
    assert_eq!(clone_origin(&fx.ctx).outcome, GitOutcome::Cloned);
    assert!(!stale.exists());
}

#[test]
fn developer_mode_never_clones_or_creates_anything() {
    let fx = Fixture::new("clone-dev");
    let clone = fx.h.root.join("dev-clone");
    fs::create_dir_all(&clone).unwrap();
    fs::write(
        clone.join(nyanitor_lib::harness::locate::script_name()),
        "#",
    )
    .unwrap();
    fs::create_dir_all(fx.h.locations.installed_harness()).unwrap();
    fs::write(
        fx.h.locations.installed_harness().join(".install-mode"),
        format!("copy\n{}\n", clone.display()),
    )
    .unwrap();
    for result in [clone_origin(&fx.ctx), fx.check(), fx.pull()] {
        assert_eq!(result.outcome, GitOutcome::DeveloperMode, "{result:?}");
    }
    assert!(!fx.repo().exists());
}

#[test]
fn without_git_nothing_is_attempted() {
    let h = HarnessRoot::new("clone-nogit");
    let ctx = h.ctx_without_git();
    let state = HarnessState::default();
    for result in [
        clone_origin(&ctx),
        flow::update_check(&state, &ctx).unwrap(),
        flow::update_pull(&state, &ctx).unwrap(),
    ] {
        assert_eq!(result.outcome, GitOutcome::GitMissing, "{result:?}");
    }
    assert!(!h.locations.repo_dir().exists());
}

#[test]
fn a_repo_folder_that_is_not_a_git_repo_is_reported_and_left_alone() {
    let fx = Fixture::new("repo-not-git");
    fs::create_dir_all(fx.repo()).unwrap();
    fs::write(fx.repo().join("precious.txt"), "do not delete").unwrap();
    for result in [clone_origin(&fx.ctx), fx.check(), fx.pull()] {
        assert_eq!(result.outcome, GitOutcome::RepoUnusable, "{result:?}");
        assert_eq!(result.reason.as_deref(), Some("not_git_repo"));
    }
    assert_eq!(
        fs::read_to_string(fx.repo().join("precious.txt")).unwrap(),
        "do not delete"
    );
}

#[test]
fn a_repo_folder_inside_some_other_repository_is_not_mistaken_for_that_repository() {
    let fx = Fixture::new("repo-nested");
    // 하네스 폴더(`hh`) 자체가 git 저장소인 상황 — `repo` 안에 `.git` 이 없으면 위쪽 저장소를 잡으면 안 된다
    git(&fx.h.locations.harness_home, &["init", "-q", "-b", "main"]);
    fs::create_dir_all(fx.repo()).unwrap();
    fs::write(fx.repo().join("x.txt"), "x").unwrap();
    let result = fx.check();
    assert_eq!(result.outcome, GitOutcome::RepoUnusable, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some("not_git_repo"));
}

#[test]
fn a_repo_with_another_remote_is_reported_and_not_replaced() {
    let fx = Fixture::cloned("repo-other-remote");
    git(
        &fx.repo(),
        &[
            "remote",
            "set-url",
            "origin",
            "https://user:ghp_token@example.com/someone/else.git",
        ],
    );
    fs::write(fx.repo().join("local.txt"), "mine").unwrap();
    for result in [clone_origin(&fx.ctx), fx.check(), fx.pull()] {
        assert_eq!(result.outcome, GitOutcome::RepoUnusable, "{result:?}");
        assert_eq!(result.reason.as_deref(), Some("remote_mismatch"));
        let detail = result.detail.clone().unwrap();
        assert!(detail.contains("example.com/someone/else"), "{detail}");
        assert!(
            !detail.contains("ghp_token"),
            "주소의 계정 정보는 지운다: {detail}"
        );
    }
    assert!(fx.repo().join("local.txt").is_file());
    // 원격이 아예 없는 경우도 같다
    git(&fx.repo(), &["remote", "remove", "origin"]);
    let result = fx.check();
    assert_eq!(result.outcome, GitOutcome::RepoUnusable);
    assert_eq!(result.reason.as_deref(), Some("remote_mismatch"));
    assert_eq!(result.detail, None);
}

#[test]
fn the_remote_address_is_compared_by_meaning() {
    let fx = Fixture::cloned("repo-remote-spelling");
    // 끝에 `/` 가 붙어도 같은 원본이다 (git 도 같은 폴더로 읽는다)
    let slash = format!("{}/", as_url(&fx.origin));
    git(&fx.repo(), &["remote", "set-url", "origin", &slash]);
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    // 끝의 `.git` 은 주소 비교에서 무시한다 — 이 시험의 원본에는 그런 폴더가 없어 받아 오기는 실패하지만, "다른 원격" 으로 거절하지는 않는다
    let dot_git = format!("{}.git", as_url(&fx.origin));
    git(&fx.repo(), &["remote", "set-url", "origin", &dot_git]);
    assert_ne!(fx.check().outcome, GitOutcome::RepoUnusable);
}

#[test]
fn update_check_and_pull_need_a_repo() {
    let fx = Fixture::new("repo-missing");
    assert_eq!(fx.check().outcome, GitOutcome::RepoMissing);
    assert_eq!(fx.pull().outcome, GitOutcome::RepoMissing);
    assert!(!fx.repo().exists(), "확인이 폴더를 만들지 않는다");
}

// ───────────────────────────── 업데이트 확인 ─────────────────────────────

#[test]
fn nothing_new_means_up_to_date_and_nothing_to_pull() {
    let fx = Fixture::cloned("check-same");
    let result = fx.check();
    assert_eq!(result.outcome, GitOutcome::Checked, "{result:?}");
    let update = preview(&result);
    assert_eq!(update.state, UpdateState::UpToDate);
    assert_eq!((update.ahead, update.behind), (0, 0));
    assert!(update.commits.is_empty() && update.files.is_empty());
    assert!(!update.can_pull && !update.dirty);
    assert_eq!(update.branch.as_deref(), Some("main"));
    assert_eq!(update.upstream.as_deref(), Some("origin/main"));
}

#[test]
fn new_commits_are_previewed_with_their_files_without_touching_the_working_tree() {
    let fx = Fixture::cloned("check-new");
    let before = fx.repo_head();
    commit_file(
        &fx.origin,
        "docs/한글 문서.md",
        "새 글\n",
        "feat: 새 문서 추가",
    );
    commit_file(&fx.origin, "README.md", "hello again\n", "fix: README 고침");
    git(&fx.origin, &["rm", "-q", "--", "README.md"]);
    git(&fx.origin, &["commit", "-q", "-m", "docs: README 지움"]);

    let result = fx.check();
    assert_eq!(result.outcome, GitOutcome::Checked, "{result:?}");
    let update = preview(&result);
    assert_eq!(update.state, UpdateState::Behind);
    assert_eq!((update.ahead, update.behind), (0, 3));
    assert_eq!(update.commits_total, 3);
    // 최신이 먼저, 짧은 해시 · 날짜 · 제목
    let subjects: Vec<&str> = update.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(
        subjects,
        [
            "docs: README 지움",
            "fix: README 고침",
            "feat: 새 문서 추가"
        ]
    );
    assert!(
        update
            .commits
            .iter()
            .all(|c| !c.hash.is_empty() && c.date.len() == 10),
        "{:?}",
        update.commits
    );
    // 바뀐 파일은 처음과 마지막을 비교한 결과 (README 는 지워졌고 새 문서가 생겼다)
    let mut files: Vec<(String, String)> = update
        .files
        .iter()
        .map(|f| (f.status.clone(), f.path.clone()))
        .collect();
    files.sort();
    assert_eq!(
        files,
        vec![
            ("A".into(), "docs/한글 문서.md".into()),
            ("D".into(), "README.md".into())
        ]
    );
    assert_eq!(update.files_total, 2);
    assert!(update.can_pull);
    // 받지는 않았다
    assert_eq!(fx.repo_head(), before);
    assert!(fx.repo().join("README.md").is_file());
    assert!(!fx.repo().join("docs").exists());
}

#[test]
fn long_lists_are_capped_but_the_totals_stay_true() {
    let fx = Fixture::cloned("check-caps");
    for n in 0..(COMMITS_MAX + 10) {
        git(
            &fx.origin,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                &format!("chore: 빈 커밋 {n}"),
            ],
        );
    }
    let dir = fx.origin.join("many");
    fs::create_dir_all(&dir).unwrap();
    for n in 0..(FILES_MAX + 50) {
        fs::write(dir.join(format!("f{n:03}.txt")), "x").unwrap();
    }
    git(&fx.origin, &["add", "."]);
    git(&fx.origin, &["commit", "-q", "-m", "feat: 파일 많이"]);

    let result = fx.check();
    let update = preview(&result);
    assert_eq!(update.commits.len(), COMMITS_MAX);
    assert_eq!(update.commits_total as usize, COMMITS_MAX + 11);
    assert_eq!(update.files.len(), FILES_MAX);
    assert_eq!(update.files_total as usize, FILES_MAX + 50);
    assert_eq!(update.commits[0].subject, "feat: 파일 많이");
}

#[test]
fn an_unreachable_remote_fails_the_check_and_changes_nothing() {
    let fx = Fixture::cloned("check-remote-gone");
    let before = fx.repo_head();
    fs::remove_dir_all(&fx.origin).unwrap();
    let result = fx.check();
    assert_eq!(result.outcome, GitOutcome::Failed, "{result:?}");
    assert!(result.detail.is_some());
    assert_eq!(fx.repo_head(), before);
}

// ───────────────────────────── 업데이트 받기 ─────────────────────────────

/// 원본의 지금 HEAD 전체 해시
fn origin_full_head(fx: &Fixture) -> String {
    git(&fx.origin, &["rev-parse", "HEAD"])
}

#[test]
fn pulling_fast_forwards_up_to_the_checked_commit_and_lists_what_was_received() {
    let fx = Fixture::cloned("pull-ff");
    let before = fx.repo_head();
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    commit_file(&fx.origin, "NEW2.md", "new2\n", "feat: 새 파일 둘");
    let check = fx.check();
    assert_eq!(check.outcome, GitOutcome::Checked, "{check:?}");
    // 확인이 본 커밋의 전체 해시 (받기가 이 커밋까지만 받는다)
    assert_eq!(
        preview(&check).upstream_hash.as_deref(),
        Some(origin_full_head(&fx).as_str())
    );

    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Updated, "{result:?}");
    assert_eq!(result.before.as_deref(), Some(before.as_str()));
    assert_eq!(result.head.as_deref(), Some(fx.origin_head().as_str()));
    assert_eq!(fx.repo_head(), fx.origin_head());
    assert_eq!(
        fs::read_to_string(fx.repo().join("NEW.md")).unwrap(),
        "new\n"
    );
    // 실제로 받은 커밋 (받기 전 HEAD..새 HEAD, 최신이 먼저)
    let subjects: Vec<&str> = result.pulled.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["feat: 새 파일 둘", "feat: 새 파일"]);
    assert_eq!(result.pulled_total, 2);
    assert!(
        result
            .pulled
            .iter()
            .all(|c| !c.hash.is_empty() && c.date.len() == 10)
    );
}

#[test]
fn a_commit_that_appears_on_the_origin_after_the_check_is_not_received() {
    let fx = Fixture::cloned("pull-after-check");
    commit_file(&fx.origin, "SEEN.md", "seen\n", "feat: 확인할 때 있던 커밋");
    let seen_full = origin_full_head(&fx);
    let seen_short = fx.origin_head();
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    // 확인한 뒤에 원본에 새 커밋이 생겼다
    commit_file(&fx.origin, "LATER.md", "later\n", "feat: 확인한 뒤의 커밋");
    assert_ne!(origin_full_head(&fx), seen_full);

    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Updated, "{result:?}");
    // 본 커밋까지만: 새 커밋은 받지 않았다 (다시 fetch 하지 않았다)
    assert_eq!(fx.repo_head(), seen_short);
    assert_ne!(fx.repo_head(), fx.origin_head());
    assert!(fx.repo().join("SEEN.md").is_file());
    assert!(!fx.repo().join("LATER.md").exists());
    assert_eq!(result.pulled_total, 1);
    assert_eq!(result.pulled[0].subject, "feat: 확인할 때 있던 커밋");

    // 새 확인에는 그 커밋이 보이고, 그때는 받을 수 있다
    let again = fx.check();
    assert_eq!(preview(&again).behind, 1);
    assert_eq!(preview(&again).commits[0].subject, "feat: 확인한 뒤의 커밋");
    assert_eq!(fx.pull().outcome, GitOutcome::Updated);
    assert_eq!(fx.repo_head(), fx.origin_head());
}

#[test]
fn pulling_without_a_check_is_refused_and_changes_nothing() {
    let fx = Fixture::cloned("pull-no-check");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    let before = fx.repo_head();
    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some("check_first"));
    assert_eq!(fx.repo_head(), before);
    assert!(!fx.repo().join("NEW.md").exists());
    // 거절은 원본을 새로 받아 오지도 않는다 (fetch 하지 않았다)
    assert_eq!(
        git(&fx.repo(), &["rev-parse", "--short", "origin/main"]),
        before
    );
}

#[test]
fn one_check_allows_one_pull_a_second_pull_must_look_again() {
    let fx = Fixture::cloned("pull-twice");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    let first = fx.pull();
    assert_eq!(first.outcome, GitOutcome::Updated, "{first:?}");

    let again = fx.pull();
    assert_eq!(again.outcome, GitOutcome::Refused, "{again:?}");
    assert_eq!(again.reason.as_deref(), Some("check_first"));
    assert_eq!(again.head, first.head);
    // 다시 확인하면 최신이고, 그때의 받기는 할 일이 없다
    let check = fx.check();
    assert_eq!(preview(&check).state, UpdateState::UpToDate);
    let nothing = fx.pull();
    assert_eq!(nothing.outcome, GitOutcome::UpToDate, "{nothing:?}");
    assert!(nothing.pulled.is_empty());
}

#[test]
fn a_fresh_app_remembers_no_check_and_a_failed_check_forgets_the_old_one() {
    let fx = Fixture::cloned("pull-forgets");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    // 앱을 새로 띄움 = 새 상태 — 같은 저장소여도 기억이 없다
    let fresh = HarnessState::default();
    let result = flow::update_pull(&fresh, &fx.ctx).unwrap();
    assert_eq!(result.reason.as_deref(), Some("check_first"), "{result:?}");

    // 다시 확인하다 실패하면 앞의 확인도 낡은 것이다
    fs::remove_dir_all(&fx.origin).unwrap();
    assert_eq!(fx.check().outcome, GitOutcome::Failed);
    let result = fx.pull();
    assert_eq!(result.reason.as_deref(), Some("check_first"), "{result:?}");
    assert!(!fx.repo().join("NEW.md").exists());
}

#[test]
fn moving_to_another_branch_after_the_check_asks_for_a_new_check() {
    let fx = Fixture::cloned("pull-branch-moved");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    // 옛 커밋에 서 있는 다른 브랜치가 같은 원격 브랜치를 따라간다 (확인한 브랜치는 `main`)
    git(&fx.repo(), &["checkout", "-q", "-b", "other", "main"]);
    git(
        &fx.repo(),
        &["branch", "-q", "--set-upstream-to=origin/main", "other"],
    );
    let before = fx.repo_head();
    let result = fx.pull();
    assert_eq!(result.reason.as_deref(), Some("check_first"), "{result:?}");
    assert_eq!(fx.repo_head(), before);
    assert!(!fx.repo().join("NEW.md").exists());
}

#[test]
fn a_local_change_to_a_tracked_file_blocks_the_pull_and_stays_as_it_is() {
    let fx = Fixture::cloned("pull-dirty");
    fs::write(fx.repo().join("README.md"), "my edit\n").unwrap();
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    let before = fx.repo_head();

    let check = fx.check();
    let update = preview(&check);
    assert!(update.dirty);
    assert_eq!(update.state, UpdateState::Behind);
    assert!(!update.can_pull, "로컬 변경이 있으면 받기를 켜지 않는다");

    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some("dirty"));
    assert_eq!(fx.repo_head(), before);
    assert_eq!(
        fs::read_to_string(fx.repo().join("README.md")).unwrap(),
        "my edit\n"
    );
    assert!(!fx.repo().join("NEW.md").exists());

    // 거절한 받기도 확인을 한 번 쓴 것이다 — 고친 뒤에는 다시 확인해야 한다
    git(&fx.repo(), &["checkout", "-q", "--", "README.md"]);
    assert_eq!(fx.pull().reason.as_deref(), Some("check_first"));
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    assert_eq!(fx.pull().outcome, GitOutcome::Updated);
}

#[test]
fn a_change_made_after_a_clean_check_still_blocks_the_pull() {
    let fx = Fixture::cloned("pull-dirty-later");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert!(preview(&fx.check()).can_pull);
    fs::write(fx.repo().join("README.md"), "edited after the check\n").unwrap();
    let result = fx.pull();
    assert_eq!(result.reason.as_deref(), Some("dirty"), "{result:?}");
    assert!(!fx.repo().join("NEW.md").exists());
}

#[test]
fn a_staged_change_counts_as_a_local_change_too() {
    let fx = Fixture::cloned("pull-staged");
    fs::write(fx.repo().join("README.md"), "staged edit\n").unwrap();
    git(&fx.repo(), &["add", "README.md"]);
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    assert_eq!(fx.pull().reason.as_deref(), Some("dirty"));
}

#[test]
fn an_untracked_file_alone_does_not_block_the_pull() {
    let fx = Fixture::cloned("pull-untracked");
    fs::write(fx.repo().join("notes.txt"), "scratch").unwrap();
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    let check = fx.check();
    assert!(!preview(&check).dirty);
    assert_eq!(fx.pull().outcome, GitOutcome::Updated);
    assert!(fx.repo().join("notes.txt").is_file());
}

#[test]
fn an_untracked_file_that_collides_with_an_incoming_one_makes_git_refuse_and_nothing_is_lost() {
    let fx = Fixture::cloned("pull-collide");
    fs::write(fx.repo().join("NEW.md"), "my own NEW.md\n").unwrap();
    commit_file(&fx.origin, "NEW.md", "from origin\n", "feat: 새 파일");
    let before = fx.repo_head();
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    let result = fx.pull();
    assert_ne!(result.outcome, GitOutcome::Updated, "{result:?}");
    assert_eq!(fx.repo_head(), before);
    assert_eq!(
        fs::read_to_string(fx.repo().join("NEW.md")).unwrap(),
        "my own NEW.md\n"
    );
}

#[test]
fn diverged_history_is_refused_and_not_merged() {
    let fx = Fixture::cloned("pull-diverged");
    commit_file(&fx.repo(), "LOCAL.md", "local\n", "chore: 로컬 커밋");
    commit_file(&fx.origin, "REMOTE.md", "remote\n", "feat: 원격 커밋");
    let local_head = fx.repo_head();

    let check = fx.check();
    let update = preview(&check);
    assert_eq!(update.state, UpdateState::Diverged);
    assert_eq!((update.ahead, update.behind), (1, 1));
    assert!(!update.can_pull);
    assert_eq!(update.commits.len(), 1, "받을 쪽 커밋만 보인다");

    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some("diverged"));
    assert_eq!(fx.repo_head(), local_head);
    assert!(!fx.repo().join("REMOTE.md").exists());
    // 병합 흔적(MERGE_HEAD · 리베이스 폴더)을 남기지 않는다
    assert!(!fx.repo().join(".git").join("MERGE_HEAD").exists());
}

#[test]
fn history_that_diverges_after_a_clean_check_is_refused_too() {
    let fx = Fixture::cloned("pull-diverged-later");
    commit_file(&fx.origin, "REMOTE.md", "remote\n", "feat: 원격 커밋");
    assert!(preview(&fx.check()).can_pull);
    commit_file(
        &fx.repo(),
        "LOCAL.md",
        "local\n",
        "chore: 확인한 뒤의 로컬 커밋",
    );
    let local_head = fx.repo_head();
    let result = fx.pull();
    assert_eq!(result.reason.as_deref(), Some("diverged"), "{result:?}");
    assert_eq!(fx.repo_head(), local_head);
    assert!(!fx.repo().join("REMOTE.md").exists());
}

#[test]
fn commits_only_on_our_side_are_reported_as_ahead_and_refused() {
    let fx = Fixture::cloned("pull-ahead");
    commit_file(&fx.repo(), "LOCAL.md", "local\n", "chore: 로컬 커밋");
    let check = fx.check();
    assert_eq!(preview(&check).state, UpdateState::Ahead);
    assert!(!preview(&check).can_pull);
    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Refused, "{result:?}");
    assert_eq!(result.reason.as_deref(), Some("ahead"));
}

#[test]
fn a_detached_head_or_a_branch_without_upstream_is_reported_without_fetching() {
    let fx = Fixture::cloned("pull-detached");
    git(&fx.repo(), &["checkout", "-q", "--detach"]);
    let check = fx.check();
    assert_eq!(preview(&check).state, UpdateState::Detached);
    assert!(!preview(&check).can_pull);
    assert_eq!(fx.pull().reason.as_deref(), Some("detached_head"));

    git(&fx.repo(), &["checkout", "-q", "main"]);
    git(&fx.repo(), &["branch", "-q", "--unset-upstream"]);
    let check = fx.check();
    assert_eq!(preview(&check).state, UpdateState::NoUpstream);
    assert_eq!(fx.pull().reason.as_deref(), Some("no_upstream"));
}

// ───────────────────────────── 사용자 git 설정 ─────────────────────────────

#[test]
fn user_git_settings_cannot_turn_the_fast_forward_into_a_merge_commit_or_a_signature_check() {
    let fx = Fixture::cloned("pull-user-config");
    // `merge.ff=false` 는 합칠 때 빨리 감기가 가능해도 병합 커밋을 만든다. 나머지도 받는 방식에 끼어들 수 있는 설정이다.
    for (key, value) in [
        ("merge.ff", "false"),
        ("pull.rebase", "true"),
        ("pull.ff", "false"),
        ("merge.verifySignatures", "true"),
        ("merge.autoStash", "true"),
        ("branch.main.rebase", "true"),
    ] {
        git(&fx.repo(), &["config", key, value]);
    }
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    let result = fx.pull();
    assert_eq!(result.outcome, GitOutcome::Updated, "{result:?}");
    assert_eq!(
        fx.repo_head(),
        fx.origin_head(),
        "병합 커밋 없이 원본 그대로"
    );
    assert_eq!(
        git(&fx.repo(), &["rev-list", "--merges", "--count", "HEAD"]),
        "0"
    );
    assert_eq!(result.pulled_total, 1);
}

#[test]
fn a_pull_rebase_setting_does_not_make_a_diverged_history_get_rebased() {
    let fx = Fixture::cloned("pull-rebase-diverged");
    git(&fx.repo(), &["config", "pull.rebase", "true"]);
    commit_file(&fx.repo(), "LOCAL.md", "local\n", "chore: 로컬 커밋");
    commit_file(&fx.origin, "REMOTE.md", "remote\n", "feat: 원격 커밋");
    let local_head = git(&fx.repo(), &["rev-parse", "HEAD"]);
    assert_eq!(fx.check().outcome, GitOutcome::Checked);
    let result = fx.pull();
    assert_eq!(result.reason.as_deref(), Some("diverged"), "{result:?}");
    assert_eq!(git(&fx.repo(), &["rev-parse", "HEAD"]), local_head);
    for leftover in ["rebase-merge", "rebase-apply", "MERGE_HEAD"] {
        assert!(
            !fx.repo().join(".git").join(leftover).exists(),
            "{leftover}"
        );
    }
}

#[test]
fn an_insteadof_rewrite_in_the_users_settings_does_not_make_the_remote_look_different() {
    let fx = Fixture::cloned("repo-insteadof");
    // 사용자 설정이 원본 주소를 다른 주소(같은 저장소의 거울)로 바꿔 부르게 한다 — 저장소에 적힌 주소는 그대로다
    let mirror = fx.h.root.join("mirror.git");
    git(
        &fx.h.root,
        &["clone", "-q", "--bare", &as_url(&fx.origin), "mirror.git"],
    );
    git(
        &fx.repo(),
        &[
            "config",
            &format!("url.{}.insteadOf", as_url(&mirror)),
            &as_url(&fx.origin),
        ],
    );
    // 준비가 됐는지: `remote get-url` 은 펼친 주소(거울)를 준다 — 저장소 설정 값과 다르다
    assert_eq!(
        git(&fx.repo(), &["remote", "get-url", "origin"]),
        as_url(&mirror)
    );
    assert_eq!(
        git(&fx.repo(), &["config", "--get", "remote.origin.url"]),
        as_url(&fx.origin)
    );

    let result = fx.check();
    assert_eq!(result.outcome, GitOutcome::Checked, "{result:?}");
    assert_ne!(result.reason.as_deref(), Some("remote_mismatch"));
    // 상태 조회와 받기(clone)의 판별도 같다
    let st = nyanitor_lib::harness::status::status(&fx.ctx);
    let repo = st.repo.unwrap();
    assert_eq!(repo.usable, Some(true), "{repo:?}");
    assert_eq!(repo.problem, None);
    assert_eq!(clone_origin(&fx.ctx).outcome, GitOutcome::AlreadyPresent);
}

// ───────────────────────────── 시간 제한 ─────────────────────────────

/// 오래 자는 가짜 git — 시간 제한 시험용
fn sleeping_git(dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let path = dir.join("fake-git.cmd");
        fs::write(&path, "@echo off\r\nping -n 40 127.0.0.1 >nul\r\n").unwrap();
        path
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-git.sh");
        fs::write(&path, "#!/bin/sh\nsleep 40\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }
}

#[test]
fn a_git_that_never_finishes_is_stopped_at_the_time_limit() {
    let h = HarnessRoot::new("git-timeout");
    let fake = sleeping_git(&h.root);
    let mut ctx =
        Context::new(h.locations.clone(), Some(fake)).with_timeout(Duration::from_secs(1));
    ctx.origin_url = "http://127.0.0.1:1/x.git".into();
    let started = Instant::now();
    let result = clone_origin(&ctx);
    assert_eq!(result.outcome, GitOutcome::TimedOut, "{result:?}");
    assert!(
        started.elapsed() < Duration::from_secs(20),
        "{:?}",
        started.elapsed()
    );
    assert!(!h.locations.repo_dir().exists());
    assert!(!h.locations.harness_home.join("repo.cloning").exists());
}

// ───────────────────────────── 쓰는 일 뒤에는 본 것이 낡는다 ─────────────────────────────

/// 원본에 가짜 설치 스크립트와 녹화된 출력(미리보기 · 설치)을 넣고 새 커밋 하나를 더해 둔 시험 한 벌 (받아 둔 상태)
fn fixture_with_script(name: &str) -> Fixture {
    let fx = Fixture::new(name);
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/harness");
    let script = nyanitor_lib::harness::locate::script_name();
    for (from, to) in [
        (script, script),
        ("plan-fresh.json", "plan.out"),
        ("install-change.json", "install.out"),
    ] {
        fs::copy(fixtures.join(from), fx.origin.join(to)).unwrap();
    }
    git(&fx.origin, &["add", "-A"]);
    git(&fx.origin, &["commit", "-q", "-m", "feat: 설치 스크립트"]);
    assert_eq!(clone_origin(&fx.ctx).outcome, GitOutcome::Cloned);
    fx
}

#[test]
fn an_install_makes_the_earlier_update_check_stale() {
    let fx = fixture_with_script("check-then-install");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert!(preview(&fx.check()).can_pull);
    let planned = flow::install_plan(&fx.state, &fx.ctx).unwrap();
    assert!(planned.report.is_some(), "{planned:?}");
    let before = fx.repo_head();
    let installed = flow::install(&fx.state, &fx.ctx).unwrap();
    assert!(installed.report.is_some(), "{installed:?}");
    // 설치 뒤에는 앞의 확인으로 받을 수 없다
    let result = fx.pull();
    assert_eq!(result.reason.as_deref(), Some("check_first"), "{result:?}");
    assert_eq!(fx.repo_head(), before);
    assert!(!fx.repo().join("NEW.md").exists());
}

#[test]
fn an_update_pull_makes_the_earlier_previews_stale() {
    let fx = fixture_with_script("pull-then-install");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert!(preview(&fx.check()).can_pull);
    let planned = flow::install_plan(&fx.state, &fx.ctx).unwrap();
    assert!(planned.report.is_some(), "{planned:?}");
    // 받으면 원본의 내용이 달라졌다 — 받기 전에 본 미리보기로는 설치할 수 없다
    assert_eq!(fx.pull().outcome, GitOutcome::Updated);
    let refused = flow::install(&fx.state, &fx.ctx).unwrap();
    assert_eq!(refused.reason.as_deref(), Some("plan_first"), "{refused:?}");
    // 새로 미리보면 설치할 수 있다
    flow::install_plan(&fx.state, &fx.ctx).unwrap();
    assert!(flow::install(&fx.state, &fx.ctx).unwrap().report.is_some());
}

#[test]
fn a_clone_does_not_disturb_what_was_remembered_unless_it_actually_cloned() {
    let fx = Fixture::cloned("clone-keeps-check");
    commit_file(&fx.origin, "NEW.md", "new\n", "feat: 새 파일");
    assert!(preview(&fx.check()).can_pull);
    // 이미 받은 원본이 있어 아무것도 하지 않은 받기는 확인을 지우지 않는다
    let again = flow::clone_origin(&fx.state, &fx.ctx).unwrap();
    assert_eq!(again.outcome, GitOutcome::AlreadyPresent);
    assert_eq!(fx.pull().outcome, GitOutcome::Updated);
}
