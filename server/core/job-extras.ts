import { constants } from "fs";
import { copyFile, lstat, mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { join } from "path";
import { scopeFor, type JobCategory } from "../../shared/launchd";
import {
  BACKUP_DIR,
  JobError,
  STATE_DIR,
  errorMessage,
  promptLabel,
  revisionLabel,
  runPrivileged,
  runPrivilegedAfterTrashCopy,
  safeFileName,
  trashPath,
  type PrivilegedStep,
  type Result,
} from "./launchctl";

// Notes, tags, revisions and the startup mechanisms that are not launchd plists.
// See docs/backend-contract.md. The Tauri backend mirrors this file.

// ── Notes and tags ───────────────────────────────────────────────────

export interface JobMeta {
  notes: string;
  tags: string[];
  icon?: string;
}

const MAX_ICON_EMOJI_CHARS = 8;
const MAX_ICON_URL_LENGTH = 48 * 1024;
const ICON_DATA_URL = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
// Digits, "#" and "*" are emoji components too (keycaps), so a text such as "1234" needs the second test.
const EMOJI_PARTS = /^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u;
const EMOJI_BASE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u;

/** "" for no icon. Throws a JobError for anything other than an emoji or a small PNG/JPEG data URL. */
export function checkJobIcon(icon: unknown): string {
  if (icon === undefined || icon === null || icon === "") return "";
  if (typeof icon !== "string") throw new JobError("The icon must be a string.");
  if (icon.startsWith("data:")) {
    if (icon.length > MAX_ICON_URL_LENGTH) throw new JobError("The icon image is larger than 48 KB.");
    if (!ICON_DATA_URL.test(icon)) throw new JobError("The icon image must be a base64 PNG or JPEG data URL.");
    return icon;
  }
  // Characters are code points: one family emoji is seven of them.
  if ([...icon].length > MAX_ICON_EMOJI_CHARS || !EMOJI_PARTS.test(icon) || !EMOJI_BASE.test(icon)) {
    throw new JobError("The icon must be an emoji of at most 8 characters or a PNG or JPEG image.");
  }
  return icon;
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
  if (!scopeFor(category)) throw new JobError(`Unknown category: ${category}`);
  const icon = checkJobIcon(meta.icon);
  const all = await getAllJobMeta();
  const notes = String(meta.notes ?? "").slice(0, 20_000);
  const tags = [...new Set((Array.isArray(meta.tags) ? meta.tags : []).map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (!notes && tags.length === 0 && !icon) delete all[metaKey(category, label)];
  else all[metaKey(category, label)] = { notes, tags, ...(icon ? { icon } : {}) };
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

function explainSystemEventsError(stderr: string, fallback: string): string {
  if (/-1743|not allowed|not authorized/i.test(stderr)) {
    return "macOS denied access. Allow mac-dash (or your terminal) under System Settings > Privacy & Security > Automation > System Events.";
  }
  return stderr.replace(/^.*execution error: /, "") || fallback;
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
  if (result.code !== 0) return { ok: false, error: explainSystemEventsError(result.stderr, "Could not read the login items.") };
  const items = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((cols) => cols.length >= 3 && cols[0])
    .map(([name, path, hidden]) => ({ name, path: path === "missing value" ? "" : path, hidden: hidden.trim() === "true" }));
  return { ok: true, items };
}

/**
 * The name travels as an argv item, never inside the AppleScript text. "--" ends osascript's own
 * options: without it a name such as "-e ..." would be compiled as one more script line.
 */
export function deleteLoginItemArgv(name: string): string[] {
  return [
    "osascript",
    "-e", "on run argv",
    "-e", 'tell application "System Events" to delete login item (item 1 of argv)',
    "-e", "end run",
    "--",
    name,
  ];
}

export async function deleteLoginItem(name: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (typeof name !== "string" || !name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, error: "Invalid login item name." };
  }
  const result = await capture(deleteLoginItemArgv(name), 30_000);
  return result.code === 0 ? { ok: true } : { ok: false, error: explainSystemEventsError(result.stderr, "Could not delete the login item.") };
}

// ── Helper tools ─────────────────────────────────────────────────────

const HELPER_TOOLS_DIR = "/Library/PrivilegedHelperTools";
export const TRASH_COPY_FAILED = "The file cannot be copied to the Trash. Delete it permanently?";

/** One file name inside /Library/PrivilegedHelperTools. Throws a JobError for anything that could leave the folder. */
export function checkHelperToolName(name: unknown): string {
  if (typeof name !== "string" || !name || name.length > 255 || name.includes("/") || /^[.-]/.test(name) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
    throw new JobError("Invalid helper tool name.");
  }
  return name;
}

/** Root only removes the file. The app makes the Trash copy itself: root never writes into ~/.Trash. */
export function helperToolDeleteSteps(name: string): PrivilegedStep[] {
  return [{ cmd: ["/bin/rm", "-f", join(HELPER_TOOLS_DIR, checkHelperToolName(name))] }];
}

/** `permanent` skips the Trash copy. The client sets it after the user confirmed TRASH_COPY_FAILED. */
export async function deleteHelperTool(name: unknown, permanent: boolean): Promise<Result> {
  try {
    const tool = checkHelperToolName(name);
    const path = join(HELPER_TOOLS_DIR, tool);
    // lstat: a symlink is not a helper tool
    if (!(await lstat(path).then((st) => st.isFile(), () => false))) throw new JobError("Helper tool not found.");

    let trashCopy: string | null = null;
    if (!permanent) {
      trashCopy = await trashPath(tool);
      await copyFile(path, trashCopy, constants.COPYFILE_EXCL).catch(() => {
        throw new JobError(TRASH_COPY_FAILED);
      });
    }
    await runPrivilegedAfterTrashCopy(helperToolDeleteSteps(tool), `mac-dash wants to delete the helper tool "${promptLabel(tool)}".`, trashCopy);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// ── Background items ─────────────────────────────────────────────────

export interface BackgroundItem {
  uid: number;
  name: string;
  developerName: string | null;
  type: string;
  disposition: string[];
  identifier: string | null;
  url: string | null;
  executablePath: string | null;
  parentIdentifier: string | null;
  teamIdentifier: string | null;
}

/**
 * Records of `sfltool dumpbtm` for the given uids. A record starts with " #<n>:" under a
 * "Records for UID <uid>" header. The "Embedded Item Identifiers" sub-lists ("    #1: <id>") carry
 * text after the colon, so they never start a record, and their keys are not read.
 */
export function parseBtmDump(text: string, uids: number[]): BackgroundItem[] {
  const items: BackgroundItem[] = [];
  let uid: number | null = null;
  let fields: Map<string, string> | null = null;

  const flush = () => {
    if (fields && uid !== null && uids.includes(uid)) {
      const value = (key: string) => {
        const v = fields!.get(key);
        return v === undefined || v === "" || v === "(null)" ? null : v;
      };
      items.push({
        uid,
        name: value("Name") ?? "",
        developerName: value("Developer Name"),
        type: (value("Type") ?? "").replace(/\s*\(0x[0-9a-f]+\)$/i, ""),
        disposition: (value("Disposition")?.match(/\[(.*?)\]/)?.[1] ?? "").split(",").map((d) => d.trim()).filter(Boolean),
        identifier: value("Identifier"),
        url: value("URL"),
        executablePath: value("Executable Path"),
        parentIdentifier: value("Parent Identifier"),
        teamIdentifier: value("Team Identifier"),
      });
    }
    fields = null;
  };

  for (const line of text.split("\n")) {
    const header = line.match(/^\s*Records for UID (-?\d+)\b/);
    if (header) {
      flush();
      uid = parseInt(header[1], 10);
    } else if (/^ #\d+:\s*$/.test(line)) {
      flush();
      fields = new Map();
    } else if (fields) {
      const field = line.match(/^\s+([A-Za-z][A-Za-z. ]*?):\s?(.*)$/);
      if (field && !fields.has(field[1])) fields.set(field[1], field[2].trim());
    }
  }
  flush();
  return items;
}

/** Items of the current user, of root and of "all users" (uid -2). */
type BackgroundItemsResult = { items: BackgroundItem[]; error: string | null };
const BTM_TTL_MS = 120_000;
let btmCache: { at: number; result: BackgroundItemsResult } | null = null;
let btmInFlight: Promise<BackgroundItemsResult> | null = null;

/**
 * `sfltool dumpbtm` usually answers in 5 s, but needs half a minute on a busy Mac and gets slower
 * when several copies run at once. One run at a time, and a good answer is kept for two minutes.
 */
export function getBackgroundItems(): Promise<BackgroundItemsResult> {
  if (btmCache && Date.now() - btmCache.at < BTM_TTL_MS) return Promise.resolve(btmCache.result);
  btmInFlight ??= (async () => {
    try {
      const run = await capture(["sfltool", "dumpbtm"], 60_000);
      if (run.code !== 0) return { items: [], error: run.stderr || "Could not read the background items." };
      const result = { items: parseBtmDump(run.stdout, [process.getuid?.() ?? 501, 0, -2]), error: null };
      btmCache = { at: Date.now(), result };
      return result;
    } finally {
      btmInFlight = null;
    }
  })();
  return btmInFlight;
}

export const RESET_BTM_STEPS: PrivilegedStep[] = [{ cmd: ["/usr/bin/sfltool", "resetbtm"] }];
export const RESET_BTM_PROMPT = "mac-dash wants to reset the background-item approval of every app.";

/** Resets the approval of EVERY app, and macOS asks for a restart. The client asks the user twice. */
export async function resetBackgroundItems(): Promise<Result> {
  try {
    await runPrivileged(RESET_BTM_STEPS, RESET_BTM_PROMPT);
    btmCache = null;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Names of the user's Shortcuts, for the "Shortcut" run kind (/usr/bin/shortcuts run <name>). */
export async function listShortcuts(): Promise<string[]> {
  const result = await capture(["shortcuts", "list"]);
  return result.code === 0 ? result.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort() : [];
}
