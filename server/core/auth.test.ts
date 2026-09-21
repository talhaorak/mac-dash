import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { bearerToken, isAuthorized, loadOrCreateToken, tokensMatch, type RequestLike } from "./auth";

const TOKEN = "a".repeat(64);
const request = (path: string, extra: Partial<RequestLike> = {}): RequestLike => ({ method: "GET", path, authorization: null, queryToken: null, ...extra });
const withBearer = (path: string, token: string, method = "GET") => request(path, { method, authorization: `Bearer ${token}` });

describe("isAuthorized", () => {
  test("outside /api only reads are open: a plugin route there cannot skip the token", () => {
    expect(isAuthorized(request("/", { method: "GET" }), "secret", true)).toBe(true);
    expect(isAuthorized(request("/assets/index.js", { method: "HEAD" }), "secret", true)).toBe(true);
    expect(isAuthorized(request("/status", { method: "POST" }), "secret", true)).toBe(false);
    expect(isAuthorized(request("/status", { method: "DELETE" }), "secret", true)).toBe(false);
    expect(isAuthorized(request("/status", { method: "POST", authorization: "Bearer secret" }), "secret", true)).toBe(true);
  });

  test("a loopback server asks for nothing", () => {
    for (const path of ["/api/services", "/ws", "/", "/api/plugins/x/run"]) expect(isAuthorized(request(path, { method: "POST" }), "", false)).toBe(true);
  });

  test("the API needs the Bearer token, plugin routes included", () => {
    for (const path of ["/api", "/api/services", "/api/services/job", "/api/processes/1/kill", "/api/plugins/demo/anything", "/api/system/stats"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        expect(isAuthorized(request(path, { method }), TOKEN, true)).toBe(false);
        expect(isAuthorized(withBearer(path, "b".repeat(64), method), TOKEN, true)).toBe(false);
        expect(isAuthorized(withBearer(path, TOKEN, method), TOKEN, true)).toBe(true);
      }
    }
  });

  test("a token in the URL does not open the API", () => {
    expect(isAuthorized(request("/api/services", { queryToken: TOKEN }), TOKEN, true)).toBe(false);
  });

  test("status and health are open for GET only", () => {
    for (const path of ["/api/auth/status", "/api/health"]) {
      expect(isAuthorized(request(path), TOKEN, true)).toBe(true);
      expect(isAuthorized(request(path, { method: "POST" }), TOKEN, true)).toBe(false);
    }
    expect(isAuthorized(request("/api/auth/status/x"), TOKEN, true)).toBe(false);
    expect(isAuthorized(request("/api/healthz"), TOKEN, true)).toBe(false);
  });

  test("static files are open", () => {
    for (const path of ["/", "/index.html", "/assets/index-abc.js", "/services", "/apiary", "/api-docs"]) {
      expect(isAuthorized(request(path), TOKEN, true)).toBe(true);
    }
  });

  test("the WebSocket takes the token from the URL", () => {
    expect(isAuthorized(request("/ws"), TOKEN, true)).toBe(false);
    expect(isAuthorized(request("/ws", { queryToken: "" }), TOKEN, true)).toBe(false);
    expect(isAuthorized(request("/ws", { queryToken: `${TOKEN}x` }), TOKEN, true)).toBe(false);
    expect(isAuthorized(request("/ws", { queryToken: TOKEN }), TOKEN, true)).toBe(true);
  });

  test("an empty server token never matches", () => {
    expect(isAuthorized(withBearer("/api/services", ""), "", true)).toBe(false);
    expect(isAuthorized(request("/ws", { queryToken: "" }), "", true)).toBe(false);
  });
});

describe("tokensMatch and bearerToken", () => {
  test("compares whole strings of any length", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    for (const wrong of [null, undefined, "", "a", TOKEN.slice(0, 63), `${TOKEN}a`, TOKEN.toUpperCase()]) expect(tokensMatch(wrong, TOKEN)).toBe(false);
  });

  test("reads the Authorization header", () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`bearer  ${TOKEN}`)).toBe(TOKEN);
    for (const header of [null, undefined, "", TOKEN, `Basic ${TOKEN}`, "Bearer", "Bearer a b"]) expect(bearerToken(header)).toBeNull();
  });
});

describe("loadOrCreateToken", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  const tempFile = async () => {
    const dir = await mkdtemp(join(tmpdir(), "macdash-token-"));
    dirs.push(dir);
    return join(dir, "state", "token");
  };

  test("creates 32 random bytes as hex with mode 0600 and keeps them", async () => {
    const file = await tempFile();
    const token = await loadOrCreateToken(file);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await loadOrCreateToken(file)).toBe(token);
    expect(await loadOrCreateToken(await tempFile())).not.toBe(token);
  });

  test("replaces a damaged file instead of accepting a weak token", async () => {
    const file = await tempFile();
    await loadOrCreateToken(file);
    await writeFile(file, "\n", { mode: 0o644 });
    const token = await loadOrCreateToken(file);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await readFile(file, "utf8")).trim()).toBe(token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("does not write through a symlink", async () => {
    const file = await tempFile();
    await loadOrCreateToken(file);
    const victim = join(file, "..", "victim");
    await writeFile(victim, "keep me");
    await rm(file);
    await symlink(victim, file);
    const token = await loadOrCreateToken(file);
    expect(await readFile(victim, "utf8")).toBe("keep me");
    expect((await readFile(file, "utf8")).trim()).toBe(token);
  });
});
