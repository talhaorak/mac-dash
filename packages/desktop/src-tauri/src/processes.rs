//! Process list, detail and kill. Shapes mirror `server/core/process-manager.ts`
//! and `GET /api/processes` in `server/routes/processes.ts`.

use serde::Serialize;
use std::collections::HashMap;
use std::ffi::CStr;
use std::sync::{LazyLock, Mutex};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 5000;
const MAX_CHAIN_DEPTH: usize = 64;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub cpu: f32,
    pub mem: f64,
    /// Resident memory in KB, like the `rss` column of `ps`.
    pub rss: u64,
    pub elapsed: String,
    pub command: String,
    pub path: String,
    pub args: String,
    pub user: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessList {
    pub processes: Vec<ProcessInfo>,
    /// All processes.
    pub total: usize,
    /// Processes that match the search, before the limit.
    pub filtered: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessChainEntry {
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub command: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProcessDetail {
    #[serde(flatten)]
    pub info: ProcessInfo,
    pub cwd: Option<String>,
    pub parent_chain: Vec<ProcessChainEntry>,
}

static PROC_SYS: LazyLock<Mutex<System>> = LazyLock::new(|| {
    let mut sys = System::new();
    sys.refresh_memory();
    refresh(&mut sys);
    Mutex::new(sys)
});

static USER_NAMES: LazyLock<Mutex<HashMap<u32, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn refresh(sys: &mut System) {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cpu()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_user(UpdateKind::OnlyIfNotSet),
    );
}

fn lookup_user_name(uid: u32) -> Option<String> {
    let mut passwd = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut buffer = vec![0 as libc::c_char; 4096];
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the whole call and the buffer length is the real one.
    let status = unsafe { libc::getpwuid_r(uid, passwd.as_mut_ptr(), buffer.as_mut_ptr(), buffer.len(), &mut found) };
    if status != 0 || found.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_name points to a NUL-terminated string inside `buffer`.
    let name = unsafe { CStr::from_ptr((*found).pw_name) };
    Some(name.to_string_lossy().into_owned())
}

fn user_name(uid: u32) -> String {
    let mut names = USER_NAMES.lock().unwrap_or_else(|e| e.into_inner());
    names.entry(uid).or_insert_with(|| lookup_user_name(uid).unwrap_or_else(|| uid.to_string())).clone()
}

/// `[[dd-]hh:]mm:ss`, like the `etime` column of `ps`.
fn format_elapsed(secs: u64) -> String {
    let (days, hours, mins, s) = (secs / 86400, (secs % 86400) / 3600, (secs % 3600) / 60, secs % 60);
    if days > 0 {
        format!("{}-{:02}:{:02}:{:02}", days, hours, mins, s)
    } else if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, mins, s)
    } else {
        format!("{:02}:{:02}", mins, s)
    }
}

fn to_info(p: &sysinfo::Process, total_mem: u64) -> ProcessInfo {
    let uid = p.user_id().map(|u| **u).unwrap_or(0);
    let rss_bytes = p.memory();
    let mem_pct = if total_mem > 0 { rss_bytes as f64 / total_mem as f64 * 100.0 } else { 0.0 };
    ProcessInfo {
        pid: p.pid().as_u32(),
        ppid: p.parent().map(|pp| pp.as_u32()).unwrap_or(0),
        uid,
        cpu: (p.cpu_usage() * 10.0).round() / 10.0,
        mem: (mem_pct * 10.0).round() / 10.0,
        rss: rss_bytes / 1024,
        elapsed: format_elapsed(p.run_time()),
        command: p.name().to_string_lossy().into_owned(),
        path: p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default(),
        args: p.cmd().iter().map(|s| s.to_string_lossy()).collect::<Vec<_>>().join(" "),
        user: user_name(uid),
    }
}

fn snapshot() -> Vec<ProcessInfo> {
    let mut sys = PROC_SYS.lock().unwrap_or_else(|e| e.into_inner());
    refresh(&mut sys);
    let total_mem = sys.total_memory();
    sys.processes().values().map(|p| to_info(p, total_mem)).collect()
}

fn by_cpu(a: &ProcessInfo, b: &ProcessInfo) -> std::cmp::Ordering {
    b.cpu.total_cmp(&a.cpu)
}

/// Search, sort and limit. Pure, so that it can be tested without a process table.
fn select(mut all: Vec<ProcessInfo>, sort: Option<&str>, limit: Option<i64>, search: Option<&str>) -> ProcessList {
    let total = all.len();
    all.sort_by(by_cpu); // order of `listProcesses()`, kept for an unknown sort key

    if let Some(query) = search.map(str::to_lowercase).filter(|q| !q.is_empty()) {
        all.retain(|p| {
            p.command.to_lowercase().contains(&query)
                || p.args.to_lowercase().contains(&query)
                || p.path.to_lowercase().contains(&query)
                || p.pid.to_string().contains(&query)
        });
    }

    match sort.filter(|s| !s.is_empty()).unwrap_or("cpu") {
        "mem" => all.sort_by(|a, b| b.mem.total_cmp(&a.mem)),
        "pid" => all.sort_by_key(|p| p.pid),
        "name" => all.sort_by_cached_key(|p| (p.command.to_lowercase(), p.command.clone())),
        _ => {}
    }

    let filtered = all.len();
    let limit = match limit {
        Some(n) if n > 0 => usize::try_from(n).unwrap_or(MAX_LIMIT).min(MAX_LIMIT),
        _ => DEFAULT_LIMIT,
    };
    all.truncate(limit);
    ProcessList { processes: all, total, filtered }
}

/// Like `GET /api/processes`: default sort is cpu descending, default limit is 200.
pub fn list_processes(sort: Option<&str>, limit: Option<i64>, search: Option<&str>) -> ProcessList {
    select(snapshot(), sort, limit, search)
}

/// The process, its parent, and so on, up to but without launchd (pid 1).
fn parent_chain(start: u32, links: &HashMap<u32, ProcessChainEntry>) -> Vec<ProcessChainEntry> {
    let mut chain = Vec::new();
    let mut current = start;
    while current > 1 && chain.len() < MAX_CHAIN_DEPTH {
        let Some(entry) = links.get(&current) else {
            break;
        };
        chain.push(entry.clone());
        if entry.ppid == current || entry.ppid == 0 {
            break;
        }
        current = entry.ppid;
    }
    chain
}

/// `lsof -a -p <pid> -d cwd -Fn`
fn cwd_from_lsof(pid: u32) -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| line.strip_prefix('n').filter(|path| !path.is_empty()).map(str::to_string))
}

pub fn get_process_detail(pid: u32) -> Option<ProcessDetail> {
    let (info, parent_chain, cwd) = {
        let mut sys = PROC_SYS.lock().unwrap_or_else(|e| e.into_inner());
        refresh(&mut sys);
        let target = Pid::from_u32(pid);
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[target]),
            false,
            ProcessRefreshKind::nothing().with_cwd(UpdateKind::Always),
        );
        let total_mem = sys.total_memory();
        let process = sys.process(target)?;
        let links: HashMap<u32, ProcessChainEntry> = sys
            .processes()
            .values()
            .map(|p| {
                let entry = ProcessChainEntry {
                    pid: p.pid().as_u32(),
                    ppid: p.parent().map(|pp| pp.as_u32()).unwrap_or(0),
                    user: user_name(p.user_id().map(|u| **u).unwrap_or(0)),
                    command: p.name().to_string_lossy().into_owned(),
                };
                (entry.pid, entry)
            })
            .collect();
        (
            to_info(process, total_mem),
            parent_chain(pid, &links),
            process.cwd().map(|c| c.to_string_lossy().into_owned()).filter(|c| !c.is_empty()),
        )
    };
    // lsof runs without the lock: it can take a moment.
    let cwd = cwd.or_else(|| cwd_from_lsof(pid));
    Some(ProcessDetail { info, cwd, parent_chain })
}

/// Refuse PIDs that must never be signalled from the dashboard:
/// the kernel (0), launchd (1) and this app.
fn check_kill_target(pid: u32, own_pid: u32) -> Result<libc::pid_t, String> {
    let target = libc::pid_t::try_from(pid).ok().filter(|p| *p > 0).ok_or("Invalid PID")?;
    if pid == 1 {
        return Err("Refusing to kill PID 1 (launchd)".to_string());
    }
    if pid == own_pid {
        return Err(format!("Refusing to kill PID {}: it is mac-dash itself", pid));
    }
    Ok(target)
}

pub fn kill_process(pid: u32, force: bool) -> Result<(), String> {
    let target = check_kill_target(pid, std::process::id())?;
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: kill has no memory preconditions. `target` is a positive pid, so no group is signalled.
    if unsafe { libc::kill(target, signal) } == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    Err(match error.raw_os_error() {
        Some(libc::EPERM) => format!("Cannot kill PID {}: the process belongs to another user or to root", pid),
        Some(libc::ESRCH) => format!("Cannot kill PID {}: no such process", pid),
        _ => format!("Failed to kill PID {}: {}", pid, error),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(pid: u32, command: &str, cpu: f32, mem: f64) -> ProcessInfo {
        ProcessInfo {
            pid,
            ppid: 1,
            uid: 501,
            cpu,
            mem,
            rss: 0,
            elapsed: "00:01".into(),
            command: command.into(),
            path: format!("/usr/bin/{}", command),
            args: format!("/usr/bin/{} --flag", command),
            user: "me".into(),
        }
    }

    fn sample() -> Vec<ProcessInfo> {
        vec![proc(30, "zsh", 1.0, 5.0), proc(10, "Safari", 9.0, 1.0), proc(20, "bun", 4.0, 9.0)]
    }

    fn pids(list: &ProcessList) -> Vec<u32> {
        list.processes.iter().map(|p| p.pid).collect()
    }

    #[test]
    fn default_is_cpu_descending() {
        let list = select(sample(), None, None, None);
        assert_eq!(pids(&list), vec![10, 20, 30]);
        assert_eq!((list.total, list.filtered), (3, 3));
    }

    #[test]
    fn sort_keys() {
        assert_eq!(pids(&select(sample(), Some("mem"), None, None)), vec![20, 30, 10]);
        assert_eq!(pids(&select(sample(), Some("pid"), None, None)), vec![10, 20, 30]);
        assert_eq!(pids(&select(sample(), Some("name"), None, None)), vec![20, 10, 30]);
        assert_eq!(pids(&select(sample(), Some("bogus"), None, None)), vec![10, 20, 30]);
    }

    #[test]
    fn search_and_limit() {
        let list = select(sample(), None, Some(1), Some("0"));
        assert_eq!(pids(&list), vec![10]); // every pid contains "0", Safari uses the most cpu
        assert_eq!((list.total, list.filtered), (3, 3));
        let list = select(sample(), None, None, Some("SAF"));
        assert_eq!(pids(&list), vec![10]);
        assert_eq!((list.total, list.filtered), (3, 1));
        assert_eq!(pids(&select(sample(), None, None, Some("20"))), vec![20]);
        assert_eq!(select(sample(), None, Some(0), None).processes.len(), 3);
        assert_eq!(select(sample(), None, Some(-4), None).processes.len(), 3);
        assert_eq!(select(sample(), None, Some(2), None).processes.len(), 2);
    }

    #[test]
    fn chain_walks_up_to_launchd() {
        let entry = |pid, ppid| (pid, ProcessChainEntry { pid, ppid, user: "me".into(), command: format!("p{}", pid) });
        let links: HashMap<u32, ProcessChainEntry> = [entry(1, 0), entry(100, 1), entry(200, 100), entry(300, 200)].into();
        let chain = parent_chain(300, &links);
        assert_eq!(chain.iter().map(|e| e.pid).collect::<Vec<_>>(), vec![300, 200, 100]);
        assert!(parent_chain(999, &links).is_empty());
        assert!(parent_chain(1, &links).is_empty());

        let looped: HashMap<u32, ProcessChainEntry> = [entry(5, 6), entry(6, 5)].into();
        assert_eq!(parent_chain(5, &looped).len(), MAX_CHAIN_DEPTH);
    }

    #[test]
    fn protected_pids() {
        assert!(check_kill_target(0, 4242).is_err());
        assert!(check_kill_target(1, 4242).is_err());
        assert!(check_kill_target(4242, 4242).is_err());
        assert!(check_kill_target(u32::MAX, 4242).is_err());
        assert_eq!(check_kill_target(4243, 4242), Ok(4243));
    }

    /// Read-only check against the real process table: `cargo test -- --ignored live`.
    #[test]
    #[ignore]
    fn live_process_detail() {
        let list = list_processes(None, Some(5), None);
        assert_eq!(list.processes.len(), 5);
        assert!(list.total > 50);

        let me = std::process::id();
        let detail = get_process_detail(me).expect("own process");
        println!("{}", serde_json::to_string_pretty(&detail).unwrap());
        assert_eq!(detail.info.pid, me);
        assert!(detail.info.rss > 0);
        assert!(!detail.info.args.is_empty());
        assert_ne!(detail.info.user, detail.info.uid.to_string());
        assert!(detail.cwd.is_some());
        assert_eq!(detail.parent_chain[0].pid, me);
        assert!(detail.parent_chain.len() > 1);
        assert!(get_process_detail(u32::MAX - 1).is_none());
    }

    #[test]
    fn elapsed_format() {
        assert_eq!(format_elapsed(59), "00:59");
        assert_eq!(format_elapsed(3_661), "01:01:01");
        assert_eq!(format_elapsed(90_061), "1-01:01:01");
    }
}
