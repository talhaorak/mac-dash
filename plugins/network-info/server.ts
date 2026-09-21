// Type-only: the import is erased, so the plugin also loads next to a compiled
// binary where no node_modules/hono exists on disk.
import type { Hono } from "hono";

interface NetworkInterface {
  name: string;
  ip4: string | null;
  ip6: string | null;
  mac: string | null;
  status: "active" | "inactive";
  type: string;
}

interface ConnectionStats {
  established: number;
  listening: number;
  timeWait: number;
  closeWait: number;
  total: number;
}

interface CachedSummary {
  interfaces: NetworkInterface[];
  connections: ConnectionStats;
  fetchedAt: number;
}

async function exec(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    return await new Response(proc.stdout).text();
  } catch {
    return "";
  }
}

async function getNetworkInterfaces(): Promise<NetworkInterface[]> {
  const output = await exec(["ifconfig"]);
  const interfaces: NetworkInterface[] = [];
  let current: Partial<NetworkInterface> | null = null;

  for (const line of output.split("\n")) {
    const ifMatch = line.match(/^(\w+):\s+flags=\d+<([^>]*)>/);
    if (ifMatch) {
      if (current?.name) {
        interfaces.push(current as NetworkInterface);
      }
      const flags = ifMatch[2];
      current = {
        name: ifMatch[1],
        ip4: null,
        ip6: null,
        mac: null,
        status: flags.includes("UP") ? "active" : "inactive",
        type: ifMatch[1].startsWith("en")
          ? "Ethernet/Wi-Fi"
          : ifMatch[1].startsWith("lo")
            ? "Loopback"
            : ifMatch[1].startsWith("bridge")
              ? "Bridge"
              : ifMatch[1].startsWith("utun")
                ? "Tunnel"
                : ifMatch[1].startsWith("awdl")
                  ? "AirDrop"
                  : "Other",
      };
      continue;
    }

    if (!current) continue;

    const ip4Match = line.match(/^\s+inet (\d+\.\d+\.\d+\.\d+)/);
    if (ip4Match) current.ip4 = ip4Match[1];

    const ip6Match = line.match(/^\s+inet6 ([a-f0-9:]+)/);
    if (ip6Match && !current.ip6) current.ip6 = ip6Match[1];

    const macMatch = line.match(/^\s+ether ([a-f0-9:]+)/i);
    if (macMatch) current.mac = macMatch[1];
  }

  if (current?.name) {
    interfaces.push(current as NetworkInterface);
  }

  return interfaces.filter((i) => i.ip4 || i.status === "active");
}

async function getConnectionStats(): Promise<ConnectionStats> {
  const output = await exec(["netstat", "-an", "-p", "tcp"]);
  const stats: ConnectionStats = {
    established: 0,
    listening: 0,
    timeWait: 0,
    closeWait: 0,
    total: 0,
  };

  for (const line of output.split("\n")) {
    if (!line.includes("tcp")) continue;
    stats.total++;
    if (line.includes("ESTABLISHED")) stats.established++;
    else if (line.includes("LISTEN")) stats.listening++;
    else if (line.includes("TIME_WAIT")) stats.timeWait++;
    else if (line.includes("CLOSE_WAIT")) stats.closeWait++;
  }

  return stats;
}

// ── External IP ──────────────────────────────────────────────────────
// Asking a third party (api.ipify.org) reveals the user's address to it, so
// the lookup runs ONLY when a client calls `/external-ip` explicitly.
// `/summary` never triggers it; it reports the cached value or null.
const EXTERNAL_IP_URL = "https://api.ipify.org";
const EXTERNAL_IP_TIMEOUT_MS = 5_000;
const EXTERNAL_IP_TTL = 5 * 60_000; // 5 minutes

let cachedExternalIp: { ip: string | null; fetchedAt: number } | null = null;
let externalIpInFlight: Promise<string | null> | null = null;

function getCachedExternalIp(): string | null {
  if (!cachedExternalIp) return null;
  if (Date.now() - cachedExternalIp.fetchedAt >= EXTERNAL_IP_TTL) return null;
  return cachedExternalIp.ip;
}

async function fetchExternalIp(): Promise<string | null> {
  try {
    const res = await fetch(EXTERNAL_IP_URL, {
      signal: AbortSignal.timeout(EXTERNAL_IP_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const ip = (await res.text()).trim();
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null;
  } catch {
    return null; // offline, timeout, DNS failure
  }
}

/** Cached for 5 minutes (failures too); concurrent callers share one request */
async function getExternalIp(): Promise<string | null> {
  if (
    cachedExternalIp &&
    Date.now() - cachedExternalIp.fetchedAt < EXTERNAL_IP_TTL
  ) {
    return cachedExternalIp.ip;
  }
  if (externalIpInFlight) return externalIpInFlight;

  externalIpInFlight = fetchExternalIp()
    .then((ip) => {
      cachedExternalIp = { ip, fetchedAt: Date.now() };
      return ip;
    })
    .finally(() => {
      externalIpInFlight = null;
    });
  return externalIpInFlight;
}

// ── Cache: summary is valid for 15s to avoid redundant subprocess spawns ─
let cachedSummary: CachedSummary | null = null;
const CACHE_TTL = 15_000; // 15 seconds

async function getSummary(): Promise<CachedSummary> {
  if (cachedSummary && Date.now() - cachedSummary.fetchedAt < CACHE_TTL) {
    return cachedSummary;
  }

  const [interfaces, connections] = await Promise.all([
    getNetworkInterfaces(),
    getConnectionStats(),
  ]);

  cachedSummary = { interfaces, connections, fetchedAt: Date.now() };
  return cachedSummary;
}

export function register(app: Hono) {
  app.get("/api/plugins/network-info/interfaces", async (c) => {
    const summary = await getSummary();
    return c.json({ interfaces: summary.interfaces });
  });

  app.get("/api/plugins/network-info/connections", async (c) => {
    const summary = await getSummary();
    return c.json(summary.connections);
  });

  // The only endpoint that contacts the third-party service
  app.get("/api/plugins/network-info/external-ip", async (c) => {
    return c.json({ ip: await getExternalIp() });
  });

  app.get("/api/plugins/network-info/summary", async (c) => {
    const summary = await getSummary();
    return c.json({
      interfaces: summary.interfaces,
      connections: summary.connections,
      // Cache only: null until a client has asked `/external-ip`
      externalIp: getCachedExternalIp(),
    });
  });
}

export function cleanup() {
  cachedSummary = null;
  cachedExternalIp = null;
}
