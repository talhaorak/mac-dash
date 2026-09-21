import { Hono } from "hono";
import {
  listProcesses,
  killProcess,
  getProcessDetail,
  getProcessChain,
  getProcessCwd,
  type KillFailureReason,
} from "../core/process-manager";

const app = new Hono();

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 5000;

/** Strict PID parsing: digits only, positive, within the macOS pid range */
function parsePid(raw: string): number | null {
  if (!/^\d{1,7}$/.test(raw)) return null;
  const pid = parseInt(raw, 10);
  return pid > 0 ? pid : null;
}

const KILL_STATUS: Record<KillFailureReason, 400 | 403 | 404 | 500> = {
  invalid: 400,
  protected: 403,
  "not-permitted": 403,
  "not-found": 404,
  failed: 500,
};

app.get("/", async (c) => {
  const processes = await listProcesses();
  const sort = c.req.query("sort") || "cpu";
  const rawLimit = parseInt(c.req.query("limit") || String(DEFAULT_LIMIT), 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const search = c.req.query("search")?.toLowerCase();

  let filtered = processes;
  if (search) {
    filtered = filtered.filter(
      (p) =>
        p.command.toLowerCase().includes(search) ||
        p.args.toLowerCase().includes(search) ||
        p.path.toLowerCase().includes(search) ||
        String(p.pid).includes(search)
    );
  }

  // Sort
  switch (sort) {
    case "cpu":
      filtered.sort((a, b) => b.cpu - a.cpu);
      break;
    case "mem":
      filtered.sort((a, b) => b.mem - a.mem);
      break;
    case "pid":
      filtered.sort((a, b) => a.pid - b.pid);
      break;
    case "name":
      filtered.sort((a, b) => a.command.localeCompare(b.command));
      break;
  }

  return c.json({
    processes: filtered.slice(0, limit),
    total: processes.length,
    filtered: filtered.length,
  });
});

app.get("/:pid", async (c) => {
  const pid = parsePid(c.req.param("pid"));
  if (pid === null) return c.json({ ok: false, error: "Invalid PID" }, 400);
  const detail = await getProcessDetail(pid);
  if (!detail) return c.json({ ok: false, error: "Process not found" }, 404);
  return c.json(detail);
});

app.get("/:pid/chain", async (c) => {
  const pid = parsePid(c.req.param("pid"));
  if (pid === null) return c.json({ ok: false, error: "Invalid PID" }, 400);
  const chain = await getProcessChain(pid);
  return c.json({ chain });
});

app.get("/:pid/cwd", async (c) => {
  const pid = parsePid(c.req.param("pid"));
  if (pid === null) return c.json({ ok: false, error: "Invalid PID" }, 400);
  const cwd = await getProcessCwd(pid);
  return c.json({ cwd });
});

app.post("/:pid/kill", async (c) => {
  const pid = parsePid(c.req.param("pid"));
  if (pid === null) return c.json({ ok: false, error: "Invalid PID" }, 400);

  const body: unknown = await c.req.json().catch(() => ({}));
  const force =
    typeof body === "object" &&
    body !== null &&
    (body as { force?: unknown }).force === true;

  const result = await killProcess(pid, force ? "KILL" : "TERM");
  if (result.ok) return c.json({ ok: true });

  return c.json(
    { ok: false, error: result.error || `Failed to kill PID ${pid}` },
    KILL_STATUS[result.reason ?? "failed"]
  );
});

export default app;
