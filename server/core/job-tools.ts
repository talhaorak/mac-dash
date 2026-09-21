import { lstat, mkdir, stat } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { jobExecutable, type JobCategory } from "../../shared/launchd";
import { JobError, errorMessage, findJobFile, run, runPrivileged, type Result } from "./launchctl";

// Code signature of a job, script applets and the pmset power schedule.
// See docs/backend-contract.md ("Signature, background items, apps, power"). The Tauri backend mirrors this file.

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
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

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
