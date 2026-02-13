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

/** Kill a process by PID */
export async function killProcess(
  pid: number,
  signal: "TERM" | "KILL" = "TERM"
): Promise<{ ok: boolean; error?: string }> {
  try {
    const sig = signal === "KILL" ? "-9" : "-15";
    const proc = Bun.spawn(["kill", sig, String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      return { ok: false, error: err.trim() || `Failed to kill PID ${pid}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
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

/** Get the parent chain of a process */
export async function getProcessChain(pid: number): Promise<ProcessChainEntry[]> {
  const chain: ProcessChainEntry[] = [];
  let currentPid = pid;

  while (currentPid > 1) {
    const output = await exec([
      "ps", "-p", String(currentPid), "-o", "pid=,ppid=,user=,args=",
    ]);
    const line = output.trim();
    if (!line) break;

    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) break;

    const [, pidStr, ppidStr, user, argsStr] = match;
    const { name } = parseExecutableFromArgs(argsStr.trim());
    chain.push({
      pid: parseInt(pidStr),
      ppid: parseInt(ppidStr),
      user,
      command: name,
    });

    const nextPid = parseInt(ppidStr);
    if (nextPid === currentPid || nextPid <= 0) break;
    currentPid = nextPid;
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
