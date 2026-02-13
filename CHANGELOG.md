# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
