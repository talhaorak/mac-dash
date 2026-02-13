import { $ } from "bun";
import { readdir } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

export interface ServiceInfo {
  label: string;
  pid: number | null;
  lastExitStatus: number | null;
  status: "running" | "stopped" | "error" | "unknown";
  category: "user-agents" | "global-agents" | "global-daemons" | "system-agents" | "system-daemons";
  plistPath: string | null;
  program: string | null;
  programArguments: string[] | null;
  runAtLoad: boolean | null;
  enabled: boolean;
  detail?: ServiceDetail;
}

export interface ServiceDetail {
  path: string | null;
  type: string | null;
  bundleId: string | null;
  state: string | null;
  environment: Record<string, string>;
  lastExitReason: string | null;
}

const SERVICE_DIRS: { path: string; category: ServiceInfo["category"] }[] = [
  { path: join(homedir(), "Library/LaunchAgents"), category: "user-agents" },
  { path: "/Library/LaunchAgents", category: "global-agents" },
  { path: "/Library/LaunchDaemons", category: "global-daemons" },
  { path: "/System/Library/LaunchAgents", category: "system-agents" },
  { path: "/System/Library/LaunchDaemons", category: "system-daemons" },
];

async function exec(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const text = await new Response(proc.stdout).text();
    return text.trim();
  } catch {
    return "";
  }
}

/** Parse `launchctl list` to get loaded services with PID and status */
async function getLoadedServices(): Promise<Map<string, { pid: number | null; exitStatus: number | null }>> {
  const output = await exec(["launchctl", "list"]);
  const map = new Map<string, { pid: number | null; exitStatus: number | null }>();

  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 3) {
      const pid = parts[0] === "-" ? null : parseInt(parts[0], 10);
      const exitStatus = parts[1] === "-" ? null : parseInt(parts[1], 10);
      const label = parts.slice(2).join(" ");
      map.set(label, { pid, exitStatus });
    }
  }

  return map;
}

/** Discover all plist files from known directories */
async function discoverPlists(): Promise<Map<string, { path: string; category: ServiceInfo["category"] }>> {
  const map = new Map<string, { path: string; category: ServiceInfo["category"] }>();

  for (const dir of SERVICE_DIRS) {
    try {
      const files = await readdir(dir.path);
      for (const file of files) {
        if (file.endsWith(".plist") || file.endsWith(".plist.disabled")) {
          const fullPath = join(dir.path, file);
          const label = basename(file).replace(/\.plist(\.disabled)?$/, "");
          map.set(label, { path: fullPath, category: dir.category });
        }
      }
    } catch {
      // Directory might not exist or lack permissions
    }
  }

  return map;
}

// ── Plist data cache ─────────────────────────────────────────────────
// Plist file contents are static; they don't change at runtime.
// We read them once and cache forever (until server restart).
interface PlistData {
  program: string | null;
  args: string[] | null;
  runAtLoad: boolean | null;
}

const plistCache = new Map<string, PlistData>();
let plistCachePopulated = false;

/** Read a plist using `plutil -convert xml1 -o -` (single process per file) */
async function readPlistFast(path: string): Promise<PlistData> {
  // Check cache first
  const cached = plistCache.get(path);
  if (cached) return cached;

  const result: PlistData = { program: null, args: null, runAtLoad: null };

  try {
    // Use plutil to convert plist to xml in one shot (faster than 3x PlistBuddy)
    const output = await exec(["plutil", "-convert", "xml1", "-o", "-", path]);
    if (!output) {
      plistCache.set(path, result);
      return result;
    }

    // Simple XML parsing for the keys we need
    const getStringValue = (key: string): string | null => {
      const pattern = new RegExp(
        `<key>${key}</key>\\s*<string>([^<]*)</string>`
      );
      const match = output.match(pattern);
      return match ? match[1] : null;
    };

    const getBoolValue = (key: string): boolean | null => {
      const pattern = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`);
      const match = output.match(pattern);
      return match ? match[1] === "true" : null;
    };

    result.program = getStringValue("Program");
    result.runAtLoad = getBoolValue("RunAtLoad");

    // Extract ProgramArguments array
    const argsMatch = output.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/
    );
    if (argsMatch) {
      const strings: string[] = [];
      const strRegex = /<string>([^<]*)<\/string>/g;
      let m;
      while ((m = strRegex.exec(argsMatch[1])) !== null) {
        strings.push(m[1]);
      }
      result.args = strings;
      if (!result.program && strings.length > 0) {
        result.program = strings[0];
      }
    }
  } catch {}

  plistCache.set(path, result);
  return result;
}

// ── Plist discovery cache ────────────────────────────────────────────
// Directory listings are also static; cache them.
let cachedPlists: Map<string, { path: string; category: ServiceInfo["category"] }> | null = null;

async function getCachedPlists() {
  if (!cachedPlists) {
    cachedPlists = await discoverPlists();
  }
  return cachedPlists;
}

// ── Pre-populate plist cache in background ───────────────────────────
// Reads all plists in parallel batches on first call, then uses cache
async function ensurePlistCachePopulated(
  plists: Map<string, { path: string; category: ServiceInfo["category"] }>
): Promise<void> {
  if (plistCachePopulated) return;

  // Read all plists in batches of 50 to avoid too many concurrent subprocesses
  const entries = [...plists.entries()];
  const BATCH_SIZE = 50;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(([_, { path }]) => readPlistFast(path))
    );
  }
  plistCachePopulated = true;
}

/** Get all services (merged loaded + discovered plists) */
export async function listServices(): Promise<ServiceInfo[]> {
  // Step 1: Get dynamic data (launchctl list) — this is the only command
  // that needs to run every time (lightweight, ~50ms)
  const [loaded, plists] = await Promise.all([
    getLoadedServices(),
    getCachedPlists(),
  ]);

  // Step 2: Ensure all plist data is cached (first call populates, subsequent calls instant)
  await ensurePlistCachePopulated(plists);

  const services: ServiceInfo[] = [];
  const seen = new Set<string>();

  // First pass: services from plists (all plist data comes from cache now)
  for (const [label, { path: plistPath, category }] of plists) {
    seen.add(label);
    const loadedInfo = loaded.get(label);
    const plistData = plistCache.get(plistPath) || {
      program: null,
      args: null,
      runAtLoad: null,
    };
    const isDisabled = plistPath.endsWith(".disabled");

    let status: ServiceInfo["status"] = "stopped";
    if (loadedInfo) {
      if (loadedInfo.pid !== null && loadedInfo.pid > 0) {
        status = "running";
      } else if (
        loadedInfo.exitStatus !== null &&
        loadedInfo.exitStatus !== 0
      ) {
        status = "error";
      } else {
        status = "stopped";
      }
    }

    services.push({
      label,
      pid: loadedInfo?.pid ?? null,
      lastExitStatus: loadedInfo?.exitStatus ?? null,
      status,
      category,
      plistPath,
      program: plistData.program ?? null,
      programArguments: plistData.args ?? null,
      runAtLoad: plistData.runAtLoad ?? null,
      enabled: !isDisabled && !!loadedInfo,
    });
  }

  // Second pass: loaded services without known plists (system/built-in)
  for (const [label, info] of loaded) {
    if (seen.has(label)) continue;

    let category: ServiceInfo["category"] = "system-agents";
    if (label.startsWith("com.apple.")) category = "system-agents";

    let status: ServiceInfo["status"] = "unknown";
    if (info.pid !== null && info.pid > 0) {
      status = "running";
    } else if (info.exitStatus !== null && info.exitStatus !== 0) {
      status = "error";
    } else {
      status = "stopped";
    }

    services.push({
      label,
      pid: info.pid,
      lastExitStatus: info.exitStatus,
      status,
      category,
      plistPath: null,
      program: null,
      programArguments: null,
      runAtLoad: null,
      enabled: true,
    });
  }

  return services.sort((a, b) => a.label.localeCompare(b.label));
}

/** Get detailed info about a specific service */
export async function getServiceDetail(label: string): Promise<ServiceDetail | null> {
  const uid = process.getuid?.() ?? 501;

  let output = await exec(["launchctl", "print", `gui/${uid}/${label}`]);
  if (!output) {
    output = await exec(["launchctl", "print", `system/${label}`]);
  }
  if (!output) return null;

  const detail: ServiceDetail = {
    path: null,
    type: null,
    bundleId: null,
    state: null,
    environment: {},
    lastExitReason: null,
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("path = ")) detail.path = trimmed.slice(7);
    else if (trimmed.startsWith("type = ")) detail.type = trimmed.slice(7);
    else if (trimmed.startsWith("bundle id = "))
      detail.bundleId = trimmed.slice(12);
    else if (trimmed.startsWith("state = ")) detail.state = trimmed.slice(8);
    else if (trimmed.startsWith("last exit reason = "))
      detail.lastExitReason = trimmed.slice(19);
  }

  const envMatch = output.match(/environment = \{([^}]*)\}/s);
  if (envMatch) {
    for (const line of envMatch[1].split("\n")) {
      const m = line.trim().match(/^(\S+)\s*=>\s*(.+)$/);
      if (m) detail.environment[m[1]] = m[2];
    }
  }

  return detail;
}

/** Start a service */
export async function startService(label: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const uid = process.getuid?.() ?? 501;
    const result = await exec(["launchctl", "kickstart", `gui/${uid}/${label}`]);
    if (result.includes("Could not find service")) {
      const sysResult = await exec(["launchctl", "kickstart", `system/${label}`]);
      if (sysResult.includes("Could not find service")) {
        return { ok: false, error: "Service not found" };
      }
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Stop a service */
export async function stopService(label: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const uid = process.getuid?.() ?? 501;
    await exec(["launchctl", "kill", "SIGTERM", `gui/${uid}/${label}`]);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Enable (load) a service */
export async function enableService(plistPath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const actualPath = plistPath.replace(/\.disabled$/, "");
    if (plistPath.endsWith(".disabled")) {
      const { rename } = await import("fs/promises");
      await rename(plistPath, actualPath);
    }
    await exec(["launchctl", "load", "-w", actualPath]);
    // Invalidate plist caches so next call picks up changes
    cachedPlists = null;
    plistCachePopulated = false;
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Disable (unload) a service */
export async function disableService(label: string, plistPath: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    if (plistPath) {
      await exec(["launchctl", "unload", "-w", plistPath]);
    } else {
      const uid = process.getuid?.() ?? 501;
      await exec(["launchctl", "remove", label]);
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
