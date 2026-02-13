#!/usr/bin/env node

/**
 * mac-dash CLI entry point
 * Checks for Bun runtime and launches the server
 */

import { execSync, spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const args = process.argv.slice(2);

// Help
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  mac-dash - macOS System Dashboard

  Usage:
    mac-dash [options]

  Options:
    --port, -p <port>   Set server port (default: 7227)
    --help, -h          Show this help
    --version, -v       Show version

  Environment:
    PORT                Server port (default: 7227)

  Examples:
    mac-dash              Start dashboard on port 7227
    mac-dash -p 8080      Start on port 8080
    npx mac-dash          Run without installing
`);
  process.exit(0);
}

// Version
if (args.includes("--version") || args.includes("-v")) {
  try {
    const pkg = JSON.parse(
      (await import("fs")).readFileSync(join(ROOT, "package.json"), "utf8")
    );
    console.log(pkg.version);
  } catch {
    console.log("unknown");
  }
  process.exit(0);
}

// Parse port
let port = process.env.PORT || "7227";
const portIdx = args.findIndex((a) => a === "--port" || a === "-p");
if (portIdx !== -1 && args[portIdx + 1]) {
  port = args[portIdx + 1];
}

// Check for Bun
let bunPath;
try {
  bunPath = execSync("which bun", { encoding: "utf8" }).trim();
} catch {
  console.error("\n  mac-dash requires the Bun runtime.\n");
  console.error("  Install Bun:");
  console.error("    curl -fsSL https://bun.sh/install | bash\n");
  console.error("  Or via Homebrew:");
  console.error("    brew install oven-sh/bun/bun\n");
  process.exit(1);
}

// Check macOS
if (process.platform !== "darwin") {
  console.error("\n  mac-dash only runs on macOS.\n");
  process.exit(1);
}

// Check built client exists
const clientDir = join(ROOT, "dist", "client");
if (!existsSync(clientDir)) {
  console.log("  Building client for first run...");
  try {
    execSync("bun run build", { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("  Build failed. Please run 'bun run build' manually.");
    process.exit(1);
  }
}

// Launch server
console.log(`\n  Starting mac-dash on http://localhost:${port}\n`);

const child = spawn(bunPath, ["server/index.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: port,
  },
});

child.on("error", (err) => {
  console.error("Failed to start mac-dash:", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

// Forward signals
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
