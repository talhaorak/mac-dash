import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";

import servicesRoutes from "./routes/services";
import processesRoutes from "./routes/processes";
import logsRoutes from "./routes/logs";
import systemRoutes from "./routes/system";
import pluginsRoutes, { setRootApp } from "./routes/plugins";
import { wsHandler, startPolling, stopPolling, type WsData } from "./ws/hub";
import { discoverPlugins, loadPluginServer } from "./plugins/registry";
import { getClientDir } from "./plugins/paths";
import { shutdownLogReader } from "./core/log-reader";
import { startJobMonitor, stopJobMonitor } from "./core/job-monitor";
import { TOKEN_FILE, bearerToken, isAuthorized, loadOrCreateToken, tokensMatch } from "./core/auth";

const app = new Hono({ strict: false }); // the client calls some routes with a trailing slash
const PORT = parseInt(process.env.PORT || "7227");
const HOST = process.env.HOST || "127.0.0.1";
const isDev = process.env.NODE_ENV !== "production";
const DEV_CLIENT_PORT = parseInt(process.env.MACDASH_DEV_PORT || "7228"); // Vite dev server, see client/vite.config.ts

// ── Access control ───────────────────────────────────────────────────
// This API can kill processes and install launchd jobs.
// It therefore only answers requests that come from its own pages:
//   - Host must be a loopback name (blocks DNS rebinding), unless HOST was opened up on purpose.
//   - A request that carries an Origin must come from an allowed origin (blocks other web pages).
// On loopback that is the whole protection. A server that listens on the network also asks for a token.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const isLoopbackBind = LOOPBACK_HOSTS.has(HOST) || HOST === "::1";
const extraHosts = new Set((process.env.MACDASH_ALLOWED_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean));
const extraOrigins = (process.env.MACDASH_ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const allowedOrigins = new Set([
  ...["localhost", "127.0.0.1", "[::1]"].map((h) => `http://${h}:${PORT}`),
  ...(isDev ? [`http://localhost:${DEV_CLIENT_PORT}`, `http://127.0.0.1:${DEV_CLIENT_PORT}`] : []),
  ...extraOrigins,
]);

function hostnameOf(hostHeader: string | null): string {
  if (!hostHeader) return "";
  return hostHeader.startsWith("[") ? hostHeader.slice(0, hostHeader.indexOf("]") + 1) : hostHeader.split(":")[0];
}

function isAllowed(req: Request): boolean {
  const host = req.headers.get("host");
  if (isLoopbackBind && !LOOPBACK_HOSTS.has(hostnameOf(host)) && !extraHosts.has(hostnameOf(host))) return false;

  const origin = req.headers.get("origin");
  if (!origin) return true; // same-origin GET, curl, native clients
  if (allowedOrigins.has(origin)) return true;
  try {
    return !isLoopbackBind && new URL(origin).host === host; // LAN mode: same-origin only
  } catch {
    return false;
  }
}

const tokenRequired = !isLoopbackBind;
const accessToken = tokenRequired ? await loadOrCreateToken() : "";

// Middleware
app.use("*", async (c, next) => {
  if (!isAllowed(c.req.raw)) return c.json({ ok: false, error: "Forbidden origin" }, 403);
  await next();
});
app.use("*", cors({ origin: (origin) => (allowedOrigins.has(origin) ? origin : null) }));
if (isDev) {
  app.use("*", logger());
}
// After cors(): a preflight carries no Authorization header and is answered there.
// c.req.path is the decoded path the router matches, so "/%61pi/..." cannot slip past the check.
app.use("*", async (c, next) => {
  const request = { method: c.req.method, path: c.req.path, authorization: c.req.header("authorization") ?? null, queryToken: null };
  if (!isAuthorized(request, accessToken, tokenRequired)) return c.json({ ok: false, error: "Access token required" }, 401);
  await next();
});

app.get("/api/auth/status", (c) =>
  c.json({ required: tokenRequired, ok: !tokenRequired || tokensMatch(bearerToken(c.req.header("authorization")), accessToken) })
);

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
  const clientDir = getClientDir(); // also correct inside a compiled binary
  app.use("/*", serveStatic({ root: clientDir }));
  // `path` is joined to `root` (default "./"), so an absolute `path` alone would never be found.
  // An unknown API path stays a 404: a client must never get the page where it expects JSON.
  const indexPage = serveStatic({ root: clientDir, path: "index.html" });
  app.get("*", (c, next) => (c.req.path.startsWith("/api/") ? next() : indexPage(c, next)));
}

// `bun --watch` reloads in place and keeps the pid, so a `log stream` child of the previous
// run would survive every reload. Reap our own leftover children before starting.
if (isDev) {
  Bun.spawnSync(["pkill", "-P", String(process.pid), "-f", "log stream --style compact"]);
}

// Initialize
console.log(`\n  macdash starting...`);
console.log(`  Mode: ${isDev ? "development" : "production"}`);

// Log stream is lazy — starts only when a client subscribes to "logs"
console.log("  Log stream: on-demand (lazy)");

// Discover and load plugins
discoverPlugins()
  .then(async (plugins) => {
    console.log(`  Discovered ${plugins.length} plugin(s)`);
    for (const plugin of plugins) {
      if (plugin.enabled) {
        const loaded = await loadPluginServer(plugin.manifest.id, app);
        if (loaded) {
          console.log(`  Loaded plugin: ${plugin.manifest.name}`);
        }
      }
    }
  })
  .catch((e) => console.error("  Plugin discovery failed:", e));

// Watch the launchd folders for the whole lifetime of the server
startJobMonitor()
  .then(() => console.log("  launchd job monitor started"))
  .catch((e) => console.error("  launchd job monitor failed to start:", e));

// Start WebSocket polling
startPolling();
console.log("  WebSocket polling started");

// Start server with WebSocket support
const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,
  idleTimeout: 120, // seconds. `sfltool dumpbtm` and `log show` can take a minute on a busy Mac.
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/ws") {
      if (!isAllowed(req)) return new Response("Forbidden origin", { status: 403 });
      const request = { method: req.method, path: "/ws", authorization: null, queryToken: url.searchParams.get("token") };
      if (!isAuthorized(request, accessToken, tokenRequired)) return new Response("Access token required", { status: 401 });
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

function shutdown() {
  stopPolling();
  stopJobMonitor();
  shutdownLogReader();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`  Server listening on http://${HOST}:${server.port}`);
console.log(`  WebSocket on ws://${HOST}:${server.port}/ws`);
if (tokenRequired) {
  console.log(`  HOST=${HOST} is reachable from your network, so the API asks for an access token.`);
  console.log(`  Access token: ${accessToken}`);
  console.log(`  (stored in ${TOKEN_FILE})`);
}
console.log(`\n  Ready!\n`);
