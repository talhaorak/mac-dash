import { Hono } from "hono";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { LoadedPlugin, PluginManifest, ServerPlugin } from "./types";
import { getPluginsDir } from "./paths";

const plugins = new Map<string, LoadedPlugin>();
// Not `join(import.meta.dir, "../../plugins")`: that is `/plugins` inside a
// `bun build --compile` executable (see ./paths.ts).
const PLUGINS_DIR = getPluginsDir();

export async function discoverPlugins(): Promise<LoadedPlugin[]> {
  try {
    const entries = await readdir(PLUGINS_DIR, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const pluginDir = join(PLUGINS_DIR, entry.name);
      const manifestPath = join(pluginDir, "manifest.json");

      try {
        const raw = await readFile(manifestPath, "utf-8");
        const manifest: PluginManifest = JSON.parse(raw);

        const hasServer = await Bun.file(join(pluginDir, "server.ts")).exists() ||
                          await Bun.file(join(pluginDir, "server.js")).exists();
        const hasClient = await Bun.file(join(pluginDir, "client.tsx")).exists() ||
                          await Bun.file(join(pluginDir, "client.jsx")).exists();

        const existing = plugins.get(manifest.id);

        plugins.set(manifest.id, {
          manifest,
          enabled: existing?.enabled ?? true,
          path: pluginDir,
          hasClient,
        });
      } catch {
        // Skip plugins with invalid manifests
      }
    }
  } catch {
    // plugins directory might not exist yet
  }

  return Array.from(plugins.values());
}

export async function loadPluginServer(
  pluginId: string,
  app: Hono
): Promise<boolean> {
  const plugin = plugins.get(pluginId);
  if (!plugin || !plugin.enabled) return false;

  const serverPath =
    (await Bun.file(join(plugin.path, "server.ts")).exists())
      ? join(plugin.path, "server.ts")
      : join(plugin.path, "server.js");

  try {
    if (await Bun.file(serverPath).exists()) {
      const mod: ServerPlugin = await import(serverPath);
      // A plugin registers on a scratch app first. Its routes are mounted only when every one of them
      // lives under /api/plugins/<id>/: a route outside /api would skip the access token and the
      // Origin checks that protect the API.
      const scratch = new Hono();
      await mod.register(scratch);
      const prefix = `/api/plugins/${pluginId}`;
      const outside = scratch.routes.filter((r) => r.path !== prefix && !r.path.startsWith(`${prefix}/`));
      if (outside.length > 0) {
        throw new Error(`routes must start with ${prefix}/ (found: ${[...new Set(outside.map((r) => r.path))].join(", ")})`);
      }
      app.route("/", scratch);
      plugin.serverModule = mod;
      return true;
    }
  } catch (e) {
    console.error(`Failed to load plugin ${pluginId} server:`, e);
  }

  return false;
}

export function getPlugins(): LoadedPlugin[] {
  return Array.from(plugins.values());
}

export function getPlugin(id: string): LoadedPlugin | undefined {
  return plugins.get(id);
}

export function enablePlugin(id: string): boolean {
  const plugin = plugins.get(id);
  if (plugin) {
    plugin.enabled = true;
    return true;
  }
  return false;
}

export function disablePlugin(id: string): boolean {
  const plugin = plugins.get(id);
  if (plugin) {
    plugin.enabled = false;
    if (plugin.serverModule?.cleanup) {
      plugin.serverModule.cleanup();
    }
    return true;
  }
  return false;
}
