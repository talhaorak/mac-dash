//! Helper tools, the background-item reset, the folder browser, the default PATH and all plists as JSON.
//! See "Helper tools, reset, browse, PATH, plists" in docs/backend-contract.md.
//!
//! The validators and builders are pure and have unit tests. The tests never run a privileged
//! command and never run `sfltool resetbtm`.

use crate::services::{
    copy_exclusive_with_mode, discard_trash_copy, free_trash_path, home_dir, indexed_files, prompt_label,
    run_privileged_command,
};
use plist::Value;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

const HELPER_TOOLS_DIR: &str = "/Library/PrivilegedHelperTools";
const SFLTOOL: &str = "/usr/bin/sfltool";
const MAX_BROWSE_ENTRIES: usize = 1000;
/// A folder with more names than this is cut before sorting, so that one request stays bounded.
const MAX_BROWSE_SCAN: usize = 20_000;
/// The client asks the user and sends the request again with `permanent: true`.
const TRASH_COPY_FAILED: &str = "The file cannot be copied to the Trash. Delete it permanently?";
const DEFAULT_PATH_TAIL: [&str; 4] = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

fn has_control_chars(text: &str) -> bool {
    text.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
}

// ── Delete helper tool ───────────────────────────────────────────────

/// One file name in `/Library/PrivilegedHelperTools`: no `/`, no leading `.` or `-`, no control characters.
fn check_helper_tool_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name.len() > 255
        || name.contains('/')
        || name.starts_with('.')
        || name.starts_with('-')
        || has_control_chars(name);
    if bad {
        return Err("Invalid helper tool name.".to_string());
    }
    Ok(())
}

/// The path of a helper tool. The name is validated first, so the result is always a direct child of the folder.
fn helper_tool_path(name: &str) -> Result<PathBuf, String> {
    check_helper_tool_name(name)?;
    let path = Path::new(HELPER_TOOLS_DIR).join(name);
    if path.parent() != Some(Path::new(HELPER_TOOLS_DIR)) {
        return Err("Invalid helper tool name.".to_string());
    }
    Ok(path)
}

/// The one root command. The Trash copy is made by the app before, because root never writes into `~/.Trash`.
fn helper_tool_remove_command(path: &str) -> [&str; 3] {
    ["/bin/rm", "-f", path]
}

pub async fn delete_helper_tool(name: &str, permanent: bool) -> Result<(), String> {
    let path = helper_tool_path(name)?;
    let (source, file_name) = (path.clone(), name.to_string());
    let trash_copy = tokio::task::spawn_blocking(move || -> Result<Option<PathBuf>, String> {
        // A regular file, not a symlink: `rm` would remove the link, and the copy would follow it.
        let meta = std::fs::symlink_metadata(&source).map_err(|_| "Helper tool not found.".to_string())?;
        if !meta.is_file() {
            return Err("Helper tool not found.".to_string());
        }
        if permanent {
            return Ok(None); // the user confirmed: no Trash copy at all
        }
        let dest = free_trash_path(&file_name);
        // The copy keeps the execute bits, without setuid and setgid.
        copy_exclusive_with_mode(&source, &dest, meta.permissions().mode() & 0o755)
            .map(|()| Some(dest))
            .map_err(|_| TRASH_COPY_FAILED.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let path = path.to_string_lossy().into_owned();
    let prompt = format!("mac-dash wants to delete the helper tool \"{}\".", prompt_label(name));
    run_privileged_command(&helper_tool_remove_command(&path), &prompt).await.inspect_err(|_| discard_trash_copy(trash_copy))
}

// ── Reset background items ───────────────────────────────────────────

/// Resets the approval of every app, and macOS asks for a restart. The client asks twice before it calls this.
const RESET_BACKGROUND_ITEMS_COMMAND: [&str; 2] = [SFLTOOL, "resetbtm"];

pub async fn reset_background_items() -> Result<(), String> {
    run_privileged_command(&RESET_BACKGROUND_ITEMS_COMMAND, "mac-dash wants to reset the background-item approval of every app.").await?;
    crate::startup_tools::clear_background_items_cache().await; // the kept answer of `dumpbtm` is wrong now
    Ok(())
}

// ── Browse ───────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowseEntry {
    pub name: String,
    pub is_directory: bool,
    /// A directory whose name ends in ".app".
    pub is_app: bool,
    /// A regular file with an execute bit.
    pub executable: bool,
    /// The name starts with ".".
    pub hidden: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct BrowseResult {
    pub path: String,
    /// None for "/".
    pub parent: Option<String>,
    pub entries: Vec<BrowseEntry>,
    pub truncated: bool,
}

/// An absolute path without `.`, `..` and doubled slashes. Lexical: symlinks stay as the user sees them.
/// Empty means the home folder.
fn normalize_browse_path(path: &str, home: &Path) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Ok(home.to_path_buf());
    }
    if !path.starts_with('/') || path.contains('\0') {
        return Err("The path must be absolute.".to_string());
    }
    let mut normal = PathBuf::from("/");
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => normal.push(part),
            Component::ParentDir => {
                normal.pop();
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    Ok(normal)
}

/// Directories first, then by lowercased name, then by name. Strings compare by UTF-16 code units, like
/// `<` in JavaScript, so both backends return the same order. Not locale-aware.
fn sort_browse_entries(entries: &mut [BrowseEntry]) {
    let units = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
    entries.sort_by_cached_key(|entry| (!entry.is_directory, units(&entry.name.to_lowercase()), units(&entry.name)));
}

fn browse_folder(path: &str, home: &Path, limit: usize) -> Result<BrowseResult, String> {
    let folder = normalize_browse_path(path, home)?;
    let reader = std::fs::read_dir(&folder).map_err(|_| "Cannot read this folder.".to_string())?;

    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in reader.flatten() {
        if entries.len() >= MAX_BROWSE_SCAN {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // A symlink counts as what it points to. A dangling one is a plain entry.
        let is_directory = match entry.file_type() {
            Ok(kind) if kind.is_symlink() => std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false),
            Ok(kind) => kind.is_dir(),
            Err(_) => false,
        };
        entries.push(BrowseEntry {
            is_app: is_directory && name.ends_with(".app"),
            hidden: name.starts_with('.'),
            executable: false, // filled in below, only for the entries that are returned
            is_directory,
            name,
        });
    }

    sort_browse_entries(&mut entries);
    truncated |= entries.len() > limit;
    entries.truncate(limit);
    for entry in entries.iter_mut().filter(|entry| !entry.is_directory) {
        entry.executable =
            std::fs::metadata(folder.join(&entry.name)).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    }

    Ok(BrowseResult {
        parent: folder.parent().map(|parent| parent.to_string_lossy().into_owned()),
        path: folder.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

/// For path pickers, because a web view cannot return real file paths.
pub async fn browse_path(path: String) -> Result<BrowseResult, String> {
    tokio::task::spawn_blocking(move || browse_folder(&path, &home_dir(), MAX_BROWSE_ENTRIES)).await.map_err(|e| e.to_string())?
}

// ── Default PATH ─────────────────────────────────────────────────────

/// Lines of `/etc/paths`, then of every file of `/etc/paths.d` (the caller sorts them), then the usual
/// Homebrew and local folders. Without duplicates and empty lines, joined with ":".
fn build_default_path(etc_paths: &str, paths_d: &[String]) -> String {
    let mut seen = HashSet::new();
    std::iter::once(etc_paths)
        .chain(paths_d.iter().map(String::as_str))
        .flat_map(str::lines)
        .chain(DEFAULT_PATH_TAIL)
        .map(str::trim)
        .filter(|line| !line.is_empty() && seen.insert(line.to_string()))
        .collect::<Vec<_>>()
        .join(":")
}

pub async fn get_default_path() -> String {
    tokio::task::spawn_blocking(|| {
        let etc_paths = std::fs::read_to_string("/etc/paths").unwrap_or_default();
        let mut files: Vec<PathBuf> =
            std::fs::read_dir("/etc/paths.d").map(|dir| dir.flatten().map(|entry| entry.path()).collect()).unwrap_or_default();
        files.sort();
        let paths_d: Vec<String> = files.iter().filter_map(|file| std::fs::read_to_string(file).ok()).collect();
        build_default_path(&etc_paths, &paths_d)
    })
    .await
    .unwrap_or_default()
}

// ── Plists as JSON ───────────────────────────────────────────────────

/// `Date.prototype.toISOString()`: "2026-09-21T05:03:37.000Z"
fn iso_date(date: plist::Date) -> String {
    let time: std::time::SystemTime = date.into();
    let (secs, nanos) = match time.duration_since(UNIX_EPOCH) {
        Ok(after) => (after.as_secs() as i64, after.subsec_nanos()),
        Err(before) => {
            let d = before.duration();
            if d.subsec_nanos() == 0 { (-(d.as_secs() as i64), 0) } else { (-(d.as_secs() as i64) - 1, 1_000_000_000 - d.subsec_nanos()) }
        }
    };
    chrono::DateTime::from_timestamp(secs, nanos).map(|utc| utc.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()).unwrap_or_default()
}

/// date → ISO string, data → base64 string, real → number. JSON has no NaN, so a real like that is null.
fn plist_to_json(value: &Value) -> serde_json::Value {
    use base64::Engine;
    match value {
        Value::Dictionary(dict) => serde_json::Value::Object(dict.iter().map(|(key, item)| (key.clone(), plist_to_json(item))).collect()),
        Value::Array(items) => serde_json::Value::Array(items.iter().map(plist_to_json).collect()),
        Value::String(text) => serde_json::Value::String(text.clone()),
        Value::Boolean(flag) => serde_json::Value::Bool(*flag),
        Value::Integer(number) => match (number.as_signed(), number.as_unsigned()) {
            (Some(signed), _) => serde_json::Value::from(signed),
            (None, Some(unsigned)) => serde_json::Value::from(unsigned),
            (None, None) => serde_json::Value::Null,
        },
        Value::Real(number) => serde_json::Number::from_f64(*number).map_or(serde_json::Value::Null, serde_json::Value::Number),
        Value::Date(date) => serde_json::Value::String(iso_date(*date)),
        Value::Data(bytes) => serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(bytes)),
        Value::Uid(uid) => serde_json::Value::from(uid.get()),
        _ => serde_json::Value::Null,
    }
}

/// Every indexed job under "<category>/<label>". Unreadable plists are left out.
pub async fn get_job_plists() -> BTreeMap<String, serde_json::Value> {
    let files = indexed_files().await;
    tokio::task::spawn_blocking(move || {
        files
            .values()
            .filter_map(|file| {
                let job = file.job.as_ref()?;
                let json = serde_json::Value::Object(job.iter().map(|(key, item)| (key.clone(), plist_to_json(item))).collect());
                Some((format!("{}/{}", file.category, file.label), json))
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helper_tool_names() {
        for good in ["com.docker.vmnetd", "com.example.Helper Tool", "a", "x_y-z.1"] {
            assert_eq!(helper_tool_path(good).unwrap(), Path::new("/Library/PrivilegedHelperTools").join(good));
        }
        let long = "x".repeat(256);
        for bad in ["", ".", "..", ".hidden", "-rf", "a/b", "/etc/passwd", "../../etc/passwd", "a\nb", "a\0b", "a\u{2028}b", long.as_str()] {
            assert!(helper_tool_path(bad).is_err(), "{:?}", bad);
        }
        // The root command removes exactly one absolute path in the helper folder.
        let path = helper_tool_path("com.example.helper").unwrap();
        assert_eq!(helper_tool_remove_command(path.to_str().unwrap()), ["/bin/rm", "-f", "/Library/PrivilegedHelperTools/com.example.helper"]);
    }

    #[test]
    fn reset_command_is_constant() {
        assert_eq!(RESET_BACKGROUND_ITEMS_COMMAND, ["/usr/bin/sfltool", "resetbtm"]);
    }

    #[test]
    fn browse_paths() {
        let home = Path::new("/Users/me");
        assert_eq!(normalize_browse_path("", home).unwrap(), home);
        assert_eq!(normalize_browse_path("/", home).unwrap(), Path::new("/"));
        assert_eq!(normalize_browse_path("/usr//local/./bin/", home).unwrap(), Path::new("/usr/local/bin"));
        assert_eq!(normalize_browse_path("/usr/local/../bin", home).unwrap(), Path::new("/usr/bin"));
        assert_eq!(normalize_browse_path("/../../..", home).unwrap(), Path::new("/"));
        for bad in ["relative", "~/Documents", "./x", "/a\0b"] {
            assert!(normalize_browse_path(bad, home).is_err(), "{:?}", bad);
        }
    }

    #[test]
    fn browse_a_folder() {
        let dir = std::env::temp_dir().join(format!("macdash-browse-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("zeta")).unwrap();
        std::fs::create_dir_all(dir.join("Alpha.app")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("beta.sh"), "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(dir.join("beta.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(dir.join("Notes.txt"), "x").unwrap();
        std::fs::write(dir.join(".hidden"), "x").unwrap();
        std::fs::write(dir.join("file.app"), "a file, not an app").unwrap();
        std::os::unix::fs::symlink(dir.join("zeta"), dir.join("link-to-dir")).unwrap();
        std::os::unix::fs::symlink(dir.join("missing"), dir.join("dangling")).unwrap();

        let result = browse_folder(dir.to_str().unwrap(), Path::new("/nowhere"), 1000).unwrap();
        assert_eq!(result.path, dir.to_str().unwrap());
        assert_eq!(result.parent.as_deref(), dir.parent().and_then(Path::to_str));
        assert!(!result.truncated);
        let names: Vec<&str> = result.entries.iter().map(|e| e.name.as_str()).collect();
        // Directories first, then files, each by name without case.
        assert_eq!(names, vec![".git", "Alpha.app", "link-to-dir", "zeta", ".hidden", "beta.sh", "dangling", "file.app", "Notes.txt"]);

        let entry = |name: &str| result.entries.iter().find(|e| e.name == name).unwrap();
        assert!(entry("Alpha.app").is_app && entry("Alpha.app").is_directory && !entry("Alpha.app").executable);
        assert!(!entry("file.app").is_app, "a file is never an app");
        assert!(entry("link-to-dir").is_directory);
        assert!(!entry("dangling").is_directory && !entry("dangling").executable);
        assert!(entry("beta.sh").executable && !entry("Notes.txt").executable);
        assert!(!entry("zeta").executable, "the search bit of a folder does not count");
        assert!(entry(".git").hidden && entry(".hidden").hidden && !entry("zeta").hidden);

        // The limit cuts after sorting and says so.
        let cut = browse_folder(dir.to_str().unwrap(), Path::new("/nowhere"), 3).unwrap();
        assert!(cut.truncated);
        assert_eq!(cut.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec![".git", "Alpha.app", "link-to-dir"]);

        // Empty path: the home folder. "/" has no parent.
        assert_eq!(browse_folder("", &dir, 1000).unwrap().path, dir.to_str().unwrap());
        assert_eq!(browse_folder("/", &dir, 5).unwrap().parent, None);
        assert_eq!(browse_folder(dir.join("missing").to_str().unwrap(), &dir, 5).unwrap_err(), "Cannot read this folder.");
        assert_eq!(browse_folder(dir.join("Notes.txt").to_str().unwrap(), &dir, 5).unwrap_err(), "Cannot read this folder.");

        let json = serde_json::to_value(entry("beta.sh")).unwrap();
        assert_eq!(json, serde_json::json!({"name": "beta.sh", "isDirectory": false, "isApp": false, "executable": true, "hidden": false}));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Read-only checks on this Mac: `cargo test -- --ignored live`. Nothing is deleted and nothing is reset.
    #[tokio::test]
    #[ignore]
    async fn live_browse_path_and_plists() {
        let path = get_default_path().await;
        println!("default PATH: {}", path);
        assert!(path.split(':').any(|p| p == "/usr/bin"));
        assert!(path.split(':').any(|p| p == "/usr/local/sbin"));
        assert_eq!(path.split(':').collect::<HashSet<_>>().len(), path.split(':').count(), "no duplicates");

        let home = browse_path(String::new()).await.unwrap();
        assert_eq!(home.path, home_dir().to_str().unwrap());
        assert!(home.entries.iter().any(|e| e.name == "Library" && e.is_directory));
        let apps = browse_path("/Applications".into()).await.unwrap();
        assert!(apps.entries.iter().any(|e| e.is_app));
        let bin = browse_path("/bin".into()).await.unwrap();
        assert!(bin.entries.iter().any(|e| e.name == "sh" && e.executable && !e.is_directory));
        assert_eq!(browse_path("/nonexistent-folder".into()).await.unwrap_err(), "Cannot read this folder.");

        let plists = get_job_plists().await;
        println!("{} plists as JSON, {} bytes", plists.len(), serde_json::to_string(&plists).unwrap().len());
        assert!(plists.len() > 100);
        let finder = &plists["system-agents/com.apple.Finder"];
        assert_eq!(finder["Label"], "com.apple.Finder");
        assert!(finder["KeepAlive"].is_object());

        // A helper tool that does not exist fails before anything privileged happens.
        assert_eq!(delete_helper_tool("no.such.helper.tool.macdash-test", false).await.unwrap_err(), "Helper tool not found.");
        assert_eq!(delete_helper_tool("../etc/hosts", true).await.unwrap_err(), "Invalid helper tool name.");
    }

    #[test]
    fn browse_order_is_by_code_units() {
        let entry = |name: &str, is_directory: bool| BrowseEntry { name: name.into(), is_directory, is_app: false, executable: false, hidden: false };
        let mut entries = vec![
            entry("b.txt", false), entry("a.txt", false), entry("B.txt", false), entry("Zebra", true), entry("apple", true),
            entry("_x", false), entry("10", false), entry("9", false), entry("ä", false), entry("z", false),
            entry("\u{1F600}", false), entry("\u{FB01}", false), // an emoji (surrogates in UTF-16) sorts before U+FB01
        ];
        sort_browse_entries(&mut entries);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Expected order from `sortBrowseEntries()` of the Bun server.
        assert_eq!(names, vec!["apple", "Zebra", "10", "9", "_x", "a.txt", "B.txt", "b.txt", "z", "ä", "\u{1F600}", "\u{FB01}"]);
    }

    #[test]
    fn default_path() {
        let etc_paths = "/usr/local/bin\n/System/Cryptexes/App/usr/bin\n/usr/bin\n/bin\n\n  /usr/sbin  \n/sbin\n";
        let paths_d = vec!["/opt/X11/bin\n".to_string(), "/usr/bin\n/Library/Apple/usr/bin".to_string(), String::new()];
        assert_eq!(
            build_default_path(etc_paths, &paths_d),
            "/usr/local/bin:/System/Cryptexes/App/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/X11/bin:/Library/Apple/usr/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/sbin"
        );
        assert_eq!(build_default_path("", &[]), "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin");
    }

    #[test]
    fn plists_as_json() {
        let xml = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict>\
            <key>Label</key><string>com.example.job</string>\
            <key>RunAtLoad</key><true/>\
            <key>StartInterval</key><integer>300</integer>\
            <key>Negative</key><integer>-5</integer>\
            <key>Big</key><integer>18446744073709551615</integer>\
            <key>Nice</key><real>1.5</real>\
            <key>When</key><date>2026-09-21T05:03:37Z</date>\
            <key>Blob</key><data>aGVsbG8=</data>\
            <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string></array>\
            <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\
            </dict></plist>";
        let value: Value = plist::from_bytes(xml.as_bytes()).unwrap();
        assert_eq!(
            plist_to_json(&value),
            serde_json::json!({
                "Label": "com.example.job",
                "RunAtLoad": true,
                "StartInterval": 300,
                "Negative": -5,
                "Big": 18446744073709551615u64,
                "Nice": 1.5,
                "When": "2026-09-21T05:03:37.000Z",
                "Blob": "aGVsbG8=",
                "ProgramArguments": ["/bin/sh", "-c"],
                "KeepAlive": {"SuccessfulExit": false},
            })
        );
        assert_eq!(plist_to_json(&Value::Real(f64::NAN)), serde_json::Value::Null);
    }
}
