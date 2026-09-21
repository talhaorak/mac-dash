import { Hono } from "hono";
import {
  getRecentLogs,
  queryLogs,
  queryLogsByProcess,
  listLogSources,
  getActiveLogProcesses,
  startLogStream,
  stopLogStream,
  LogQueryBusyError,
  MAX_QUERY_MINUTES,
  MAX_PREDICATE_LENGTH,
  MAX_PROCESS_NAME_LENGTH,
} from "../core/log-reader";

const app = new Hono();

const MAX_RECENT_COUNT = 1000; // size of the in-memory stream buffer

/** Parse an integer query parameter and clamp it to [min, max] */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
  const count = clampInt(c.req.query("count"), 100, 1, MAX_RECENT_COUNT);
  const process = c.req.query("process");
  let logs = getRecentLogs(count);
  if (process) {
    const q = process.toLowerCase();
    logs = logs.filter((l) => l.process.toLowerCase().includes(q));
  }
  return c.json({ logs, count: logs.length });
});

app.get("/query", async (c) => {
  const minutes = clampInt(c.req.query("minutes"), 5, 1, MAX_QUERY_MINUTES);
  const predicate = c.req.query("predicate")?.trim() || undefined;
  if (predicate && predicate.length > MAX_PREDICATE_LENGTH) {
    return c.json(
      {
        ok: false,
        error: `Predicate is too long (max ${MAX_PREDICATE_LENGTH} characters)`,
      },
      400
    );
  }

  try {
    const result = await queryLogs(minutes, predicate);
    return c.json({
      logs: result.entries,
      count: result.entries.length,
      truncated: result.truncated,
    });
  } catch (e: unknown) {
    const status = e instanceof LogQueryBusyError ? 429 : 500;
    return c.json({ ok: false, error: errorMessage(e) }, status);
  }
});

app.get("/query/process/:name", async (c) => {
  const processName = c.req.param("name");
  if (!processName || processName.length > MAX_PROCESS_NAME_LENGTH) {
    return c.json(
      {
        ok: false,
        error: `Process name must be 1..${MAX_PROCESS_NAME_LENGTH} characters`,
      },
      400
    );
  }
  const minutes = clampInt(c.req.query("minutes"), 5, 1, MAX_QUERY_MINUTES);

  try {
    const result = await queryLogsByProcess(processName, minutes);
    return c.json({
      logs: result.entries,
      count: result.entries.length,
      truncated: result.truncated,
    });
  } catch (e: unknown) {
    const status = e instanceof LogQueryBusyError ? 429 : 500;
    return c.json({ ok: false, error: errorMessage(e) }, status);
  }
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
