use serde::Serialize;
use sysinfo::{ProcessesToUpdate, ProcessRefreshKind, System};
use std::sync::Mutex;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub cpu: f32,
    pub mem: f64,
    pub rss: u64, // bytes
    pub elapsed: String,
    pub command: String,
    pub path: String,
    pub args: String,
    pub user: String,
}

static PROC_SYS: std::sync::LazyLock<Mutex<System>> = std::sync::LazyLock::new(|| {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    Mutex::new(sys)
});

pub fn list_processes() -> Vec<ProcessInfo> {
    let mut sys = PROC_SYS.lock().unwrap();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let total_mem = sys.total_memory();

    let mut procs: Vec<ProcessInfo> = sys.processes().values().map(|p| {
        let pid = p.pid().as_u32();
        let ppid = p.parent().map(|pp| pp.as_u32()).unwrap_or(0);
        let uid = p.user_id().map(|u| **u).unwrap_or(0);
        let rss = p.memory();
        let mem_pct = if total_mem > 0 { (rss as f64 / total_mem as f64) * 100.0 } else { 0.0 };
        let cmd_path = p.exe().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        let name = p.name().to_string_lossy().to_string();
        let args = p.cmd().iter().map(|s| s.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ");

        ProcessInfo {
            pid, ppid, uid,
            cpu: p.cpu_usage(),
            mem: (mem_pct * 10.0).round() / 10.0,
            rss,
            elapsed: format_elapsed(p.run_time()),
            command: name,
            path: cmd_path,
            args,
            user: format!("{}", uid),
        }
    }).collect();

    procs.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    procs
}

pub fn kill_process(pid: u32, force: bool) -> Result<(), String> {
    let output = std::process::Command::new("kill")
        .arg(if force { "-9" } else { "-15" })
        .arg(pid.to_string())
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(err)
    } else {
        Ok(())
    }
}

fn format_elapsed(secs: u64) -> String {
    let hours = secs / 3600;
    let mins = (secs % 3600) / 60;
    let s = secs % 60;
    if hours > 0 {
        format!("{:02}:{:02}:{:02}", hours, mins, s)
    } else {
        format!("{:02}:{:02}", mins, s)
    }
}
