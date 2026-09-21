# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-09-21

### Added
- **Lingon parity, second round** ([docs/lingon-parity.md](docs/lingon-parity.md)): grid view, job icons, tree editor for nested keys (Sockets, MachServices, LaunchEvents), undo/redo and "Discard changes", a path picker for every path field, automatic PATH for new jobs, per-job system log tab, editor colour themes, smart-folder rules over any launchd key, view options, helper tool delete, background-item reset, file drop to create a job (desktop).
- **Deep links**: every view, filter, job and editor has its own URL. Browser tabs and reloads restore their state. Desktop: New Window (Cmd+N).
- **Light, dark and system appearance.**
- **English and Turkish** user interface with a language switch.
- **Access token** for servers that listen beyond loopback (`HOST=0.0.0.0`): login screen, `~/.macdash/token`.
- `bun run test:e2e`: an end-to-end test of the HTTP backend against real launchd, part of CI.
- `bun run media`: regenerates the README and website screenshots and the demo GIF from fictional data.
- README and website: real screenshots and a demo.

### Changed
- The background-item dump is cached for two minutes and runs once at a time (`sfltool dumpbtm` needs up to a minute on a busy Mac). HTTP idle timeout 120 s.
- A click on a browser notification opens the job.

### Fixed
- Production builds answered 404 for deep links.

## [1.1.0] - 2026-09-21

### Added
- **launchd job editor** with Lingon parity as the goal ([docs/lingon-parity.md](docs/lingon-parity.md)): form for every `launchd.plist` key, Expert mode (XML), validation, templates, duplicate, delete to Trash, revisions, notes and tags, timeline, output viewer, `launchctl print`.
- **Job monitor**: watches the five launchd folders all the time, keeps a change history in `~/.macdash/job-events.json`, notifies on added, changed and removed jobs.
- Jobs for all users and root jobs: `/Library` writes and `system` domain actions go through one macOS administrator prompt.
- Crontab, privileged helper tools, startup items and login items are listed read-only.
- `shared/plist.ts` (XML plist parser and serializer, tested against every plist on the machine) and `shared/launchd.ts` (key schema, validation, schedule summaries), used by the server and the client.
- `docs/backend-contract.md`: the contract both backends implement.
- Toasts, an accessible `Dialog`, and a two-step confirm for destructive actions.
- `bun test` and a desktop `cargo check` job in CI. Release smoke test for the compiled binary.

- **Code signature** of every job's executable, verified against Apple's root (`anchor apple`, `anchor apple generic`). Displayed certificate names are never trusted.
- **Background items**: the macOS Background Task Management database (login items, app-embedded helpers) as a searchable list. Login items can be deleted.
- **Smart folders** (saved rule-based filters), a **list view** with sortable columns, and a **quick switcher** (Cmd+K).
- **Failed-job events**: the monitor records and notifies when a job's exit status changes to a failure. Monitor settings live in `~/.macdash/settings.json` and apply to both backends.
- **Power schedule**: view and set repeating wake, start-up, sleep and shut-down times (`pmset repeat`).
- **Wrap a script in an app**, so macOS can grant it privacy permissions.
- Editor: Umask as a permission grid, find and replace in Expert mode, drafts that survive closing the editor.
- `?selftest=1` in development builds runs an end-to-end check of every backend operation, in the browser and inside the desktop app.

### Security
- The server listens on `127.0.0.1` instead of all interfaces.
- CORS is limited to the app's own origins. Requests with a foreign `Origin` or a non-loopback `Host` get 403, for HTTP and for the WebSocket upgrade.
- The API no longer accepts file paths from the client. Jobs are addressed by label and scope.
- Every `osascript` argument follows a `--` separator, so a value that starts with `-e` cannot be compiled as script text.
- `kill` refuses pid 1 and the server's own process.
- Privileged saves hand the plist text to the root script instead of a temporary file, so no other process can swap the content while the administrator prompt is open.
- Desktop: real CSP, no remote script in the About window, `withGlobalTauri` off, commands restricted to the main window.

### Changed
- Service state comes from `launchctl print gui/<uid>` and `launchctl print system`. Daemons now show their real state; before, every daemon showed as stopped.
- Enabled/disabled comes from `launchctl print-disabled`. `load`/`unload` are replaced by `bootstrap`, `bootout`, `enable`, `disable`, `kickstart`.
- Plist data is cached by modification time, so new and edited jobs appear without a restart.
- Failed actions show the real launchd error instead of reporting success.
- System stats use the `os` module and `statfs`: one subprocess per tick instead of six. Disk usage now counts the data volume.
- The plugin runtime is a separate chunk and recharts is replaced by an SVG sparkline: the main bundle went from 1769 KB to 627 KB.
- The Vite dev server uses port 7228 (`MACDASH_DEV_PORT`) instead of Vite's default 5173.
- Polling pauses while the window is hidden. Navigation no longer refetches everything. WebSocket reconnect uses backoff.
- Dependencies updated within their semver ranges. `react-router-dom` removed (unused).

### Fixed
- Two plist files that declare the same Label (macOS ships such a pair) no longer produce duplicate rows.
- The desktop app shows its real version, and its own WebView logging no longer floods the log page.
- The log viewer updated the store once per log line. A burst of lines tripped React's update limit. Lines are now added in batches every 250 ms.
- Log lines were all attributed to the process "system" (the parser did not match the `compact` log style).
- `log stream` is restarted when it exits and is killed on shutdown.
- Compiled release binaries did not find `plugins/`, served no client and reported version 0.1.0.
- Process details were empty in the desktop app.
- The "N new" badge in the log viewer never appeared.
- Closing the desktop window quit the app although a tray icon exists. It now hides to the tray.
- The Vite dev server crashed under the Bun runtime while proxying the WebSocket. `dev:client` runs Vite under Node.

## [1.0.9] - 2026-02-13

### Fixed
- Desktop window drag now works reliably from the custom top areas by using Tauri drag regions in the client layout.
- macOS traffic lights no longer overlap the app logo/header section in the sidebar.
- Removed Electron-style `app-region` CSS usage that conflicted with Tauri window drag behavior.

## [1.0.6] - 2026-02-13

### Added — Desktop App (Tauri v2)
- **Native macOS desktop app** — no server needed, ~5MB binary
- Rust backend with `sysinfo`, `plist`, `tokio` for native performance
- System tray with "Show Dashboard" and "Quit"
- **About Mac Dash** window with version, author, GitHub/website links
- **Auto-update support** — checks on startup + every 6h, "Install & Relaunch" dialog
- Desktop release CI/CD workflow (DMG + GitHub Release + Homebrew Cask)

### Fixed
- Traffic light buttons (close/minimize/fullscreen) no longer overlap app content
- Plugins page shows appropriate message in desktop mode (no HTTP server)
- Right-click context menu disabled in desktop mode
- Text selection disabled (except in logs/code) for native app feel
- Tauri v2 plugin configs (removed invalid map configs that caused startup crash)
- Backend adapter auto-detects Tauri mode vs HTTP API
- Serde camelCase rename on all Rust structs for proper JSON serialization

### Changed
- `backend.ts` adapter routes to `invoke()` in Tauri mode, HTTP in web mode
- Desktop polls at 3s interval via Tauri invoke (no WebSocket needed)

### Metadata
- Copyright: © 2026 Talha Orak
- Bundle: DMG + .app for macOS (arm64 + x64 universal)
- Identifier: `com.talhaorak.macdash`

## [1.0.5] - 2026-02-12

### Changed
- Renamed CLI command to `macdash`

## [1.0.0] - 2025-02-13

### Added
- Bun + Hono server with REST API and WebSocket real-time updates
- React + Vite + Tailwind client with dark glassmorphism UI
- System dashboard with CPU, memory, disk gauges and mini charts
- Service management (start, stop, enable, disable via launchctl)
- Process manager with sort and filter
- Log viewer with level filtering and lazy streaming
- Plugin system with manifest-based discovery
- Network info plugin (first-party)
- WebSocket topic-based pub/sub for efficient data streaming
- LaunchAgent installer script
- CLI support via npx and global npm install
- Homebrew formula
- GitHub Actions CI/CD (test, release, pages)
- Project landing page

[Unreleased]: https://github.com/talhaorak/mac-dash/compare/v1.0.9...HEAD
[1.0.9]: https://github.com/talhaorak/mac-dash/releases/tag/v1.0.9
[1.0.6]: https://github.com/talhaorak/mac-dash/releases/tag/v1.0.6
[1.0.5]: https://github.com/talhaorak/mac-dash/releases/tag/v1.0.5
[1.0.0]: https://github.com/talhaorak/mac-dash/releases/tag/v1.0.0
