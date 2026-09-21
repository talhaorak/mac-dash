//! Watches the launchd scope directories for the whole lifetime of the app, so that a job
//! installed by any program is recorded even while the window is hidden.
//! Mirrors `server/core/job-monitor.ts`; see docs/backend-contract.md.
//!
//! The history file `~/.macdash/job-events.json` has the same shape as the one the Bun server
//! writes, and both backends share it.

use crate::launchd::job_executable;
use crate::services::{create_private_dir, rescan_jobs, state_dir, JobFileChange};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

const MAX_EVENTS: usize = 500;
const SCAN_INTERVAL: Duration = Duration::from_secs(3);
/// A larger batch (an installer, a migration) gets one summary notification.
const MAX_NOTIFICATIONS_PER_BATCH: usize = 5;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct JobEvent {
    pub id: String,
    /// Milliseconds since the epoch.
    pub at: u64,
    /// "added" | "modified" | "removed"
    pub kind: String,
    pub label: String,
    pub category: String,
    pub path: String,
    pub program: Option<String>,
}

/// Oldest first, like the history file.
static EVENTS: Mutex<Vec<JobEvent>> = Mutex::new(Vec::new());
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static APP: OnceLock<AppHandle> = OnceLock::new();

fn history_file() -> PathBuf {
    state_dir().join("job-events.json")
}

/// Events from the history file. Entries that do not look like a JobEvent are skipped.
fn parse_history(text: &str) -> Option<Vec<JobEvent>> {
    let items: Vec<serde_json::Value> = serde_json::from_str(text).ok()?;
    let mut events: Vec<JobEvent> = items.into_iter().filter_map(|item| serde_json::from_value(item).ok()).collect();
    let surplus = events.len().saturating_sub(MAX_EVENTS);
    events.drain(..surplus);
    Some(events)
}

fn load_history() -> Option<Vec<JobEvent>> {
    parse_history(&std::fs::read_to_string(history_file()).ok()?)
}

fn save_history(events: &[JobEvent]) -> std::io::Result<()> {
    use std::io::Write;
    create_private_dir(&state_dir())?;
    let json = serde_json::to_vec(events)?;
    // Write a sibling file first, so that a crash never leaves half a history.
    let target = history_file();
    let temp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
    file.write_all(&json)?;
    drop(file);
    std::fs::rename(&temp, &target)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn to_events(changes: &[JobFileChange], now: u64) -> Vec<JobEvent> {
    changes
        .iter()
        .map(|change| JobEvent {
            id: format!("{}-{}", now, SEQUENCE.fetch_add(1, Ordering::Relaxed)),
            at: now,
            kind: change.kind.to_string(),
            label: change.file.label.clone(),
            category: change.file.category.to_string(),
            path: change.file.path.clone(),
            program: change.file.job.as_ref().and_then(job_executable),
        })
        .collect()
}

/// Append to the shared history. The file is read again first, because the Bun server may
/// have written to it since this process loaded it.
fn append_history(fresh: &[JobEvent]) {
    let mut events = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(on_disk) = load_history() {
        *events = on_disk;
    }
    events.extend_from_slice(fresh);
    let surplus = events.len().saturating_sub(MAX_EVENTS);
    events.drain(..surplus);
    if let Err(e) = save_history(&events) {
        eprintln!("[monitor] Could not save the job history: {}", e);
    }
}

fn notification_title(kind: &str) -> &'static str {
    match kind {
        "added" => "launchd job added",
        "removed" => "launchd job removed",
        _ => "launchd job changed",
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[monitor] Could not post a notification: {}", e);
    }
}

fn publish(app: &AppHandle, fresh: &[JobEvent]) {
    for event in fresh {
        let _ = app.emit_to("main", "job-event", event);
    }
    if fresh.len() > MAX_NOTIFICATIONS_PER_BATCH {
        notify(app, "launchd jobs changed", &format!("{} jobs were added, changed or removed.", fresh.len()));
        return;
    }
    for event in fresh {
        let detail = event.program.as_deref().unwrap_or(&event.path);
        notify(app, notification_title(&event.kind), &format!("{}\n{}", event.label, detail));
    }
}

/// Called by `rescan_jobs()` after every scan that found differences, whoever triggered it.
/// The baseline scan never gets here.
pub async fn record(changes: &[JobFileChange]) {
    let fresh = to_events(changes, now_ms());
    let stored = fresh.clone();
    let _ = tokio::task::spawn_blocking(move || append_history(&stored)).await;
    if let Some(app) = APP.get() {
        publish(app, &fresh);
    }
}

/// Start the monitor. It runs until the app exits.
pub fn start(app: AppHandle) {
    if APP.set(app).is_err() {
        return; // already running
    }
    tauri::async_runtime::spawn(async {
        if let Ok(Some(history)) = tokio::task::spawn_blocking(load_history).await {
            *EVENTS.lock().unwrap_or_else(|e| e.into_inner()) = history;
        }
        rescan_jobs().await; // baseline: jobs that already exist are not events

        let mut ticker = tokio::time::interval(SCAN_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticker.tick().await; // the first tick completes at once
        loop {
            ticker.tick().await;
            rescan_jobs().await;
        }
    });
}

/// Newest first.
pub async fn get_job_events() -> Vec<JobEvent> {
    let on_disk = tokio::task::spawn_blocking(load_history).await.ok().flatten();
    let mut events = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(on_disk) = on_disk {
        *events = on_disk;
    }
    events.iter().rev().cloned().collect()
}

pub async fn clear_job_events() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        let mut events = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
        events.clear();
        save_history(&events).map_err(|e| format!("Could not clear the job history: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::JobFile;
    use std::sync::Arc;

    #[test]
    fn history_shape_matches_the_server() {
        // Written by server/core/job-monitor.ts
        let text = r#"[{"id":"1758430000000-0","at":1758430000000,"kind":"added","label":"com.example.job","category":"user-agents","path":"/Users/me/Library/LaunchAgents/com.example.job.plist","program":"/bin/sh"},
            {"id":"1758430000001-1","at":1758430000001,"kind":"removed","label":"x","category":"global-daemons","path":"/Library/LaunchDaemons/x.plist","program":null},
            {"broken":true}, 42]"#;
        let events = parse_history(text).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].program.as_deref(), Some("/bin/sh"));
        assert_eq!(events[1].program, None);

        let json = serde_json::to_string(&events[1]).unwrap();
        assert_eq!(
            json,
            r#"{"id":"1758430000001-1","at":1758430000001,"kind":"removed","label":"x","category":"global-daemons","path":"/Library/LaunchDaemons/x.plist","program":null}"#
        );
        assert!(parse_history("{}").is_none());
        assert!(parse_history("not json").is_none());
    }

    #[test]
    fn history_keeps_the_newest() {
        let one = r#"{"id":"ID","at":1,"kind":"added","label":"l","category":"user-agents","path":"/p","program":null}"#;
        let many: Vec<String> = (0..MAX_EVENTS + 7).map(|i| one.replace("ID", &i.to_string())).collect();
        let events = parse_history(&format!("[{}]", many.join(","))).unwrap();
        assert_eq!(events.len(), MAX_EVENTS);
        assert_eq!(events[0].id, "7");
    }

    #[test]
    fn changes_become_events() {
        let mut job = plist::Dictionary::new();
        job.insert("Program".into(), plist::Value::String("/usr/bin/true".into()));
        let file = |job| {
            Arc::new(JobFile {
                path: "/Library/LaunchAgents/com.example.plist".into(),
                file_name: "com.example.plist".into(),
                category: "global-agents",
                label: "com.example".into(),
                modified: None,
                size: 1,
                job,
                quarantined: false,
            })
        };
        let changes = [
            JobFileChange { kind: "added", file: file(Some(job)) },
            JobFileChange { kind: "removed", file: file(None) },
        ];
        let events = to_events(&changes, 1234);
        assert_eq!(events.len(), 2);
        assert!(events[0].id.starts_with("1234-"));
        assert_ne!(events[0].id, events[1].id);
        assert_eq!(events[0].at, 1234);
        assert_eq!(events[0].kind, "added");
        assert_eq!(events[0].category, "global-agents");
        assert_eq!(events[0].program.as_deref(), Some("/usr/bin/true"));
        assert_eq!(events[1].program, None);
        assert_eq!(notification_title("added"), "launchd job added");
        assert_eq!(notification_title("modified"), "launchd job changed");
        assert_eq!(notification_title("removed"), "launchd job removed");
    }
}
