//! Watches the launchd scope directories for the whole lifetime of the app, so that a job
//! installed by any program is recorded even while the window is hidden.
//! Mirrors `server/core/job-monitor.ts`; see docs/backend-contract.md.
//!
//! The history file `~/.macdash/job-events.json` has the same shape as the one the Bun server
//! writes, and both backends share it.

use crate::launchd::job_executable;
use crate::services::{create_private_dir, loaded_exit_statuses, rescan_jobs, state_dir, JobFile, JobFileChange};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventTarget};
use tauri_plugin_notification::NotificationExt;

const MAX_EVENTS: usize = 500;
const SCAN_INTERVAL: Duration = Duration::from_secs(3);
/// How often the last exit status of the loaded jobs is compared.
const STATUS_INTERVAL: Duration = Duration::from_secs(30);
const MAX_EXCLUDE_PREFIXES: usize = 50;
const MAX_PREFIX_CHARS: usize = 100;
/// A larger batch (an installer, a migration) gets one summary notification.
const MAX_NOTIFICATIONS_PER_BATCH: usize = 5;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct JobEvent {
    pub id: String,
    /// Milliseconds since the epoch.
    pub at: u64,
    /// "added" | "modified" | "removed" | "failed"
    pub kind: String,
    pub label: String,
    pub category: String,
    pub path: String,
    pub program: Option<String>,
    /// Only for "failed".
    #[serde(rename = "exitStatus", default, skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<i64>,
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

/// Write a sibling file first (0600), then rename: a crash never leaves half a file.
fn write_private_json(target: &std::path::Path, json: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
    file.write_all(json)?;
    drop(file);
    std::fs::rename(&temp, target)
}

fn save_history(events: &[JobEvent]) -> std::io::Result<()> {
    create_private_dir(&state_dir())?;
    write_private_json(&history_file(), &serde_json::to_vec(events)?)
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
            exit_status: None,
        })
        .collect()
}

// ── Failed jobs ──────────────────────────────────────────────────────

/// (category, label) → last exit status. Only loaded jobs are in the map. None: never exited.
type StatusMap = HashMap<(String, String), Option<i64>>;

/// -15 is SIGTERM: somebody stopped the job on purpose (launchctl, this app, a logout).
const ORDERLY_STOP: i64 = -15;

/// Jobs whose last exit status changed to a failure since the previous pass. 0 and -15 are no failures.
/// A job that was not loaded before counts as changed. Sorted, so that the events have a stable order.
fn newly_failed(previous: &StatusMap, current: &StatusMap) -> Vec<((String, String), i64)> {
    let mut failed: Vec<((String, String), i64)> = current
        .iter()
        .filter_map(|(key, status)| {
            let status = (*status).filter(|code| *code != 0 && *code != ORDERLY_STOP)?;
            (previous.get(key) != Some(&Some(status))).then(|| (key.clone(), status))
        })
        .collect();
    failed.sort();
    failed
}

fn failed_event(file: &JobFile, exit_status: i64, now: u64) -> JobEvent {
    JobEvent {
        id: format!("{}-{}", now, SEQUENCE.fetch_add(1, Ordering::Relaxed)),
        at: now,
        kind: "failed".to_string(),
        label: file.label.clone(),
        category: file.category.to_string(),
        path: file.path.clone(),
        program: file.job.as_ref().and_then(job_executable),
        exit_status: Some(exit_status),
    }
}

/// One pass over the loaded jobs. Returns the new snapshot and the events. The first pass
/// (`previous` is None) is the baseline and reports nothing. None: launchd gave no answer, so the
/// pass does not count. An empty snapshot would turn every known failure into a new one next time.
async fn status_pass(previous: Option<&StatusMap>) -> Option<(StatusMap, Vec<JobEvent>)> {
    let loaded = loaded_exit_statuses().await?;
    let mut files: HashMap<(String, String), Arc<JobFile>> = HashMap::new();
    let mut current = StatusMap::new();
    for (file, status) in loaded {
        let key = (file.category.to_string(), file.label.clone());
        current.insert(key.clone(), status);
        files.insert(key, file);
    }
    let now = now_ms();
    let events = match previous {
        Some(previous) => newly_failed(previous, &current)
            .into_iter()
            .filter_map(|(key, status)| files.get(&key).map(|file| failed_event(file, status, now)))
            .collect(),
        None => Vec::new(),
    };
    Some((current, events))
}

// ── Settings ─────────────────────────────────────────────────────────

/// `~/.macdash/settings.json`, shared with the Bun server.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct MonitorSettings {
    /// false stops the native notifications. Events are still recorded.
    pub notify: bool,
    /// A label that starts with one of these prefixes never notifies.
    pub exclude: Vec<String>,
}

impl Default for MonitorSettings {
    fn default() -> Self {
        MonitorSettings { notify: true, exclude: Vec::new() }
    }
}

/// Serializes read-modify-write cycles on the settings file.
static SETTINGS_WRITE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn settings_file() -> PathBuf {
    state_dir().join("settings.json")
}

/// Limits: 50 prefixes of 100 characters. Trimmed, without empty entries and duplicates.
fn clean_prefixes<'a>(prefixes: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    prefixes
        .into_iter()
        .map(|prefix| prefix.trim().chars().take(MAX_PREFIX_CHARS).collect::<String>())
        .filter(|prefix| !prefix.is_empty() && seen.insert(prefix.clone()))
        .take(MAX_EXCLUDE_PREFIXES)
        .collect()
}

/// Anything that is missing or has the wrong type falls back to the default.
fn settings_from_json(value: &serde_json::Value) -> MonitorSettings {
    let notify = value.get("notify").and_then(|n| n.as_bool()).unwrap_or(true);
    let exclude = value
        .get("exclude")
        .and_then(|e| e.as_array())
        .map(|items| clean_prefixes(items.iter().filter_map(|item| item.as_str())))
        .unwrap_or_default();
    MonitorSettings { notify, exclude }
}

fn read_settings_json() -> serde_json::Map<String, serde_json::Value> {
    std::fs::read_to_string(settings_file())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn load_settings() -> MonitorSettings {
    settings_from_json(&serde_json::Value::Object(read_settings_json()))
}

pub async fn get_monitor_settings() -> MonitorSettings {
    tokio::task::spawn_blocking(load_settings).await.unwrap_or_default()
}

pub async fn set_monitor_settings(notify: bool, exclude: Vec<String>) -> Result<(), String> {
    let exclude = clean_prefixes(exclude.iter().map(String::as_str));
    let _guard = SETTINGS_WRITE.lock().await;
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        // Keys that this version does not know stay in the file.
        let mut all = read_settings_json();
        all.insert("notify".to_string(), serde_json::Value::Bool(notify));
        all.insert("exclude".to_string(), serde_json::json!(exclude));
        create_private_dir(&state_dir())?;
        write_private_json(&settings_file(), &serde_json::to_vec_pretty(&all)?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not save the settings: {}", e))
}

/// The events that may post a native notification under these settings.
fn notifiable<'a>(settings: &MonitorSettings, events: &'a [JobEvent]) -> Vec<&'a JobEvent> {
    if !settings.notify {
        return Vec::new();
    }
    events.iter().filter(|event| !settings.exclude.iter().any(|prefix| event.label.starts_with(prefix.as_str()))).collect()
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
        "failed" => "launchd job failed",
        _ => "launchd job changed",
    }
}

/// Label, then the program (or the plist path), then the exit status of a failed job.
/// A click on a notification cannot open the job on macOS, so the body must say which job it is.
fn notification_body(event: &JobEvent) -> String {
    let detail = event.program.as_deref().unwrap_or(&event.path);
    match event.exit_status {
        Some(status) => format!("{}\n{}\nExit status {}", event.label, detail, status),
        None => format!("{}\n{}", event.label, detail),
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        eprintln!("[monitor] Could not post a notification: {}", e);
    }
}

fn publish(app: &AppHandle, fresh: &[JobEvent], settings: &MonitorSettings) {
    // To every dashboard window (`main`, `main-2`, …), and to no other window.
    for event in fresh {
        let _ = app.emit_filter("job-event", event, |target| match target {
            EventTarget::Window { label }
            | EventTarget::Webview { label }
            | EventTarget::WebviewWindow { label }
            | EventTarget::AnyLabel { label } => crate::windows::is_dashboard_label(label),
            _ => false,
        });
    }
    let wanted = notifiable(settings, fresh);
    if wanted.len() > MAX_NOTIFICATIONS_PER_BATCH {
        notify(app, "launchd jobs changed", &format!("{} jobs were added, changed or removed.", wanted.len()));
        return;
    }
    for event in wanted {
        notify(app, notification_title(&event.kind), &notification_body(event));
    }
}

/// Store the events, send them to the window and post the notifications that the settings allow.
async fn record_events(fresh: Vec<JobEvent>) {
    if fresh.is_empty() {
        return;
    }
    let stored = fresh.clone();
    let settings = tokio::task::spawn_blocking(move || {
        append_history(&stored);
        load_settings() // read on every batch: the Bun server may have changed the file
    })
    .await
    .unwrap_or_default();
    if let Some(app) = APP.get() {
        publish(app, &fresh, &settings);
    }
}

/// Called by `rescan_jobs()` after every scan that found differences, whoever triggered it.
/// The baseline scan never gets here.
pub async fn record(changes: &[JobFileChange]) {
    record_events(to_events(changes, now_ms())).await;
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

    // Failed jobs: compare the last exit status of the loaded jobs. The first pass is the baseline.
    tauri::async_runtime::spawn(async {
        let mut ticker = tokio::time::interval(STATUS_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut previous: Option<StatusMap> = None;
        loop {
            ticker.tick().await; // the first tick completes at once
            // Every launchctl call inside has a timeout, so this task cannot stay stuck in a pass.
            if let Some((current, events)) = status_pass(previous.as_ref()).await {
                previous = Some(current);
                record_events(events).await;
            }
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
        let failed = failed_event(&file(None), -9, 99);
        assert_eq!((failed.kind.as_str(), failed.exit_status, failed.at), ("failed", Some(-9), 99));
        assert_eq!(notification_body(&failed), "com.example\n/Library/LaunchAgents/com.example.plist\nExit status -9");
        assert_eq!(notification_title("failed"), "launchd job failed");
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
        assert_eq!(notification_body(&events[0]), "com.example\n/usr/bin/true");
        assert_eq!(notification_body(&events[1]), "com.example\n/Library/LaunchAgents/com.example.plist");
    }

    #[test]
    fn failed_event_shape() {
        // Written by the Bun server: "failed" carries exitStatus, the other kinds do not.
        let text = r#"[{"id":"1-0","at":1,"kind":"failed","label":"x","category":"user-agents","path":"/p","program":"/bin/x","exitStatus":78},
            {"id":"1-1","at":1,"kind":"added","label":"y","category":"user-agents","path":"/q","program":null}]"#;
        let events = parse_history(text).unwrap();
        assert_eq!(events[0].exit_status, Some(78));
        assert_eq!(events[1].exit_status, None);
        assert_eq!(
            serde_json::to_string(&events[0]).unwrap(),
            r#"{"id":"1-0","at":1,"kind":"failed","label":"x","category":"user-agents","path":"/p","program":"/bin/x","exitStatus":78}"#
        );
        assert!(!serde_json::to_string(&events[1]).unwrap().contains("exitStatus"));
    }

    /// Read-only: two passes over the real launchd state. `cargo test -- --ignored live`.
    #[tokio::test]
    #[ignore]
    async fn live_status_passes() {
        let (baseline, events) = status_pass(None).await.expect("launchd answers");
        println!("{} loaded jobs with a plist in a writable scope", baseline.len());
        assert!(events.is_empty(), "the first pass is the baseline");
        let (_, events) = status_pass(Some(&baseline)).await.expect("launchd answers");
        assert!(events.iter().all(|e| e.kind == "failed" && e.exit_status.is_some_and(|s| s != 0)));
        println!("monitor settings: {:?}", get_monitor_settings().await);
    }

    #[test]
    fn status_changes() {
        let key = |label: &str| ("user-agents".to_string(), label.to_string());
        let map = |entries: &[(&str, Option<i64>)]| -> StatusMap { entries.iter().map(|(label, status)| (key(label), *status)).collect() };

        let before = map(&[
            ("same-error", Some(78)),
            ("ok", Some(0)),
            ("never-ran", None),
            ("was-error", Some(1)),
            ("other-error", Some(1)),
            ("gone", Some(0)),
            ("stopped", Some(0)),
            ("was-stopped", Some(-15)),
            ("error-then-stopped", Some(78)),
        ]);
        let after = map(&[
            ("same-error", Some(78)),  // unchanged: no event
            ("ok", Some(1)),           // 0 → 1
            ("never-ran", Some(-9)),   // "-" → killed by a signal
            ("was-error", Some(0)),    // recovered: no event
            ("other-error", Some(2)),  // another failure
            ("new-failed", Some(78)),  // loaded since the last pass, and failed already
            ("new-clean", Some(0)),
            ("new-idle", None),
            ("stopped", Some(-15)),            // SIGTERM is an orderly stop: no event
            ("new-stopped", Some(-15)),
            ("error-then-stopped", Some(-15)),
            ("was-stopped", Some(78)),         // stopped before, failed now
        ]);
        assert_eq!(
            newly_failed(&before, &after),
            vec![(key("never-ran"), -9), (key("new-failed"), 78), (key("ok"), 1), (key("other-error"), 2), (key("was-stopped"), 78)]
        );
        // Nothing changed, and an empty world
        assert!(newly_failed(&after, &after).is_empty());
        assert!(newly_failed(&before, &StatusMap::new()).is_empty());
        // The same label in two scopes is two jobs.
        let mut two = map(&[("dup", Some(0))]);
        two.insert(("global-daemons".to_string(), "dup".to_string()), Some(3));
        assert_eq!(newly_failed(&map(&[("dup", Some(0))]), &two), vec![(("global-daemons".to_string(), "dup".to_string()), 3)]);
    }

    #[test]
    fn settings_limits_and_defaults() {
        assert_eq!(MonitorSettings::default(), MonitorSettings { notify: true, exclude: vec![] });
        assert_eq!(settings_from_json(&serde_json::json!({})), MonitorSettings::default());
        assert_eq!(settings_from_json(&serde_json::json!({"notify": "no", "exclude": "com.apple."})), MonitorSettings::default());
        assert_eq!(
            settings_from_json(&serde_json::json!({"notify": false, "exclude": ["com.apple.", 5, " com.google. ", "", "com.apple."], "future": 1})),
            MonitorSettings { notify: false, exclude: vec!["com.apple.".into(), "com.google.".into()] }
        );
        // The wire shape of the shared file
        assert_eq!(serde_json::to_string(&MonitorSettings::default()).unwrap(), r#"{"notify":true,"exclude":[]}"#);

        let many: Vec<String> = (0..80).map(|i| format!("prefix{}.", i)).collect();
        assert_eq!(clean_prefixes(many.iter().map(String::as_str)).len(), MAX_EXCLUDE_PREFIXES);
        let long = "é".repeat(300);
        assert_eq!(clean_prefixes([long.as_str()])[0].chars().count(), MAX_PREFIX_CHARS);
    }

    #[test]
    fn settings_filter_notifications() {
        let event = |label: &str| JobEvent {
            id: "1-0".into(),
            at: 1,
            kind: "added".into(),
            label: label.into(),
            category: "user-agents".into(),
            path: "/p".into(),
            program: None,
            exit_status: None,
        };
        let events = [event("com.apple.thing"), event("com.example.job"), event("org.apple")];
        let labels = |settings: &MonitorSettings| notifiable(settings, &events).iter().map(|e| e.label.clone()).collect::<Vec<_>>();

        assert_eq!(labels(&MonitorSettings::default()).len(), 3);
        assert_eq!(
            labels(&MonitorSettings { notify: true, exclude: vec!["com.apple.".into(), "zzz".into()] }),
            vec!["com.example.job", "org.apple"]
        );
        assert!(labels(&MonitorSettings { notify: false, exclude: vec![] }).is_empty());
    }
}
