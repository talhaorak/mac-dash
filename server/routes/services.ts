import { Hono } from "hono";
import {
  listServices,
  getServiceDetail,
  startService,
  stopService,
  enableService,
  disableService,
} from "../core/launchctl";

const app = new Hono();

app.get("/", async (c) => {
  const services = await listServices();
  return c.json({ services, count: services.length });
});

app.get("/:label{.+}", async (c) => {
  const label = c.req.param("label");
  const detail = await getServiceDetail(label);
  if (!detail) return c.json({ error: "Service not found" }, 404);
  return c.json(detail);
});

app.post("/:label{.+}/start", async (c) => {
  const label = c.req.param("label");
  const result = await startService(label);
  return c.json(result, result.ok ? 200 : 400);
});

app.post("/:label{.+}/stop", async (c) => {
  const label = c.req.param("label");
  const result = await stopService(label);
  return c.json(result, result.ok ? 200 : 400);
});

app.post("/:label{.+}/enable", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const plistPath = body.plistPath;
  if (!plistPath) return c.json({ ok: false, error: "plistPath required" }, 400);
  const result = await enableService(plistPath);
  return c.json(result, result.ok ? 200 : 400);
});

app.post("/:label{.+}/disable", async (c) => {
  const label = c.req.param("label");
  const body = await c.req.json().catch(() => ({}));
  const result = await disableService(label, body.plistPath || null);
  return c.json(result, result.ok ? 200 : 400);
});

export default app;
