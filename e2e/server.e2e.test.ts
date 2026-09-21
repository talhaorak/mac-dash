/**
 * End-to-end test of the Bun server over HTTP and WebSocket, checked against docs/backend-contract.md.
 * It mirrors client/src/dev/selftest.ts, which drives the same lifecycle through the client adapter.
 *
 * Runs ONLY with MACDASH_E2E=1 (`bun run test:e2e`), so that a plain `bun test` has no side effects.
 *
 * Safety rules of this file:
 * - It starts its own server on a free loopback port. A running mac-dash is not touched.
 * - Every mutation goes through `testJob()`, which only returns the one job this run created:
 *   label `com.macdash.e2e-<timestamp>`, scope `user-agents`. No administrator prompt can appear.
 * - `afterAll` deletes the job, its notes and its backups, whatever failed before.
 * - It never calls an endpoint that opens a macOS dialog (login items, reset, helper tools, power schedule).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { readdir, unlink } from "fs/promises";
import { connect } from "net";
import { homedir } from "os";
import { join, resolve } from "path";
import { parsePlistDict, serializePlist } from "../shared/plist";

const ENABLED = process.env.MACDASH_E2E === "1";
const e2e = ENABLED ? test : test.skip;

const ROOT = resolve(import.meta.dir, "..");
const HAS_CLIENT_BUILD = existsSync(join(ROOT, "dist", "client", "index.html"));
const SLOW = 60_000; // the first job scan converts several hundred binary plists

// ── Shape assertions (same notation as the self-test) ────────────────

/** "string", "number", "boolean", "string[]", "array", "object". A trailing "?" also allows null. */
type Shape = Record<string, string>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const KIND_CHECKS: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  "string[]": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  array: (v) => Array.isArray(v),
  object: isObject,
};

function matchesKind(v: unknown, kind: string): boolean {
  if (kind.endsWith("?")) return v === null || matchesKind(v, kind.slice(0, -1));
  return KIND_CHECKS[kind]?.(v) ?? false;
}

function shapeProblems(value: unknown, shape: Shape, where: string): string[] {
  if (!isObject(value)) return [`${where}: expected an object, got ${JSON.stringify(value)}`];
  return Object.entries(shape)
    .filter(([key, kind]) => !matchesKind(value[key], kind))
    .map(([key, kind]) => `${where}.${key}: expected ${kind}, got ${JSON.stringify(value[key])}`);
}

function expectShape(value: unknown, shape: Shape, where: string): asserts value is Record<string, any> {
  expect(shapeProblems(value, shape, where)).toEqual([]);
}

function expectEach(list: unknown, shape: Shape, where: string): asserts list is Record<string, any>[] {
  expect(Array.isArray(list)).toBe(true);
  const problems = (list as unknown[]).flatMap((item, i) => shapeProblems(item, shape, `${where}[${i}]`));
  expect(problems.slice(0, 6)).toEqual([]);
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
const SERVICE_DETAIL: Shape = { path: "string?", type: "string?", bundleId: "string?", state: "string?", environment: "object", lastExitReason: "string?", domain: "string", raw: "string" };
const JOB_DOCUMENT: Shape = { label: "string", category: "string", path: "string", fileName: "string", xml: "string", writable: "boolean", needsAdmin: "boolean", mtime: "number" };
const JOB_OUTPUT: Shape = { path: "string?", exists: "boolean", size: "number", truncated: "boolean", text: "string" };
const JOB_EVENT: Shape = { id: "string", at: "number", kind: "string", label: "string", category: "string", path: "string", program: "string?" };
const JOB_SIGNATURE: Shape = { path: "string?", signed: "boolean", identifier: "string?", authorities: "string[]", teamId: "string?", apple: "boolean", trusted: "boolean", adhoc: "boolean", error: "string?" };
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
const BROWSE_ENTRY: Shape = { name: "string", isDirectory: "boolean", isApp: "boolean", executable: "boolean", hidden: "boolean" };
const ERROR_BODY: Shape = { ok: "boolean", error: "string" };

// ── The server under test ────────────────────────────────────────────

let port = 0;
let base = "";
let server: ReturnType<typeof Bun.spawn> | null = null;
let serverLog = "";

interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

/** A browser sends Origin with every non-GET request. So does this client. */
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<ApiResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(method === "GET" ? {} : { Origin: base }), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: a static file
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

async function get(path: string): Promise<any> {
  const res = await api("GET", path);
  expect({ path, status: res.status }).toEqual({ path, status: 200 });
  return res.body;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Poll until `probe` returns a value other than null. launchd and the file monitor are not instant. */
async function waitFor<T>(probe: () => Promise<T | null> | T | null, timeoutMs: number, everyMs = 300): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

/** fetch() does not send a forged Host header. A raw socket does. Returns the status code. */
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let head = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("timeout")));
    socket.on("data", (chunk) => (head += chunk.toString("latin1")));
    socket.on("error", fail);
    socket.on("close", () => done(parseInt(head.match(/^HTTP\/1\.1 (\d{3})/)?.[1] ?? "0", 10)));
  });
}

// ── The one job this file may change ─────────────────────────────────

const label = `com.macdash.e2e-${Date.now()}`;
const category = "user-agents";
const metaKey = `${category}/${label}`;
const plist = { Label: label, ProgramArguments: ["/usr/bin/true"] };
const jobFile = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);

/** The guard fails loudly if an edit of this file ever points a mutation at another job. */
function testJob(): { label: string; category: string } {
  if (!/^com\.macdash\.e2e-\d+$/.test(label)) throw new Error("E2E guard: refusing to touch a job that is not the test job");
  return { label, category };
}
const jobQuery = () => new URLSearchParams(testJob()).toString();
const listed = async () => ((await get("/api/services")).services as any[]).find((s) => s.label === label && s.category === category) ?? null;

let savedAt = 0;
const wsMessages: { at: number; message: any }[] = [];
let ws: WebSocket | null = null;

beforeAll(async () => {
  if (!ENABLED) return;
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  port = probe.port ?? 0;
  await probe.stop(true);
  base = `http://127.0.0.1:${port}`;

  server = Bun.spawn([process.execPath, "server/index.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), MACDASH_ALLOWED_HOSTS: "", MACDASH_ALLOWED_ORIGINS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const stream of [server.stdout, server.stderr]) {
    void (async () => {
      for await (const chunk of stream as ReadableStream<Uint8Array>) serverLog += Buffer.from(chunk).toString("utf8");
    })();
  }

  const up = await waitFor(() => fetch(`${base}/api/health`).then((r) => (r.ok ? true : null), () => null), 60_000, 200);
  if (!up) throw new Error(`The server did not answer /api/health within 60 s.\n${serverLog}`);
}, 90_000);

afterAll(async () => {
  if (!ENABLED) return;
  ws?.close();
  try {
    if (await listed().catch(() => null)) await api("DELETE", `/api/services/job?${jobQuery()}`);
    const meta = (await api("GET", "/api/services/meta").catch(() => null))?.body?.meta ?? {};
    if (metaKey in meta) await api("PUT", "/api/services/meta", { ...testJob(), notes: "", tags: [] });
  } finally {
    // The server is gone or refused: remove the test job by hand. The path is built from the guarded label.
    if (existsSync(jobFile)) {
      await Bun.spawn(["launchctl", "bootout", `gui/${process.getuid?.()}/${testJob().label}`], { stdout: "ignore", stderr: "ignore" }).exited;
      await unlink(jobFile).catch(() => {});
    }
    const backups = join(homedir(), ".macdash", "backups");
    for (const name of await readdir(backups).catch(() => [] as string[])) {
      if (name.startsWith(`${testJob().label}-`)) await unlink(join(backups, name)).catch(() => {});
    }
    server?.kill("SIGTERM");
    await server?.exited;
  }
}, SLOW);

// ── Read-only endpoints ──────────────────────────────────────────────

describe("GET endpoints answer with the contract shape", () => {
  e2e("health and auth status (loopback needs no token)", async () => {
    expectShape(await get("/api/health"), { status: "string", uptime: "number", timestamp: "number" }, "health");
    expect(await get("/api/auth/status")).toEqual({ required: false, ok: true });
  });

  (HAS_CLIENT_BUILD && ENABLED ? test : test.skip)("production mode serves the built client", async () => {
    const res = await api("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(String(res.body)).toContain("<div id=\"root\"");
    expect((await api("GET", "/services/some/deep/link")).status).toBe(200); // single-page fallback
    expect((await api("GET", "/api/no/such/endpoint")).status).toBe(404); // never the page where a client expects JSON
  });

  e2e("system", async () => {
    const stats = await get("/api/system/stats");
    expectShape(stats, { cpu: "object", memory: "object", disk: "object", uptime: "string", hostname: "string", osVersion: "string", processCount: "number", threadCount: "number" }, "stats");
    expectShape(stats.cpu, { user: "number", sys: "number", idle: "number", model: "string", cores: "number", loadAvg: "array" }, "stats.cpu");
    expectShape(stats.memory, { total: "number", used: "number", free: "number", wired: "number", compressed: "number", usedPercent: "number" }, "stats.memory");
    expectShape(stats.disk, { total: "number", used: "number", free: "number", usedPercent: "number", mountPoint: "string" }, "stats.disk");
    expectShape(await get("/api/system/hardware"), { model: "string", cpu: "string", cores: "number", memory: "number", osVersion: "string", hostname: "string", serialNumber: "string?" }, "hardware");
    expectShape(await get("/api/system/version"), { version: "string" }, "version");
  }, SLOW);

  e2e("processes", async () => {
    const result = await get("/api/processes?sort=cpu&limit=50");
    expectShape(result, { processes: "array", total: "number", filtered: "number" }, "result");
    expectEach(result.processes, { pid: "number", ppid: "number", uid: "number", user: "string", cpu: "number", mem: "number", rss: "number", elapsed: "string", command: "string", path: "string", args: "string" }, "processes");
    expect(result.processes.length).toBeGreaterThan(0);
    expect(result.processes.length).toBeLessThanOrEqual(50);

    const detail = await get(`/api/processes/${process.pid}`);
    expectShape(detail, { cwd: "string?", parentChain: "array" }, "detail");
    expectEach(detail.parentChain, { pid: "number", ppid: "number", user: "string", command: "string" }, "parentChain");
    expectShape(await get(`/api/processes/${process.pid}/chain`), { chain: "array" }, "chain");
    expectShape(await get(`/api/processes/${process.pid}/cwd`), { cwd: "string?" }, "cwd");
    expectShape((await api("GET", "/api/processes/not-a-pid")).body, ERROR_BODY, "error");
  }, SLOW);

  e2e("logs and plugins", async () => {
    const logs = await get("/api/logs/recent?count=20");
    expectShape(logs, { logs: "array", count: "number" }, "logs");
    expect(logs.count).toBe(logs.logs.length);
    const plugins = await get("/api/plugins");
    expectEach(plugins.plugins, { id: "string", name: "string", version: "string", enabled: "boolean", hasClient: "boolean" }, "plugins");
  }, SLOW);

  e2e("services list", async () => {
    const result = await get("/api/services");
    expectShape(result, { services: "array", count: "number" }, "result");
    expectEach(result.services, SERVICE_INFO, "services");
    expect(result.services.length).toBeGreaterThan(100);
    expect(result.count).toBe(result.services.length);
    expect(result.services.filter((s: any) => !CATEGORIES.includes(s.category) || !["running", "stopped", "error", "unknown"].includes(s.status))).toEqual([]);
    expect(result.services.filter((s: any) => s.enabled === s.disabled)).toEqual([]);
    const keys = result.services.map((s: any) => `${s.category}/${s.label}`);
    expect(new Set(keys).size).toBe(keys.length); // (category, label) is a unique key
  }, SLOW);

  e2e("notes, extras, shortcuts, events, monitor settings, power schedule", async () => {
    const { meta } = await get("/api/services/meta");
    expect(isObject(meta)).toBe(true);
    expectEach(Object.values(meta), { notes: "string", tags: "string[]" }, "meta");

    const extras = await get("/api/services/extras");
    expectShape(extras, { cron: "string[]", helperTools: "array", startupItems: "array" }, "extras");
    expectEach(extras.helperTools, { name: "string", path: "string" }, "helperTools");
    expectEach(extras.startupItems, { name: "string", path: "string" }, "startupItems");

    expectShape(await get("/api/services/shortcuts"), { shortcuts: "string[]" }, "shortcuts");

    const { events } = await get("/api/services/events");
    expectEach(events, JOB_EVENT, "events");
    expect(events.filter((e: any) => !["added", "modified", "removed", "failed"].includes(e.kind))).toEqual([]);

    expectShape(await get("/api/services/monitor-settings"), { notify: "boolean", exclude: "string[]" }, "settings");

    const schedule = await get("/api/services/power-schedule");
    expectShape(schedule, { raw: "string", repeating: "array" }, "schedule");
    expectEach(schedule.repeating, { type: "string", days: "string", time: "string" }, "repeating");
  }, SLOW);

  e2e("background items (a machine where sfltool fails answers 400 with the same list key)", async () => {
    const res = await api("GET", "/api/services/background-items");
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) expectShape(res.body, ERROR_BODY, "error");
    expectEach(res.body.items, BACKGROUND_ITEM, "items");
  }, SLOW);

  e2e("browse", async () => {
    const home = await get("/api/services/browse?path=");
    expectShape(home, { path: "string", parent: "string?", entries: "array", truncated: "boolean" }, "browse");
    expectEach(home.entries, BROWSE_ENTRY, "entries");
    expect(home.path).toBe(homedir());

    const bin = await get(`/api/services/browse?${new URLSearchParams({ path: "/usr/../bin" })}`);
    expect(bin).toMatchObject({ path: "/bin", parent: "/", truncated: false });
    expect(bin.entries.find((e: any) => e.name === "sh")).toEqual({ name: "sh", isDirectory: false, isApp: false, executable: true, hidden: false });
    expect((await get("/api/services/browse?path=/")).parent).toBeNull();

    const names = home.entries.map((e: any) => e.name);
    const dirsFirst = [...home.entries].sort((a: any, b: any) => Number(b.isDirectory) - Number(a.isDirectory));
    expect(dirsFirst.map((e: any) => e.name)).toEqual(names); // a stable sort changes nothing when directories already lead

    for (const bad of ["relative/path", "/no/such/folder", "/etc/hosts"]) {
      const res = await api("GET", `/api/services/browse?${new URLSearchParams({ path: bad })}`);
      expect(res.status).toBe(400);
      expectShape(res.body, ERROR_BODY, "error");
    }
    expect((await api("GET", "/api/services/browse?path=/no/such/folder")).body.error).toBe("Cannot read this folder.");
  });

  e2e("default PATH", async () => {
    const { path } = await get("/api/services/default-path");
    const dirs = (path as string).split(":");
    for (const dir of ["/usr/bin", "/bin", "/opt/homebrew/bin", "/usr/local/sbin"]) expect(dirs).toContain(dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs.filter((d) => !d.startsWith("/"))).toEqual([]);
  });

  e2e("plists as JSON", async () => {
    const { plists } = await get("/api/services/plists");
    expect(isObject(plists)).toBe(true);
    const keys = Object.keys(plists);
    expect(keys.length).toBeGreaterThan(100);
    expect(keys.filter((k) => !CATEGORIES.includes(k.slice(0, k.indexOf("/"))))).toEqual([]);
    expect(Object.values(plists).filter((p) => !isObject(p))).toEqual([]);
  }, SLOW);

  e2e("bad requests get { ok: false, error }", async () => {
    const cases: [string, number][] = [
      ["/api/services/detail", 400],
      ["/api/services/job?label=x&category=nope", 400],
      [`/api/services/job?label=com.macdash.no-such-job&category=${category}`, 404],
      ["/api/services/revisions", 400],
      ["/api/services/revision?id=../../etc/passwd", 404],
      ["/api/services/signature", 400],
      ["/api/services/output", 400],
    ];
    for (const [path, status] of cases) {
      const res = await api("GET", path);
      expect({ path, status: res.status }).toEqual({ path, status });
      expectShape(res.body, ERROR_BODY, path);
      expect(res.body.ok).toBe(false);
    }
  });
});

// ── Origin and Host protection ───────────────────────────────────────

describe("requests from other pages are refused", () => {
  e2e("a foreign Origin gets 403 before the route runs", async () => {
    for (const origin of ["http://evil.example", `http://evil.example:${port}`, "null"]) {
      const res = await api("POST", "/api/services/check-paths", { paths: ["/bin/sh"] }, { Origin: origin });
      expect({ origin, status: res.status }).toEqual({ origin, status: 403 });
      expectShape(res.body, ERROR_BODY, "error");
    }
    expect((await api("GET", "/api/services/meta", undefined, { Origin: "http://evil.example" })).status).toBe(403);
  });

  e2e("the own origin and a request without Origin pass", async () => {
    expect((await api("POST", "/api/services/check-paths", { paths: ["/bin/sh", "/nope"] })).body.facts).toEqual([
      { path: "/bin/sh", exists: true, isFile: true, isDirectory: false, executable: true },
      { path: "/nope", exists: false, isFile: false, isDirectory: false, executable: false },
    ]);
    const res = await fetch(`${base}/api/services/check-paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"paths":[]}' });
    expect(res.status).toBe(200);
  });

  e2e("a foreign Host gets 403 (DNS rebinding)", async () => {
    expect(await rawGet("/api/health", `127.0.0.1:${port}`)).toBe(200);
    expect(await rawGet("/api/health", `localhost:${port}`)).toBe(200);
    expect(await rawGet("/api/health", `evil.example:${port}`)).toBe(403);
    expect(await rawGet("/api/services/meta", "evil.example")).toBe(403);
    expect(await rawGet("/", "evil.example")).toBe(403);
  });

  e2e("the WebSocket refuses a foreign Origin", async () => {
    const outcome = await new Promise<string>((done) => {
      // `headers` is an extension of Bun's WebSocket client
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: "http://evil.example" } } as any);
      socket.onopen = () => (socket.close(), done("open"));
      socket.onerror = () => done("refused");
      socket.onclose = () => done("refused");
      setTimeout(() => done("timeout"), 10_000);
    });
    expect(outcome).toBe("refused");
  });
});

// ── Job lifecycle, user scope only ───────────────────────────────────

describe("job lifecycle in the user scope", () => {
  e2e("the WebSocket accepts a subscription to job-events", async () => {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onmessage = (event) => wsMessages.push({ at: Date.now(), message: JSON.parse(String(event.data)) });
    await new Promise<void>((done, fail) => {
      ws!.onopen = () => done();
      ws!.onerror = () => fail(new Error("WebSocket connection failed"));
    });
    ws.send(JSON.stringify({ type: "subscribe", topics: ["job-events"] }));
    const subscribed = await waitFor(() => wsMessages.find((m) => m.message.type === "subscribed") ?? null, 5000, 50);
    expect(subscribed?.message.topics).toEqual(["job-events"]);
    expect(wsMessages[0].message.type).toBe("connected");
  });

  e2e("save and load", async () => {
    await get("/api/services"); // the monitor's baseline scan is done once the list answers
    const res = await api("POST", "/api/services/job", { category: testJob().category, xml: serializePlist(plist), load: true });
    savedAt = Date.now();
    expect(res.body).toEqual({ ok: true, label, path: jobFile });
    expect(res.status).toBe(200);
  }, SLOW);

  e2e("the list shows the job, loaded", async () => {
    const found = await waitFor(async () => {
      const s = await listed();
      return s?.loaded ? s : null;
    }, 6000);
    expectShape(found, SERVICE_INFO, "service");
    expect(found).toMatchObject({ writable: true, needsAdmin: false, disabled: false, enabled: true, unreadable: false, program: "/usr/bin/true", programArguments: ["/usr/bin/true"], plistPath: jobFile });
  }, SLOW);

  e2e("detail and signature of the job", async () => {
    const detail = await get(`/api/services/detail?${jobQuery()}`);
    expectShape(detail, SERVICE_DETAIL, "detail");
    expect(detail.domain).toMatch(/^gui\/\d+$/);
    expect(detail.raw).toContain(label);

    const signature = await get(`/api/services/signature?${jobQuery()}`);
    expectShape(signature, JOB_SIGNATURE, "signature");
    expect(signature).toMatchObject({ path: "/usr/bin/true", signed: true, apple: true, trusted: true, adhoc: false, error: null });
  }, SLOW);

  e2e("read returns the XML", async () => {
    const doc = await get(`/api/services/job?${jobQuery()}`);
    expectShape(doc, JOB_DOCUMENT, "document");
    expect(doc).toMatchObject({ label, category, fileName: `${label}.plist`, path: jobFile, writable: true, needsAdmin: false });
    expect(parsePlistDict(doc.xml)).toEqual(plist);
  });

  e2e("notes, tags and icon round trip", async () => {
    const meta = { notes: "written by the mac-dash end-to-end test", tags: ["e2e", "temporary"], icon: "\u{1F680}" };
    expect((await api("PUT", "/api/services/meta", { ...testJob(), ...meta })).body).toEqual({ ok: true });
    expect((await get("/api/services/meta")).meta[metaKey]).toEqual(meta);

    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    expect((await api("PUT", "/api/services/meta", { ...testJob(), ...meta, icon: png })).status).toBe(200);
    expect((await get("/api/services/meta")).meta[metaKey].icon).toBe(png);

    for (const icon of ["rocket", "data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${"A".repeat(48 * 1024)}`]) {
      const res = await api("PUT", "/api/services/meta", { ...testJob(), ...meta, icon });
      expect(res.status).toBe(400);
      expectShape(res.body, ERROR_BODY, "error");
    }
    expect((await get("/api/services/meta")).meta[metaKey].icon).toBe(png); // a refused icon changes nothing

    // no icon in the request removes it, the notes keep the entry
    expect((await api("PUT", "/api/services/meta", { ...testJob(), notes: meta.notes, tags: meta.tags })).status).toBe(200);
    expect((await get("/api/services/meta")).meta[metaKey]).toEqual({ notes: meta.notes, tags: meta.tags });
  });

  e2e("save only, with StartInterval", async () => {
    const xml = serializePlist({ ...plist, StartInterval: 3600 });
    const res = await api("POST", "/api/services/job", { category: testJob().category, xml, original: testJob(), load: false });
    expect(res.body).toEqual({ ok: true, label, path: jobFile });
    expect(parsePlistDict((await get(`/api/services/job?${jobQuery()}`)).xml).StartInterval).toBe(3600);
    expect((await get("/api/services/plists")).plists[metaKey]).toEqual({ ...plist, StartInterval: 3600 });
  }, SLOW);

  e2e("the overwrite left a revision", async () => {
    const { revisions } = await get(`/api/services/revisions?${new URLSearchParams({ label })}`);
    expectEach(revisions, { id: "string", at: "number", size: "number" }, "revisions");
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const { xml } = await get(`/api/services/revision?${new URLSearchParams({ id: revisions[revisions.length - 1].id })}`);
    expect(parsePlistDict(xml)).toEqual(plist); // the oldest revision is the first version
  });

  e2e("start", async () => {
    const res = await api("POST", "/api/services/action", { ...testJob(), action: "start" });
    expect(res.body).toEqual({ ok: true });
  }, SLOW);

  e2e("output of a job without StandardOutPath", async () => {
    const output = await get(`/api/services/output?${jobQuery()}&stream=stdout&lines=50`);
    expectShape(output, JOB_OUTPUT, "output");
    expect(output).toEqual({ path: null, exists: false, size: 0, truncated: false, text: "" });
  });

  e2e("disable unloads the job", async () => {
    expect((await api("POST", "/api/services/action", { ...testJob(), action: "disable" })).body).toEqual({ ok: true });
    const state = await waitFor(async () => {
      const s = await listed();
      return s && s.disabled && !s.enabled && !s.loaded ? s : null;
    }, 6000);
    expect(state).not.toBeNull();
  }, SLOW);

  e2e("start of a disabled job is refused with the message of the contract", async () => {
    const res = await api("POST", "/api/services/action", { ...testJob(), action: "start" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: "The job is disabled. Enable it first." });
  }, SLOW);

  e2e("enable loads the job again", async () => {
    expect((await api("POST", "/api/services/action", { ...testJob(), action: "enable" })).body).toEqual({ ok: true });
    const state = await waitFor(async () => {
      const s = await listed();
      return s && !s.disabled && s.loaded ? s : null;
    }, 6000);
    expect(state).not.toBeNull();
  }, SLOW);

  e2e("the WebSocket delivered the job-events message of the new job", async () => {
    const isAdded = (m: { message: any }) => m.message.topic === "job-events" && m.message.data?.label === label && m.message.data?.kind === "added";
    const hit = await waitFor(() => wsMessages.find(isAdded) ?? null, Math.max(0, savedAt + 8000 - Date.now()), 100);
    expect(hit).not.toBeNull();
    expect(hit!.message).toMatchObject({ topic: "job-events", type: "update" });
    expectShape(hit!.message.data, JOB_EVENT, "event");
    expect(hit!.message.data).toMatchObject({ category, path: jobFile, program: "/usr/bin/true" });
    expect(hit!.at - savedAt).toBeLessThanOrEqual(8000);

    const { events } = await get("/api/services/events");
    expect(events.some((e: any) => e.id === hit!.message.data.id)).toBe(true);
    // the save-only overwrite was reported too
    expect(wsMessages.some((m) => m.message.topic === "job-events" && m.message.data?.label === label && m.message.data?.kind === "modified")).toBe(true);
  }, SLOW);

  e2e("delete removes the job and its notes", async () => {
    expect((await api("DELETE", `/api/services/job?${jobQuery()}`)).body).toEqual({ ok: true });
    const gone = await waitFor(async () => ((await listed()) === null ? true : null), 6000);
    expect(gone).toBe(true);
    expect(existsSync(jobFile)).toBe(false);
    expect(metaKey in (await get("/api/services/meta")).meta).toBe(false);
    expect((await api("GET", `/api/services/job?${jobQuery()}`)).status).toBe(404);

    const removed = await waitFor(() => wsMessages.find((m) => m.message.data?.label === label && m.message.data?.kind === "removed") ?? null, 8000, 100);
    expect(removed).not.toBeNull();
  }, SLOW);
});
