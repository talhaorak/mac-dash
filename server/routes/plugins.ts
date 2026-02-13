import { Hono } from "hono";
import {
  discoverPlugins,
  getPlugins,
  enablePlugin,
  disablePlugin,
  loadPluginServer,
} from "../plugins/registry";

// We need a reference to the root app to register plugin routes
let rootApp: Hono | null = null;

export function setRootApp(app: Hono) {
  rootApp = app;
}

const app = new Hono();

app.get("/", async (c) => {
  const plugins = getPlugins();
  return c.json({
    plugins: plugins.map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      icon: p.manifest.icon,
      enabled: p.enabled,
      hasClient: p.hasClient,
      sidebar: p.manifest.sidebar,
      dashboardWidget: p.manifest.dashboardWidget,
    })),
  });
});

app.post("/discover", async (c) => {
  const plugins = await discoverPlugins();
  // Auto-load server modules for enabled plugins
  if (rootApp) {
    for (const p of plugins) {
      if (p.enabled && !p.serverModule) {
        await loadPluginServer(p.manifest.id, rootApp);
      }
    }
  }
  return c.json({
    plugins: plugins.map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      enabled: p.enabled,
    })),
  });
});

app.post("/:id/enable", async (c) => {
  const id = c.req.param("id");
  const ok = enablePlugin(id);
  if (ok && rootApp) {
    await loadPluginServer(id, rootApp);
  }
  return c.json({ ok }, ok ? 200 : 404);
});

app.post("/:id/disable", async (c) => {
  const id = c.req.param("id");
  const ok = disablePlugin(id);
  return c.json({ ok }, ok ? 200 : 404);
});

export default app;
