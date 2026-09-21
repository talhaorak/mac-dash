import { existsSync } from "fs";
import { dirname, join, resolve } from "path";

/**
 * Filesystem locations of the app's on-disk assets (`plugins/`, `dist/client/`).
 *
 * Source-relative paths built from `import.meta.dir` break inside a
 * `bun build --compile` executable: every bundled module reports the virtual
 * directory `/$bunfs/root`, so `join(import.meta.dir, "../../plugins")`
 * resolves to `/plugins`.  A compiled binary has to look next to the real
 * executable instead.
 */

const BUNFS_PREFIX = "/$bunfs";

/** True when this code runs inside a `bun build --compile` executable */
export function isCompiledBinary(): boolean {
  return import.meta.dir.startsWith(BUNFS_PREFIX);
}

function hasAppAssets(dir: string): boolean {
  return existsSync(join(dir, "plugins")) || existsSync(join(dir, "dist"));
}

let cachedRoot: string | null = null;

/**
 * Directory that contains `plugins/` and `dist/`.
 *
 * Resolution order:
 *   1. `MACDASH_ROOT` environment variable (explicit override)
 *   2. compiled binary: the directory of the executable (release tarball
 *      layout), then `../share/macdash` (Homebrew formula layout:
 *      `bin/macdash` + `share/macdash/{plugins,dist}`)
 *   3. running from source: the repository root (two levels above this file)
 */
export function getAppRoot(): string {
  if (cachedRoot) return cachedRoot;

  const override = process.env.MACDASH_ROOT?.trim();
  if (override) {
    cachedRoot = resolve(override);
    return cachedRoot;
  }

  if (isCompiledBinary()) {
    const execDir = dirname(process.execPath);
    const candidates = [execDir, join(execDir, "../share/macdash")];
    cachedRoot = candidates.find(hasAppAssets) ?? execDir;
    return cachedRoot;
  }

  cachedRoot = join(import.meta.dir, "../..");
  return cachedRoot;
}

/** Directory that holds one sub-directory per plugin */
export function getPluginsDir(): string {
  return join(getAppRoot(), "plugins");
}

/** Directory of the built web client (`vite build` output) */
export function getClientDir(): string {
  return join(getAppRoot(), "dist/client");
}
