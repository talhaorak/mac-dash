export interface ProcessInfo {
  pid: number;
  ppid: number;
  uid: number;
  cpu: number;
  mem: number;
  rss: number; // in KB
  elapsed: string;
  command: string;
  path: string;
  args: string;
  user: string;
}

export interface ProcessChainEntry {
  pid: number;
  ppid: number;
  user: string;
  command: string;
}

export interface ProcessDetailExtended extends ProcessInfo {
  cwd: string | null;
  parentChain: ProcessChainEntry[];
}

async function exec(cmd: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    return await new Response(proc.stdout).text();
  } catch {
    return "";
  }
}

/**
 * Parse the executable path and short name from the full args string.
 * macOS `ps comm` truncates to ~16 chars (MAXCOMLEN), so we derive
 * everything from `args` which is never truncated.
 */
function parseExecutableFromArgs(argsStr: string): { name: string; path: string } {
  if (!argsStr || argsStr.trim() === "") {
    return { name: "?", path: "?" };
  }

  // Non-absolute paths: take first space-delimited token
  if (!argsStr.startsWith("/")) {
    const spaceIdx = argsStr.indexOf(" ");
    const cmd = spaceIdx >= 0 ? argsStr.substring(0, spaceIdx) : argsStr;
    return { name: cmd.split("/").pop() || cmd, path: cmd };
  }

  // .app bundle paths may contain spaces (e.g. "Firefox Developer Edition.app")
  // Pattern: /path/to/Something.app/Contents/MacOS/executable
  const macosExeMatch = argsStr.match(/^(\/.*?\.app\/Contents\/MacOS\/\S+)/);
  if (macosExeMatch) {
    const path = macosExeMatch[1];
    return { name: path.split("/").pop() || path, path };
  }

  // .app bundle with other internal paths
  const appMatch = argsStr.match(/^(\/.*?\.app\/\S+)/);
  if (appMatch) {
    const path = appMatch[1];
    return { name: path.split("/").pop() || path, path };
  }

  // Standard absolute paths (no spaces in path) — first space-delimited token
  const spaceIdx = argsStr.indexOf(" ");
  const path = spaceIdx >= 0 ? argsStr.substring(0, spaceIdx) : argsStr;
  return { name: path.split("/").pop() || path, path };
}

/** List all processes with resource info */
export async function listProcesses(): Promise<ProcessInfo[]> {
  // NOTE: We do NOT use `comm` because macOS truncates it to ~16 chars.
  // Instead we derive command name and path from the full `args` field.
  const output = await exec([
    "ps",
    "-eo",
    "pid,ppid,uid,user,%cpu,%mem,rss,etime,args",
  ]);

  const lines = output.trim().split("\n").slice(1); // skip header
  const processes: ProcessInfo[] = [];

  for (const line of lines) {
    const match = line
      .trim()
      .match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+)\s+(\S+)\s+(.+)$/
      );
    if (!match) continue;

    const [, pid, ppid, uid, user, cpu, mem, rss, elapsed, args] = match;
    const argsStr = args.trim();
    const { name, path } = parseExecutableFromArgs(argsStr);

    processes.push({
      pid: parseInt(pid),
      ppid: parseInt(ppid),
      uid: parseInt(uid),
      user,
      cpu: parseFloat(cpu),
      mem: parseFloat(mem),
      rss: parseInt(rss),
      elapsed: elapsed.trim(),
      command: name,
      path,
      args: argsStr,
    });
  }

  return processes.sort((a, b) => b.cpu - a.cpu);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type KillFailureReason =
  | "invalid"
  | "protected"
  | "not-permitted"
  | "not-found"
  | "failed";

export interface KillResult {
  ok: boolean;
  error?: string;
  /** Machine-readable failure class; the route maps it to an HTTP status */
  reason?: KillFailureReason;
}

/**
 * Refuse PIDs that must never be signalled from the dashboard:
 * launchd (1), the kernel (0), this server and the process that spawned it.
 */
function checkKillTarget(pid: number): KillResult | null {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, reason: "invalid", error: "Invalid PID" };
  }
  if (pid === 1) {
    return {
      ok: false,
      reason: "protected",
      error: "Refusing to kill PID 1 (launchd)",
    };
  }
  if (pid === process.pid) {
    return {
      ok: false,
      reason: "protected",
      error: `Refusing to kill PID ${pid}: it is the mac-dash server itself`,
    };
  }
  if (pid === process.ppid) {
    return {
      ok: false,
      reason: "protected",
      error: `Refusing to kill PID ${pid}: it is the parent of the mac-dash server`,
    };
  }
  return null;
}

/** Kill a process by PID */
export async function killProcess(
  pid: number,
  signal: "TERM" | "KILL" = "TERM"
): Promise<KillResult> {
  const rejected = checkKillTarget(pid);
  if (rejected) return rejected;

  try {
    const sig = signal === "KILL" ? "-9" : "-15";
    const proc = Bun.spawn(["kill", sig, String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);
    if (exitCode === 0) return { ok: true };

    // `kill` prints "kill: <pid>: <strerror>"
    const err = stderr.trim();
    if (/operation not permitted/i.test(err)) {
      return {
        ok: false,
        reason: "not-permitted",
        error: `Cannot kill PID ${pid}: the process belongs to another user or to root`,
      };
    }
    if (/no such process/i.test(err)) {
      return {
        ok: false,
        reason: "not-found",
        error: `Cannot kill PID ${pid}: no such process`,
      };
    }
    return {
      ok: false,
      reason: "failed",
      error: err || `Failed to kill PID ${pid} (exit code ${exitCode})`,
    };
  } catch (e: unknown) {
    return { ok: false, reason: "failed", error: errorMessage(e) };
  }
}

/** Get the working directory of a process via lsof */
export async function getProcessCwd(pid: number): Promise<string | null> {
  try {
    const output = await exec(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    const lines = output.trim().split("\n");
    for (const line of lines) {
      if (line.startsWith("n") && line.length > 1) {
        return line.substring(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Upper bound for the ancestor walk; real chains are a handful of entries */
const MAX_CHAIN_DEPTH = 64;

/**
 * Get the parent chain of a process.
 * Takes ONE `ps` snapshot of every process and walks the pid → ppid map in
 * memory, instead of spawning one `ps` per ancestor.
 */
export async function getProcessChain(pid: number): Promise<ProcessChainEntry[]> {
  const output = await exec(["ps", "-axo", "pid=,ppid=,user=,args="]);

  const byPid = new Map<number, ProcessChainEntry>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;

    const [, pidStr, ppidStr, user, argsStr] = match;
    const { name } = parseExecutableFromArgs(argsStr.trim());
    const entryPid = parseInt(pidStr);
    byPid.set(entryPid, {
      pid: entryPid,
      ppid: parseInt(ppidStr),
      user,
      command: name,
    });
  }

  const chain: ProcessChainEntry[] = [];
  const visited = new Set<number>();
  let currentPid = pid;

  while (currentPid > 1 && chain.length < MAX_CHAIN_DEPTH) {
    if (visited.has(currentPid)) break; // pid reuse could form a cycle
    visited.add(currentPid);

    const entry = byPid.get(currentPid);
    if (!entry) break;
    chain.push(entry);

    if (entry.ppid === currentPid || entry.ppid <= 0) break;
    currentPid = entry.ppid;
  }

  return chain;
}

/** Get detailed info about a single process including cwd and parent chain */
export async function getProcessDetail(pid: number): Promise<ProcessDetailExtended | null> {
  const output = await exec([
    "ps",
    "-p",
    String(pid),
    "-o",
    "pid,ppid,uid,user,%cpu,%mem,rss,etime,args",
  ]);

  const lines = output.trim().split("\n").slice(1);
  if (lines.length === 0) return null;

  const match = lines[0]
    .trim()
    .match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+)\s+(\S+)\s+(.+)$/
    );
  if (!match) return null;

  const [, pidStr, ppid, uid, user, cpu, mem, rss, elapsed, args] = match;
  const argsStr = args.trim();
  const { name, path } = parseExecutableFromArgs(argsStr);

  // Fetch cwd and parent chain in parallel
  const [cwd, parentChain] = await Promise.all([
    getProcessCwd(parseInt(pidStr)),
    getProcessChain(parseInt(pidStr)),
  ]);

  return {
    pid: parseInt(pidStr),
    ppid: parseInt(ppid),
    uid: parseInt(uid),
    user,
    cpu: parseFloat(cpu),
    mem: parseFloat(mem),
    rss: parseInt(rss),
    elapsed: elapsed.trim(),
    command: name,
    path,
    args: argsStr,
    cwd,
    parentChain,
  };
}
