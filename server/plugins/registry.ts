import { Hono } from "hono";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { LoadedPlugin, PluginManifest, ServerPlugin } from "./types";

const plugins = new Map<string, LoadedPlugin>();
const PLUGINS_DIR = join(import.meta.dir, "../../plugins");

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
      await mod.register(app);
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
