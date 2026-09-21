import os from "os";
import { statfs } from "fs/promises";

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
// CPU model, core count and memory size come from the `os` module.
// Only the macOS product version needs a subprocess (`os.release()` is the
// Darwin kernel version, not "15.2").
let cachedCpuModel = "";
let cachedCpuCores = 0;
let cachedMemTotal = 0;
let cachedOsVersion = "";
let staticCached = false;

async function ensureStaticCache(): Promise<void> {
  if (staticCached) return;

  const cpus = os.cpus();
  cachedCpuModel = cpus[0]?.model?.trim() || "Unknown";
  cachedCpuCores = cpus.length || 1;
  cachedMemTotal = os.totalmem();

  cachedOsVersion = (await exec(["sw_vers", "-productVersion"])) || "unknown";
  staticCached = true;
}

// ── CPU usage from os.cpus() tick deltas (no subprocess) ─────────────
// os.cpus() reports cumulative per-core times.  Usage over an interval is
// the delta between two samples: (user+nice), (sys+irq) and idle as a
// share of the total delta.  This is what `top` reports, unlike the old
// sum of `ps -A -o %cpu` with a guessed 60/40 user/sys split.
interface CpuSample {
  user: number;
  sys: number;
  idle: number;
  at: number;
}

interface CpuUsage {
  user: number;
  sys: number;
  idle: number;
}

const CPU_MIN_SAMPLE_GAP_MS = 250; // below this the delta is mostly noise
const CPU_FIRST_SAMPLE_WAIT_MS = 200;
let lastCpuSample: CpuSample | null = null;
let lastCpuUsage: CpuUsage = { user: 0, sys: 0, idle: 100 };

function sampleCpu(): CpuSample {
  // Read the numbers right now: the delta needs values frozen at sample time.
  let user = 0;
  let sys = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    user += cpu.times.user + cpu.times.nice;
    sys += cpu.times.sys + cpu.times.irq;
    idle += cpu.times.idle;
  }
  return { user, sys, idle, at: Date.now() };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

async function getCpuUsage(): Promise<CpuUsage> {
  try {
    if (!lastCpuSample) {
      // First call: no previous sample, so take a short one-off window.
      lastCpuSample = sampleCpu();
      await Bun.sleep(CPU_FIRST_SAMPLE_WAIT_MS);
    } else if (Date.now() - lastCpuSample.at < CPU_MIN_SAMPLE_GAP_MS) {
      return lastCpuUsage;
    }

    const prev = lastCpuSample;
    const next = sampleCpu();
    const user = next.user - prev.user;
    const sys = next.sys - prev.sys;
    const idle = next.idle - prev.idle;
    const total = user + sys + idle;
    if (total <= 0) return lastCpuUsage; // counters did not advance

    lastCpuSample = next;
    lastCpuUsage = {
      user: round1((user / total) * 100),
      sys: round1((sys / total) * 100),
      idle: round1((idle / total) * 100),
    };
  } catch {}
  return lastCpuUsage;
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

// ── Load average, uptime, hostname: `os` module, no subprocess ───────
const round2 = (n: number): number => Math.round(n * 100) / 100;

function getLoadAvg(): [number, number, number] {
  const [one = 0, five = 0, fifteen = 0] = os.loadavg();
  return [round2(one), round2(five), round2(fifteen)];
}

function getUptime(): string {
  const upSeconds = Math.floor(os.uptime());
  if (!Number.isFinite(upSeconds) || upSeconds < 0) return "unknown";

  const days = Math.floor(upSeconds / 86400);
  const hours = Math.floor((upSeconds % 86400) / 3600);
  const mins = Math.floor((upSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function getHostname(): string {
  return os.hostname() || "localhost";
}

// ── Disk via statfs(2) (no subprocess) ───────────────────────────────
// used = total - available, the same formula as the desktop backend.
// (`df -k /` reports only the sealed APFS system volume as "Used".)
const DISK_MOUNT_POINT = "/";

async function getDiskStats(): Promise<{
  total: number;
  used: number;
  free: number;
}> {
  try {
    const stats = await statfs(DISK_MOUNT_POINT);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return { total, used: Math.max(total - free, 0), free };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

/** Get real-time system statistics — one subprocess per call (`vm_stat`) */
export async function getSystemStats(): Promise<SystemStats> {
  // Ensure static info is cached
  await ensureStaticCache();

  const [cpu, mem, disk] = await Promise.all([
    getCpuUsage(),
    getMemoryStats(cachedMemTotal),
    getDiskStats(),
  ]);

  return {
    cpu: {
      user: cpu.user,
      sys: cpu.sys,
      idle: cpu.idle,
      model: cachedCpuModel,
      cores: cachedCpuCores,
      loadAvg: getLoadAvg(),
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
      total: disk.total,
      used: disk.used,
      free: disk.free,
      usedPercent: disk.total > 0 ? (disk.used / disk.total) * 100 : 0,
      mountPoint: DISK_MOUNT_POINT,
    },
    uptime: getUptime(),
    hostname: getHostname(),
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
    hostname: getHostname(),
    serialNumber: null,
  };
}
