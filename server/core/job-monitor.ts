import { watch, type FSWatcher } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { JOB_SCOPES, jobExecutable, type JobCategory } from "../../shared/launchd";
import { onJobFilesChanged, rescanJobs, type JobFileChange } from "./launchctl";

// Watches the launchd scope directories for the whole lifetime of the server, so that a job
// installed by any app is recorded even while no dashboard is open. See docs/backend-contract.md.

export interface JobEvent {
  id: string;
  at: number;
  kind: "added" | "modified" | "removed";
  label: string;
  category: JobCategory;
  path: string;
  program: string | null;
}

const STATE_DIR = join(homedir(), ".macdash");
const HISTORY_FILE = join(STATE_DIR, "job-events.json");
const MAX_EVENTS = 500;
const DEBOUNCE_MS = 400;
const FALLBACK_POLL_MS = 30_000;

let events: JobEvent[] = [];
const listeners = new Set<(event: JobEvent) => void>();
let watchers: FSWatcher[] = [];
let pollTimer: Timer | null = null;
let debounceTimer: Timer | null = null;
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

async function record(changes: JobFileChange[]): Promise<void> {
  // The desktop app appends to the same file. Re-read it so its events are kept.
  await loadHistory();
  const now = Date.now();
  const fresh = changes.map(
    ({ kind, file }): JobEvent => ({
      id: `${now}-${sequence++}`,
      at: now,
      kind,
      label: file.label,
      category: file.category,
      path: file.path,
      program: file.job ? jobExecutable(file.job) : null,
    })
  );
  events = [...events, ...fresh].slice(-MAX_EVENTS);
  await saveHistory();
  for (const event of fresh) for (const listener of listeners) listener(event);
}

function scheduleScan(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void rescanJobs().catch(() => {}), DEBOUNCE_MS);
}

export async function startJobMonitor(): Promise<void> {
  await loadHistory();
  await rescanJobs(); // baseline: jobs that already exist are not events
  onJobFilesChanged((changes) => void record(changes));

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
}

export function stopJobMonitor(): void {
  for (const watcher of watchers) watcher.close();
  watchers = [];
  if (pollTimer) clearInterval(pollTimer);
  if (debounceTimer) clearTimeout(debounceTimer);
  pollTimer = debounceTimer = null;
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

/** Native notification, for the case where nobody has the dashboard open. */
export function notifyNatively(event: JobEvent): void {
  const verb = { added: "added", modified: "changed", removed: "removed" }[event.kind];
  Bun.spawn(
    [
      "osascript",
      "-e", "on run argv",
      "-e", "display notification (item 2 of argv) with title (item 1 of argv) subtitle (item 3 of argv)",
      "-e", "end run",
      `launchd job ${verb}`,
      event.program ?? event.path,
      event.label,
    ],
    { stdout: "ignore", stderr: "ignore" }
  );
}
