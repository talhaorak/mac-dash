import { Subprocess } from "bun";
import { readdir, stat } from "fs/promises";
import { join } from "path";

export interface LogEntry {
  timestamp: string;
  level: "error" | "warning" | "info" | "debug" | "default";
  process: string;
  pid: number | null;
  message: string;
  subsystem: string | null;
  category: string | null;
}

export interface LogSource {
  id: string;
  name: string;
  path: string;
  size: number;
  modified: string;
}

type LogCallback = (entry: LogEntry) => void;

let streamProcess: Subprocess | null = null;
let listeners: Set<LogCallback> = new Set();
let logBuffer: LogEntry[] = [];
const MAX_BUFFER = 1000;

// Reference counting: multiple callers (WS hub, REST routes) can start/stop
// the stream.  We only actually stop when all callers have stopped.
let streamRefCount = 0;

// ── Restart policy for an unexpectedly exited `log stream` ───────────
// Exponential backoff (1s, 2s, 4s … capped at 30s) so a child that dies
// immediately cannot turn into a hot restart loop.  A run that survives
// STABLE_RUN_MS resets the backoff.
const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
const STABLE_RUN_MS = 60_000;
let restartTimer: Timer | null = null;
let restartAttempts = 0;

// ── Limits for `log show` queries ────────────────────────────────────
export const MAX_QUERY_MINUTES = 1440; // 24h
export const MAX_PREDICATE_LENGTH = 500;
export const MAX_PROCESS_NAME_LENGTH = 128;
const MAX_QUERY_ENTRIES = 500;
const QUERY_TIMEOUT_MS = 20_000;
const QUERY_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_CONCURRENT_QUERIES = 3;
const activeQueries = new Set<Subprocess>();

export interface LogQueryResult {
  entries: LogEntry[];
  /** true when the child was killed before it finished (see truncatedBy) */
  truncated: boolean;
  truncatedBy: "timeout" | "output-limit" | null;
}

/** Thrown when too many `log show` children are already running */
export class LogQueryBusyError extends Error {
  constructor() {
    super("Too many log queries are running. Try again in a few seconds.");
    this.name = "LogQueryBusyError";
  }
}

function parseLogLevel(level: string): LogEntry["level"] {
  const l = level.toLowerCase();
  if (l.includes("error") || l.includes("fault")) return "error";
  if (l.includes("warn")) return "warning";
  if (l.includes("info") || l.includes("notice")) return "info";
  if (l.includes("debug")) return "debug";
  return "default";
}

// "Ty" column of `--style compact`
const COMPACT_LEVELS: Record<string, LogEntry["level"]> = {
  E: "error",
  F: "error",
  I: "info",
  Db: "debug",
  Df: "default",
};

function parseCompactLogLine(line: string): LogEntry | null {
  // NDJSON, `--style compact`, or syslog-like lines
  try {
    // Try NDJSON first
    if (line.startsWith("{")) {
      const obj = JSON.parse(line);
      return {
        timestamp: obj.timestamp || new Date().toISOString(),
        level: parseLogLevel(obj.messageType || obj.level || "default"),
        process: obj.processImagePath?.split("/").pop() || obj.process || "unknown",
        pid: obj.processID ?? null,
        message: obj.eventMessage || obj.message || "",
        subsystem: obj.subsystem || null,
        category: obj.category || null,
      };
    }
  } catch {}

  // `--style compact`: "2026-01-31 12:00:00.123 Df process name[123:1a2b] message"
  const compact = line.match(
    /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+)\s+([A-Za-z]{1,2})\s+(.+?)\[(\d+):[0-9a-fA-F]+\]\s?(.*)$/
  );
  if (compact) {
    const [, timestamp, type, process, pid, message] = compact;
    return {
      timestamp,
      level: COMPACT_LEVELS[type] ?? "default",
      process: process.trim(),
      pid: parseInt(pid),
      message,
      subsystem: null,
      category: null,
    };
  }

  // Column header printed once by `log show` / `log stream`
  if (/^Timestamp\s+Ty\s+Process\[/.test(line)) return null;

  // syslog-like format: "timestamp+zone host process[pid] <Level> message"
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+[+-]\d{4})\s+\S+\s+(\S+)\[(\d+)\](?:\s+<(\w+)>)?\s+(.+)$/
  );
  if (match) {
    const [, timestamp, process, pid, level, message] = match;
    return {
      timestamp,
      level: parseLogLevel(level || "default"),
      process,
      pid: parseInt(pid),
      message,
      subsystem: null,
      category: null,
    };
  }

  // Fallback: just use the line as-is
  if (line.trim().length > 0) {
    return {
      timestamp: new Date().toISOString(),
      level: "default",
      process: "system",
      pid: null,
      message: line.trim(),
      subsystem: null,
      category: null,
    };
  }

  return null;
}

function handleLogLine(line: string): void {
  const entry = parseCompactLogLine(line);
  if (!entry) return;

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) {
    logBuffer = logBuffer.slice(-MAX_BUFFER);
  }
  for (const cb of listeners) {
    try {
      cb(entry);
    } catch {}
  }
}

/** Schedule a restart with capped exponential backoff */
function scheduleRestart(): void {
  if (restartTimer || streamRefCount === 0) return;

  const delay = Math.min(
    RESTART_BASE_DELAY_MS * 2 ** restartAttempts,
    RESTART_MAX_DELAY_MS
  );
  restartAttempts++;
  console.error(`Log stream: restarting in ${delay}ms (attempt ${restartAttempts})`);

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (streamRefCount > 0 && !streamProcess) spawnLogStream();
  }, delay);
}

/** Spawn the `log stream` child and wire up its stdout / exit handling */
function spawnLogStream(): void {
  let proc: Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(
      ["log", "stream", "--style", "compact", "--level", "info"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );
  } catch (e) {
    console.error("Failed to start log stream:", e);
    streamProcess = null;
    scheduleRestart();
    return;
  }

  streamProcess = proc;
  const startedAt = Date.now();

  // stdout → parsed entries
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) handleLogLine(line);
      }
    } catch (e) {
      console.error("Log stream error:", e);
    }
  })();

  // stderr must be drained or a chatty child blocks on a full pipe.
  // Keep only a short tail for the exit diagnostic.
  let stderrTail = "";
  (async () => {
    try {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr) {
        stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-500);
      }
    } catch {}
  })();

  proc.exited.then((exitCode) => {
    // stopLogStream()/shutdownLogReader() clear `streamProcess` before they
    // kill the child, so a mismatch means this exit was requested.
    if (streamProcess !== proc) return;

    streamProcess = null;
    if (Date.now() - startedAt >= STABLE_RUN_MS) restartAttempts = 0;
    console.error(
      `Log stream exited unexpectedly (code ${exitCode})${
        stderrTail.trim() ? `: ${stderrTail.trim()}` : ""
      }`
    );
    scheduleRestart();
  });
}

/** Kill the child (if any) and cancel a pending restart */
function killLogStream(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  restartAttempts = 0;

  const proc = streamProcess;
  streamProcess = null; // mark the exit as intentional before killing
  if (proc) {
    try {
      proc.kill();
    } catch {}
  }
}

/** Start the macOS log stream process (ref-counted) */
export function startLogStream(): void {
  streamRefCount++;
  if (streamProcess || restartTimer) return; // already running or restarting
  spawnLogStream();
}

/** Stop the log stream (ref-counted — only stops when all callers release) */
export function stopLogStream(): void {
  streamRefCount = Math.max(0, streamRefCount - 1);
  if (streamRefCount === 0) killLogStream();
}

/**
 * Release everything this module owns, regardless of ref count: the
 * `log stream` child, the restart timer and in-flight `log show` children.
 * Call it from the SIGINT/SIGTERM handler so no `log` process is orphaned.
 */
export function shutdownLogReader(): void {
  streamRefCount = 0;
  killLogStream();

  for (const proc of activeQueries) {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
  activeQueries.clear();
}

/** Subscribe to real-time log entries */
export function onLogEntry(callback: LogCallback): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Get buffered recent logs */
export function getRecentLogs(count: number = 100): LogEntry[] {
  const safeCount = Number.isFinite(count)
    ? Math.min(Math.max(Math.trunc(count), 1), MAX_BUFFER)
    : 100;
  return logBuffer.slice(-safeCount);
}

/**
 * Query historical logs using `log show`.
 *
 * Guards: `lastMinutes` is clamped to 1..MAX_QUERY_MINUTES, the predicate is
 * length-capped, the child is killed after QUERY_TIMEOUT_MS or once it has
 * produced QUERY_MAX_OUTPUT_BYTES, and stdout is consumed as a stream that
 * keeps only the newest MAX_QUERY_ENTRIES lines (memory stays bounded no
 * matter how much the child prints).
 */
export async function queryLogs(
  lastMinutes: number = 5,
  predicate?: string
): Promise<LogQueryResult> {
  if (predicate && predicate.length > MAX_PREDICATE_LENGTH) {
    throw new RangeError(
      `Predicate is too long (max ${MAX_PREDICATE_LENGTH} characters)`
    );
  }
  if (activeQueries.size >= MAX_CONCURRENT_QUERIES) {
    throw new LogQueryBusyError();
  }

  const minutes = Number.isFinite(lastMinutes)
    ? Math.min(Math.max(Math.trunc(lastMinutes), 1), MAX_QUERY_MINUTES)
    : 5;

  const args = [
    "log",
    "show",
    "--last",
    `${minutes}m`,
    "--style",
    "compact",
  ];
  if (predicate) {
    args.push("--predicate", predicate);
  }

  let proc: Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  } catch {
    return { entries: [], truncated: false, truncatedBy: null };
  }

  activeQueries.add(proc);
  let truncatedBy: LogQueryResult["truncatedBy"] = null;
  const timeout = setTimeout(() => {
    truncatedBy = "timeout";
    proc.kill("SIGKILL");
  }, QUERY_TIMEOUT_MS);

  // Newest raw lines only; parsing is deferred to the survivors.
  let tail: string[] = [];
  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let bytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim().length > 0) tail.push(line);
      }
      if (tail.length > MAX_QUERY_ENTRIES * 2) {
        tail = tail.slice(-MAX_QUERY_ENTRIES);
      }

      if (bytes > QUERY_MAX_OUTPUT_BYTES) {
        truncatedBy = "output-limit";
        proc.kill("SIGKILL");
        break;
      }
    }
    if (buffer.trim().length > 0) tail.push(buffer);
  } catch {
    // reader fails when the child is killed mid-read; keep what we have
  } finally {
    clearTimeout(timeout);
    activeQueries.delete(proc);
  }

  const entries: LogEntry[] = [];
  for (const line of tail.slice(-MAX_QUERY_ENTRIES)) {
    const entry = parseCompactLogLine(line);
    if (entry) entries.push(entry);
  }

  return { entries, truncated: truncatedBy !== null, truncatedBy };
}

/** List available log files in /var/log and ~/Library/Logs */
export async function listLogSources(): Promise<LogSource[]> {
  const sources: LogSource[] = [];
  const dirs = ["/var/log", join(process.env.HOME || "", "Library/Logs")];

  for (const dir of dirs) {
    try {
      const files = await readdir(dir, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile() && (file.name.endsWith(".log") || file.name.endsWith(".txt"))) {
          try {
            const fullPath = join(dir, file.name);
            const s = await stat(fullPath);
            sources.push({
              id: fullPath,
              name: file.name,
              path: fullPath,
              size: s.size,
              modified: s.mtime.toISOString(),
            });
          } catch {}
        }
      }
    } catch {}
  }

  return sources.sort((a, b) => b.modified.localeCompare(a.modified));
}

/** Get list of processes that are actively logging (from the buffer) */
export function getActiveLogProcesses(): { name: string; count: number; lastSeen: string }[] {
  const processCounts = new Map<string, { count: number; lastSeen: string }>();

  for (const entry of logBuffer) {
    const existing = processCounts.get(entry.process);
    if (existing) {
      existing.count++;
      if (entry.timestamp > existing.lastSeen) {
        existing.lastSeen = entry.timestamp;
      }
    } else {
      processCounts.set(entry.process, { count: 1, lastSeen: entry.timestamp });
    }
  }

  return Array.from(processCounts.entries())
    .map(([name, data]) => ({ name, count: data.count, lastSeen: data.lastSeen }))
    .sort((a, b) => b.count - a.count);
}

/** Query logs filtered by process name using `log show` */
export async function queryLogsByProcess(
  processName: string,
  lastMinutes: number = 5
): Promise<LogQueryResult> {
  if (processName.length === 0 || processName.length > MAX_PROCESS_NAME_LENGTH) {
    throw new RangeError(
      `Process name must be 1..${MAX_PROCESS_NAME_LENGTH} characters`
    );
  }
  // Escape for an NSPredicate string literal so the name cannot close the
  // quotes and append its own predicate clauses.
  const escaped = processName.replace(/[\\"]/g, "\\$&");
  const predicate = `process == "${escaped}"`;
  return queryLogs(lastMinutes, predicate);
}
