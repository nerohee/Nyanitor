//! 자식 프로세스 트리를 한꺼번에 끄는 도구.
//!
//! 이유: Windows 에서 `claude` 하나만 죽이면 claude 가 시킨 `bash` · `node` 가 남는다
//! (`notes/P3-01-cli-protocol.md` §4-6 함정 2).
//! - Windows: Job Object (`KILL_ON_JOB_CLOSE`). 앱이 비정상 종료해도 OS 가 핸들을 닫으면서 트리가 꺼진다.
//!   Job 에 넣지 못하면 `taskkill /T /F` 로 대신한다 (앱이 죽을 때 자식이 남을 수 있음 — 경고를 남긴다).
//! - 그 밖(macOS · Linux): 프로세스 그룹을 새로 만들고 그룹 전체에 SIGKILL.
//!
//! 이 파일 밖에서는 `unsafe` 를 쓰지 않는다.

use std::process::{Child, Command};

use tauri_plugin_log::log;

/// 만든 자식 프로세스에 붙이는 "트리 끄개". 버리면(Drop) Windows 는 Job 핸들이 닫혀 남은 프로세스가 꺼진다.
pub struct ProcessTree {
    inner: Inner,
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
