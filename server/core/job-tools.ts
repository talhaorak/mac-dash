import { lstat, mkdir, readdir, readFile, stat } from "fs/promises";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { jobExecutable, type JobCategory } from "../../shared/launchd";
import { PlistData, PlistReal, type PlistValue } from "../../shared/plist";
import { JobError, errorMessage, findJobFile, indexedJobFiles, run, runPrivileged, type Result } from "./launchctl";

// Code signature of a job, script applets, the pmset power schedule, the folder browser, the default PATH
// and the plists as JSON. See docs/backend-contract.md ("Signature, background items, apps, power" and
// "Helper tools, reset, browse, PATH, plists"). The Tauri backend mirrors this file.

// ── Code signature ───────────────────────────────────────────────────

export interface JobSignature {
  path: string | null;
  signed: boolean;
  identifier: string | null;
  authorities: string[];
  teamId: string | null;
  /** Verified: the code is Apple's own (requirement "anchor apple"). */
  apple: boolean;
  /** Verified: signed with a certificate that Apple issued: Apple, Developer ID or App Store ("anchor apple generic"). */
  trusted: boolean;
  adhoc: boolean;
  error: string | null;
}

const UNSIGNED: Omit<JobSignature, "path"> = { signed: false, identifier: null, authorities: [], teamId: null, apple: false, trusted: false, adhoc: false, error: null };

/** Parse what `codesign -dv --verbose=2` writes to stderr. Display only: codesign -d does not verify the chain. */
export function parseCodesign(stderr: string, exitCode: number): Omit<JobSignature, "path"> {
  if (/code object is not signed at all/.test(stderr)) return { ...UNSIGNED };
  if (exitCode !== 0) {
    const lines = stderr.trim().split("\n");
    return { ...UNSIGNED, error: lines[lines.length - 1].replace(/^.*: /, "") || `codesign exited with code ${exitCode}` };
  }

  const field = (name: string) => stderr.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1].trim() ?? null;
  const authorities = [...stderr.matchAll(/^Authority=(.*)$/gm)].map((m) => m[1].trim());
  const team = field("TeamIdentifier");
  return {
    signed: true,
    identifier: field("Identifier"),
    authorities,
    teamId: team && team !== "not set" ? team : null,
    apple: false, // set by getJobSignature after a real verification
    trusted: false,
    adhoc: field("Signature") === "adhoc",
    error: null,
  };
}

/** The executable comes from the indexed plist, never from the client. */
export async function getJobSignature(label: string, category: JobCategory): Promise<JobSignature> {
  const failed = (path: string | null, error: string): JobSignature => ({ path, ...UNSIGNED, error });

  const file = await findJobFile(label, category);
  if (!file) return failed(null, "Job file not found.");
  const path = file.job ? jobExecutable(file.job) : null;
  if (!path) return failed(null, "The job has no executable.");
  if (!path.startsWith("/")) return failed(path, "The executable path is not absolute.");
  if (!(await stat(path).then((st) => st.isFile(), () => false))) return failed(path, "Executable not found");

  const result = await run(["codesign", "-dv", "--verbose=2", path], undefined, 15_000);
  const signature = parseCodesign(result.stderr, result.code);
  if (!signature.signed) return { path, ...signature };

  // `codesign -d` only displays names, and anyone can name a self-signed certificate "Software Signing".
  // The two flags are therefore the result of a real verification against Apple's root.
  const [appleAnchor, appleIssued] = await Promise.all([
    run(["codesign", "-v", "-R=anchor apple", path], undefined, 30_000),
    run(["codesign", "-v", "-R=anchor apple generic", path], undefined, 30_000),
  ]);
  return { path, ...signature, apple: appleAnchor.code === 0, trusted: appleIssued.code === 0 };
}

// ── Script applet ────────────────────────────────────────────────────

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
// U+2028 and U+2029 are line breaks for AppleScript too: inside a string literal they would end the line.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** An AppleScript string literal. Only backslash and double quote are special inside it. */
export function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Throws a JobError when the request breaks a rule of the contract. Touches nothing. */
export function checkScriptAppRequest(scriptPath: unknown, name: unknown): { scriptPath: string; name: string } {
  if (typeof name !== "string" || !APP_NAME.test(name)) {
    throw new JobError("The app name may contain letters, digits, spaces, dots, dashes and underscores (64 characters, starting with a letter or digit).");
  }
  if (typeof scriptPath !== "string" || !scriptPath.startsWith("/")) throw new JobError("The script path must be absolute.");
  if (CONTROL_CHARS.test(scriptPath)) throw new JobError("The script path contains control characters.");
  return { scriptPath, name };
}

/** Wrap a script in ~/Applications/<name>.app, so that macOS can grant the job privacy permissions. */
export async function buildScriptApp(scriptPath: unknown, name: unknown): Promise<Result<{ path: string }>> {
  try {
    const request = checkScriptAppRequest(scriptPath, name);
    const isFile = await stat(request.scriptPath).then((st) => st.isFile(), () => false);
    if (!isFile) throw new JobError("The script does not exist or is not a regular file.");

    const appsDir = join(homedir(), "Applications");
    const appPath = join(appsDir, `${request.name}.app`);
    await mkdir(appsDir, { recursive: true });
    // lstat: a dangling symlink also counts as "exists"
    if (await lstat(appPath).then(() => true, () => false)) throw new JobError(`${appPath} already exists.`);

    const source = `do shell script quoted form of ${appleScriptString(request.scriptPath)}`;
    const result = await run(["osacompile", "-o", appPath, "-e", source], undefined, 30_000);
    if (result.code !== 0) throw new JobError(result.stderr || "osacompile failed.");
    return { ok: true, path: appPath };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// ── Power schedule ───────────────────────────────────────────────────

export type PowerEventType = "sleep" | "wake" | "poweron" | "shutdown" | "wakeorpoweron" | "restart";

export interface PowerEvent {
  type: PowerEventType;
  days: string;
  time: string;
}

export interface PowerSchedule {
  raw: string;
  repeating: PowerEvent[];
}

const SLEEP_TYPES: PowerEventType[] = ["sleep", "shutdown", "restart"];
const WAKE_TYPES: PowerEventType[] = ["wake", "poweron", "wakeorpoweron"];
const DAY_LETTERS = "MTWRFSU";
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAYS_PATTERN = /^M?T?W?R?F?S?U?$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

/** "weekdays only" → "MTWRF", "Some days: Mon Wed" → "MW". Empty when the text names no day. */
function parsePmsetDays(text: string): string {
  const lower = text.trim().toLowerCase();
  if (lower === "every day") return DAY_LETTERS;
  if (lower === "weekdays only") return "MTWRF";
  if (lower === "weekends only") return "SU";

  const found = new Set<string>();
  for (const token of text.replace(/^\s*some days:/i, "").split(/[\s,]+/).filter(Boolean)) {
    const named = DAY_NAMES.indexOf(token.slice(0, 3).toLowerCase());
    if (named >= 0) found.add(DAY_LETTERS[named]);
    else if (/^[MTWRFSU]+$/.test(token)) for (const letter of token) found.add(letter); // some versions print "MW"
  }
  return [...DAY_LETTERS].filter((letter) => found.has(letter)).join("");
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The "Repeating power events" block of `pmset -g sched`. One-time events are not part of the schedule. */
export function parsePmsetSched(text: string): PowerEvent[] {
  const events: PowerEvent[] = [];
  let inBlock = false;
  for (const line of text.split("\n")) {
    if (/^Repeating power events:/i.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (/^\S/.test(line)) break; // next block, e.g. "Scheduled power events:"

    const m = line.match(/^\s+(\w+) at (\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?\s+(.+)$/i);
    if (!m) continue;
    const printed = m[1].toLowerCase();
    const type = (printed === "wakepoweron" ? "wakeorpoweron" : printed) as PowerEventType;
    if (!SLEEP_TYPES.includes(type) && !WAKE_TYPES.includes(type)) continue;

    const meridiem = m[5]?.toUpperCase();
    let hour = parseInt(m[2], 10);
    if (meridiem) hour = (hour % 12) + (meridiem === "PM" ? 12 : 0);
    const time = `${pad(hour)}:${m[3]}:${m[4] ?? "00"}`;
    const days = parsePmsetDays(m[6]);
    if (days && TIME_PATTERN.test(time)) events.push({ type, days, time });
  }
  return events;
}

export async function getPowerSchedule(): Promise<PowerSchedule> {
  const result = await run(["pmset", "-g", "sched"], undefined, 10_000);
  return { raw: result.stdout, repeating: result.code === 0 ? parsePmsetSched(result.stdout) : [] };
}

/** argv for `pmset repeat`. Every value is checked here, before anything is near a shell. */
export function pmsetRepeatArgs(events: unknown): string[] {
  if (!Array.isArray(events)) throw new JobError("events must be an array.");
  if (events.length > 2) throw new JobError("pmset repeat takes at most two events.");

  const args = ["/usr/bin/pmset", "repeat"];
  const used = { sleep: false, wake: false };
  for (const event of events) {
    const { type, days, time } = (event ?? {}) as Partial<Record<keyof PowerEvent, unknown>>;
    const group = SLEEP_TYPES.includes(type as PowerEventType) ? "sleep" : WAKE_TYPES.includes(type as PowerEventType) ? "wake" : null;
    if (typeof type !== "string" || !group) throw new JobError(`Unknown power event type: ${String(type).slice(0, 40)}`);
    if (typeof days !== "string" || !days || !DAYS_PATTERN.test(days)) throw new JobError('days must be a subset of "MTWRFSU", in that order.');
    if (typeof time !== "string" || !TIME_PATTERN.test(time)) throw new JobError("time must look like HH:MM:SS.");
    if (used[group]) {
      throw new JobError(group === "sleep" ? "Only one of sleep, shutdown and restart can repeat." : "Only one of wake, poweron and wakeorpoweron can repeat.");
    }
    used[group] = true;
    args.push(type, days, time);
  }
  return events.length === 0 ? [...args, "cancel"] : args;
}

/** One administrator prompt. An empty list cancels the repeating schedule. */
export async function setPowerSchedule(events: unknown): Promise<Result> {
  try {
    await runPrivileged([{ cmd: pmsetRepeatArgs(events) }], "mac-dash wants to change the power schedule.");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// ── Folder browser ───────────────────────────────────────────────────

export interface BrowseEntry {
  name: string;
  isDirectory: boolean;
  isApp: boolean;
  executable: boolean;
  hidden: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
}

const MAX_BROWSE_ENTRIES = 1000;

/** Empty means the home folder. `..` is resolved here, so the client always gets a canonical path back. */
export function checkBrowsePath(path: unknown): string {
  if (path === undefined || path === null || path === "") return homedir();
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) throw new JobError("The path must be absolute.");
  return resolve(path);
}

/** Directories first, then by name without case. Plain code-unit order, so that both backends agree. */
export function sortBrowseEntries<T extends { name: string; isDirectory: boolean }>(entries: T[]): T[] {
  const key = (e: T) => e.name.toLowerCase();
  return [...entries].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.name < b.name ? -1 : 1));
}

/** Names and flags only, for path pickers. Never reads a file. */
export async function browsePath(path: unknown): Promise<BrowseResult> {
  const dir = checkBrowsePath(path);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new JobError("Cannot read this folder.");
  }

  // Only a symlink needs a stat to know whether it leads to a folder.
  const typed = await Promise.all(
    dirents.map(async (d) => ({
      name: d.name,
      isDirectory: d.isSymbolicLink() ? await stat(join(dir, d.name)).then((st) => st.isDirectory(), () => false) : d.isDirectory(),
    }))
  );
  const kept = sortBrowseEntries(typed).slice(0, MAX_BROWSE_ENTRIES);
  const entries = await Promise.all(
    kept.map(async ({ name, isDirectory }): Promise<BrowseEntry> => ({
      name,
      isDirectory,
      isApp: isDirectory && name.endsWith(".app"),
      executable: !isDirectory && (await stat(join(dir, name)).then((st) => st.isFile() && (st.mode & 0o111) !== 0, () => false)),
      hidden: name.startsWith("."),
    }))
  );
  return { path: dir, parent: dir === "/" ? null : dirname(dir), entries, truncated: typed.length > kept.length };
}

// ── Default PATH ─────────────────────────────────────────────────────

const EXTRA_PATH_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/local/sbin"];

/** `pathsFile` is the text of /etc/paths, `pathsDFiles` the texts of the files in /etc/paths.d, sorted by file name. */
export function buildDefaultPath(pathsFile: string, pathsDFiles: string[]): string {
  const lines = [pathsFile, ...pathsDFiles].flatMap((text) => text.split("\n")).map((line) => line.trim());
  return [...new Set([...lines, ...EXTRA_PATH_DIRS].filter(Boolean))].join(":");
}

/** The PATH a login shell starts with. launchd itself gives a job only /usr/bin:/bin:/usr/sbin:/sbin. */
export async function getDefaultPath(): Promise<string> {
  const read = (path: string) => readFile(path, "utf8").catch(() => "");
  const names = await readdir("/etc/paths.d").then((n) => n.sort(), () => [] as string[]);
  return buildDefaultPath(await read("/etc/paths"), await Promise.all(names.map((name) => read(join("/etc/paths.d", name)))));
}

// ── Plists as JSON ───────────────────────────────────────────────────

/** date → ISO string, data → base64 string, real → number. Everything else is JSON already. */
export function plistToJson(value: PlistValue): unknown {
  if (value instanceof PlistReal) return value.value;
  if (value instanceof PlistData) return value.base64;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plistToJson);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plistToJson(v)]));
  return value;
}

/** Every readable indexed job under "<category>/<label>", for smart-folder rules over launchd keys. */
export async function getJobPlists(): Promise<Record<string, unknown>> {
  const plists: Record<string, unknown> = {};
  for (const file of await indexedJobFiles()) {
    if (file.job) plists[`${file.category}/${file.label}`] = plistToJson(file.job);
  }
  return plists;
}
