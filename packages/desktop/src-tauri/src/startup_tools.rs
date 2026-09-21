//! Code signatures, background items, login items, script apps and the power schedule.
//! See "Signature, background items, apps, power" in docs/backend-contract.md.
//!
//! Every function that builds arguments or parses tool output is pure and has unit tests.
//! The tests never run `osascript`, `osacompile` or `pmset`.

use crate::job_extras::{is_automation_denied, AUTOMATION_DENIED};
use crate::launchd::job_executable;
use crate::services::{
    find_job_file, home_dir, osascript_argv, run_privileged_command, run_with_timeout, scope_or_err, uid,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

const CODESIGN: &str = "/usr/bin/codesign";
const SFLTOOL: &str = "/usr/bin/sfltool";
const OSACOMPILE: &str = "/usr/bin/osacompile";
const PMSET: &str = "/usr/bin/pmset";

const COMMAND_TIMEOUT: Duration = Duration::from_secs(10);
const CODESIGN_DISPLAY_TIMEOUT: Duration = Duration::from_secs(15);
const CODESIGN_VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
/// Code that Apple signed itself.
const REQUIREMENT_APPLE: &str = "anchor apple";
/// Code whose certificate Apple issued: Apple, Developer ID, App Store.
const REQUIREMENT_APPLE_ISSUED: &str = "anchor apple generic";
/// Usually 5 s. On a busy Mac it took more than 15 s, so the limit is generous.
const DUMPBTM_TIMEOUT: Duration = Duration::from_secs(60);
const OSA_TIMEOUT: Duration = Duration::from_secs(30);

fn has_control_chars(text: &str) -> bool {
    text.chars().any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
}

// ── Code signature ───────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobSignature {
    /// The job's executable (Program, else ProgramArguments[0]).
    pub path: Option<String>,
    pub signed: bool,
    pub identifier: Option<String>,
    /// Certificate chain, leaf first.
    pub authorities: Vec<String>,
    /// None for "not set".
    pub team_id: Option<String>,
    /// VERIFIED: `codesign -v -R="anchor apple"` exits 0. Never derived from the displayed names.
    pub apple: bool,
    /// VERIFIED: `codesign -v -R="anchor apple generic"` exits 0 (Apple, Developer ID, App Store).
    pub trusted: bool,
    pub adhoc: bool,
    pub error: Option<String>,
}

/// Parse the stderr of `codesign -dv --verbose=2 <path>`.
/// `codesign -d` only displays names, and anyone can name a self-signed certificate "Software Signing".
/// The parser therefore leaves `apple` and `trusted` false. `signature_of` fills them in after a real verification.
fn parse_codesign(path: &str, exit_code: i32, stderr: &str) -> JobSignature {
    let mut signature = JobSignature { path: Some(path.to_string()), ..JobSignature::default() };
    if stderr.contains("code object is not signed at all") {
        return signature; // signed: false, and that is not an error
    }
    if exit_code != 0 {
        // "<path>: No such file or directory"
        let line = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("");
        let reason = line.strip_prefix(path).and_then(|rest| rest.strip_prefix(": ")).unwrap_or(line);
        signature.error = Some(if reason.is_empty() { format!("codesign exited with code {}", exit_code) } else { reason.to_string() });
        return signature;
    }

    signature.signed = true;
    for line in stderr.lines() {
        if let Some(value) = line.strip_prefix("Identifier=") {
            signature.identifier.get_or_insert_with(|| value.to_string());
        } else if let Some(value) = line.strip_prefix("Authority=") {
            signature.authorities.push(value.to_string());
        } else if let Some(value) = line.strip_prefix("TeamIdentifier=") {
            signature.team_id = Some(value.to_string()).filter(|v| v != "not set" && !v.is_empty());
        } else if line == "Signature=adhoc" {
            signature.adhoc = true;
        }
    }
    signature
}

/// `codesign -v -R=<requirement> <path>`. The requirement is ONE argv element. No shell is involved.
fn codesign_verify_command(requirement: &str, path: &str) -> Vec<String> {
    vec![CODESIGN.to_string(), "-v".to_string(), format!("-R={}", requirement), path.to_string()]
}

/// Display the signature of an absolute path, then verify it against Apple's root when it is signed.
async fn signature_of(executable: &str) -> JobSignature {
    // The path is absolute, so codesign cannot read it as an option.
    let shown = run_with_timeout(&[CODESIGN, "-dv", "--verbose=2", executable], Some(CODESIGN_DISPLAY_TIMEOUT)).await;
    let mut signature = parse_codesign(executable, shown.code, &shown.stderr);
    if signature.signed {
        let apple = codesign_verify_command(REQUIREMENT_APPLE, executable);
        let issued = codesign_verify_command(REQUIREMENT_APPLE_ISSUED, executable);
        let (apple, issued) = tokio::join!(
            run_with_timeout(&apple, Some(CODESIGN_VERIFY_TIMEOUT)),
            run_with_timeout(&issued, Some(CODESIGN_VERIFY_TIMEOUT)),
        );
        // A timeout or a spawn error has a code other than 0, so it never counts as verified.
        signature.apple = apple.code == 0;
        signature.trusted = issued.code == 0;
    }
    signature
}

/// The executable path comes from the plist, never from the client.
pub async fn get_job_signature(label: &str, category: &str) -> Result<JobSignature, String> {
    scope_or_err(category)?;
    let failure = |path: Option<String>, error: &str| JobSignature { path, error: Some(error.to_string()), ..JobSignature::default() };

    let Some(file) = find_job_file(label, category).await else {
        return Ok(failure(None, "Job file not found."));
    };
    let Some(executable) = file.job.as_ref().and_then(job_executable) else {
        return Ok(failure(None, "The job has no executable."));
    };
    if !executable.starts_with('/') || executable.contains('\0') {
        return Ok(failure(Some(executable), "The executable path is not absolute."));
    }
    let is_file = {
        let path = PathBuf::from(&executable);
        tokio::task::spawn_blocking(move || path.is_file()).await.unwrap_or(false)
    };
    if !is_file {
        return Ok(failure(Some(executable), "Executable not found"));
    }
    Ok(signature_of(&executable).await)
}

// ── Background items ─────────────────────────────────────────────────

/// One record of `sfltool dumpbtm`.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundItem {
    pub uid: i64,
    pub name: String,
    pub developer_name: Option<String>,
    /// Text before " (0x..)", e.g. "developer", "legacy daemon", "login item", "app".
    pub r#type: String,
    /// e.g. ["enabled", "allowed", "notified"]
    pub disposition: Vec<String>,
    pub identifier: Option<String>,
    /// None for "(null)".
    pub url: Option<String>,
    pub executable_path: Option<String>,
    pub parent_identifier: Option<String>,
    pub team_identifier: Option<String>,
}

/// ` Records for UID 501 : <uuid>`
fn parse_uid_header(line: &str) -> Option<i64> {
    line.trim().strip_prefix("Records for UID ")?.split_whitespace().next()?.parse().ok()
}

/// ` #12:` starts a record. `    #1: 16.com.example` is an embedded identifier.
fn is_record_start(line: &str) -> bool {
    let Some(number) = line.trim().strip_prefix('#').and_then(|rest| rest.strip_suffix(':')) else {
        return false;
    };
    !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
}

fn nullable(value: &str) -> Option<String> {
    Some(value.to_string()).filter(|v| v != "(null)" && !v.is_empty())
}

/// "legacy daemon (0x10010)" → "legacy daemon"
fn strip_hex_suffix(value: &str) -> &str {
    match value.rfind(" (") {
        Some(at) if value.ends_with(')') => value[..at].trim_end(),
        _ => value,
    }
}

/// "[enabled, allowed, notified] (0xb)" → ["enabled", "allowed", "notified"]
fn parse_bracket_list(value: &str) -> Vec<String> {
    let inner = value.split_once('[').and_then(|(_, rest)| rest.split_once(']')).map(|(inner, _)| inner).unwrap_or("");
    inner.split(',').map(str::trim).filter(|item| !item.is_empty()).map(str::to_string).collect()
}

/// Records of the given uids. The `Embedded Item Identifiers` sub-lists are skipped.
fn parse_dumpbtm(text: &str, wanted_uids: &[i64]) -> Vec<BackgroundItem> {
    let mut items = Vec::new();
    let mut uid: Option<i64> = None;
    let mut current: Option<BackgroundItem> = None;
    let mut in_embedded = false;

    let finish = |item: Option<BackgroundItem>, items: &mut Vec<BackgroundItem>| {
        if let Some(item) = item.filter(|i| wanted_uids.contains(&i.uid)) {
            items.push(item);
        }
    };

    for line in text.lines() {
        if let Some(header_uid) = parse_uid_header(line) {
            finish(current.take(), &mut items);
            uid = Some(header_uid);
            in_embedded = false;
            continue;
        }
        if line.trim().is_empty() {
            in_embedded = false;
            continue;
        }
        if is_record_start(line) {
            finish(current.take(), &mut items);
            current = uid.map(|uid| BackgroundItem { uid, ..BackgroundItem::default() });
            in_embedded = false;
            continue;
        }
        if in_embedded {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key == "Embedded Item Identifiers" {
            in_embedded = true;
            continue;
        }
        let Some(item) = current.as_mut() else {
            continue;
        };
        match key {
            "Name" => item.name = nullable(value).unwrap_or_default(),
            "Developer Name" => item.developer_name = nullable(value),
            "Type" => item.r#type = strip_hex_suffix(value).to_string(),
            "Disposition" => item.disposition = parse_bracket_list(value),
            "Identifier" => item.identifier = nullable(value),
            "URL" => item.url = nullable(value),
            "Executable Path" => item.executable_path = nullable(value),
            "Parent Identifier" => item.parent_identifier = nullable(value),
            "Team Identifier" => item.team_identifier = nullable(value),
            _ => {}
        }
    }
    finish(current.take(), &mut items);
    items
}

/// Read-only: `sfltool dumpbtm`. Never `resetbtm`.
pub async fn get_background_items() -> Result<Vec<BackgroundItem>, String> {
    let result = run_with_timeout(&[SFLTOOL, "dumpbtm"], Some(DUMPBTM_TIMEOUT)).await;
    if result.code != 0 {
        return Err(if result.stderr.is_empty() { "Could not read the background items.".to_string() } else { result.stderr });
    }
    let wanted = [i64::from(uid()), 0, -2];
    let text = result.stdout;
    tokio::task::spawn_blocking(move || parse_dumpbtm(&text, &wanted)).await.map_err(|e| e.to_string())
}

// ── Login items ──────────────────────────────────────────────────────

const DELETE_LOGIN_ITEM_SCRIPT: [&str; 3] =
    ["on run argv", "tell application \"System Events\" to delete login item (item 1 of argv)", "end run"];

fn check_login_item_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.chars().count() > 255 || has_control_chars(name) {
        return Err("Invalid login item name.".to_string());
    }
    Ok(())
}

/// `osascript -e … -- <name>`: the name is an `argv` item after the `--` separator, never AppleScript source.
/// A login item can have any name, also `-e do shell script "…"`.
fn delete_login_item_command(name: &str) -> Vec<&str> {
    osascript_argv(&DELETE_LOGIN_ITEM_SCRIPT, std::slice::from_ref(&name))
}

pub async fn delete_login_item(name: &str) -> Result<(), String> {
    check_login_item_name(name)?;
    let result = run_with_timeout(&delete_login_item_command(name), Some(OSA_TIMEOUT)).await;
    if result.code == 0 {
        return Ok(());
    }
    Err(if is_automation_denied(&result.stderr) {
        AUTOMATION_DENIED.to_string()
    } else if result.stderr.is_empty() {
        "Could not delete the login item.".to_string()
    } else {
        result.stderr
    })
}

// ── Script apps ──────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct BuiltApp {
    pub path: String,
}

/// `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`
fn is_valid_app_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b' ' | b'.' | b'_' | b'-'))
}

/// A string literal of AppleScript: `\` and `"` are the only characters with a meaning inside it.
/// Control characters are rejected before this point.
fn applescript_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The one line of the applet. `quoted form of` makes the path safe for the shell at run time.
fn script_app_source(script_path: &str) -> String {
    format!("do shell script quoted form of {}", applescript_string(script_path))
}

fn check_script_path(script_path: &str) -> Result<(), String> {
    if !script_path.starts_with('/') {
        return Err("The script path must be absolute.".to_string());
    }
    if has_control_chars(script_path) {
        return Err("The script path contains control characters.".to_string());
    }
    Ok(())
}

/// Wrap a script in an applet, so that macOS can grant it privacy permissions.
pub async fn build_script_app(script_path: &str, name: &str) -> Result<BuiltApp, String> {
    if !is_valid_app_name(name) {
        return Err("The app name may only contain letters, digits, spaces, dots, dashes and underscores (64 characters).".to_string());
    }
    check_script_path(script_path)?;

    let applications = home_dir().join("Applications");
    let app = applications.join(format!("{}.app", name));
    let script = PathBuf::from(script_path);
    let target = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        match std::fs::metadata(&script) {
            Ok(meta) if meta.is_file() => {}
            Ok(_) => return Err("The script is not a regular file.".to_string()),
            Err(_) => return Err("Script not found.".to_string()),
        }
        std::fs::create_dir_all(&applications).map_err(|e| format!("Could not create {}: {}", applications.display(), e))?;
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(format!("{} already exists.", target.display()));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    let app_path = app.to_string_lossy().into_owned();
    let source = script_app_source(script_path);
    let result = run_with_timeout(&[OSACOMPILE, "-o", &app_path, "-e", &source], Some(OSA_TIMEOUT)).await;
    if result.code != 0 {
        return Err(if result.stderr.is_empty() { "osacompile could not build the app.".to_string() } else { result.stderr });
    }
    Ok(BuiltApp { path: app_path })
}

// ── Power schedule ───────────────────────────────────────────────────

/// One half of `pmset repeat`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct PowerEvent {
    /// "sleep" | "wake" | "poweron" | "shutdown" | "wakeorpoweron" | "restart"
    pub r#type: String,
    /// Subset of "MTWRFSU", in that order.
    pub days: String,
    /// "HH:MM:SS"
    pub time: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PowerSchedule {
    pub raw: String,
    pub repeating: Vec<PowerEvent>,
}

const OFF_TYPES: [&str; 3] = ["sleep", "shutdown", "restart"];
const ON_TYPES: [&str; 3] = ["wake", "poweron", "wakeorpoweron"];
const DAY_LETTERS: &str = "MTWRFSU";
const DAY_NAMES: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/// "7:00AM" → "07:00:00", "12:05AM" → "00:05:00", "11:30PM" → "23:30:00"
fn parse_clock(text: &str) -> Option<String> {
    let upper = text.trim().to_ascii_uppercase();
    let (clock, pm) = match (upper.strip_suffix("AM"), upper.strip_suffix("PM")) {
        (Some(clock), _) => (clock.trim_end().to_string(), Some(false)),
        (_, Some(clock)) => (clock.trim_end().to_string(), Some(true)),
        _ => (upper, None), // 24-hour clock
    };
    let mut parts = clock.split(':');
    let hour: u32 = parts.next()?.parse().ok()?;
    let minute: u32 = parts.next()?.parse().ok()?;
    let second: u32 = parts.next().map_or(Some(0), |s| s.parse().ok())?;
    let hour = match pm {
        Some(_) if !(1..=12).contains(&hour) => return None,
        Some(true) => hour % 12 + 12,
        Some(false) => hour % 12,
        None => hour,
    };
    (hour < 24 && minute < 60 && second < 60).then(|| format!("{:02}:{:02}:{:02}", hour, minute, second))
}

/// "every day" | "weekdays only" | "weekends only" | "Some days: Mon Wed"
fn parse_day_phrase(phrase: &str) -> Option<String> {
    let phrase = phrase.trim();
    let days = match phrase {
        "every day" => DAY_LETTERS.to_string(),
        "weekdays only" => "MTWRF".to_string(),
        "weekends only" => "SU".to_string(),
        _ => {
            let names: Vec<&str> = phrase.strip_prefix("Some days:")?.split_whitespace().collect();
            DAY_NAMES.iter().zip(DAY_LETTERS.chars()).filter(|(name, _)| names.contains(name)).map(|(_, letter)| letter).collect()
        }
    };
    (!days.is_empty()).then_some(days)
}

/// `  wakepoweron at 7:00AM weekdays only`
fn parse_repeat_line(line: &str) -> Option<PowerEvent> {
    let (kind, rest) = line.trim().split_once(" at ")?;
    let kind = match kind.trim() {
        "wakepoweron" => "wakeorpoweron", // pmset prints one name and accepts the other
        other => other,
    };
    if !OFF_TYPES.contains(&kind) && !ON_TYPES.contains(&kind) {
        return None;
    }
    let (clock, phrase) = rest.trim().split_once(char::is_whitespace)?;
    Some(PowerEvent { r#type: kind.to_string(), days: parse_day_phrase(phrase)?, time: parse_clock(clock)? })
}

/// The "Repeating power events" block of `pmset -g sched`.
fn parse_pmset_sched(raw: &str) -> PowerSchedule {
    let mut repeating = Vec::new();
    let mut in_block = false;
    for line in raw.lines() {
        if line.trim_start().starts_with("Repeating power events") {
            in_block = true;
        } else if in_block {
            if !line.starts_with(char::is_whitespace) || line.trim().is_empty() {
                in_block = false; // the next block ("Scheduled power events:") is not indented
            } else if let Some(event) = parse_repeat_line(line) {
                repeating.push(event);
            }
        }
    }
    PowerSchedule { raw: raw.to_string(), repeating }
}

/// `^M?T?W?R?F?S?U?$`, not empty
fn is_valid_days(days: &str) -> bool {
    let mut letters = DAY_LETTERS.chars();
    !days.is_empty() && days.chars().all(|day| letters.any(|letter| letter == day))
}

/// `^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$`
fn is_valid_time(time: &str) -> bool {
    let bytes = time.as_bytes();
    if bytes.len() != 8 || bytes[2] != b':' || bytes[5] != b':' {
        return false;
    }
    let number = |at: usize| -> Option<u32> {
        (bytes[at].is_ascii_digit() && bytes[at + 1].is_ascii_digit()).then(|| u32::from(bytes[at] - b'0') * 10 + u32::from(bytes[at + 1] - b'0'))
    };
    matches!((number(0), number(3), number(6)), (Some(h), Some(m), Some(s)) if h < 24 && m < 60 && s < 60)
}

/// Arguments for `pmset`. Everything is validated here, before anything reaches a shell.
/// At most two events: one that turns the Mac off and one that turns it on.
fn pmset_repeat_args(events: &[PowerEvent]) -> Result<Vec<String>, String> {
    if events.is_empty() {
        return Ok(vec!["repeat".to_string(), "cancel".to_string()]);
    }
    if events.len() > 2 {
        return Err("pmset accepts at most two repeating events.".to_string());
    }
    let mut args = vec!["repeat".to_string()];
    let (mut off, mut on) = (0, 0);
    for event in events {
        let kind = event.r#type.as_str();
        if OFF_TYPES.contains(&kind) {
            off += 1;
        } else if ON_TYPES.contains(&kind) {
            on += 1;
        } else {
            return Err(format!("Unknown power event type: {}", kind.chars().filter(|c| !c.is_control()).take(40).collect::<String>()));
        }
        if !is_valid_days(&event.days) {
            return Err("Days must be a subset of MTWRFSU, in that order.".to_string());
        }
        if !is_valid_time(&event.time) {
            return Err("Time must have the form HH:MM:SS.".to_string());
        }
        args.extend([event.r#type.clone(), event.days.clone(), event.time.clone()]);
    }
    if off > 1 || on > 1 {
        return Err("Use one of sleep, shutdown or restart, and one of wake, poweron or wakeorpoweron.".to_string());
    }
    Ok(args)
}

pub async fn get_power_schedule() -> Result<PowerSchedule, String> {
    let result = run_with_timeout(&[PMSET, "-g", "sched"], Some(COMMAND_TIMEOUT)).await;
    if result.code != 0 {
        return Err(if result.stderr.is_empty() { "Could not read the power schedule.".to_string() } else { result.stderr });
    }
    Ok(parse_pmset_sched(&result.stdout))
}

/// One administrator prompt. An empty list cancels the repeating events.
pub async fn set_power_schedule(events: &[PowerEvent]) -> Result<(), String> {
    let args = pmset_repeat_args(events)?;
    let mut cmd = vec![PMSET];
    cmd.extend(args.iter().map(String::as_str));
    run_privileged_command(&cmd, "mac-dash wants to change the power schedule.").await
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPLE: &str = "Executable=/bin/ls\nIdentifier=com.apple.ls\nFormat=Mach-O universal (x86_64 arm64e)\nCodeDirectory v=20400 size=325 flags=0x0(none) hashes=5+2 location=embedded\nPlatform identifier=26\nSignature size=4202\nAuthority=Software Signing\nAuthority=Apple Code Signing Certification Authority\nAuthority=Apple Root CA\nSigned Time=8 Aug 2026 at 23:31:18\nInfo.plist=not bound\nTeamIdentifier=not set\nSealed Resources=none\nInternal requirements count=1 size=60";

    const DEVELOPER_ID: &str = "Executable=/Applications/Claude.app/Contents/MacOS/Claude\nIdentifier=com.anthropic.claudefordesktop\nFormat=app bundle with Mach-O universal (x86_64 arm64)\nCodeDirectory v=20500 size=458 flags=0x10000(runtime) hashes=3+7 location=embedded\nSignature size=9046\nAuthority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTimestamp=18 Sep 2026 at 03:51:40\nNotarization Ticket=stapled\nInfo.plist entries=43\nTeamIdentifier=Q6L2SF6YDW\nRuntime Version=26.5.0\nSealed Resources version=2 rules=13 files=3525\nInternal requirements count=1 size=192";

    const ADHOC: &str = "Executable=/path/target/debug/deps/tool\nIdentifier=tool-d6a98bf5659a87c3\nFormat=Mach-O thin (arm64)\nCodeDirectory v=20400 size=122490 flags=0x20002(adhoc,linker-signed) hashes=3824+0 location=embedded\nSignature=adhoc\nInfo.plist=not bound\nTeamIdentifier=not set\nSealed Resources=none\nInternal requirements=none";

    #[test]
    fn codesign_apple_binary() {
        let signature = parse_codesign("/bin/ls", 0, APPLE);
        assert_eq!(signature.path.as_deref(), Some("/bin/ls"));
        assert!(signature.signed && !signature.adhoc);
        // Names prove nothing: the parser never sets the verified flags.
        assert!(!signature.apple && !signature.trusted);
        assert_eq!(signature.identifier.as_deref(), Some("com.apple.ls"));
        assert_eq!(signature.authorities, vec!["Software Signing", "Apple Code Signing Certification Authority", "Apple Root CA"]);
        assert_eq!(signature.team_id, None);
        assert_eq!(signature.error, None);

        // A self-signed certificate can carry any name. It must not look like Apple.
        let forged = parse_codesign("/x", 0, "Identifier=x\nAuthority=Software Signing\nAuthority=Apple Root CA\nTeamIdentifier=ABCDE12345");
        assert!(forged.signed && !forged.apple && !forged.trusted);
        assert_eq!(forged.authorities[0], "Software Signing");
        assert_eq!(forged.team_id.as_deref(), Some("ABCDE12345"));
    }

    #[test]
    fn codesign_verify_arguments() {
        assert_eq!(
            codesign_verify_command(REQUIREMENT_APPLE, "/bin/ls"),
            vec!["/usr/bin/codesign", "-v", "-R=anchor apple", "/bin/ls"]
        );
        // The requirement stays ONE argv element, and a path with spaces stays one as well.
        assert_eq!(
            codesign_verify_command(REQUIREMENT_APPLE_ISSUED, "/Applications/My App.app/Contents/MacOS/My App"),
            vec!["/usr/bin/codesign", "-v", "-R=anchor apple generic", "/Applications/My App.app/Contents/MacOS/My App"]
        );
    }

    #[test]
    fn codesign_developer_id() {
        let signature = parse_codesign("/Applications/Claude.app/Contents/MacOS/Claude", 0, DEVELOPER_ID);
        assert!(signature.signed && !signature.apple && !signature.trusted && !signature.adhoc);
        assert_eq!(signature.identifier.as_deref(), Some("com.anthropic.claudefordesktop"));
        assert_eq!(signature.authorities[0], "Developer ID Application: Anthropic PBC (Q6L2SF6YDW)");
        assert_eq!(signature.authorities.len(), 3);
        assert_eq!(signature.team_id.as_deref(), Some("Q6L2SF6YDW"));
    }

    #[test]
    fn codesign_adhoc_unsigned_and_missing() {
        let adhoc = parse_codesign("/path/target/debug/deps/tool", 0, ADHOC);
        assert!(adhoc.signed && adhoc.adhoc && !adhoc.apple);
        assert!(adhoc.authorities.is_empty());
        assert_eq!(adhoc.team_id, None);

        let unsigned = parse_codesign("/etc/hosts", 1, "/etc/hosts: code object is not signed at all");
        assert_eq!(unsigned, JobSignature { path: Some("/etc/hosts".into()), ..JobSignature::default() });

        let missing = parse_codesign("/nonexistent/file", 1, "/nonexistent/file: No such file or directory");
        assert!(!missing.signed);
        assert_eq!(missing.error.as_deref(), Some("No such file or directory"));

        let folder = parse_codesign("/tmp", 1, "/tmp: bundle format unrecognized, invalid, or unsuitable");
        assert_eq!(folder.error.as_deref(), Some("bundle format unrecognized, invalid, or unsuitable"));
        assert_eq!(parse_codesign("/x", -1, "").error.as_deref(), Some("codesign exited with code -1"));

        let json = serde_json::to_value(&adhoc).unwrap();
        assert_eq!(json["teamId"], serde_json::Value::Null);
        assert_eq!(json["adhoc"], true);
        assert_eq!(json["apple"], false);
        assert_eq!(json["trusted"], false);
    }

    /// Captured from `sfltool dumpbtm` on macOS and trimmed. The layout is unchanged.
    const DUMPBTM: &str = "========================
 Records for UID -2 : FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE
========================

 ServiceManagement migrated: true
 LaunchServices registered: false

 Items:

 #1:
                 UUID: F795003E-4AF4-4F54-AC11-9385A7206B83
                 Name: AutoCAD
       Developer Name: AutoCAD
                 Type: developer (0x20)
                Flags: [ curated ] (0x4)
          Disposition: [disabled, allowed, not notified] (0x2)
           Identifier: AutoCAD
                  URL: (null)
           Generation: 0
  Embedded Item Identifiers:
    #1: 16.com.autodesk.adskaccessservicehost
    #2: 16.com.autodesk.other

 #2:
                 UUID: 68353594-0105-463F-AAD0-AE5B903875A1
                 Name: AdskAccessServiceHost
       Developer Name: AutoCAD
      Team Identifier: XXKJ396S2Y
                 Type: legacy daemon (0x10010)
                Flags: [ legacy, curated ] (0x5)
          Disposition: [enabled, disallowed, notified] (0x9)
           Identifier: 16.com.autodesk.adskaccessservicehost
                  URL: file:///Library/LaunchDaemons/com.autodesk.adskaccessservicehost.plist
      Executable Path: /Library/Application Support/Autodesk/AdODIS/V1/Setup/AdskAccessServiceHost
           Generation: 3
    Assoc. Bundle IDs: [ com.autodesk.AutoCAD2022 ]
    Parent Identifier: AutoCAD

========================
 Records for UID 0 : FFFFEEEE-DDDD-CCCC-BBBB-AAAA00000000
========================

 ServiceManagement migrated: true
 LaunchServices registered: false

 Items:

 #1:
                 UUID: 00000000-1111-2222-3333-444444444444
                 Name: com.docker.vmnetd
       Developer Name: Docker Inc
      Team Identifier: 9BNSXJN65R
                 Type: daemon (0x10)
                Flags: [  ] (0)
          Disposition: [enabled, allowed, notified] (0xb)
           Identifier: 16.com.docker.vmnetd
                  URL: Contents/Library/LaunchDaemons/com.docker.vmnetd.plist
      Executable Path: /Library/PrivilegedHelperTools/com.docker.vmnetd
           Generation: 1
    Parent Identifier: 2.com.docker.docker

========================
 Records for UID 501 : FA7B2188-5C79-409C-AD7A-704FB1B05396
========================

 ServiceManagement migrated: true
 LaunchServices registered: true

 Items:

 #1:
                 UUID: 74101492-E3B2-4A96-BEB2-11843EB713DD
                 Name: (null)
       Developer Name: (null)
                 Type: developer (0x20)
                Flags: [  ] (0)
          Disposition: [disabled, allowed, not notified] (0x2)
           Identifier: Unknown Developer
                  URL: (null)
           Generation: 1

 #35:
                 UUID: CF1E82F2-C464-48A2-9CA1-0A6B1A9C1F03
                 Name: DockerHelper
       Developer Name: Docker Inc
      Team Identifier: 9BNSXJN65R
                 Type: login item (0x4)
                Flags: [  ] (0)
          Disposition: [enabled, allowed, notified] (0xb)
           Identifier: 4.com.docker.helper
                  URL: Contents/Library/LoginItems/DockerHelper.app
           Generation: 1
    Bundle Identifier: com.docker.helper
    Parent Identifier: 2.com.docker.docker

========================
 Records for UID 502 : 555DF79A-92DF-443B-9B6A-1678D2AFE585
========================

 Items:

 #1:
                 UUID: B2447DAF-6658-4D22-8F6C-0BF0790197F4
                 Name: Someone Else: Helper
       Developer Name: (null)
                 Type: app (0x2)
                Flags: [  ] (0)
          Disposition: [enabled, allowed, notified] (0xb)
           Identifier: 2.com.example.other
                  URL: file:///Applications/Other.app/
           Generation: 1


";

    #[test]
    fn dumpbtm_records() {
        let items = parse_dumpbtm(DUMPBTM, &[501, 0, -2]);
        assert_eq!(items.len(), 5, "the record of uid 502 and the embedded identifiers are left out");
        assert_eq!(items.iter().map(|i| i.uid).collect::<Vec<_>>(), vec![-2, -2, 0, 501, 501]);

        let developer = &items[0];
        assert_eq!(developer.name, "AutoCAD");
        assert_eq!(developer.r#type, "developer");
        assert_eq!(developer.disposition, vec!["disabled", "allowed", "not notified"]);
        assert_eq!(developer.identifier.as_deref(), Some("AutoCAD"), "an embedded identifier must not overwrite it");
        assert_eq!(developer.url, None);
        assert_eq!(developer.team_identifier, None);

        let daemon = &items[1];
        assert_eq!(daemon.r#type, "legacy daemon");
        assert_eq!(daemon.developer_name.as_deref(), Some("AutoCAD"));
        assert_eq!(daemon.team_identifier.as_deref(), Some("XXKJ396S2Y"));
        assert_eq!(daemon.url.as_deref(), Some("file:///Library/LaunchDaemons/com.autodesk.adskaccessservicehost.plist"));
        assert_eq!(daemon.executable_path.as_deref(), Some("/Library/Application Support/Autodesk/AdODIS/V1/Setup/AdskAccessServiceHost"));
        assert_eq!(daemon.parent_identifier.as_deref(), Some("AutoCAD"));
        assert_eq!(daemon.disposition, vec!["enabled", "disallowed", "notified"]);

        assert_eq!(items[2].r#type, "daemon");
        assert_eq!(items[2].uid, 0);

        let unknown = &items[3];
        assert_eq!(unknown.name, "");
        assert_eq!(unknown.developer_name, None);
        assert_eq!(unknown.identifier.as_deref(), Some("Unknown Developer"));

        let login_item = &items[4];
        assert_eq!(login_item.r#type, "login item");
        assert_eq!(login_item.url.as_deref(), Some("Contents/Library/LoginItems/DockerHelper.app"));

        // Another user only sees its own records plus the shared ones.
        let other = parse_dumpbtm(DUMPBTM, &[502, 0, -2]);
        assert_eq!(other.len(), 4);
        assert_eq!(other[3].name, "Someone Else: Helper", "only the first colon splits key and value");
        assert_eq!(other[3].url.as_deref(), Some("file:///Applications/Other.app/"));

        assert!(parse_dumpbtm("", &[501]).is_empty());
        assert!(parse_dumpbtm(" #1:\n Name: orphan without a uid header\n", &[501]).is_empty());

        let json = serde_json::to_value(login_item).unwrap();
        assert_eq!(json["developerName"], "Docker Inc");
        assert_eq!(json["type"], "login item");
        assert_eq!(json["executablePath"], serde_json::Value::Null);
        assert_eq!(json["parentIdentifier"], "2.com.docker.docker");
        assert_eq!(json["teamIdentifier"], "9BNSXJN65R");
    }

    #[test]
    fn dumpbtm_line_kinds() {
        assert!(is_record_start(" #1:"));
        assert!(is_record_start(" #128:   "));
        assert!(!is_record_start("    #1: 16.com.autodesk.cer"));
        assert!(!is_record_start(" #:"));
        assert!(!is_record_start(" #a:"));
        assert_eq!(parse_uid_header(" Records for UID -2 : FFFFEEEE-DDDD"), Some(-2));
        assert_eq!(parse_uid_header(" Records for UID 501 : FA7B"), Some(501));
        assert_eq!(parse_uid_header(" Items:"), None);
        assert_eq!(strip_hex_suffix("background tasks (0x2000)"), "background tasks");
        assert_eq!(strip_hex_suffix("app"), "app");
        assert!(parse_bracket_list("[  ] (0)").is_empty());
    }

    #[test]
    fn login_item_delete_command() {
        let cmd = delete_login_item_command("Evil\" & (do shell script \"id\") & \"");
        // The name is the last argv item, after the separator. The AppleScript source is constant.
        assert_eq!(
            cmd,
            vec![
                "/usr/bin/osascript",
                "-e",
                "on run argv",
                "-e",
                "tell application \"System Events\" to delete login item (item 1 of argv)",
                "-e",
                "end run",
                "--",
                "Evil\" & (do shell script \"id\") & \"",
            ]
        );
        assert!(cmd[..8].iter().all(|part| !part.contains("Evil")));

        // A login item whose name looks like an osascript option. Without "--" it would be compiled as code.
        let hostile = "-e do shell script \"id > /tmp/pwned\"";
        let cmd = delete_login_item_command(hostile);
        assert_eq!(cmd[cmd.len() - 2..], ["--", hostile]);
        assert_eq!(cmd.iter().filter(|part| part.starts_with('-') && **part != "-e" && **part != "--").count(), 1, "only the name itself");
        assert!(check_login_item_name(hostile).is_ok(), "the name is legal, so the separator must protect it");

        assert!(check_login_item_name("Dropbox").is_ok());
        assert!(check_login_item_name("").is_err());
        assert!(check_login_item_name("a\nb").is_err());
        assert!(check_login_item_name(&"x".repeat(256)).is_err());
        assert!(is_automation_denied("execution error: Not authorized to send Apple events to System Events. (-1743)"));
    }

    #[test]
    fn app_names() {
        for good in ["Backup", "My Backup 2", "a", "A.b_c-d", &"x".repeat(64)] {
            assert!(is_valid_app_name(good), "{:?}", good);
        }
        for bad in ["", " lead", ".hidden", "-dash", "a/b", "a:b", "ünï", "a\nb", "a\"b", &"x".repeat(65), "../x"] {
            assert!(!is_valid_app_name(bad), "{:?}", bad);
        }
    }

    #[test]
    fn applescript_escaping() {
        assert_eq!(applescript_string("/Users/me/run.sh"), "\"/Users/me/run.sh\"");
        assert_eq!(applescript_string("/a \"b\"/c"), "\"/a \\\"b\\\"/c\"");
        assert_eq!(applescript_string("/a\\b"), "\"/a\\\\b\"");
        // A backslash before a quote: both are escaped, so the literal cannot end early.
        assert_eq!(applescript_string("/x\\\" & (do shell script \"id\") & \""), "\"/x\\\\\\\" & (do shell script \\\"id\\\") & \\\"\"");
        assert_eq!(
            script_app_source("/Users/me/it's \"here\"/$(id) `x`.sh"),
            "do shell script quoted form of \"/Users/me/it's \\\"here\\\"/$(id) `x`.sh\""
        );

        // Every quote inside the literal is escaped: the number of unescaped quotes is exactly two.
        for hostile in ["\"", "\\", "\\\"", "\"\\\"\\", "a\" & b & \"c", "\\\\\"\\\\"] {
            let literal = applescript_string(hostile);
            let (mut unescaped, mut chars) = (0, literal.chars());
            while let Some(c) = chars.next() {
                match c {
                    '\\' => {
                        chars.next();
                    }
                    '"' => unescaped += 1,
                    _ => {}
                }
            }
            assert_eq!(unescaped, 2, "{:?} -> {}", hostile, literal);
        }

        assert!(check_script_path("/Users/me/run.sh").is_ok());
        assert!(check_script_path("relative/run.sh").is_err());
        assert!(check_script_path("~/run.sh").is_err());
        assert!(check_script_path("/Users/me/a\nb.sh").is_err());
        assert!(check_script_path("/Users/me/a\u{2028}b.sh").is_err());
        assert!(check_script_path("/Users/me/a\0b.sh").is_err());
    }

    #[test]
    fn pmset_schedule_lines() {
        let raw = "Repeating power events:\n  wakepoweron at 7:00AM weekdays only\n  sleep at 11:30PM every day\nScheduled power events:\n [0]  wake at 09/22/2026 07:00:00 by 'com.apple.alarm.user-visible-Weekly Usage Report'\n";
        let schedule = parse_pmset_sched(raw);
        assert_eq!(schedule.raw, raw);
        assert_eq!(
            schedule.repeating,
            vec![
                PowerEvent { r#type: "wakeorpoweron".into(), days: "MTWRF".into(), time: "07:00:00".into() },
                PowerEvent { r#type: "sleep".into(), days: "MTWRFSU".into(), time: "23:30:00".into() },
            ]
        );

        let some = parse_pmset_sched("Repeating power events:\n  shutdown at 9:00PM Some days: Mon Wed \n  poweron at 12:05AM weekends only\n");
        assert_eq!(
            some.repeating,
            vec![
                PowerEvent { r#type: "shutdown".into(), days: "MW".into(), time: "21:00:00".into() },
                PowerEvent { r#type: "poweron".into(), days: "SU".into(), time: "00:05:00".into() },
            ]
        );

        // Nothing scheduled, and a block with only one-time events
        assert!(parse_pmset_sched("").repeating.is_empty());
        assert!(parse_pmset_sched("Scheduled power events:\n [0]  wake at 09/22/2026 07:00:00 by 'x'\n").repeating.is_empty());
        // Day names come back in calendar order, whatever pmset prints.
        assert_eq!(parse_day_phrase("Some days: Sun Tue Thu"), Some("TRU".into()));
        assert_eq!(parse_day_phrase("Some days:"), None);
        assert_eq!(parse_clock("12:00PM").as_deref(), Some("12:00:00"));
        assert_eq!(parse_clock("12:00AM").as_deref(), Some("00:00:00"));
        assert_eq!(parse_clock("23:15:30").as_deref(), Some("23:15:30"));
        assert_eq!(parse_clock("13:00PM"), None);
        assert_eq!(parse_clock("7:60AM"), None);
        // The wire name of the JSON is "type".
        assert_eq!(serde_json::to_value(&schedule.repeating[0]).unwrap()["type"], "wakeorpoweron");
    }

    /// Read-only checks against the real tools: `cargo test -- --ignored live`.
    /// They run `codesign -dv`, `sfltool dumpbtm` and `pmset -g sched`. They change nothing.
    #[tokio::test]
    #[ignore]
    async fn live_read_only_tools() {
        let finder = get_job_signature("com.apple.Finder", "system-agents").await.unwrap();
        println!("{}", serde_json::to_string(&finder).unwrap());
        assert!(finder.signed && finder.apple && finder.trusted && !finder.adhoc, "{:?}", finder);
        assert_eq!(finder.error, None);

        // Verified flags: Apple's own code, this adhoc-signed test binary, and a Developer ID app when present.
        let ls = signature_of("/bin/ls").await;
        assert!(ls.signed && ls.apple && ls.trusted, "{:?}", ls);
        let me = std::env::current_exe().unwrap();
        let own = signature_of(me.to_str().unwrap()).await;
        println!("{}", serde_json::to_string(&own).unwrap());
        assert!(own.signed && own.adhoc && !own.apple && !own.trusted, "{:?}", own);
        let developer_id = "/Applications/Claude.app/Contents/MacOS/Claude";
        if std::path::Path::new(developer_id).is_file() {
            let app = signature_of(developer_id).await;
            assert!(app.signed && !app.apple && app.trusted, "{:?}", app);
        }
        let unsigned = signature_of("/etc/hosts").await;
        assert!(!unsigned.signed && !unsigned.apple && !unsigned.trusted && unsigned.error.is_none());

        let missing = get_job_signature("no.such.job", "user-agents").await.unwrap();
        assert_eq!(missing.error.as_deref(), Some("Job file not found."));
        assert!(get_job_signature("x", "bogus-category").await.is_err());

        let items = get_background_items().await.unwrap();
        let me = i64::from(uid());
        println!("{} background items, {} of this user", items.len(), items.iter().filter(|i| i.uid == me).count());
        assert!(!items.is_empty());
        assert!(items.iter().all(|i| [me, 0, -2].contains(&i.uid) && !i.r#type.is_empty() && !i.r#type.contains("(0x")));
        assert!(items.iter().all(|i| i.url.as_deref() != Some("(null)")));

        let schedule = get_power_schedule().await.unwrap();
        println!("power schedule: {:?}", schedule.repeating);
    }

    fn event(kind: &str, days: &str, time: &str) -> PowerEvent {
        PowerEvent { r#type: kind.into(), days: days.into(), time: time.into() }
    }

    #[test]
    fn pmset_arguments() {
        assert_eq!(pmset_repeat_args(&[]).unwrap(), vec!["repeat", "cancel"]);
        assert_eq!(pmset_repeat_args(&[event("sleep", "MTWRFSU", "23:30:00")]).unwrap(), vec!["repeat", "sleep", "MTWRFSU", "23:30:00"]);
        assert_eq!(
            pmset_repeat_args(&[event("wakeorpoweron", "MTWRF", "07:00:00"), event("shutdown", "U", "00:00:59")]).unwrap(),
            vec!["repeat", "wakeorpoweron", "MTWRF", "07:00:00", "shutdown", "U", "00:00:59"]
        );

        // Two events of the same half, and more than two events
        assert!(pmset_repeat_args(&[event("sleep", "M", "01:00:00"), event("restart", "T", "02:00:00")]).is_err());
        assert!(pmset_repeat_args(&[event("wake", "M", "01:00:00"), event("poweron", "T", "02:00:00")]).is_err());
        assert!(pmset_repeat_args(&[event("sleep", "M", "01:00:00"), event("wake", "T", "02:00:00"), event("restart", "W", "03:00:00")]).is_err());

        // Nothing unchecked reaches the shell.
        for (kind, days, time) in [
            ("cancel", "M", "01:00:00"),
            ("sleep; rm -rf /", "M", "01:00:00"),
            ("wakepoweron", "M", "01:00:00"),
            ("sleep", "", "01:00:00"),
            ("sleep", "MM", "01:00:00"),
            ("sleep", "UM", "01:00:00"),
            ("sleep", "mtw", "01:00:00"),
            ("sleep", "M $(id)", "01:00:00"),
            ("sleep", "M", "1:00:00"),
            ("sleep", "M", "24:00:00"),
            ("sleep", "M", "23:60:00"),
            ("sleep", "M", "23:00"),
            ("sleep", "M", "23:00:00 "),
            ("sleep", "M", "2٣:00:00"),
            ("sleep", "M", "23:00:00'; id; '"),
        ] {
            assert!(pmset_repeat_args(&[event(kind, days, time)]).is_err(), "{:?} {:?} {:?}", kind, days, time);
        }
        assert!(is_valid_days("MTWRFSU") && is_valid_days("TRU") && is_valid_days("U"));
        assert!(is_valid_time("00:00:00") && is_valid_time("23:59:59"));
    }
}
