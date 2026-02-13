import type { ServerWebSocket } from "bun";
import { listServices } from "../core/launchctl";
import { listProcesses } from "../core/process-manager";
import { getSystemStats } from "../core/system-info";
import {
  onLogEntry,
  startLogStream,
  stopLogStream,
  type LogEntry,
} from "../core/log-reader";

export type WsData = {
  subscriptions: Set<string>;
};

type WsClient = ServerWebSocket<WsData>;

const clients = new Set<WsClient>();
let pollingIntervals: Timer[] = [];
let logUnsubscribe: (() => void) | null = null;

// ── Caching: avoid re-serialising and re-sending identical data ──────
let lastServicesJson = "";
let lastProcessesJson = "";

function broadcast(topic: string, type: "snapshot" | "update", data: any) {
  const message = JSON.stringify({
    topic,
    type,
    data,
    timestamp: Date.now(),
  });

  for (const client of clients) {
    if (
      client.data.subscriptions.has(topic) ||
      client.data.subscriptions.has("*")
    ) {
      try {
        client.send(message);
      } catch {
        clients.delete(client);
      }
    }
  }
}

// ── Topic-aware subscriber counting ──────────────────────────────────
function hasSubscribers(topic: string): boolean {
  for (const client of clients) {
    if (
      client.data.subscriptions.has(topic) ||
      client.data.subscriptions.has("*")
    ) {
      return true;
    }
  }
  return false;
}

function hasLogSubscribers(): boolean {
  return hasSubscribers("logs");
}

// ── Lazy log stream management ───────────────────────────────────────
// Only runs `log stream` when at least one client is subscribed to "logs"
let logStreamActive = false;

function ensureLogStream() {
  if (hasLogSubscribers() && !logStreamActive) {
    startLogStream();
    logStreamActive = true;
    logUnsubscribe = onLogEntry((entry: LogEntry) => {
      broadcast("logs", "update", entry);
    });
    console.log("  [hub] Log stream started (subscriber joined)");
  } else if (!hasLogSubscribers() && logStreamActive) {
    stopLogStream();
    logUnsubscribe?.();
    logUnsubscribe = null;
    logStreamActive = false;
    console.log("  [hub] Log stream stopped (no subscribers)");
  }
}

/** Start all polling loops for real-time data */
export function startPolling() {
  // ── System stats — every 5s (was 2s) ──────────────────────────────
  // Uses vm_stat + iostat instead of heavy `top -l 1`
  pollingIntervals.push(
    setInterval(async () => {
      if (!hasSubscribers("system")) return;
      try {
        const stats = await getSystemStats();
        broadcast("system", "snapshot", stats);
      } catch (e) {
        console.error("System poll error:", e);
      }
    }, 5000)
  );

  // ── Services — every 10s (was 3s) ─────────────────────────────────
  // Services rarely change; only broadcast when data actually differs
  pollingIntervals.push(
    setInterval(async () => {
      if (!hasSubscribers("services")) return;
      try {
        const services = await listServices();
        const json = JSON.stringify(services);
        if (json !== lastServicesJson) {
          lastServicesJson = json;
          broadcast("services", "snapshot", services);
        }
      } catch (e) {
        console.error("Services poll error:", e);
      }
    }, 10000)
  );

  // ── Processes — every 5s (was 3s) ──────────────────────────────────
  pollingIntervals.push(
    setInterval(async () => {
      if (!hasSubscribers("processes")) return;
      try {
        const processes = await listProcesses();
        const sliced = processes.slice(0, 200);
        const json = JSON.stringify(sliced);
        if (json !== lastProcessesJson) {
          lastProcessesJson = json;
          broadcast("processes", "snapshot", sliced);
        }
      } catch (e) {
        console.error("Processes poll error:", e);
      }
    }, 5000)
  );

  // Logs are NOT started here anymore — they start/stop lazily
  // based on whether anyone is subscribed to the "logs" topic.
}

export function stopPolling() {
  for (const interval of pollingIntervals) {
    clearInterval(interval);
  }
  pollingIntervals = [];
  // Also stop log stream
  if (logStreamActive) {
    stopLogStream();
    logUnsubscribe?.();
    logUnsubscribe = null;
    logStreamActive = false;
  }
}

export const wsHandler = {
  open(ws: WsClient) {
    ws.data.subscriptions = new Set();
    clients.add(ws);
    ws.send(JSON.stringify({ type: "connected", timestamp: Date.now() }));
  },

  message(ws: WsClient, message: string | Buffer) {
    try {
      const msg = JSON.parse(
        typeof message === "string" ? message : message.toString()
      );

      switch (msg.type) {
        case "subscribe": {
          const topics: string[] = Array.isArray(msg.topics)
            ? msg.topics
            : [msg.topic];
          for (const t of topics) {
            ws.data.subscriptions.add(t);
          }
          ws.send(
            JSON.stringify({
              type: "subscribed",
              topics: Array.from(ws.data.subscriptions),
              timestamp: Date.now(),
            })
          );
          // Check if log stream needs to start
          ensureLogStream();
          break;
        }

        case "unsubscribe": {
          const topics: string[] = Array.isArray(msg.topics)
            ? msg.topics
            : [msg.topic];
          for (const t of topics) {
            ws.data.subscriptions.delete(t);
          }
          // Check if log stream should stop
          ensureLogStream();
          break;
        }

        case "ping":
          ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          break;
      }
    } catch {
      // Ignore malformed messages
    }
  },

  close(ws: WsClient) {
    clients.delete(ws);
    // Check if log stream should stop (no more subscribers)
    ensureLogStream();
  },
};

export function getClientCount(): number {
  return clients.size;
}
