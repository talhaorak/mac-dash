use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

const LOG: &str = "/usr/bin/log";
/// Wait this long before a stream that ended by itself is started again.
const RESTART_DELAY: Duration = Duration::from_secs(5);
const MAX_QUERY_MINUTES: u32 = 24 * 60;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub process: String,
    pub pid: Option<i32>,
    pub message: String,
    pub subsystem: Option<String>,
    pub category: Option<String>,
}

static LOG_BUFFER: std::sync::LazyLock<Mutex<Vec<LogEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// State of the `log stream` child process.
/// The stream runs while the client wants it and the main window is visible.
struct StreamControl {
    /// The client asked for the stream (`start_log_stream`) and did not stop it.
    wanted: bool,
    /// The main window is hidden. Nobody reads the buffer, so the child does not run.
    paused: bool,
    /// Present while a stream task runs. Sending (or dropping) it ends the task.
    stop: Option<oneshot::Sender<()>>,
    /// pid of the running child, for the synchronous kill at app exit.
    child_pid: Option<u32>,
    /// Identifies the running task, so that an old task never clears the state of a new one.
    generation: u64,
}

static STREAM: Mutex<StreamControl> =
    Mutex::new(StreamControl { wanted: false, paused: false, stop: None, child_pid: None, generation: 0 });

fn stream() -> std::sync::MutexGuard<'static, StreamControl> {
    STREAM.lock().unwrap_or_else(|e| e.into_inner())
}

const MAX_BUFFER: usize = 1000;

fn parse_log_level(level: &str) -> &'static str {
    let l = level.to_lowercase();
    if l.contains("error") || l.contains("fault") { "error" }
    else if l.contains("warn") { "warning" }
    else if l.contains("info") || l.contains("notice") { "info" }
    else if l.contains("debug") { "debug" }
    else { "default" }
}

fn parse_compact_line(line: &str) -> Option<LogEntry> {
    // Try JSON first
    if line.starts_with('{') {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(line) {
            return Some(LogEntry {
                timestamp: val["timestamp"].as_str().unwrap_or("").to_string(),
                level: parse_log_level(val["messageType"].as_str().unwrap_or("default")).to_string(),
                process: val["processImagePath"].as_str()
                    .and_then(|p| p.rsplit('/').next())
                    .or(val["process"].as_str())
                    .unwrap_or("unknown").to_string(),
                pid: val["processID"].as_i64().map(|v| v as i32),
                message: val["eventMessage"].as_str().or(val["message"].as_str()).unwrap_or("").to_string(),
                subsystem: val["subsystem"].as_str().map(|s| s.to_string()),
                category: val["category"].as_str().map(|s| s.to_string()),
            });
        }
    }

    // Compact format: "2024-01-01 12:00:00.000000+0300 hostname process[pid] <level> message"
    // Simple regex-like parsing
    let line = line.trim();
    if line.is_empty() { return None; }

    // Try to find the pattern: timestamp hostname process[pid]
    let parts: Vec<&str> = line.splitn(4, ' ').collect();
    if parts.len() >= 4 {
        // Check if this looks like a timestamp
        if parts[0].len() >= 10 && parts[0].contains('-') {
            let timestamp = format!("{} {}", parts[0], parts[1]);
            let rest = &line[parts[0].len() + parts[1].len() + parts[2].len() + 3..];

            // Parse process[pid]
            if let Some(bracket_pos) = rest.find('[') {
                // Search after the opening bracket: a "]" before it would make the slice below panic.
                if let Some(close_pos) = rest[bracket_pos..].find(']').map(|at| bracket_pos + at) {
                    let process = &rest[..bracket_pos];
                    let pid: Option<i32> = rest[bracket_pos+1..close_pos].parse().ok();
                    let message = rest[close_pos+1..].trim().to_string();

                    return Some(LogEntry {
                        timestamp,
                        level: "default".to_string(),
                        process: process.to_string(),
                        pid,
                        message,
                        subsystem: None,
                        category: None,
                    });
                }
            }
        }
    }

    // Fallback
    Some(LogEntry {
        timestamp: chrono::Local::now().to_rfc3339(),
        level: "default".to_string(),
        process: "system".to_string(),
        pid: None,
        message: line.to_string(),
        subsystem: None,
        category: None,
    })
}

fn push_entry(entry: LogEntry) {
    let mut buf = LOG_BUFFER.lock().unwrap_or_else(|e| e.into_inner());
    buf.push(entry);
    if buf.len() > MAX_BUFFER {
        let drain = buf.len() - MAX_BUFFER;
        buf.drain(..drain);
    }
}

/// Spawn the child and its reader task when the stream should run and does not.
fn ensure_running(control: &mut StreamControl) {
    if !control.wanted || control.paused || control.stop.is_some() {
        return;
    }
    let (stop_tx, stop_rx) = oneshot::channel();
    control.stop = Some(stop_tx);
    control.generation += 1;
    let generation = control.generation;
    tauri::async_runtime::spawn(run_stream(generation, stop_rx));
}

async fn run_stream(generation: u64, mut stop: oneshot::Receiver<()>) {
    let spawned = Command::new(LOG)
        .args(["stream", "--style", "compact", "--level", "info"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn();

    let mut stopped_on_request = false;
    if let Ok(mut child) = spawned {
        {
            let mut control = stream();
            if control.generation == generation {
                control.child_pid = child.id();
            }
        }
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout);
            let mut line = Vec::new();
            loop {
                line.clear();
                tokio::select! {
                    _ = &mut stop => {
                        stopped_on_request = true;
                        break;
                    }
                    // Bytes, not `lines()`: one message with invalid UTF-8 must not end the stream.
                    read = reader.read_until(b'\n', &mut line) => match read {
                        Ok(n) if n > 0 => {
                            if let Some(entry) = parse_compact_line(String::from_utf8_lossy(&line).trim_end()) {
                                push_entry(entry);
                            }
                        }
                        // EOF or a read error: the child ended by itself.
                        _ => break,
                    },
                }
            }
        }
        // Forget the pid before the child is reaped, so that `shutdown()` never signals a reused pid.
        {
            let mut control = stream();
            if control.generation == generation {
                control.child_pid = None;
            }
        }
        let _ = child.kill().await; // kills when still alive, and reaps
    }

    // Reset the state, so that the stream can start again.
    {
        let mut control = stream();
        if control.generation == generation {
            control.stop = None;
            control.child_pid = None;
        }
    }
    if !stopped_on_request {
        // Unexpected exit (or `log` could not start). Try again later, when it is still wanted.
        tokio::time::sleep(RESTART_DELAY).await;
        ensure_running(&mut stream());
    }
}

fn stop_child(control: &mut StreamControl) {
    if let Some(stop) = control.stop.take() {
        let _ = stop.send(());
    }
}

pub fn start_log_stream() {
    let mut control = stream();
    control.wanted = true;
    ensure_running(&mut control);
}

pub fn stop_log_stream() {
    let mut control = stream();
    control.wanted = false;
    stop_child(&mut control);
}

/// The main window was hidden: nobody reads the log buffer.
pub fn pause_log_stream() {
    let mut control = stream();
    control.paused = true;
    stop_child(&mut control);
}

/// The main window is visible again.
pub fn resume_log_stream() {
    let mut control = stream();
    control.paused = false;
    ensure_running(&mut control);
}

/// App exit. The async runtime may not run the stream task again, so the child is killed here.
pub fn shutdown() {
    let mut control = stream();
    control.wanted = false;
    stop_child(&mut control);
    if let Some(pid) = control.child_pid.take().and_then(|pid| libc::pid_t::try_from(pid).ok()) {
        // SAFETY: kill has no memory preconditions. The pid belongs to a child that was not reaped yet.
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
}

pub fn get_recent_logs(count: usize) -> Vec<LogEntry> {
    let buf = LOG_BUFFER.lock().unwrap_or_else(|e| e.into_inner());
    let start = buf.len().saturating_sub(count);
    buf[start..].to_vec()
}

pub async fn query_logs(last_minutes: u32, predicate: Option<&str>) -> Vec<LogEntry> {
    let mut args = vec![
        LOG.to_string(), "show".to_string(),
        "--last".to_string(), format!("{}m", last_minutes.clamp(1, MAX_QUERY_MINUTES)),
        "--style".to_string(), "compact".to_string(),
    ];
    if let Some(pred) = predicate {
        args.push("--predicate".to_string());
        args.push(pred.to_string());
    }

    let output = Command::new(&args[0])
        .args(&args[1..])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await;

    match output {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout);
            text.lines()
                .filter_map(parse_compact_line)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .take(500)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect()
        }
        Err(_) => Vec::new(),
    }
}

pub fn get_active_log_processes() -> Vec<(String, usize, String)> {
    let buf = LOG_BUFFER.lock().unwrap_or_else(|e| e.into_inner());
    let mut counts: std::collections::HashMap<String, (usize, String)> = std::collections::HashMap::new();

    for entry in buf.iter() {
        let e = counts.entry(entry.process.clone()).or_insert((0, String::new()));
        e.0 += 1;
        if entry.timestamp > e.1 {
            e.1 = entry.timestamp.clone();
        }
    }

    let mut result: Vec<_> = counts.into_iter()
        .map(|(name, (count, last_seen))| (name, count, last_seen))
        .collect();
    result.sort_by(|a, b| b.1.cmp(&a.1));
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_lines() {
        let entry = parse_compact_line("2026-09-21 10:00:00.123456+0300 host kernel[0] something happened").unwrap();
        assert_eq!(entry.process, "kernel");
        assert_eq!(entry.pid, Some(0));
        assert_eq!(entry.message, "something happened");

        // A closing bracket before the opening one must not panic (release builds abort on panic).
        let odd = parse_compact_line("2026-09-21 10:00:00.123456+0300 host we]ird[12] text").unwrap();
        assert_eq!(odd.pid, Some(12));
        assert!(parse_compact_line("2026-09-21 10:00:00.1+0300 host only] closing").is_some());
        assert!(parse_compact_line("   ").is_none());
    }
}
