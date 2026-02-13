use serde::Serialize;
use std::sync::Mutex;
use tokio::process::Command;
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Serialize, Clone, Debug)]
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

static STREAM_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

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
                if let Some(close_pos) = rest.find(']') {
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

pub fn start_log_stream() {
    if STREAM_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // already running
    }

    tokio::spawn(async {
        let mut child = match Command::new("log")
            .args(["stream", "--style", "compact", "--level", "info"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(_) => {
                STREAM_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout).lines();

        while let Ok(Some(line)) = reader.next_line().await {
            if !STREAM_RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if let Some(entry) = parse_compact_line(&line) {
                let mut buf = LOG_BUFFER.lock().unwrap();
                buf.push(entry);
                if buf.len() > MAX_BUFFER {
                    let drain = buf.len() - MAX_BUFFER;
                    buf.drain(..drain);
                }
            }
        }

        let _ = child.kill().await;
        STREAM_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

pub fn stop_log_stream() {
    STREAM_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
}

pub fn get_recent_logs(count: usize) -> Vec<LogEntry> {
    let buf = LOG_BUFFER.lock().unwrap();
    let start = buf.len().saturating_sub(count);
    buf[start..].to_vec()
}

pub async fn query_logs(last_minutes: u32, predicate: Option<&str>) -> Vec<LogEntry> {
    let mut args = vec![
        "log".to_string(), "show".to_string(),
        "--last".to_string(), format!("{}m", last_minutes),
        "--style".to_string(), "compact".to_string(),
    ];
    if let Some(pred) = predicate {
        args.push("--predicate".to_string());
        args.push(pred.to_string());
    }

    let output = Command::new(&args[0])
        .args(&args[1..])
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
    let buf = LOG_BUFFER.lock().unwrap();
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
