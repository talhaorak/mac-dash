import { watch, type FSWatcher } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { JOB_SCOPES, jobExecutable, type JobCategory } from "../../shared/launchd";
import { JobError, listServices, onJobFilesChanged, rescanJobs, type JobFileChange, type ServiceInfo } from "./launchctl";

// Watches the launchd scope directories for the whole lifetime of the server, so that a job
// installed by any app is recorded even while no dashboard is open. See docs/backend-contract.md.

export interface JobEvent {
  id: string;
  at: number;
  kind: "added" | "modified" | "removed" | "failed";
  label: string;
  category: JobCategory;
  path: string;
  program: string | null;
  /** Only for "failed". */
  exitStatus?: number;
}

export interface MonitorSettings {
  notify: boolean;
  exclude: string[];
}

const STATE_DIR = join(homedir(), ".macdash");
const HISTORY_FILE = join(STATE_DIR, "job-events.json");
const SETTINGS_FILE = join(STATE_DIR, "settings.json");
const MAX_EVENTS = 500;
const DEBOUNCE_MS = 400;
const FALLBACK_POLL_MS = 30_000;
const EXIT_POLL_MS = 30_000;
const MAX_EXCLUDES = 50;
const MAX_EXCLUDE_LENGTH = 100;

let events: JobEvent[] = [];
const listeners = new Set<(event: JobEvent) => void>();
let watchers: FSWatcher[] = [];
let pollTimer: Timer | null = null;
let debounceTimer: Timer | null = null;
let exitTimer: Timer | null = null;
let exitStatuses: ExitStatuses | null = null;
let exitPollRunning = false;
let appendChain: Promise<void> = Promise.resolve();
let sequence = 0;

async function loadHistory(): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_FILE, "utf8"));
    events = Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    events = [];
  }
}

async function saveHistory(): Promise<void> {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(HISTORY_FILE, JSON.stringify(events), { mode: 0o600 });
  } catch (e) {
    console.error("  [monitor] Could not save the job history:", e);
  }
}

type NewJobEvent = Omit<JobEvent, "id" | "at">;

/** File changes and failures arrive independently. Appends run one after the other so none is lost. */
function append(fresh: NewJobEvent[]): Promise<void> {
  const result = appendChain.then(async () => {
    // The desktop app appends to the same file. Re-read it so its events are kept.
    await loadHistory();
    const now = Date.now();
    const stamped = fresh.map((event): JobEvent => ({ id: `${now}-${sequence++}`, at: now, ...event }));
    events = [...events, ...stamped].slice(-MAX_EVENTS);
    await saveHistory();
    for (const event of stamped) for (const listener of listeners) listener(event);
  });
  appendChain = result.catch(() => {});
  return result;
}

function record(changes: JobFileChange[]): Promise<void> {
  return append(
    changes.map(({ kind, file }) => ({
      kind,
      label: file.label,
      category: file.category,
      path: file.path,
      program: file.job ? jobExecutable(file.job) : null,
    }))
  );
}

// ── Failed jobs ──────────────────────────────────────────────────────

/** Last exit status per "<category>/<label>". null: never exited, or not loaded. */
export type ExitStatuses = Map<string, number | null>;

type ExitFacts = Pick<ServiceInfo, "label" | "category" | "plistPath" | "writable" | "loaded" | "lastExitStatus">;

/**
 * Jobs with a plist in a writable scope whose last exit status changed to a value other than 0.
 * The first pass (previous = null) is the baseline. A job that appears later starts at "never exited",
 * so a job that fails right after it was installed is reported.
 */
export function findNewFailures<T extends ExitFacts>(previous: ExitStatuses | null, services: T[]): { next: ExitStatuses; failed: T[] } {
  const next: ExitStatuses = new Map();
  const failed: T[] = [];
  for (const service of services) {
    if (!service.writable || !service.plistPath) continue;
    const key = `${service.category}/${service.label}`;
    const status = service.loaded ? service.lastExitStatus : null;
    next.set(key, status);
    // -15 is SIGTERM: somebody stopped the job on purpose (launchctl, this app, a logout).
    const isFailure = status !== null && status !== 0 && status !== -15;
    if (previous && isFailure && status !== (previous.get(key) ?? null)) failed.push(service);
  }
  return { next, failed };
}

/** Never throws and never overlaps: a slow launchctl must not pile up polls. */
async function pollExitStatuses(): Promise<void> {
  if (exitPollRunning) return;
  exitPollRunning = true;
  try {
    const { next, failed } = findNewFailures(exitStatuses, await listServices());
    exitStatuses = next;
    if (failed.length > 0) {
      await append(
        failed.map((s) => ({ kind: "failed", label: s.label, category: s.category, path: s.plistPath!, program: s.program, exitStatus: s.lastExitStatus! }))
      );
    }
  } catch (e) {
    console.error("  [monitor] Could not compare the exit statuses:", e);
  } finally {
    exitPollRunning = false;
  }
}

function scheduleScan(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void rescanJobs().catch(() => {}), DEBOUNCE_MS);
}

export async function startJobMonitor(): Promise<void> {
  await loadHistory();
  await rescanJobs(); // baseline: jobs that already exist are not events
  onJobFilesChanged((changes) => void record(changes).catch(() => {}));

  for (const scope of JOB_SCOPES) {
    try {
      const watcher = watch(scope.dir.replace(/^~/, homedir()), { persistent: false }, scheduleScan);
      watcher.on("error", () => {});
      watchers.push(watcher);
    } catch {
      // The directory does not exist yet. The fallback poll picks it up.
    }
  }
  pollTimer = setInterval(scheduleScan, FALLBACK_POLL_MS);

  void pollExitStatuses(); // baseline
  exitTimer = setInterval(() => void pollExitStatuses(), EXIT_POLL_MS);
}

export function stopJobMonitor(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  if (exitTimer) clearInterval(exitTimer);
  pollTimer = debounceTimer = exitTimer = null;
  exitStatuses = null; // the next start takes a new baseline
}

export function onJobEvent(listener: (event: JobEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Newest first. */
export async function getJobEvents(): Promise<JobEvent[]> {
  await loadHistory();
  return [...events].reverse();
}

export async function clearJobEvents(): Promise<void> {
  events = [];
  await saveHistory();
}

// ── Settings ─────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: MonitorSettings = { notify: true, exclude: [] };

/** Bring stored or submitted settings into the limits of the contract. Throws a JobError on a wrong type. */
export function normalizeMonitorSettings(input: unknown): MonitorSettings {
  const { notify, exclude } = (input ?? {}) as { notify?: unknown; exclude?: unknown };
  if (typeof notify !== "boolean") throw new JobError("notify must be a boolean.");
  if (!Array.isArray(exclude) || exclude.some((p) => typeof p !== "string")) throw new JobError("exclude must be an array of strings.");
  const prefixes = (exclude as string[]).map((p) => p.trim().slice(0, MAX_EXCLUDE_LENGTH)).filter(Boolean);
  return { notify, exclude: [...new Set(prefixes)].slice(0, MAX_EXCLUDES) };
}

export function shouldNotify(settings: MonitorSettings, label: string): boolean {
  return settings.notify && !settings.exclude.some((prefix) => label.startsWith(prefix));
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Read on every use: the desktop app writes the same file. */
export async function getMonitorSettings(): Promise<MonitorSettings> {
  const stored = await readSettingsFile();
  try {
    return normalizeMonitorSettings({ ...DEFAULT_SETTINGS, ...stored });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setMonitorSettings(input: unknown): Promise<MonitorSettings> {
  const settings = normalizeMonitorSettings(input);
  const stored = await readSettingsFile(); // keep keys that another version wrote
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify({ ...stored, ...settings }, null, 2), { mode: 0o600 });
  return settings;
}

// ── Native notification ──────────────────────────────────────────────

export function notificationText(event: JobEvent): { title: string; message: string; subtitle: string } {
  const verb = { added: "added", modified: "changed", removed: "removed", failed: "failed" }[event.kind];
  const target = event.program ?? event.path;
  return {
    title: `launchd job ${verb}`,
    message: event.kind === "failed" ? `Exit status ${event.exitStatus}: ${target}` : target,
    subtitle: event.label,
  };
}

/** Native notification, for the case where nobody has the dashboard open. Honours the monitor settings. */
export async function notifyNatively(event: JobEvent): Promise<void> {
  try {
    if (!shouldNotify(await getMonitorSettings(), event.label)) return;
    const { title, message, subtitle } = notificationText(event);
    Bun.spawn(
      [
        "osascript",
        "-e", "on run argv",
        "-e", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
        "-e", "end run",
        title,
        message,
        subtitle,
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
  } catch {
    // A notification is a courtesy. The event is already recorded.
  }
}
