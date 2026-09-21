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
/// The WHOLE data URL string, not the decoded image.
const MAX_ICON_URL_BYTES: usize = 48 * 1024;
const ICON_URL_PREFIXES: [&str; 2] = ["data:image/png;base64,", "data:image/jpeg;base64,"];

/// `\p{Extended_Pictographic}`, generated from the JavaScript engine of the Bun server (Unicode 15.1),
/// so that both backends accept the same emoji. Sorted ranges, both ends included.
#[rustfmt::skip]
const EXTENDED_PICTOGRAPHIC: [(u32, u32); 156] = [
    (0xA9, 0xA9), (0xAE, 0xAE), (0x203C, 0x203C), (0x2049, 0x2049), (0x2122, 0x2122), (0x2139, 0x2139),
    (0x2194, 0x2199), (0x21A9, 0x21AA), (0x231A, 0x231B), (0x2328, 0x2328), (0x23CF, 0x23CF), (0x23E9, 0x23F3),
    (0x23F8, 0x23FA), (0x24C2, 0x24C2), (0x25AA, 0x25AB), (0x25B6, 0x25B6), (0x25C0, 0x25C0), (0x25FB, 0x25FE),
    (0x2600, 0x2604), (0x260E, 0x260E), (0x2611, 0x2611), (0x2614, 0x2615), (0x2618, 0x2618), (0x261D, 0x261D),
    (0x2620, 0x2620), (0x2622, 0x2623), (0x2626, 0x2626), (0x262A, 0x262A), (0x262E, 0x262F), (0x2638, 0x263A),
    (0x2640, 0x2640), (0x2642, 0x2642), (0x2648, 0x2653), (0x265F, 0x2660), (0x2663, 0x2663), (0x2665, 0x2666),
    (0x2668, 0x2668), (0x267B, 0x267B), (0x267E, 0x267F), (0x2692, 0x2697), (0x2699, 0x2699), (0x269B, 0x269C),
    (0x26A0, 0x26A1), (0x26A7, 0x26A7), (0x26AA, 0x26AB), (0x26B0, 0x26B1), (0x26BD, 0x26BE), (0x26C4, 0x26C5),
    (0x26C8, 0x26C8), (0x26CE, 0x26CF), (0x26D1, 0x26D1), (0x26D3, 0x26D4), (0x26E9, 0x26EA), (0x26F0, 0x26F5),
    (0x26F7, 0x26FA), (0x26FD, 0x26FD), (0x2702, 0x2702), (0x2705, 0x2705), (0x2708, 0x270D), (0x270F, 0x270F),
    (0x2712, 0x2712), (0x2714, 0x2714), (0x2716, 0x2716), (0x271D, 0x271D), (0x2721, 0x2721), (0x2728, 0x2728),
    (0x2733, 0x2734), (0x2744, 0x2744), (0x2747, 0x2747), (0x274C, 0x274C), (0x274E, 0x274E), (0x2753, 0x2755),
    (0x2757, 0x2757), (0x2763, 0x2764), (0x2795, 0x2797), (0x27A1, 0x27A1), (0x27B0, 0x27B0), (0x27BF, 0x27BF),
    (0x2934, 0x2935), (0x2B05, 0x2B07), (0x2B1B, 0x2B1C), (0x2B50, 0x2B50), (0x2B55, 0x2B55), (0x3030, 0x3030),
    (0x303D, 0x303D), (0x3297, 0x3297), (0x3299, 0x3299), (0x1F004, 0x1F004), (0x1F02C, 0x1F02F), (0x1F094, 0x1F09F),
    (0x1F0AF, 0x1F0B0), (0x1F0C0, 0x1F0C0), (0x1F0CF, 0x1F0D0), (0x1F0F6, 0x1F0FF), (0x1F170, 0x1F171),
    (0x1F17E, 0x1F17F), (0x1F18E, 0x1F18E), (0x1F191, 0x1F19A), (0x1F1AE, 0x1F1E5), (0x1F201, 0x1F20F),
    (0x1F21A, 0x1F21A), (0x1F22F, 0x1F22F), (0x1F232, 0x1F23A), (0x1F23C, 0x1F23F), (0x1F249, 0x1F25F),
    (0x1F266, 0x1F321), (0x1F324, 0x1F393), (0x1F396, 0x1F397), (0x1F399, 0x1F39B), (0x1F39E, 0x1F3F0),
    (0x1F3F3, 0x1F3F5), (0x1F3F7, 0x1F3FA), (0x1F400, 0x1F4FD), (0x1F4FF, 0x1F53D), (0x1F549, 0x1F54E),
    (0x1F550, 0x1F567), (0x1F56F, 0x1F570), (0x1F573, 0x1F57A), (0x1F587, 0x1F587), (0x1F58A, 0x1F58D),
    (0x1F590, 0x1F590), (0x1F595, 0x1F596), (0x1F5A4, 0x1F5A5), (0x1F5A8, 0x1F5A8), (0x1F5B1, 0x1F5B2),
    (0x1F5BC, 0x1F5BC), (0x1F5C2, 0x1F5C4), (0x1F5D1, 0x1F5D3), (0x1F5DC, 0x1F5DE), (0x1F5E1, 0x1F5E1),
    (0x1F5E3, 0x1F5E3), (0x1F5E8, 0x1F5E8), (0x1F5EF, 0x1F5EF), (0x1F5F3, 0x1F5F3), (0x1F5FA, 0x1F64F),
    (0x1F680, 0x1F6C5), (0x1F6CB, 0x1F6D2), (0x1F6D5, 0x1F6E5), (0x1F6E9, 0x1F6E9), (0x1F6EB, 0x1F6F0),
    (0x1F6F3, 0x1F6FF), (0x1F7DA, 0x1F7FF), (0x1F80C, 0x1F80F), (0x1F848, 0x1F84F), (0x1F85A, 0x1F85F),
    (0x1F888, 0x1F88F), (0x1F8AE, 0x1F8AF), (0x1F8BC, 0x1F8BF), (0x1F8C2, 0x1F8CF), (0x1F8D9, 0x1F8FF),
    (0x1F90C, 0x1F93A), (0x1F93C, 0x1F945), (0x1F947, 0x1F9FF), (0x1FA58, 0x1FA5F), (0x1FA6E, 0x1FAFF),
    (0x1FC00, 0x1FFFD),
];
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

fn is_extended_pictographic(c: char) -> bool {
    let code = u32::from(c);
    EXTENDED_PICTOGRAPHIC.binary_search_by(|(first, last)| {
        if code < *first { std::cmp::Ordering::Greater } else if code > *last { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal }
    }).is_ok()
}

fn is_regional_indicator(c: char) -> bool {
    matches!(u32::from(c), 0x1F1E6..=0x1F1FF)
}

fn is_keycap_base(c: char) -> bool {
    matches!(c, '0'..='9' | '#' | '*')
}

/// `\p{Emoji_Component}` without the keycap bases: ZWJ, keycap, VS16, regional indicators, skin tones,
/// hair components and tag characters.
fn is_emoji_component(c: char) -> bool {
    matches!(u32::from(c), 0x200D | 0x20E3 | 0xFE0F | 0x1F1E6..=0x1F1FF | 0x1F3FB..=0x1F3FF | 0x1F9B0..=0x1F9B3 | 0xE0020..=0xE007F)
}

/// An emoji of at most 8 code points (one family emoji is seven of them): 🚀, ⚙️, 🇹🇷, 1️⃣, 👍🏽.
/// Every code point is pictographic or an emoji component. A digit, "#" or "*" only counts in a keycap
/// sequence, before U+FE0F U+20E3 or U+20E3. At least one code point is pictographic, a regional
/// indicator or the keycap, so that "1234" and "#" are no emoji.
fn is_emoji_icon(icon: &str) -> bool {
    let chars: Vec<char> = icon.chars().collect();
    if chars.is_empty() || chars.len() > MAX_ICON_EMOJI_CHARS {
        return false;
    }
    let parts_ok = chars.iter().enumerate().all(|(at, c)| {
        if is_keycap_base(*c) {
            matches!(chars.get(at + 1..), Some(['\u{FE0F}', '\u{20E3}', ..]) | Some(['\u{20E3}', ..]))
        } else {
            is_extended_pictographic(*c) || is_emoji_component(*c)
        }
    });
    parts_ok && chars.iter().any(|c| is_extended_pictographic(*c) || is_regional_indicator(*c) || *c == '\u{20E3}')
}

/// `^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$`. SVG never passes: it can carry script.
/// The payload alphabet cannot break out of an attribute.
fn is_image_data_url(icon: &str) -> bool {
    ICON_URL_PREFIXES.iter().filter_map(|prefix| icon.strip_prefix(prefix)).any(|payload| {
        let data = payload.trim_end_matches('=');
        let padding = payload.len() - data.len();
        !data.is_empty() && padding <= 2 && data.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    })
}

/// None: no icon. Err: a value that is neither an emoji nor a PNG/JPEG data URL. Same rules and
/// texts as `checkJobIcon()` of the Bun server. Nothing is trimmed: "🚀 " is not an emoji.
fn clean_icon(icon: Option<&str>) -> Result<Option<String>, String> {
    let Some(icon) = icon.filter(|icon| !icon.is_empty()) else {
        return Ok(None);
    };
    if icon.starts_with("data:") {
        if icon.len() > MAX_ICON_URL_BYTES {
            return Err("The icon image is larger than 48 KB.".to_string());
        }
        if !is_image_data_url(icon) {
            return Err("The icon image must be a base64 PNG or JPEG data URL.".to_string());
        }
    } else if !is_emoji_icon(icon) {
        return Err("The icon must be an emoji of at most 8 characters or a PNG or JPEG image.".to_string());
    }
    Ok(Some(icon.to_string()))
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

    /// The cases of `checkJobIcon` in server/core/job-extras.test.ts, plus a few more.
    #[test]
    fn icons() {
        assert_eq!(clean_icon(None), Ok(None));
        assert_eq!(clean_icon(Some("")), Ok(None));

        // Emoji, also sequences of several code points
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}"; // 7 code points, 11 UTF-16 units
        for emoji in ["\u{1F680}", "\u{2699}\u{FE0F}", "\u{1F1F9}\u{1F1F7}", "1\u{FE0F}\u{20E3}", "\u{1F44D}\u{1F3FD}", family, "#\u{FE0F}\u{20E3}", "*\u{20E3}", "✅", "⭐", "❤️", "©️", "🗂"] {
            assert_eq!(clean_icon(Some(emoji)), Ok(Some(emoji.to_string())), "{}", emoji);
        }

        // A PNG or JPEG data URL up to 48 KB, measured on the whole string
        assert_eq!(clean_icon(Some("data:image/png;base64,iVBORw0KGgo=")), Ok(Some("data:image/png;base64,iVBORw0KGgo=".to_string())));
        assert_eq!(clean_icon(Some("data:image/jpeg;base64,/9j/4AAQ")), Ok(Some("data:image/jpeg;base64,/9j/4AAQ".to_string())));
        assert_eq!(clean_icon(Some(PNG_URL)), Ok(Some(PNG_URL.to_string())));
        assert_eq!(clean_icon(Some(JPEG_URL)), Ok(Some(JPEG_URL.to_string())));
        let prefix = "data:image/png;base64,";
        let largest = format!("{}{}", prefix, "A".repeat(48 * 1024 - prefix.len()));
        assert_eq!(clean_icon(Some(&largest)).unwrap().unwrap().len(), 48 * 1024);
        let too_big = format!("{}A", largest);
        assert_eq!(clean_icon(Some(&too_big)).unwrap_err(), "The icon image is larger than 48 KB.");

        // Everything else
        let nine = "\u{1F680}".repeat(9);
        for bad in [
            "A", "rocket", "1234", "#", "1", "*", "12\u{20E3}", "\u{200D}", "\u{FE0F}\u{200D}", "\u{1F3FD}", nine.as_str(),
            "\u{1F680}<script>", "\u{1F680} ", " \u{1F680}", "\u{1F680}\n", "   ", "a\u{1F680}",
            "https://example.com/icon.png", "javascript:alert(1)",
        ] {
            assert_eq!(clean_icon(Some(bad)).unwrap_err(), "The icon must be an emoji of at most 8 characters or a PNG or JPEG image.", "{:?}", bad);
        }
        for bad in [
            "data:image/svg+xml;base64,PHN2Zz4=", "data:image/gif;base64,R0lGODlh", "data:image/png;base64,",
            "data:image/png;base64,iVBOR w0K", "data:image/png,iVBORw0KGgo=", "data:image/png;base64,iVBO\"onerror=\"x",
            "data:image/png;base64,====", "data:image/png;base64,AAAA===", "data:image/png;base64,AA=A", "data:text/html;base64,PGI+",
        ] {
            assert_eq!(clean_icon(Some(bad)).unwrap_err(), "The icon image must be a base64 PNG or JPEG data URL.", "{:?}", bad);
        }
        // The scheme is case-sensitive, like in the server: this one is no data URL and no emoji.
        assert!(clean_icon(Some("DATA:IMAGE/PNG;BASE64,iVBORw0KGgo=")).is_err());
    }

    #[test]
    fn pictographic_table() {
        assert!(EXTENDED_PICTOGRAPHIC.windows(2).all(|pair| pair[0].1 < pair[1].0), "sorted and disjoint, for the binary search");
        assert!(EXTENDED_PICTOGRAPHIC.iter().all(|(first, last)| first <= last));
        for c in ['\u{A9}', '\u{2699}', '\u{1F680}', '\u{1F468}', '\u{1FAE0}', '\u{1F5C2}'] {
            assert!(is_extended_pictographic(c), "{:?}", c);
        }
        // Skin tones, regional indicators and keycap parts are components, not pictographs.
        for c in ['A', '1', '#', ' ', '\u{200D}', '\u{FE0F}', '\u{20E3}', '\u{1F3FD}', '\u{1F1F9}'] {
            assert!(!is_extended_pictographic(c), "{:?}", c);
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
