//! 짧은 별도 세션으로 `/usage` 를 읽는다 — 로그인 확인 → 세션 띄우기 → `/usage` 보내기 → `usage_report` 받기 → 프로세스 트리 끄기.
//!
//! 세션 관리자(`claude::session`)와 따로 돈다 — 사용자의 작업 세션이 돌고 있어도 부딪치지 않는다 (한 번에 하나 규칙은 작업 세션끼리의 것).
//! 실행 파일은 찾은 `claude`(시험에서는 가짜 CLI)뿐이고 인자는 `build_args` 가 만든다. 모델은 `/usage` 가 모델을 부르지 않으므로 필요 없지만,
//! 만에 하나 `/usage` 를 모르는 CLI 가 글로 받아 모델에 보내도 싸게 끝나도록 `haiku` · `--max-turns 1` 을 준다 (진짜 모델 응답이 보이면 바로 끝낸다).
//! 세션 기록은 남기지 않는다 (`--no-session-persistence`). 받은 줄은 로그에 남기지 않는다 — 계정 정보가 들어 있다.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri_plugin_log::log;

use super::{UnavailableReason, UsageResult, report};
use crate::claude::discover;
use crate::claude::exec::{self, ClaudeCommand};
use crate::claude::process_tree::ProcessTree;

/// 읽을 출력의 최대 크기 (정상은 수 KB — 넘으면 그 뒤는 읽지 않는다)
const STDOUT_LIMIT: u64 = 16 << 20;

/// 한 번 읽는 데 쓰는 시간
#[derive(Debug, Clone, Copy)]
pub struct FetchConfig {
    /// 세션을 띄운 뒤 `usage_report` 를 받기까지 기다리는 최대 시간
    pub timeout: Duration,
    /// 받은 뒤 stdin 을 닫고 스스로 끝나기를 기다리는 시간 (안 끝나면 프로세스 트리를 끈다)
    pub exit_grace: Duration,
}

impl Default for FetchConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            exit_grace: Duration::from_secs(1),
        }
    }
}

/// `/usage` 세션의 실행 인자 — 권한 질문 도구도 이어 하기도 없다 (도구가 필요한 일이 없다).
pub fn build_args() -> Vec<&'static str> {
    vec![
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "haiku",
        "--max-turns",
        "1",
        "--no-session-persistence",
    ]
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

/// 이 PC 의 `claude` · 환경으로 읽는다.
pub fn read_here() -> UsageResult {
    let cmd = discover::locate_here(None).map(ClaudeCommand::new);
    read_with(
        cmd.as_ref(),
        !exec::other_billing_vars().is_empty(),
        &FetchConfig::default(),
    )
}

/// `cmd` 로 읽는다. `other_billing` 은 구독이 아닌 곳으로 과금하는 환경 변수가 있다는 뜻 (그러면 구독 한도가 아니다).
/// 어떤 실패도 오류로 돌려주지 않는다 — `unavailable` 과 이유다.
pub fn read_with(
    cmd: Option<&ClaudeCommand>,
    other_billing: bool,
    config: &FetchConfig,
) -> UsageResult {
    let Some(cmd) = cmd else {
        return UsageResult::unavailable(UnavailableReason::NoClaude);
    };
    let auth = match discover::read_auth(cmd) {
        Ok(auth) => auth,
        Err(err) => {
            log::warn!("usage: could not read the login state: {err}");
            return UsageResult::unavailable(UnavailableReason::Failed);
        }
    };
    if !auth.logged_in {
        return UsageResult::unavailable(UnavailableReason::NotLoggedIn);
    }
    // 구독 한도는 구독 로그인(`subscriptionType` 이 있음)에만 있다. 다른 제공자 변수가 있으면 CLI 가 그쪽으로 돌 수 있다.
    if other_billing || auth.subscription_type.is_none() {
        return UsageResult::unavailable(UnavailableReason::NotSubscription);
    }
    match fetch_report(cmd, config).and_then(|value| report::parse(&value, now_secs())) {
        Ok(reading) => UsageResult::Ok(reading),
        Err(reason) => {
            log::info!("usage: no limits this time ({reason:?})");
            UsageResult::unavailable(reason)
        }
    }
}

/// 띄운 세션과 그 밑 프로세스. 버려지면(오류 · 패닉 포함) stdin 을 닫고 `grace` 만큼 스스로 끝나기를 기다린 뒤 트리를 끈다.
struct Running {
    child: Child,
    tree: ProcessTree,
    grace: Duration,
}

impl Drop for Running {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        let deadline = Instant::now() + self.grace;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                _ => break,
            }
        }
        // 스스로 끝났어도 남은 손자 프로세스가 있을 수 있다
        self.tree.kill();
        let _ = self.child.wait();
    }
}

/// 세션을 띄워 `/usage` 를 보내고 `usage_report` 값을 받는다.
fn fetch_report(cmd: &ClaudeCommand, config: &FetchConfig) -> Result<Value, UnavailableReason> {
    let mut command = cmd.command(build_args());
    command
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            UnavailableReason::NoClaude
        } else {
            log::warn!("usage: could not start claude: {err}");
            UnavailableReason::Failed
        }
    })?;
    let tree = ProcessTree::attach(&child);
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let mut running = Running {
        child,
        tree,
        grace: Duration::ZERO,
    };
    let (Some(stdout), Some(stderr)) = (stdout, stderr) else {
        return Err(UnavailableReason::Failed);
    };

    // 읽기 스레드: 줄을 보낸다. 끝나면(EOF · 오류 · 받는 쪽이 없음) 채널이 닫혀 "끝남" 을 알린다.
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout.take(STDOUT_LIMIT));
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim().to_string();
                    if !line.is_empty() && tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    // 오류 출력은 쓰지 않고 버린다 (파이프가 차서 CLI 가 멈추지 않게만 비운다). 로그에도 남기지 않는다.
    thread::spawn(move || {
        let mut stderr = stderr;
        let _ = std::io::copy(&mut stderr, &mut std::io::sink());
    });

    let deadline = Instant::now() + config.timeout;
    let message = json!({ "type": "user", "message": { "role": "user", "content": "/usage" } });
    let Some(stdin) = running.child.stdin.as_mut() else {
        return Err(UnavailableReason::Failed);
    };
    if writeln!(stdin, "{message}")
        .and_then(|()| stdin.flush())
        .is_err()
    {
        return Err(UnavailableReason::Failed);
    }

    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match rx.recv_timeout(left) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => return Err(UnavailableReason::Timeout),
            // 보고서 없이 끝났다 (죽음 · 모르는 명령 뒤 종료)
            Err(RecvTimeoutError::Disconnected) => return Err(UnavailableReason::Failed),
        };
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("usage_report") {
            Some(Value::Null) | None => {}
            Some(report) => {
                running.grace = config.exit_grace;
                return Ok(report.clone());
            }
        }
        match value.get("type").and_then(Value::as_str) {
            // 진짜 모델이 답하고 있다 = CLI 가 `/usage` 를 명령으로 알아듣지 못했다. 더 쓰지 않고 끝낸다.
            Some("assistant") if is_model_reply(&value) => {
                return Err(UnavailableReason::NotSupported);
            }
            // 보고서 없이 턴이 끝났다
            Some("result") => return Err(UnavailableReason::NotSupported),
            _ => {}
        }
    }
}

/// 모델이 만든 `assistant` 메시지인가 (`/usage` 같은 로컬 명령의 결과는 모델이 `<synthetic>` 이다).
fn is_model_reply(value: &Value) -> bool {
    value
        .pointer("/message/model")
        .and_then(Value::as_str)
        .is_some_and(|model| model != "<synthetic>")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_arguments_have_no_resume_no_permission_tool_and_no_persistence() {
        let args = build_args();
        assert!(args.contains(&"--no-session-persistence"));
        assert!(args.contains(&"stream-json"));
        for forbidden in [
            "--resume",
            "-c",
            "--continue",
            "--permission-prompt-tool",
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "--add-dir",
        ] {
            assert!(!args.contains(&forbidden), "{forbidden}");
        }
    }

    #[test]
    fn only_a_non_synthetic_assistant_message_counts_as_a_model_reply() {
        assert!(is_model_reply(
            &json!({ "type": "assistant", "message": { "model": "claude-haiku-5-5" } })
        ));
        assert!(!is_model_reply(
            &json!({ "type": "assistant", "message": { "model": "<synthetic>" } })
        ));
        assert!(!is_model_reply(
            &json!({ "type": "assistant", "message": {} })
        ));
        assert!(!is_model_reply(&json!({ "type": "assistant" })));
    }

    #[test]
    fn without_claude_it_is_unavailable_not_an_error() {
        assert_eq!(
            read_with(None, false, &FetchConfig::default()),
            UsageResult::unavailable(UnavailableReason::NoClaude)
        );
    }
}
