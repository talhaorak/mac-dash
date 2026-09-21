/**
 * launchd.plist(5) knowledge shared by the server and the client:
 * key schema, job scopes, validation rules and human-readable schedule summaries.
 */

import { isPlistDict, type PlistDict, type PlistValue } from "./plist";

// ── Scopes ───────────────────────────────────────────────────────────

export type JobCategory =
  | "user-agents"
  | "global-agents"
  | "global-daemons"
  | "system-agents"
  | "system-daemons";

export interface JobScope {
  category: JobCategory;
  title: string;
  /** Directory, with "~" for the home folder. */
  dir: string;
  /** Agents run in the GUI session of the logged-in user; daemons run in the system domain. */
  kind: "agent" | "daemon";
  /** System scopes are protected by SIP and can never be written. */
  writable: boolean;
  /** Writing here needs administrator rights. */
  needsAdmin: boolean;
  description: string;
}

export const JOB_SCOPES: JobScope[] = [
  {
    category: "user-agents",
    title: "User Agents",
    dir: "~/Library/LaunchAgents",
    kind: "agent",
    writable: true,
    needsAdmin: false,
    description: "Runs as you, while you are logged in.",
  },
  {
    category: "global-agents",
    title: "Global Agents",
    dir: "/Library/LaunchAgents",
    kind: "agent",
    writable: true,
    needsAdmin: true,
    description: "Runs for every user who logs in, as that user.",
  },
  {
    category: "global-daemons",
    title: "Global Daemons",
    dir: "/Library/LaunchDaemons",
    kind: "daemon",
    writable: true,
    needsAdmin: true,
    description: "Runs as root (or UserName) from boot, with no user logged in.",
  },
  {
    category: "system-agents",
    title: "System Agents",
    dir: "/System/Library/LaunchAgents",
    kind: "agent",
    writable: false,
    needsAdmin: true,
    description: "Part of macOS. Read-only.",
  },
  {
    category: "system-daemons",
    title: "System Daemons",
    dir: "/System/Library/LaunchDaemons",
    kind: "daemon",
    writable: false,
    needsAdmin: true,
    description: "Part of macOS. Read-only.",
  },
];

export function scopeFor(category: string): JobScope | undefined {
  return JOB_SCOPES.find((s) => s.category === category);
}

/** A label becomes a file name and a launchctl service target, so keep it to a safe alphabet. */
export const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

// ── Key schema ───────────────────────────────────────────────────────

export type KeyType =
  | "string"
  | "integer"
  | "boolean"
  | "string-array"
  | "string-dict"
  | "bool-dict"
  | "integer-dict"
  | "keepalive"
  | "calendar"
  | "session-type"
  | "complex";

export type KeyGroup = "identity" | "program" | "triggers" | "environment" | "io" | "resources" | "advanced";

export interface KeySpec {
  key: string;
  type: KeyType;
  group: KeyGroup;
  title: string;
  help: string;
  options?: string[];
  min?: number;
  max?: number;
  daemonOnly?: boolean;
  deprecated?: boolean;
}

export const RESOURCE_LIMIT_KEYS = [
  "Core",
  "CPU",
  "Data",
  "FileSize",
  "MemoryLock",
  "NumberOfFiles",
  "NumberOfProcesses",
  "ResidentSetSize",
  "Stack",
];

export const LAUNCHD_KEYS: KeySpec[] = [
  { key: "Label", type: "string", group: "identity", title: "Label", help: "Unique job identifier. The plist file must be named <Label>.plist." },
  { key: "Disabled", type: "boolean", group: "identity", title: "Disabled", help: "Hint that the job should not be loaded. The launchctl override database takes precedence." },
  { key: "UserName", type: "string", group: "identity", title: "Run as user", help: "User to run the job as. Only honoured for daemons.", daemonOnly: true },
  { key: "GroupName", type: "string", group: "identity", title: "Run as group", help: "Group to run the job as. Only honoured for daemons.", daemonOnly: true },
  { key: "InitGroups", type: "boolean", group: "identity", title: "Init groups", help: "Call initgroups(3) before running the job.", daemonOnly: true },
  { key: "LimitLoadToSessionType", type: "session-type", group: "identity", title: "Session types", help: "Sessions the agent loads in.", options: ["Aqua", "Background", "LoginWindow", "StandardIO", "System"] },
  { key: "AssociatedBundleIdentifiers", type: "string-array", group: "identity", title: "Associated bundle IDs", help: "Apps this job belongs to. macOS shows the app name under Login Items." },

  { key: "Program", type: "string", group: "program", title: "Program", help: "Absolute path of the executable. When absent, the first ProgramArguments entry is used." },
  { key: "ProgramArguments", type: "string-array", group: "program", title: "Program arguments", help: "argv of the job. The first entry is the executable unless Program is set." },
  { key: "BundleProgram", type: "string", group: "program", title: "Bundle program", help: "Executable path relative to the app bundle that registered the job." },
  { key: "SpawnConstraint", type: "complex", group: "program", title: "Spawn constraint", help: "Launch constraint the executable must satisfy (macOS 13.3+)." },
  { key: "EnableGlobbing", type: "boolean", group: "program", title: "Enable globbing", help: "Expand wildcards in ProgramArguments with glob(3).", deprecated: true },

  { key: "RunAtLoad", type: "boolean", group: "triggers", title: "Run at load", help: "Start the job when it is loaded: at login for agents, at boot for daemons." },
  { key: "KeepAlive", type: "keepalive", group: "triggers", title: "Keep alive", help: "Keep the job running. Restart it unconditionally, or only under the chosen conditions." },
  { key: "StartInterval", type: "integer", group: "triggers", title: "Start interval", help: "Start the job every N seconds.", min: 1 },
  { key: "StartCalendarInterval", type: "calendar", group: "triggers", title: "Calendar schedule", help: "Start the job at calendar times, like cron. Missing fields are wildcards." },
  { key: "WatchPaths", type: "string-array", group: "triggers", title: "Watch paths", help: "Start the job when any of these files or folders is modified." },
  { key: "QueueDirectories", type: "string-array", group: "triggers", title: "Queue directories", help: "Keep the job alive while any of these directories is not empty." },
  { key: "StartOnMount", type: "boolean", group: "triggers", title: "Start on mount", help: "Start the job every time a filesystem is mounted." },
  { key: "LaunchOnlyOnce", type: "boolean", group: "triggers", title: "Launch only once", help: "Run the job once per boot and never restart it." },
  { key: "ThrottleInterval", type: "integer", group: "triggers", title: "Throttle interval", help: "Minimum seconds between two starts. Default is 10.", min: 0 },
  { key: "LaunchEvents", type: "complex", group: "triggers", title: "Launch events", help: "Start the job on higher-level events (IOKit matching, notifications)." },
  { key: "OnDemand", type: "boolean", group: "triggers", title: "On demand", help: "Replaced by KeepAlive in macOS 10.5.", deprecated: true },

  { key: "EnvironmentVariables", type: "string-dict", group: "environment", title: "Environment variables", help: "Extra environment variables for the job." },
  { key: "WorkingDirectory", type: "string", group: "environment", title: "Working directory", help: "chdir(2) to this directory before running the job." },
  { key: "RootDirectory", type: "string", group: "environment", title: "Root directory", help: "chroot(2) to this directory before running the job.", daemonOnly: true },
  { key: "Umask", type: "integer", group: "environment", title: "Umask", help: "umask(2) value, as a decimal integer." },

  { key: "StandardOutPath", type: "string", group: "io", title: "Standard output", help: "File that receives stdout." },
  { key: "StandardErrorPath", type: "string", group: "io", title: "Standard error", help: "File that receives stderr." },
  { key: "StandardInPath", type: "string", group: "io", title: "Standard input", help: "File connected to stdin." },
  { key: "Debug", type: "boolean", group: "io", title: "Debug", help: "Raise launchd's log level while this job runs.", deprecated: true },

  { key: "ProcessType", type: "string", group: "resources", title: "Process type", help: "Resource policy applied to the job.", options: ["Background", "Standard", "Adaptive", "Interactive"] },
  { key: "Nice", type: "integer", group: "resources", title: "Nice", help: "Scheduling priority from -20 (highest) to 20 (lowest).", min: -20, max: 20 },
  { key: "LowPriorityIO", type: "boolean", group: "resources", title: "Low priority I/O", help: "Treat the job's filesystem I/O as low priority." },
  { key: "LowPriorityBackgroundIO", type: "boolean", group: "resources", title: "Low priority background I/O", help: "Low priority I/O while the job is throttled to the background." },
  { key: "SoftResourceLimits", type: "integer-dict", group: "resources", title: "Soft resource limits", help: "setrlimit(2) soft limits.", options: RESOURCE_LIMIT_KEYS },
  { key: "HardResourceLimits", type: "integer-dict", group: "resources", title: "Hard resource limits", help: "setrlimit(2) hard limits.", options: RESOURCE_LIMIT_KEYS },
  { key: "ExitTimeOut", type: "integer", group: "resources", title: "Exit timeout", help: "Seconds between SIGTERM and SIGKILL when the job is stopped. Default is 20.", min: 0 },
  { key: "TimeOut", type: "integer", group: "resources", title: "Timeout", help: "Recommended inactivity timeout handed to the job.", min: 0 },

  { key: "AbandonProcessGroup", type: "boolean", group: "advanced", title: "Abandon process group", help: "Do not kill the remaining processes of the job's process group when the job exits." },
  { key: "EnableTransactions", type: "boolean", group: "advanced", title: "Enable transactions", help: "The job uses XPC transactions to signal outstanding work." },
  { key: "EnablePressuredExit", type: "boolean", group: "advanced", title: "Enable pressured exit", help: "launchd can stop the job under memory pressure when it is clean." },
  { key: "SessionCreate", type: "boolean", group: "advanced", title: "Session create", help: "Run the job in a new security audit session." },
  { key: "LegacyTimers", type: "boolean", group: "advanced", title: "Legacy timers", help: "Opt out of timer coalescing." },
  { key: "MaterializeDatalessFiles", type: "boolean", group: "advanced", title: "Materialize dataless files", help: "Allow the job to materialize dataless (cloud-only) files." },
  { key: "WaitForDebugger", type: "boolean", group: "advanced", title: "Wait for debugger", help: "Start the job suspended until a debugger attaches." },
  { key: "MachServices", type: "complex", group: "advanced", title: "Mach services", help: "Mach service names the job registers with the bootstrap server." },
  { key: "Sockets", type: "complex", group: "advanced", title: "Sockets", help: "Launch-on-demand sockets." },
  { key: "inetdCompatibility", type: "complex", group: "advanced", title: "inetd compatibility", help: "The job expects inetd-style socket handling." },
  { key: "LimitLoadToHosts", type: "string-array", group: "advanced", title: "Limit load to hosts", help: "No longer supported by launchd.", deprecated: true },
  { key: "LimitLoadFromHosts", type: "string-array", group: "advanced", title: "Limit load from hosts", help: "No longer supported by launchd.", deprecated: true },
  { key: "LimitLoadToHardware", type: "complex", group: "advanced", title: "Limit load to hardware", help: "Load only on matching hardware (sysctl values)." },
  { key: "LimitLoadFromHardware", type: "complex", group: "advanced", title: "Limit load from hardware", help: "Do not load on matching hardware (sysctl values)." },
  { key: "HopefullyExitsFirst", type: "boolean", group: "advanced", title: "Hopefully exits first", help: "No longer supported by launchd.", deprecated: true },
  { key: "HopefullyExitsLast", type: "boolean", group: "advanced", title: "Hopefully exits last", help: "No longer supported by launchd.", deprecated: true },
];

export const KEY_SPEC = new Map(LAUNCHD_KEYS.map((k) => [k.key, k]));

export const KEEPALIVE_CONDITIONS: { key: string; type: "boolean" | "bool-dict"; help: string; deprecated?: boolean }[] = [
  { key: "SuccessfulExit", type: "boolean", help: "true: restart until the job fails. false: restart until it exits with 0." },
  { key: "Crashed", type: "boolean", help: "true: restart only after a crash. false: restart only after a clean exit." },
  { key: "PathState", type: "bool-dict", help: "Keep alive while a path exists (true) or does not exist (false)." },
  { key: "OtherJobEnabled", type: "bool-dict", help: "Keep alive while another job is enabled (true) or disabled (false)." },
  { key: "AfterInitialDemand", type: "boolean", help: "Apply the other conditions only after the job has been started once on demand." },
  { key: "NetworkState", type: "boolean", help: "No longer implemented by launchd.", deprecated: true },
];

export const CALENDAR_FIELDS: { key: string; min: number; max: number; help: string }[] = [
  { key: "Month", min: 1, max: 12, help: "1–12" },
  { key: "Day", min: 1, max: 31, help: "1–31" },
  { key: "Weekday", min: 0, max: 7, help: "0 and 7 are Sunday" },
  { key: "Hour", min: 0, max: 23, help: "0–23" },
  { key: "Minute", min: 0, max: 59, help: "0–59" },
];

// ── Summaries ────────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} d`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export function describeCalendarEntry(entry: PlistDict): string {
  const num = (k: string) => (typeof entry[k] === "number" ? (entry[k] as number) : null);
  const minute = num("Minute");
  const hour = num("Hour");
  const day = num("Day");
  const weekday = num("Weekday");
  const month = num("Month");

  const pad = (n: number) => String(n).padStart(2, "0");
  let time: string;
  if (hour !== null && minute !== null) time = `at ${pad(hour)}:${pad(minute)}`;
  else if (hour !== null) time = `every minute of hour ${pad(hour)}`;
  else if (minute !== null) time = `at minute ${pad(minute)} of every hour`;
  else time = "every minute";

  // launchd, like cron, starts the job when Day OR Weekday matches if both are set.
  const days: string[] = [];
  if (day !== null) days.push(`on day ${day}`);
  if (weekday !== null) days.push(`on ${WEEKDAYS[weekday] ?? `weekday ${weekday}`}`);
  const parts = days.length > 0 ? [days.join(" or ")] : [];
  if (month !== null) parts.push(`in ${MONTHS[month] ?? `month ${month}`}`);
  return [time, ...parts].join(" ");
}

export function calendarEntries(value: PlistValue | undefined): PlistDict[] {
  if (Array.isArray(value)) return value.filter(isPlistDict);
  if (isPlistDict(value)) return [value];
  return [];
}

/** Short trigger tags for the job list, e.g. ["At load", "Every 5 min"]. */
export function describeTriggers(job: PlistDict): string[] {
  const tags: string[] = [];
  if (job.RunAtLoad === true) tags.push("At load");
  if (job.KeepAlive === true) tags.push("Keep alive");
  else if (isPlistDict(job.KeepAlive) && Object.keys(job.KeepAlive).length > 0) tags.push("Keep alive (conditional)");
  if (typeof job.StartInterval === "number") tags.push(`Every ${formatInterval(job.StartInterval)}`);
  const cal = calendarEntries(job.StartCalendarInterval);
  if (cal.length === 1) tags.push(`Calendar: ${describeCalendarEntry(cal[0])}`);
  else if (cal.length > 1) tags.push(`Calendar ×${cal.length}`);
  if (Array.isArray(job.WatchPaths) && job.WatchPaths.length > 0) tags.push(`Watches ${job.WatchPaths.length} path${job.WatchPaths.length > 1 ? "s" : ""}`);
  if (Array.isArray(job.QueueDirectories) && job.QueueDirectories.length > 0) tags.push("Queue directory");
  if (job.StartOnMount === true) tags.push("On mount");
  if (isPlistDict(job.Sockets)) tags.push("Socket");
  if (isPlistDict(job.MachServices)) tags.push("Mach service");
  if (isPlistDict(job.LaunchEvents)) tags.push("Launch event");
  return tags;
}

// ── Timeline ─────────────────────────────────────────────────────────

/**
 * Next start times of one StartCalendarInterval entry (local time, like launchd).
 * An entry without Hour and Minute fires every minute: it yields a single marker at `from`.
 */
export function nextRuns(entry: Record<string, number>, from: Date, count: number, horizonDays = 31): Date[] {
  const { Minute, Hour, Day, Weekday, Month } = entry;
  if (Minute === undefined && Hour === undefined) return [new Date(from)];
  const runs: Date[] = [];
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let d = 0; d <= horizonDays && runs.length < count; d++, day.setDate(day.getDate() + 1)) {
    if (Month !== undefined && day.getMonth() + 1 !== Month) continue;
    const dayMatches = Day !== undefined && day.getDate() === Day;
    const weekdayMatches = Weekday !== undefined && day.getDay() === Weekday % 7;
    // Both set: either one matches (launchd.plist(5)). One set: it must match.
    if ((Day !== undefined || Weekday !== undefined) && !dayMatches && !weekdayMatches) continue;
    const hours = Hour !== undefined ? [Hour] : Array.from({ length: 24 }, (_, h) => h);
    const minute = Minute ?? 0; // Hour set, Minute missing: launchd fires every minute of that hour; show the first
    for (const h of hours) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, minute);
      if (at > from && runs.length < count) runs.push(at);
    }
  }
  return runs;
}

// ── Validation ───────────────────────────────────────────────────────

export type IssueSeverity = "error" | "warning" | "info";

export interface JobIssue {
  severity: IssueSeverity;
  key: string | null;
  message: string;
  /** The job cannot be saved until this is fixed. Other errors are strong warnings (e.g. a path on an unmounted volume). */
  blocking?: boolean;
}

export interface PathFacts {
  path: string;
  exists: boolean;
  isFile: boolean;
  isDirectory: boolean;
  executable: boolean;
}

export interface ValidateOptions {
  category: JobCategory;
  /** File name the job is (or will be) stored under, without directory. */
  fileName?: string | null;
  /** Labels of the other known jobs, to detect duplicates. */
  otherLabels?: Iterable<string>;
  /** Filesystem facts collected by the backend (see collectPaths). */
  pathFacts?: PathFacts[];
}

function typeMatches(spec: KeySpec, value: PlistValue): boolean {
  const isStr = (v: PlistValue) => typeof v === "string";
  switch (spec.type) {
    case "string":
      return isStr(value);
    case "integer":
      // Umask may also be written as a string
      return Number.isInteger(value) || (spec.key === "Umask" && isStr(value));
    case "boolean":
      return typeof value === "boolean";
    case "string-array":
      return (Array.isArray(value) && value.every(isStr)) || (spec.key === "AssociatedBundleIdentifiers" && isStr(value));
    case "session-type":
      return isStr(value) || (Array.isArray(value) && value.every(isStr));
    case "string-dict":
      return isPlistDict(value) && Object.values(value).every(isStr);
    case "bool-dict":
      return isPlistDict(value) && Object.values(value).every((v) => typeof v === "boolean");
    case "integer-dict":
      return isPlistDict(value) && Object.values(value).every((v) => Number.isInteger(v));
    case "keepalive":
      return typeof value === "boolean" || isPlistDict(value);
    case "calendar":
      return isPlistDict(value) || (Array.isArray(value) && value.every(isPlistDict));
    case "complex":
      return true;
  }
}

/** The executable launchd will run: Program, else ProgramArguments[0]. */
export function jobExecutable(job: PlistDict): string | null {
  if (typeof job.Program === "string" && job.Program) return job.Program;
  const args = job.ProgramArguments;
  if (Array.isArray(args) && typeof args[0] === "string" && args[0]) return args[0];
  return null;
}

/** Paths whose existence matters for validation; the backend stats them. */
export function collectPaths(job: PlistDict): string[] {
  const paths = new Set<string>();
  const add = (v: PlistValue | undefined) => {
    if (typeof v === "string" && v.startsWith("/")) paths.add(v);
  };
  add(jobExecutable(job) ?? undefined);
  add(job.WorkingDirectory);
  add(job.RootDirectory);
  add(job.StandardInPath);
  for (const key of ["StandardOutPath", "StandardErrorPath"] as const) {
    const v = job[key];
    if (typeof v === "string" && v.startsWith("/")) paths.add(v.slice(0, v.lastIndexOf("/")) || "/");
  }
  for (const key of ["WatchPaths", "QueueDirectories"] as const) {
    const v = job[key];
    if (Array.isArray(v)) v.forEach(add);
  }
  return [...paths];
}

export function validateJob(job: PlistDict, opts: ValidateOptions): JobIssue[] {
  const issues: JobIssue[] = [];
  const push = (severity: IssueSeverity, key: string | null, message: string, blocking = false) =>
    issues.push({ severity, key, message, ...(blocking ? { blocking } : {}) });
  const scope = scopeFor(opts.category);
  const facts = new Map((opts.pathFacts ?? []).map((f) => [f.path, f]));

  // Label
  const label = job.Label;
  if (typeof label !== "string" || label.trim() === "") {
    push("error", "Label", "Label is required.", true);
  } else {
    if (!LABEL_PATTERN.test(label)) {
      push("error", "Label", "Label may only contain letters, digits, dots, dashes and underscores.", true);
    }
    if (opts.fileName && opts.fileName !== `${label}.plist`) {
      push("warning", "Label", `File name "${opts.fileName}" does not match the label. launchd convention is "${label}.plist".`);
    }
    if (opts.otherLabels) {
      for (const other of opts.otherLabels) {
        if (other === label) {
          push("error", "Label", "Another job in this scope already uses this label.", true);
          break;
        }
      }
    }
    if (label.startsWith("com.apple.")) {
      push("warning", "Label", 'The "com.apple." prefix is reserved for macOS jobs.');
    }
  }

  // Program
  const exe = jobExecutable(job);
  if (!exe && typeof job.BundleProgram !== "string" && !isPlistDict(job.MachServices)) {
    push("error", "ProgramArguments", "The job has nothing to run. Set Program or ProgramArguments.", true);
  }
  if (Array.isArray(job.ProgramArguments) && job.ProgramArguments.length === 0) {
    push("error", "ProgramArguments", "ProgramArguments is empty.");
  }
  if (exe) {
    if (exe.startsWith("~")) {
      push("error", "Program", "launchd does not expand ~. Use the full path.");
    } else if (!exe.startsWith("/")) {
      push("warning", "Program", `"${exe}" is not an absolute path. launchd searches a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).`);
    } else {
      const f = facts.get(exe);
      if (f && !f.exists) push("error", "Program", `Executable not found: ${exe}`);
      else if (f && f.isDirectory) {
        push("error", "Program", exe.endsWith(".app") ? `${exe} is an app bundle. Run it with /usr/bin/open -a, or point to Contents/MacOS/<binary>.` : `${exe} is a directory.`);
      } else if (f && !f.executable) push("error", "Program", `File is not executable: ${exe} (chmod +x).`);
    }
  }
  for (const key of ["WorkingDirectory", "StandardOutPath", "StandardErrorPath", "StandardInPath"] as const) {
    const v = job[key];
    if (typeof v === "string" && v.startsWith("~")) {
      push("error", key, "launchd does not expand ~. Use the full path.");
    }
  }

  // Triggers
  const hasTrigger =
    job.RunAtLoad === true ||
    job.KeepAlive === true ||
    (isPlistDict(job.KeepAlive) && Object.keys(job.KeepAlive).length > 0) ||
    typeof job.StartInterval === "number" ||
    calendarEntries(job.StartCalendarInterval).length > 0 ||
    (Array.isArray(job.WatchPaths) && job.WatchPaths.length > 0) ||
    (Array.isArray(job.QueueDirectories) && job.QueueDirectories.length > 0) ||
    job.StartOnMount === true ||
    isPlistDict(job.Sockets) ||
    isPlistDict(job.MachServices) ||
    isPlistDict(job.LaunchEvents);
  if (!hasTrigger) {
    push("warning", null, "No trigger is set. The job only runs when you start it manually.");
  }
  if (typeof job.StartInterval === "number" && job.StartInterval < 1) {
    push("error", "StartInterval", "StartInterval must be at least 1 second.");
  }
  if (job.KeepAlive === true && typeof job.StartInterval === "number") {
    push("warning", "StartInterval", "StartInterval has no effect while KeepAlive keeps the job running.");
  }
  if (typeof job.ThrottleInterval === "number" && typeof job.StartInterval === "number" && job.StartInterval < job.ThrottleInterval) {
    push("warning", "ThrottleInterval", "StartInterval is shorter than ThrottleInterval, so launchd delays the starts.");
  }
  for (const [i, entry] of calendarEntries(job.StartCalendarInterval).entries()) {
    for (const [field, value] of Object.entries(entry)) {
      const spec = CALENDAR_FIELDS.find((f) => f.key === field);
      if (!spec) push("warning", "StartCalendarInterval", `Schedule ${i + 1}: unknown field "${field}".`);
      else if (!Number.isInteger(value) || (value as number) < spec.min || (value as number) > spec.max) {
        push("error", "StartCalendarInterval", `Schedule ${i + 1}: ${field} must be an integer between ${spec.min} and ${spec.max}.`);
      }
    }
  }
  if (isPlistDict(job.KeepAlive) && "NetworkState" in job.KeepAlive) {
    push("warning", "KeepAlive", "KeepAlive.NetworkState is no longer implemented by launchd.");
  }

  // Paths
  for (const key of ["WatchPaths", "QueueDirectories"] as const) {
    const v = job[key];
    if (!Array.isArray(v)) continue;
    for (const p of v) {
      if (typeof p !== "string") continue;
      const f = facts.get(p);
      if (f && !f.exists) push("warning", key, `Path does not exist yet: ${p}`);
      if (key === "QueueDirectories" && f?.exists && !f.isDirectory) push("error", key, `Not a directory: ${p}`);
    }
  }
  if (typeof job.WorkingDirectory === "string") {
    const f = facts.get(job.WorkingDirectory);
    if (f && !f.isDirectory) push("error", "WorkingDirectory", `Working directory not found: ${job.WorkingDirectory}`);
  }
  for (const key of ["StandardOutPath", "StandardErrorPath"] as const) {
    const v = job[key];
    if (typeof v !== "string" || !v.startsWith("/")) continue;
    const parent = v.slice(0, v.lastIndexOf("/")) || "/";
    const f = facts.get(parent);
    if (f && !f.isDirectory) push("warning", key, `Folder does not exist: ${parent}. launchd does not create it.`);
  }

  // Scope-specific
  if (scope?.kind === "agent") {
    for (const key of ["UserName", "GroupName", "InitGroups", "RootDirectory"]) {
      if (key in job) push("warning", key, `${key} is ignored for agents. It only applies to daemons.`);
    }
  }
  if (scope?.kind === "daemon" && "LimitLoadToSessionType" in job) {
    push("warning", "LimitLoadToSessionType", "LimitLoadToSessionType applies to agents, not daemons.");
  }
  if (typeof job.Nice === "number" && (job.Nice < -20 || job.Nice > 20)) {
    push("error", "Nice", "Nice must be between -20 and 20.");
  }
  if (typeof job.ProcessType === "string" && !KEY_SPEC.get("ProcessType")!.options!.includes(job.ProcessType)) {
    push("error", "ProcessType", "ProcessType must be Background, Standard, Adaptive or Interactive.");
  }

  // Types, unknown and deprecated keys
  for (const [key, value] of Object.entries(job)) {
    const spec = KEY_SPEC.get(key);
    if (!spec) {
      push("info", key, `"${key}" is not a documented launchd key. launchd ignores unknown keys.`);
      continue;
    }
    if (!typeMatches(spec, value)) push("error", key, `${key} has the wrong type. Expected ${spec.type}.`, true);
    if (spec.deprecated) push("warning", key, `${key} is deprecated. ${spec.help}`);
  }

  const order: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ── Exit status ──────────────────────────────────────────────────────

const SIGNALS: Record<number, string> = {
  1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 8: "SIGFPE",
  9: "SIGKILL", 10: "SIGBUS", 11: "SIGSEGV", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
};

const EXIT_CODES: Record<number, string> = {
  0: "Success",
  1: "General error",
  2: "Misuse of a shell builtin or wrong arguments",
  64: "Command line usage error (EX_USAGE)",
  66: "Cannot open input (EX_NOINPUT)",
  69: "Service unavailable (EX_UNAVAILABLE)",
  70: "Internal software error (EX_SOFTWARE)",
  73: "Cannot create output file (EX_CANTCREAT)",
  74: "I/O error (EX_IOERR)",
  77: "Permission denied (EX_NOPERM)",
  78: "Configuration error (EX_CONFIG). launchd reports 78 when it cannot start the program: check the path, the permissions and the log paths.",
  126: "Command found but not executable",
  127: "Command not found",
};

/** Explain the "last exit status" column of `launchctl list`. Negative values are signals. */
export function explainExitStatus(status: number | null): string | null {
  if (status === null) return null;
  if (status < 0) return `Terminated by signal ${-status}${SIGNALS[-status] ? ` (${SIGNALS[-status]})` : ""}`;
  if (status > 128 && SIGNALS[status - 128]) return `Terminated by signal ${status - 128} (${SIGNALS[status - 128]})`;
  return EXIT_CODES[status] ?? `Exited with code ${status}`;
}

// ── Templates ────────────────────────────────────────────────────────

export interface JobTemplate {
  id: string;
  title: string;
  description: string;
  build: (label: string) => PlistDict;
}

export const JOB_TEMPLATES: JobTemplate[] = [
  {
    id: "blank",
    title: "Blank job",
    description: "Only a label and a command.",
    build: (label) => ({ Label: label, ProgramArguments: ["/bin/sh", "-c", "echo hello"] }),
  },
  {
    id: "login",
    title: "Run at login",
    description: "Starts an app or script every time you log in.",
    build: (label) => ({ Label: label, ProgramArguments: ["/usr/bin/open", "-a", "Safari"], RunAtLoad: true }),
  },
  {
    id: "interval",
    title: "Run every N minutes",
    description: "Runs a command on a fixed interval.",
    build: (label) => ({ Label: label, ProgramArguments: ["/bin/sh", "-c", "date >> /tmp/" + label + ".log"], StartInterval: 300 }),
  },
  {
    id: "calendar",
    title: "Run at a specific time",
    description: "Runs a command every day at 09:00, like cron.",
    build: (label) => ({ Label: label, ProgramArguments: ["/bin/sh", "-c", "echo good morning"], StartCalendarInterval: [{ Hour: 9, Minute: 0 }] }),
  },
  {
    id: "keepalive",
    title: "Keep a program running",
    description: "Restarts the program whenever it quits or crashes.",
    build: (label) => ({
      Label: label,
      ProgramArguments: ["/usr/local/bin/my-server"],
      RunAtLoad: true,
      KeepAlive: true,
      StandardOutPath: `/tmp/${label}.out.log`,
      StandardErrorPath: `/tmp/${label}.err.log`,
    }),
  },
  {
    id: "watch",
    title: "Run when a file or folder changes",
    description: "Starts the command when a watched path is modified.",
    build: (label) => ({ Label: label, ProgramArguments: ["/bin/sh", "-c", "echo changed"], WatchPaths: ["/Users/Shared"] }),
  },
  {
    id: "mount",
    title: "Run when a volume is mounted",
    description: "Starts the command every time a disk is mounted.",
    build: (label) => ({ Label: label, ProgramArguments: ["/bin/sh", "-c", "ls /Volumes"], StartOnMount: true }),
  },
];
