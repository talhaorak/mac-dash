export interface SystemStats {
  cpu: {
    user: number;
    sys: number;
    idle: number;
    model: string;
    cores: number;
    loadAvg: [number, number, number];
  };
  memory: {
    total: number; // bytes
    used: number;
    free: number;
    wired: number;
    compressed: number;
    usedPercent: number;
  };
  disk: {
    total: number; // bytes
    used: number;
    free: number;
    usedPercent: number;
    mountPoint: string;
  };
  uptime: string;
  hostname: string;
  osVersion: string;
  processCount: number;
  threadCount: number;
}

export interface HardwareInfo {
  model: string;
  cpu: string;
  cores: number;
  memory: number; // bytes
  osVersion: string;
  hostname: string;
  serialNumber: string | null;
}

async function exec(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    return (await new Response(proc.stdout).text()).trim();
  } catch {
    return "";
  }
}

// ── Cached static values (fetched once) ──────────────────────────────
let cachedCpuModel = "";
let cachedCpuCores = 0;
let cachedMemTotal = 0;
let cachedHostname = "";
let cachedOsVersion = "";
let staticCached = false;

async function ensureStaticCache(): Promise<void> {
  if (staticCached) return;
  // Batch all sysctl keys in a single call
  const output = await exec([
    "sysctl",
    "-n",
    "machdep.cpu.brand_string",
    "hw.ncpu",
    "hw.memsize",
  ]);
  const lines = output.split("\n");
  cachedCpuModel = lines[0]?.trim() || "Unknown";
  cachedCpuCores = parseInt(lines[1]?.trim()) || 1;
  cachedMemTotal = parseInt(lines[2]?.trim()) || 0;

  const [hostname, osVersion] = await Promise.all([
    exec(["hostname"]),
    exec(["sw_vers", "-productVersion"]),
  ]);
  cachedHostname = hostname || "localhost";
  cachedOsVersion = osVersion || "unknown";
  staticCached = true;
}

// ── Lightweight CPU usage via ps + sysctl ─────────────────────────────
// Instead of `top -l 1` (heavy, enumerates all processes) or
// `iostat -c 2` (takes ~1s sampling window), we use:
// - `ps -A -o %cpu` to sum all process CPU usage (instant)
// - Divide by core count to approximate system-wide utilisation
// This is a rough approximation but extremely lightweight (~50ms).
let lastCpuIdle = 100;
let lastCpuUser = 0;
let lastCpuSys = 0;

async function getCpuUsage(): Promise<{
  user: number;
  sys: number;
  idle: number;
}> {
  try {
    const output = await exec(["ps", "-A", "-o", "%cpu"]);
    const lines = output.split("\n").slice(1); // skip header
    let totalCpu = 0;
    for (const line of lines) {
      const val = parseFloat(line.trim());
      if (!isNaN(val)) totalCpu += val;
    }
    // totalCpu is the sum of per-process CPU % (can exceed 100% on multi-core)
    // Normalise to 0-100 range by dividing by core count
    const cores = cachedCpuCores || 1;
    const usedPercent = Math.min(totalCpu / cores, 100);
    // Approximate user/sys split (typically ~60/40 on macOS)
    const user = Math.round(usedPercent * 0.6 * 10) / 10;
    const sys = Math.round(usedPercent * 0.4 * 10) / 10;
    const idle = Math.round((100 - usedPercent) * 10) / 10;

    lastCpuUser = user;
    lastCpuSys = sys;
    lastCpuIdle = idle;
    return { user, sys, idle };
  } catch {}
  return { user: lastCpuUser, sys: lastCpuSys, idle: lastCpuIdle };
}

// ── Memory via vm_stat (single lightweight call) ─────────────────────
async function getMemoryStats(
  totalMem: number
): Promise<{
  used: number;
  free: number;
  wired: number;
  compressed: number;
}> {
  try {
    const output = await exec(["vm_stat"]);
    const pageSize = 16384; // Default on Apple Silicon; fallback OK for display
    const pageSizeMatch = output.match(/page size of (\d+) bytes/);
    const pSize = pageSizeMatch ? parseInt(pageSizeMatch[1]) : pageSize;

    const getValue = (key: string): number => {
      const match = output.match(new RegExp(`${key}:\\s+(\\d+)`));
      return match ? parseInt(match[1]) * pSize : 0;
    };

    const free = getValue("Pages free");
    const active = getValue("Pages active");
    const inactive = getValue("Pages inactive");
    const speculative = getValue("Pages speculative");
    const wired = getValue("Pages wired down");
    const compressed = getValue("Pages occupied by compressor");

    const used = active + wired + compressed;
    const actualFree = free + inactive + speculative;

    return { used, free: actualFree, wired, compressed };
  } catch {
    return { used: 0, free: totalMem, wired: 0, compressed: 0 };
  }
}

// ── Load average & process/thread counts from sysctl ─────────────────
async function getLoadAndProcessCounts(): Promise<{
  loadAvg: [number, number, number];
  processCount: number;
  threadCount: number;
}> {
  try {
    const output = await exec(["sysctl", "-n", "vm.loadavg", "kern.proc.all"]);
    // vm.loadavg: "{ 2.45 3.12 2.98 }"
    const loadMatch = output.match(
      /\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/
    );
    const loadAvg: [number, number, number] = loadMatch
      ? [
          parseFloat(loadMatch[1]),
          parseFloat(loadMatch[2]),
          parseFloat(loadMatch[3]),
        ]
      : [0, 0, 0];

    // kern.proc.all is not always available; fallback to ps count
    return { loadAvg, processCount: 0, threadCount: 0 };
  } catch {
    return { loadAvg: [0, 0, 0], processCount: 0, threadCount: 0 };
  }
}

async function getLoadAvg(): Promise<[number, number, number]> {
  try {
    const output = await exec(["sysctl", "-n", "vm.loadavg"]);
    const match = output.match(/\{\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\}/);
    if (match) {
      return [
        parseFloat(match[1]),
        parseFloat(match[2]),
        parseFloat(match[3]),
      ];
    }
  } catch {}
  return [0, 0, 0];
}

// ── Uptime from sysctl (no subprocess needed) ────────────────────────
async function getUptime(): Promise<string> {
  try {
    const output = await exec(["sysctl", "-n", "kern.boottime"]);
    // kern.boottime: "{ sec = 1707834567, usec = 123456 } ..."
    const match = output.match(/sec\s*=\s*(\d+)/);
    if (match) {
      const bootTime = parseInt(match[1]);
      const upSeconds = Math.floor(Date.now() / 1000 - bootTime);
      const days = Math.floor(upSeconds / 86400);
      const hours = Math.floor((upSeconds % 86400) / 3600);
      const mins = Math.floor((upSeconds % 3600) / 60);
      if (days > 0) return `${days}d ${hours}h ${mins}m`;
      if (hours > 0) return `${hours}h ${mins}m`;
      return `${mins}m`;
    }
  } catch {}
  return "unknown";
}

/** Get real-time system statistics — OPTIMIZED: no more `top` */
export async function getSystemStats(): Promise<SystemStats> {
  // Ensure static info is cached
  await ensureStaticCache();

  // Run lightweight commands in parallel
  const [cpu, mem, loadAvg, dfOutput, uptime] = await Promise.all([
    getCpuUsage(),
    getMemoryStats(cachedMemTotal),
    getLoadAvg(),
    exec(["df", "-k", "/"]),
    getUptime(),
  ]);

  // Parse disk usage
  let diskTotal = 0,
    diskUsed = 0,
    diskFree = 0;
  const dfLines = dfOutput.split("\n");
  if (dfLines.length > 1) {
    const parts = dfLines[1].trim().split(/\s+/);
    if (parts.length >= 4) {
      diskTotal = parseInt(parts[1]) * 1024;
      diskUsed = parseInt(parts[2]) * 1024;
      diskFree = parseInt(parts[3]) * 1024;
    }
  }

  return {
    cpu: {
      user: cpu.user,
      sys: cpu.sys,
      idle: cpu.idle,
      model: cachedCpuModel,
      cores: cachedCpuCores,
      loadAvg,
    },
    memory: {
      total: cachedMemTotal,
      used: mem.used,
      free: mem.free,
      wired: mem.wired,
      compressed: mem.compressed,
      usedPercent:
        cachedMemTotal > 0 ? (mem.used / cachedMemTotal) * 100 : 0,
    },
    disk: {
      total: diskTotal,
      used: diskUsed,
      free: diskFree,
      usedPercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
      mountPoint: "/",
    },
    uptime,
    hostname: cachedHostname,
    osVersion: cachedOsVersion,
    processCount: 0, // We get this from process list instead now
    threadCount: 0,
  };
}

/** Get static hardware info */
export async function getHardwareInfo(): Promise<HardwareInfo> {
  await ensureStaticCache();

  return {
    model: cachedCpuModel.includes("Apple")
      ? "Apple Silicon Mac"
      : "Intel Mac",
    cpu: cachedCpuModel,
    cores: cachedCpuCores,
    memory: cachedMemTotal,
    osVersion: cachedOsVersion,
    hostname: cachedHostname,
    serialNumber: null,
  };
}
