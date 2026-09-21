/**
 * Plugin Runtime — shared module registry & dynamic component loader.
 *
 * The host app registers shared modules on `globalThis.__macdash__`.
 * When a plugin's bundled client.js is loaded, its import statements
 * have been rewritten to read from these globals.
 */

import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as JsxDevRuntime from "react/jsx-dev-runtime";
import * as LucideReact from "lucide-react";
import * as FramerMotion from "framer-motion";

// @/ modules — host app internals shared with plugins
import * as GlowCardModule from "@/components/ui/GlowCard";
import * as ApiModule from "@/lib/api";
import * as UtilsModule from "@/lib/utils";

export type PluginModule = {
  default: React.ComponentType<any>;
  metadata?: { title?: string; icon?: string };
};

// ── Register shared modules on globalThis ──────────────────────────

declare global {
  var __macdash__: {
    react: typeof React;
    reactDom: any;
    jsxRuntime: typeof JsxRuntime;
    jsxDevRuntime: typeof JsxDevRuntime;
    icons: typeof LucideReact;
    framerMotion: typeof FramerMotion;
    zustand: any;
    modules: Record<string, any>;
  };
}

export function initPluginRuntime() {
  globalThis.__macdash__ = {
    react: React,
    reactDom: null, // lazy — only register if needed
    jsxRuntime: JsxRuntime,
    jsxDevRuntime: JsxDevRuntime,
    icons: LucideReact,
    framerMotion: FramerMotion,
    zustand: null,
    modules: {
      "@/components/ui/GlowCard": GlowCardModule,
      "@/lib/api": ApiModule,
      "@/lib/utils": UtilsModule,
    },
  };
}

// ── Dynamic plugin component loader ────────────────────────────────

const moduleCache = new Map<string, PluginModule>();
/** Loads in progress, so concurrent callers share one fetch + import. */
const inflight = new Map<string, Promise<PluginModule>>();

/**
 * Dynamically load a plugin's client component from the server.
 *
 * Flow:
 *   1. Fetch bundled JS from `/api/plugins/{id}/client.js`
 *   2. Create a Blob URL from the response
 *   3. `import()` the Blob URL — the code references `globalThis.__macdash__`
 *   4. Revoke the Blob URL. The evaluated module stays alive without it.
 *   5. Return the module's default export (React component) + metadata
 */
export function loadPluginModule(pluginId: string): Promise<PluginModule> {
  const cached = moduleCache.get(pluginId);
  if (cached) return Promise.resolve(cached);

  const pending = inflight.get(pluginId);
  if (pending) return pending;

  const promise = fetchPluginModule(pluginId)
    .then((mod) => {
      // Skip the cache when clearPluginModuleCache() ran during the load.
      if (inflight.get(pluginId) === promise) moduleCache.set(pluginId, mod);
      return mod;
    })
    .finally(() => {
      if (inflight.get(pluginId) === promise) inflight.delete(pluginId);
    });

  inflight.set(pluginId, promise);
  return promise;
}

async function fetchPluginModule(pluginId: string): Promise<PluginModule> {
  const res = await fetch(
    `/api/plugins/${encodeURIComponent(pluginId)}/client.js`
  );
  if (!res.ok) {
    throw new Error(
      `Failed to load plugin "${pluginId}" client: ${res.status} ${res.statusText}`
    );
  }

  const code = await res.text();
  const blob = new Blob([code], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);

  try {
    const mod: PluginModule = await import(/* @vite-ignore */ url);

    if (typeof mod.default !== "function") {
      throw new Error(
        `Plugin "${pluginId}" client.tsx must export a default React component`
      );
    }

    return mod;
  } finally {
    // The Blob URL is only needed until the import settles.
    URL.revokeObjectURL(url);
  }
}

/**
 * Drop a cached plugin module so the next render fetches fresh code.
 * Call it when a plugin is enabled, disabled, or rescanned.
 */
export function clearPluginModuleCache(pluginId?: string) {
  if (pluginId) {
    moduleCache.delete(pluginId);
    inflight.delete(pluginId);
  } else {
    moduleCache.clear();
    inflight.clear();
  }
}
