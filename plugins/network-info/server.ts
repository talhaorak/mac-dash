import { Hono } from "hono";

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
  externalIp: string | null;
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

async function getExternalIp(): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["curl", "-s", "-m", "3", "https://api.ipify.org"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const ip = (await new Response(proc.stdout).text()).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

// ── Cache: summary is valid for 15s to avoid redundant subprocess spawns ─
let cachedSummary: CachedSummary | null = null;
const CACHE_TTL = 15_000; // 15 seconds

async function getSummary(): Promise<CachedSummary> {
  if (cachedSummary && Date.now() - cachedSummary.fetchedAt < CACHE_TTL) {
    return cachedSummary;
  }

  const [interfaces, connections, externalIp] = await Promise.all([
    getNetworkInterfaces(),
    getConnectionStats(),
    getExternalIp(),
  ]);

  cachedSummary = { interfaces, connections, externalIp, fetchedAt: Date.now() };
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

  app.get("/api/plugins/network-info/external-ip", async (c) => {
    const summary = await getSummary();
    return c.json({ ip: summary.externalIp });
  });

  app.get("/api/plugins/network-info/summary", async (c) => {
    const summary = await getSummary();
    return c.json({
      interfaces: summary.interfaces,
      connections: summary.connections,
      externalIp: summary.externalIp,
    });
  });
}

export function cleanup() {
  cachedSummary = null;
}
