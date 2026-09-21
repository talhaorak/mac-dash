import { Hono } from "hono";
import { getSystemStats, getHardwareInfo } from "../core/system-info";
// Static import: the bundler inlines the JSON, so the version is also correct
// inside a `bun build --compile` executable, where package.json does not exist
// on disk.  (No `with { type: "json" }`: tsconfig uses `module: ES2022`, and
// TypeScript only accepts import attributes with esnext/nodenext/preserve.)
import pkg from "../../package.json";

const app = new Hono();

const appVersion: string = pkg.version || "0.0.0";

app.get("/stats", async (c) => {
  const stats = await getSystemStats();
  return c.json(stats);
});

app.get("/hardware", async (c) => {
  const info = await getHardwareInfo();
  return c.json(info);
});

app.get("/version", (c) => {
  return c.json({ version: appVersion });
});

export default app;
