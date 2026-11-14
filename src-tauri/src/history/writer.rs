//! 배경 쓰기 — 이벤트를 보내는 스레드는 큐에 넣기만 하고, 쓰는 스레드가 DB 에 묶어서 쓴다.
//!
//! - 큐는 끝이 없는 채널이지만 쌓인 수가 `Limits::max_queued` 를 넘으면 새 항목을 버리고 로그에 남긴다 (DB 가 오래 막혀도 메모리가 불어나지 않게).
//! - 쓰는 스레드는 쌓인 것을 한꺼번에(최대 `MAX_BATCH` 개) 꺼내 **한 트랜잭션**으로 쓴다 — 항목마다 디스크에 내리는 것보다 훨씬 싸다 (`synchronous=FULL`).
//!   한 트랜잭션 안에서 프로젝트마다 한도를 넘은 오래된 것을 지운다.
//! - 프로젝트가 이미 빠졌으면(`FOREIGN KEY`) 그 항목만 건너뛴다 — 빠진 프로젝트의 기록이 되살아나지 않는다. 건너뛴 것이 있으면 한 묶음에 한 번 로그에 남긴다 (조용히 버리지 않는다).
//! - DB 를 못 써서 한 묶음을 버렸으면 그 사실을 한 번 기억한다 (`take_failure`) — 쓰기가 계속 실패하는 동안은 되풀이하지 않고, 한 번 성공한 뒤 다시 실패하면 또 알린다.
//! - `flush` 는 지금까지 넣은 것이 모두 쓰일 때까지 기다린다 (기록을 읽기 전에 · 시험). `shutdown` 은 남은 것을 쓰고 스레드를 끝낸다 (앱을 끌 때).

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use rusqlite::{ErrorCode, TransactionBehavior};
use tauri_plugin_log::log;

use super::{Limits, RecordCtx, chat, record, usage};
use crate::claude::events::SessionEvent;
use crate::db::AppDb;
use crate::error::AppError;

/// 한 트랜잭션에 쓰는 최대 항목 수
const MAX_BATCH: usize = 256;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

struct Item {
    ctx: RecordCtx,
    event: SessionEvent,
}

enum Msg {
    Item(Box<Item>),
    /// 이 실행의 비어 있던 세션 ID 를 채운다 (앞서 넣은 항목들이 다 쓰인 뒤에 처리되므로 순서가 맞는다)
    Bind {
        project_id: i64,
        run_id: i64,
        session_id: String,
    },
    Flush(Sender<()>),
    Stop(Sender<()>),
}

enum Op {
    Item(Box<Item>),
    Bind {
        project_id: i64,
        run_id: i64,
        session_id: String,
    },
}

#[derive(Default)]
struct Failure {
    /// 아직 알리지 않은 실패 (오류 종류 이름)
    report: Option<String>,
    /// 실패가 이어지는 중 — 성공하면 풀린다
    ongoing: bool,
}

struct Counters {
    /// 큐에 있거나 쓰는 중인 항목 수
    queued: AtomicUsize,
    /// 큐가 가득 차서 버린 항목 수 (앱을 켠 뒤 합)
    dropped: AtomicUsize,
    warned_full: AtomicBool,
    failure: Mutex<Failure>,
}

/// 배경 쓰기 — 복제하지 않고 `SessionManager` 가 하나를 쥔다.
pub struct Recorder {
    tx: Mutex<Option<Sender<Msg>>>,
    handle: Mutex<Option<JoinHandle<()>>>,
    counters: Arc<Counters>,
    max_queued: usize,
}

impl Recorder {
    /// 쓰는 스레드를 띄운다. 스레드를 못 띄워도 앱은 계속된다 (기록만 안 남는다).
    pub fn start(db: AppDb, limits: Limits) -> Self {
        let counters = Arc::new(Counters {
            queued: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
            warned_full: AtomicBool::new(false),
            failure: Mutex::new(Failure::default()),
        });
        let (tx, rx) = mpsc::channel::<Msg>();
        let max_queued = limits.max_queued;
        let thread_counters = Arc::clone(&counters);
        let spawned = thread::Builder::new()
            .name("history-writer".into())
            .spawn(move || run(rx, &db, &limits, &thread_counters));
        let (tx, handle) = match spawned {
            Ok(handle) => (Some(tx), Some(handle)),
            Err(err) => {
                log::error!("could not start the chat history writer: {err}");
                (None, None)
            }
        };
        Self {
            tx: Mutex::new(tx),
            handle: Mutex::new(handle),
            counters,
            max_queued,
        }
    }

    fn send(&self, msg: Msg, capped: bool) -> bool {
        if capped && self.counters.queued.load(Ordering::SeqCst) >= self.max_queued {
            self.counters.dropped.fetch_add(1, Ordering::SeqCst);
            if !self.counters.warned_full.swap(true, Ordering::SeqCst) {
                log::warn!("the chat history queue is full; dropping new items until it drains");
            }
            return false;
        }
        let guard = lock(&self.tx);
        let Some(tx) = guard.as_ref() else {
            return false;
        };
        self.counters.queued.fetch_add(1, Ordering::SeqCst);
        if tx.send(msg).is_err() {
            self.counters.queued.fetch_sub(1, Ordering::SeqCst);
            return false;
        }
        true
    }

    /// 이벤트 하나를 쓸 줄에 세운다. 막지 않는다 (채널에 넣기만). 넣었으면 `true`.
    pub fn submit(&self, ctx: RecordCtx, event: SessionEvent) -> bool {
        self.send(Msg::Item(Box::new(Item { ctx, event })), true)
    }

    /// 이 실행의 세션 ID 를 알게 됐다 — 앞서 넣은 항목 가운데 비어 있던 것에 채우도록 줄에 세운다.
    pub fn bind(&self, project_id: i64, run_id: i64, session_id: &str) {
        self.send(
            Msg::Bind {
                project_id,
                run_id,
                session_id: session_id.to_string(),
            },
            false,
        );
    }

    /// 지금까지 넣은 것이 모두 쓰일 때까지 기다린다 (최대 `timeout`). 다 쓰였으면 `true`.
    pub fn flush(&self, timeout: Duration) -> bool {
        let (ack_tx, ack_rx) = mpsc::channel();
        {
            let guard = lock(&self.tx);
            let Some(tx) = guard.as_ref() else {
                return true; // 이미 끝났다 — 남은 것이 없다
            };
            if tx.send(Msg::Flush(ack_tx)).is_err() {
                return false; // 쓰는 스레드가 죽었다
            }
        }
        ack_rx.recv_timeout(timeout).is_ok()
    }

    /// 남은 것을 쓰고 스레드를 끝낸다 (앱을 끌 때). 이 뒤의 `submit` 은 받지 않는다. 오래 걸리면 `timeout` 뒤에 기다리기를 그만둔다.
    pub fn shutdown(&self, timeout: Duration) {
        let Some(tx) = lock(&self.tx).take() else {
            return;
        };
        let (ack_tx, ack_rx) = mpsc::channel();
        let acked = tx.send(Msg::Stop(ack_tx)).is_ok() && ack_rx.recv_timeout(timeout).is_ok();
        drop(tx);
        let handle = lock(&self.handle).take();
        match handle {
            Some(handle) if acked => {
                let _ = handle.join();
            }
            Some(_) => log::warn!("the chat history writer did not finish in time"),
            None => {}
        }
    }

    /// 쓰기가 실패했다는 알림을 꺼낸다 (오류 종류 이름) — 같은 실패는 한 번만 나온다.
    pub fn take_failure(&self) -> Option<String> {
        lock(&self.counters.failure).report.take()
    }

    /// 가득 차서 버린 항목 수 (진단 · 시험용)
    pub fn dropped(&self) -> usize {
        self.counters.dropped.load(Ordering::SeqCst)
    }
}

/// 제약 위반(없는 프로젝트 등)은 그 항목만 건너뛴다 (`false`). 다른 오류는 그대로 올린다.
fn wrote(result: rusqlite::Result<()>) -> rusqlite::Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::SqliteFailure(failure, _))
            if failure.code == ErrorCode::ConstraintViolation =>
        {
            Ok(false)
        }
        Err(other) => Err(other),
    }
}

/// 한 묶음을 한 트랜잭션으로 쓴다. 실패하면 아무것도 남지 않는다. 돌려주는 것: 제약 위반(프로젝트가 그 사이 빠짐 등)으로 건너뛴 항목 수.
fn write_ops(db: &AppDb, limits: &Limits, ops: &[Op]) -> Result<usize, AppError> {
    db.write(|conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut touched = BTreeSet::new();
        let mut skipped = 0_usize;
        // 이 묶음에서 쓴 사용량 줄의 가장 늦은 시각 — 오래된 줄을 지우는 기준
        let mut newest_usage_at: Option<i64> = None;
        for op in ops {
            match op {
                Op::Item(item) => {
                    if let Some(draft) = record::draft(&item.event, limits) {
                        if wrote(chat::insert(&tx, &item.ctx, &draft))? {
                            touched.insert(item.ctx.project_id);
                        } else {
                            skipped += 1;
                        }
                    }
                    if let SessionEvent::TurnEnded(summary) = &item.event {
                        if wrote(usage::insert(&tx, &item.ctx, summary))? {
                            newest_usage_at = newest_usage_at.max(Some(item.ctx.at));
                        } else {
                            skipped += 1;
                        }
                    }
                }
                Op::Bind {
                    project_id,
                    run_id,
                    session_id,
                } => chat::bind_session(&tx, *project_id, *run_id, session_id)?,
            }
        }
        for project_id in touched {
            chat::trim(&tx, project_id, limits.max_items_per_project)?;
        }
        // 턴이 끝날 때만 (사용량 줄이 늘 때만) 오래된 줄을 가볍게 지운다 — 시각 색인으로 오래된 쪽만 본다
        if let Some(at) = newest_usage_at {
            usage::prune(&tx, at.saturating_sub(limits.usage_keep_secs))?;
        }
        tx.commit()?;
        Ok(skipped)
    })
}

fn run(rx: Receiver<Msg>, db: &AppDb, limits: &Limits, counters: &Counters) {
    let mut stopping = false;
    while !stopping {
        let Ok(first) = rx.recv() else {
            break; // 보내는 쪽이 다 사라졌다
        };
        let mut messages = vec![first];
        while messages.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(message) => messages.push(message),
                Err(_) => break,
            }
        }
        let mut ops = Vec::with_capacity(messages.len());
        let mut acks = Vec::new();
        for message in messages {
            match message {
                Msg::Item(item) => ops.push(Op::Item(item)),
                Msg::Bind {
                    project_id,
                    run_id,
                    session_id,
                } => ops.push(Op::Bind {
                    project_id,
                    run_id,
                    session_id,
                }),
                Msg::Flush(ack) => acks.push(ack),
                Msg::Stop(ack) => {
                    acks.push(ack);
                    stopping = true;
                }
            }
        }
        if !ops.is_empty() {
            match write_ops(db, limits, &ops) {
                Ok(skipped) => {
                    if skipped > 0 {
                        // 프로젝트가 그 사이 빠졌다 (외래 키 위반) — 그 기록은 버렸다. 조용히 사라지지 않게 한 묶음에 한 번 남긴다.
                        log::warn!(
                            "{skipped} chat history item(s) were not stored because their project is gone (database constraint)"
                        );
                    }
                    lock(&counters.failure).ongoing = false;
                }
                Err(err) => {
                    let mut failure = lock(&counters.failure);
                    if !failure.ongoing {
                        log::warn!(
                            "could not write the chat history ({} items dropped): {err}",
                            ops.len()
                        );
                        failure.report = Some(err.kind().to_string());
                    }
                    failure.ongoing = true;
                }
            }
            counters.queued.fetch_sub(ops.len(), Ordering::SeqCst);
            if counters.queued.load(Ordering::SeqCst) == 0 {
                counters.warned_full.store(false, Ordering::SeqCst);
            }
        }
        for ack in acks {
            let _ = ack.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::events::{TokenUsage, TurnOutcome, TurnSummary};
    use crate::claude::test_util::TempDir;
    use crate::db::DB_FILE;
    use crate::projects::store as projects_store;
    use std::time::Instant;

    const WAIT: Duration = Duration::from_secs(10);

    fn setup(name: &str) -> (TempDir, AppDb) {
        let dir = TempDir::new(name);
        let db = AppDb::open(&dir.join(DB_FILE));
        for key in ["a", "b"] {
            db.write(|conn| projects_store::insert(conn, key, key, key, None, 1))
                .unwrap();
        }
        (dir, db)
    }

    fn ctx(project_id: i64) -> RecordCtx {
        RecordCtx {
            project_id,
            run_id: 1,
            session_id: None,
            at: 100,
            api_key_source: Some("none".into()),
        }
    }

    fn say(n: usize) -> SessionEvent {
        SessionEvent::Text {
            text: format!("t{n}"),
        }
    }

    fn turn_ended() -> SessionEvent {
        SessionEvent::TurnEnded(TurnSummary {
            outcome: TurnOutcome::Success,
            subtype: None,
            is_error: false,
            terminal_reason: None,
            result: Some("done".into()),
            errors: vec![],
            api_error_status: None,
            duration_ms: None,
            num_turns: None,
            usage: TokenUsage {
                input_tokens: 5,
                output_tokens: 6,
                cache_creation_input_tokens: 7,
                cache_read_input_tokens: 8,
            },
            cost_usd: 0.5,
            total_cost_usd: 0.5,
        })
    }

    fn texts(db: &AppDb, project_id: i64) -> Vec<String> {
        db.read(|conn| chat::read_page(conn, project_id, None, 1000, None))
            .unwrap()
            .entries
            .iter()
            .map(|e| e.event["text"].as_str().unwrap_or("?").to_string())
            .collect()
    }

    #[test]
    fn items_are_written_in_order_after_a_flush() {
        let (_dir, db) = setup("rec-order");
        let recorder = Recorder::start(db.clone(), Limits::default());
        for n in 0..300 {
            assert!(recorder.submit(ctx(1), say(n)));
        }
        assert!(recorder.flush(WAIT));
        let got = texts(&db, 1);
        let want: Vec<String> = (0..300).map(|n| format!("t{n}")).collect();
        assert_eq!(got, want, "여러 묶음에 걸쳐도 순서가 그대로");
        recorder.shutdown(WAIT);
    }

    #[test]
    fn a_turn_end_writes_both_the_chat_item_and_the_usage_row() {
        let (_dir, db) = setup("rec-usage");
        let recorder = Recorder::start(db.clone(), Limits::default());
        recorder.submit(ctx(1), turn_ended());
        assert!(recorder.flush(WAIT));
        let page = db.read(|c| chat::read_page(c, 1, None, 10, None)).unwrap();
        assert_eq!(page.entries.len(), 1);
        assert_eq!(page.entries[0].event["type"], "turn_ended");
        let summary = db.read(|c| usage::summarize(c, 0, None)).unwrap();
        assert_eq!(summary.today.turns, 1);
        assert_eq!(summary.today.total_tokens, 26);
        assert_eq!(summary.today.subscription_turns, 1);
        recorder.shutdown(WAIT);
    }

    #[test]
    fn a_turn_end_prunes_usage_rows_older_than_the_keep_period_and_leaves_the_chat_alone() {
        let (_dir, db) = setup("rec-usage-prune");
        let limits = Limits::default();
        let now = 1_800_000_000_i64;
        let at = |days: i64| RecordCtx {
            at: now - days * 86_400,
            ..ctx(1)
        };
        let recorder = Recorder::start(db.clone(), limits.clone());
        // 오래된 턴 둘 (가장 새 줄(10일 전) 기준으로 90일 밖) · 안쪽 턴 하나
        recorder.submit(at(120), turn_ended());
        recorder.submit(at(101), turn_ended());
        recorder.submit(at(10), turn_ended());
        assert!(recorder.flush(WAIT));
        let turns = |conn: &rusqlite::Connection| -> i64 {
            conn.query_row("SELECT count(*) FROM usage_turns", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(
            db.read(|c| Ok(turns(c))).unwrap(),
            1,
            "90일 밖의 두 줄이 지워졌다"
        );
        // 채팅 줄은 사용량 정리와 상관없이 셋 다 있다
        let page = db.read(|c| chat::read_page(c, 1, None, 10, None)).unwrap();
        assert_eq!(page.entries.len(), 3);
        // 새 턴이 쓰이면 그 시각 기준으로 또 정리된다 — 남은 줄의 합은 그대로 더해진다
        recorder.submit(at(0), turn_ended());
        assert!(recorder.flush(WAIT));
        assert_eq!(db.read(|c| Ok(turns(c))).unwrap(), 2);
        let summary = db
            .read(|c| usage::summarize(c, now - 86_400, None))
            .unwrap();
        assert_eq!(summary.today.turns, 1);
        assert_eq!(summary.projects[0].total.turns, 2);
        // 사용량이 아닌 이벤트만 쓰는 묶음은 정리하지 않는다 (오래된 줄이 새로 생긴 줄 때문에 지워지지 않으면 그대로)
        recorder.submit(at(0), say(1));
        assert!(recorder.flush(WAIT));
        assert_eq!(db.read(|c| Ok(turns(c))).unwrap(), 2);
        recorder.shutdown(WAIT);
    }

    #[test]
    fn a_lone_old_turn_with_a_clock_far_in_the_past_is_not_pruned() {
        // 시각이 작은 값(시험 · 시계가 거꾸로 간 PC)이어도 자기 자신을 지우지 않는다
        let (_dir, db) = setup("rec-usage-old-clock");
        let recorder = Recorder::start(db.clone(), Limits::default());
        recorder.submit(ctx(1), turn_ended()); // at = 100
        assert!(recorder.flush(WAIT));
        let summary = db.read(|c| usage::summarize(c, 0, None)).unwrap();
        assert_eq!(summary.today.turns, 1);
        recorder.shutdown(WAIT);
    }

    #[test]
    fn submitting_does_not_wait_for_a_slow_database() {
        let (_dir, db) = setup("rec-slow");
        let recorder = Recorder::start(db.clone(), Limits::default());
        // 다른 스레드가 DB 를 오래 쥐고 있다
        let blocker = db.clone();
        let (held_tx, held_rx) = mpsc::channel();
        let holder = thread::spawn(move || {
            blocker
                .write(|_| {
                    held_tx.send(()).unwrap();
                    thread::sleep(Duration::from_millis(600));
                    Ok(())
                })
                .unwrap();
        });
        held_rx.recv().unwrap();
        let started = Instant::now();
        for n in 0..50 {
            recorder.submit(ctx(1), say(n));
        }
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "넣는 쪽이 DB 를 기다렸다: {:?}",
            started.elapsed()
        );
        holder.join().unwrap();
        assert!(recorder.flush(WAIT));
        assert_eq!(texts(&db, 1).len(), 50);
        recorder.shutdown(WAIT);
    }

    #[test]
    fn shutdown_writes_what_is_left_and_later_submits_are_refused() {
        let (_dir, db) = setup("rec-shutdown");
        let recorder = Recorder::start(db.clone(), Limits::default());
        for n in 0..20 {
            recorder.submit(ctx(1), say(n));
        }
        recorder.shutdown(WAIT);
        assert_eq!(texts(&db, 1).len(), 20, "끌 때 남은 것을 썼다");
        assert!(!recorder.submit(ctx(1), say(99)));
        assert!(recorder.flush(WAIT), "이미 끝났으면 기다릴 것이 없다");
        // 두 번 불러도 된다
        recorder.shutdown(WAIT);
    }

    #[test]
    fn old_items_are_trimmed_per_project_in_the_same_pass() {
        let (_dir, db) = setup("rec-trim");
        let limits = Limits {
            max_items_per_project: 5,
            ..Limits::default()
        };
        let recorder = Recorder::start(db.clone(), limits);
        for n in 0..12 {
            recorder.submit(ctx(1), say(n));
        }
        for n in 0..3 {
            recorder.submit(ctx(2), say(100 + n));
        }
        assert!(recorder.flush(WAIT));
        assert_eq!(texts(&db, 1), ["t7", "t8", "t9", "t10", "t11"]);
        assert_eq!(texts(&db, 2), ["t100", "t101", "t102"]);
        recorder.shutdown(WAIT);
    }

    #[test]
    fn long_text_is_cut_by_the_limit() {
        let (_dir, db) = setup("rec-long");
        let limits = Limits {
            max_text_chars: 5,
            ..Limits::default()
        };
        let recorder = Recorder::start(db.clone(), limits);
        recorder.submit(
            ctx(1),
            SessionEvent::UserMessage {
                text: "abcdefghij".into(),
                deferred: false,
            },
        );
        assert!(recorder.flush(WAIT));
        let page = db.read(|c| chat::read_page(c, 1, None, 5, None)).unwrap();
        assert_eq!(page.entries[0].event["text"], "abcde…");
        assert!(page.entries[0].truncated);
        recorder.shutdown(WAIT);
    }

    #[test]
    fn an_item_of_a_removed_project_is_skipped_and_the_rest_of_the_batch_is_kept() {
        let (_dir, db) = setup("rec-gone");
        let recorder = Recorder::start(db.clone(), Limits::default());
        db.write(|conn| projects_store::remove(conn, 2)).unwrap();
        recorder.submit(ctx(1), say(1));
        recorder.submit(ctx(2), say(2));
        recorder.submit(ctx(2), turn_ended());
        recorder.submit(ctx(1), say(3));
        assert!(recorder.flush(WAIT));
        assert_eq!(texts(&db, 1), ["t1", "t3"]);
        assert!(texts(&db, 2).is_empty());
        assert_eq!(
            recorder.take_failure(),
            None,
            "빠진 프로젝트는 실패가 아니다"
        );
        recorder.shutdown(WAIT);
    }

    #[test]
    fn write_ops_reports_how_many_items_a_removed_project_made_it_skip() {
        // 로그에 한 번 남기는 값 — 건너뛴 항목 수 (채팅 한 줄 + 츄르 한 줄 = 둘)
        let (_dir, db) = setup("rec-gone-count");
        db.write(|conn| projects_store::remove(conn, 2)).unwrap();
        let item = |project_id: i64, event: SessionEvent| {
            Op::Item(Box::new(Item {
                ctx: ctx(project_id),
                event,
            }))
        };
        let limits = Limits::default();
        let ops = [
            item(1, say(1)),
            item(2, say(2)),
            item(2, turn_ended()),
            item(1, say(3)),
        ];
        assert_eq!(write_ops(&db, &limits, &ops).unwrap(), 3);
        assert_eq!(texts(&db, 1), ["t1", "t3"]);
        // 빠진 프로젝트가 없으면 0 (경고를 남기지 않는다)
        let fine = [item(1, say(4))];
        assert_eq!(write_ops(&db, &limits, &fine).unwrap(), 0);
    }

    #[test]
    fn binding_fills_the_session_id_of_items_queued_before_it() {
        let (_dir, db) = setup("rec-bind");
        let recorder = Recorder::start(db.clone(), Limits::default());
        recorder.submit(ctx(1), say(1));
        recorder.bind(1, 1, "sess-1");
        let mut with_id = ctx(1);
        with_id.session_id = Some("sess-1".into());
        recorder.submit(with_id, say(2));
        assert!(recorder.flush(WAIT));
        let page = db.read(|c| chat::read_page(c, 1, None, 5, None)).unwrap();
        let ids: Vec<_> = page.entries.iter().map(|e| e.session_id.clone()).collect();
        assert_eq!(
            ids,
            [Some("sess-1".to_string()), Some("sess-1".to_string())]
        );
        recorder.shutdown(WAIT);
    }

    #[test]
    fn a_full_queue_drops_new_items_instead_of_growing() {
        let (_dir, db) = setup("rec-full");
        let limits = Limits {
            max_queued: 10,
            ..Limits::default()
        };
        let recorder = Recorder::start(db.clone(), limits);
        let blocker = db.clone();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = thread::spawn(move || {
            blocker
                .write(|_| {
                    held_tx.send(()).unwrap();
                    let _ = release_rx.recv_timeout(Duration::from_secs(10));
                    Ok(())
                })
                .unwrap();
        });
        held_rx.recv().unwrap();
        let accepted = (0..40).filter(|n| recorder.submit(ctx(1), say(*n))).count();
        // 쓰는 스레드가 DB 를 기다리는 동안에도 큐에 있는 수로 세므로 한도에서 딱 멈춘다
        assert_eq!(accepted, 10);
        assert_eq!(recorder.dropped(), 30);
        release_tx.send(()).unwrap();
        holder.join().unwrap();
        assert!(recorder.flush(WAIT));
        assert_eq!(texts(&db, 1).len(), accepted);
        // 비워지면 다시 받는다
        assert!(recorder.submit(ctx(1), say(1000)));
        recorder.shutdown(WAIT);
    }

    #[test]
    fn an_unwritable_database_reports_one_failure_and_the_writer_keeps_going() {
        // 데이터 폴더 자리에 파일이 있어 DB 를 못 연다
        let dir = TempDir::new("rec-unavailable");
        let blocker = dir.join("data");
        std::fs::write(&blocker, b"i am a file").unwrap();
        let db = AppDb::open(&blocker.join(DB_FILE));
        let recorder = Recorder::start(db, Limits::default());
        recorder.submit(ctx(1), say(1));
        assert!(recorder.flush(WAIT));
        assert_eq!(recorder.take_failure().as_deref(), Some("db_unavailable"));
        // 같은 실패는 되풀이해 알리지 않는다
        recorder.submit(ctx(1), say(2));
        assert!(recorder.flush(WAIT));
        assert_eq!(recorder.take_failure(), None);
        // 스레드는 살아 있다
        assert!(recorder.submit(ctx(1), say(3)));
        recorder.shutdown(WAIT);
    }

    #[test]
    fn a_read_only_newer_database_reports_a_failure_and_nothing_is_written() {
        let dir = TempDir::new("rec-readonly");
        let path = dir.join(DB_FILE);
        drop(setup_in(&dir));
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", crate::db::SCHEMA_VERSION + 1)
                .unwrap();
        }
        let db = AppDb::open(&path);
        let recorder = Recorder::start(db.clone(), Limits::default());
        recorder.submit(ctx(1), say(1));
        assert!(recorder.flush(WAIT));
        assert_eq!(recorder.take_failure().as_deref(), Some("db_read_only"));
        assert!(texts(&db, 1).is_empty());
        recorder.shutdown(WAIT);
    }

    fn setup_in(dir: &TempDir) -> AppDb {
        let db = AppDb::open(&dir.join(DB_FILE));
        db.write(|conn| projects_store::insert(conn, "a", "a", "a", None, 1))
            .unwrap();
        db
    }

    #[test]
    fn a_failure_after_a_success_is_reported_again() {
        let (_dir, db) = setup("rec-again");
        let recorder = Recorder::start(db.clone(), Limits::default());
        // 앞 항목은 성공
        recorder.submit(ctx(1), say(1));
        assert!(recorder.flush(WAIT));
        assert_eq!(recorder.take_failure(), None);
        // 테이블을 없애 쓰기를 실패하게 한다
        db.write(|c| {
            c.execute_batch("DROP TABLE chat_items")?;
            Ok(())
        })
        .unwrap();
        recorder.submit(ctx(1), say(2));
        assert!(recorder.flush(WAIT));
        assert!(recorder.take_failure().is_some());
        recorder.shutdown(WAIT);
    }

    #[test]
    fn flush_on_an_idle_recorder_returns_at_once() {
        let (_dir, db) = setup("rec-idle");
        let recorder = Recorder::start(db, Limits::default());
        let started = Instant::now();
        assert!(recorder.flush(WAIT));
        assert!(started.elapsed() < Duration::from_secs(2));
        recorder.shutdown(WAIT);
    }
}
