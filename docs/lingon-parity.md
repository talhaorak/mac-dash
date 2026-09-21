# Lingon parity

Reference: Lingon Pro 10.3 (September 2026; "Lingon X" was renamed at version 10) and Lingon X 9.
Sources: the vendor page, its update feeds, archived FAQ pages and reviews. Items the sources do not confirm are left out.

Status: **Done** works in the web build and is implemented in the desktop backend. **Partial** covers the main use but not every detail. **Open** is not built.

## Scopes and listing

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 1 | User agents, global agents and global daemons in separate groups | Done | Services page groups |
| 2 | `/System/Library` agents and daemons, read-only | Done | Collapsed groups, editor opens in view mode |
| 3 | Login items from System Settings | Done | Listed on request, delete with a two-step confirm |
| 4 | App-embedded login-item helpers | Done | "Background items": the Background Task Management database, read-only |
| 5 | `/Library/PrivilegedHelperTools` | Partial | Listed. Delete is open |
| 6 | Legacy StartupItems | Done | "Other startup mechanisms" card |
| 7 | The user's crontab | Done | Same card |
| 8 | Unparseable plists | Done | Flagged in the list, repaired in Expert mode with the error line |
| 9 | Plists symlinked from user-added folders | Open | |
| 56 | Grid, tree, list and timeline views | Partial | Tree with counts, list with sortable and hideable columns, timeline. Grid is open |
| 57 | Search covers names and notes | Done | Also program, path and tags |
| 58 | Tags with a filter | Done | Tag chips |
| 59 | Notes per job, also on read-only jobs | Done | Detail drawer, Notes tab |
| 60 | Custom icon per job | Open | |
| 61 | Smart folders | Done | Rules over status, scope, owner, tags, triggers, schedule, exit status. Rules over arbitrary launchd keys are open |
| 62 | Quick "Go to" | Done | Cmd+K |
| 49 | Filter by status | Done | Running, stopped, error, disabled |
| 51 | List of system-disabled jobs | Done | "Disabled" filter reads `launchctl print-disabled` |

## Create and edit

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 10 | Create a job with name, enabled, scope and a run kind: command, script, app, shortcut | Done | New job, Run section |
| 11 | Automatic name | Done | `com.example.my-job`, made unique |
| 12 | Create by dropping a file | Open | |
| 13 | Script shell selector | Done | Interpreter list |
| 14 | Wrap a command in `sh -c` | Done | "Command" run kind |
| 15 | Build a script into an `.app` | Done | "Wrap in an app…" in the Script run kind |
| 16 | Pick a shortcut | Done | List from `shortcuts list` |
| 17 | Resolve bare commands to absolute paths, flag missing paths | Done | "Find the full path", Checks panel |
| 18 | Add PATH to the environment | Partial | One-click button. Lingon adds it automatically |
| 19 | Save reloads. Save without reload | Done | "Save and load", "Save only" |
| 20 | Discard changes, undo | Partial | Cancel with a confirmation. Undo is the browser's field undo |
| 21 | Keep unsaved edits across relaunch | Done | Drafts with restore and discard |
| 22 | Duplicate | Done | |
| 23 | Delete | Done | Moves to the Trash, keeps a backup |
| 24 | Show in Finder | Done | |
| 25 | Enable and disable, disabled jobs dimmed | Done | `launchctl enable/disable` plus bootstrap/bootout |
| 26 | Restart from the row, test run with output | Done | Run now, Restart, Output tab |
| 27 | Save to `/Library` with administrator rights | Done | One macOS password prompt per save. No persistent helper |
| 28 | UserName, GroupName, InitGroups for daemons | Done | "User and session" |
| 29–31 | RunAtLoad, KeepAlive with conditions, StartOnMount | Done | "When" |
| 32 | Several schedule rows: interval, hourly, daily, monthly, yearly, weekdays | Done | Interval with units, calendar rows with presets |
| 33 | WatchPaths and QueueDirectories with path pickers | Partial | Lists with existence checks. No native file picker |
| 34–35 | Standard in/out/error, working directory, environment table | Done | |
| 36 | LaunchEvents, MachServices, Sockets | Partial | Shown in the form, edited in Expert mode |
| 37–41 | Every other documented launchd key | Done | 52 keys in the schema, unknown keys are preserved |
| 38 | Umask as an rwx grid | Done | |
| 42 | Remove a key | Done | Empty the field or choose "Not set" |
| 43 | Mark sections that hold values | Done | "n set" badge |
| 44 | Help per key | Done | Key name and description under every field |
| 45 | Raw plist editor with syntax colours | Partial | Colours, parse errors with line numbers, find and replace. No themes |
| 46 | Reject a plist without Label and a program | Done | Blocking checks, plus `plutil -lint` in the backend |
| 63 | Revisions with revert | Done | Newest 20 per job in `~/.macdash/backups` |

## Inspect and monitor

| # | Capability | Status | Where |
| --- | --- | --- | --- |
| 47 | `launchctl print` per job | Done | Detail drawer |
| 48 | Running with PID, idle, live refresh | Done | Agents and daemons, from both launchd domains |
| 50 | Unified-log view per job | Partial | "System log" opens the Logs page filtered by the program |
| 52 | Background-items dump with reset | Partial | Searchable list. Reset is left out on purpose: it wipes every app's approval |
| 53 | Quarantine warning, cleared on save | Done | |
| 54 | Background monitor that notifies on added, changed and removed plists | Done | Server and desktop app watch all five folders |
| 55 | Quiet while the app is in front, prefix excludes, on/off switch, open the job from the notification | Partial | Excludes and the switch apply to both backends (`~/.macdash/settings.json`). A click on the desktop notification does not open the job |

## Not planned or platform-bound

| # | Capability | Status |
| --- | --- | --- |
| 64 | Tabs and multiple windows | Open |
| 65 | Customizable toolbar | Open |
| 66 | Scheduled Mac wake and sleep (`pmset repeat`) | Done. Setting it asks for an administrator password |
| 67 | Localisation, right-to-left layout | Open. Dark mode and keyboard access are done |

## Beyond Lingon

- Change history of the launchd folders (Lingon only notifies), and failed-job events.
- Verified code signature of every job's executable.
- Exit status explained in words (signal names, `EX_CONFIG` hints).
- Validation of 20+ mistakes: `~` in paths, app bundles as executables, agent-only and daemon-only keys, StartInterval against KeepAlive and ThrottleInterval, calendar ranges, deprecated keys.
- Job templates.
- Web access from the same Mac, plus processes, logs and system load in one tool.
