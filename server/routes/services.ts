import { Hono, type Context } from "hono";
import {
  SERVICE_ACTIONS,
  checkPaths,
  deleteJob,
  getServiceDetail,
  listServices,
  manageService,
  readJob,
  readJobOutput,
  revealJob,
  saveJob,
  type ServiceAction,
} from "../core/launchctl";
import { clearJobEvents, getJobEvents } from "../core/job-monitor";
import {
  getAllJobMeta,
  getLoginItems,
  getStartupExtras,
  listRevisions,
  listShortcuts,
  readRevision,
  setJobMeta,
} from "../core/job-extras";
import { refreshServices } from "../ws/hub";
import { scopeFor, type JobCategory } from "../../shared/launchd";

// Jobs are addressed by label + category. Paths never come from the client (docs/backend-contract.md).

const app = new Hono();

const fail = (c: Context, error: string, status: 400 | 404 = 400) => c.json({ ok: false, error }, status);

function jobRef(source: { label?: unknown; category?: unknown }): { label: string; category: JobCategory } | null {
  const { label, category } = source;
  if (typeof label !== "string" || !label || typeof category !== "string" || !scopeFor(category)) return null;
  return { label, category: category as JobCategory };
}

app.get("/", async (c) => {
  const services = await listServices();
  return c.json({ services, count: services.length });
});

app.get("/detail", async (c) => {
  const ref = jobRef(c.req.query());
  if (!ref) return fail(c, "label and category are required");
  const detail = await getServiceDetail(ref.label, ref.category);
  return detail ? c.json(detail) : fail(c, "launchd does not know this service", 404);
});

app.post("/action", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ref = jobRef(body);
  if (!ref) return fail(c, "label and category are required");
  if (!SERVICE_ACTIONS.includes(body.action)) return fail(c, `action must be one of: ${SERVICE_ACTIONS.join(", ")}`);
  const result = await manageService(ref.label, ref.category, body.action as ServiceAction);
  refreshServices();
  return c.json(result, result.ok ? 200 : 400);
});

app.get("/job", async (c) => {
  const ref = jobRef(c.req.query());
  if (!ref) return fail(c, "label and category are required");
  const doc = await readJob(ref.label, ref.category);
  return doc ? c.json(doc) : fail(c, "Job file not found or not readable", 404);
});

app.post("/job", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.xml !== "string" || !scopeFor(body.category)) return fail(c, "category and xml are required");
  const original = body.original ? jobRef(body.original) : null;
  if (body.original && !original) return fail(c, "original must contain label and category");
  const result = await saveJob({ category: body.category, xml: body.xml, original, load: body.load !== false });
  refreshServices();
  return c.json(result, result.ok ? 200 : 400);
});

app.delete("/job", async (c) => {
  const ref = jobRef(c.req.query());
  if (!ref) return fail(c, "label and category are required");
  const result = await deleteJob(ref.label, ref.category);
  if (result.ok) await setJobMeta(ref.label, ref.category, { notes: "", tags: [] }); // no orphaned notes
  refreshServices();
  return c.json(result, result.ok ? 200 : 400);
});

app.get("/output", async (c) => {
  const ref = jobRef(c.req.query());
  if (!ref) return fail(c, "label and category are required");
  const stream = c.req.query("stream") === "stderr" ? "stderr" : "stdout";
  const lines = parseInt(c.req.query("lines") || "200", 10);
  return c.json(await readJobOutput(ref.label, ref.category, stream, Number.isFinite(lines) ? lines : 200));
});

app.post("/check-paths", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body.paths)) return fail(c, "paths must be an array");
  return c.json({ facts: await checkPaths(body.paths) });
});

app.post("/reveal", async (c) => {
  const ref = jobRef(await c.req.json().catch(() => ({})));
  if (!ref) return fail(c, "label and category are required");
  const result = await revealJob(ref.label, ref.category);
  return c.json(result, result.ok ? 200 : 400);
});

app.get("/meta", async (c) => c.json({ meta: await getAllJobMeta() }));

app.put("/meta", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ref = jobRef(body);
  if (!ref) return fail(c, "label and category are required");
  await setJobMeta(ref.label, ref.category, { notes: body.notes ?? "", tags: body.tags ?? [] });
  return c.json({ ok: true });
});

app.get("/revisions", async (c) => {
  const label = c.req.query("label");
  if (!label) return fail(c, "label is required");
  return c.json({ revisions: await listRevisions(label) });
});

app.get("/revision", async (c) => {
  const xml = await readRevision(c.req.query("id") ?? "");
  return xml === null ? fail(c, "Revision not found", 404) : c.json({ xml });
});

app.get("/extras", async (c) => c.json(await getStartupExtras()));

app.get("/login-items", async (c) => {
  const result = await getLoginItems();
  return c.json(result, result.ok ? 200 : 400);
});

app.get("/shortcuts", async (c) => c.json({ shortcuts: await listShortcuts() }));

app.get("/events", async (c) => c.json({ events: await getJobEvents() }));

app.delete("/events", async (c) => {
  await clearJobEvents();
  return c.json({ ok: true });
});

export default app;
