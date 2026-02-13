import { Hono } from "hono";
import {
  getRecentLogs,
  queryLogs,
  queryLogsByProcess,
  listLogSources,
  getActiveLogProcesses,
  startLogStream,
  stopLogStream,
} from "../core/log-reader";

const app = new Hono();

// ── Lazy log stream for REST clients ─────────────────────────────────
// When a client fetches /recent or /active-processes, we assume they're
// viewing the Logs page.  We start the stream on demand and stop it
// after 60 seconds of inactivity (no more REST requests to these endpoints).
let restLogStreamActive = false;
let restIdleTimer: Timer | null = null;

function touchRestLogStream() {
  if (!restLogStreamActive) {
    startLogStream();
    restLogStreamActive = true;
  }
  // Reset idle timer
  if (restIdleTimer) clearTimeout(restIdleTimer);
  restIdleTimer = setTimeout(() => {
    // Only stop if no WS subscribers are keeping it alive
    // (the WS hub manages its own start/stop)
    stopLogStream();
    restLogStreamActive = false;
  }, 60_000); // 60s idle timeout
}

app.get("/recent", async (c) => {
  touchRestLogStream();
  const count = parseInt(c.req.query("count") || "100");
  const process = c.req.query("process");
  let logs = getRecentLogs(count);
  if (process) {
    const q = process.toLowerCase();
    logs = logs.filter((l) => l.process.toLowerCase().includes(q));
  }
  return c.json({ logs, count: logs.length });
});

app.get("/query", async (c) => {
  const minutes = parseInt(c.req.query("minutes") || "5");
  const predicate = c.req.query("predicate") || undefined;
  const logs = await queryLogs(minutes, predicate);
  return c.json({ logs, count: logs.length });
});

app.get("/query/process/:name", async (c) => {
  const processName = c.req.param("name");
  const minutes = parseInt(c.req.query("minutes") || "5");
  const logs = await queryLogsByProcess(processName, minutes);
  return c.json({ logs, count: logs.length });
});

app.get("/sources", async (c) => {
  const sources = await listLogSources();
  return c.json({ sources });
});

app.get("/active-processes", async (c) => {
  touchRestLogStream();
  const processes = getActiveLogProcesses();
  return c.json({ processes });
});

export default app;
