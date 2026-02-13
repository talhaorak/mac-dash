<p align="center">
  <br />
  <strong style="font-size: 48px;">🖥️</strong>
  <br />
</p>

<h1 align="center">mac-dash</h1>

<p align="center">
  <strong>Beautiful real-time macOS system dashboard</strong><br />
  Monitor services, processes, CPU, memory, disk and logs — all from your browser.
</p>

<p align="center">
  <a href="https://github.com/talhaorak/mac-dash/actions/workflows/ci.yml"><img src="https://github.com/talhaorak/mac-dash/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@talhaorak/mac-dash"><img src="https://img.shields.io/npm/v/mac-dash.svg?color=06b6d4" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/mac-dash"><img src="https://img.shields.io/npm/dm/mac-dash.svg?color=8b5cf6" alt="npm downloads" /></a>
  <a href="https://github.com/talhaorak/mac-dash/blob/master/LICENSE"><img src="https://img.shields.io/github/license/talhaorak/mac-dash?color=22c55e" alt="License" /></a>
  <a href="https://github.com/talhaorak/mac-dash/stargazers"><img src="https://img.shields.io/github/stars/talhaorak/mac-dash?style=social" alt="GitHub Stars" /></a>
</p>

<p align="center">
  <a href="https://talhaorak.github.io/mac-dash">Website</a> &middot;
  <a href="#installation">Install</a> &middot;
  <a href="#features">Features</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a> &middot;
  <a href="https://buymeacoffee.com/talhao">Sponsor</a>
</p>

---

## What is mac-dash?

mac-dash is a lightweight, real-time system dashboard for macOS. It runs a local web server and gives you a beautiful browser-based interface to:

- **Monitor** CPU, memory, and disk usage with live gauges and charts
- **Manage** LaunchAgents and LaunchDaemons (start, stop, enable, disable)
- **Explore** running processes (sort, filter, kill)
- **Stream** macOS unified logs in real-time
- **Extend** with plugins

Built with **Bun + Hono** (server) and **React + Tailwind** (client). No Electron. ~50ms overhead.

## Installation

### Quick Start (npx)

```bash
npx mac-dash
```

### Global Install (npm)

```bash
npm install -g mac-dash
mac-dash
```

### Homebrew

```bash
brew install talhaorak/tap/mac-dash
mac-dash
```

### From Source

```bash
git clone https://github.com/talhaorak/mac-dash.git
cd mac-dash
bun install
cd client && bun install && cd ..
bun run dev
```

> **Requirements**: macOS + [Bun](https://bun.sh) runtime

## Features

### System Dashboard
Real-time CPU, memory, and disk monitoring with animated gauges, sparkline charts, and hardware info.

### Service Manager
Browse all LaunchAgents and LaunchDaemons across user, global, and system directories. Start, stop, enable, or disable services with one click.

### Process Explorer
View running processes sorted by CPU or memory. See detailed command arguments. Kill processes when needed.

### Log Viewer
Stream macOS unified logs in real-time via WebSocket. Filter by log level (error, warning, info, debug) or by process name.

### Plugin System
Extend mac-dash with custom plugins that add new pages, API endpoints, and dashboard widgets.

```
plugins/
  my-plugin/
    manifest.json   # Plugin metadata
    server.ts       # Backend API routes
    client.tsx      # React UI component
```

See [plugins/README.md](plugins/README.md) for the full plugin development guide.

## Usage

```bash
# Start with default port (7227)
mac-dash

# Custom port
mac-dash --port 8080

# Or use environment variable
PORT=8080 mac-dash
```

Then open [http://localhost:7227](http://localhost:7227) in your browser.

### Run as Background Service

Install mac-dash as a LaunchAgent that starts on login:

```bash
./scripts/install-launchagent.sh
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Server | [Hono](https://hono.dev) |
| Frontend | [React 19](https://react.dev) |
| Styling | [Tailwind CSS 4](https://tailwindcss.com) |
| Bundler | [Vite](https://vite.dev) |
| Real-time | WebSocket |
| State | [Zustand](https://zustand.docs.pmnd.rs/) |
| Charts | [Recharts](https://recharts.org) |

## Project Structure

```
mac-dash/
  server/              # Bun + Hono backend
    core/              # System info, launchctl, process manager, log reader
    routes/            # REST API endpoints
    ws/                # WebSocket hub with topic-based subscriptions
    plugins/           # Plugin registry
  client/              # React + Vite + Tailwind frontend
    src/
      components/      # UI components (Gauge, MiniChart, GlowCard, etc.)
      pages/           # Dashboard, Services, Processes, Logs, Plugins
      hooks/           # Custom hooks (useWebSocket)
      stores/          # Zustand state stores
      lib/             # API client, utilities
  plugins/             # Plugin directory
  website/             # Landing page (GitHub Pages)
  scripts/             # Helper scripts
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)

## Support

If you find mac-dash useful, consider supporting the project:

<a href="https://buymeacoffee.com/talhao" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="40" /></a>

## Author

**Talha Orak** — Software Architect

- GitHub: [@talhaorak](https://github.com/talhaorak)
- Website: [talhaorak.github.io/mac-dash](https://talhaorak.github.io/mac-dash)

## License

[MIT](LICENSE) &copy; Talha Orak
