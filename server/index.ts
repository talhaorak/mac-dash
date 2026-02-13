import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
import { join } from "path";

import servicesRoutes from "./routes/services";
import processesRoutes from "./routes/processes";
import logsRoutes from "./routes/logs";
import systemRoutes from "./routes/system";
import pluginsRoutes, { setRootApp } from "./routes/plugins";
import { wsHandler, startPolling, type WsData } from "./ws/hub";
import { discoverPlugins, loadPluginServer } from "./plugins/registry";

const app = new Hono();
const PORT = parseInt(process.env.PORT || "7227");
const isDev = process.env.NODE_ENV !== "production";

// Middleware
app.use("*", cors());
if (isDev) {
  app.use("*", logger());
}

// API Routes
app.route("/api/services", servicesRoutes);
app.route("/api/processes", processesRoutes);
app.route("/api/logs", logsRoutes);
app.route("/api/system", systemRoutes);
app.route("/api/plugins", pluginsRoutes);

// Give plugins access to the root Hono app for route registration
setRootApp(app);

// Health check
app.get("/api/health", (c) =>
  c.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() })
);

// Production: serve built client
if (!isDev) {
  const clientDir = join(import.meta.dir, "../dist/client");
  app.use("/*", serveStatic({ root: clientDir }));
  app.get("*", serveStatic({ path: join(clientDir, "index.html") }));
}

// Initialize
console.log(`\n  mac-dash starting...`);
console.log(`  Mode: ${isDev ? "development" : "production"}`);

// Log stream is now lazy — starts only when a client subscribes to "logs"
console.log("  Log stream: on-demand (lazy)");

// Discover and load plugins
discoverPlugins().then(async (plugins) => {
  console.log(`  Discovered ${plugins.length} plugin(s)`);
  for (const plugin of plugins) {
    if (plugin.enabled) {
      const loaded = await loadPluginServer(plugin.manifest.id, app);
      if (loaded) {
        console.log(`  Loaded plugin: ${plugin.manifest.name}`);
      }
    }
  }
});

// Start WebSocket polling
startPolling();
console.log("  WebSocket polling started");

// Start server with WebSocket support
const server = Bun.serve<WsData>({
  port: PORT,
  idleTimeout: 30, // seconds — avoid premature timeouts during first plist cache build
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req, {
        data: { subscriptions: new Set() },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Pass to Hono
    return app.fetch(req, { ip: server.requestIP(req) });
  },
  websocket: wsHandler,
});

console.log(`  Server listening on http://localhost:${server.port}`);
console.log(`  WebSocket on ws://localhost:${server.port}/ws`);
console.log(`\n  Ready!\n`);
