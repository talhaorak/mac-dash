import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { STATE_DIR } from "./launchctl";

// Access token for a server that listens beyond loopback. See docs/backend-contract.md ("Access token").

export const TOKEN_FILE = join(STATE_DIR, "token");
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** The stored token, or a new one (32 random bytes, hex, mode 0600) when the file is missing or damaged. */
export async function loadOrCreateToken(file = TOKEN_FILE): Promise<string> {
  const stored = await readFile(file, "utf8").then((text) => text.trim(), () => "");
  if (TOKEN_PATTERN.test(stored)) {
    await chmod(file, 0o600).catch(() => {});
    return stored;
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(file), { recursive: true });
  await unlink(file).catch(() => {});
  await writeFile(file, `${token}\n`, { mode: 0o600, flag: "wx" }); // "wx" never writes through a planted symlink
  return token;
}

/** Constant time. Both sides are hashed first, so the buffers always have the same length. */
export function tokensMatch(presented: string | null | undefined, token: string): boolean {
  if (typeof presented !== "string" || !presented || !token) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(presented), digest(token));
}

export function bearerToken(authorization: string | null | undefined): string | null {
  return authorization?.match(/^Bearer +(\S+)$/i)?.[1] ?? null;
}

export interface RequestLike {
  method: string;
  /** The path as the router sees it (Hono decodes percent-escapes before it matches a route). */
  path: string;
  authorization: string | null;
  /** `?token=`, read for the WebSocket only: a browser cannot set a header on a WebSocket. */
  queryToken: string | null;
}

/** Always reachable, so that a client can find out whether it needs a token and whether its token works. */
const OPEN_API_PATHS = new Set(["/api/auth/status", "/api/health"]);

/**
 * Everything under /api needs the token, plugin routes included. /ws takes it from the URL.
 * Static files stay open so that the login screen can load.
 */
export function isAuthorized(req: RequestLike, token: string, required: boolean): boolean {
  if (!required) return true;
  if (req.path === "/ws") return tokensMatch(req.queryToken, token);
  // Static files and the single-page fallback are read-only. Anything else outside /api needs the token too.
  const isApi = req.path === "/api" || req.path.startsWith("/api/");
  if (!isApi && (req.method === "GET" || req.method === "HEAD")) return true;
  if (req.method === "GET" && OPEN_API_PATHS.has(req.path)) return true;
  return tokensMatch(bearerToken(req.authorization), token);
}
