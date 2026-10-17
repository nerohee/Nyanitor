//! 시험용 가짜 `claude` (P3-02). 설치본에 들어가지 않는다 — Cargo `[[example]]` 이라 `cargo build` · `tauri build` 는 만들지 않고
//! `cargo test` 만 만든다. 세션 관리자 시험(`tests/*.rs`)이 이 실행 파일 경로를 `ClaudeCommand` 로 끼워 쓴다.
//!
//! 하는 일: P3-01 녹화본(`tests/fixtures/cli/<이름>.jsonl`, 형식은 `scripts/cli-probe/README.md`)을 재생한다.
//! - `recv` 줄은 stdout 으로, `stderr` 줄은 stderr 로 내보낸다.
//! - `send` 줄 앞에서는 같은 종류(`user` · `control_response` · `interrupt`)의 줄이 stdin 으로 들어올 때까지 기다린다.
//!   앱이 보내지 않는 종류(`initialize` · 모르는 control · JSON 아닌 줄)의 `send` 와 그 응답은 건너뛴다.
//! - 녹화의 임시 작업 폴더 이름을 이 프로세스의 실제 작업 폴더로 바꿔서 내보낸다 (파일 경로 규칙을 시험할 수 있게).
//! - 마지막 `exit` 가 코드 0 이면 stdin 이 닫힐 때까지 기다렸다 끝내고, 0 이 아니면 바로 그 코드로 끝낸다.
//!
//! 환경 변수 (시험이 정한다):
//! - `NYANITOR_FAKE_REPLAY=<녹화 이름>` (확장자 없이)  · `NYANITOR_FAKE_FIXTURES=<폴더>` (기본: 소스의 `tests/fixtures/cli`)
//! - `NYANITOR_FAKE_FLAGS=` 쉼표로 이어 쓴 것:
//!   `free` (send 를 기다리지 않고 끝까지 재생) · `inject-unknown` (assistant 줄 앞에 모르는 type 끼움) ·
//!   `inject-nonjson` (첫 줄 앞에 JSON 아닌 줄 · 빈 줄 끼움) · `die-before-result` (첫 `result` 직전에 코드 1 로 죽음) ·
//!   `hang-on-eof` (stdin 이 닫혀도 안 끝남 — 강제 종료 시험) · `mark-done` (재생이 끝나면 stderr 에 `fake-claude: replay complete`) ·
//!   `keep-cwd` (녹화의 옛 작업 폴더 이름을 그대로 둔다)
//! - `NYANITOR_FAKE_DELAY_MS=<ms>` 느린 재생 (줄마다 쉼) · `NYANITOR_FAKE_CUT_LINE=<n>` n 번째 줄을 반만 쓰고 코드 1 로 죽음 ·
//!   `NYANITOR_FAKE_LONG_LINE=<바이트>` 첫 `system/init` 뒤에 그만큼 긴 assistant 글 한 줄을 끼움
//! - `NYANITOR_FAKE_CHILD_PIDFILE=<파일>` 손자 프로세스(60초 자는 것, stdout 을 쥔 채)를 띄우고 pid 를 적는다
//! - `NYANITOR_FAKE_ENV_DUMP=<파일>` 받은 환경 변수 **이름**을 적는다 · `NYANITOR_FAKE_LOG=<파일>` 받은 인자와 stdin 줄을 적는다
//! - `NYANITOR_FAKE_VERSION=<버전>` (`--version`) · `NYANITOR_FAKE_AUTH=in|out|garbage|slow` (`auth status`)
//! - (P3-03) `NYANITOR_FAKE_VERSION_OUT=<글>` · `NYANITOR_FAKE_VERSION_CODE=<코드>` (`--version` 이 글 그대로 · 이 종료 코드) ·
//!   `NYANITOR_FAKE_VERSION_DELAY_MS=<ms>` (`--version` 이 느림 — 시작이 오래 걸리는 동안의 경계 시험) ·
//!   `NYANITOR_FAKE_AUTH_OUT=<글>` · `NYANITOR_FAKE_AUTH_CODE=<코드>` (`auth status` 가 글 그대로 · 이 종료 코드. 글 안의 두 글자 `\n` 은 줄바꿈으로) ·
//!   `NYANITOR_FAKE_AUTH_PAD=<바이트>` (`auth status` 글 뒤에 그만큼의 `x`)
//! - (P3-03) 녹화 줄 `{"dir":"recv_bytes","hex":"…"}` — 16진수 바이트를 **그대로**(줄바꿈을 덧붙이지 않고) stdout 으로 (BOM · CRLF · 깨진 UTF-8 시험)

use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio, exit};
use std::thread::sleep;
use std::time::Duration;

use serde_json::{Value, json};

enum Item {
    Json(Value),
    Raw(String),
}

enum Step {
    Recv(Item),
    /// 바이트 그대로 (줄바꿈도 녹화가 정한다)
    RecvBytes(Vec<u8>),
    /// 이 종류의 줄이 stdin 으로 올 때까지 기다린다
    Send(String),
    Stderr(String),
    Exit(Option<i32>),
}

struct Config {
    flags: Vec<String>,
    delay: Duration,
    cut_line: Option<usize>,
    long_line: usize,
    log: Option<PathBuf>,
}

impl Config {
    fn from_env() -> Self {
        let number = |name: &str| env::var(name).ok().and_then(|v| v.parse::<usize>().ok());
        Self {
            flags: env::var("NYANITOR_FAKE_FLAGS")
                .unwrap_or_default()
                .split(',')
                .map(|f| f.trim().to_string())
                .filter(|f| !f.is_empty())
                .collect(),
            delay: Duration::from_millis(number("NYANITOR_FAKE_DELAY_MS").unwrap_or(0) as u64),
            cut_line: number("NYANITOR_FAKE_CUT_LINE"),
            long_line: number("NYANITOR_FAKE_LONG_LINE").unwrap_or(0),
            log: env::var_os("NYANITOR_FAKE_LOG").map(PathBuf::from),
        }
    }

    fn has(&self, flag: &str) -> bool {
        self.flags.iter().any(|f| f == flag)
    }

    fn log_line(&self, value: &Value) {
        let Some(path) = &self.log else { return };
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{value}");
        }
    }
}

fn main() {
    // 손자 프로세스 역할: 자기만 하고 stdout 은 그대로 쥐고 있는다.
    if env::var("NYANITOR_FAKE_ROLE").as_deref() == Ok("sleeper") {
        for _ in 0..120 {
            sleep(Duration::from_secs(1));
        }
        exit(0);
    }
    let args: Vec<String> = env::args().skip(1).collect();
    let config = Config::from_env();
    config.log_line(&json!({ "argv": args }));
    if let Some(path) = env::var_os("NYANITOR_FAKE_ENV_DUMP") {
        let mut names: Vec<String> = env::vars_os()
            .map(|(k, _)| k.to_string_lossy().into_owned())
            .collect();
        names.sort();
        let _ = fs::write(path, names.join("\n"));
    }

    if args.first().map(String::as_str) == Some("--version") {
        if let Some(ms) = env::var("NYANITOR_FAKE_VERSION_DELAY_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            sleep(Duration::from_millis(ms));
        }
        if let Ok(out) = env::var("NYANITOR_FAKE_VERSION_OUT") {
            print!("{}", out.replace("\\n", "\n"));
            let _ = io::stdout().flush();
            exit(
                env::var("NYANITOR_FAKE_VERSION_CODE")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            );
        }
        let version = env::var("NYANITOR_FAKE_VERSION").unwrap_or_else(|_| "2.1.296".into());
        println!("{version} (Claude Code)");
        return;
    }
    if args.first().map(String::as_str) == Some("auth") {
        auth_status();
        return;
    }
    run_session(&config);
}

fn auth_status() {
    if let Ok(out) = env::var("NYANITOR_FAKE_AUTH_OUT") {
        print!("{}", out.replace("\\n", "\n"));
        if let Some(pad) = env::var("NYANITOR_FAKE_AUTH_PAD")
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
        {
            print!("{}", "x".repeat(pad));
        }
        let _ = io::stdout().flush();
        exit(
            env::var("NYANITOR_FAKE_AUTH_CODE")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0),
        );
    }
    match env::var("NYANITOR_FAKE_AUTH").as_deref().unwrap_or("in") {
        "out" => {
            println!(r#"{{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}}"#);
            exit(1);
        }
        "garbage" => println!("this is not json"),
        "slow" => {
            sleep(Duration::from_secs(60));
        }
        _ => println!(
            r#"{{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"fake@example.com","orgName":"Fake Org","subscriptionType":"pro"}}"#
        ),
    }
}

// ───────────────────────── 녹화 읽기 ─────────────────────────

fn fixtures_dir() -> PathBuf {
    env::var_os("NYANITOR_FAKE_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cli"))
}

/// `send` 한 줄의 종류. 앱이 보내지 않는 것은 `None` (건너뛴다).
fn send_kind(msg: &Value) -> Option<String> {
    match msg.get("type").and_then(Value::as_str)? {
        "user" => Some("user".into()),
        "control_response" => Some("control_response".into()),
        "control_request" => {
            let subtype = msg.pointer("/request/subtype").and_then(Value::as_str)?;
            (subtype == "interrupt").then(|| "interrupt".into())
        }
        _ => None,
    }
}

/// 줄을 읽은 쪽의 종류 (`send_kind` 와 같은 말).
fn line_kind(text: &str) -> String {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => send_kind(&value).unwrap_or_else(|| "other".into()),
        Err(_) => "raw".into(),
    }
}

fn load_steps(name: &str, keep_cwd: bool) -> Vec<Step> {
    let path = fixtures_dir().join(format!("{name}.jsonl"));
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {}: {e}", path.display()));
    let records: Vec<Value> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("fixture line is JSON"))
        .collect();

    // 앱이 보내지 않는 control 요청(initialize · 모르는 subtype)의 id — 그 응답도 건너뛴다.
    let skipped_ids: Vec<String> = records
        .iter()
        .filter(|r| r["dir"] == "send")
        .filter_map(|r| r.get("msg"))
        .filter(|m| m["type"] == "control_request" && send_kind(m).is_none())
        .filter_map(|m| m["request_id"].as_str().map(str::to_string))
        .collect();

    let fixture_cwd = records
        .iter()
        .filter(|r| r["dir"] == "recv")
        .filter_map(|r| r.get("msg"))
        .find(|m| m["type"] == "system" && m["subtype"] == "init")
        .and_then(|m| m["cwd"].as_str().map(str::to_string));
    let real_cwd = env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default();

    let mut steps = Vec::new();
    for record in &records {
        match record["dir"].as_str() {
            Some("recv") => {
                if let Some(msg) = record.get("msg") {
                    let is_skipped_response = msg["type"] == "control_response"
                        && msg
                            .pointer("/response/request_id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| skipped_ids.iter().any(|s| s == id));
                    if is_skipped_response {
                        continue;
                    }
                    let mut msg = msg.clone();
                    if let (Some(from), false) = (&fixture_cwd, keep_cwd) {
                        replace_in_strings(&mut msg, from, &real_cwd);
                    }
                    steps.push(Step::Recv(Item::Json(msg)));
                } else if let Some(raw) = record["raw"].as_str() {
                    steps.push(Step::Recv(Item::Raw(raw.to_string())));
                }
            }
            Some("send") => {
                if let Some(kind) = record.get("msg").and_then(send_kind) {
                    steps.push(Step::Send(kind));
                }
            }
            Some("recv_bytes") => {
                if let Some(hex) = record["hex"].as_str() {
                    steps.push(Step::RecvBytes(decode_hex(hex)));
                }
            }
            Some("stderr") => {
                if let Some(raw) = record["raw"].as_str() {
                    steps.push(Step::Stderr(raw.to_string()));
                }
            }
            Some("exit") => steps.push(Step::Exit(record["code"].as_i64().map(|c| c as i32))),
            _ => {}
        }
    }
    steps
}

fn decode_hex(hex: &str) -> Vec<u8> {
    let digits: Vec<u8> = hex.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    digits
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).expect("hex is ASCII");
            u8::from_str_radix(text, 16).expect("hex digits")
        })
        .collect()
}

fn replace_in_strings(value: &mut Value, from: &str, to: &str) {
    match value {
        Value::String(text) if text.contains(from) => *text = text.replace(from, to),
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| replace_in_strings(v, from, to)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|v| replace_in_strings(v, from, to)),
        _ => {}
    }
}

// ───────────────────────── 재생 ─────────────────────────

fn write_stdout(text: &str, newline: bool) {
    let mut out = io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    if newline {
        let _ = out.write_all(b"\n");
    }
    let _ = out.flush();
}

fn type_of(item: &Item) -> &str {
    match item {
        Item::Json(v) => v["type"].as_str().unwrap_or(""),
        Item::Raw(_) => "",
    }
}

fn run_session(config: &Config) {
    let Ok(name) = env::var("NYANITOR_FAKE_REPLAY") else {
        eprintln!("fake claude: set NYANITOR_FAKE_REPLAY to a fixture name");
        exit(2);
    };
    let steps = load_steps(&name, config.has("keep-cwd"));

    if let Some(pidfile) = env::var_os("NYANITOR_FAKE_CHILD_PIDFILE") {
        let exe = env::current_exe().expect("current exe");
        // stdout · stderr 를 그대로 물려준다 — 이 프로세스가 끝나도 파이프가 열려 있게 (EOF 가 안 오는 경우 시험).
        let mut child = Command::new(exe)
            .env("NYANITOR_FAKE_ROLE", "sleeper")
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn sleeper");
        let _ = fs::write(pidfile, child.id().to_string());
        // 이 프로세스가 먼저 끝나도 자식은 남는다 (시험이 끄는지 본다). 기다리는 일은 곁가지 스레드가 한다.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }

    let stdin = io::stdin();
    let mut input = stdin.lock();
    let free = config.has("free");
    let mut written = 0usize;
    let mut exit_code: Option<Option<i32>> = None;

    if config.has("inject-nonjson") {
        write_stdout("this is not json {", true);
        write_stdout("", true);
    }

    for step in steps {
        match step {
            Step::Recv(item) => {
                if config.has("die-before-result") && type_of(&item) == "result" {
                    exit(1);
                }
                if config.has("inject-unknown") && type_of(&item) == "assistant" {
                    write_stdout(r#"{"type":"future_thing","payload":{"x":1}}"#, true);
                }
                let line = match &item {
                    Item::Json(v) => v.to_string(),
                    Item::Raw(r) => r.clone(),
                };
                if config.cut_line == Some(written) {
                    let half = line.len() / 2;
                    let cut = (0..=half)
                        .rev()
                        .find(|i| line.is_char_boundary(*i))
                        .unwrap_or(0);
                    write_stdout(&line[..cut], false);
                    exit(1);
                }
                write_stdout(&line, true);
                written += 1;
                if config.long_line > 0
                    && matches!(&item, Item::Json(v) if v["type"] == "system" && v["subtype"] == "init")
                {
                    let long = json!({
                        "type": "assistant",
                        "message": { "content": [{ "type": "text", "text": "x".repeat(config.long_line) }] },
                    });
                    write_stdout(&long.to_string(), true);
                }
                if !config.delay.is_zero() {
                    sleep(config.delay);
                }
            }
            Step::RecvBytes(bytes) => {
                let mut out = io::stdout().lock();
                let _ = out.write_all(&bytes);
                let _ = out.flush();
                written += 1;
            }
            Step::Send(kind) => {
                if free {
                    continue;
                }
                loop {
                    let mut line = String::new();
                    match input.read_line(&mut line) {
                        Ok(0) | Err(_) => finish_after_eof(config), // stdin 이 닫혔다 — CLI 처럼 끝낸다
                        Ok(_) => {}
                    }
                    let line = line.trim_end().to_string();
                    config.log_line(&json!({ "stdin": line }));
                    if line_kind(&line) == kind {
                        break;
                    }
                    config
                        .log_line(&json!({ "unexpected": line_kind(&line), "waiting_for": kind }));
                }
            }
            Step::Stderr(text) => {
                eprintln!("{text}");
            }
            Step::Exit(code) => exit_code = Some(code),
        }
    }

    if config.has("mark-done") {
        eprintln!("fake-claude: replay complete");
    }
    // 녹화가 끝났다. 코드 0 이면 CLI 처럼 stdin 이 닫힐 때까지 기다린다 (그동안 들어온 줄은 기록만).
    match exit_code {
        Some(Some(code)) if code != 0 => exit(code),
        Some(None) => exit(1),
        _ => {}
    }
    loop {
        let mut line = String::new();
        match input.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => config.log_line(&json!({ "stdin": line.trim_end() })),
        }
    }
    finish_after_eof(config);
}

/// stdin 이 닫힌 뒤: 보통은 코드 0 으로 끝내고, `hang-on-eof` 면 안 끝난다 (강제 종료 시험).
fn finish_after_eof(config: &Config) -> ! {
    if config.has("hang-on-eof") {
        loop {
            sleep(Duration::from_secs(3600));
        }
    }
    exit(0);
}
