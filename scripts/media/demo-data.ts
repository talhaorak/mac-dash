/**
 * Fictional data for screenshots and the demo GIF. Nothing here comes from a real machine,
 * so the published images show no host name, user name or installed software.
 */

const USER = "alex";
const HOME = `/Users/${USER}`;

type Status = "running" | "stopped" | "error";

interface DemoJob {
  label: string;
  category: "user-agents" | "global-agents" | "global-daemons" | "system-agents" | "system-daemons";
  program: string;
  args?: string[];
  status: Status;
  exit?: number | null;
  disabled?: boolean;
  triggers: string[];
  startInterval?: number;
  calendar?: Record<string, number>[];
  userName?: string;
  keys?: Record<string, unknown>;
}

const DIRS: Record<DemoJob["category"], string> = {
  "user-agents": `${HOME}/Library/LaunchAgents`,
  "global-agents": "/Library/LaunchAgents",
  "global-daemons": "/Library/LaunchDaemons",
  "system-agents": "/System/Library/LaunchAgents",
  "system-daemons": "/System/Library/LaunchDaemons",
};

const JOBS: DemoJob[] = [
  { label: "com.example.backup-documents", category: "user-agents", program: "/usr/bin/rsync", args: ["/usr/bin/rsync", "-a", `${HOME}/Documents`, "/Volumes/Backup"], status: "stopped", exit: 0, triggers: ["Calendar: at 02:30"], calendar: [{ Hour: 2, Minute: 30 }] },
  { label: "com.example.sync-photos", category: "user-agents", program: "/bin/sh", args: ["/bin/sh", "-c", "~/bin/sync-photos.sh"], status: "running", triggers: ["At load", "Every 15 min"], startInterval: 900 },
  { label: "com.example.dev-server", category: "user-agents", program: "/opt/homebrew/bin/node", args: ["/opt/homebrew/bin/node", `${HOME}/Projects/api/server.js`], status: "running", triggers: ["At load", "Keep alive"] },
  { label: "com.example.clean-downloads", category: "user-agents", program: "/bin/zsh", args: ["/bin/zsh", `${HOME}/bin/clean-downloads.zsh`], status: "stopped", exit: 0, triggers: ["Calendar ×5"], calendar: [1, 2, 3, 4, 5].map((Weekday) => ({ Weekday, Hour: 18, Minute: 0 })) },
  { label: "com.example.weekly-report", category: "user-agents", program: "/usr/bin/shortcuts", args: ["/usr/bin/shortcuts", "run", "Weekly Report"], status: "stopped", exit: 0, triggers: ["Calendar: at 09:00 on Mon"], calendar: [{ Weekday: 1, Hour: 9, Minute: 0 }] },
  { label: "com.example.watch-inbox", category: "user-agents", program: "/usr/bin/python3", args: ["/usr/bin/python3", `${HOME}/bin/process-inbox.py`], status: "stopped", exit: 0, triggers: ["Watches 1 path"] },
  { label: "com.example.nightly-build", category: "user-agents", program: "/bin/bash", args: ["/bin/bash", `${HOME}/Projects/app/build.sh`], status: "error", exit: 78, triggers: ["Calendar: at 23:00"], calendar: [{ Hour: 23, Minute: 0 }] },
  { label: "com.example.vpn-keepalive", category: "user-agents", program: "/usr/local/bin/vpn-keepalive", status: "stopped", exit: null, disabled: true, triggers: ["At load", "Keep alive (conditional)"] },
  { label: "homebrew.mxcl.postgresql@17", category: "user-agents", program: "/opt/homebrew/opt/postgresql@17/bin/postgres", status: "running", triggers: ["At load", "Keep alive"] },
  { label: "homebrew.mxcl.redis", category: "user-agents", program: "/opt/homebrew/opt/redis/bin/redis-server", status: "running", triggers: ["At load", "Keep alive"] },
  { label: "com.acme.updater.agent", category: "global-agents", program: "/Library/Application Support/Acme/UpdaterAgent", status: "running", triggers: ["At load", "Every 1 h"], startInterval: 3600 },
  { label: "com.acme.menubar-helper", category: "global-agents", program: "/Applications/Acme.app/Contents/Library/LoginItems/Helper.app/Contents/MacOS/Helper", status: "running", triggers: ["At load"] },
  { label: "org.example.printer-status", category: "global-agents", program: "/Library/Printers/Example/status", status: "stopped", exit: 0, triggers: ["Mach service"] },
  { label: "com.acme.updater.daemon", category: "global-daemons", program: "/Library/PrivilegedHelperTools/com.acme.updater", status: "running", triggers: ["At load", "Mach service"], userName: "root" },
  { label: "com.example.offsite-backup", category: "global-daemons", program: "/usr/local/bin/restic", args: ["/usr/local/bin/restic", "backup", "/Users"], status: "stopped", exit: 0, triggers: ["Calendar: at 03:15"], calendar: [{ Hour: 3, Minute: 15 }], userName: "root" },
  { label: "org.example.metrics-exporter", category: "global-daemons", program: "/usr/local/bin/node_exporter", status: "running", triggers: ["At load", "Keep alive", "Socket"] },
  { label: "com.example.legacy-vpn", category: "global-daemons", program: "/Library/Application Support/LegacyVPN/vpnd", status: "error", exit: 1, triggers: ["At load", "Keep alive"] },
  ...["Spotlight", "AirPlayUIAgent", "controlcenter", "Dock.agent", "Finder", "notificationcenterui.agent", "Siri.agent", "talagent", "UserEventAgent-Aqua", "WiFiAgent", "screensharing.agent", "quicklook"].map(
    (n, i): DemoJob => ({ label: `com.apple.${n}`, category: "system-agents", program: `/System/Library/CoreServices/${n}`, status: i % 4 === 3 ? "stopped" : "running", exit: i % 4 === 3 ? 0 : null, triggers: i % 2 ? ["Mach service"] : ["At load", "Mach service"] })
  ),
  ...["apsd", "bluetoothd", "cfprefsd.xpc.daemon", "configd", "coreaudiod", "diskarbitrationd", "locationd", "logd", "mDNSResponder", "opendirectoryd", "powerd", "securityd", "syslogd", "timed", "WindowServer"].map(
    (n, i): DemoJob => ({ label: `com.apple.${n}`, category: "system-daemons", program: `/usr/libexec/${n}`, status: i % 5 === 4 ? "stopped" : "running", exit: i % 5 === 4 ? 0 : null, triggers: ["Mach service"] })
  ),
];

let pidSeed = 300;
const pids = new Map<string, number>();
const pidOf = (job: DemoJob) => {
  if (job.status !== "running") return null;
  if (!pids.has(job.label)) pids.set(job.label, (pidSeed += 37 + (job.label.length % 23)));
  return pids.get(job.label)!;
};

export function services() {
  return JOBS.map((j) => {
    const writable = !j.category.startsWith("system");
    return {
      label: j.label,
      pid: pidOf(j),
      lastExitStatus: j.exit ?? null,
      status: j.status,
      category: j.category,
      plistPath: `${DIRS[j.category]}/${j.label}.plist`,
      program: j.program,
      programArguments: j.args ?? [j.program],
      runAtLoad: j.triggers.includes("At load"),
      enabled: !j.disabled,
      loaded: !j.disabled,
      disabled: !!j.disabled,
      triggers: j.triggers,
      writable,
      needsAdmin: j.category !== "user-agents",
      userName: j.userName ?? null,
      unreadable: false,
      quarantined: false,
      startInterval: j.startInterval ?? null,
      calendar: j.calendar ?? [],
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export function jobXml(label: string): string {
  const j = JOBS.find((x) => x.label === label) ?? JOBS[0];
  const args = (j.args ?? [j.program]).map((a) => `\t\t<string>${a}</string>`).join("\n");
  const calendar = (j.calendar ?? [])
    .map((c) => `\t\t<dict>\n${Object.entries(c).map(([k, v]) => `\t\t\t<key>${k}</key>\n\t\t\t<integer>${v}</integer>`).join("\n")}\n\t\t</dict>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${j.label}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
${j.triggers.includes("At load") ? "\t<key>RunAtLoad</key>\n\t<true/>\n" : ""}${j.triggers.includes("Keep alive") ? "\t<key>KeepAlive</key>\n\t<true/>\n" : ""}${j.startInterval ? `\t<key>StartInterval</key>\n\t<integer>${j.startInterval}</integer>\n` : ""}${calendar ? `\t<key>StartCalendarInterval</key>\n\t<array>\n${calendar}\n\t</array>\n` : ""}\t<key>StandardOutPath</key>
\t<string>${HOME}/Library/Logs/${j.label}.log</string>
\t<key>StandardErrorPath</key>
\t<string>${HOME}/Library/Logs/${j.label}.err.log</string>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
\t</dict>
</dict>
</plist>
`;
}

const PROCS = [
  ["WindowServer", "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer", "_windowserver", 18.2, 1.9],
  ["node", "/opt/homebrew/bin/node", USER, 12.6, 2.4],
  ["Xcode", "/Applications/Xcode.app/Contents/MacOS/Xcode", USER, 9.8, 6.1],
  ["Safari", "/Applications/Safari.app/Contents/MacOS/Safari", USER, 7.4, 3.2],
  ["postgres", "/opt/homebrew/opt/postgresql@17/bin/postgres", USER, 4.1, 1.1],
  ["mds_stores", "/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Versions/A/Support/mds_stores", "root", 3.7, 0.8],
  ["Terminal", "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal", USER, 2.9, 0.6],
  ["redis-server", "/opt/homebrew/opt/redis/bin/redis-server", USER, 1.8, 0.2],
  ["Finder", "/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", USER, 1.2, 0.9],
  ["coreaudiod", "/usr/sbin/coreaudiod", "_coreaudiod", 0.9, 0.3],
  ["rsync", "/usr/bin/rsync", USER, 0.7, 0.1],
  ["launchd", "/sbin/launchd", "root", 0.4, 0.2],
  ["mDNSResponder", "/usr/sbin/mDNSResponder", "_mdnsresponder", 0.3, 0.1],
  ["Dock", "/System/Library/CoreServices/Dock.app/Contents/MacOS/Dock", USER, 0.3, 0.5],
  ["logd", "/usr/libexec/logd", "root", 0.2, 0.2],
] as const;

export function processes(tick = 0) {
  return PROCS.map(([command, path, user, cpu, mem], i) => {
    const wobble = 1 + 0.25 * Math.sin(tick / 3 + i);
    return {
      pid: 210 + i * 173,
      ppid: 1,
      uid: user === "root" ? 0 : 501,
      user,
      cpu: Math.round(cpu * wobble * 10) / 10,
      mem,
      rss: Math.round(mem * 16 * 1024 * 10.24),
      elapsed: `${String(1 + (i % 9)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:12`,
      command,
      path,
      args: path,
    };
  }).sort((a, b) => b.cpu - a.cpu);
}

export function systemStats(tick = 0) {
  const cpu = 24 + 14 * Math.sin(tick / 4) + 6 * Math.sin(tick / 1.7);
  const total = 32 * 1024 ** 3;
  const used = total * (0.58 + 0.04 * Math.sin(tick / 6));
  return {
    cpu: { user: Math.round(cpu * 0.68 * 10) / 10, sys: Math.round(cpu * 0.32 * 10) / 10, idle: Math.round((100 - cpu) * 10) / 10, model: "Apple M4 Pro", cores: 14, loadAvg: [2.41, 2.18, 1.97] },
    memory: { total, used, free: total - used, wired: total * 0.14, compressed: total * 0.06, usedPercent: Math.round((used / total) * 1000) / 10 },
    disk: { total: 994.7e9, used: 412.3e9, free: 582.4e9, usedPercent: 41.4, mountPoint: "/" },
    uptime: "6d 4h 12m",
    hostname: "studio.local",
    osVersion: "26.0",
    processCount: 512,
    threadCount: 2840,
  };
}

export const hardware = { model: "Mac16,7", cpu: "Apple M4 Pro", cores: 14, memory: 32 * 1024 ** 3, osVersion: "26.0", hostname: "studio.local", serialNumber: null };

const LOG_LINES: [string, string, string][] = [
  ["info", "rsync", "sent 48,221 bytes  received 1,204 bytes  total size 9,882,113"],
  ["default", "launchd", "com.example.sync-photos: service spawned with pid 1874"],
  ["info", "node", "GET /api/health 200 3 ms"],
  ["error", "bash", "build.sh: line 12: xcodebuild: command not found"],
  ["warning", "postgres", "checkpoints are occurring too frequently (18 seconds apart)"],
  ["info", "mds_stores", "Indexing finished for volume Macintosh HD"],
  ["default", "launchd", "com.example.nightly-build: exited with exit code: 78"],
  ["info", "redis-server", "100 changes in 300 seconds. Saving..."],
  ["debug", "Safari", "Tab 4 finished loading in 412 ms"],
  ["info", "restic", "snapshot 5f2c1a9e saved"],
];

export function logEntry(i: number, at = Date.now()) {
  const [level, process, message] = LOG_LINES[i % LOG_LINES.length];
  return { timestamp: new Date(at).toISOString(), level, process, pid: 400 + ((i * 53) % 900), message, subsystem: null, category: null };
}

export function jobEvents(now = Date.now()) {
  const ev = (minutesAgo: number, kind: string, label: string, category: DemoJob["category"], program: string, exitStatus?: number) => ({
    id: `${now - minutesAgo * 60000}-0`,
    at: now - minutesAgo * 60000,
    kind,
    label,
    category,
    path: `${DIRS[category]}/${label}.plist`,
    program,
    ...(exitStatus === undefined ? {} : { exitStatus }),
  });
  return [
    ev(3, "failed", "com.example.nightly-build", "user-agents", "/bin/bash", 78),
    ev(42, "added", "com.acme.updater.daemon", "global-daemons", "/Library/PrivilegedHelperTools/com.acme.updater"),
    ev(42, "added", "com.acme.updater.agent", "global-agents", "/Library/Application Support/Acme/UpdaterAgent"),
    ev(180, "modified", "com.example.backup-documents", "user-agents", "/usr/bin/rsync"),
    ev(1440, "removed", "com.oldvendor.telemetry", "global-daemons", "/Library/OldVendor/telemetryd"),
  ];
}

export const meta = {
  "user-agents/com.example.backup-documents": { notes: "Nightly copy of Documents to the external disk. Check the disk is mounted.", tags: ["backup"], icon: "💾" },
  "global-daemons/com.example.offsite-backup": { notes: "restic to the offsite bucket.", tags: ["backup", "root"], icon: "☁️" },
  "user-agents/com.example.dev-server": { notes: "", tags: ["work"], icon: "🛠" },
  "user-agents/com.example.weekly-report": { notes: "", tags: ["work"], icon: "📊" },
};

export const extras = {
  cron: ["*/10 * * * * /usr/local/bin/heartbeat --quiet", "0 4 * * 0 /usr/sbin/periodic weekly"],
  helperTools: [{ name: "com.acme.updater", path: "/Library/PrivilegedHelperTools/com.acme.updater" }],
  startupItems: [],
};

export const backgroundItems = [
  { uid: 501, name: "Acme", developerName: "Acme Inc.", type: "developer", disposition: ["enabled", "allowed", "notified"], identifier: "Acme", url: null, executablePath: null, parentIdentifier: null, teamIdentifier: "ACME123456" },
  { uid: 501, name: "Acme Helper", developerName: "Acme Inc.", type: "login item", disposition: ["enabled", "allowed", "notified"], identifier: "com.acme.menubar-helper", url: "file:///Applications/Acme.app/Contents/Library/LoginItems/Helper.app/", executablePath: null, parentIdentifier: "Acme", teamIdentifier: "ACME123456" },
  { uid: 0, name: "com.example.legacy-vpn", developerName: null, type: "legacy daemon", disposition: ["disabled", "allowed", "notified"], identifier: "com.example.legacy-vpn", url: "file:///Library/LaunchDaemons/com.example.legacy-vpn.plist", executablePath: "/Library/Application Support/LegacyVPN/vpnd", parentIdentifier: null, teamIdentifier: null },
];

export function signature(label: string) {
  const j = JOBS.find((x) => x.label === label);
  const apple = !!j && (j.program.startsWith("/usr/bin") || j.program.startsWith("/bin") || j.program.startsWith("/System") || j.program.startsWith("/usr/libexec"));
  if (apple) return { path: j!.program, signed: true, identifier: "com.apple.tool", authorities: ["Software Signing", "Apple Code Signing Certification Authority", "Apple Root CA"], teamId: null, apple: true, trusted: true, adhoc: false, error: null };
  if (label.includes("legacy")) return { path: j?.program ?? null, signed: false, identifier: null, authorities: [], teamId: null, apple: false, trusted: false, adhoc: false, error: null };
  return { path: j?.program ?? null, signed: true, identifier: label, authorities: ["Developer ID Application: Acme Inc. (ACME123456)", "Developer ID Certification Authority", "Apple Root CA"], teamId: "ACME123456", apple: false, trusted: true, adhoc: false, error: null };
}

export function detail(label: string, category: string) {
  const j = JOBS.find((x) => x.label === label);
  const domain = category.endsWith("daemons") ? "system" : "gui/501";
  const state = j?.status === "running" ? "running" : "not running";
  return {
    path: j ? `${DIRS[j.category]}/${label}.plist` : null,
    type: category.endsWith("daemons") ? "LaunchDaemon" : "LaunchAgent",
    bundleId: null,
    state,
    environment: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    lastExitReason: j?.exit ? `${j.exit} (EX_CONFIG)` : null,
    domain,
    raw: `${domain}/${label} = {\n\tactive count = ${j?.status === "running" ? 1 : 0}\n\tpath = ${j ? DIRS[j.category] : ""}/${label}.plist\n\ttype = LaunchAgent\n\tstate = ${state}\n\n\tprogram = ${j?.program ?? ""}\n\tdefault environment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t}\n\n\truns = 14\n\tlast exit code = ${j?.exit ?? "(never exited)"}\n}`,
  };
}

export const output = {
  path: `${HOME}/Library/Logs/com.example.backup-documents.log`,
  exists: true,
  size: 1840,
  truncated: false,
  text: ["sending incremental file list", "Documents/Invoices/2026-09.pdf", "Documents/Notes/ideas.md", "", "sent 48,221 bytes  received 1,204 bytes  32,950.00 bytes/sec", "total size is 9,882,113  speedup is 199.94"].join("\n"),
};
