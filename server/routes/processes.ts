import { Hono } from "hono";
import {
  listProcesses,
  killProcess,
  getProcessDetail,
  getProcessChain,
  getProcessCwd,
} from "../core/process-manager";

const app = new Hono();

app.get("/", async (c) => {
  const processes = await listProcesses();
  const sort = c.req.query("sort") || "cpu";
  const limit = parseInt(c.req.query("limit") || "200");
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
  const pid = parseInt(c.req.param("pid"));
  if (isNaN(pid)) return c.json({ error: "Invalid PID" }, 400);
  const detail = await getProcessDetail(pid);
  if (!detail) return c.json({ error: "Process not found" }, 404);
  return c.json(detail);
});

app.get("/:pid/chain", async (c) => {
  const pid = parseInt(c.req.param("pid"));
  if (isNaN(pid)) return c.json({ error: "Invalid PID" }, 400);
  const chain = await getProcessChain(pid);
  return c.json({ chain });
});

app.get("/:pid/cwd", async (c) => {
  const pid = parseInt(c.req.param("pid"));
  if (isNaN(pid)) return c.json({ error: "Invalid PID" }, 400);
  const cwd = await getProcessCwd(pid);
  return c.json({ cwd });
});

app.post("/:pid/kill", async (c) => {
  const pid = parseInt(c.req.param("pid"));
  if (isNaN(pid)) return c.json({ error: "Invalid PID" }, 400);

  const body = await c.req.json().catch(() => ({}));
  const signal = body.force ? "KILL" : "TERM";

  const result = await killProcess(pid, signal);
  return c.json(result, result.ok ? 200 : 400);
});

export default app;
