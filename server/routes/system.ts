import { Hono } from "hono";
import { getSystemStats, getHardwareInfo } from "../core/system-info";
import { readFileSync } from "fs";
import { join } from "path";

const app = new Hono();

// Read version from package.json at startup
let appVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, "../../package.json"), "utf-8")
  );
  appVersion = pkg.version || appVersion;
} catch {}

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
