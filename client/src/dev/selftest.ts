/**
 * End-to-end self-test of the backend adapter (client/src/lib/backend.ts) against the active backend.
 *
 * Loaded by main.tsx ONLY in a development build and ONLY with `?selftest=1` in the URL.
 * It is a dynamic import behind `import.meta.env.DEV`, so production bundles do not contain it.
 *
 * Safety rules of this file:
 * - Every mutation goes through `testJob()`, which only returns the one job this run created:
 *   label `com.macdash.selftest-<timestamp>`, scope `user-agents`. No other job is touched.
 * - No administrator prompt can appear: the user scope never needs root.
 * - The `finally` block deletes the test job when it still exists.
 *
 * Shapes are checked against docs/backend-contract.md.
 */

import { backend, metaKey, type JobEvent, type JobRef } from "@/lib/backend";
import { parsePlistDict, serializePlist } from "@shared/plist";

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface SelfTestReport {
  ok: boolean;
  backend: "tauri" | "http";
  steps: StepResult[];
  failures: string[];
}

// ── Shape assertions ─────────────────────────────────────────────────

/** "string", "number", "boolean", "string[]", "array", "object". A trailing "?" also allows null. */
type Kind = string;
type Shape = Record<string, Kind>;

const KIND_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  "string[]": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  array: (v) => Array.isArray(v),
  object: (v) => isObject(v),
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchesKind(v: unknown, kind: Kind): boolean {
  if (kind.endsWith("?")) return v === null || matchesKind(v, kind.slice(0, -1));
  return KIND_CHECKS[kind]?.(v) ?? false;
}

function show(v: unknown): string {
  if (v === undefined) return "undefined";
  const text = JSON.stringify(v) ?? String(v);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function shapeProblems(value: unknown, shape: Shape, where: string): string[] {
  if (!isObject(value)) return [`${where}: expected an object, got ${show(value)}`];
  return Object.entries(shape)
    .filter(([key, kind]) => !matchesKind(value[key], kind))
    .map(([key, kind]) => `${where}.${key}: expected ${kind}, got ${show(value[key])}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectShape(value: unknown, shape: Shape, where: string): asserts value is Record<string, unknown> {
  const problems = shapeProblems(value, shape, where);
  check(problems.length === 0, problems.slice(0, 6).join("; ") + (problems.length > 6 ? `; and ${problems.length - 6} more` : ""));
}

function expectEach(list: unknown, shape: Shape, where: string): asserts list is Record<string, unknown>[] {
  check(Array.isArray(list), `${where}: expected an array, got ${show(list)}`);
  const problems = list.flatMap((item, i) => shapeProblems(item, shape, `${where}[${i}]`));
  check(problems.length === 0, problems.slice(0, 6).join("; ") + (problems.length > 6 ? `; and ${problems.length - 6} more` : ""));
}

const CATEGORIES = ["user-agents", "global-agents", "global-daemons", "system-agents", "system-daemons"];

const SERVICE_INFO: Shape = {
  label: "string",
  pid: "number?",
  lastExitStatus: "number?",
  status: "string",
  category: "string",
  plistPath: "string?",
  program: "string?",
  programArguments: "string[]?",
  runAtLoad: "boolean?",
  enabled: "boolean",
  loaded: "boolean",
  disabled: "boolean",
  triggers: "string[]",
  writable: "boolean",
  needsAdmin: "boolean",
  userName: "string?",
  unreadable: "boolean",
  quarantined: "boolean",
  startInterval: "number?",
  calendar: "array",
};

const SERVICE_DETAIL: Shape = {
  path: "string?",
  type: "string?",
  bundleId: "string?",
  state: "string?",
  environment: "object",
  lastExitReason: "string?",
  domain: "string",
  raw: "string",
};

const JOB_DOCUMENT: Shape = {
  label: "string",
  category: "string",
  path: "string",
  fileName: "string",
  xml: "string",
  writable: "boolean",
  needsAdmin: "boolean",
  mtime: "number",
};

const JOB_OUTPUT: Shape = { path: "string?", exists: "boolean", size: "number", truncated: "boolean", text: "string" };

const JOB_EVENT: Shape = { id: "string", at: "number", kind: "string", label: "string", category: "string", path: "string", program: "string?" };

const JOB_SIGNATURE: Shape = {
  path: "string?",
  signed: "boolean",
  identifier: "string?",
  authorities: "string[]",
  teamId: "string?",
  apple: "boolean",
  trusted: "boolean",
  adhoc: "boolean",
  error: "string?",
};

const BACKGROUND_ITEM: Shape = {
  uid: "number",
  name: "string",
  developerName: "string?",
  type: "string",
  disposition: "string[]",
  identifier: "string?",
  url: "string?",
  executablePath: "string?",
  parentIdentifier: "string?",
  teamIdentifier: "string?",
};

// ── Helpers ──────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll until `probe` returns a value other than null. launchd and the file monitor are not instant. */
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number, everyMs = 400): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

// ── Overlay ──────────────────────────────────────────────────────────

function createOverlay(): (text: string) => void {
  const root = document.createElement("div");
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Self-test report");
  root.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#05070c;color:#d1d5db;padding:24px;" +
    "font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace";
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:0;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text";
  root.appendChild(pre);
  document.body.appendChild(root);
  return (text) => {
    pre.textContent = text;
  };
}

// ── The run ──────────────────────────────────────────────────────────

export async function runSelfTest(): Promise<SelfTestReport> {
  const isTauri = backend.isDesktop();
  const steps: StepResult[] = [];
  const render = createOverlay();
  const progress = (running: string) =>
    render(
      `mac-dash self-test (${isTauri ? "tauri" : "http"})\n\n` +
        steps.map((s) => `${s.ok ? "ok  " : "FAIL"}  ${s.name}${s.detail ? `  ${s.detail}` : ""}`).join("\n") +
        `\n…     ${running}`
    );

  /** One failure never stops the run. The returned string of `run` becomes the detail of a passed step. */
  const step = async (name: string, run: () => Promise<string | void>): Promise<boolean> => {
    progress(name);
    const started = performance.now();
    try {
      const detail = await run();
      steps.push({ name, ok: true, ms: Math.round(performance.now() - started), ...(detail ? { detail } : {}) });
      return true;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, ms: Math.round(performance.now() - started), detail });
      return false;
    }
  };

  // ── Read-only calls ────────────────────────────────────────────────

  await step("getSystemStats", async () => {
    const stats = await backend.getSystemStats();
    expectShape(stats, { cpu: "object", memory: "object", disk: "object", uptime: "string", hostname: "string", osVersion: "string", processCount: "number", threadCount: "number" }, "stats");
    expectShape(stats.cpu, { user: "number", sys: "number", idle: "number", model: "string", cores: "number", loadAvg: "array" }, "stats.cpu");
    expectShape(stats.memory, { total: "number", used: "number", free: "number", wired: "number", compressed: "number", usedPercent: "number" }, "stats.memory");
    expectShape(stats.disk, { total: "number", used: "number", free: "number", usedPercent: "number", mountPoint: "string" }, "stats.disk");
  });

  await step("getHardwareInfo", async () => {
    const info = await backend.getHardwareInfo();
    expectShape(info, { model: "string", cpu: "string", cores: "number", memory: "number", osVersion: "string", hostname: "string", serialNumber: "string?" }, "hardware");
  });

  let services: Record<string, unknown>[] = [];
  await step("getServices", async () => {
    const result = await backend.getServices();
    expectShape(result, { services: "array", count: "number" }, "result");
    expectEach(result.services, SERVICE_INFO, "services");
    services = result.services;
    check(services.length > 100, `expected more than 100 jobs, got ${services.length}`);
    check(result.count === services.length, `count is ${show(result.count)}, the list has ${services.length} items`);
    const badEnum = services.find((s) => !CATEGORIES.includes(s.category as string) || !["running", "stopped", "error", "unknown"].includes(s.status as string));
    check(!badEnum, `unknown category or status in ${show(badEnum)}`);
    const inconsistent = services.find((s) => s.enabled === s.disabled);
    check(!inconsistent, `enabled must be !disabled: ${show(inconsistent?.label)}`);
    return `${services.length} jobs`;
  });

  await step("getServiceDetail (loaded user agent)", async () => {
    const agent = services.find((s) => s.category === "user-agents" && s.loaded === true);
    check(agent, "no loaded job in user-agents to ask for");
    const detail = await backend.getServiceDetail({ label: agent.label, category: agent.category } as JobRef);
    expectShape(detail, SERVICE_DETAIL, "detail");
    check(/^gui\/\d+$/.test(detail.domain as string), `an agent's domain must be gui/<uid>, got ${show(detail.domain)}`);
    check((detail.raw as string).includes(agent.label as string), "raw does not contain the label");
    return String(agent.label);
  });

  let firstPid: number | null = null;
  await step("getProcesses", async () => {
    const result = await backend.getProcesses("cpu", 50);
    expectShape(result, { processes: "array", total: "number", filtered: "number" }, "result");
    expectEach(
      result.processes,
      { pid: "number", ppid: "number", uid: "number", user: "string", cpu: "number", mem: "number", rss: "number", elapsed: "string", command: "string", path: "string", args: "string" },
      "processes"
    );
    check(result.processes.length > 0 && result.processes.length <= 50, `limit 50 returned ${result.processes.length} processes`);
    firstPid = result.processes[0].pid as number;
    return `${show(result.total)} processes`;
  });

  await step("getProcessDetail (first pid)", async () => {
    check(firstPid !== null, "getProcesses returned no pid");
    const detail = await backend.getProcessDetail(firstPid);
    expectShape(detail, { cwd: "string?", parentChain: "array" }, "detail");
    expectEach(detail.parentChain, { pid: "number", ppid: "number", user: "string", command: "string" }, "parentChain");
    return `pid ${firstPid}`;
  });

  await step("getRecentLogs", async () => {
    const result = await backend.getRecentLogs(20);
    expectShape(result, { logs: "array", count: "number" }, "result");
    check(result.count === (result.logs as unknown[]).length, "count does not match the list");
  });

  await step("getStartupExtras", async () => {
    const extras = await backend.getStartupExtras();
    expectShape(extras, { cron: "string[]", helperTools: "array", startupItems: "array" }, "extras");
    expectEach(extras.helperTools, { name: "string", path: "string" }, "helperTools");
    expectEach(extras.startupItems, { name: "string", path: "string" }, "startupItems");
  });

  await step("listShortcuts", async () => {
    const shortcuts = await backend.listShortcuts();
    check(matchesKind(shortcuts, "string[]"), `expected string[], got ${show(shortcuts)}`);
    return `${shortcuts.length} shortcuts`;
  });

  await step("getJobMeta", async () => {
    const meta = await backend.getJobMeta();
    check(isObject(meta), `expected an object, got ${show(meta)}`);
    expectEach(Object.values(meta), { notes: "string", tags: "string[]" }, "meta");
  });

  await step("getJobEvents", async () => {
    const events = await backend.getJobEvents();
    expectEach(events, JOB_EVENT, "events");
    const bad = events.find((e) => !["added", "modified", "removed", "failed"].includes(e.kind as string));
    check(!bad, `unknown event kind: ${show(bad?.kind)}`);
    return `${events.length} events`;
  });

  await step("getMonitorSettings", async () => {
    expectShape(await backend.getMonitorSettings(), { notify: "boolean", exclude: "string[]" }, "settings");
  });

  await step("getBackgroundItems", async () => {
    const items = await backend.getBackgroundItems();
    expectEach(items, BACKGROUND_ITEM, "items");
    return `${items.length} items`;
  });

  await step("getPowerSchedule", async () => {
    const schedule = await backend.getPowerSchedule();
    expectShape(schedule, { raw: "string", repeating: "array" }, "schedule");
    expectEach(schedule.repeating, { type: "string", days: "string", time: "string" }, "repeating");
  });

  await step("getJobSignature (third-party job)", async () => {
    const thirdParty = services.find(
      (s) => ["user-agents", "global-agents", "global-daemons"].includes(s.category as string) && s.plistPath !== null && !(s.label as string).startsWith("com.apple.")
    );
    check(thirdParty, "no third-party job with a plist to ask for");
    const sig = await backend.getJobSignature({ label: thirdParty.label, category: thirdParty.category } as JobRef);
    expectShape(sig, JOB_SIGNATURE, "signature");
    check(!(sig.apple && !sig.trusted), "apple implies trusted");
    check(!(sig.adhoc && sig.trusted), "an ad-hoc signature cannot be trusted");
    return `${thirdParty.label}: signed=${show(sig.signed)} trusted=${show(sig.trusted)}`;
  });

  await step("checkPaths", async () => {
    const facts = await backend.checkPaths(["/bin/sh", "/nope"]);
    expectEach(facts, { path: "string", exists: "boolean", isFile: "boolean", isDirectory: "boolean", executable: "boolean" }, "facts");
    const sh = facts.find((f) => f.path === "/bin/sh");
    const nope = facts.find((f) => f.path === "/nope");
    check(facts.length === 2 && sh && nope, `expected facts for both paths, got ${show(facts)}`);
    check(sh.exists && sh.isFile && sh.executable && !sh.isDirectory, `/bin/sh: ${show(sh)}`);
    check(!nope.exists && !nope.isFile && !nope.isDirectory && !nope.executable, `/nope: ${show(nope)}`);
  });

  // ── Job lifecycle, user scope only ─────────────────────────────────

  const label = `com.macdash.selftest-${Date.now()}`;
  const ref: JobRef = { label, category: "user-agents" };
  /** The only job this file may change. The guard fails loudly if an edit of this file ever breaks that. */
  const testJob = (): JobRef => {
    if (!/^com\.macdash\.selftest-\d+$/.test(ref.label) || ref.category !== "user-agents") throw new Error("Self-test guard: refusing to touch a job that is not the test job");
    return { ...ref };
  };
  const plist = { Label: label, ProgramArguments: ["/usr/bin/true"] };
  const listed = async () => (await backend.getServices()).services.find((s) => s.label === label && s.category === "user-agents") ?? null;

  const arrivals: { event: JobEvent; at: number }[] = [];
  let unlisten: () => void = () => {};
  let created = false;
  let savedAt = 0;
  const needsJob = () => check(created, "skipped: the test job was not created");

  try {
    if (isTauri) {
      await step("onJobEvent (subscribe)", async () => {
        unlisten = await backend.onJobEvent((event) => arrivals.push({ event, at: Date.now() }));
      });
    }

    await step("saveJob (load: true)", async () => {
      const result = await backend.saveJob({ category: testJob().category, xml: serializePlist(plist), load: true });
      created = true;
      savedAt = Date.now();
      expectShape(result, { label: "string", path: "string" }, "result");
      check(result.label === label, `label is ${show(result.label)}`);
      check(result.path.endsWith(`/Library/LaunchAgents/${label}.plist`), `unexpected path ${show(result.path)}`);
    });

    await step("getServices shows the job, loaded", async () => {
      needsJob();
      const found = await waitFor(async () => {
        const s = await listed();
        return s && s.loaded ? s : null;
      }, 6000);
      check(found, "the job did not appear as loaded within 6 s");
      expectShape(found, SERVICE_INFO, "service");
      check(found.writable && !found.needsAdmin && !found.disabled && found.enabled, `unexpected flags: ${show(found)}`);
      check(found.program === "/usr/bin/true", `program is ${show(found.program)}`);
    });

    await step("readJob returns the XML", async () => {
      needsJob();
      const doc = await backend.readJob(testJob());
      expectShape(doc, JOB_DOCUMENT, "document");
      check(doc.label === label && doc.category === "user-agents" && doc.fileName === `${label}.plist`, `wrong document: ${show({ ...doc, xml: undefined })}`);
      check(doc.writable && !doc.needsAdmin, "the document must be writable without administrator rights");
      const parsed = parsePlistDict(doc.xml);
      check(parsed.Label === label, `Label in the XML is ${show(parsed.Label)}`);
      check(Array.isArray(parsed.ProgramArguments) && parsed.ProgramArguments[0] === "/usr/bin/true", "ProgramArguments did not survive");
    });

    await step("setJobMeta / getJobMeta round trip", async () => {
      needsJob();
      const meta = { notes: "written by the mac-dash self-test", tags: ["selftest", "temporary"] };
      await backend.setJobMeta(testJob(), meta);
      const stored = (await backend.getJobMeta())[metaKey(ref)];
      check(stored && stored.notes === meta.notes && JSON.stringify(stored.tags) === JSON.stringify(meta.tags), `stored meta is ${show(stored)}`);
    });

    await step("saveJob (save only) with StartInterval", async () => {
      needsJob();
      const result = await backend.saveJob({ category: testJob().category, xml: serializePlist({ ...plist, StartInterval: 3600 }), original: testJob(), load: false });
      check(result.label === label, `label is ${show(result.label)}`);
      const parsed = parsePlistDict((await backend.readJob(testJob())).xml);
      check(parsed.StartInterval === 3600, `StartInterval in the file is ${show(parsed.StartInterval)}`);
    });

    await step("listJobRevisions has the first version", async () => {
      needsJob();
      const revisions = await backend.listJobRevisions(label);
      expectEach(revisions, { id: "string", at: "number", size: "number" }, "revisions");
      check(revisions.length >= 1, "no revision after an overwrite");
      const xml = await backend.readJobRevision(revisions[0].id as string);
      check(typeof xml === "string" && xml.includes(label), "the revision does not contain the label");
      return `${revisions.length} revision(s)`;
    });

    await step("manageService start", async () => {
      needsJob();
      await backend.manageService(testJob(), "start");
    });

    await step("readJobOutput", async () => {
      needsJob();
      const output = await backend.readJobOutput(testJob(), "stdout", 50);
      expectShape(output, JOB_OUTPUT, "output");
      check(output.path === null && !output.exists, `the job has no StandardOutPath, got ${show(output)}`);
    });

    await step("manageService disable", async () => {
      needsJob();
      await backend.manageService(testJob(), "disable");
      const state = await waitFor(async () => {
        const s = await listed();
        return s && s.disabled && !s.loaded ? s : null;
      }, 6000);
      check(state, `the job is not disabled and unloaded: ${show(await listed())}`);
    });

    await step("start of a disabled job is refused", async () => {
      needsJob();
      let message: string | null = null;
      try {
        await backend.manageService(testJob(), "start");
      } catch (e) {
        message = (e as Error).message;
      }
      check(message !== null, "start succeeded on a disabled job");
      check(message.includes("The job is disabled. Enable it first."), `wrong error text: ${show(message)}`);
    });

    await step("manageService enable", async () => {
      needsJob();
      await backend.manageService(testJob(), "enable");
      const state = await waitFor(async () => {
        const s = await listed();
        return s && !s.disabled && s.loaded ? s : null;
      }, 6000);
      check(state, `the job is not enabled and loaded: ${show(await listed())}`);
    });

    if (isTauri) {
      await step("job-event 'added' arrived within 8 s", async () => {
        needsJob();
        const find = async () => arrivals.find((a) => a.event.label === label && a.event.kind === "added") ?? null;
        const hit = await waitFor(find, Math.max(0, savedAt + 8000 - Date.now()), 200);
        check(hit, `no "added" event for the job. Events seen: ${show(arrivals.map((a) => `${a.event.kind}:${a.event.label}`))}`);
        check(hit.at - savedAt <= 8000, `the event arrived ${hit.at - savedAt} ms after the save`);
        expectShape(hit.event, JOB_EVENT, "event");
        check(hit.event.category === "user-agents" && hit.event.path.endsWith(`${label}.plist`), `wrong event: ${show(hit.event)}`);
        return `${Math.max(0, hit.at - savedAt)} ms after the save`;
      });
    }

    await step("deleteJob", async () => {
      needsJob();
      await backend.deleteJob(testJob());
      const gone = await waitFor(async () => ((await listed()) === null ? true : null), 6000);
      check(gone, "the job is still in getServices after 6 s");
      created = false;
      check(!(metaKey(ref) in (await backend.getJobMeta())), "the notes and tags of the deleted job are still stored");
    });
  } finally {
    // Always leave the machine as it was, whatever failed above.
    await step("cleanup", async () => {
      unlisten();
      const notes: string[] = [];
      if (await listed().catch(() => null)) {
        await backend.deleteJob(testJob());
        notes.push("deleted the leftover test job");
      }
      const meta = await backend.getJobMeta().catch(() => ({}) as Record<string, unknown>);
      if (metaKey(ref) in meta) {
        await backend.setJobMeta(testJob(), { notes: "", tags: [] }); // empty notes and no tags delete the entry
        notes.push("removed the leftover notes");
      }
      return notes.join(", ") || undefined;
    });
  }

  // ── Report ─────────────────────────────────────────────────────────

  const failures = steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail ?? "failed"}`);
  const report: SelfTestReport = { ok: failures.length === 0, backend: isTauri ? "tauri" : "http", steps, failures };
  const json = JSON.stringify(report);
  render(`mac-dash self-test: ${report.ok ? "PASSED" : `FAILED (${failures.length})`}\n\n${JSON.stringify(report, null, 2)}`);
  console.log("SELFTEST_REPORT " + json);

  if (isTauri) {
    // Debug builds of the shell print the line and exit. Release builds have no such command.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("selftest_report", { report: json });
    } catch {
      // not a debug shell
    }
  }
  return report;
}
