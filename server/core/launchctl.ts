import { constants } from "fs";
import { access, copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { parsePlistDict, type PlistDict } from "../../shared/plist";
import {
  JOB_SCOPES,
  LABEL_PATTERN,
  calendarEntries,
  describeTriggers,
  jobExecutable,
  scopeFor,
  type JobCategory,
  type JobScope,
  type PathFacts,
} from "../../shared/launchd";

// See docs/backend-contract.md. The Tauri backend (services.rs) mirrors this file.

export interface ServiceInfo {
  label: string;
  pid: number | null;
  lastExitStatus: number | null;
  status: "running" | "stopped" | "error" | "unknown";
  category: JobCategory;
  plistPath: string | null;
  program: string | null;
  programArguments: string[] | null;
  runAtLoad: boolean | null;
  enabled: boolean;
  loaded: boolean;
  disabled: boolean;
  triggers: string[];
  writable: boolean;
  needsAdmin: boolean;
  userName: string | null;
  /** The plist exists but cannot be parsed. */
  unreadable: boolean;
  /** The plist carries com.apple.quarantine, so launchd may refuse to load it. Saving clears it. */
  quarantined: boolean;
  startInterval: number | null;
  /** StartCalendarInterval entries, for the timeline. */
  calendar: Record<string, number>[];
}

export interface ServiceDetail {
  path: string | null;
  type: string | null;
  bundleId: string | null;
  state: string | null;
  environment: Record<string, string>;
  lastExitReason: string | null;
  domain: string;
  raw: string;
}

export interface JobDocument {
  label: string;
  category: JobCategory;
  path: string;
  fileName: string;
  xml: string;
  writable: boolean;
  needsAdmin: boolean;
  mtime: number;
}

export interface SaveJobRequest {
  category: JobCategory;
  xml: string;
  original?: { label: string; category: JobCategory } | null;
  load?: boolean;
}

export interface JobOutput {
  path: string | null;
  exists: boolean;
  size: number;
  truncated: boolean;
  text: string;
}

export type ServiceAction = "start" | "stop" | "restart" | "load" | "unload" | "enable" | "disable";

export const SERVICE_ACTIONS: ServiceAction[] = ["start", "stop", "restart", "load", "unload", "enable", "disable"];

export interface JobFile {
  path: string;
  fileName: string;
  category: JobCategory;
  label: string;
  mtimeMs: number;
  size: number;
  job: PlistDict | null;
  quarantined: boolean;
}

export interface JobFileChange {
  kind: "added" | "modified" | "removed";
  file: JobFile;
}

export type Result<T = {}> = ({ ok: true } & T) | { ok: false; error: string };

export class JobError extends Error {}

const UID = process.getuid?.() ?? 501;
export const STATE_DIR = join(homedir(), ".macdash");
export const BACKUP_DIR = join(STATE_DIR, "backups");
const MAX_BACKUPS_PER_JOB = 20;
const MAX_OUTPUT_BYTES = 256 * 1024;

let testDirs: { scopes: Partial<Record<JobCategory, string>>; backups: string } | null = null;

/** A scope without a test directory does not exist for that test: real job folders are never read. */
const scopeDir = (scope: JobScope): string | null =>
  testDirs ? testDirs.scopes[scope.category] ?? null : scope.dir.replace(/^~/, homedir());
const backupDir = () => testDirs?.backups ?? BACKUP_DIR;
const domainFor = (category: JobCategory) => (scopeFor(category)?.kind === "daemon" ? "system" : `gui/${UID}`);
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── Process helpers ──────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `timeoutMs` kills a command that hangs (a tool waiting for a permission dialog, a dead volume). */
export async function run(cmd: string[], stdin?: string, timeoutMs?: number): Promise<ExecResult> {
  let timer: Timer | undefined;
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : new Blob([stdin]) });
    if (timeoutMs) timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr: stderr.trim() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: errorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** Labels come from plists that any app can drop into a job folder. These two keep them harmless. */
const isLaunchctlTarget = (label: string) => label !== "" && !label.includes("/") && !label.startsWith("-");
export const promptLabel = (label: string) => label.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, 80);

const shQuote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

export interface PrivilegedStep {
  cmd: string[];
  /** A failing tolerant step does not abort the script (e.g. bootout of a job that is not loaded). */
  tolerant?: boolean;
}

/** The shell text that `do shell script` receives: every argument single-quoted, steps joined with &&. */
export function buildPrivilegedScript(steps: PrivilegedStep[]): string {
  // `a && b || true && c` would swallow a failure of `a`: sh gives && and || the same precedence.
  // A tolerant step is therefore its own group.
  return steps
    .map((s) => {
      const cmd = s.cmd.map(shQuote).join(" ");
      return s.tolerant ? `{ ${cmd} || true; }` : cmd;
    })
    .join(" && ");
}

/** Run shell steps as root behind the macOS administrator prompt. One prompt per call. */
export async function runPrivileged(steps: PrivilegedStep[], prompt: string): Promise<void> {
  if (testDirs) throw new JobError("Privileged commands are switched off while the scope directories point at test folders.");
  const result = await run([
    "osascript",
    "-e", "on run argv",
    "-e", "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
    "-e", "end run",
    "--", // an argument that starts with "-e" would otherwise be compiled as script text
    buildPrivilegedScript(steps),
    prompt,
  ]);
  if (result.code !== 0) {
    if (result.stderr.includes("-128")) throw new JobError("Cancelled at the administrator prompt.");
    throw new JobError(result.stderr.replace(/^.*execution error: /, "") || "Privileged command failed.");
  }
}

// ── Job file index ───────────────────────────────────────────────────
// Parsed plists are cached by (mtime, size). rescanJobs() is cheap: one readdir and
// one stat per file, and it only re-parses files that changed.

let index = new Map<string, JobFile>();
let indexLoaded = false;
let indexReady: Promise<void> | null = null;
let scanChain: Promise<unknown> = Promise.resolve();
let changeListener: ((changes: JobFileChange[]) => void) | null = null;

/**
 * TESTS ONLY. Point the scopes and the backup folder at temporary directories (null restores the real ones)
 * and forget the index. While this is set, no launchctl command runs: bootout and bootstrap are skipped.
 */
export function __setScopeDirsForTests(dirs: { scopes: Partial<Record<JobCategory, string>>; backups: string } | null): void {
  testDirs = dirs;
  index = new Map();
  indexLoaded = false;
  indexReady = null;
}

/** Called after every scan that found differences, whoever triggered it. The first scan is the baseline. */
export function onJobFilesChanged(listener: (changes: JobFileChange[]) => void): void {
  changeListener = listener;
}

const isJobFileName = (name: string) => name.endsWith(".plist") || name.endsWith(".plist.disabled");

/** The first scan converts several hundred binary plists: cap the number of plutil processes. */
const plutilSlots = {
  free: 16,
  waiting: [] as (() => void)[],
  async use<T>(task: () => Promise<T>): Promise<T> {
    if (this.free === 0) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.free--;
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    }
  },
};

async function readPlistXml(path: string): Promise<string | null> {
  try {
    const bytes = await readFile(path);
    if (bytes.subarray(0, 6).toString("latin1") !== "bplist") return bytes.toString("utf8");
  } catch {
    return null;
  }
  const converted = await plutilSlots.use(() => run(["plutil", "-convert", "xml1", "-o", "-", path]));
  return converted.code === 0 ? converted.stdout : null;
}

async function parseJobFile(path: string): Promise<PlistDict | null> {
  const xml = await readPlistXml(path);
  if (!xml) return null;
  try {
    return parsePlistDict(xml);
  } catch {
    return null;
  }
}

/**
 * launchd knows one job per label and domain. When two files of one scope declare the same Label
 * (macOS ships com.apple.sysdiagnose.plist and com.apple.sysdiagnose.darwinos.plist), the file named
 * <Label>.plist keeps the label and the others are listed under their file name. Every job stays
 * visible and (category, label) stays a unique key.
 */
export function resolveLabelCollisions(files: Map<string, JobFile>, changes: JobFileChange[] = []): void {
  const byKey = new Map<string, JobFile[]>();
  for (const file of files.values()) {
    const key = `${file.category}/${file.label}`;
    byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const owner = group.find((f) => f.fileName === `${f.label}.plist`) ?? group.sort((a, b) => a.fileName.localeCompare(b.fileName))[0];
    for (const file of group) {
      if (file === owner) continue;
      // A cached entry is shared with the previous index: replace it instead of mutating it.
      const renamed = { ...file, label: file.fileName.replace(/\.plist(\.disabled)?$/, "") };
      files.set(file.path, renamed);
      const change = changes.find((c) => c.file === file);
      if (change) change.file = renamed;
    }
  }
}

/** Downloaded or AirDropped plists keep com.apple.quarantine. One xattr call covers all changed files. */
async function markQuarantined(files: JobFile[]): Promise<void> {
  if (files.length === 0) return;
  // With two or more paths xattr prefixes every hit with "<path>: ". /dev/null guarantees that form.
  const result = await run(["xattr", "-p", "com.apple.quarantine", "/dev/null", ...files.map((f) => f.path)]);
  for (const file of files) file.quarantined = result.stdout.includes(`${file.path}: `);
}

/** Re-read the scope directories and report what changed since the previous scan. Scans never overlap. */
export function rescanJobs(): Promise<JobFileChange[]> {
  const result = scanChain.then(scanJobFiles);
  scanChain = result.catch(() => {});
  return result;
}

async function scanJobFiles(): Promise<JobFileChange[]> {
  const next = new Map<string, JobFile>();
  const changes: JobFileChange[] = [];

  await Promise.all(
    JOB_SCOPES.map(async (scope) => {
      const dir = scopeDir(scope);
      if (dir === null) return;
      let names: string[];
      try {
        names = (await readdir(dir)).filter(isJobFileName);
      } catch {
        return; // missing or unreadable directory
      }
      await Promise.all(
        names.map(async (fileName) => {
          const path = join(dir, fileName);
          let st;
          try {
            st = await stat(path);
          } catch {
            return;
          }
          if (!st.isFile()) return;

          const prev = index.get(path);
          if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
            next.set(path, prev);
            return;
          }
          const job = await parseJobFile(path);
          const label =
            typeof job?.Label === "string" && job.Label
              ? job.Label
              : fileName.replace(/\.plist(\.disabled)?$/, "");
          const file: JobFile = { path, fileName, category: scope.category, label, mtimeMs: st.mtimeMs, size: st.size, job, quarantined: false };
          next.set(path, file);
          changes.push({ kind: prev ? "modified" : "added", file });
        })
      );
    })
  );

  resolveLabelCollisions(next, changes);
  await markQuarantined(changes.filter((c) => scopeFor(c.file.category)!.writable).map((c) => c.file));

  for (const [path, file] of index) {
    if (!next.has(path)) changes.push({ kind: "removed", file });
  }
  index = next;
  if (indexLoaded && changes.length > 0) changeListener?.(changes);
  indexLoaded = true;
  return changes;
}

function ensureIndex(): Promise<void> {
  indexReady ??= rescanJobs().then(() => undefined);
  return indexReady;
}

/** Every indexed job file, for callers that read all plists at once. */
export async function indexedJobFiles(): Promise<JobFile[]> {
  await ensureIndex();
  return [...index.values()];
}

export async function findJobFile(label: string, category: JobCategory): Promise<JobFile | null> {
  await ensureIndex();
  for (const file of index.values()) {
    if (file.label === label && file.category === category) return file;
  }
  return null;
}

// ── launchd state ────────────────────────────────────────────────────

interface DomainState {
  services: Map<string, { pid: number | null; status: number | null }>;
  disabled: Map<string, boolean>;
}

/** launchctl answers in milliseconds. A hung call must not freeze the dashboard or the monitor. */
const LAUNCHCTL_TIMEOUT_MS = 15_000;
const lastDomainState = new Map<string, DomainState>();

async function readDomain(domain: string): Promise<DomainState> {
  const [printed, overrides] = await Promise.all([
    run(["launchctl", "print", domain], undefined, LAUNCHCTL_TIMEOUT_MS),
    run(["launchctl", "print-disabled", domain], undefined, LAUNCHCTL_TIMEOUT_MS),
  ]);
  // Timed out or failed: show the last known state instead of "nothing is loaded".
  if (printed.code !== 0 && lastDomainState.has(domain)) return lastDomainState.get(domain)!;

  const services: DomainState["services"] = new Map();
  let inServices = false;
  for (const line of printed.stdout.split("\n")) {
    if (!inServices) {
      if (/^\tservices = \{$/.test(line)) inServices = true;
      continue;
    }
    if (/^\t\}$/.test(line)) break;
    const m = line.match(/^\s*(\d+)\s+(-|-?\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    services.set(m[3].trim(), { pid: pid > 0 ? pid : null, status: m[2] === "-" ? null : parseInt(m[2], 10) });
  }

  const disabled: DomainState["disabled"] = new Map();
  for (const line of overrides.stdout.split("\n")) {
    // macOS 13+: "label" => disabled|enabled. Older: "label" => true|false (true = disabled).
    const m = line.match(/^\s*"(.+)" => (disabled|enabled|true|false)$/);
    if (m) disabled.set(m[1], m[2] === "disabled" || m[2] === "true");
  }
  const state = { services, disabled };
  if (printed.code === 0) lastDomainState.set(domain, state);
  return state;
}

function statusOf(state: { pid: number | null; status: number | null } | undefined): ServiceInfo["status"] {
  if (!state) return "stopped";
  if (state.pid !== null) return "running";
  return state.status !== null && state.status !== 0 ? "error" : "stopped";
}

/** Merge job files with the live state of the gui and system launchd domains. */
export async function listServices(): Promise<ServiceInfo[]> {
  const guiDomain = `gui/${UID}`;
  const [gui, system] = await Promise.all([readDomain(guiDomain), readDomain("system"), ensureIndex()]);
  const stateFor = (domain: string) => (domain === "system" ? system : gui);

  const services: ServiceInfo[] = [];
  const seen = { [guiDomain]: new Set<string>(), system: new Set<string>() };

  for (const file of index.values()) {
    const scope = scopeFor(file.category)!;
    const domain = domainFor(file.category);
    const domainState = stateFor(domain);
    const state = domainState.services.get(file.label);
    seen[domain].add(file.label);

    const job = file.job ?? {};
    const args = Array.isArray(job.ProgramArguments)
      ? job.ProgramArguments.filter((a): a is string => typeof a === "string")
      : null;
    const disabled =
      domainState.disabled.get(file.label) ?? (file.fileName.endsWith(".disabled") || job.Disabled === true);

    services.push({
      label: file.label,
      pid: state?.pid ?? null,
      lastExitStatus: state?.status ?? null,
      status: statusOf(state),
      category: file.category,
      plistPath: file.path,
      program: jobExecutable(job),
      programArguments: args,
      runAtLoad: typeof job.RunAtLoad === "boolean" ? job.RunAtLoad : null,
      enabled: !disabled,
      loaded: !!state,
      disabled,
      triggers: describeTriggers(job),
      writable: scope.writable,
      needsAdmin: scope.needsAdmin,
      userName: typeof job.UserName === "string" ? job.UserName : null,
      unreadable: file.job === null,
      quarantined: file.quarantined,
      startInterval: typeof job.StartInterval === "number" ? job.StartInterval : null,
      calendar: calendarEntries(job.StartCalendarInterval).map((entry) =>
        Object.fromEntries(Object.entries(entry).filter((kv): kv is [string, number] => typeof kv[1] === "number"))
      ),
    });
  }

  // Services launchd knows about that have no file in the scope directories
  // (XPC services, app-registered SMAppService jobs, running app instances).
  for (const [domain, domainState] of [[guiDomain, gui], ["system", system]] as const) {
    for (const [label, state] of domainState.services) {
      if (seen[domain].has(label)) continue;
      const category: JobCategory =
        domain === "system"
          ? "system-daemons"
          : label.startsWith("com.apple.") || label.startsWith("application.")
            ? "system-agents"
            : "user-agents";
      const disabled = domainState.disabled.get(label) ?? false;
      services.push({
        label,
        pid: state.pid,
        lastExitStatus: state.status,
        status: statusOf(state),
        category,
        plistPath: null,
        program: null,
        programArguments: null,
        runAtLoad: null,
        enabled: !disabled,
        loaded: true,
        disabled,
        triggers: [],
        writable: false,
        needsAdmin: domain === "system",
        userName: null,
        unreadable: false,
        quarantined: false,
        startInterval: null,
        calendar: [],
      });
    }
  }

  return services.sort((a, b) => a.label.localeCompare(b.label));
}

export async function getServiceDetail(label: string, category: JobCategory): Promise<ServiceDetail | null> {
  const domain = domainFor(category);
  const printed = await run(["launchctl", "print", `${domain}/${label}`], undefined, LAUNCHCTL_TIMEOUT_MS);
  if (printed.code !== 0 || !printed.stdout) return null;

  const detail: ServiceDetail = {
    path: null,
    type: null,
    bundleId: null,
    state: null,
    environment: {},
    lastExitReason: null,
    domain,
    raw: printed.stdout,
  };
  const fields: [string, "path" | "type" | "bundleId" | "state" | "lastExitReason"][] = [
    ["path = ", "path"],
    ["type = ", "type"],
    ["bundle id = ", "bundleId"],
    ["state = ", "state"],
    ["last exit reason = ", "lastExitReason"],
  ];
  for (const line of printed.stdout.split("\n")) {
    const trimmed = line.trim();
    for (const [prefix, field] of fields) {
      if (detail[field] === null && trimmed.startsWith(prefix)) detail[field] = trimmed.slice(prefix.length);
    }
  }
  const env = printed.stdout.match(/\benvironment = \{([^}]*)\}/);
  if (env) {
    for (const line of env[1].split("\n")) {
      const m = line.trim().match(/^(\S+)\s*=>\s*(.*)$/);
      if (m) detail.environment[m[1]] = m[2];
    }
  }
  return detail;
}

// ── Actions ──────────────────────────────────────────────────────────

async function isLoaded(domain: string, label: string): Promise<boolean> {
  return (await run(["launchctl", "print", `${domain}/${label}`], undefined, LAUNCHCTL_TIMEOUT_MS)).code === 0;
}

/** Steps for one action. Tolerant steps may fail without failing the action. */
async function actionSteps(action: ServiceAction, label: string, domain: string, file: JobFile | null): Promise<PrivilegedStep[]> {
  const target = `${domain}/${label}`;
  const bootstrap = (path: string): PrivilegedStep => ({ cmd: ["launchctl", "bootstrap", domain, path] });
  const loaded = await isLoaded(domain, label);

  switch (action) {
    case "start":
      return [...(!loaded && file ? [bootstrap(file.path)] : []), { cmd: ["launchctl", "kickstart", target] }];
    case "restart":
      return [...(!loaded && file ? [bootstrap(file.path)] : []), { cmd: ["launchctl", "kickstart", "-k", target] }];
    case "stop":
      return [{ cmd: ["launchctl", "kill", "SIGTERM", target] }];
    case "load":
      if (!file) throw new JobError("This service has no plist file to load.");
      if (loaded) throw new JobError("The job is already loaded.");
      return [bootstrap(file.path)];
    case "unload":
      return [{ cmd: ["launchctl", "bootout", target] }];
    case "enable":
      return [{ cmd: ["launchctl", "enable", target] }, ...(!loaded && file ? [bootstrap(file.path)] : [])];
    case "disable":
      return [...(loaded ? [{ cmd: ["launchctl", "bootout", target], tolerant: true }] : []), { cmd: ["launchctl", "disable", target] }];
  }
}

function explainLaunchctlError(result: ExecResult): string {
  const text = result.stderr || result.stdout.trim();
  if (/Operation not permitted|Not privileged/i.test(text)) return "Not permitted. macOS protects this service (SIP) or it needs administrator rights.";
  if (/Could not find service/i.test(text)) return "launchd does not know this service. Load it first.";
  if (/Input\/output error|: 5\b/.test(text)) return "launchd rejected the job (error 5). Check that it is not already loaded, not disabled, and that the plist is valid.";
  return text || `launchctl exited with code ${result.code}`;
}

export async function manageService(label: string, category: JobCategory, action: ServiceAction): Promise<Result> {
  try {
    if (!SERVICE_ACTIONS.includes(action)) throw new JobError(`Unknown action: ${action}`);
    if (!scopeFor(category)) throw new JobError(`Unknown category: ${category}`);
    if (!label || label.includes("/") || label.startsWith("-")) throw new JobError("Invalid label.");

    const domain = domainFor(category);
    let file = await findJobFile(label, category);

    // A job switched off by renaming its file needs the original name back before it can load.
    if (action === "enable" && file?.fileName.endsWith(".disabled")) {
      const restored = file.path.replace(/\.disabled$/, "");
      if (scopeFor(category)!.needsAdmin) {
        await runPrivileged([{ cmd: ["/bin/mv", file.path, restored] }], `mac-dash wants to enable "${promptLabel(label)}".`);
      } else {
        await rename(file.path, restored);
      }
      await rescanJobs();
      file = await findJobFile(label, category);
    }

    if (action === "start" || action === "restart" || action === "load") {
      const loaded = await isLoaded(domain, label);
      if (!loaded && (await readDomain(domain)).disabled.get(label)) {
        throw new JobError("The job is disabled. Enable it first.");
      }
    }
    const steps = await actionSteps(action, label, domain, file);
    if (domain === "system") {
      await runPrivileged(steps, `mac-dash wants to ${action} the daemon "${promptLabel(label)}".`);
    } else {
      for (const step of steps) {
        const result = await run(step.cmd, undefined, 2 * LAUNCHCTL_TIMEOUT_MS);
        if (result.code !== 0 && !step.tolerant) throw new JobError(explainLaunchctlError(result));
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

// ── Job documents ────────────────────────────────────────────────────

export async function readJob(label: string, category: JobCategory): Promise<JobDocument | null> {
  const file = await findJobFile(label, category);
  if (!file) return null;
  const xml = await readPlistXml(file.path);
  if (xml === null) return null;
  const scope = scopeFor(category)!;
  return {
    label: file.label,
    category,
    path: file.path,
    fileName: file.fileName,
    xml,
    writable: scope.writable,
    needsAdmin: scope.needsAdmin,
    mtime: file.mtimeMs,
  };
}

const REVISION_NAME = /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.plist$/;

/** A Label read from a plist is untrusted text. Reduce it to one safe path component. */
export function safeFileName(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "_";
}

/** Label part of a backup file name, or null when the name is not a revision. */
export function revisionLabel(fileName: string): string | null {
  return fileName.match(REVISION_NAME)?.[1] ?? null;
}

/** Every overwrite and delete keeps a copy in ~/.macdash/backups. Returns false when the copy failed. */
async function backupJobFile(file: JobFile): Promise<boolean> {
  try {
    const dir = backupDir();
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const name = safeFileName(file.label);
    await copyFile(file.path, join(dir, `${name}-${stamp}.plist`));
    const mine = (await readdir(dir)).filter((n) => revisionLabel(n) === name).sort();
    for (const old of mine.slice(0, -MAX_BACKUPS_PER_JOB)) await unlink(join(dir, old)).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function trashPath(fileName: string): Promise<string> {
  const trash = join(homedir(), ".Trash");
  const candidate = join(trash, fileName);
  try {
    await access(candidate);
    const extension = /\.plist(\.disabled)?$/.test(fileName) ? ".plist" : "";
    return join(trash, `${fileName.replace(/\.plist(\.disabled)?$/, "")} ${Date.now()}${extension}`);
  } catch {
    return candidate;
  }
}

/**
 * Root never writes into a folder the user controls (~/.Trash could be swapped for a symlink while the
 * administrator prompt is open). For a root-owned job the app copies the world-readable file to the
 * Trash itself, and the root script only removes the original.
 */
async function copyToTrash(file: JobFile, hasBackup: boolean): Promise<string | null> {
  const dest = await trashPath(file.fileName);
  try {
    await copyFile(file.path, dest, constants.COPYFILE_EXCL);
    return dest;
  } catch {
    if (!hasBackup) throw new JobError("Could not copy the file to the Trash and could not back it up. Nothing was deleted.");
    return null;
  }
}

/** Run the root script. When it fails or is cancelled the original is still in place, so drop the Trash copy. */
export async function runPrivilegedAfterTrashCopy(steps: PrivilegedStep[], prompt: string, trashCopy: string | null): Promise<void> {
  try {
    await runPrivileged(steps, prompt);
  } catch (e) {
    if (trashCopy) await unlink(trashCopy).catch(() => {});
    throw e;
  }
}

async function moveToTrash(file: JobFile, hasBackup: boolean): Promise<void> {
  const dest = await trashPath(file.fileName);
  try {
    await rename(file.path, dest);
    return;
  } catch {
    // Different volume, or macOS privacy protection (TCC) denies access to ~/.Trash.
  }
  try {
    await copyFile(file.path, dest);
  } catch {
    if (!hasBackup) throw new JobError("Could not move the file to the Trash and could not back it up. Nothing was deleted.");
  }
  await unlink(file.path);
}

/** launchctl for the user's own domain. A no-op while the scope directories point at test folders. */
const launchctlUnlessTesting = (args: string[]): Promise<ExecResult> =>
  testDirs ? Promise.resolve({ code: 0, stdout: "", stderr: "" }) : run(["launchctl", ...args]);

/** A privileged save passes the plist inside the root script, so the size (in bytes, not characters) is bound by ARG_MAX. */
export const MAX_PRIVILEGED_XML = 200 * 1024;

export async function saveJob(req: SaveJobRequest): Promise<Result<{ label: string; path: string }>> {
  try {
    const scope = scopeFor(req.category);
    if (!scope?.writable) throw new JobError("This scope is read-only.");
    if (typeof req.xml !== "string" || req.xml.length > 1024 * 1024) throw new JobError("Invalid plist document.");

    const job = parsePlistDict(req.xml);
    const label = job.Label;
    if (typeof label !== "string" || !LABEL_PATTERN.test(label)) {
      throw new JobError("Label is missing or contains characters other than letters, digits, dots, dashes and underscores.");
    }

    const original = req.original ? await findJobFile(req.original.label, req.original.category) : null;
    if (req.original && !original) throw new JobError("The job being edited no longer exists on disk.");
    if (original && !scopeFor(original.category)!.writable) throw new JobError("The original job is read-only. Duplicate it instead.");

    const dir = scopeDir(scope);
    if (dir === null) throw new JobError("This scope is not available.");
    const dest = join(dir, `${label}.plist`);
    const existing = await findJobFile(label, req.category);
    if (existing && existing.path !== original?.path) throw new JobError(`A job with the label "${label}" already exists in ${scope.title}.`);

    // Lint from memory. The checked text never sits in a file that another process could swap
    // while the administrator prompt is open.
    const lint = await run(["plutil", "-lint", "-"], req.xml);
    if (lint.code !== 0) throw new JobError(`plutil rejected the plist: ${lint.stdout.trim() || lint.stderr}`);

    const hasBackup = original ? await backupJobFile(original) : false;

    const domain = domainFor(req.category);
    const load = req.load !== false && job.Disabled !== true;
    const moved = original !== null && original.path !== dest;
    // "Save only" leaves a running job alone. A rename or a move must unload the old identity.
    const bootoutOriginal = original !== null && (moved || load);
    const originalDomain = original ? domainFor(original.category) : domain;
    const originalNeedsAdmin = original ? scopeFor(original.category)!.needsAdmin : false;
    const staging = `${dest}.macdash-new`; // not "*.plist": the monitor ignores it
    const originalTarget = original && isLaunchctlTarget(original.label) ? `${originalDomain}/${original.label}` : null;
    const prompt = `mac-dash wants to save the job "${promptLabel(label)}" to ${scope.title}.`;

    if (scope.needsAdmin) {
      // Target in /Library: root writes it. Root only touches root-owned folders.
      const xmlBytes = Buffer.from(req.xml, "utf8");
      if (xmlBytes.length > MAX_PRIVILEGED_XML) throw new JobError("The plist is too large for a privileged save (200 KB).");
      const trashCopy = moved && originalNeedsAdmin ? await copyToTrash(original!, hasBackup) : null;
      const steps: PrivilegedStep[] = [];
      if (bootoutOriginal && originalTarget) steps.push({ cmd: ["launchctl", "bootout", originalTarget], tolerant: true });
      // root decodes the text it was handed: $0 is the base64 plist, $1 the staging file
      steps.push({ cmd: ["/bin/sh", "-c", 'printf %s "$0" | /usr/bin/base64 -D > "$1"', xmlBytes.toString("base64"), staging] });
      steps.push({ cmd: ["/usr/sbin/chown", "root:wheel", staging] });
      steps.push({ cmd: ["/bin/chmod", "644", staging] });
      steps.push({ cmd: ["/bin/mv", "-f", staging, dest] });
      if (moved && originalNeedsAdmin) steps.push({ cmd: ["/bin/rm", "-f", original!.path] });
      steps.push({ cmd: ["/usr/bin/xattr", "-d", "com.apple.quarantine", dest], tolerant: true });
      if (load) steps.push({ cmd: ["launchctl", "bootstrap", domain, dest], tolerant: true });
      await runPrivilegedAfterTrashCopy(steps, prompt, trashCopy);
      if (moved && !originalNeedsAdmin) await moveToTrash(original!, hasBackup);
      if (load && !(await isLoaded(domain, label))) {
        await rescanJobs();
        return { ok: false, error: "Saved, but launchd did not load the job: check that it is not disabled and that the plist is valid." };
      }
    } else {
      // Target in the user's own folder: the app writes it. Root never writes where the user can plant a symlink.
      if (bootoutOriginal && originalTarget && originalDomain !== "system") await launchctlUnlessTesting(["bootout", originalTarget]);
      await mkdir(dir, { recursive: true });
      // Write next to the target, then rename: atomic, and a symlink at the target is replaced, not followed.
      await writeFile(staging, req.xml, { mode: 0o644, flag: "wx" }).catch(async () => {
        await unlink(staging);
        await writeFile(staging, req.xml, { mode: 0o644, flag: "wx" });
      });
      await rename(staging, dest);
      await run(["xattr", "-d", "com.apple.quarantine", dest]);
      if (moved && originalNeedsAdmin) {
        // The job left /Library: root unloads it and removes the original. The Trash copy is ours.
        const trashCopy = await copyToTrash(original!, hasBackup);
        const steps: PrivilegedStep[] = [];
        if (originalTarget) steps.push({ cmd: ["launchctl", "bootout", originalTarget], tolerant: true });
        steps.push({ cmd: ["/bin/rm", "-f", original!.path] });
        await runPrivilegedAfterTrashCopy(steps, `mac-dash wants to move the job "${promptLabel(original!.label)}" out of ${scopeFor(original!.category)!.title}.`, trashCopy);
      } else if (moved) {
        await moveToTrash(original!, hasBackup);
      }
      if (load) {
        const result = await launchctlUnlessTesting(["bootstrap", domain, dest]);
        if (result.code !== 0) {
          await rescanJobs();
          return { ok: false, error: `Saved, but launchd did not load the job: ${explainLaunchctlError(result)}` };
        }
      }
    }

    await rescanJobs();
    return { ok: true, label, path: dest };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

export async function deleteJob(label: string, category: JobCategory): Promise<Result> {
  try {
    const scope = scopeFor(category);
    if (!scope?.writable) throw new JobError("This scope is read-only.");
    const file = await findJobFile(label, category);
    if (!file) throw new JobError("Job file not found.");

    const hasBackup = await backupJobFile(file);
    const target = isLaunchctlTarget(file.label) ? `${domainFor(category)}/${file.label}` : null;
    if (scope.needsAdmin) {
      const trashCopy = await copyToTrash(file, hasBackup);
      const steps: PrivilegedStep[] = [];
      if (target) steps.push({ cmd: ["launchctl", "bootout", target], tolerant: true });
      steps.push({ cmd: ["/bin/rm", "-f", file.path] });
      await runPrivilegedAfterTrashCopy(steps, `mac-dash wants to move the job "${promptLabel(file.label)}" to the Trash.`, trashCopy);
    } else {
      if (target) await launchctlUnlessTesting(["bootout", target]);
      await moveToTrash(file, hasBackup);
    }
    await rescanJobs();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Tail of the job's StandardOutPath or StandardErrorPath. The path always comes from the plist. */
export async function readJobOutput(label: string, category: JobCategory, stream: "stdout" | "stderr", lines = 200): Promise<JobOutput> {
  const file = await findJobFile(label, category);
  const value = file?.job?.[stream === "stderr" ? "StandardErrorPath" : "StandardOutPath"];
  const path = typeof value === "string" && value ? value : null;
  const empty: JobOutput = { path, exists: false, size: 0, truncated: false, text: "" };
  if (!path) return empty;

  let handle;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_OUTPUT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const all = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
    if (size > length && all.length > 1) all.shift(); // the first line is cut in the middle
    const count = Math.max(1, Math.min(lines, 5000));
    const tail = all.slice(-count);
    return { path, exists: true, size, truncated: size > length || all.length > tail.length, text: tail.join("\n") };
  } catch {
    return empty;
  } finally {
    await handle?.close();
  }
}

export async function checkPaths(paths: string[]): Promise<PathFacts[]> {
  const unique = [...new Set(paths.filter((p) => typeof p === "string" && p.startsWith("/")))].slice(0, 64);
  return Promise.all(
    unique.map(async (path) => {
      try {
        const st = await stat(path);
        const executable = await access(path, constants.X_OK).then(() => true, () => false);
        return { path, exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), executable };
      } catch {
        return { path, exists: false, isFile: false, isDirectory: false, executable: false };
      }
    })
  );
}

export async function revealJob(label: string, category: JobCategory): Promise<Result> {
  const file = await findJobFile(label, category);
  if (!file) return { ok: false, error: "Job file not found." };
  const result = await run(["open", "-R", file.path]);
  return result.code === 0 ? { ok: true } : { ok: false, error: result.stderr || "Could not open Finder." };
}
