import { join } from "path";
import type { BunPlugin } from "bun";
import type { LoadedPlugin } from "./types";

// ── Bundle cache ───────────────────────────────────────────────────
const bundleCache = new Map<string, { code: string; bundledAt: number }>();
const BUNDLE_CACHE_TTL = 60_000; // 1 min — keeps dev fast, avoids stale builds

/**
 * Bundle a plugin's client.tsx into browser-ready ESM JavaScript.
 *
 * Strategy:
 *   1. Bun.build compiles TSX → JS and externalises all bare-module imports
 *      (react, lucide-react, @/…) so they stay as `import` statements.
 *   2. A post-process step rewrites those `import` statements into
 *      `const { … } = globalThis.__macdash__.*` lookups, so the code
 *      runs inside a Blob URL without needing real module resolution.
 */
export async function bundlePluginClient(
  plugin: LoadedPlugin
): Promise<string | null> {
  const cached = bundleCache.get(plugin.manifest.id);
  if (cached && Date.now() - cached.bundledAt < BUNDLE_CACHE_TTL) {
    return cached.code;
  }

  const clientPath = await resolveClientPath(plugin.path);
  if (!clientPath) return null;

  try {
    const result = await Bun.build({
      entrypoints: [clientPath],
      format: "esm",
      target: "browser",
      minify: false,
      plugins: [externaliseDeps],
    });

    if (!result.success || !result.outputs?.length) {
      console.error(
        `[plugin:${plugin.manifest.id}] client build failed:`,
        result.logs
      );
      return null;
    }

    let code = await result.outputs[0].text();
    code = transformImports(code);

    bundleCache.set(plugin.manifest.id, { code, bundledAt: Date.now() });
    return code;
  } catch (e) {
    console.error(
      `[plugin:${plugin.manifest.id}] client bundle error:`,
      e
    );
    return null;
  }
}

/** Clear cached bundle for a specific plugin or all plugins */
export function clearBundleCache(pluginId?: string) {
  if (pluginId) bundleCache.delete(pluginId);
  else bundleCache.clear();
}

// ── Bun build plugin: externalise all non-relative imports ─────────
const externaliseDeps: BunPlugin = {
  name: "externalise-deps",
  setup(build) {
    // Any import that doesn't start with . or / is a bare-module specifier
    // (react, lucide-react, @/components/…, etc.) → keep it external.
    build.onResolve({ filter: /^[^./]/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

// ── Resolve plugin client entry point ──────────────────────────────
async function resolveClientPath(pluginDir: string): Promise<string | null> {
  for (const ext of ["client.tsx", "client.jsx", "client.ts", "client.js"]) {
    const p = join(pluginDir, ext);
    if (await Bun.file(p).exists()) return p;
  }
  return null;
}

// ── Post-process: rewrite ESM imports → globalThis lookups ─────────
const GLOBAL_MAP: Record<string, string> = {
  react: "__macdash__.react",
  "react-dom": "__macdash__.reactDom",
  "react/jsx-runtime": "__macdash__.jsxRuntime",
  "react/jsx-dev-runtime": "__macdash__.jsxDevRuntime",
  "lucide-react": "__macdash__.icons",
  "framer-motion": "__macdash__.framerMotion",
  zustand: "__macdash__.zustand",
  recharts: "__macdash__.recharts",
};

function getGlobalRef(modulePath: string): string {
  if (GLOBAL_MAP[modulePath]) return `globalThis.${GLOBAL_MAP[modulePath]}`;
  if (modulePath.startsWith("@/")) {
    return `globalThis.__macdash__.modules["${modulePath}"]`;
  }
  // Unknown bare module — fall back to modules map
  return `globalThis.__macdash__.modules["${modulePath}"]`;
}

function transformImports(code: string): string {
  // 1) import Name, { a, b } from "mod"  (combined default + named)
  code = code.replace(
    /import\s+(\w+)\s*,\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?/g,
    (_m, def: string, named: string, mod: string) => {
      const ref = getGlobalRef(mod);
      const destructured = named.replace(/\b(\w+)\s+as\s+(\w+)/g, "$1: $2");
      return `const ${def} = (${ref})?.default ?? ${ref};\nconst {${destructured}} = ${ref};`;
    }
  );

  // 2) import * as Name from "mod"
  code = code.replace(
    /import\s*\*\s*as\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?/g,
    (_m, name: string, mod: string) => {
      return `const ${name} = ${getGlobalRef(mod)};`;
    }
  );

  // 3) import { a, b as c } from "mod"
  code = code.replace(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']\s*;?/g,
    (_m, named: string, mod: string) => {
      const ref = getGlobalRef(mod);
      const destructured = named.replace(/\b(\w+)\s+as\s+(\w+)/g, "$1: $2");
      return `const {${destructured}} = ${ref};`;
    }
  );

  // 4) import Name from "mod"  (default import — must come AFTER named/star)
  code = code.replace(
    /import\s+(\w+)\s+from\s*["']([^"']+)["']\s*;?/g,
    (_m, name: string, mod: string) => {
      const ref = getGlobalRef(mod);
      return `const ${name} = (${ref})?.default ?? ${ref};`;
    }
  );

  return code;
}
