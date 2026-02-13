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

function parseLogLevel(level: string): LogEntry["level"] {
  const l = level.toLowerCase();
  if (l.includes("error") || l.includes("fault")) return "error";
  if (l.includes("warn")) return "warning";
  if (l.includes("info") || l.includes("notice")) return "info";
  if (l.includes("debug")) return "debug";
  return "default";
}

function parseCompactLogLine(line: string): LogEntry | null {
  // Compact format: "timestamp processName[pid] message"
  // or NDJSON format
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

  // Compact format parsing
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

/** Start the macOS log stream process (ref-counted) */
export function startLogStream(): void {
  streamRefCount++;
  if (streamProcess) return; // already running

  try {
    streamProcess = Bun.spawn(
      ["log", "stream", "--style", "compact", "--level", "info"],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const stdout = streamProcess.stdout;
    if (!stdout || typeof stdout === "number") return;
    const reader = (stdout as ReadableStream<Uint8Array>).getReader();

    const decoder = new TextDecoder();
    let buffer = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const entry = parseCompactLogLine(line);
            if (entry) {
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
          }
        }
      } catch (e) {
        console.error("Log stream error:", e);
      }
    })();
  } catch (e) {
    console.error("Failed to start log stream:", e);
  }
}

/** Stop the log stream (ref-counted — only stops when all callers release) */
export function stopLogStream(): void {
  streamRefCount = Math.max(0, streamRefCount - 1);
  if (streamRefCount === 0 && streamProcess) {
    streamProcess.kill();
    streamProcess = null;
  }
}

/** Force-stop the log stream regardless of ref count */
export function forceStopLogStream(): void {
  streamRefCount = 0;
  if (streamProcess) {
    streamProcess.kill();
    streamProcess = null;
  }
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
  return logBuffer.slice(-count);
}

/** Query historical logs using `log show` */
export async function queryLogs(
  lastMinutes: number = 5,
  predicate?: string
): Promise<LogEntry[]> {
  const args = [
    "log",
    "show",
    "--last",
    `${lastMinutes}m`,
    "--style",
    "compact",
  ];
  if (predicate) {
    args.push("--predicate", predicate);
  }

  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const entries: LogEntry[] = [];

    for (const line of output.split("\n")) {
      const entry = parseCompactLogLine(line);
      if (entry) entries.push(entry);
    }

    return entries.slice(-500); // cap at 500
  } catch {
    return [];
  }
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
): Promise<LogEntry[]> {
  const predicate = `process == "${processName}"`;
  return queryLogs(lastMinutes, predicate);
}
