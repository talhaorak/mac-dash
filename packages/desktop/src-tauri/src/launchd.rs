//! launchd knowledge shared with the Bun server. This is the Rust port of the parts of
//! `shared/launchd.ts` that a backend needs: scopes, label rules, trigger summaries.
//! Output strings must stay identical to the TypeScript version.

use plist::{Dictionary, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScopeKind {
    Agent,
    Daemon,
}

#[derive(Debug)]
pub struct JobScope {
    pub category: &'static str,
    pub title: &'static str,
    /// Directory, with "~" for the home folder.
    pub dir: &'static str,
    pub kind: ScopeKind,
    /// System scopes are protected by SIP and can never be written.
    pub writable: bool,
    /// Writing here needs administrator rights.
    pub needs_admin: bool,
}

pub const JOB_SCOPES: [JobScope; 5] = [
    JobScope {
        category: "user-agents",
        title: "User Agents",
        dir: "~/Library/LaunchAgents",
        kind: ScopeKind::Agent,
        writable: true,
        needs_admin: false,
    },
    JobScope {
        category: "global-agents",
        title: "Global Agents",
        dir: "/Library/LaunchAgents",
        kind: ScopeKind::Agent,
        writable: true,
        needs_admin: true,
    },
    JobScope {
        category: "global-daemons",
        title: "Global Daemons",
        dir: "/Library/LaunchDaemons",
        kind: ScopeKind::Daemon,
        writable: true,
        needs_admin: true,
    },
    JobScope {
        category: "system-agents",
        title: "System Agents",
        dir: "/System/Library/LaunchAgents",
        kind: ScopeKind::Agent,
        writable: false,
        needs_admin: true,
    },
    JobScope {
        category: "system-daemons",
        title: "System Daemons",
        dir: "/System/Library/LaunchDaemons",
        kind: ScopeKind::Daemon,
        writable: false,
        needs_admin: true,
    },
];

pub fn scope_for(category: &str) -> Option<&'static JobScope> {
    JOB_SCOPES.iter().find(|s| s.category == category)
}

/// `^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`. A label becomes a file name and a launchctl target.
pub fn is_valid_label(label: &str) -> bool {
    let bytes = label.as_bytes();
    if bytes.is_empty() || bytes.len() > 201 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Weaker rule for services that only become a `launchctl` target (never a file name).
/// launchd labels of running apps contain characters outside the file-safe alphabet.
pub fn is_valid_target_label(label: &str) -> bool {
    !label.is_empty() && !label.contains('/') && !label.starts_with('-') && !label.contains('\0')
}

/// Sort key that follows `String.prototype.localeCompare` for the alphabet of launchd labels:
/// punctuation before digits before letters, case only as a tie-break (lowercase first).
/// Both backends return the job list in the same order this way.
pub fn label_sort_key(label: &str) -> (Vec<u32>, Vec<bool>, String) {
    // Order of the common punctuation in the default Unicode collation.
    const PUNCTUATION: &str = "_-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$";
    let primary = label
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            c if c.is_whitespace() => 0,
            c if c.is_ascii_digit() => 1000 + c as u32,
            c if c.is_alphanumeric() => 2000 + c as u32,
            c => PUNCTUATION.chars().position(|p| p == c).map_or(500 + c as u32, |at| 1 + at as u32),
        })
        .collect();
    let uppercase = label.chars().map(char::is_uppercase).collect();
    (primary, uppercase, label.to_string())
}

// ── Summaries ────────────────────────────────────────────────────────

const WEEKDAYS: [&str; 8] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 13] = [
    "", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The TypeScript parser maps `<integer>` to a number and `<real>` to a wrapper object,
/// so only integers count as numbers here.
fn as_integer(value: Option<&Value>) -> Option<i128> {
    match value {
        Some(Value::Integer(i)) => i
            .as_signed()
            .map(i128::from)
            .or_else(|| i.as_unsigned().map(i128::from)),
        _ => None,
    }
}

pub fn format_interval(seconds: i128) -> String {
    if seconds % 86400 == 0 {
        format!("{} d", seconds / 86400)
    } else if seconds % 3600 == 0 {
        format!("{} h", seconds / 3600)
    } else if seconds % 60 == 0 {
        format!("{} min", seconds / 60)
    } else {
        format!("{} s", seconds)
    }
}

/// `String(n).padStart(2, "0")`
fn pad2(n: i128) -> String {
    let text = n.to_string();
    if text.len() < 2 {
        format!("0{}", text)
    } else {
        text
    }
}

pub fn describe_calendar_entry(entry: &Dictionary) -> String {
    let num = |key: &str| as_integer(entry.get(key));
    let (minute, hour, day, weekday, month) =
        (num("Minute"), num("Hour"), num("Day"), num("Weekday"), num("Month"));

    let time = match (hour, minute) {
        (Some(h), Some(m)) => format!("at {}:{}", pad2(h), pad2(m)),
        (Some(h), None) => format!("every minute of hour {}", pad2(h)),
        (None, Some(m)) => format!("at minute {} of every hour", pad2(m)),
        (None, None) => "every minute".to_string(),
    };

    let lookup = |table: &[&str], index: i128| -> Option<String> {
        usize::try_from(index)
            .ok()
            .and_then(|i| table.get(i))
            .map(|s| s.to_string())
    };

    // launchd, like cron, starts the job when Day OR Weekday matches if both are set.
    let mut days = Vec::new();
    if let Some(d) = day {
        days.push(format!("on day {}", d));
    }
    if let Some(w) = weekday {
        days.push(format!(
            "on {}",
            lookup(&WEEKDAYS, w).unwrap_or_else(|| format!("weekday {}", w))
        ));
    }
    let mut parts = vec![time];
    if !days.is_empty() {
        parts.push(days.join(" or "));
    }
    if let Some(m) = month {
        parts.push(format!(
            "in {}",
            lookup(&MONTHS, m).unwrap_or_else(|| format!("month {}", m))
        ));
    }
    parts.join(" ")
}

pub fn calendar_entries(value: Option<&Value>) -> Vec<&Dictionary> {
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_dictionary).collect(),
        Some(Value::Dictionary(dict)) => vec![dict],
        _ => Vec::new(),
    }
}

fn is_true(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Boolean(true)))
}

fn is_dict(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Dictionary(_)))
}

fn array_len(value: Option<&Value>) -> usize {
    match value {
        Some(Value::Array(items)) => items.len(),
        _ => 0,
    }
}

/// Short trigger tags for the job list, e.g. `["At load", "Every 5 min"]`.
pub fn describe_triggers(job: &Dictionary) -> Vec<String> {
    let mut tags = Vec::new();
    if is_true(job.get("RunAtLoad")) {
        tags.push("At load".to_string());
    }
    match job.get("KeepAlive") {
        Some(Value::Boolean(true)) => tags.push("Keep alive".to_string()),
        Some(Value::Dictionary(conditions)) if !conditions.is_empty() => {
            tags.push("Keep alive (conditional)".to_string())
        }
        _ => {}
    }
    if let Some(seconds) = as_integer(job.get("StartInterval")) {
        tags.push(format!("Every {}", format_interval(seconds)));
    }
    let calendar = calendar_entries(job.get("StartCalendarInterval"));
    if calendar.len() == 1 {
        tags.push(format!("Calendar: {}", describe_calendar_entry(calendar[0])));
    } else if calendar.len() > 1 {
        tags.push(format!("Calendar ×{}", calendar.len()));
    }
    let watched = array_len(job.get("WatchPaths"));
    if watched > 0 {
        tags.push(format!("Watches {} path{}", watched, if watched > 1 { "s" } else { "" }));
    }
    if array_len(job.get("QueueDirectories")) > 0 {
        tags.push("Queue directory".to_string());
    }
    if is_true(job.get("StartOnMount")) {
        tags.push("On mount".to_string());
    }
    if is_dict(job.get("Sockets")) {
        tags.push("Socket".to_string());
    }
    if is_dict(job.get("MachServices")) {
        tags.push("Mach service".to_string());
    }
    if is_dict(job.get("LaunchEvents")) {
        tags.push("Launch event".to_string());
    }
    tags
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_string).filter(|s| !s.is_empty())
}

/// The executable launchd will run: Program, else ProgramArguments[0].
pub fn job_executable(job: &Dictionary) -> Option<String> {
    if let Some(program) = non_empty_string(job.get("Program")) {
        return Some(program.to_string());
    }
    let first = job.get("ProgramArguments").and_then(Value::as_array).and_then(|a| a.first());
    non_empty_string(first).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(xml_body: &str) -> Dictionary {
        let xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>{}</dict></plist>",
            xml_body
        );
        plist::from_bytes::<Value>(xml.as_bytes())
            .unwrap()
            .into_dictionary()
            .unwrap()
    }

    #[test]
    fn label_pattern() {
        assert!(is_valid_label("com.example.job"));
        assert!(is_valid_label("a"));
        assert!(is_valid_label("A1._-"));
        assert!(is_valid_label(&format!("a{}", "b".repeat(200))));
        assert!(!is_valid_label(&format!("a{}", "b".repeat(201))));
        assert!(!is_valid_label(""));
        assert!(!is_valid_label(".hidden"));
        assert!(!is_valid_label("-flag"));
        assert!(!is_valid_label("../evil"));
        assert!(!is_valid_label("a/b"));
        assert!(!is_valid_label("a b"));
        assert!(!is_valid_label("a\n"));
        assert!(!is_valid_label("ünicode"));
    }

    #[test]
    fn target_label_rule() {
        assert!(is_valid_target_label("application.com.apple.Safari.1234.5678"));
        assert!(is_valid_target_label("com.apple.xpc.launchd.unmanaged.foo (1)"));
        assert!(!is_valid_target_label(""));
        assert!(!is_valid_target_label("-k"));
        assert!(!is_valid_target_label("system/com.apple.foo"));
    }

    #[test]
    fn label_order_matches_locale_compare() {
        // Order taken from `labels.sort((a, b) => a.localeCompare(b))` in Bun.
        let expected = [
            "com.apple-dash",
            "com.apple.cvmsCompAgent_arm64",
            "com.apple.cvmsCompAgent_arm64_1",
            "com.apple.cvmsCompAgent3600_arm64",
            "com.apple.Finder",
            "com.apple.finder.extra",
            "com.Apple.zeta",
            "org.example",
        ];
        let mut sorted = expected.to_vec();
        sorted.reverse();
        sorted.sort_by_cached_key(|l| label_sort_key(l));
        assert_eq!(sorted, expected);
    }

    #[test]
    fn scopes() {
        assert_eq!(scope_for("user-agents").unwrap().dir, "~/Library/LaunchAgents");
        assert_eq!(scope_for("global-daemons").unwrap().kind, ScopeKind::Daemon);
        assert!(!scope_for("system-agents").unwrap().writable);
        assert!(scope_for("nope").is_none());
    }

    #[test]
    fn intervals() {
        assert_eq!(format_interval(300), "5 min");
        assert_eq!(format_interval(3600), "1 h");
        assert_eq!(format_interval(172800), "2 d");
        assert_eq!(format_interval(45), "45 s");
        assert_eq!(format_interval(90), "90 s");
    }

    #[test]
    fn triggers_simple() {
        let j = job("<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StartInterval</key><integer>300</integer>");
        assert_eq!(describe_triggers(&j), vec!["At load", "Keep alive", "Every 5 min"]);
    }

    #[test]
    fn triggers_ignore_false_empty_and_real() {
        let j = job(
            "<key>RunAtLoad</key><false/><key>KeepAlive</key><dict/>\
             <key>StartInterval</key><real>60.0</real><key>WatchPaths</key><array/>",
        );
        assert!(describe_triggers(&j).is_empty());
    }

    #[test]
    fn triggers_conditional_keepalive_and_calendar() {
        let j = job(
            "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\
             <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>",
        );
        assert_eq!(describe_triggers(&j), vec!["Keep alive (conditional)", "Calendar: at 09:00"]);
    }

    #[test]
    fn triggers_calendar_array() {
        let one = job("<key>StartCalendarInterval</key><array><dict><key>Minute</key><integer>5</integer></dict></array>");
        assert_eq!(describe_triggers(&one), vec!["Calendar: at minute 05 of every hour"]);
        let three = job(
            "<key>StartCalendarInterval</key><array><dict/><dict/><string>x</string><dict/></array>",
        );
        assert_eq!(describe_triggers(&three), vec!["Calendar ×3"]);
    }

    #[test]
    fn calendar_entry_text() {
        let j = job(
            "<key>E</key><dict><key>Hour</key><integer>14</integer><key>Weekday</key><integer>7</integer>\
             <key>Day</key><integer>3</integer><key>Month</key><integer>12</integer></dict>",
        );
        let entry = j.get("E").unwrap().as_dictionary().unwrap();
        assert_eq!(describe_calendar_entry(entry), "every minute of hour 14 on day 3 or on Sun in Dec");
        let odd = job("<key>E</key><dict><key>Weekday</key><integer>9</integer><key>Month</key><integer>13</integer></dict>");
        let entry = odd.get("E").unwrap().as_dictionary().unwrap();
        assert_eq!(describe_calendar_entry(entry), "every minute on weekday 9 in month 13");
    }

    #[test]
    fn calendar_day_or_weekday() {
        let text = |body: &str| {
            let j = job(&format!("<key>E</key><dict>{}</dict>", body));
            describe_calendar_entry(j.get("E").unwrap().as_dictionary().unwrap())
        };
        let int = |key: &str, value: i64| format!("<key>{}</key><integer>{}</integer>", key, value);
        // Both set: launchd fires when EITHER matches. Day first, then weekday.
        assert_eq!(text(&[int("Hour", 8), int("Minute", 0), int("Weekday", 5), int("Day", 15)].concat()), "at 08:00 on day 15 or on Fri");
        assert_eq!(
            text(&[int("Hour", 8), int("Minute", 0), int("Weekday", 5), int("Day", 15), int("Month", 12)].concat()),
            "at 08:00 on day 15 or on Fri in Dec"
        );
        // Single fields are unchanged.
        assert_eq!(text(&[int("Hour", 8), int("Minute", 5), int("Weekday", 1)].concat()), "at 08:05 on Mon");
        assert_eq!(text(&[int("Hour", 18), int("Minute", 0), int("Day", 24), int("Month", 12)].concat()), "at 18:00 on day 24 in Dec");
        assert_eq!(text(&int("Month", 1)), "every minute in Jan");
        assert_eq!(text(""), "every minute");
    }

    #[test]
    fn triggers_paths_and_dicts() {
        let j = job(
            "<key>WatchPaths</key><array><string>/a</string><string>/b</string></array>\
             <key>QueueDirectories</key><array><string>/q</string></array>\
             <key>StartOnMount</key><true/>\
             <key>Sockets</key><dict/><key>MachServices</key><dict/><key>LaunchEvents</key><dict/>",
        );
        assert_eq!(
            describe_triggers(&j),
            vec!["Watches 2 paths", "Queue directory", "On mount", "Socket", "Mach service", "Launch event"]
        );
        let single = job("<key>WatchPaths</key><array><string>/a</string></array>");
        assert_eq!(describe_triggers(&single), vec!["Watches 1 path"]);
    }

    #[test]
    fn executable() {
        assert_eq!(job_executable(&job("<key>Program</key><string>/bin/ls</string>")), Some("/bin/ls".into()));
        assert_eq!(
            job_executable(&job(
                "<key>Program</key><string></string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string></array>"
            )),
            Some("/bin/sh".into())
        );
        assert_eq!(job_executable(&job("<key>ProgramArguments</key><array/>")), None);
        assert_eq!(job_executable(&job("<key>ProgramArguments</key><array><integer>1</integer></array>")), None);
    }
}
