//! launchd job backend. This file mirrors `server/core/launchctl.ts`.
//! The binding contract is `docs/backend-contract.md`.
//!
//! Rules that matter here:
//! - A job is addressed by label + category. The client never sends a path.
//! - Commands are spawned with argument arrays. The only shell string is the one handed to
//!   `osascript` for the administrator prompt, and every argument in it is single-quoted.
//! - No user-writable path crosses the privilege boundary as a source of content. root writes the
//!   text it was handed inside the script, and only into root-owned directories.
//! - A Label read from a plist is untrusted. It never becomes a path component without
//!   `safe_file_name()`, and job files are always located through the directory scan.
//! - Job files move to `~/.Trash`. A file is only unlinked when the Trash refuses it and a
//!   backup copy exists in `~/.macdash/backups`.
//! - root never writes into a folder the user controls (`~/Library/LaunchAgents`, `~/.Trash`): a
//!   same-user process could plant a symlink there while the prompt is open. The app writes and
//!   copies there itself. For a file in `/Library` the root script only runs `rm -f` on the original.

use crate::launchd::{
    calendar_entries, describe_triggers, is_valid_label, is_valid_target_label, job_executable, label_sort_key,
    scope_for, JobScope, ScopeKind, JOB_SCOPES,
};
use plist::{Dictionary, Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::CString;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const LAUNCHCTL: &str = "/bin/launchctl";
const OSASCRIPT: &str = "/usr/bin/osascript";
const PLUTIL: &str = "/usr/bin/plutil";
const OPEN: &str = "/usr/bin/open";
const XATTR: &str = "/usr/bin/xattr";
const QUARANTINE_XATTR: &str = "com.apple.quarantine";
const MAX_BACKUPS_PER_JOB: usize = 20;

/// `launchctl print`, `print-disabled` and the other read-only tools. A hung launchctl must not freeze
/// the job list (polled every 3 s) or wedge the failed-job poll.
const LAUNCHCTL_TIMEOUT: Duration = Duration::from_secs(15);
/// bootstrap, bootout, kickstart, kill, enable, disable without the administrator prompt.
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);

const MAX_OUTPUT_BYTES: u64 = 256 * 1024;
const MAX_XML_BYTES: usize = 1024 * 1024;
/// A privileged save passes the plist inside the root script, so the size is bound by ARG_MAX.
const MAX_PRIVILEGED_XML_BYTES: usize = 200 * 1024;
/// A new file is written next to its target under this suffix, then renamed.
/// The suffix does not end in ".plist", so the monitor ignores the file.
const STAGING_SUFFIX: &str = ".macdash-new";
/// A job plist larger than this is listed but not parsed.
const MAX_PLIST_BYTES: u64 = 4 * 1024 * 1024;

pub const SERVICE_ACTIONS: [&str; 7] = ["start", "stop", "restart", "load", "unload", "enable", "disable"];

// ── Types (see docs/backend-contract.md) ─────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub label: String,
    pub pid: Option<i64>,
    pub last_exit_status: Option<i64>,
    /// "running" | "stopped" | "error" | "unknown"
    pub status: &'static str,
    pub category: String,
    pub plist_path: Option<String>,
    pub program: Option<String>,
    pub program_arguments: Option<Vec<String>>,
    pub run_at_load: Option<bool>,
    pub enabled: bool,
    pub loaded: bool,
    pub disabled: bool,
    pub triggers: Vec<String>,
    pub writable: bool,
    pub needs_admin: bool,
    pub user_name: Option<String>,
    /// The plist exists but cannot be parsed.
    pub unreadable: bool,
    /// The plist carries com.apple.quarantine, so launchd may refuse to load it. Saving clears it.
    pub quarantined: bool,
    pub start_interval: Option<i64>,
    /// StartCalendarInterval entries, integer fields only.
    pub calendar: Vec<BTreeMap<String, i64>>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDetail {
    pub path: Option<String>,
    pub r#type: Option<String>,
    pub bundle_id: Option<String>,
    pub state: Option<String>,
    pub environment: BTreeMap<String, String>,
    pub last_exit_reason: Option<String>,
    pub domain: String,
    pub raw: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobDocument {
    pub label: String,
    pub category: String,
    pub path: String,
    pub file_name: String,
    pub xml: String,
    pub writable: bool,
    pub needs_admin: bool,
    /// Milliseconds since the epoch.
    pub mtime: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobRef {
    pub label: String,
    pub category: String,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SaveJobRequest {
    pub category: String,
    pub xml: String,
    #[serde(default)]
    pub original: Option<JobRef>,
    #[serde(default)]
    pub load: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SavedJob {
    pub label: String,
    pub path: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobOutput {
    pub path: Option<String>,
    pub exists: bool,
    pub size: u64,
    pub truncated: bool,
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PathFacts {
    pub path: String,
    pub exists: bool,
    pub is_file: bool,
    pub is_directory: bool,
    pub executable: bool,
}

/// One plist file in a scope directory, with its parsed content.
#[derive(Debug, Clone)]
pub struct JobFile {
    pub path: String,
    pub file_name: String,
    pub category: &'static str,
    pub label: String,
    pub modified: Option<SystemTime>,
    pub size: u64,
    pub job: Option<Dictionary>,
    /// com.apple.quarantine is present. Checked for the writable scopes only.
    pub quarantined: bool,
}

impl JobFile {
    pub fn mtime_ms(&self) -> f64 {
        self.modified
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6)
            .unwrap_or(0.0)
    }
}

#[derive(Clone, Debug)]
pub struct JobFileChange {
    /// "added" | "modified" | "removed"
    pub kind: &'static str,
    pub file: Arc<JobFile>,
}

type JobResult<T> = Result<T, String>;

pub(crate) fn uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

pub(crate) fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/var/empty"))
}

/// `~/.macdash`, shared with the Bun server.
pub(crate) fn state_dir() -> PathBuf {
    home_dir().join(".macdash")
}

pub(crate) fn backup_dir() -> PathBuf {
    state_dir().join("backups")
}

/// Create `~/.macdash` (or a folder in it), private to the user.
pub(crate) fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
}

fn scope_dir(scope: &JobScope) -> PathBuf {
    match scope.dir.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest),
        None => PathBuf::from(scope.dir),
    }
}

fn domain_for(scope: &JobScope) -> String {
    match scope.kind {
        ScopeKind::Daemon => "system".to_string(),
        ScopeKind::Agent => format!("gui/{}", uid()),
    }
}

pub(crate) fn scope_or_err(category: &str) -> JobResult<&'static JobScope> {
    scope_for(category).ok_or_else(|| format!("Unknown category: {}", category))
}

// ── Process helpers ──────────────────────────────────────────────────

#[derive(Debug, Default)]
pub(crate) struct ExecResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// How long a hung child gets to die after SIGKILL before the caller moves on.
const REAP_GRACE: Duration = Duration::from_secs(2);

const TIMED_OUT: &str = "The command timed out.";

/// Spawn a command from an argument array and collect its output. No shell is involved.
/// `input` goes to the standard input. With a timeout, a hung child is killed AND reaped here, so that
/// it neither blocks the caller for ever nor stays behind as a zombie.
async fn run_command<S: AsRef<str>>(cmd: &[S], input: Option<&[u8]>, timeout: Option<Duration>) -> ExecResult {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut command = Command::new(cmd[0].as_ref());
    command
        .args(cmd[1..].iter().map(|a| a.as_ref()))
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return ExecResult { code: 127, stdout: String::new(), stderr: e.to_string() },
    };
    let (stdin, stdout, stderr) = (child.stdin.take(), child.stdout.take(), child.stderr.take());

    let feed = async move {
        if let (Some(mut stdin), Some(input)) = (stdin, input) {
            // A command that exits early closes the pipe. Its exit status tells the story.
            let _ = stdin.write_all(input).await;
            let _ = stdin.shutdown().await;
        } // dropping stdin sends EOF
    };
    async fn drain(pipe: Option<impl tokio::io::AsyncRead + Unpin>) -> Vec<u8> {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes).await;
        }
        bytes
    }
    // Feed and drain at the same time, so that no pipe can fill up and block.
    let finished = {
        let collect = async { tokio::join!(feed, drain(stdout), drain(stderr), child.wait()) };
        match timeout {
            Some(limit) => tokio::time::timeout(limit, collect).await.ok(),
            None => Some(collect.await),
        }
    };
    match finished {
        Some(((), stdout, stderr, Ok(status))) => ExecResult {
            code: status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).trim().to_string(),
        },
        Some(((), _, _, Err(e))) => ExecResult { code: 127, stdout: String::new(), stderr: e.to_string() },
        None => {
            // Timed out. SIGKILL, then wait: the wait reaps the child. The wait is bounded as well, for a
            // process that cannot die (uninterruptible sleep). tokio reaps that one later (kill_on_drop).
            let _ = child.start_kill();
            let _ = tokio::time::timeout(REAP_GRACE, child.wait()).await;
            ExecResult { code: -1, stdout: String::new(), stderr: TIMED_OUT.to_string() }
        }
    }
}

pub(crate) async fn run_with_timeout<S: AsRef<str>>(cmd: &[S], timeout: Option<Duration>) -> ExecResult {
    run_command(cmd, None, timeout).await
}

/// Like `run_with_timeout`, with `input` on the standard input of the command.
async fn run_with_stdin<S: AsRef<str>>(cmd: &[S], input: &[u8], timeout: Duration) -> ExecResult {
    run_command(cmd, Some(input), Some(timeout)).await
}

fn sh_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Step {
    cmd: Vec<String>,
    /// A failing tolerant step does not abort the script (e.g. bootout of a job that is not loaded).
    tolerant: bool,
}

fn step(cmd: &[&str]) -> Step {
    Step { cmd: cmd.iter().map(|s| s.to_string()).collect(), tolerant: false }
}

fn tolerant(cmd: &[&str]) -> Step {
    Step { tolerant: true, ..step(cmd) }
}

/// The `/bin/sh` script for the administrator prompt. Every argument is single-quoted.
/// A tolerant step is grouped as `{ cmd || true; }`, so that it cannot hide the failure of
/// an earlier step: in `a && b || true`, a failing `a` would still end with status 0.
fn privileged_script(steps: &[Step]) -> String {
    steps
        .iter()
        .map(|s| {
            let cmd = s.cmd.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
            if s.tolerant {
                format!("{{ {} || true; }}", cmd)
            } else {
                cmd
            }
        })
        .collect::<Vec<_>>()
        .join(" && ")
}

/// `stderr.replace(/^.*execution error: /, "")`
fn strip_execution_error(stderr: &str) -> &str {
    const MARKER: &str = "execution error: ";
    let first_line_end = stderr.find('\n').unwrap_or(stderr.len());
    match stderr[..first_line_end].rfind(MARKER) {
        Some(at) => &stderr[at + MARKER.len()..],
        None => stderr,
    }
}

fn explain_privileged_failure(stderr: &str) -> String {
    if stderr.contains("-128") || stderr.contains("User canceled") {
        return "Cancelled at the administrator prompt.".to_string();
    }
    let text = strip_execution_error(stderr);
    if text.is_empty() {
        "Privileged command failed.".to_string()
    } else {
        text.to_string()
    }
}

/// A label as it appears in the administrator prompt. It can come from a plist that any program
/// dropped into a scope directory, so it must not be able to restyle the dialog: one line, 80 characters.
pub(crate) fn prompt_label(label: &str) -> String {
    label.chars().filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}')).take(80).collect()
}

/// argv for `osascript`: every script line as an `-e` option, then `--`, then the items of `on run argv`.
/// Without `--`, osascript compiles an argument that starts with `-e` as AppleScript source. An item
/// like `-e do shell script "…"` would then run as code. Every osascript call of this crate is built here.
pub(crate) fn osascript_argv<'a>(script_lines: &[&'a str], args: &[&'a str]) -> Vec<&'a str> {
    let mut argv = vec![OSASCRIPT];
    for line in script_lines {
        argv.extend(["-e", *line]);
    }
    argv.push("--");
    argv.extend(args);
    argv
}

const PRIVILEGED_SCRIPT: [&str; 3] = [
    "on run argv",
    "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
    "end run",
];

/// Run shell steps as root behind the macOS administrator prompt. One prompt per call.
/// The script and the prompt are `argv` items, never part of the AppleScript source.
async fn run_privileged(steps: &[Step], prompt: &str) -> JobResult<()> {
    if steps.is_empty() {
        return Ok(());
    }
    let script = privileged_script(steps);
    // No timeout: the administrator prompt waits for the user.
    let result = run_with_timeout(&osascript_argv(&PRIVILEGED_SCRIPT, &[script.as_str(), prompt]), None).await;
    if result.code != 0 {
        return Err(explain_privileged_failure(&result.stderr));
    }
    Ok(())
}

/// One command as root behind the administrator prompt, for callers outside this file.
/// Every argument is single-quoted in the script, like all privileged steps.
pub(crate) async fn run_privileged_command(cmd: &[&str], prompt: &str) -> JobResult<()> {
    run_privileged(&[step(cmd)], prompt).await
}

// ── Job file index ───────────────────────────────────────────────────
// Parsed plists are cached by (mtime, size). rescan_jobs() is cheap: one readdir and
// one stat per file, and it only re-parses files that changed.

pub(crate) type FileMap = BTreeMap<String, Arc<JobFile>>;

struct JobIndex {
    files: Arc<FileMap>,
    /// False until the first scan. The first scan is the baseline and reports no changes.
    loaded: bool,
}

/// The async mutex also serializes scans: two scans never overlap.
static INDEX: LazyLock<tokio::sync::Mutex<JobIndex>> =
    LazyLock::new(|| tokio::sync::Mutex::new(JobIndex { files: Arc::new(FileMap::new()), loaded: false }));

/// Serializes the operations that change launchd state or job files.
static MUTATION: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn is_job_file_name(name: &str) -> bool {
    name.ends_with(".plist") || name.ends_with(".plist.disabled")
}

/// `fileName.replace(/\.plist(\.disabled)?$/, "")`
fn strip_job_extension(file_name: &str) -> &str {
    let name = file_name.strip_suffix(".disabled").filter(|n| n.ends_with(".plist")).unwrap_or(file_name);
    name.strip_suffix(".plist").unwrap_or(name)
}

fn c_path(path: &str) -> Option<CString> {
    CString::new(path.as_bytes()).ok()
}

/// Downloaded or AirDropped plists keep com.apple.quarantine, and launchd may refuse them.
fn is_quarantined(path: &str) -> bool {
    let (Some(c_path), Some(name)) = (c_path(path), c_path(QUARANTINE_XATTR)) else {
        return false;
    };
    // SAFETY: both strings are valid and NUL-terminated. A null buffer of size 0 only asks for the length.
    unsafe { libc::getxattr(c_path.as_ptr(), name.as_ptr(), std::ptr::null_mut(), 0, 0, 0) >= 0 }
}

fn remove_quarantine(path: &str) {
    if let (Some(c_path), Some(name)) = (c_path(path), c_path(QUARANTINE_XATTR)) {
        // SAFETY: both strings are valid and NUL-terminated. A missing attribute is not an error for the caller.
        unsafe { libc::removexattr(c_path.as_ptr(), name.as_ptr(), 0) };
    }
}

fn parse_job_file(path: &Path, size: u64) -> Option<Dictionary> {
    if size > MAX_PLIST_BYTES {
        return None;
    }
    Value::from_file(path).ok()?.into_dictionary()
}

fn scan_blocking(prev: &FileMap) -> (FileMap, Vec<JobFileChange>) {
    let dirs: Vec<(PathBuf, &'static JobScope)> = JOB_SCOPES.iter().map(|scope| (scope_dir(scope), scope)).collect();
    scan_dirs(prev, &dirs)
}

fn scan_dirs(prev: &FileMap, dirs: &[(PathBuf, &'static JobScope)]) -> (FileMap, Vec<JobFileChange>) {
    let mut next = FileMap::new();
    let mut changes = Vec::new();

    for (dir, scope) in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue; // missing or unreadable directory
        };
        for entry in entries.flatten() {
            let Ok(file_name) = entry.file_name().into_string() else {
                continue;
            };
            if !is_job_file_name(&file_name) {
                continue;
            }
            let path_buf = entry.path();
            let Some(path) = path_buf.to_str().map(str::to_string) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(&path_buf) else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let modified = meta.modified().ok();
            let size = meta.len();

            let previous = prev.get(&path);
            if let Some(p) = previous {
                if p.modified == modified && p.size == size {
                    next.insert(path, Arc::clone(p));
                    continue;
                }
            }

            let job = parse_job_file(&path_buf, size);
            let label = job
                .as_ref()
                .and_then(|j| j.get("Label"))
                .and_then(Value::as_string)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| strip_job_extension(&file_name).to_string());
            let file = Arc::new(JobFile {
                path: path.clone(),
                file_name,
                category: scope.category,
                label,
                modified,
                size,
                job,
                quarantined: scope.writable && is_quarantined(&path),
            });
            changes.push(JobFileChange {
                kind: if previous.is_some() { "modified" } else { "added" },
                file: Arc::clone(&file),
            });
            next.insert(path, file);
        }
    }

    resolve_label_collisions(&mut next, &mut changes);

    for (path, file) in prev.iter() {
        if !next.contains_key(path) {
            changes.push(JobFileChange { kind: "removed", file: Arc::clone(file) });
        }
    }
    (next, changes)
}

/// Contract rule 9: `(category, label)` is a unique key. macOS itself ships two files with one Label
/// (`com.apple.sysdiagnose.plist` and `com.apple.sysdiagnose.darwinos.plist`). The file named
/// `<Label>.plist` keeps the label, else the first by file name. Every other file is listed under its
/// file name without the extension.
fn resolve_label_collisions(files: &mut FileMap, changes: &mut [JobFileChange]) {
    let mut groups: HashMap<(&'static str, String), Vec<Arc<JobFile>>> = HashMap::new();
    for file in files.values() {
        groups.entry((file.category, file.label.clone())).or_default().push(Arc::clone(file));
    }
    for mut group in groups.into_values().filter(|group| group.len() > 1) {
        group.sort_by_cached_key(|file| label_sort_key(&file.file_name));
        let owner = group
            .iter()
            .find(|file| file.file_name == format!("{}.plist", file.label))
            .unwrap_or(&group[0])
            .clone();
        for file in group.iter().filter(|file| !Arc::ptr_eq(file, &owner)) {
            // A cached entry is shared with the previous index: replace it, never change it in place.
            let renamed = Arc::new(JobFile { label: strip_job_extension(&file.file_name).to_string(), ..JobFile::clone(file) });
            for change in changes.iter_mut().filter(|change| Arc::ptr_eq(&change.file, file)) {
                change.file = Arc::clone(&renamed);
            }
            files.insert(file.path.clone(), renamed);
        }
    }
}

/// Re-read the scope directories and report what changed since the previous scan.
/// Every scan after the baseline hands its changes to the job monitor, whoever triggered it.
pub async fn rescan_jobs() -> Vec<JobFileChange> {
    let mut index = INDEX.lock().await;
    let prev = Arc::clone(&index.files);
    let Ok((next, changes)) = tokio::task::spawn_blocking(move || scan_blocking(&prev)).await else {
        return Vec::new();
    };
    if !changes.is_empty() || !index.loaded {
        index.files = Arc::new(next);
    }
    let report = index.loaded && !changes.is_empty();
    index.loaded = true;
    if report {
        // Still under the index lock, so that events keep the order of the scans.
        crate::job_monitor::record(&changes).await;
    }
    changes
}

async fn ensure_index() {
    let loaded = INDEX.lock().await.loaded;
    if !loaded {
        rescan_jobs().await;
    }
}

pub(crate) async fn indexed_files() -> Arc<FileMap> {
    ensure_index().await;
    Arc::clone(&INDEX.lock().await.files)
}

pub(crate) async fn find_job_file(label: &str, category: &str) -> Option<Arc<JobFile>> {
    indexed_files()
        .await
        .values()
        .find(|f| f.label == label && f.category == category)
        .cloned()
}

// ── launchd state ────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ServiceState {
    pub pid: Option<i64>,
    pub status: Option<i64>,
}

#[derive(Default)]
struct DomainState {
    services: HashMap<String, ServiceState>,
    disabled: HashMap<String, bool>,
}

/// One line of the services block: `^\s*(\d+)\s+(-|-?\d+)\s+(.+)$`
fn parse_service_line(line: &str) -> Option<(String, ServiceState)> {
    let rest = line.trim_start();
    let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    if digits == 0 {
        return None;
    }
    let pid: i64 = rest[..digits].parse().ok()?;

    let after_pid = &rest[digits..];
    let rest = after_pid.trim_start();
    if rest.len() == after_pid.len() {
        return None; // no whitespace after the pid
    }

    let token_end = rest.find(char::is_whitespace)?;
    let token = &rest[..token_end];
    let status = if token == "-" {
        None
    } else {
        let magnitude = token.strip_prefix('-').unwrap_or(token);
        if magnitude.is_empty() || !magnitude.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        Some(token.parse::<i64>().ok()?)
    };

    let label = rest[token_end..].trim();
    if label.is_empty() {
        return None;
    }
    Some((label.to_string(), ServiceState { pid: (pid > 0).then_some(pid), status }))
}

/// The `services = { pid status label }` block of `launchctl print <domain>`.
/// pid 0 means not running, status "-" means never exited.
fn parse_services_block(printed: &str) -> HashMap<String, ServiceState> {
    let mut services = HashMap::new();
    let mut in_services = false;
    for line in printed.split('\n') {
        if !in_services {
            in_services = line == "\tservices = {";
            continue;
        }
        if line == "\t}" {
            break;
        }
        if let Some((label, state)) = parse_service_line(line) {
            services.insert(label, state);
        }
    }
    services
}

/// `^\s*"(.+)" => (disabled|enabled|true|false)$`
/// macOS 13+: "label" => disabled|enabled. Older: "label" => true|false (true = disabled).
fn parse_disabled_line(line: &str) -> Option<(String, bool)> {
    const ARROW: &str = "\" => ";
    let rest = line.trim_start().strip_prefix('"')?;
    let at = rest.rfind(ARROW)?;
    let label = &rest[..at];
    if label.is_empty() {
        return None;
    }
    let disabled = match &rest[at + ARROW.len()..] {
        "disabled" | "true" => true,
        "enabled" | "false" => false,
        _ => return None,
    };
    Some((label.to_string(), disabled))
}

fn parse_disabled(printed: &str) -> HashMap<String, bool> {
    printed.split('\n').filter_map(parse_disabled_line).collect()
}

/// The last good answer of launchd per domain. When `launchctl print` fails or times out, the jobs
/// keep their last known state for that tick. They do not all flip to "not loaded".
static LAST_DOMAIN_STATE: LazyLock<std::sync::Mutex<HashMap<String, Arc<DomainState>>>> =
    LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// The state of a domain from the two command results, or the last known one. None: launchd gave
/// no answer and there is no earlier one. Pure apart from the cache that it is handed.
fn resolve_domain_state(
    cache: &mut HashMap<String, Arc<DomainState>>,
    domain: &str,
    printed: &ExecResult,
    overrides: &ExecResult,
) -> Option<Arc<DomainState>> {
    let known = cache.get(domain).cloned();
    if printed.code != 0 {
        return known;
    }
    let disabled = match (overrides.code, &known) {
        (0, _) | (_, None) => parse_disabled(&overrides.stdout),
        (_, Some(known)) => known.disabled.clone(), // print-disabled failed: keep the known overrides
    };
    let state = Arc::new(DomainState { services: parse_services_block(&printed.stdout), disabled });
    cache.insert(domain.to_string(), Arc::clone(&state));
    Some(state)
}

async fn read_domain(domain: &str) -> Option<Arc<DomainState>> {
    let print = [LAUNCHCTL, "print", domain];
    let print_disabled = [LAUNCHCTL, "print-disabled", domain];
    let (printed, overrides) = tokio::join!(
        run_with_timeout(&print, Some(LAUNCHCTL_TIMEOUT)),
        run_with_timeout(&print_disabled, Some(LAUNCHCTL_TIMEOUT)),
    );
    let mut cache = LAST_DOMAIN_STATE.lock().unwrap_or_else(|e| e.into_inner());
    resolve_domain_state(&mut cache, domain, &printed, &overrides)
}

/// The override database of a domain: label → disabled.
async fn read_disabled(domain: &str) -> HashMap<String, bool> {
    parse_disabled(&run_with_timeout(&[LAUNCHCTL, "print-disabled", domain], Some(LAUNCHCTL_TIMEOUT)).await.stdout)
}

/// Last exit status of every loaded job that has a plist in a writable scope, for the monitor.
/// Inner None: the job never exited. Jobs that launchd does not know are left out.
/// Outer None: launchd gave no answer for a domain and there is no earlier one. The caller skips the pass.
pub(crate) async fn loaded_exit_statuses() -> Option<Vec<(Arc<JobFile>, Option<i64>)>> {
    let gui_domain = format!("gui/{}", uid());
    let (gui, system, files) = tokio::join!(read_domain(&gui_domain), read_domain("system"), indexed_files());
    let (gui, system) = (gui?, system?);

    Some(
        files
            .values()
            .filter_map(|file| {
                let scope = scope_for(file.category).filter(|s| s.writable)?;
                let domain = if scope.kind == ScopeKind::Daemon { &system } else { &gui };
                domain.services.get(&file.label).map(|state| (Arc::clone(file), state.status))
            })
            .collect(),
    )
}

fn status_of(state: Option<&ServiceState>) -> &'static str {
    match state {
        None => "stopped",
        Some(s) if s.pid.is_some() => "running",
        Some(s) if s.status.is_some_and(|code| code != 0) => "error",
        Some(_) => "stopped",
    }
}

/// StartCalendarInterval entries with their integer fields. A single dict becomes one entry.
fn calendar_fields(job: &Dictionary) -> Vec<BTreeMap<String, i64>> {
    calendar_entries(job.get("StartCalendarInterval"))
        .into_iter()
        .map(|entry| {
            entry
                .iter()
                .filter_map(|(key, value)| value.as_signed_integer().map(|n| (key.clone(), n)))
                .collect()
        })
        .collect()
}

/// Merge job files with the live state of the gui and system launchd domains.
pub async fn list_services() -> Vec<ServiceInfo> {
    let gui_domain = format!("gui/{}", uid());
    let (gui, system, files) = tokio::join!(read_domain(&gui_domain), read_domain("system"), indexed_files());
    let (gui, system) = (gui.unwrap_or_default(), system.unwrap_or_default());
    let (gui, system) = (&*gui, &*system);

    let mut services = Vec::with_capacity(files.len() + 64);
    let mut seen_gui: HashSet<&str> = HashSet::new();
    let mut seen_system: HashSet<&str> = HashSet::new();
    let empty = Dictionary::new();

    for file in files.values() {
        let Some(scope) = scope_for(file.category) else {
            continue;
        };
        let is_system = scope.kind == ScopeKind::Daemon;
        let domain_state = if is_system { system } else { gui };
        let state = domain_state.services.get(&file.label);
        if is_system {
            seen_system.insert(&file.label);
        } else {
            seen_gui.insert(&file.label);
        }

        let job = file.job.as_ref().unwrap_or(&empty);
        let args = job.get("ProgramArguments").and_then(Value::as_array).map(|items| {
            items.iter().filter_map(|a| a.as_string().map(str::to_string)).collect::<Vec<_>>()
        });
        let disabled = domain_state.disabled.get(&file.label).copied().unwrap_or_else(|| {
            file.file_name.ends_with(".disabled") || job.get("Disabled").and_then(Value::as_boolean) == Some(true)
        });

        services.push(ServiceInfo {
            label: file.label.clone(),
            pid: state.and_then(|s| s.pid),
            last_exit_status: state.and_then(|s| s.status),
            status: status_of(state),
            category: file.category.to_string(),
            plist_path: Some(file.path.clone()),
            program: job_executable(job),
            program_arguments: args,
            run_at_load: job.get("RunAtLoad").and_then(Value::as_boolean),
            enabled: !disabled,
            loaded: state.is_some(),
            disabled,
            triggers: describe_triggers(job),
            writable: scope.writable,
            needs_admin: scope.needs_admin,
            user_name: job.get("UserName").and_then(Value::as_string).map(str::to_string),
            unreadable: file.job.is_none(),
            quarantined: file.quarantined,
            start_interval: job.get("StartInterval").and_then(Value::as_signed_integer),
            calendar: calendar_fields(job),
        });
    }

    // Services launchd knows about that have no file in the scope directories
    // (XPC services, app-registered SMAppService jobs, running app instances).
    for (is_system, domain_state, seen) in [(false, gui, &seen_gui), (true, system, &seen_system)] {
        for (label, state) in &domain_state.services {
            if seen.contains(label.as_str()) {
                continue;
            }
            let category = if is_system {
                "system-daemons"
            } else if label.starts_with("com.apple.") || label.starts_with("application.") {
                "system-agents"
            } else {
                "user-agents"
            };
            let disabled = domain_state.disabled.get(label).copied().unwrap_or(false);
            services.push(ServiceInfo {
                label: label.clone(),
                pid: state.pid,
                last_exit_status: state.status,
                status: status_of(Some(state)),
                category: category.to_string(),
                plist_path: None,
                program: None,
                program_arguments: None,
                run_at_load: None,
                enabled: !disabled,
                loaded: true,
                disabled,
                triggers: Vec::new(),
                writable: false,
                needs_admin: is_system,
                user_name: None,
                unreadable: false,
                quarantined: false,
                start_interval: None,
                calendar: Vec::new(),
            });
        }
    }

    services.sort_by_cached_key(|s| label_sort_key(&s.label));
    services
}

/// `\benvironment = \{([^}]*)\}` and then `^(\S+)\s*=>\s*(.*)$` on every trimmed line.
fn parse_environment(printed: &str) -> BTreeMap<String, String> {
    const MARKER: &str = "environment = {";
    let mut environment = BTreeMap::new();

    let mut from = 0;
    let body = loop {
        let Some(found) = printed[from..].find(MARKER) else {
            return environment;
        };
        let at = from + found;
        let boundary = printed[..at].chars().next_back().is_none_or(|c| !(c.is_alphanumeric() || c == '_'));
        if boundary {
            let start = at + MARKER.len();
            match printed[start..].find('}') {
                Some(end) => break &printed[start..start + end],
                None => return environment,
            }
        }
        from = at + MARKER.len();
    };

    for line in body.split('\n') {
        let line = line.trim();
        let token_end = line.find(char::is_whitespace).unwrap_or(line.len());
        let (token, rest) = line.split_at(token_end);
        if token.is_empty() {
            continue;
        }
        let rest = rest.trim_start();
        if let Some(value) = rest.strip_prefix("=>") {
            environment.insert(token.to_string(), value.trim_start().to_string());
        } else if let Some(arrow) = token.rfind("=>").filter(|at| *at > 0) {
            // "KEY=>value" without spaces around the arrow
            let value = format!("{}{}", &token[arrow + 2..], &line[token_end..]);
            environment.insert(token[..arrow].to_string(), value.trim_start().to_string());
        }
    }
    environment
}

fn parse_service_detail(printed: &str, domain: &str) -> ServiceDetail {
    let mut detail = ServiceDetail {
        domain: domain.to_string(),
        raw: printed.to_string(),
        environment: parse_environment(printed),
        ..ServiceDetail::default()
    };
    for line in printed.split('\n') {
        let trimmed = line.trim();
        let fields: [(&str, &mut Option<String>); 5] = [
            ("path = ", &mut detail.path),
            ("type = ", &mut detail.r#type),
            ("bundle id = ", &mut detail.bundle_id),
            ("state = ", &mut detail.state),
            ("last exit reason = ", &mut detail.last_exit_reason),
        ];
        for (prefix, field) in fields {
            if field.is_none() {
                if let Some(value) = trimmed.strip_prefix(prefix) {
                    *field = Some(value.to_string());
                }
            }
        }
    }
    detail
}

pub async fn get_service_detail(label: &str, category: &str) -> JobResult<Option<ServiceDetail>> {
    let scope = scope_or_err(category)?;
    if !is_valid_target_label(label) {
        return Err("Invalid label.".to_string());
    }
    let domain = domain_for(scope);
    let printed = run_with_timeout(&[LAUNCHCTL, "print", &format!("{}/{}", domain, label)], Some(LAUNCHCTL_TIMEOUT)).await;
    if printed.code != 0 || printed.stdout.is_empty() {
        return Ok(None);
    }
    Ok(Some(parse_service_detail(&printed.stdout, &domain)))
}

// ── Actions ──────────────────────────────────────────────────────────

/// Steps for one action. Tolerant steps may fail without failing the action.
fn action_steps(action: &str, label: &str, domain: &str, plist: Option<&str>, loaded: bool) -> JobResult<Vec<Step>> {
    let target = format!("{}/{}", domain, label);
    let bootstrap_if_needed: Vec<Step> = match plist {
        Some(path) if !loaded => vec![step(&[LAUNCHCTL, "bootstrap", domain, path])],
        _ => Vec::new(),
    };

    Ok(match action {
        "start" => [bootstrap_if_needed, vec![step(&[LAUNCHCTL, "kickstart", &target])]].concat(),
        "restart" => [bootstrap_if_needed, vec![step(&[LAUNCHCTL, "kickstart", "-k", &target])]].concat(),
        "stop" => vec![step(&[LAUNCHCTL, "kill", "SIGTERM", &target])],
        "load" => {
            let Some(path) = plist else {
                return Err("This service has no plist file to load.".to_string());
            };
            if loaded {
                return Err("The job is already loaded.".to_string());
            }
            vec![step(&[LAUNCHCTL, "bootstrap", domain, path])]
        }
        "unload" => vec![step(&[LAUNCHCTL, "bootout", &target])],
        "enable" => [vec![step(&[LAUNCHCTL, "enable", &target])], bootstrap_if_needed].concat(),
        "disable" => {
            let mut steps = Vec::new();
            if loaded {
                steps.push(tolerant(&[LAUNCHCTL, "bootout", &target]));
            }
            steps.push(step(&[LAUNCHCTL, "disable", &target]));
            steps
        }
        other => return Err(format!("Unknown action: {}", other)),
    })
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// `/: 5\b/`
fn mentions_error_5(text: &str) -> bool {
    text.match_indices(": 5").any(|(at, m)| {
        text[at + m.len()..].chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
    })
}

fn explain_launchctl_error(result: &ExecResult) -> String {
    let text = if result.stderr.is_empty() { result.stdout.trim() } else { result.stderr.as_str() };
    if contains_ignore_case(text, "Operation not permitted") || contains_ignore_case(text, "Not privileged") {
        return "Not permitted. macOS protects this service (SIP) or it needs administrator rights.".to_string();
    }
    if contains_ignore_case(text, "Could not find service") {
        return "launchd does not know this service. Load it first.".to_string();
    }
    if text.contains("Input/output error") || mentions_error_5(text) {
        return "launchd rejected the job (error 5). Check that it is not already loaded, not disabled, and that the plist is valid.".to_string();
    }
    if text.is_empty() {
        format!("launchctl exited with code {}", result.code)
    } else {
        text.to_string()
    }
}

/// These actions bootstrap a job that is not loaded, and launchd refuses to bootstrap a disabled job.
fn needs_enabled_job(action: &str) -> bool {
    matches!(action, "start" | "restart" | "load")
}

async fn is_loaded(domain: &str, label: &str) -> bool {
    run_with_timeout(&[LAUNCHCTL, "print", &format!("{}/{}", domain, label)], Some(LAUNCHCTL_TIMEOUT)).await.code == 0
}

pub async fn manage_service(label: &str, category: &str, action: &str) -> JobResult<()> {
    if !SERVICE_ACTIONS.contains(&action) {
        return Err(format!("Unknown action: {}", action));
    }
    let scope = scope_or_err(category)?;
    if !is_valid_target_label(label) {
        return Err("Invalid label.".to_string());
    }
    let _guard = MUTATION.lock().await;

    let domain = domain_for(scope);
    let mut file = find_job_file(label, category).await;

    // A job switched off by renaming its file needs the original name back before it can load.
    if action == "enable" {
        if let Some(disabled_file) = file.as_ref().filter(|f| f.file_name.ends_with(".disabled")) {
            let restored = disabled_file.path.strip_suffix(".disabled").unwrap_or(&disabled_file.path).to_string();
            if Path::new(&restored).exists() {
                return Err(format!("Cannot enable the job: {} already exists.", restored));
            }
            if scope.needs_admin {
                run_privileged(
                    &[step(&["/bin/mv", &disabled_file.path, &restored])],
                    &format!("mac-dash wants to enable \"{}\".", prompt_label(label)),
                )
                .await?;
            } else {
                tokio::fs::rename(&disabled_file.path, &restored).await.map_err(|e| e.to_string())?;
            }
            rescan_jobs().await;
            file = find_job_file(label, category).await;
        }
    }

    let loaded = is_loaded(&domain, label).await;
    if needs_enabled_job(action) && !loaded && read_disabled(&domain).await.get(label) == Some(&true) {
        // bootstrap of a disabled job fails with the unhelpful "error 5"
        return Err("The job is disabled. Enable it first.".to_string());
    }
    let steps = action_steps(action, label, &domain, file.as_ref().map(|f| f.path.as_str()), loaded)?;
    if domain == "system" {
        run_privileged(&steps, &format!("mac-dash wants to {} the daemon \"{}\".", action, prompt_label(label))).await?;
    } else {
        for s in &steps {
            let result = run_with_timeout(&s.cmd, Some(ACTION_TIMEOUT)).await;
            if result.code != 0 && !s.tolerant {
                return Err(explain_launchctl_error(&result));
            }
        }
    }
    Ok(())
}

// ── Job documents ────────────────────────────────────────────────────

/// The file as XML text. XML files are returned unchanged, binary plists are converted.
pub(crate) fn read_plist_xml(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if !bytes.starts_with(b"bplist") {
        return Some(String::from_utf8_lossy(&bytes).into_owned());
    }
    let value: Value = plist::from_bytes(&bytes).ok()?;
    let mut xml = Vec::new();
    plist::to_writer_xml(&mut xml, &value).ok()?;
    String::from_utf8(xml).ok()
}

/// The label is only compared with the labels of the directory scan, so any text is safe here.
/// The path always comes from the scan.
pub async fn read_job(label: &str, category: &str) -> JobResult<Option<JobDocument>> {
    let scope = scope_or_err(category)?;
    let Some(file) = find_job_file(label, category).await else {
        return Ok(None);
    };
    let path = PathBuf::from(&file.path);
    let Ok(Some(xml)) = tokio::task::spawn_blocking(move || read_plist_xml(&path)).await else {
        return Ok(None);
    };
    Ok(Some(JobDocument {
        label: file.label.clone(),
        category: category.to_string(),
        path: file.path.clone(),
        file_name: file.file_name.clone(),
        xml,
        writable: scope.writable,
        needs_admin: scope.needs_admin,
        mtime: file.mtime_ms(),
    }))
}

/// Label part of a backup file name, or None when the name is not a revision.
/// `^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.plist$`
pub(crate) fn revision_label(file_name: &str) -> Option<&str> {
    const STAMP: &[u8] = b"dddd-dd-ddTdd-dd-dd-dddZ";
    let stem = file_name.strip_suffix(".plist")?;
    let split = stem.len().checked_sub(STAMP.len())?;
    if !stem.is_char_boundary(split) {
        return None;
    }
    let (head, stamp) = stem.split_at(split);
    let stamp_matches = stamp.bytes().zip(STAMP).all(|(byte, pattern)| match pattern {
        b'd' => byte.is_ascii_digit(),
        other => byte == *other,
    });
    let label = head.strip_suffix('-')?;
    let one_line = !label.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    (stamp_matches && !label.is_empty() && one_line).then_some(label)
}

/// A Label read from a plist is untrusted text: any file in a scope directory supplies one.
/// Reduce it to one safe path component before it becomes part of a file name.
/// Same result as `safeFileName()` in the Bun server, so both backends share the backup folder:
/// every character outside `[A-Za-z0-9._-]` becomes `_` (one per UTF-16 unit, like the JS regex),
/// leading dots become one `_`, at most 200 characters, never empty.
pub(crate) fn safe_file_name(label: &str) -> String {
    let mut name = String::with_capacity(label.len());
    for c in label.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            name.push(c);
        } else {
            name.extend(std::iter::repeat_n('_', c.len_utf16()));
        }
    }
    let without_dots = name.trim_start_matches('.');
    let mut name = if without_dots.len() == name.len() { name } else { format!("_{}", without_dots) };
    name.truncate(200); // ASCII only at this point, so this cannot split a character
    if name.is_empty() {
        name.push('_');
    }
    name
}

fn backup_blocking(source: &Path, label: &str) -> std::io::Result<()> {
    let dir = backup_dir();
    create_private_dir(&dir)?;
    let name = safe_file_name(label);
    // Same shape as `new Date().toISOString().replace(/[:.]/g, "-")`, so both backends share the folder.
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ");
    let dest = dir.join(format!("{}-{}.plist", name, stamp));
    // The name is one component by construction. Refuse anything else instead of trusting it.
    if dest.parent() != Some(dir.as_path()) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "backup name is not a file name"));
    }
    std::fs::copy(source, dest)?;

    // Keep the newest revisions of this label. The timestamp makes the names sort by age.
    let mut mine: Vec<String> = std::fs::read_dir(&dir)?
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|file_name| revision_label(file_name) == Some(name.as_str()))
        .collect();
    mine.sort();
    let surplus = mine.len().saturating_sub(MAX_BACKUPS_PER_JOB);
    for old in &mine[..surplus] {
        let _ = std::fs::remove_file(dir.join(old));
    }
    Ok(())
}

/// Every overwrite and delete keeps a copy in `~/.macdash/backups`. Returns false when the copy failed.
async fn backup_job_file(file: &Arc<JobFile>) -> bool {
    let file = Arc::clone(file);
    tokio::task::spawn_blocking(move || backup_blocking(Path::new(&file.path), &file.label).is_ok())
        .await
        .unwrap_or(false)
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// A free path in `~/.Trash` for a file that is no job plist: `<name>`, else `<name> <timestamp>`.
pub(crate) fn free_trash_path(file_name: &str) -> PathBuf {
    let trash = home_dir().join(".Trash");
    let candidate = trash.join(file_name);
    match std::fs::symlink_metadata(&candidate) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => candidate,
        _ => trash.join(format!("{} {}", file_name, now_ms())),
    }
}

/// A free path in `~/.Trash` for this file name.
fn trash_path(file_name: &str) -> String {
    let trash = home_dir().join(".Trash");
    let candidate = trash.join(file_name);
    let taken = match std::fs::symlink_metadata(&candidate) {
        Ok(_) => true,
        // macOS can refuse to look inside the Trash. Then the state of the name is unknown.
        Err(e) => e.kind() != std::io::ErrorKind::NotFound,
    };
    let path = if taken {
        trash.join(format!("{} {}.plist", strip_job_extension(file_name), now_ms()))
    } else {
        candidate
    };
    path.to_string_lossy().into_owned()
}

/// Move the file to the Trash. Without the Trash, the backup copy is the safety net.
fn move_to_trash(file: &JobFile, has_backup: bool) -> Result<(), String> {
    let dest = trash_path(&file.file_name);
    if std::fs::rename(&file.path, &dest).is_ok() {
        return Ok(());
    }
    // Different volume, or macOS privacy protection (TCC) denies access to ~/.Trash.
    if std::fs::copy(&file.path, &dest).is_err() && !has_backup {
        return Err("Could not move the file to the Trash and could not back it up. Nothing was deleted.".to_string());
    }
    std::fs::remove_file(&file.path).map_err(|e| format!("Could not remove {}: {}", file.path, e))
}

fn staging_path(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_owned();
    name.push(STAGING_SUFFIX);
    PathBuf::from(name)
}

/// Write a job file without privileges: a new file next to the target, then a rename.
/// The rename is atomic, and a symlink planted at the target is replaced instead of followed.
/// `create_new` (O_EXCL) never opens something that already sits at the staging path.
fn write_job_file(dest: &Path, xml: &str) -> std::io::Result<()> {
    use std::io::Write;

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let staging = staging_path(dest);
    let create = || std::fs::OpenOptions::new().write(true).create_new(true).mode(0o644).open(&staging);
    let mut file = match create() {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            std::fs::remove_file(&staging)?; // left over from a crash, or planted: remove the name, never follow it
            create()?
        }
        other => other?,
    };
    let written = file
        .write_all(xml.as_bytes())
        // fchmod on the open file: the umask must not decide, and no path is resolved again
        .and_then(|_| file.set_permissions(std::fs::Permissions::from_mode(0o644)))
        .and_then(|_| file.sync_all());
    drop(file);
    let result = written.and_then(|_| std::fs::rename(&staging, dest));
    if result.is_err() {
        let _ = std::fs::remove_file(&staging);
    }
    result
}

/// root writes `xml` to `dest`. The text travels inside the script: `$0` is the base64 plist and
/// `$1` the staging file. Nothing that the user could swap while the administrator prompt is open
/// is read on the root side. `dest` must be in a root-owned directory.
fn privileged_write_steps(xml: &str, dest: &str, owner: &str) -> Vec<Step> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(xml.as_bytes());
    let staging = format!("{}{}", dest, STAGING_SUFFIX);
    vec![
        step(&["/bin/sh", "-c", "printf %s \"$0\" | /usr/bin/base64 -D > \"$1\"", &encoded, &staging]),
        step(&["/usr/sbin/chown", owner, &staging]),
        step(&["/bin/chmod", "644", &staging]),
        step(&["/bin/mv", "-f", &staging, dest]),
    ]
}

/// Root never writes into a folder the user controls: `~/.Trash` could be swapped for a symlink while
/// the administrator prompt is open. For a root-owned job the app copies the world-readable file to the
/// Trash itself, and the root script only removes the original.
/// Returns the copy, or None when the copy failed and the backup in `~/.macdash/backups` is the safety net.
fn copy_to_trash(file: &JobFile, has_backup: bool) -> Result<Option<PathBuf>, String> {
    let dest = PathBuf::from(trash_path(&file.file_name));
    match copy_exclusive(Path::new(&file.path), &dest) {
        Ok(()) => Ok(Some(dest)),
        Err(_) if has_backup => Ok(None),
        Err(_) => Err("Could not copy the file to the Trash and could not back it up. Nothing was deleted.".to_string()),
    }
}

/// Copy to a name that must not exist yet. `create_new` (O_EXCL) never writes through a file
/// or a symlink that appeared at the name.
fn copy_exclusive(source: &Path, dest: &Path) -> std::io::Result<()> {
    copy_exclusive_with_mode(source, dest, 0o644)
}

/// `mode` is set on the open file, so the umask does not decide. Callers pass no setuid or setgid bit.
pub(crate) fn copy_exclusive_with_mode(source: &Path, dest: &Path, mode: u32) -> std::io::Result<()> {
    let mut source = std::fs::File::open(source)?;
    let mut target = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dest)?;
    let copied = std::io::copy(&mut source, &mut target)
        .and_then(|_| target.set_permissions(std::fs::Permissions::from_mode(mode & 0o777)))
        .and_then(|_| target.sync_all());
    if copied.is_err() {
        let _ = std::fs::remove_file(dest); // our own half-written file
    }
    copied
}

/// The root script failed or was cancelled, so the original is still in place: take our copy back.
pub(crate) fn discard_trash_copy(copy: Option<PathBuf>) {
    if let Some(path) = copy {
        let _ = std::fs::remove_file(path);
    }
}

/// root unloads a job and removes its file from `/Library`. The Trash copy was made by the app before.
fn privileged_remove_steps(bootout: Option<&str>, path: &str) -> Vec<Step> {
    let mut steps: Vec<Step> = bootout.iter().map(|target| tolerant(&[LAUNCHCTL, "bootout", target])).collect();
    steps.push(step(&["/bin/rm", "-f", path]));
    steps
}

/// A save whose target is in `/Library`. root only touches root-owned folders.
struct PrivilegedSave<'a> {
    xml: &'a str,
    dest: &'a str,
    domain: &'a str,
    load: bool,
    /// launchctl target of the job that is replaced, when it must be unloaded.
    bootout: Option<&'a str>,
    /// The original file, when it moved and lives in `/Library` too.
    remove_original: Option<&'a str>,
}

/// One root script, in the order of the contract:
/// bootout, write (0644, root:wheel), remove the old file, clear the quarantine flag, bootstrap.
fn privileged_save_steps(save: &PrivilegedSave) -> Vec<Step> {
    let mut steps = Vec::new();
    if let Some(target) = save.bootout {
        steps.push(tolerant(&[LAUNCHCTL, "bootout", target]));
    }
    steps.extend(privileged_write_steps(save.xml, save.dest, "root:wheel"));
    if let Some(original) = save.remove_original {
        steps.push(step(&["/bin/rm", "-f", original]));
    }
    steps.push(tolerant(&[XATTR, "-d", QUARANTINE_XATTR, save.dest]));
    if save.load {
        steps.push(tolerant(&[LAUNCHCTL, "bootstrap", save.domain, save.dest]));
    }
    steps
}

/// What a save does to the job it replaces.
#[derive(Debug, PartialEq, Eq)]
struct SavePlan {
    /// Bootstrap the new file.
    load: bool,
    /// The path changes (rename or other scope): the old file goes to the Trash.
    moved: bool,
    /// Unload the original. "Save only" of the same path leaves a running job alone.
    bootout_original: bool,
    /// The old file is in `/Library`: the app copies it to the Trash and root removes it.
    root_removes_original: bool,
}

fn plan_save(request_load: Option<bool>, job_disabled: bool, dest: &str, original: Option<(&str, &JobScope)>) -> SavePlan {
    let load = request_load != Some(false) && !job_disabled;
    let moved = original.is_some_and(|(path, _)| path != dest);
    SavePlan {
        load,
        moved,
        bootout_original: original.is_some() && (moved || load),
        root_removes_original: moved && original.is_some_and(|(_, scope)| scope.needs_admin),
    }
}

pub async fn save_job(req: SaveJobRequest) -> JobResult<SavedJob> {
    let scope = scope_for(&req.category).filter(|s| s.writable).ok_or("This scope is read-only.")?;
    if req.xml.len() > MAX_XML_BYTES {
        return Err("Invalid plist document.".to_string());
    }

    let job = Value::from_reader_xml(std::io::Cursor::new(req.xml.as_bytes()))
        .map_err(|e| format!("Invalid plist document: {}", e))?
        .into_dictionary()
        .ok_or("Root element must be a <dict>")?;
    // The Label becomes the new file name, so LABEL_PATTERN is mandatory here.
    let label = job
        .get("Label")
        .and_then(Value::as_string)
        .filter(|l| is_valid_label(l))
        .ok_or("Label is missing or contains characters other than letters, digits, dots, dashes and underscores.")?
        .to_string();

    let _guard = MUTATION.lock().await;

    // The original is found through the directory scan. Its label is only compared, never used as a path.
    let original = match &req.original {
        Some(reference) => {
            let original_scope = scope_or_err(&reference.category)?;
            let file = find_job_file(&reference.label, &reference.category)
                .await
                .ok_or("The job being edited no longer exists on disk.")?;
            if !original_scope.writable {
                return Err("The original job is read-only. Duplicate it instead.".to_string());
            }
            Some((file, original_scope))
        }
        None => None,
    };
    let original_path = original.as_ref().map(|(file, _)| file.path.as_str());

    let dest_path = scope_dir(scope).join(format!("{}.plist", label));
    let dest = dest_path.to_string_lossy().into_owned();
    if let Some(existing) = find_job_file(&label, &req.category).await {
        if Some(existing.path.as_str()) != original_path {
            return Err(format!("A job with the label \"{}\" already exists in {}.", label, scope.title));
        }
    }
    if Some(dest.as_str()) != original_path && std::fs::symlink_metadata(&dest_path).is_ok() {
        return Err(format!("A file named \"{}.plist\" already exists in {}.", label, scope.title));
    }

    // Lint from memory. The checked text never sits in a file that another process could swap
    // while the administrator prompt is open.
    let lint = run_with_stdin(&[PLUTIL, "-lint", "-"], req.xml.as_bytes(), LAUNCHCTL_TIMEOUT).await;
    if lint.code != 0 {
        let reason = if lint.stdout.trim().is_empty() { lint.stderr.as_str() } else { lint.stdout.trim() };
        return Err(format!("plutil rejected the plist: {}", reason));
    }
    if scope.needs_admin && req.xml.len() > MAX_PRIVILEGED_XML_BYTES {
        return Err("The plist is too large for a privileged save (200 KB).".to_string());
    }

    let job_disabled = job.get("Disabled").and_then(Value::as_boolean) == Some(true);
    let plan = plan_save(req.load, job_disabled, &dest, original.as_ref().map(|(f, s)| (f.path.as_str(), *s)));

    let has_backup = match &original {
        Some((file, _)) => backup_job_file(file).await,
        None => false,
    };

    let domain = domain_for(scope);
    let original_domain = original.as_ref().map(|(_, s)| domain_for(s));
    // The label of the original comes from its plist. launchctl only gets it when it is a plain target.
    let original_target = original
        .as_ref()
        .filter(|(file, _)| is_valid_target_label(&file.label))
        .map(|(file, original_scope)| format!("{}/{}", domain_for(original_scope), file.label));
    let moved_file = if plan.moved { original.as_ref().map(|(file, _)| Arc::clone(file)) } else { None };

    if scope.needs_admin {
        // Target in /Library: root writes it. root only touches root-owned folders.
        let root_removed = if plan.root_removes_original { moved_file.clone() } else { None };
        let trash_copy = match &root_removed {
            Some(file) => {
                let file = Arc::clone(file);
                tokio::task::spawn_blocking(move || copy_to_trash(&file, has_backup)).await.map_err(|e| e.to_string())??
            }
            None => None,
        };
        let steps = privileged_save_steps(&PrivilegedSave {
            xml: &req.xml,
            dest: &dest,
            domain: &domain,
            load: plan.load,
            bootout: original_target.as_deref().filter(|_| plan.bootout_original),
            remove_original: root_removed.as_ref().map(|file| file.path.as_str()),
        });
        let prompt = format!("mac-dash wants to save the job \"{}\" to {}.", prompt_label(&label), scope.title);
        if let Err(e) = run_privileged(&steps, &prompt).await {
            discard_trash_copy(trash_copy);
            return Err(e);
        }
        // An original in the user's own folder: the app moves it, without privileges.
        if let Some(file) = moved_file.filter(|_| !plan.root_removes_original) {
            let moved = tokio::task::spawn_blocking(move || move_to_trash(&file, has_backup)).await.map_err(|e| e.to_string())?;
            if let Err(e) = moved {
                rescan_jobs().await;
                return Err(e);
            }
        }
        // bootstrap is a tolerant step of the script, so its failure shows only here.
        if plan.load && !is_loaded(&domain, &label).await {
            rescan_jobs().await;
            return Err("Saved, but launchd did not load the job: check that it is not disabled and that the plist is valid.".to_string());
        }
    } else {
        // Target in the user's own folder: the app writes it. root never writes where the user can plant a symlink.
        if let Some(target) = original_target.as_deref().filter(|_| plan.bootout_original && original_domain.as_deref() != Some("system")) {
            run_with_timeout(&[LAUNCHCTL, "bootout", target], Some(ACTION_TIMEOUT)).await;
        }
        let (target, xml) = (dest_path.clone(), req.xml.clone());
        // An original in the user's folder goes to the Trash right here. One in /Library needs root, below.
        let trash_here = if plan.root_removes_original { None } else { moved_file.clone() };
        let written = tokio::task::spawn_blocking(move || -> Result<(), String> {
            write_job_file(&target, &xml).map_err(|e| format!("Could not write {}: {}", target.display(), e))?;
            remove_quarantine(&target.to_string_lossy());
            match trash_here {
                Some(file) => move_to_trash(&file, has_backup),
                None => Ok(()),
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Err(e) = written {
            rescan_jobs().await;
            return Err(e);
        }

        if let Some((file, original_scope)) = original.as_ref().filter(|_| plan.root_removes_original) {
            // The job left /Library: root unloads it and removes the original. The Trash copy is ours.
            let copied = Arc::clone(file);
            let trash_copy =
                tokio::task::spawn_blocking(move || copy_to_trash(&copied, has_backup)).await.map_err(|e| e.to_string())?;
            let removed = match trash_copy {
                Ok(trash_copy) => {
                    let steps = privileged_remove_steps(original_target.as_deref(), &file.path);
                    let prompt = format!(
                        "mac-dash wants to move the job \"{}\" out of {}.",
                        prompt_label(&file.label),
                        original_scope.title
                    );
                    run_privileged(&steps, &prompt).await.inspect_err(|_| discard_trash_copy(trash_copy))
                }
                Err(e) => Err(e),
            };
            if let Err(e) = removed {
                rescan_jobs().await;
                return Err(e);
            }
        }

        if plan.load {
            let result = run_with_timeout(&[LAUNCHCTL, "bootstrap", &domain, &dest], Some(ACTION_TIMEOUT)).await;
            if result.code != 0 {
                rescan_jobs().await;
                return Err(format!(
                    "Saved, but launchd did not load the job: {}",
                    explain_launchctl_error(&result)
                ));
            }
        }
    }

    rescan_jobs().await;
    Ok(SavedJob { label, path: dest })
}

pub async fn delete_job(label: &str, category: &str) -> JobResult<()> {
    let scope = scope_for(category).filter(|s| s.writable).ok_or("This scope is read-only.")?;
    let _guard = MUTATION.lock().await;
    // The file comes from the directory scan. The label is only compared with the scan.
    let file = find_job_file(label, category).await.ok_or("Job file not found.")?;

    let has_backup = backup_job_file(&file).await;
    // A label that is not a plain launchctl target cannot be unloaded by name. The file still goes.
    let target = is_valid_target_label(&file.label).then(|| format!("{}/{}", domain_for(scope), file.label));
    if scope.needs_admin {
        let copied = Arc::clone(&file);
        let trash_copy =
            tokio::task::spawn_blocking(move || copy_to_trash(&copied, has_backup)).await.map_err(|e| e.to_string())??;
        let steps = privileged_remove_steps(target.as_deref(), &file.path);
        let prompt = format!("mac-dash wants to move the job \"{}\" to the Trash.", prompt_label(&file.label));
        if let Err(e) = run_privileged(&steps, &prompt).await {
            discard_trash_copy(trash_copy);
            return Err(e);
        }
    } else {
        if let Some(target) = &target {
            run_with_timeout(&[LAUNCHCTL, "bootout", target], Some(ACTION_TIMEOUT)).await;
        }
        let trashed = Arc::clone(&file);
        tokio::task::spawn_blocking(move || move_to_trash(&trashed, has_backup))
            .await
            .map_err(|e| e.to_string())??;
    }
    rescan_jobs().await;
    Ok(())
}

/// The last `lines` lines of `text` (1 to 5000). `cut` says that the text starts in the middle of a line.
/// Returns the tail, without the final newline, and whether lines were dropped.
fn tail_lines(text: &str, cut: bool, lines: i64) -> (String, bool) {
    let mut all: Vec<&str> = text.strip_suffix('\n').unwrap_or(text).split('\n').collect();
    if cut && all.len() > 1 {
        all.remove(0); // the first line is cut in the middle
    }
    let count = lines.clamp(1, 5000) as usize;
    let skip = all.len().saturating_sub(count);
    (all[skip..].join("\n"), skip > 0)
}

fn read_tail(path: &str, lines: i64) -> Option<JobOutput> {
    // Only regular files: opening a FIFO or a device would block or never end.
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let length = size.min(MAX_OUTPUT_BYTES);
    file.seek(SeekFrom::Start(size - length)).ok()?;
    let mut buffer = Vec::with_capacity(length as usize);
    file.take(length).read_to_end(&mut buffer).ok()?;

    let (text, dropped) = tail_lines(&String::from_utf8_lossy(&buffer), size > length, lines);
    Some(JobOutput { path: Some(path.to_string()), exists: true, size, truncated: size > length || dropped, text })
}

/// Tail of the job's StandardOutPath or StandardErrorPath. The path always comes from the plist.
pub async fn read_job_output(label: &str, category: &str, stream: &str, lines: Option<i64>) -> JobResult<JobOutput> {
    scope_or_err(category)?;
    let key = match stream {
        "stdout" => "StandardOutPath",
        "stderr" => "StandardErrorPath",
        other => return Err(format!("Unknown stream: {}", other)),
    };
    let file = find_job_file(label, category).await;
    let path = file
        .as_ref()
        .and_then(|f| f.job.as_ref())
        .and_then(|job| job.get(key))
        .and_then(Value::as_string)
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    let empty = JobOutput { path: path.clone(), exists: false, size: 0, truncated: false, text: String::new() };
    let Some(path) = path else {
        return Ok(empty);
    };
    let lines = lines.unwrap_or(200);
    let output = tokio::task::spawn_blocking(move || read_tail(&path, lines)).await.ok().flatten();
    Ok(output.unwrap_or(empty))
}

fn path_facts(path: String) -> PathFacts {
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let executable = CString::new(path.as_bytes())
                // SAFETY: `c` is a valid NUL-terminated string that lives for the whole call.
                .map(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
                .unwrap_or(false);
            PathFacts { path, exists: true, is_file: meta.is_file(), is_directory: meta.is_dir(), executable }
        }
        Err(_) => PathFacts { path, exists: false, is_file: false, is_directory: false, executable: false },
    }
}

/// Filesystem facts for the validation in the client. Absolute paths only, at most 64.
pub async fn check_paths(paths: Vec<String>) -> Vec<PathFacts> {
    let mut seen = HashSet::new();
    let unique: Vec<String> = paths
        .into_iter()
        .filter(|p| p.starts_with('/') && !p.contains('\0'))
        .filter(|p| seen.insert(p.clone()))
        .take(64)
        .collect();
    tokio::task::spawn_blocking(move || unique.into_iter().map(path_facts).collect())
        .await
        .unwrap_or_default()
}

pub async fn reveal_job(label: &str, category: &str) -> JobResult<()> {
    scope_or_err(category)?;
    let file = find_job_file(label, category).await.ok_or("Job file not found.")?;
    let result = run_with_timeout(&[OPEN, "-R", &file.path], Some(LAUNCHCTL_TIMEOUT)).await;
    if result.code == 0 {
        Ok(())
    } else if result.stderr.is_empty() {
        Err("Could not open Finder.".to_string())
    } else {
        Err(result.stderr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRINT_GUI: &str = "gui/501 = {\n\ttype = user\n\thandle = 501\n\tactive count = 3\n\tservice count = 3\n\n\tservices = {\n\t\t     0      -  \tcom.apple.never-ran\n\t\t   593      - \tcom.apple.Finder\n\t\t     0     78 \tcom.example.broken\n\t\t     0     -9 \tcom.example.killed\n\t\t 12345      0 \tapplication.com.apple.Safari.1152921500311879999.1152921500311880003\n\t\t     0      0 \tcom.example.clean\n\t\tnot a service line\n\t}\n\n\tunmanaged processes = {\n\t\t   700      - \tcom.example.unmanaged\n\t}\n}\n";

    #[test]
    fn services_block() {
        let services = parse_services_block(PRINT_GUI);
        assert_eq!(services.len(), 6);
        assert_eq!(services["com.apple.never-ran"], ServiceState { pid: None, status: None });
        assert_eq!(services["com.apple.Finder"], ServiceState { pid: Some(593), status: None });
        assert_eq!(services["com.example.broken"], ServiceState { pid: None, status: Some(78) });
        assert_eq!(services["com.example.killed"], ServiceState { pid: None, status: Some(-9) });
        assert_eq!(services["com.example.clean"], ServiceState { pid: None, status: Some(0) });
        assert!(services.contains_key("application.com.apple.Safari.1152921500311879999.1152921500311880003"));
        // Lines after the closing brace of the block do not count.
        assert!(!services.contains_key("com.example.unmanaged"));
    }

    #[test]
    fn services_block_missing() {
        assert!(parse_services_block("Could not find domain for user gui: 501\n").is_empty());
        assert!(parse_services_block("").is_empty());
    }

    #[test]
    fn service_lines() {
        assert_eq!(parse_service_line("0 - a label with spaces"), Some(("a label with spaces".into(), ServiceState { pid: None, status: None })));
        assert_eq!(parse_service_line("\t\t12\t-15\tx"), Some(("x".into(), ServiceState { pid: Some(12), status: Some(-15) })));
        assert_eq!(parse_service_line("0 -"), None);
        assert_eq!(parse_service_line("0 - "), None);
        assert_eq!(parse_service_line("- 0 label"), None);
        assert_eq!(parse_service_line("12abc 0 label"), None);
        assert_eq!(parse_service_line("12 0x label"), None);
        assert_eq!(parse_service_line("12 -- label"), None);
        assert_eq!(parse_service_line(""), None);
    }

    /// A hung tool must not block its caller, and the killed child must not stay behind as a zombie.
    #[tokio::test]
    async fn hung_commands_are_killed_and_reaped() {
        let zombies = || {
            let me = std::process::id().to_string();
            let listing = std::process::Command::new("/bin/ps").args(["-axo", "ppid=,stat=,comm="]).output().unwrap();
            String::from_utf8_lossy(&listing.stdout)
                .lines()
                .filter(|line| {
                    let mut columns = line.split_whitespace();
                    columns.next() == Some(me.as_str()) && columns.next().is_some_and(|stat| stat.starts_with('Z')) && line.contains("sleep")
                })
                .count()
        };

        let started = std::time::Instant::now();
        let result = run_with_timeout(&["/bin/sleep", "30"], Some(Duration::from_millis(200))).await;
        assert!(started.elapsed() < Duration::from_secs(5), "returned after {:?}", started.elapsed());
        assert_eq!((result.code, result.stderr.as_str()), (-1, TIMED_OUT));
        assert_eq!(zombies(), 0, "the killed child was reaped");

        // The same with data on stdin, for a command that never reads it.
        let result = run_with_stdin(&["/bin/sleep", "30"], &vec![b'x'; 1024 * 1024], Duration::from_millis(200)).await;
        assert_eq!(result.code, -1);
        assert_eq!(zombies(), 0);

        // A command that finishes in time is not affected, and stderr is collected.
        let quick = run_with_timeout(&["/bin/sh", "-c", "echo out; echo err >&2; exit 3"], Some(Duration::from_secs(10))).await;
        assert_eq!((quick.code, quick.stdout.as_str(), quick.stderr.as_str()), (3, "out\n", "err"));
        assert_eq!(run_with_timeout(&["/nonexistent/tool"], Some(Duration::from_secs(1))).await.code, 127);
    }

    #[test]
    fn launchd_state_survives_a_failed_print() {
        let ok = |stdout: &str| ExecResult { code: 0, stdout: stdout.to_string(), stderr: String::new() };
        let timed_out = ExecResult { code: -1, stdout: String::new(), stderr: TIMED_OUT.to_string() };
        let printed = "gui/501 = {\n\tservices = {\n\t\t   593      - \tcom.example.job\n\t}\n}\n";
        let overrides = "\tdisabled services = {\n\t\t\"com.example.off\" => disabled\n\t}\n";
        let mut cache = HashMap::new();

        // No answer and nothing known: the caller must not take this for "nothing is loaded".
        assert!(resolve_domain_state(&mut cache, "gui/501", &timed_out, &timed_out).is_none());

        let first = resolve_domain_state(&mut cache, "gui/501", &ok(printed), &ok(overrides)).unwrap();
        assert_eq!(first.services["com.example.job"].pid, Some(593));
        assert_eq!(first.disabled.get("com.example.off"), Some(&true));

        // launchctl hangs for one tick: the job stays loaded and running.
        let kept = resolve_domain_state(&mut cache, "gui/501", &timed_out, &timed_out).unwrap();
        assert!(Arc::ptr_eq(&kept, &first));
        // Only print-disabled fails: the services are fresh, the overrides are the known ones.
        let mixed = resolve_domain_state(&mut cache, "gui/501", &ok("gui/501 = {\n\tservices = {\n\t}\n}\n"), &timed_out).unwrap();
        assert!(mixed.services.is_empty());
        assert_eq!(mixed.disabled.get("com.example.off"), Some(&true));
        // The domains do not share their state.
        assert!(resolve_domain_state(&mut cache, "system", &timed_out, &timed_out).is_none());
        // A good answer replaces the known state, also an empty one.
        let emptied = resolve_domain_state(&mut cache, "gui/501", &ok("gui/501 = {\n\tservices = {\n\t}\n}\n"), &ok("")).unwrap();
        assert!(emptied.services.is_empty() && emptied.disabled.is_empty());
    }

    #[test]
    fn statuses() {
        assert_eq!(status_of(None), "stopped");
        assert_eq!(status_of(Some(&ServiceState { pid: Some(1), status: Some(78) })), "running");
        assert_eq!(status_of(Some(&ServiceState { pid: None, status: Some(78) })), "error");
        assert_eq!(status_of(Some(&ServiceState { pid: None, status: Some(0) })), "stopped");
        assert_eq!(status_of(Some(&ServiceState { pid: None, status: None })), "stopped");
    }

    #[test]
    fn disabled_lines() {
        let printed = "disabled services = {\n\t\"com.example.off\" => disabled\n\t\"com.example.on\" => enabled\n\t\"com.old.off\" => true\n\t\"com.old.on\" => false\n\t\"odd \" => name\" => disabled\n\t\"com.example.other\" => maybe\n\tcom.example.bare => disabled\n}\nlogin item associations = {\n}\n";
        let disabled = parse_disabled(printed);
        assert_eq!(disabled.len(), 5);
        assert!(disabled["com.example.off"]);
        assert!(!disabled["com.example.on"]);
        assert!(disabled["com.old.off"]);
        assert!(!disabled["com.old.on"]);
        assert!(disabled["odd \" => name"]);
        assert_eq!(parse_disabled_line("\t\"x\" => disabled "), None);
        assert_eq!(parse_disabled_line("\t\"\" => disabled"), None);
    }

    #[test]
    fn detail_fields_and_environment() {
        let printed = "gui/501/com.example.job = {\n\tactive count = 1\n\tpath = /Users/me/Library/LaunchAgents/com.example.job.plist\n\ttype = LaunchAgent\n\tstate = running\n\tbundle id = com.example\n\n\tprogram = /bin/sh\n\tinherited environment = {\n\t\tSSH_AUTH_SOCK => /private/tmp/com.apple.launchd.x/Listeners\n\t}\n\n\tdefault environment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t}\n\n\tenvironment = {\n\t\tFOO => bar baz\n\t}\n\n\tlast exit reason = 78 (EX_CONFIG)\n\tstate = ignored second state\n}\n";
        let detail = parse_service_detail(printed, "gui/501");
        assert_eq!(detail.path.as_deref(), Some("/Users/me/Library/LaunchAgents/com.example.job.plist"));
        assert_eq!(detail.r#type.as_deref(), Some("LaunchAgent"));
        assert_eq!(detail.state.as_deref(), Some("running"));
        assert_eq!(detail.bundle_id.as_deref(), Some("com.example"));
        assert_eq!(detail.last_exit_reason.as_deref(), Some("78 (EX_CONFIG)"));
        assert_eq!(detail.domain, "gui/501");
        assert_eq!(detail.raw, printed);
        // Like the TypeScript regex, the first "environment = {" block wins.
        assert_eq!(detail.environment.len(), 1);
        assert_eq!(detail.environment["SSH_AUTH_SOCK"], "/private/tmp/com.apple.launchd.x/Listeners");
    }

    #[test]
    fn environment_edge_cases() {
        assert!(parse_environment("no block here").is_empty());
        assert!(parse_environment("\tmyenvironment = {\n\t\tA => b\n\t}").is_empty());
        let env = parse_environment("\tenvironment = {\n\t\tA => b c\n\t\tB=>d\n\t\tEMPTY => \n\t\tnot a pair\n\t}");
        assert_eq!(env.len(), 3);
        assert_eq!(env["A"], "b c");
        assert_eq!(env["B"], "d");
        assert_eq!(env["EMPTY"], "");
    }

    #[test]
    fn shell_quoting() {
        assert_eq!(sh_quote("plain"), "'plain'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("$(rm -rf /); `x`"), "'$(rm -rf /); `x`'");
        let script = privileged_script(&[
            tolerant(&["/bin/launchctl", "bootout", "system/com.example.job"]),
            step(&["/bin/mv", "/Library/LaunchDaemons/a b.plist", "/Users/me/.Trash/a b.plist"]),
        ]);
        assert_eq!(
            script,
            "{ '/bin/launchctl' 'bootout' 'system/com.example.job' || true; } && '/bin/mv' '/Library/LaunchDaemons/a b.plist' '/Users/me/.Trash/a b.plist'"
        );
    }

    /// No root script may touch a folder that the user controls.
    fn assert_root_stays_out_of_user_folders(steps: &[Step]) {
        for s in steps {
            let line = s.cmd.join(" ");
            assert!(!line.contains(".Trash"), "root touches the Trash: {}", line);
            assert!(!line.contains("/Users/"), "root touches a user folder: {}", line);
            assert!(!line.contains("/tmp") && !line.contains("/var/folders"), "root reads a temp file: {}", line);
            assert_ne!(s.cmd[0], "/usr/bin/install");
            if s.cmd[0] == "/bin/mv" || s.cmd[0] == "/usr/sbin/chown" || s.cmd[0] == "/bin/chmod" || s.cmd[0] == "/bin/rm" {
                let paths = s.cmd.iter().filter(|a| a.starts_with('/') && *a != &s.cmd[0]);
                assert!(paths.clone().count() > 0);
                assert!(paths.into_iter().all(|p| p.starts_with("/Library/")), "{}", line);
            }
        }
    }

    #[test]
    fn privileged_save_script() {
        let xml = "<plist/>";
        // A daemon is renamed inside /Library: root removes the old file. The Trash copy is made by the app.
        let steps = privileged_save_steps(&PrivilegedSave {
            xml,
            dest: "/Library/LaunchDaemons/com.example.new.plist",
            domain: "system",
            load: true,
            bootout: Some("system/com.example.old"),
            remove_original: Some("/Library/LaunchDaemons/com.example.old.plist"),
        });
        assert_eq!(
            privileged_script(&steps),
            "{ '/bin/launchctl' 'bootout' 'system/com.example.old' || true; } \
             && '/bin/sh' '-c' 'printf %s \"$0\" | /usr/bin/base64 -D > \"$1\"' 'PHBsaXN0Lz4=' '/Library/LaunchDaemons/com.example.new.plist.macdash-new' \
             && '/usr/sbin/chown' 'root:wheel' '/Library/LaunchDaemons/com.example.new.plist.macdash-new' \
             && '/bin/chmod' '644' '/Library/LaunchDaemons/com.example.new.plist.macdash-new' \
             && '/bin/mv' '-f' '/Library/LaunchDaemons/com.example.new.plist.macdash-new' '/Library/LaunchDaemons/com.example.new.plist' \
             && '/bin/rm' '-f' '/Library/LaunchDaemons/com.example.old.plist' \
             && { '/usr/bin/xattr' '-d' 'com.apple.quarantine' '/Library/LaunchDaemons/com.example.new.plist' || true; } \
             && { '/bin/launchctl' 'bootstrap' 'system' '/Library/LaunchDaemons/com.example.new.plist' || true; }"
        );
        assert_root_stays_out_of_user_folders(&steps);
        // The staging file is invisible to the monitor.
        assert!(!is_job_file_name("com.example.new.plist.macdash-new"));

        // A user agent moves into /Library: root unloads it by name, but never touches its file.
        // The app moves the original to the Trash after the script.
        let from_user = privileged_save_steps(&PrivilegedSave {
            xml,
            dest: "/Library/LaunchAgents/x.plist",
            domain: "gui/501",
            load: true,
            bootout: Some("gui/501/x"),
            remove_original: None,
        });
        assert_root_stays_out_of_user_folders(&from_user);
        assert!(from_user.iter().all(|s| s.cmd[0] != "/bin/rm"));

        // "Save only" of a /Library job: no bootout, no bootstrap.
        let save_only = privileged_save_steps(&PrivilegedSave {
            xml,
            dest: "/Library/LaunchDaemons/x.plist",
            domain: "system",
            load: false,
            bootout: None,
            remove_original: None,
        });
        assert!(save_only.iter().all(|s| !s.cmd.contains(&"bootout".to_string()) && !s.cmd.contains(&"bootstrap".to_string())));
        assert_eq!(save_only.len(), 5); // write, chown, chmod, mv, xattr
        assert_root_stays_out_of_user_folders(&save_only);
    }

    #[test]
    fn privileged_remove_script() {
        // Delete of a /Library job, and the original of a job that moved to the user's folder.
        let steps = privileged_remove_steps(Some("system/com.example.job"), "/Library/LaunchDaemons/com.example.job.plist");
        assert_eq!(
            privileged_script(&steps),
            "{ '/bin/launchctl' 'bootout' 'system/com.example.job' || true; } && '/bin/rm' '-f' '/Library/LaunchDaemons/com.example.job.plist'"
        );
        assert_root_stays_out_of_user_folders(&steps);

        // A label that is not a plain launchctl target: no bootout, the file still goes.
        let no_target = privileged_remove_steps(None, "/Library/LaunchAgents/it's odd.plist");
        assert_eq!(privileged_script(&no_target), "'/bin/rm' '-f' '/Library/LaunchAgents/it'\\''s odd.plist'");
        assert_root_stays_out_of_user_folders(&no_target);
    }

    #[test]
    fn trash_copies_are_exclusive() {
        let dir = std::env::temp_dir().join(format!("macdash-trash-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.plist");
        let victim = dir.join("victim");
        std::fs::write(&source, b"bplist00\x00\xff binary \n content").unwrap();
        std::fs::write(&victim, "victim").unwrap();

        let copy = dir.join("copy.plist");
        copy_exclusive(&source, &copy).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), std::fs::read(&source).unwrap());

        // An existing name is never overwritten.
        assert!(copy_exclusive(&source, &victim).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "victim");

        // A symlink that appeared at the name is never followed.
        let planted = dir.join("planted.plist");
        std::os::unix::fs::symlink(&victim, &planted).unwrap();
        assert!(copy_exclusive(&source, &planted).is_err());
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "victim");

        assert!(copy_exclusive(&dir.join("missing"), &dir.join("never")).is_err());
        assert!(!dir.join("never").exists());

        discard_trash_copy(Some(copy.clone()));
        assert!(!copy.exists());
        discard_trash_copy(None);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The root script must write exactly the text it was handed, whatever the text contains.
    /// Runs the generated script through `/bin/sh -c` WITHOUT privileges, into a scratch folder.
    #[test]
    fn privileged_write_is_byte_identical_for_hostile_content() {
        let dir = std::env::temp_dir().join(format!("macdash-write-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let canary = dir.join("canary");
        let owner = uid().to_string();

        let hostile = [
            "plain".to_string(),
            "it's \"quoted\" 'twice' '' ' \"\" \"".to_string(),
            format!("$(touch {0}) `touch {0}` ${{IFS}} $0 $1 $HOME ; touch {0} & | > < \\ \\\\ \\n %s %d %%", canary.display()),
            "line one\nline two\r\n\n\ttabbed\n\n".to_string(),
            "no trailing newline".to_string(),
            "ünïcödé 日本語 😀 \u{2028} \u{feff}".to_string(),
            "-n -e --help".to_string(),
            "'; rm -rf / #".to_string(),
            "<?xml version=\"1.0\"?>\n<plist version=\"1.0\"><dict><key>Label</key><string>a&amp;b</string></dict></plist>\n".to_string(),
            "x".repeat(MAX_PRIVILEGED_XML_BYTES), // the largest text a privileged save accepts
        ];
        for (i, content) in hostile.iter().enumerate() {
            // A destination with a space and a quote in its path
            let dest = dir.join(format!("it's job {}.plist", i));
            let dest_text = dest.to_str().unwrap();
            let script = privileged_script(&privileged_write_steps(content, dest_text, &owner));
            let output = std::process::Command::new("/bin/sh").args(["-c", &script]).output().unwrap();
            assert!(output.status.success(), "case {}: {}", i, String::from_utf8_lossy(&output.stderr));
            assert_eq!(std::fs::read(&dest).unwrap(), content.as_bytes(), "case {}", i);
            assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o644);
            assert!(!staging_path(&dest).exists(), "the staging file is renamed away");
        }
        assert!(!canary.exists(), "nothing inside the content was executed");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_plans() {
        let user = scope_for("user-agents").unwrap();
        let agents = scope_for("global-agents").unwrap();
        let daemons = scope_for("global-daemons").unwrap();
        let plan = |load, moved, bootout_original, root_removes_original| SavePlan { load, moved, bootout_original, root_removes_original };

        // New job
        assert_eq!(plan_save(None, false, "/u/a.plist", None), plan(true, false, false, false));
        // "Save only" of the same path leaves the loaded job alone.
        assert_eq!(plan_save(Some(false), false, "/u/a.plist", Some(("/u/a.plist", user))), plan(false, false, false, false));
        assert_eq!(plan_save(Some(false), false, "/L/d.plist", Some(("/L/d.plist", daemons))), plan(false, false, false, false));
        // Disabled key: no load, so no bootout either.
        assert_eq!(plan_save(Some(true), true, "/u/a.plist", Some(("/u/a.plist", user))), plan(false, false, false, false));
        // Save and load: the old instance is replaced.
        assert_eq!(plan_save(None, false, "/u/a.plist", Some(("/u/a.plist", user))), plan(true, false, true, false));
        // A rename must unload the old identity, even for "save only". The app trashes its own file.
        assert_eq!(plan_save(Some(false), false, "/u/b.plist", Some(("/u/a.plist", user))), plan(false, true, true, false));
        // A user job moves into /Library: the original is still the app's to move.
        assert_eq!(plan_save(None, false, "/L/a.plist", Some(("/u/a.plist", user))), plan(true, true, true, false));
        // The original is in /Library and the path changes: root removes it.
        assert_eq!(plan_save(None, false, "/u/a.plist", Some(("/L/a.plist", agents))), plan(true, true, true, true));
        assert_eq!(plan_save(Some(false), false, "/L/e.plist", Some(("/L/d.plist", daemons))), plan(false, true, true, true));
    }

    #[test]
    fn job_files_are_written_atomically_and_never_through_symlinks() {
        let dir = std::env::temp_dir().join(format!("macdash-save-{}-{}", std::process::id(), now_ms()));
        let dest = dir.join("LaunchAgents").join("com.example.plist"); // the folder is created on demand
        let victim = dir.join("victim");
        let mode = |path: &Path| std::fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777;

        write_job_file(&dest, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first");
        assert_eq!(mode(&dest), 0o644);

        // A stale staging file does not stop the save.
        std::fs::write(staging_path(&dest), "stale").unwrap();
        write_job_file(&dest, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "second");
        assert!(!staging_path(&dest).exists());

        // A symlink planted at the target is replaced, not followed.
        std::fs::write(&victim, "victim").unwrap();
        std::fs::remove_file(&dest).unwrap();
        std::os::unix::fs::symlink(&victim, &dest).unwrap();
        write_job_file(&dest, "third").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "victim");
        assert!(std::fs::symlink_metadata(&dest).unwrap().is_file());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "third");

        // A symlink planted at the staging path is removed, not followed.
        std::os::unix::fs::symlink(&victim, staging_path(&dest)).unwrap();
        write_job_file(&dest, "fourth").unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "victim");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fourth");

        // Something that cannot be removed at the staging path fails the save and keeps the target.
        std::fs::create_dir(staging_path(&dest)).unwrap();
        assert!(write_job_file(&dest, "fifth").is_err());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fourth");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// `plutil -lint -` reads the document from memory. No file is involved.
    #[tokio::test]
    async fn lint_from_stdin() {
        let good = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>x</string></dict></plist>";
        let result = run_with_stdin(&[PLUTIL, "-lint", "-"], good.as_bytes(), LAUNCHCTL_TIMEOUT).await;
        assert_eq!(result.code, 0, "{:?}", result);

        let bad = "<plist><dict><key>a</key></dict></plist>";
        let result = run_with_stdin(&[PLUTIL, "-lint", "-"], bad.as_bytes(), LAUNCHCTL_TIMEOUT).await;
        assert_ne!(result.code, 0);
        assert!(!result.stdout.trim().is_empty() || !result.stderr.is_empty());

        // More than a pipe buffer in both directions must not block.
        let big = "y".repeat(MAX_XML_BYTES);
        let echoed = run_with_stdin(&["/bin/cat"], big.as_bytes(), LAUNCHCTL_TIMEOUT).await;
        assert_eq!(echoed.stdout.len(), big.len());
        // A command that never reads its input
        assert_eq!(run_with_stdin(&["/usr/bin/true"], big.as_bytes(), LAUNCHCTL_TIMEOUT).await.code, 0);
    }

    #[test]
    fn osascript_arguments_follow_a_separator() {
        let hostile = "-e do shell script \"id > /tmp/pwned\"";
        let argv = osascript_argv(&["on run argv", "return item 1 of argv", "end run"], &[hostile, "-s", "plain"]);
        assert_eq!(
            argv,
            vec!["/usr/bin/osascript", "-e", "on run argv", "-e", "return item 1 of argv", "-e", "end run", "--", hostile, "-s", "plain"]
        );
        // Every `on run argv` item comes after the separator, and only constant script lines come before it.
        let separator = argv.iter().position(|a| *a == "--").unwrap();
        assert!(argv[..separator].iter().all(|a| !a.contains("pwned")));
        assert_eq!(argv[separator + 1..].len(), 3);
        assert_eq!(osascript_argv(&["return 1"], &[]), vec!["/usr/bin/osascript", "-e", "return 1", "--"]);

        // The administrator prompt gets the script and the prompt text as items 1 and 2.
        let script = privileged_script(&[step(&["/bin/rm", "-f", "/Library/LaunchDaemons/x.plist"])]);
        let argv = osascript_argv(&PRIVILEGED_SCRIPT, &[script.as_str(), "-e return 1"]);
        assert_eq!(argv[argv.len() - 3..], ["--", script.as_str(), "-e return 1"]);
        assert!(PRIVILEGED_SCRIPT.iter().all(|line| !line.contains("rm")));
    }

    /// Runs osascript WITHOUT privileges and without System Events: the script only returns its argument.
    /// It proves that an item after `--` is data. `cargo test -- --ignored live`
    #[tokio::test]
    #[ignore]
    async fn live_osascript_separator() {
        let script = ["on run argv", "return \"ARG:\" & (item 1 of argv)", "end run"];
        let hostile = "-e return \"INJECTED\"";
        let result = run_with_timeout(&osascript_argv(&script, &[hostile]), Some(LAUNCHCTL_TIMEOUT)).await;
        assert_eq!(result.code, 0, "{:?}", result);
        assert_eq!(result.stdout.trim_end(), format!("ARG:{}", hostile));

        // The shape of the privileged call, with a harmless script in place of `do shell script`:
        // a 270 KB item 1 (the largest privileged save) and a prompt that starts with a dash.
        let echo = ["on run argv", "return ((count of characters of (item 1 of argv)) as text) & \"|\" & (item 2 of argv)", "end run"];
        let payload = privileged_script(&privileged_write_steps(&"x".repeat(MAX_PRIVILEGED_XML_BYTES), "/Library/LaunchDaemons/x.plist", "root:wheel"));
        let result = run_with_timeout(&osascript_argv(&echo, &[payload.as_str(), "-e prompt"]), Some(LAUNCHCTL_TIMEOUT)).await;
        assert_eq!(result.code, 0, "{}", result.stderr);
        assert_eq!(result.stdout.trim_end(), format!("{}|-e prompt", payload.chars().count()));
    }

    #[test]
    fn prompt_labels_stay_on_one_line() {
        assert_eq!(prompt_label("com.example.job"), "com.example.job");
        assert_eq!(prompt_label("x\".\n\nmacOS needs your password\r\u{2028}"), "x\".macOS needs your password");
        assert_eq!(prompt_label(&"a".repeat(500)).chars().count(), 80);
    }

    #[test]
    fn disabled_jobs_fail_early() {
        for action in ["start", "restart", "load"] {
            assert!(needs_enabled_job(action));
        }
        for action in ["stop", "unload", "enable", "disable"] {
            assert!(!needs_enabled_job(action));
        }
    }

    /// The grouping of tolerant steps must not hide an earlier failure. Runs /bin/sh without privileges.
    #[test]
    fn tolerant_steps_do_not_mask_failures() {
        let status = |steps: &[Step]| {
            std::process::Command::new("/bin/sh").args(["-c", &privileged_script(steps)]).status().unwrap().code()
        };
        assert_eq!(status(&[tolerant(&["/usr/bin/false"]), step(&["/usr/bin/true"])]), Some(0));
        assert_eq!(status(&[step(&["/usr/bin/false"]), tolerant(&["/usr/bin/false"]), tolerant(&["/usr/bin/true"])]), Some(1));
        assert_eq!(status(&[step(&["/usr/bin/true"]), tolerant(&["/usr/bin/false"])]), Some(0));
    }

    #[test]
    fn privileged_errors() {
        assert_eq!(explain_privileged_failure("0:94: execution error: User canceled. (-128)"), "Cancelled at the administrator prompt.");
        assert_eq!(explain_privileged_failure("0:94: execution error: install: /x: No such file (71)"), "install: /x: No such file (71)");
        assert_eq!(explain_privileged_failure(""), "Privileged command failed.");
        assert_eq!(explain_privileged_failure("something else"), "something else");
    }

    #[test]
    fn launchctl_errors() {
        let failure = |stderr: &str, stdout: &str| ExecResult { code: 5, stdout: stdout.into(), stderr: stderr.into() };
        assert!(explain_launchctl_error(&failure("Bootstrap failed: 5: Input/output error", "")).starts_with("launchd rejected the job (error 5)"));
        assert!(explain_launchctl_error(&failure("Boot-out failed: 5", "")).starts_with("launchd rejected the job"));
        assert_eq!(explain_launchctl_error(&failure("failed: 50", "")), "failed: 50");
        assert!(explain_launchctl_error(&failure("operation NOT permitted", "")).starts_with("Not permitted."));
        assert!(explain_launchctl_error(&failure("", "Could not find service \"x\" in domain\n")).starts_with("launchd does not know"));
        assert_eq!(explain_launchctl_error(&failure("", "")), "launchctl exited with code 5");
    }

    #[test]
    fn steps_per_action() {
        let plist = Some("/p/x.plist");
        let cmds = |steps: Vec<Step>| steps.into_iter().map(|s| (s.cmd[1..].join(" "), s.tolerant)).collect::<Vec<_>>();

        assert_eq!(
            cmds(action_steps("start", "x", "gui/501", plist, false).unwrap()),
            vec![("bootstrap gui/501 /p/x.plist".to_string(), false), ("kickstart gui/501/x".to_string(), false)]
        );
        assert_eq!(cmds(action_steps("start", "x", "gui/501", plist, true).unwrap()), vec![("kickstart gui/501/x".to_string(), false)]);
        assert_eq!(cmds(action_steps("start", "x", "gui/501", None, false).unwrap()), vec![("kickstart gui/501/x".to_string(), false)]);
        assert_eq!(cmds(action_steps("restart", "x", "system", plist, true).unwrap()), vec![("kickstart -k system/x".to_string(), false)]);
        assert_eq!(cmds(action_steps("stop", "x", "system", plist, true).unwrap()), vec![("kill SIGTERM system/x".to_string(), false)]);
        assert_eq!(cmds(action_steps("load", "x", "system", plist, false).unwrap()), vec![("bootstrap system /p/x.plist".to_string(), false)]);
        assert_eq!(action_steps("load", "x", "system", plist, true).unwrap_err(), "The job is already loaded.");
        assert_eq!(action_steps("load", "x", "system", None, false).unwrap_err(), "This service has no plist file to load.");
        assert_eq!(cmds(action_steps("unload", "x", "system", plist, true).unwrap()), vec![("bootout system/x".to_string(), false)]);
        assert_eq!(
            cmds(action_steps("enable", "x", "gui/501", plist, false).unwrap()),
            vec![("enable gui/501/x".to_string(), false), ("bootstrap gui/501 /p/x.plist".to_string(), false)]
        );
        assert_eq!(
            cmds(action_steps("disable", "x", "gui/501", plist, true).unwrap()),
            vec![("bootout gui/501/x".to_string(), true), ("disable gui/501/x".to_string(), false)]
        );
        assert_eq!(cmds(action_steps("disable", "x", "gui/501", plist, false).unwrap()), vec![("disable gui/501/x".to_string(), false)]);
        assert!(action_steps("explode", "x", "gui/501", plist, false).is_err());
    }

    #[test]
    fn job_file_names() {
        assert!(is_job_file_name("a.plist"));
        assert!(is_job_file_name("a.plist.disabled"));
        assert!(!is_job_file_name("a.plist.bak"));
        assert_eq!(strip_job_extension("com.x.plist"), "com.x");
        assert_eq!(strip_job_extension("com.x.plist.disabled"), "com.x");
        assert_eq!(strip_job_extension("com.x.disabled"), "com.x.disabled");
    }

    #[test]
    fn safe_file_names() {
        assert_eq!(safe_file_name("com.example.job"), "com.example.job");
        assert_eq!(safe_file_name("A1._-"), "A1._-");
        // Path traversal through a hostile Label
        // Expected values come from `safeFileName()` in server/core/launchctl.ts, run in Bun.
        assert_eq!(safe_file_name("../../.ssh/authorized_keys"), "__.._.ssh_authorized_keys");
        assert_eq!(safe_file_name("../../x"), "__.._x");
        assert_eq!(safe_file_name("a/b\\c"), "a_b_c");
        assert_eq!(safe_file_name(".hidden"), "_hidden");
        assert_eq!(safe_file_name("..."), "_");
        assert_eq!(safe_file_name(""), "_");
        assert_eq!(safe_file_name("a b\n\0$(id)`x`'\""), "a_b____id__x___");
        assert_eq!(safe_file_name("-rf"), "-rf");
        // Non-ASCII: one "_" per UTF-16 unit, like the JavaScript regex without the u flag
        assert_eq!(safe_file_name("é"), "_");
        assert_eq!(safe_file_name("😀x"), "__x");
        assert_eq!(safe_file_name(&"a".repeat(500)).len(), 200);
        assert_eq!(safe_file_name(&format!(".{}", "a".repeat(500))).len(), 200);
        for hostile in ["../../x", "/etc/passwd", "..", ".", "a/../b", "x\0y", "-rf"] {
            let name = safe_file_name(hostile);
            assert!(!name.contains('/') && !name.contains('\0') && !name.starts_with('.') && !name.is_empty(), "{:?} -> {:?}", hostile, name);
            assert_eq!(Path::new(&name).components().count(), 1);
        }
    }

    #[test]
    fn revision_names() {
        assert_eq!(revision_label("com.foo-2026-09-21T05-03-37-821Z.plist"), Some("com.foo"));
        assert_eq!(revision_label("a-b-2026-09-21T05-03-37-821Z.plist"), Some("a-b"));
        assert_eq!(revision_label("-2026-09-21T05-03-37-821Z.plist"), None);
        assert_eq!(revision_label("com.foo-2026-09-21T05-03-37-821Z.plist.bak"), None);
        assert_eq!(revision_label("com.foo-2026-09-21T05:03:37.821Z.plist"), None);
        assert_eq!(revision_label("com.foo-2026-09-21T05-03-37-82xZ.plist"), None);
        assert_eq!(revision_label("com.foo.plist"), None);
        assert_eq!(revision_label("é-2026-09-21T05-03-37-821Z.plist"), Some("é"));
        assert_eq!(revision_label("2026-09-21T05-03-37-821Z.plist"), None);
    }

    #[test]
    fn calendar_integer_fields() {
        let xml = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>StartCalendarInterval</key><dict>\
            <key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer><key>Bad</key><string>x</string>\
            <key>Real</key><real>1.5</real></dict></dict></plist>";
        let job = plist::from_bytes::<Value>(xml.as_bytes()).unwrap().into_dictionary().unwrap();
        let calendar = calendar_fields(&job);
        assert_eq!(calendar.len(), 1);
        assert_eq!(calendar[0].len(), 2);
        assert_eq!(calendar[0]["Hour"], 9);
        assert_eq!(calendar[0]["Minute"], 30);
        assert!(calendar_fields(&Dictionary::new()).is_empty());
    }

    #[test]
    fn output_tail() {
        // One trailing newline is not a line. Exactly `lines` lines come back.
        assert_eq!(tail_lines("a\nb\nc\n", false, 2), ("b\nc".to_string(), true));
        assert_eq!(tail_lines("a\nb\nc\n", false, 3), ("a\nb\nc".to_string(), false));
        assert_eq!(tail_lines("a\nb\nc\n", false, 200), ("a\nb\nc".to_string(), false));
        assert_eq!(tail_lines("a\nb\nc", false, 1), ("c".to_string(), true));
        // Only ONE trailing newline is stripped: an empty last line is content.
        assert_eq!(tail_lines("a\n\n", false, 200), ("a\n".to_string(), false));
        // A truncated read drops the partial first line, but never the only line.
        assert_eq!(tail_lines("half\nb\nc", true, 200), ("b\nc".to_string(), false));
        assert_eq!(tail_lines("one very long line without a newline", true, 200), ("one very long line without a newline".to_string(), false));
        assert_eq!(tail_lines("half\n", true, 200), ("half".to_string(), false));
        // The count is clamped to 1..5000.
        assert_eq!(tail_lines("a\nb\nc", false, 0), ("c".to_string(), true));
        assert_eq!(tail_lines("a\nb\nc", false, -7), ("c".to_string(), true));
        let many = "x\n".repeat(6000);
        let (text, dropped) = tail_lines(&many, false, 1_000_000);
        assert_eq!(text.split('\n').count(), 5000);
        assert!(dropped);
        assert_eq!(tail_lines("", false, 10), (String::new(), false));
    }

    /// Read-only check against the real launchd of this Mac: `cargo test -- --ignored live`.
    /// It lists directories and runs `launchctl print`. It changes nothing.
    #[tokio::test]
    #[ignore]
    async fn live_list_services() {
        let services = list_services().await;
        let with_file = services.iter().filter(|s| s.plist_path.is_some()).count();
        let running = services.iter().filter(|s| s.status == "running").count();
        let loaded = services.iter().filter(|s| s.loaded).count();
        let unreadable = services.iter().filter(|s| s.unreadable).count();
        let disabled = services.iter().filter(|s| s.disabled).count();
        let with_triggers = services.iter().filter(|s| !s.triggers.is_empty()).count();
        println!(
            "{} services: {} with a file, {} loaded, {} running, {} disabled, {} unreadable, {} with triggers",
            services.len(), with_file, loaded, running, disabled, unreadable, with_triggers
        );
        assert!(with_file > 100, "the system scopes alone hold several hundred plists");
        assert!(running > 10);
        assert!(loaded > running);
        assert!(with_triggers > 10);

        // MACDASH_DUMP=<file> writes the list as JSON, to compare it with the Bun server.
        if let Ok(target) = std::env::var("MACDASH_DUMP") {
            std::fs::write(target, serde_json::to_string(&services).unwrap()).unwrap();
        }

        let finder = services.iter().find(|s| s.label == "com.apple.Finder").expect("Finder agent");
        println!("{}", serde_json::to_string_pretty(finder).unwrap());
        assert_eq!(finder.category, "system-agents");
        assert!(!finder.writable);

        let detail = get_service_detail("com.apple.Finder", "system-agents").await.unwrap().expect("detail");
        assert_eq!(detail.domain, format!("gui/{}", uid()));
        assert!(detail.path.is_some());
        assert!(detail.raw.contains("com.apple.Finder"));

        let document = read_job("com.apple.Finder", "system-agents").await.unwrap().expect("document");
        assert!(document.xml.contains("<plist"));
        assert!(!document.writable);

        // A second scan of an unchanged system reports nothing.
        assert!(rescan_jobs().await.is_empty());

        let facts = check_paths(vec!["/bin/sh".into(), "/bin/sh".into(), "relative".into(), "/nonexistent".into(), "/tmp".into()]).await;
        assert_eq!(facts.len(), 3);
        assert!(facts[0].executable && facts[0].is_file);
        assert!(!facts[1].exists);
        assert!(facts[2].is_directory);
    }

    #[test]
    fn scan_reports_added_modified_removed() {
        let dir = std::env::temp_dir().join(format!("macdash-scan-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let dirs = vec![(dir.clone(), scope_for("user-agents").unwrap())];
        let plist = |label: &str, extra: &str| {
            format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>{}</string>{}</dict></plist>", label, extra)
        };

        std::fs::write(dir.join("com.example.a.plist"), plist("com.example.a", "")).unwrap();
        std::fs::write(dir.join("file-name-wins.plist.disabled"), "not a plist").unwrap();
        std::fs::write(dir.join("ignored.txt"), "x").unwrap();
        std::fs::create_dir(dir.join("folder.plist")).unwrap();

        // Baseline
        let (index, changes) = scan_dirs(&FileMap::new(), &dirs);
        assert_eq!(index.len(), 2);
        assert!(changes.iter().all(|c| c.kind == "added"));
        let broken = index.values().find(|f| f.file_name.ends_with(".disabled")).unwrap();
        assert_eq!(broken.label, "file-name-wins");
        assert!(broken.job.is_none());
        assert_eq!(index.values().find(|f| f.label == "com.example.a").unwrap().category, "user-agents");

        // Nothing changed: the parsed files are reused.
        let (same, changes) = scan_dirs(&index, &dirs);
        assert!(changes.is_empty());
        assert!(same.values().zip(index.values()).all(|(a, b)| Arc::ptr_eq(a, b)));

        // One modified (size differs), one added, one removed
        std::fs::write(dir.join("com.example.a.plist"), plist("com.example.a", "<key>RunAtLoad</key><true/>")).unwrap();
        std::fs::write(dir.join("com.example.b.plist"), plist("com.example.b", "")).unwrap();
        std::fs::remove_file(dir.join("file-name-wins.plist.disabled")).unwrap();
        let (next, changes) = scan_dirs(&same, &dirs);
        let mut kinds: Vec<(&str, &str)> = changes.iter().map(|c| (c.kind, c.file.label.as_str())).collect();
        kinds.sort();
        assert_eq!(kinds, vec![("added", "com.example.b"), ("modified", "com.example.a"), ("removed", "file-name-wins")]);
        assert_eq!(next.len(), 2);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn duplicate_labels_in_one_scope_get_unique_keys() {
        let dir = std::env::temp_dir().join(format!("macdash-dup-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let dirs = vec![(dir.clone(), scope_for("system-daemons").unwrap())];
        let plist = |label: &str| format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>{}</string></dict></plist>", label);

        // Like macOS: two files, one Label. The file named after the label keeps it.
        std::fs::write(dir.join("com.apple.sysdiagnose.plist"), plist("com.apple.sysdiagnose")).unwrap();
        std::fs::write(dir.join("com.apple.sysdiagnose.darwinos.plist"), plist("com.apple.sysdiagnose")).unwrap();
        // No file is named after the label: the first by file name keeps it.
        std::fs::write(dir.join("b-second.plist"), plist("shared")).unwrap();
        std::fs::write(dir.join("a-first.plist.disabled"), plist("shared")).unwrap();
        std::fs::write(dir.join("c-third.plist"), plist("shared")).unwrap();
        std::fs::write(dir.join("single.plist"), plist("com.example.single")).unwrap();

        let (index, changes) = scan_dirs(&FileMap::new(), &dirs);
        let labels = |files: &FileMap| files.values().map(|f| (f.file_name.clone(), f.label.clone())).collect::<HashMap<_, _>>();
        let by_file = labels(&index);
        assert_eq!(by_file["com.apple.sysdiagnose.plist"], "com.apple.sysdiagnose");
        assert_eq!(by_file["com.apple.sysdiagnose.darwinos.plist"], "com.apple.sysdiagnose.darwinos");
        assert_eq!(by_file["a-first.plist.disabled"], "shared");
        assert_eq!(by_file["b-second.plist"], "b-second");
        assert_eq!(by_file["c-third.plist"], "c-third");
        assert_eq!(by_file["single.plist"], "com.example.single");

        // The key is unique, and the change list points at the renamed entries.
        let keys: HashSet<(&str, &str)> = index.values().map(|f| (f.category, f.label.as_str())).collect();
        assert_eq!(keys.len(), index.len());
        assert_eq!(changes.len(), 6);
        for change in &changes {
            assert!(Arc::ptr_eq(&change.file, &index[&change.file.path]), "{}", change.file.file_name);
        }
        // Everything else of the renamed file stays: the parsed plist still has the declared Label.
        let renamed = index.values().find(|f| f.label == "com.apple.sysdiagnose.darwinos").unwrap();
        assert_eq!(renamed.job.as_ref().unwrap().get("Label").and_then(Value::as_string), Some("com.apple.sysdiagnose"));

        // The next scan of an unchanged folder reports nothing and reuses every entry.
        let (again, changes) = scan_dirs(&index, &dirs);
        assert!(changes.is_empty());
        assert!(again.values().zip(index.values()).all(|(a, b)| Arc::ptr_eq(a, b)));
        assert_eq!(labels(&again), by_file);

        // The cached entry of the previous index is never changed in place.
        let owner_before = Arc::clone(&index[dir.join("com.apple.sysdiagnose.plist").to_str().unwrap()]);
        std::fs::write(dir.join("com.apple.sysdiagnose.darwinos.plist"), plist("com.apple.sysdiagnose") + "\n").unwrap();
        let (third, changes) = scan_dirs(&again, &dirs);
        assert_eq!(changes.len(), 1);
        assert_eq!((changes[0].kind, changes[0].file.label.as_str()), ("modified", "com.apple.sysdiagnose.darwinos"));
        assert!(Arc::ptr_eq(&third[&owner_before.path], &owner_before));
        assert_eq!(owner_before.label, "com.apple.sysdiagnose");

        // The same label in two scopes is no collision.
        let other = std::env::temp_dir().join(format!("macdash-dup-agents-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("elsewhere.plist"), plist("com.apple.sysdiagnose")).unwrap();
        let both = vec![(dir.clone(), scope_for("system-daemons").unwrap()), (other.clone(), scope_for("system-agents").unwrap())];
        let (index, _) = scan_dirs(&FileMap::new(), &both);
        assert!(index.values().any(|f| f.category == "system-agents" && f.label == "com.apple.sysdiagnose"));

        std::fs::remove_dir_all(&dir).unwrap();
        std::fs::remove_dir_all(&other).unwrap();
    }

    #[test]
    fn binary_and_xml_plists_read_as_xml() {
        let dir = std::env::temp_dir().join(format!("macdash-test-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();

        let mut job = Dictionary::new();
        job.insert("Label".into(), Value::String("com.example.binary".into()));
        let binary = dir.join("binary.plist");
        Value::Dictionary(job).to_file_binary(&binary).unwrap();
        let xml = read_plist_xml(&binary).unwrap();
        assert!(xml.starts_with("<?xml"));
        assert!(xml.contains("<string>com.example.binary</string>"));

        let text = "<?xml version=\"1.0\"?>\n<!-- keep me -->\n<plist version=\"1.0\"><dict/></plist>\n";
        let plain = dir.join("plain.plist");
        std::fs::write(&plain, text).unwrap();
        assert_eq!(read_plist_xml(&plain).unwrap(), text);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
