//! Notes, tags, revisions and the startup mechanisms that are not launchd plists.
//! Mirrors `server/core/job-extras.ts`; see docs/backend-contract.md.

use crate::services::{
    backup_dir, create_private_dir, read_plist_xml, revision_label, run_with_timeout, safe_file_name, scope_or_err,
    state_dir,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, UNIX_EPOCH};

const OSASCRIPT: &str = "/usr/bin/osascript";
const CRONTAB: &str = "/usr/bin/crontab";
const SHORTCUTS: &str = "/usr/bin/shortcuts";

const MAX_NOTES_CHARS: usize = 20_000;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 40;
const MAX_LABEL_CHARS: usize = 512;
const MAX_REVISION_BYTES: u64 = 4 * 1024 * 1024;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_ITEMS_TIMEOUT: Duration = Duration::from_secs(30);

// ── Notes and tags ───────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct JobMeta {
    pub notes: String,
    pub tags: Vec<String>,
}

type RawMeta = serde_json::Map<String, serde_json::Value>;

/// Serializes read-modify-write cycles on the meta file.
static META_WRITE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn meta_file() -> PathBuf {
    state_dir().join("job-meta.json")
}

fn meta_key(category: &str, label: &str) -> String {
    format!("{}/{}", category, label)
}

/// The file as the Bun server wrote it. Anything that is not a JSON object counts as empty.
fn read_raw_meta() -> RawMeta {
    std::fs::read_to_string(meta_file())
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

fn to_job_meta(value: &serde_json::Value) -> Option<JobMeta> {
    let entry = value.as_object()?;
    let notes = entry.get("notes").and_then(|n| n.as_str()).unwrap_or("").to_string();
    let tags = entry
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|tags| tags.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Some(JobMeta { notes, tags })
}

pub async fn get_job_meta() -> BTreeMap<String, JobMeta> {
    tokio::task::spawn_blocking(|| {
        read_raw_meta().iter().filter_map(|(key, value)| Some((key.clone(), to_job_meta(value)?))).collect()
    })
    .await
    .unwrap_or_default()
}

/// Limits: notes 20 000 characters, 20 tags of 40 characters, trimmed and de-duplicated.
fn clean_meta(notes: &str, tags: &[String]) -> JobMeta {
    let mut seen = HashSet::new();
    let tags = tags
        .iter()
        .map(|tag| tag.trim().chars().take(MAX_TAG_CHARS).collect::<String>())
        .filter(|tag| !tag.is_empty())
        .filter(|tag| seen.insert(tag.clone()))
        .take(MAX_TAGS)
        .collect();
    JobMeta { notes: notes.chars().take(MAX_NOTES_CHARS).collect(), tags }
}

fn write_private_file(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temp = target.with_extension(format!("json.{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&temp);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temp)?;
    file.write_all(bytes)?;
    drop(file);
    std::fs::rename(&temp, target)
}

pub async fn set_job_meta(label: &str, category: &str, notes: &str, tags: &[String]) -> Result<(), String> {
    scope_or_err(category)?;
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS || label.chars().any(char::is_control) {
        return Err("Invalid label.".to_string());
    }
    let key = meta_key(category, label);
    let meta = clean_meta(notes, tags);

    let _guard = META_WRITE.lock().await;
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut all = read_raw_meta();
        if meta.notes.is_empty() && meta.tags.is_empty() {
            all.remove(&key);
        } else {
            all.insert(key, serde_json::json!({ "notes": meta.notes, "tags": meta.tags }));
        }
        create_private_dir(&state_dir())?;
        write_private_file(&meta_file(), &serde_json::to_vec_pretty(&all)?)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("Could not save the notes: {}", e))
}

// ── Revisions ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct JobRevision {
    /// Backup file name.
    pub id: String,
    /// Modification time in milliseconds since the epoch.
    pub at: f64,
    pub size: u64,
}

/// Newest first. Backups are stored under `safe_file_name(label)`, because the label is untrusted text.
pub async fn list_job_revisions(label: String) -> Vec<JobRevision> {
    tokio::task::spawn_blocking(move || {
        let label = safe_file_name(&label);
        let dir = backup_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut revisions: Vec<JobRevision> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| revision_label(name) == Some(label.as_str()))
            .filter_map(|id| {
                let meta = std::fs::metadata(dir.join(&id)).ok()?;
                let at = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
                    .unwrap_or(0.0);
                Some(JobRevision { id, at, size: meta.len() })
            })
            .collect();
        revisions.sort_by(|a, b| b.at.total_cmp(&a.at));
        revisions
    })
    .await
    .unwrap_or_default()
}

/// A revision id is a file name in the backup folder, never a path.
fn is_revision_id(id: &str) -> bool {
    !id.contains('/') && !id.contains('\\') && !id.contains('\0') && revision_label(id).is_some()
}

/// XML text of one revision. A binary plist is converted.
pub async fn read_job_revision(id: String) -> Result<String, String> {
    if !is_revision_id(&id) {
        return Err("Invalid revision.".to_string());
    }
    tokio::task::spawn_blocking(move || {
        let path = backup_dir().join(&id);
        // The backup folder only holds regular files that this app copied there.
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MAX_REVISION_BYTES {
            return None;
        }
        read_plist_xml(&path)
    })
    .await
    .ok()
    .flatten()
    .ok_or_else(|| "Revision not found.".to_string())
}

// ── Other startup mechanisms (read-only) ─────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct NamedPath {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartupExtras {
    pub cron: Vec<String>,
    pub helper_tools: Vec<NamedPath>,
    pub startup_items: Vec<NamedPath>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct LoginItem {
    pub name: String,
    pub path: String,
    pub hidden: bool,
}

fn list_dir(dir: &str) -> Vec<NamedPath> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    names.into_iter().map(|name| NamedPath { path: format!("{}/{}", dir, name), name }).collect()
}

/// `crontab -l` without comments and blank lines.
fn parse_crontab(stdout: &str) -> Vec<String> {
    stdout
        .split('\n')
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

pub async fn get_startup_extras() -> StartupExtras {
    let crontab_list = [CRONTAB, "-l"];
    let (crontab, dirs) = tokio::join!(
        run_with_timeout(&crontab_list, Some(COMMAND_TIMEOUT)),
        tokio::task::spawn_blocking(|| {
            (
                list_dir("/Library/PrivilegedHelperTools"),
                [list_dir("/Library/StartupItems"), list_dir("/System/Library/StartupItems")].concat(),
            )
        }),
    );
    let (helper_tools, startup_items) = dirs.unwrap_or_default();
    StartupExtras {
        cron: if crontab.code == 0 { parse_crontab(&crontab.stdout) } else { Vec::new() },
        helper_tools,
        startup_items,
    }
}

const LOGIN_ITEMS_SCRIPT: [&str; 7] = [
    "tell application \"System Events\"",
    "set out to \"\"",
    "repeat with li in login items",
    "set out to out & (name of li) & tab & (path of li) & tab & (hidden of li) & linefeed",
    "end repeat",
    "return out",
    "end tell",
];

fn parse_login_items(stdout: &str) -> Vec<LoginItem> {
    stdout
        .split('\n')
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let (name, path, hidden) = (cols.next()?, cols.next()?, cols.next()?);
            if name.is_empty() {
                return None;
            }
            Some(LoginItem {
                name: name.to_string(),
                path: if path == "missing value" { String::new() } else { path.to_string() },
                hidden: hidden.trim() == "true",
            })
        })
        .collect()
}

/// `/-1743|not allowed|not authorized/i`
fn is_automation_denied(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("-1743") || lower.contains("not allowed") || lower.contains("not authorized")
}

/// Login items from System Events. The first call makes macOS ask for Automation permission,
/// so the client only calls this when the user asks for it.
pub async fn get_login_items() -> Result<Vec<LoginItem>, String> {
    let mut cmd = vec![OSASCRIPT];
    for line in LOGIN_ITEMS_SCRIPT {
        cmd.extend(["-e", line]);
    }
    let result = run_with_timeout(&cmd, Some(LOGIN_ITEMS_TIMEOUT)).await;
    if result.code != 0 {
        return Err(if is_automation_denied(&result.stderr) {
            "macOS denied access. Allow mac-dash (or your terminal) under System Settings > Privacy & Security > Automation > System Events.".to_string()
        } else if result.stderr.is_empty() {
            "Could not read the login items.".to_string()
        } else {
            result.stderr
        });
    }
    Ok(parse_login_items(&result.stdout))
}

/// Names of the user's Shortcuts, for the "Shortcut" run kind (`/usr/bin/shortcuts run <name>`).
pub async fn list_shortcuts() -> Vec<String> {
    let result = run_with_timeout(&[SHORTCUTS, "list"], Some(COMMAND_TIMEOUT)).await;
    if result.code != 0 {
        return Vec::new();
    }
    let mut names: Vec<String> =
        result.stdout.split('\n').map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_limits() {
        let tags: Vec<String> =
            ["  web ", "web", "", "   ", &"x".repeat(50)].iter().map(|t| t.to_string()).collect();
        let meta = clean_meta(&"n".repeat(MAX_NOTES_CHARS + 5), &tags);
        assert_eq!(meta.notes.chars().count(), MAX_NOTES_CHARS);
        assert_eq!(meta.tags, vec!["web".to_string(), "x".repeat(40)]);

        let many: Vec<String> = (0..30).map(|i| format!("tag{}", i)).collect();
        assert_eq!(clean_meta("", &many).tags.len(), MAX_TAGS);
        assert_eq!(meta_key("user-agents", "com.example"), "user-agents/com.example");
    }

    #[test]
    fn meta_entries_are_read_leniently() {
        let value = serde_json::json!({ "notes": "hello", "tags": ["a", 1, "b"] });
        assert_eq!(to_job_meta(&value), Some(JobMeta { notes: "hello".into(), tags: vec!["a".into(), "b".into()] }));
        assert_eq!(to_job_meta(&serde_json::json!({})), Some(JobMeta { notes: String::new(), tags: vec![] }));
        assert_eq!(to_job_meta(&serde_json::json!("text")), None);
    }

    #[test]
    fn revision_ids() {
        assert!(is_revision_id("com.foo-2026-09-21T05-03-37-821Z.plist"));
        assert!(!is_revision_id("../com.foo-2026-09-21T05-03-37-821Z.plist"));
        assert!(!is_revision_id("a/b-2026-09-21T05-03-37-821Z.plist"));
        assert!(!is_revision_id("a\\b-2026-09-21T05-03-37-821Z.plist"));
        assert!(!is_revision_id("com.foo.plist"));
        assert!(!is_revision_id(""));
    }

    #[test]
    fn crontab_lines() {
        let stdout = "# comment\n\n  */5 * * * * /usr/bin/true  \n\t# indented comment\nMAILTO=me\n";
        assert_eq!(parse_crontab(stdout), vec!["*/5 * * * * /usr/bin/true", "MAILTO=me"]);
    }

    #[test]
    fn login_item_lines() {
        let stdout = "Dropbox\t/Applications/Dropbox.app\tfalse\nGhost\tmissing value\ttrue \n\tnameless\tfalse\nshort\tline\n\n";
        assert_eq!(
            parse_login_items(stdout),
            vec![
                LoginItem { name: "Dropbox".into(), path: "/Applications/Dropbox.app".into(), hidden: false },
                LoginItem { name: "Ghost".into(), path: String::new(), hidden: true },
            ]
        );
    }

    #[test]
    fn automation_errors() {
        assert!(is_automation_denied("execution error: Not authorized to send Apple events to System Events. (-1743)"));
        assert!(is_automation_denied("osascript is NOT ALLOWED assistive access"));
        assert!(!is_automation_denied("syntax error"));
    }
}
