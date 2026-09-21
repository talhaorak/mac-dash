//! Notes, tags, revisions and the startup mechanisms that are not launchd plists.
//! Mirrors `server/core/job-extras.ts`; see docs/backend-contract.md.

use crate::services::{
    backup_dir, create_private_dir, osascript_argv, read_plist_xml, revision_label, run_with_timeout, safe_file_name,
    scope_or_err, state_dir,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, UNIX_EPOCH};

const CRONTAB: &str = "/usr/bin/crontab";
const SHORTCUTS: &str = "/usr/bin/shortcuts";

const MAX_NOTES_CHARS: usize = 20_000;
const MAX_TAGS: usize = 20;
const MAX_TAG_CHARS: usize = 40;
const MAX_LABEL_CHARS: usize = 512;
const MAX_ICON_EMOJI_CHARS: usize = 8;
/// The whole data URL, not the decoded image.
const MAX_ICON_URL_BYTES: usize = 48 * 1024;
const ICON_URL_PREFIXES: [(&str, &[u8]); 2] =
    [("data:image/png;base64,", b"\x89PNG\r\n\x1a\n"), ("data:image/jpeg;base64,", b"\xff\xd8\xff")];
const MAX_REVISION_BYTES: u64 = 4 * 1024 * 1024;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const LOGIN_ITEMS_TIMEOUT: Duration = Duration::from_secs(30);

// ── Notes and tags ───────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct JobMeta {
    pub notes: String,
    pub tags: Vec<String>,
    /// An emoji, or a PNG/JPEG data URL. The key is left out when there is no icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
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
    // Read leniently: the Bun server validated the icon when it wrote the entry. Only the size is checked.
    let icon = entry.get("icon").and_then(|i| i.as_str()).filter(|i| !i.is_empty() && i.len() <= MAX_ICON_URL_BYTES).map(str::to_string);
    Some(JobMeta { notes, tags, icon })
}

/// Characters that emoji are made of: pictographs, symbols, and the joiners and modifiers between them.
fn is_emoji_char(c: char) -> bool {
    matches!(u32::from(c),
        0x00A9 | 0x00AE | 0x203C | 0x2049 | 0x2122 | 0x2139 | 0x3030 | 0x303D | 0x3297 | 0x3299
        | 0x2190..=0x21FF | 0x2300..=0x23FF | 0x2460..=0x24FF | 0x25A0..=0x27BF | 0x2900..=0x297F | 0x2B00..=0x2BFF
        | 0x1F000..=0x1FAFF
        | 0x200D | 0xFE0F | 0x20E3 | 0xE0020..=0xE007F)
}

fn is_emoji_joiner(c: char) -> bool {
    matches!(u32::from(c), 0x200D | 0xFE0F | 0x20E3 | 0xE0020..=0xE007F)
}

/// An emoji of at most 8 characters: 👍, 👨‍👩‍👧, 🇹🇷, 1️⃣. Letters, markup and control characters never pass.
fn is_emoji_icon(icon: &str) -> bool {
    let keycap = icon.contains('\u{20E3}');
    let count = icon.chars().count();
    (1..=MAX_ICON_EMOJI_CHARS).contains(&count)
        && icon.chars().all(|c| is_emoji_char(c) || (keycap && matches!(c, '0'..='9' | '#' | '*')))
        && icon.chars().any(|c| !is_emoji_joiner(c))
}

/// A `data:image/png;base64,` or `data:image/jpeg;base64,` URL of at most 48 KB whose payload really is
/// base64 of that image type. SVG never passes: it can carry script.
fn is_image_data_url(icon: &str) -> bool {
    use base64::Engine;
    if icon.len() > MAX_ICON_URL_BYTES {
        return false;
    }
    ICON_URL_PREFIXES.iter().any(|(prefix, magic)| {
        icon.strip_prefix(prefix)
            .and_then(|payload| base64::engine::general_purpose::STANDARD.decode(payload).ok())
            .is_some_and(|bytes| bytes.starts_with(magic))
    })
}

/// None: no icon. Err: a value that is neither an emoji nor a PNG/JPEG data URL.
fn clean_icon(icon: Option<&str>) -> Result<Option<String>, String> {
    match icon.map(str::trim).filter(|icon| !icon.is_empty()) {
        None => Ok(None),
        Some(icon) if is_emoji_icon(icon) || is_image_data_url(icon) => Ok(Some(icon.to_string())),
        Some(_) => Err("The icon must be an emoji or a PNG or JPEG image of at most 48 KB.".to_string()),
    }
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
    JobMeta { notes: notes.chars().take(MAX_NOTES_CHARS).collect(), tags, icon: None }
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

/// Replace one entry of the file. Empty notes, no tags and no icon deletes it. Other entries stay
/// as they are, also with keys that this version does not know.
fn apply_meta(all: &mut RawMeta, key: String, meta: &JobMeta) {
    if meta.notes.is_empty() && meta.tags.is_empty() && meta.icon.is_none() {
        all.remove(&key);
    } else {
        let mut entry = serde_json::Map::new();
        entry.insert("notes".to_string(), serde_json::Value::String(meta.notes.clone()));
        entry.insert("tags".to_string(), serde_json::json!(meta.tags));
        if let Some(icon) = &meta.icon {
            entry.insert("icon".to_string(), serde_json::Value::String(icon.clone()));
        }
        all.insert(key, serde_json::Value::Object(entry));
    }
}

/// Replaces the entry. Empty notes, no tags and no icon deletes it.
pub async fn set_job_meta(label: &str, category: &str, notes: &str, tags: &[String], icon: Option<&str>) -> Result<(), String> {
    scope_or_err(category)?;
    if label.is_empty() || label.chars().count() > MAX_LABEL_CHARS || label.chars().any(char::is_control) {
        return Err("Invalid label.".to_string());
    }
    let key = meta_key(category, label);
    let meta = JobMeta { icon: clean_icon(icon)?, ..clean_meta(notes, tags) };

    let _guard = META_WRITE.lock().await;
    tokio::task::spawn_blocking(move || -> std::io::Result<()> {
        let mut all = read_raw_meta();
        apply_meta(&mut all, key, &meta);
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

/// The error text for a refused Automation request, for reading and for deleting login items.
pub(crate) const AUTOMATION_DENIED: &str =
    "macOS denied access. Allow mac-dash (or your terminal) under System Settings > Privacy & Security > Automation > System Events.";

/// `/-1743|not allowed|not authorized/i`
pub(crate) fn is_automation_denied(stderr: &str) -> bool {
    let lower = stderr.to_lowercase();
    lower.contains("-1743") || lower.contains("not allowed") || lower.contains("not authorized")
}

/// Login items from System Events. The first call makes macOS ask for Automation permission,
/// so the client only calls this when the user asks for it.
pub async fn get_login_items() -> Result<Vec<LoginItem>, String> {
    // A constant script without arguments. It still goes through the one argv builder.
    let result = run_with_timeout(&osascript_argv(&LOGIN_ITEMS_SCRIPT, &[]), Some(LOGIN_ITEMS_TIMEOUT)).await;
    if result.code != 0 {
        return Err(if is_automation_denied(&result.stderr) {
            AUTOMATION_DENIED.to_string()
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
        assert_eq!(to_job_meta(&value), Some(JobMeta { notes: "hello".into(), tags: vec!["a".into(), "b".into()], icon: None }));
        assert_eq!(to_job_meta(&serde_json::json!({})), Some(JobMeta { notes: String::new(), tags: vec![], icon: None }));
        assert_eq!(to_job_meta(&serde_json::json!("text")), None);
    }

    /// 1x1 PNG and the start of a JPEG, as `canvas.toDataURL()` makes them.
    const PNG_URL: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const JPEG_URL: &str = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgM=";

    #[test]
    fn icons() {
        for emoji in ["👍", "⚙️", "🗂", "👨‍👩‍👧", "🇹🇷", "1️⃣", "#️⃣", "✅", "⭐", "❤️", "👋🏽", "©️"] {
            assert_eq!(clean_icon(Some(emoji)), Ok(Some(emoji.to_string())), "{}", emoji);
        }
        assert_eq!(clean_icon(Some(PNG_URL)), Ok(Some(PNG_URL.to_string())));
        assert_eq!(clean_icon(Some(JPEG_URL)), Ok(Some(JPEG_URL.to_string())));
        assert_eq!(clean_icon(Some(" 👍 ")), Ok(Some("👍".to_string())));
        // No icon
        assert_eq!(clean_icon(None), Ok(None));
        assert_eq!(clean_icon(Some("")), Ok(None));
        assert_eq!(clean_icon(Some("   ")), Ok(None));

        let too_long = "👍".repeat(9);
        let too_big = format!("data:image/png;base64,{}", "A".repeat(MAX_ICON_URL_BYTES));
        let svg = "data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+";
        let svg_as_png = "data:image/png;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+";
        for bad in [
            "abc", "A", "1", "#", "12", "<b>", "👍a", "a👍", "\u{200D}", "\u{FE0F}\u{200D}", "👍\n👍", "👍 👍", too_long.as_str(), too_big.as_str(),
            svg, svg_as_png, "data:image/png;base64,", "data:image/png;base64,not base64!", "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
            "data:text/html;base64,PGI+", "javascript:alert(1)", "https://example.com/icon.png", "DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=",
        ] {
            assert!(clean_icon(Some(bad)).is_err(), "{:?}", bad.chars().take(40).collect::<String>());
        }
    }

    #[test]
    fn meta_entries_are_replaced_or_deleted() {
        let mut all: RawMeta = serde_json::from_value(serde_json::json!({
            "user-agents/keep": { "notes": "server", "tags": [], "icon": "🗂", "future": true },
            "user-agents/edit": { "notes": "old", "tags": ["a"], "icon": "👍" },
        }))
        .unwrap();
        let meta = |notes: &str, tags: &[&str], icon: Option<&str>| JobMeta {
            notes: notes.into(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            icon: icon.map(str::to_string),
        };

        // An icon alone keeps the entry alive.
        apply_meta(&mut all, "user-agents/edit".into(), &meta("", &[], Some("⭐")));
        assert_eq!(all["user-agents/edit"], serde_json::json!({ "notes": "", "tags": [], "icon": "⭐" }));
        // No icon in the request removes the icon: the entry is replaced, like notes and tags.
        apply_meta(&mut all, "user-agents/edit".into(), &meta("n", &["t"], None));
        assert_eq!(all["user-agents/edit"], serde_json::json!({ "notes": "n", "tags": ["t"] }));
        // Nothing left: the entry goes.
        apply_meta(&mut all, "user-agents/edit".into(), &meta("", &[], None));
        assert!(!all.contains_key("user-agents/edit"));
        apply_meta(&mut all, "user-agents/never-existed".into(), &meta("", &[], None));
        // The entries of other jobs are untouched, with the keys of a later version.
        assert_eq!(all["user-agents/keep"], serde_json::json!({ "notes": "server", "tags": [], "icon": "🗂", "future": true }));
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn meta_entries_round_trip_with_the_server() {
        // Written by the Bun server: with an icon, without one, and an entry with keys of a later version.
        let file = serde_json::json!({
            "user-agents/com.example.a": { "notes": "n", "tags": ["t"], "icon": "🗂" },
            "user-agents/com.example.b": { "notes": "", "tags": ["x"] },
            "global-daemons/com.example.c": { "notes": "", "tags": [], "icon": PNG_URL, "color": "red" },
        });
        let a = to_job_meta(&file["user-agents/com.example.a"]).unwrap();
        assert_eq!(a, JobMeta { notes: "n".into(), tags: vec!["t".into()], icon: Some("🗂".into()) });
        // The wire shape: "icon" only when it is set.
        assert_eq!(serde_json::to_string(&a).unwrap(), r#"{"notes":"n","tags":["t"],"icon":"🗂"}"#);
        let b = to_job_meta(&file["user-agents/com.example.b"]).unwrap();
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"notes":"","tags":["x"]}"#);
        assert_eq!(to_job_meta(&file["global-daemons/com.example.c"]).unwrap().icon.as_deref(), Some(PNG_URL));
        // An icon that is not a string, or an absurdly large one, is dropped on read.
        assert_eq!(to_job_meta(&serde_json::json!({"notes": "", "tags": [], "icon": 5})).unwrap().icon, None);
        let huge = "x".repeat(MAX_ICON_URL_BYTES + 1);
        assert_eq!(to_job_meta(&serde_json::json!({"notes": "", "tags": [], "icon": huge})).unwrap().icon, None);
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
