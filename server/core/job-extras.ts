import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { scopeFor, type JobCategory } from "../../shared/launchd";
import { BACKUP_DIR, STATE_DIR, revisionLabel, safeFileName } from "./launchctl";

// Notes, tags, revisions and the startup mechanisms that are not launchd plists.
// See docs/backend-contract.md. The Tauri backend mirrors this file.

// ── Notes and tags ───────────────────────────────────────────────────

export interface JobMeta {
  notes: string;
  tags: string[];
}

const META_FILE = join(STATE_DIR, "job-meta.json");
export const metaKey = (category: JobCategory, label: string) => `${category}/${label}`;

export async function getAllJobMeta(): Promise<Record<string, JobMeta>> {
  try {
    const parsed = JSON.parse(await readFile(META_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function setJobMeta(label: string, category: JobCategory, meta: JobMeta): Promise<void> {
  if (!scopeFor(category)) throw new Error(`Unknown category: ${category}`);
  const all = await getAllJobMeta();
  const notes = String(meta.notes ?? "").slice(0, 20_000);
  const tags = [...new Set((Array.isArray(meta.tags) ? meta.tags : []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (!notes && tags.length === 0) delete all[metaKey(category, label)];
  else all[metaKey(category, label)] = { notes, tags };
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(META_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// ── Revisions ────────────────────────────────────────────────────────

export interface JobRevision {
  id: string; // backup file name
  at: number;
  size: number;
}

export async function listRevisions(label: string): Promise<JobRevision[]> {
  let names: string[];
  try {
    names = await readdir(BACKUP_DIR);
  } catch {
    return [];
  }
  const revisions = await Promise.all(
    names
      .filter((name) => revisionLabel(name) === safeFileName(label))
      .map(async (id) => {
        const st = await stat(join(BACKUP_DIR, id));
        return { id, at: st.mtimeMs, size: st.size };
      })
  );
  return revisions.sort((a, b) => b.at - a.at);
}

export async function readRevision(id: string): Promise<string | null> {
  if (id.includes("/") || id.includes("\\") || revisionLabel(id) === null) return null;
  try {
    return await readFile(join(BACKUP_DIR, id), "utf8");
  } catch {
    return null;
  }
}

// ── Other startup mechanisms (read-only) ─────────────────────────────

export interface StartupExtras {
  cron: string[];
  helperTools: { name: string; path: string }[];
  startupItems: { name: string; path: string }[];
}

export interface LoginItem {
  name: string;
  path: string;
  hidden: boolean;
}

async function capture(cmd: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, stdout, stderr: stderr.trim() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

async function listDir(dir: string): Promise<{ name: string; path: string }[]> {
  try {
    return (await readdir(dir)).filter((n) => !n.startsWith(".")).sort().map((name) => ({ name, path: join(dir, name) }));
  } catch {
    return [];
  }
}

export async function getStartupExtras(): Promise<StartupExtras> {
  const [crontab, helperTools, startupA, startupB] = await Promise.all([
    capture(["crontab", "-l"]),
    listDir("/Library/PrivilegedHelperTools"),
    listDir("/Library/StartupItems"),
    listDir("/System/Library/StartupItems"),
  ]);
  const cron = crontab.code === 0
    ? crontab.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
    : [];
  return { cron, helperTools, startupItems: [...startupA, ...startupB] };
}

/**
 * Login items from System Events. The first call makes macOS ask for Automation permission,
 * so the client only calls this when the user asks for it.
 */
export async function getLoginItems(): Promise<{ ok: true; items: LoginItem[] } | { ok: false; error: string }> {
  const script = [
    'tell application "System Events"',
    'set out to ""',
    "repeat with li in login items",
    "set out to out & (name of li) & tab & (path of li) & tab & (hidden of li) & linefeed",
    "end repeat",
    "return out",
    "end tell",
  ];
  const result = await capture(["osascript", ...script.flatMap((line) => ["-e", line])], 30_000);
  if (result.code !== 0) {
    const denied = /-1743|not allowed|not authorized/i.test(result.stderr);
    return {
      ok: false,
      error: denied
        ? "macOS denied access. Allow mac-dash (or your terminal) under System Settings > Privacy & Security > Automation > System Events."
        : result.stderr || "Could not read the login items.",
    };
  }
  const items = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 3 && cols[0])
    .map(([name, path, hidden]) => ({ name, path: path === "missing value" ? "" : path, hidden: hidden.trim() === "true" }));
  return { ok: true, items };
}

/** Names of the user's Shortcuts, for the "Shortcut" run kind (/usr/bin/shortcuts run <name>). */
export async function listShortcuts(): Promise<string[]> {
  const result = await capture(["shortcuts", "list"]);
  return result.code === 0 ? result.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort() : [];
}
