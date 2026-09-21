# Backend contract: launchd jobs

mac-dash has two backends that must behave identically:

- the Bun/Hono server (`server/`), reached over HTTP and WebSocket
- the Tauri shell (`packages/desktop/src-tauri/`), reached with `invoke()`

`client/src/lib/backend.ts` is the only place that knows which one is active.
All property-list editing happens in the client with `shared/plist.ts` and `shared/launchd.ts`.
Backends only move XML text, touch files and call `launchctl`.

## Rules for both backends

1. Never trust a path sent by the client. A job is addressed by `label` + `category`. The backend resolves the file itself.
2. A job file lives in one of five scope directories (see `JOB_SCOPES` in `shared/launchd.ts`). Only `user-agents`, `global-agents` and `global-daemons` are writable.
3. A label must match `LABEL_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$`) before it is used in a file name or a `launchctl` target.
4. launchd domain: agents use `gui/<uid>`, daemons use `system`.
5. `global-agents` file writes and every `system` domain mutation need root. Run them through one `osascript` call: `do shell script "<cmd>" with administrator privileges`. Pass the command as an `argv` item (`on run argv`), never by string interpolation into AppleScript. Single-quote every shell argument.
6. Spawn commands with argument arrays. Never build a shell string outside rule 5.
7. Status comes from `launchctl print gui/<uid>` and `launchctl print system` (the `services = { pid status label }` block; pid `0` means not running, status `-` means never exited). Disabled overrides come from `launchctl print-disabled <domain>`.
8. Use `bootstrap` / `bootout` / `enable` / `disable` / `kickstart` / `kill`. Never `load` / `unload`.

9. `(category, label)` is a unique key. When two files of one scope declare the same `Label`, the file named `<Label>.plist` keeps it (else the first by file name), and the others are listed under their file name without the extension.

## Types

```ts
type JobCategory = "user-agents" | "global-agents" | "global-daemons" | "system-agents" | "system-daemons";

interface ServiceInfo {
  label: string;
  pid: number | null;
  lastExitStatus: number | null;
  status: "running" | "stopped" | "error" | "unknown";
  category: JobCategory;
  plistPath: string | null;
  program: string | null;
  programArguments: string[] | null;
  runAtLoad: boolean | null;
  enabled: boolean;      // !disabled
  loaded: boolean;       // known to launchd in its domain
  disabled: boolean;     // print-disabled override, else ".plist.disabled" file, else Disabled key
  triggers: string[];    // describeTriggers() from shared/launchd.ts
  writable: boolean;     // scope is writable and the file exists
  needsAdmin: boolean;
  userName: string | null;
  unreadable: boolean;   // the plist exists but cannot be parsed
  quarantined: boolean;  // com.apple.quarantine xattr present (checked for writable scopes only)
  startInterval: number | null;
  calendar: Record<string, number>[]; // StartCalendarInterval entries, integer fields only
}

interface ServiceDetail {
  path: string | null;
  type: string | null;
  bundleId: string | null;
  state: string | null;
  environment: Record<string, string>;
  lastExitReason: string | null;
  domain: string;        // "gui/501" | "system"
  raw: string;           // full `launchctl print <domain>/<label>` output
}

interface JobDocument {
  label: string;
  category: JobCategory;
  path: string;
  fileName: string;
  xml: string;           // always XML, binary plists are converted
  writable: boolean;
  needsAdmin: boolean;
  mtime: number;         // ms since epoch
}

interface SaveJobRequest {
  category: JobCategory;            // target scope
  xml: string;                      // Label inside decides the file name
  original?: { label: string; category: JobCategory } | null; // set when editing; differs on rename/move
  load?: boolean;                   // default true: bootstrap after writing unless disabled
}

interface JobOutput { path: string | null; exists: boolean; size: number; truncated: boolean; text: string }

interface PathFacts { path: string; exists: boolean; isFile: boolean; isDirectory: boolean; executable: boolean }

interface JobMeta { notes: string; tags: string[] }          // stored in ~/.macdash/job-meta.json under "<category>/<label>"
interface JobRevision { id: string; at: number; size: number } // id = file name in ~/.macdash/backups
interface StartupExtras {
  cron: string[];                                   // `crontab -l` without comments and blank lines
  helperTools: { name: string; path: string }[];    // /Library/PrivilegedHelperTools
  startupItems: { name: string; path: string }[];   // /Library/StartupItems + /System/Library/StartupItems
}
interface LoginItem { name: string; path: string; hidden: boolean }

interface JobEvent {
  id: string;
  at: number;                       // ms since epoch
  kind: "added" | "modified" | "removed" | "failed";
  label: string;
  category: JobCategory;
  path: string;
  program: string | null;
  exitStatus?: number;              // only for "failed"
}

interface JobSignature {
  path: string | null;              // the job's executable (Program, else ProgramArguments[0])
  signed: boolean;
  identifier: string | null;
  authorities: string[];            // certificate chain, leaf first
  teamId: string | null;            // null for "not set"
  apple: boolean;                   // VERIFIED: `codesign -v -R="anchor apple"` exits 0
  trusted: boolean;                 // VERIFIED: `codesign -v -R="anchor apple generic"` exits 0 (Apple, Developer ID, App Store)
  adhoc: boolean;
  error: string | null;             // e.g. "Executable not found"
}

interface BackgroundItem {          // one record of `sfltool dumpbtm`
  uid: number;
  name: string;
  developerName: string | null;
  type: string;                     // text before " (0x..)", e.g. "developer", "legacy daemon", "login item", "app"
  disposition: string[];            // e.g. ["enabled", "allowed", "notified"]
  identifier: string | null;
  url: string | null;               // null for "(null)"
  executablePath: string | null;
  parentIdentifier: string | null;
  teamIdentifier: string | null;
}

interface PowerEvent {              // one half of `pmset repeat`
  type: "sleep" | "wake" | "poweron" | "shutdown" | "wakeorpoweron" | "restart";
  days: string;                     // subset of "MTWRFSU", in that order
  time: string;                     // "HH:MM:SS"
}
interface PowerSchedule { raw: string; repeating: PowerEvent[] }

interface MonitorSettings { notify: boolean; exclude: string[] }  // ~/.macdash/settings.json, shared by both backends
```

## Operations

| Operation | HTTP | Tauri command |
| --- | --- | --- |
| List | `GET /api/services` → `{ services, count }` | `get_services()` → `ServiceInfo[]` |
| Detail | `GET /api/services/detail?label=&category=` → `ServiceDetail` | `get_service_detail(label, category)` |
| Action | `POST /api/services/action` `{ label, category, action }` → `{ ok, error? }` | `manage_service(label, category, action)` |
| Read job | `GET /api/services/job?label=&category=` → `JobDocument` | `read_job(label, category)` |
| Save job | `POST /api/services/job` `SaveJobRequest` → `{ ok, label, path }` | `save_job(request)` |
| Delete job | `DELETE /api/services/job?label=&category=` → `{ ok }` | `delete_job(label, category)` |
| Job output | `GET /api/services/output?label=&category=&stream=stdout\|stderr&lines=200` → `JobOutput` | `read_job_output(label, category, stream, lines)` |
| Check paths | `POST /api/services/check-paths` `{ paths }` → `{ facts }` | `check_paths(paths)` → `PathFacts[]` |
| Reveal in Finder | `POST /api/services/reveal` `{ label, category }` → `{ ok }` | `reveal_job(label, category)` |
| All notes and tags | `GET /api/services/meta` → `{ meta: Record<string, JobMeta> }` | `get_job_meta()` → `Record<string, JobMeta>` |
| Set notes and tags | `PUT /api/services/meta` `{ label, category, notes, tags }` → `{ ok }` | `set_job_meta(label, category, notes, tags)` |
| Revisions | `GET /api/services/revisions?label=` → `{ revisions }` | `list_job_revisions(label)` → `JobRevision[]` |
| Read revision | `GET /api/services/revision?id=` → `{ xml }` | `read_job_revision(id)` → `string` |
| Other startup items | `GET /api/services/extras` → `StartupExtras` | `get_startup_extras()` |
| Login items | `GET /api/services/login-items` → `{ ok, items }` or `{ ok: false, error }` | `get_login_items()` → `LoginItem[]` |
| Shortcuts | `GET /api/services/shortcuts` → `{ shortcuts: string[] }` | `list_shortcuts()` → `string[]` |
| Code signature | `GET /api/services/signature?label=&category=` → `JobSignature` | `get_job_signature(label, category)` |
| Background items | `GET /api/services/background-items` → `{ items }` | `get_background_items()` → `BackgroundItem[]` |
| Delete login item | `DELETE /api/services/login-items?name=` → `{ ok }` | `delete_login_item(name)` |
| Build app from script | `POST /api/services/build-app` `{ scriptPath, name }` → `{ ok, path }` | `build_script_app(scriptPath, name)` → `{ path }` |
| Power schedule | `GET /api/services/power-schedule` → `PowerSchedule` | `get_power_schedule()` |
| Set power schedule | `PUT /api/services/power-schedule` `{ events: PowerEvent[] }` → `{ ok }` | `set_power_schedule(events)` |
| Monitor settings | `GET /api/services/monitor-settings` → `MonitorSettings` | `get_monitor_settings()` |
| Set monitor settings | `PUT /api/services/monitor-settings` `MonitorSettings` → `{ ok }` | `set_monitor_settings(notify, exclude)` |
| Change history | `GET /api/services/events` → `{ events }` | `get_job_events()` → `JobEvent[]` |
| Clear history | `DELETE /api/services/events` → `{ ok }` | `clear_job_events()` |
| Live changes | WebSocket topic `job-events`, one `JobEvent` per `update` message | Tauri event `job-event` with a `JobEvent` payload |

Actions: `start`, `stop`, `restart`, `load`, `unload`, `enable`, `disable`.

- `start`: bootstrap when not loaded, then `kickstart <domain>/<label>`. A job that is not loaded and is disabled fails with `The job is disabled. Enable it first.` (also for `restart` and `load`).
- `restart`: `kickstart -k`.
- `stop`: `kill SIGTERM`.
- `load`: `bootstrap <domain> <plist>`. `unload`: `bootout <domain>/<label>`.
- `enable`: rename `*.plist.disabled` back when present, `enable <domain>/<label>`, then bootstrap.
- `disable`: `bootout`, then `disable <domain>/<label>`.

## Save

1. Parse the XML. Reject when the root is not a dict, when `Label` fails `LABEL_PATTERN`, or when the target scope is not writable.
2. Target path is `<scope dir>/<Label>.plist`. Reject when it exists and is not the `original` job.
3. Lint from memory: `plutil -lint -` with the XML on stdin. Do not write a temporary file.
4. Copy the previous file to `~/.macdash/backups/<safe label>-<timestamp>.plist`. A label read from a plist is untrusted: replace every character outside `[A-Za-z0-9._-]` with `_` before it becomes a file name.
5. `bootout` the original job only when the path changes (rename, other scope) or when the job will be loaded again. "Save only" (`load: false`) on the same path leaves a running job alone.
6. Write `<target>.macdash-new`, then rename it over the target (`0644`, `root:wheel` in `/Library`). The rename is atomic and replaces a symlink instead of following it.
7. Move the original file to the Trash when the path changed, then `bootstrap` unless `load` is false or the job has `Disabled` set.

Privileged saves never pass a user-writable path to root. While the administrator prompt is open, any process of the same user could swap such a file. The root script receives the plist text itself, base64-encoded, as an argument, and decodes it into the staging file. The XML limit for a privileged save is 200 KB.
In the root script a tolerant step is its own group: `{ cmd || true; }`. `a && b || true && c` would hide a failure of `a`.
After a privileged save with `load`, check `launchctl print`. When the job is not loaded, return an error that starts with `Saved, but launchd did not load the job:`.

After writing, remove the `com.apple.quarantine` xattr from the file (ignore failures). Keep the newest 20 backups per label.

Notes and tags: empty notes plus no tags deletes the entry. Limits: notes 20 000 characters, 20 tags of 40 characters.
A revision id must match `^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.plist$` and contain no path separator.
Login items come from System Events through `osascript`. macOS asks for Automation permission on the first call, so clients only call it on request.

Root never writes into a folder the user controls, because a same-user process could plant a symlink there while the prompt is open:

- Target in `/Library`: the root script writes the file. Target in `~/Library/LaunchAgents`: the app writes it, also when the original job lives in `/Library`.
- Root-owned file to the Trash: the app copies the (world-readable) file to `~/.Trash`, the root script only runs `rm -f` on the original. When the copy fails, continue only if the backup succeeded.
- A label from a plist is untrusted. Skip `bootout` when the label contains `/` or starts with `-`. Strip control characters from the label and cut it to 80 characters before it goes into the administrator prompt.

## Delete

`bootout`, then move the file to `~/.Trash` (root-owned files: see above). Delete the job's notes and tags afterwards.
When the Trash is not reachable (another volume, macOS privacy protection), unlink only if the backup copy in `~/.macdash/backups` succeeded. Root-owned files are moved with administrator privileges and handed to the user.

## Signature, background items, apps, power

- **Signature**: run `codesign -dv --verbose=2 <executable>` and parse stderr (`Identifier=`, `Authority=` lines in order, `TeamIdentifier=`, `Signature=adhoc`). The executable path comes from the plist, never from the client. `code object is not signed at all` means `signed: false`. `codesign -d` only displays names, which a self-signed certificate can imitate, so `apple` and `trusted` come from the two `codesign -v -R=...` verifications (30 s timeout each, run only for signed code). A relative or missing executable gives `error`.
- **Background items**: parse `sfltool dumpbtm` (works without root on macOS 13+; when it fails return an empty list and the stderr text as the error). Records start with ` #<n>:` under a `Records for UID <uid>` header. Return the records of the current uid, of uid 0 and of uid -2. Skip the `Embedded Item Identifiers` sub-lists. Read-only: never call `resetbtm`.
- **Delete login item**: System Events through `osascript`, the name as an `argv` item after a `--` separator (an argument that starts with `-e` would otherwise be compiled as script text): `tell application "System Events" to delete login item (item 1 of argv)`. Same Automation-permission error text as for reading.
- **Build app**: wrap a script in an applet so macOS can grant it privacy permissions. `name` must match `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`. `scriptPath` must be absolute, exist, be a regular file and contain no control characters. Create `~/Applications` when missing. Refuse to overwrite an existing `.app`. Run `osacompile -o <app> -e 'do shell script quoted form of "<path>"'` with `\` and `"` escaped for the AppleScript string literal.
- **Power schedule**: read with `pmset -g sched` (the "Repeating power events" block: lines like `  wakepoweron at 7:00AM weekdays only`, `  sleep at 11:30PM every day`, `  shutdown at 9:00PM Some days: Mon Wed`). Set with one administrator prompt: `pmset repeat <type> <days> <time> [<type> <days> <time>]`, or `pmset repeat cancel` for an empty list. At most two events: one of `sleep|shutdown|restart` and one of `wake|poweron|wakeorpoweron`. Validate `days` against `^M?T?W?R?F?S?U?$` (not empty) and `time` against `^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$` before anything reaches the shell.
- **Monitor settings**: `notify: false` stops native notifications. A label that starts with one of the `exclude` prefixes never notifies. Events are still recorded. Limits: 50 prefixes of 100 characters.

## Monitor

The backend watches the five scope directories all the time, not only while a client is connected.
It diffs `(path, mtime, size)` snapshots, appends `JobEvent`s to `~/.macdash/job-events.json` (newest 500) and publishes them.
Every 30 seconds the monitor also compares the last exit status of the jobs that have a plist in a writable scope. When the status of a loaded job changes to a value other than 0, it records a `failed` event with `exitStatus`. A status of `-15` (SIGTERM, an orderly stop) is not a failure. The first pass is the baseline.
Native notifications honour `MonitorSettings`.
The desktop shell posts a native notification per event. The server posts one through `osascript` only when no WebSocket client is connected; otherwise the web client shows a browser notification.
