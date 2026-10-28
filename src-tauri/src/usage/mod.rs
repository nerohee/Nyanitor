//! 사용량 한도 읽기 (P5-01, D-24) — `/usage` 의 구조화 결과(`usage_report`)로 구독 한도 %와 초기화 시각을 받는다.
//!
//! 실험 결과 (CLI 2.1.296, 녹화본 `tests/fixtures/cli/usage.jsonl`): stream-json 세션에 `/usage` 를 보내면 모델을 부르지 않고
//! (비용 0 · 토큰 0) 약 1~2초 안에 `usage_report` 를 실은 합성 `assistant` 메시지와 `result` 가 온다. 구독 로그인일 때만 한도 줄이 들어 있다.
//!
//! - `report` — `usage_report` 읽기 (순수 함수: 사용률은 0~1, 초기화 시각은 유닉스 초 — 돌아가는 세션의 `rate_limit_event` 와 같은 뜻)
//! - `fetch` — 짧은 별도 세션을 띄워 `/usage` 를 보내고 `usage_report` 를 받아 돌려준다 (시간 제한 · 프로세스 트리 끄기)
//! - `commands` — Tauri 명령 `usage_read` (얇게)
//!
//! 이 모듈은 구독 로그인이 아니거나 못 받으면 **오류가 아니라 `unavailable` 과 이유**를 돌려준다 (화면은 "확인할 수 없음", 앱은 그대로 동작).
//! 같은 결과를 잠깐 기억해 너무 자주 세션을 띄우지 않고, 동시에 여러 번 불러도 세션은 하나만 뜬다. 원본 출력은 로그에 남기지 않는다 (계정 정보가 들어 있다).
//! 화면에서 실행 파일 · 인자 · 경로를 받는 길은 없다.

pub mod commands;
pub mod fetch;
pub mod report;

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

/// 한 한도 창 (5시간 · 7일)
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// 사용률 0~1 (100% 를 넘기면 1 보다 클 수 있다)
    pub utilization: f64,
    /// 초기화 시각 (유닉스 초). 모르면 `None`
    pub resets_at: Option<i64>,
    /// 서버가 매긴 정도 (`normal` · `warning` · `critical` …, 글 그대로)
    pub severity: Option<String>,
}

/// 모델 · 표면별 주간 한도
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedWindow {
    /// 서버가 준 이름 (예: 모델 이름)
    pub label: String,
    pub utilization: f64,
    pub resets_at: Option<i64>,
    pub severity: Option<String>,
}

/// 읽은 한도
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReading {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    pub scoped: Vec<ScopedWindow>,
    /// 추가 사용(초과 요금)을 켰는가 (금액은 읽지 않는다)
    pub extra_usage_enabled: Option<bool>,
    /// 읽은 때 (유닉스 초). 기억한 값이면 처음 읽은 때
    pub read_at: i64,
}

/// 못 받는 이유
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UnavailableReason {
    /// 구독 로그인이 아니다 (API 키 · 다른 제공자) — 한도가 없다
    NotSubscription,
    NotLoggedIn,
    /// 이 PC 에서 `claude` 를 찾지 못했다
    NoClaude,
    /// CLI 가 한도를 주지 않는다 (`usage_report` 가 없다 · 모양이 다르다 · 한도 줄이 없다)
    NotSupported,
    /// 시간 안에 못 받았다
    Timeout,
    /// 그 밖의 실패 (실행 실패 · 중간에 끝남 · CLI 가 한도를 가져오지 못함)
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageUnavailable {
    pub reason: UnavailableReason,
}

/// `usage_read` 의 결과 — 오류가 아니라 두 상태 중 하나.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UsageResult {
    Ok(UsageReading),
    Unavailable(UsageUnavailable),
}

impl UsageResult {
    pub fn unavailable(reason: UnavailableReason) -> Self {
        UsageResult::Unavailable(UsageUnavailable { reason })
    }
}

/// 기억하는 시간
#[derive(Debug, Clone, Copy)]
pub struct CacheConfig {
    /// 받은 한도 — 이 안에 다시 부르면 기억한 값 (한도 % 는 몇 분 단위로만 변한다)
    pub ok_ttl: Duration,
    /// 못 받은 결과 — 짧게만 기억한다 (곧 다시 시도할 수 있게, 그래도 세션을 연달아 띄우지 않게)
    pub unavailable_ttl: Duration,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            ok_ttl: Duration::from_secs(5 * 60),
            unavailable_ttl: Duration::from_secs(60),
        }
    }
}

struct Cached {
    result: UsageResult,
    at: Instant,
}

#[derive(Default)]
struct Shared {
    cached: Option<Cached>,
    /// 세션을 띄워 읽는 중 (한 번에 하나)
    running: bool,
}

struct Inner {
    shared: Mutex<Shared>,
    done: Condvar,
    config: CacheConfig,
}

/// 읽은 한도를 기억하고 동시에 하나만 읽게 한다. 복제해도 같은 기억을 가리킨다 (Tauri `State` · 스레드에 나눠 쥔다).
#[derive(Clone)]
pub struct UsageState {
    inner: Arc<Inner>,
}

impl Default for UsageState {
    fn default() -> Self {
        Self::new(CacheConfig::default())
    }
}

fn lock(mutex: &Mutex<Shared>) -> MutexGuard<'_, Shared> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 읽던 쪽이 패닉해도 "읽는 중" 표시가 남지 않게 한다 (다른 호출이 영원히 기다리지 않도록).
struct RunningGuard<'a> {
    inner: &'a Inner,
    finished: bool,
}

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            lock(&self.inner.shared).running = false;
            self.inner.done.notify_all();
        }
    }
}

impl UsageState {
    pub fn new(config: CacheConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                shared: Mutex::new(Shared::default()),
                done: Condvar::new(),
                config,
            }),
        }
    }

    fn ttl_of(&self, result: &UsageResult) -> Duration {
        match result {
            UsageResult::Ok(_) => self.inner.config.ok_ttl,
            UsageResult::Unavailable(_) => self.inner.config.unavailable_ttl,
        }
    }

    fn fresh(&self, cached: &Cached) -> bool {
        cached.at.elapsed() < self.ttl_of(&cached.result)
    }

    /// 기억한 값이 아직 유효하면 그것을, 아니면 `fetch` 로 읽어 기억하고 돌려준다.
    /// 다른 호출이 읽는 중이면 그것이 끝나기를 기다렸다가 그 결과를 쓴다 (세션 하나).
    pub fn read(&self, fetch: impl FnOnce() -> UsageResult) -> UsageResult {
        let mut shared = lock(&self.inner.shared);
        loop {
            if let Some(cached) = &shared.cached
                && self.fresh(cached)
            {
                return cached.result.clone();
            }
            if !shared.running {
                shared.running = true;
                break;
            }
            shared = self
                .inner
                .done
                .wait(shared)
                .unwrap_or_else(PoisonError::into_inner);
        }
        drop(shared);

        let mut guard = RunningGuard {
            inner: &self.inner,
            finished: false,
        };
        let result = fetch();
        {
            let mut shared = lock(&self.inner.shared);
            shared.cached = Some(Cached {
                result: result.clone(),
                at: Instant::now(),
            });
            shared.running = false;
            guard.finished = true;
        }
        self.inner.done.notify_all();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::thread;

    fn ok(read_at: i64) -> UsageResult {
        UsageResult::Ok(UsageReading {
            five_hour: Some(UsageWindow {
                utilization: 0.5,
                resets_at: None,
                severity: None,
            }),
            seven_day: None,
            scoped: Vec::new(),
            extra_usage_enabled: None,
            read_at,
        })
    }

    fn state(ok_ms: u64, unavailable_ms: u64) -> UsageState {
        UsageState::new(CacheConfig {
            ok_ttl: Duration::from_millis(ok_ms),
            unavailable_ttl: Duration::from_millis(unavailable_ms),
        })
    }

    #[test]
    fn serializes_with_a_state_tag_and_camel_case() {
        let json = serde_json::to_value(ok(7)).unwrap();
        assert_eq!(json["state"], "ok");
        assert_eq!(json["readAt"], 7);
        assert_eq!(json["fiveHour"]["utilization"], 0.5);
        assert_eq!(json["fiveHour"]["resetsAt"], serde_json::Value::Null);
        assert_eq!(json["sevenDay"], serde_json::Value::Null);
        assert_eq!(json["scoped"], serde_json::json!([]));
        let json = serde_json::to_value(UsageResult::unavailable(UnavailableReason::NotSupported))
            .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "state": "unavailable", "reason": "not_supported" })
        );
    }

    #[test]
    fn a_second_call_within_the_time_gets_the_remembered_value_without_reading() {
        let state = state(60_000, 60_000);
        let calls = AtomicUsize::new(0);
        let fetch = |n: i64| {
            calls.fetch_add(1, Ordering::SeqCst);
            ok(n)
        };
        assert_eq!(state.read(|| fetch(1)), ok(1));
        assert_eq!(state.read(|| fetch(2)), ok(1), "기억한 값 (처음 읽은 때)");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn after_the_time_it_reads_again() {
        let state = state(30, 30);
        assert_eq!(state.read(|| ok(1)), ok(1));
        thread::sleep(Duration::from_millis(60));
        assert_eq!(state.read(|| ok(2)), ok(2));
    }

    #[test]
    fn unavailable_results_are_remembered_for_their_own_shorter_time() {
        let state = state(60_000, 30);
        let first = UsageResult::unavailable(UnavailableReason::Timeout);
        assert_eq!(state.read(|| first.clone()), first);
        // 짧은 시간 안에는 기억한 값
        assert_eq!(state.read(|| ok(9)), first);
        thread::sleep(Duration::from_millis(60));
        assert_eq!(state.read(|| ok(9)), ok(9));
        // 받은 값은 못 받은 값보다 오래 간다
        assert_eq!(state.read(|| ok(10)), ok(9));
    }

    #[test]
    fn a_zero_time_never_remembers() {
        let state = state(0, 0);
        assert_eq!(state.read(|| ok(1)), ok(1));
        assert_eq!(state.read(|| ok(2)), ok(2));
    }

    #[test]
    fn simultaneous_calls_start_one_read_and_all_get_its_result() {
        let state = state(60_000, 60_000);
        let calls = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let state = state.clone();
                let calls = calls.clone();
                thread::spawn(move || {
                    state.read(|| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(150));
                        ok(42)
                    })
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap(), ok(42));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn simultaneous_calls_with_no_memory_still_read_one_at_a_time() {
        // 기억이 없어도(시간 0) 읽는 동안에는 겹치지 않는다
        let state = state(0, 0);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let handles: Vec<_> = (0..6)
            .map(|_| {
                let state = state.clone();
                let running = running.clone();
                let peak = peak.clone();
                thread::spawn(move || {
                    state.read(|| {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(20));
                        running.fetch_sub(1, Ordering::SeqCst);
                        ok(1)
                    })
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_panicking_read_does_not_block_later_calls() {
        let state = state(60_000, 60_000);
        let crashed = {
            let state = state.clone();
            thread::spawn(move || state.read(|| panic!("boom"))).join()
        };
        assert!(crashed.is_err());
        // 표시가 남지 않았다 — 다음 호출이 바로 읽는다
        assert_eq!(state.read(|| ok(5)), ok(5));
    }

    #[test]
    fn waiters_behind_a_panicking_read_take_over() {
        let state = state(60_000, 60_000);
        let first = {
            let state = state.clone();
            thread::spawn(move || {
                state.read(|| {
                    thread::sleep(Duration::from_millis(100));
                    panic!("boom")
                })
            })
        };
        thread::sleep(Duration::from_millis(30));
        let second = {
            let state = state.clone();
            thread::spawn(move || state.read(|| ok(8)))
        };
        assert!(first.join().is_err());
        assert_eq!(second.join().unwrap(), ok(8));
    }
}
