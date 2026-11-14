//! 자식 프로세스 트리를 한꺼번에 끄는 도구.
//!
//! 이유: Windows 에서 `claude` 하나만 죽이면 claude 가 시킨 `bash` · `node` 가 남는다
//! (`notes/P3-01-cli-protocol.md` §4-6 함정 2).
//! - Windows: Job Object (`KILL_ON_JOB_CLOSE`). 앱이 비정상 종료해도 OS 가 핸들을 닫으면서 트리가 꺼진다.
//!   Job 에 넣지 못하면 `taskkill /T /F` 로 대신한다 (앱이 죽을 때 자식이 남을 수 있음 — 경고를 남긴다).
//! - 그 밖(macOS · Linux): 프로세스 그룹을 새로 만들고 그룹 전체에 SIGKILL. 앱이 비정상으로 끝나도 남지 않게 **자식마다 감시 프로세스**를 하나 붙인다 (아래 `watchdog`).
//!
//! 이 파일 밖에서는 `unsafe` 를 쓰지 않는다.

use std::process::{Child, Command};

use tauri_plugin_log::log;

/// 만든 자식 프로세스에 붙이는 "트리 끄개". 버리면(Drop) Windows 는 Job 핸들이 닫혀 남은 프로세스가 꺼진다.
pub struct ProcessTree {
    inner: Inner,
    /// macOS · Linux: 앱이 비정상으로 끝나면 이 자식의 그룹을 대신 끄는 감시 프로세스 (`watchdog`). 이 트리가 버려질 때 같이 치운다.
    #[cfg(unix)]
    watchdog: Option<std::process::Child>,
}

enum Inner {
    #[cfg(windows)]
    Job(windows_job::Job),
    /// Job 에 넣지 못한 경우 (또는 Windows 가 아닐 때의 프로세스 그룹). pid 로 끈다.
    Pid(u32),
}

impl ProcessTree {
    /// 방금 띄운 자식을 트리 끄개에 묶는다. 묶기에 실패해도 끌 방법(pid)은 남긴다.
    pub fn attach(child: &Child) -> Self {
        let pid = child.id();
        #[cfg(windows)]
        {
            match windows_job::Job::create_and_assign(child) {
                Ok(job) => {
                    return Self {
                        inner: Inner::Job(job),
                    };
                }
                Err(err) => {
                    log::warn!(
                        "could not put pid {pid} in a job object ({err}); falling back to taskkill"
                    );
                }
            }
        }
        Self {
            inner: Inner::Pid(pid),
            #[cfg(unix)]
            watchdog: watchdog::spawn(std::process::id(), pid),
        }
    }

    /// 자식과 그 밑 프로세스를 모두 강제로 끈다. 이미 없으면 아무 일도 없다.
    pub fn kill(&self) {
        match &self.inner {
            #[cfg(windows)]
            Inner::Job(job) => job.terminate(),
            Inner::Pid(pid) => kill_by_pid(*pid),
        }
    }

    /// 이 트리가 Job Object 로 묶였는가 (시험용).
    pub fn is_job(&self) -> bool {
        match &self.inner {
            #[cfg(windows)]
            Inner::Job(_) => true,
            Inner::Pid(_) => false,
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // 감시 프로세스를 치운다 (끝낸 뒤 거두지 않으면 좀비로 남는다). 자식 그룹은 건드리지 않는다 — 끄는 일은 `kill` 이 한다.
        #[cfg(unix)]
        if let Some(mut watchdog) = self.watchdog.take() {
            let _ = watchdog.kill();
            let _ = watchdog.wait();
        }
    }
}

/// 새로 만들 자식이 자기 프로세스 그룹을 갖게 한다 (Windows 에서는 아무 일도 안 한다).
pub fn prepare_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    {
        let _ = command;
    }
}

#[cfg(windows)]
fn kill_by_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 고정된 명령 · 고정된 인자 (pid 숫자만 바뀐다).
    let result = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    if let Err(err) = result {
        log::warn!("taskkill failed to start for pid {pid}: {err}");
    }
}

#[cfg(unix)]
fn kill_by_pid(pid: u32) {
    // 자식은 `prepare_command` 로 자기 그룹의 우두머리(pgid == pid)다.
    let Ok(pgid) = i32::try_from(pid) else {
        log::warn!("pid {pid} does not fit in pid_t");
        return;
    };
    // SAFETY: 숫자 하나를 넘기는 시스템 호출이다. 이미 없는 그룹이면 ESRCH 오류만 돌아온다.
    let rc = unsafe { libc::killpg(pgid, libc::SIGKILL) };
    if rc != 0 {
        log::debug!("killpg({pgid}) returned {rc} (already gone?)");
    }
}

/// macOS · Linux: 앱이 비정상으로 끝나도(죽음 · 강제 종료 · 패닉 중단) 자식 트리가 남지 않게 하는 감시 프로세스.
///
/// 운영체제에 "부모가 죽으면 자식 그룹을 같이 끄라" 는 부탁은 없다 (Windows 의 Job Object 같은 것이 없다):
/// - Linux 의 `PR_SET_PDEATHSIG` 는 자식 **하나**만 끄고 (그 아래 bash · 개발 서버 · git 은 남는다), 또 부모 **프로세스**가 아니라 자식을 낳은 **스레드**가
///   끝날 때 신호가 간다 — 우리는 자식을 블로킹 풀의 스레드에서 낳고 그 스레드는 놀면 사라지므로 살아 있는 세션이 갑자기 죽는다. 그래서 쓰지 않는다.
/// - macOS 에는 그런 부탁 자체가 없다. kqueue `NOTE_EXIT` 는 감시할 프로세스가 우리 코드여야 하는데 자식은 남의 `claude` 다.
///
/// 그래서 자식마다 가벼운 `sh` 하나를 **자기 그룹으로** 띄운다 (자식 그룹과 달라서 `killpg` 에 같이 죽지 않는다). 1초마다 앱과 자식이 살았는지 보다가:
/// - 앱이 사라졌으면 자식 그룹(`-<자식 pid>`)에 SIGKILL 을 보내고 끝난다 — 그 아래 손자까지 같은 그룹이면 함께 꺼진다.
/// - 자식이 먼저 끝났으면(앱은 살아 있음) 그냥 끝난다 (남은 손자는 앱이 `kill()` 로 끈다).
///
/// 표준 입출력은 모두 닫는다 (자식의 출력 파이프를 쥐고 있지 않게). 한도: 앱이 죽은 뒤 최대 약 1초 뒤에 꺼지고, `setsid` 로 그룹을 떠난 손자는 못 끈다 (지금도 `killpg` 가 못 끈다).
/// 의존성을 더하지 않는다 (`/bin/sh` 만 쓴다 — 없으면 경고만 남기고 감시 없이 간다).
#[cfg(unix)]
mod watchdog {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};

    use tauri_plugin_log::log;

    /// `$1` = 앱 pid, `$2` = 자식(그룹 우두머리) pid. `kill -0` 은 신호를 보내지 않고 살아 있는지만 본다.
    pub(super) const SCRIPT: &str = r#"
while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 1; done
if ! kill -0 "$1" 2>/dev/null; then kill -9 "-$2" 2>/dev/null; fi
exit 0
"#;

    /// 앱(`app_pid`)이 사라지면 `leader_pid` 가 우두머리인 그룹을 끄는 감시를 띄운다. 못 띄우면 `None` (경고).
    pub(super) fn spawn(app_pid: u32, leader_pid: u32) -> Option<Child> {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(SCRIPT)
            .arg("nyanitor-watchdog")
            .arg(app_pid.to_string())
            .arg(leader_pid.to_string())
            // 고정 PATH — 감시가 부르는 `sleep` 을 환경의 PATH 로 바꿔치지 못하게
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // 자기 그룹 — 자식 그룹을 끌 때 같이 죽지 않는다
            .process_group(0);
        match command.spawn() {
            Ok(child) => Some(child),
            Err(err) => {
                log::warn!(
                    "could not start the watchdog for pid {leader_pid} ({err}); the child may outlive an app crash"
                );
                None
            }
        }
    }
}

#[cfg(windows)]
mod windows_job {
    use std::io;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject,
    };

    /// Job Object 핸들. 핸들은 상속되지 않게 만든다 (자식이 쥐고 있으면 앱이 죽어도 안 닫힌다).
    pub struct Job(HANDLE);

    // SAFETY: Job 핸들은 어느 스레드에서 써도 되는 커널 객체 핸들이다 (값만 옮긴다).
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn create_and_assign(child: &Child) -> io::Result<Self> {
            // SAFETY: 이름 · 보안 속성 없이 새 Job 을 만든다. 실패하면 null 이 돌아온다.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(handle); // 이 뒤로는 실패해도 Drop 이 핸들을 닫는다

            // SAFETY: 0 으로 채운 구조체에 한 가지 플래그만 켜서 크기와 함께 넘긴다.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    std::ptr::from_ref(&info).cast(),
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }

            // SAFETY: `child` 가 살아 있는 동안 그 프로세스 핸들은 유효하다.
            let ok = unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle()) };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }

        pub fn terminate(&self) {
            // SAFETY: 유효한 Job 핸들. 이미 비어 있어도 오류 없이 끝난다.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // 마지막 핸들이 닫히면 KILL_ON_JOB_CLOSE 로 남은 프로세스가 꺼진다.
            // SAFETY: 이 핸들은 이 구조체만 갖고 있고 한 번만 닫는다.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// macOS · Linux 에서만 돈다 (이 PC 는 Windows 라 P11 의 CI 에서 처음 돈다 — 스크립트 글은 Git Bash 의 `sh` 로 따로 읽어 확인했다).
#[cfg(all(test, unix))]
mod unix_tests {
    use super::*;
    use std::fs;
    use std::os::unix::process::CommandExt;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    use crate::claude::test_util::TempDir;

    /// 살아 있는 프로세스인가 (끝났지만 거두지 않은 좀비는 아니다 — 컨테이너의 1번 프로세스가 거두지 않아도 흔들리지 않게)
    fn running(pid: u32) -> bool {
        // SAFETY: 신호 0 은 보내지 않고 있는지만 본다.
        let exists = unsafe { libc::kill(pid as i32, 0) } == 0;
        if !exists {
            return false;
        }
        match Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
        {
            Ok(out) if out.status.success() => {
                let stat = String::from_utf8_lossy(&out.stdout);
                let stat = stat.trim();
                !stat.is_empty() && !stat.starts_with('Z')
            }
            // `ps` 가 없으면 신호 0 의 답을 믿는다
            _ => true,
        }
    }

    fn wait_until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if done() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("timed out waiting for {what}");
    }

    /// 시험이 띄운 것들을 끝에 정리한다 (시험이 실패해도 `sleep 60` 이 남지 않게)
    struct Cleanup(Vec<u32>);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            for pid in &self.0 {
                // SAFETY: 숫자 하나를 넘기는 시스템 호출이다. 없으면 오류만 돌아온다.
                unsafe {
                    libc::kill(*pid as i32, libc::SIGKILL);
                    libc::kill(-(*pid as i32), libc::SIGKILL);
                }
            }
        }
    }

    /// 자기 그룹의 우두머리 `sh` 와 그 밑 손자 `sleep 60` (손자 pid 는 파일에 적힌다)
    fn spawn_group(dir: &Path) -> (Child, u32) {
        let pidfile = dir.join("grandchild.pid");
        let leader = Command::new("sh")
            .arg("-c")
            .arg("sleep 60 & echo $! > \"$1\"; wait")
            .arg("leader")
            .arg(&pidfile)
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        wait_until("the grandchild pid", Duration::from_secs(5), || {
            fs::read_to_string(&pidfile).is_ok_and(|text| text.trim().parse::<u32>().is_ok())
        });
        let grandchild = fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        (leader, grandchild)
    }

    fn stand_in_for_the_app() -> Child {
        Command::new("sleep")
            .arg("60")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    #[test]
    fn the_watchdog_kills_the_whole_group_when_the_app_is_gone() {
        let dir = TempDir::new("watchdog-kill");
        let mut app = stand_in_for_the_app();
        let (mut leader, grandchild) = spawn_group(&dir);
        let _cleanup = Cleanup(vec![app.id(), leader.id(), grandchild]);
        let mut watch = watchdog::spawn(app.id(), leader.id()).expect("the watchdog starts");

        // 앱이 살아 있는 동안에는 아무것도 끄지 않는다
        std::thread::sleep(Duration::from_millis(2500));
        assert!(leader.try_wait().unwrap().is_none(), "the child died early");
        assert!(running(grandchild), "the grandchild died early");

        // 앱이 죽었다 — 우두머리와 손자가 모두 꺼진다
        app.kill().unwrap();
        app.wait().unwrap();
        wait_until("the leader to be killed", Duration::from_secs(8), || {
            leader.try_wait().unwrap().is_some()
        });
        wait_until(
            "the grandchild to be killed",
            Duration::from_secs(8),
            || !running(grandchild),
        );
        // 감시도 할 일을 마치고 스스로 끝난다
        wait_until("the watchdog to end", Duration::from_secs(8), || {
            watch.try_wait().unwrap().is_some()
        });
    }

    #[test]
    fn the_watchdog_ends_quietly_when_the_child_ends_first_and_the_app_lives() {
        let mut app = stand_in_for_the_app();
        let mut leader = Command::new("sleep")
            .arg("1")
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let _cleanup = Cleanup(vec![app.id(), leader.id()]);
        let mut watch = watchdog::spawn(app.id(), leader.id()).expect("the watchdog starts");
        leader.wait().unwrap();
        wait_until("the watchdog to end", Duration::from_secs(8), || {
            watch.try_wait().unwrap().is_some()
        });
        assert!(
            app.try_wait().unwrap().is_none(),
            "the app stand-in must not be touched"
        );
        app.kill().unwrap();
        app.wait().unwrap();
    }

    #[test]
    fn a_process_tree_owns_a_watchdog_and_clears_it_when_dropped() {
        let dir = TempDir::new("watchdog-owned");
        let (mut leader, grandchild) = spawn_group(&dir);
        let _cleanup = Cleanup(vec![leader.id(), grandchild]);
        let tree = ProcessTree::attach(&leader);
        let watch_pid = tree.watchdog.as_ref().expect("a watchdog is attached").id();
        assert!(running(watch_pid));
        // 정상 끝내기 — 그룹은 `kill()` 이 끈다
        tree.kill();
        wait_until("the leader to be killed", Duration::from_secs(5), || {
            leader.try_wait().unwrap().is_some()
        });
        wait_until(
            "the grandchild to be killed",
            Duration::from_secs(5),
            || !running(grandchild),
        );
        // 버리면 감시가 치워진다 (거두어져 좀비도 남지 않는다)
        drop(tree);
        assert!(!running(watch_pid));
    }

    #[test]
    fn the_watchdog_script_uses_only_posix_builtins_and_sleep() {
        // 환경을 바꿔치는 길이 없다: 고정 PATH 에서 `sleep` 하나만 부른다
        assert!(watchdog::SCRIPT.contains("kill -0"));
        // 음수 pid 앞에 `--` 를 두지 않는다: Ubuntu 의 `/bin/sh`(dash) 는 `kill -9 -- -N` 을 "Illegal number" 로 거절해 그룹이 꺼지지 않는다
        assert!(watchdog::SCRIPT.contains("kill -9 \"-$2\""));
        assert!(!watchdog::SCRIPT.contains("-- "));
        assert_eq!(watchdog::SCRIPT.matches("sleep").count(), 1);
    }
}
