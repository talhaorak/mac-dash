# Contributing to mac-dash

Thank you for your interest in contributing to mac-dash! This guide will help you get started.

## Getting Started

### Prerequisites

- **macOS** (required - mac-dash uses macOS-specific APIs)
- **[Bun](https://bun.sh)** v1.1+

### Setup

```bash
# Clone the repo
git clone https://github.com/talhaorak/mac-dash.git
cd mac-dash

# Install dependencies
bun install
cd client && bun install && cd ..

# Start development
bun run dev
```

The dev server runs at `http://localhost:5173` (client) with API proxy to `http://localhost:7227` (server).

## Development

### Project Structure

```
mac-dash/
  server/           # Bun + Hono backend
    core/           # System info, launchctl, process manager, log reader
    routes/         # REST API endpoints
    ws/             # WebSocket hub
    plugins/        # Plugin registry & types
  client/           # React + Vite + Tailwind frontend
    src/
      components/   # UI components
      pages/        # Page components
      hooks/        # Custom hooks
      stores/       # Zustand stores
      lib/          # Utilities
  plugins/          # Plugin directory
  scripts/          # Helper scripts
  website/          # Landing page (GitHub Pages)
```

### Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server (client + server) |
| `bun run dev:server` | Start only the backend |
| `bun run dev:client` | Start only the frontend |
| `bun run build` | Build for production |
| `bun run start` | Run production server |
| `bun run typecheck` | TypeScript type checking |

### Code Style

- **TypeScript** everywhere
- **Functional** approach preferred
- Use **async/await** for async operations
- Components use **named exports** (except page defaults)
- Zustand for state management
- Hono for API routes

## Making Changes

### Branch Strategy

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Commit with a descriptive message
5. Push and open a Pull Request

### Commit Messages

Use clear, descriptive commit messages:

```
feat: add battery monitoring widget
fix: resolve WebSocket reconnection loop
docs: update plugin development guide
refactor: simplify service polling logic
```

### Pull Requests

- Fill out the PR template
- Reference any related issues
- Keep PRs focused - one feature/fix per PR
- Ensure the build passes

## Plugin Development

mac-dash has a plugin system. See `plugins/README.md` for the full guide.

Quick start:

```
plugins/
  my-plugin/
    manifest.json   # Plugin metadata
    server.ts       # Backend routes (optional)
    client.tsx      # Frontend UI (optional)
```

## Reporting Issues

- Use the **Bug Report** template for bugs
- Use the **Feature Request** template for ideas
- Include macOS version, Bun version, and steps to reproduce

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
