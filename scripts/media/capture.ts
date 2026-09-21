/**
 * Produces the screenshots and the demo GIF for the README and the website.
 *
 *   bun run build && bun run media
 *
 * It serves the built client, answers every API call with fictional data (scripts/media/demo-data.ts)
 * and drives the page in the Chrome that is installed on this Mac. No real machine data is shown.
 * Needs Google Chrome and ffmpeg.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import puppeteer, { type Page } from "puppeteer-core";
import * as demo from "./demo-data";

const ROOT = resolve(import.meta.dir, "../..");
const DIST = join(ROOT, "dist/client");
const OUT = join(ROOT, "docs/media");
const FRAMES = join(ROOT, "docs/media/.frames");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1440;
const HEIGHT = 900;
const FPS = 10;

if (!existsSync(join(DIST, "index.html"))) throw new Error("dist/client is missing. Run `bun run build` first.");
if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}. Set CHROME_PATH.`);

// ── Static server for the built client ───────────────────────────────
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const file = Bun.file(join(DIST, path === "/" ? "index.html" : path));
    return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(DIST, "index.html")));
  },
});
const BASE = `http://127.0.0.1:${server.port}`;

// ── Fictional API ────────────────────────────────────────────────────
function api(method: string, url: URL): unknown {
  const p = url.pathname.replace(/^\/api/, "").replace(/\/$/, "");
  const q = url.searchParams;
  const label = q.get("label") ?? "";
  if (method !== "GET") return { ok: true, label: "com.example.my-job", path: "/Users/alex/Library/LaunchAgents/com.example.my-job.plist", facts: [] };
  switch (p) {
    case "/auth/status": return { required: false, ok: true };
    case "/health": return { status: "ok" };
    case "/system/stats": return demo.systemStats();
    case "/system/hardware": return demo.hardware;
    case "/system/version": return { version: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version };
    case "/services": { const services = demo.services(); return { services, count: services.length }; }
    case "/services/detail": return demo.detail(label, q.get("category") ?? "");
    case "/services/job": {
      const s = demo.services().find((x) => x.label === label)!;
      return { label, category: s.category, path: s.plistPath, fileName: `${label}.plist`, xml: demo.jobXml(label), writable: s.writable, needsAdmin: s.needsAdmin, mtime: Date.now() - 86_400_000 };
    }
    case "/services/meta": return { meta: demo.meta };
    case "/services/events": return { events: demo.jobEvents() };
    case "/services/signature": return demo.signature(label);
    case "/services/extras": return demo.extras;
    case "/services/background-items": return { items: demo.backgroundItems };
    case "/services/login-items": return { ok: true, items: [{ name: "Acme", path: "/Applications/Acme.app", hidden: false }] };
    case "/services/power-schedule": return { raw: "", repeating: [{ type: "wakeorpoweron", days: "MTWRF", time: "07:30:00" }, { type: "sleep", days: "MTWRFSU", time: "23:30:00" }] };
    case "/services/monitor-settings": return { notify: true, exclude: ["com.apple."] };
    case "/services/shortcuts": return { shortcuts: ["Weekly Report", "Toggle Focus", "Backup Photos"] };
    case "/services/revisions": return { revisions: [1, 3, 9].map((d) => ({ id: `${label}-r${d}.plist`, at: Date.now() - d * 86_400_000, size: 812 })) };
    case "/services/output": return demo.output;
    case "/services/plists": return { plists: {} };
    case "/services/default-path": return { path: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin" };
    case "/services/browse": return { path: "/Users/alex", parent: "/Users", entries: [], truncated: false };
    case "/processes": { const processes = demo.processes(); return { processes, total: 512, filtered: processes.length }; }
    case "/logs/recent": { const logs = Array.from({ length: 60 }, (_, i) => demo.logEntry(i, Date.now() - (60 - i) * 900)); return { logs, count: logs.length }; }
    case "/logs/active-processes": return { processes: [{ name: "launchd", count: 41, lastSeen: Date.now() }, { name: "node", count: 25, lastSeen: Date.now() }] };
    case "/logs/query": return { logs: Array.from({ length: 12 }, (_, i) => demo.logEntry(i * 3, Date.now() - i * 60_000)), count: 12, truncated: false };
    case "/plugins": return { plugins: [] };
    default:
      if (p.startsWith("/processes/")) return { ...demo.processes()[0], cwd: "/Users/alex/Projects/api", parentChain: [{ pid: 1, ppid: 0, user: "root", command: "launchd" }] };
      return {};
  }
}

// A WebSocket that plays the server: the dashboard shows "Live" and the charts move.
const FAKE_SOCKET = `(() => {
  const Real = window.WebSocket;
  class DemoSocket {
    constructor(url) {
      if (!String(url).endsWith("/ws") && !String(url).includes("/ws?")) return new Real(url);
      this.readyState = 0; this.subs = new Set(); this.n = 0;
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen({}); this.timer = setInterval(() => this.tick(), 400); }, 30);
    }
    async tick() {
      this.n++;
      for (const topic of this.subs) {
        const data = await window.__demoData(topic, this.n);
        if (data == null || this.readyState !== 1) continue;
        this.onmessage && this.onmessage({ data: JSON.stringify({ topic, type: topic === "logs" ? "update" : "snapshot", data, timestamp: Date.now() }) });
      }
    }
    send(raw) {
      const m = JSON.parse(raw);
      const topics = Array.isArray(m.topics) ? m.topics : [m.topic];
      if (m.type === "subscribe") topics.forEach((t) => this.subs.add(t));
      if (m.type === "unsubscribe") topics.forEach((t) => this.subs.delete(t));
    }
    close() { clearInterval(this.timer); this.readyState = 3; }
    addEventListener() {} removeEventListener() {}
  }
  DemoSocket.CONNECTING = 0; DemoSocket.OPEN = 1; DemoSocket.CLOSING = 2; DemoSocket.CLOSED = 3;
  window.WebSocket = DemoSocket;
})();`;

function demoData(topic: string, n: number): unknown {
  if (topic === "system") return demo.systemStats(n);
  if (topic === "processes") return n % 3 === 0 ? demo.processes(n) : null;
  if (topic === "logs") return demo.logEntry(n);
  return null; // services and job-events: the REST snapshot is enough
}

// ── Page helpers ─────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let frame = 0;
let recording = false;

async function recordFor(page: Page, ms: number) {
  if (!recording) return sleep(ms);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const started = Date.now();
    await page.screenshot({ path: join(FRAMES, `f${String(frame++).padStart(5, "0")}.png`) as `${string}.png` });
    await sleep(Math.max(0, 1000 / FPS - (Date.now() - started)));
  }
}

async function clickText(page: Page, text: string, selector = "a, button, [role=button], [role=tab], [role=radio], [role=menuitem]") {
  const ok = await page.evaluate(
    (text, selector) => {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().startsWith(text));
      el?.click();
      return !!el;
    },
    text,
    selector
  );
  if (!ok) throw new Error(`Nothing to click for "${text}"`);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, `${name}.png`) as `${string}.png` });
  console.log(`  ${name}.png`);
}

async function typeInto(page: Page, selector: string, text: string, delay = 45) {
  await page.$eval(selector, (el) => {
    (el as HTMLInputElement).focus();
    (el as HTMLInputElement).select();
  });
  for (const ch of text) {
    await page.keyboard.type(ch);
    await recordFor(page, delay);
  }
}

// ── Scenes ───────────────────────────────────────────────────────────
async function newPage(browser: Awaited<ReturnType<typeof puppeteer.launch>>, theme: "dark" | "light" = "dark", language: "en" | "tr" = "en") {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  await page.exposeFunction("__demoData", demoData);
  await page.evaluateOnNewDocument(FAKE_SOCKET);
  await page.evaluateOnNewDocument(
    (theme, language) => {
      localStorage.setItem("macdash.theme", theme);
      localStorage.setItem("macdash.language", language);
    },
    theme,
    language
  );
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return void req.continue();
    req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(api(req.method(), url)) });
  });
  return page;
}

async function screenshots(browser: Awaited<ReturnType<typeof puppeteer.launch>>) {
  console.log("Screenshots");
  const page = await newPage(browser);

  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle0" });
  await sleep(9000); // let the charts collect some history
  await shot(page, "dashboard");

  await page.goto(`${BASE}/#/services`, { waitUntil: "networkidle0" });
  await sleep(1200);
  await shot(page, "services");

  await clickText(page, "List", "[role=radio]");
  await sleep(600);
  await shot(page, "services-list");

  await clickText(page, "Timeline", "[role=radio]");
  await sleep(600);
  await shot(page, "timeline");

  await clickText(page, "Groups", "[role=radio]");
  await sleep(400);
  await clickText(page, "com.example.backup-documents", "[role=button]");
  await sleep(1800);
  await shot(page, "job-details");

  await clickText(page, "Edit", "[role=dialog] button");
  await sleep(1500);
  await shot(page, "job-editor");

  await clickText(page, "Expert", "[role=tab]");
  await sleep(700);
  await shot(page, "job-editor-xml");
  await page.keyboard.press("Escape");
  await sleep(500);

  await page.goto(`${BASE}/#/services?panel=changes`, { waitUntil: "networkidle0" });
  await sleep(1200);
  await shot(page, "job-changes");

  await page.goto(`${BASE}/#/processes`, { waitUntil: "networkidle0" });
  await sleep(1500);
  await shot(page, "processes");

  await page.goto(`${BASE}/#/logs`, { waitUntil: "networkidle0" });
  await sleep(4000);
  await shot(page, "logs");
  await page.close();

  const light = await newPage(browser, "light");
  await light.goto(`${BASE}/#/services`, { waitUntil: "networkidle0" });
  await sleep(1200);
  await shot(light, "services-light");
  await light.close();

  const turkish = await newPage(browser, "dark", "tr");
  await turkish.goto(`${BASE}/#/services?edit=user-agents/com.example.backup-documents`, { waitUntil: "networkidle0" });
  await sleep(2000);
  await shot(turkish, "job-editor-tr");
  await turkish.close();
}

async function demoGif(browser: Awaited<ReturnType<typeof puppeteer.launch>>) {
  console.log("Demo GIF");
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const page = await newPage(browser);
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: "networkidle0" });
  await sleep(6000);
  recording = true;

  await recordFor(page, 2200);
  await clickText(page, "Services");
  await recordFor(page, 1800);
  await clickText(page, "New job");
  await recordFor(page, 700);
  await clickText(page, "Run at a specific time", "[role=menuitem]");
  await recordFor(page, 1400);
  await typeInto(page, "[role=dialog] input[type=text]", "com.example.morning-report");
  await recordFor(page, 900);
  await clickText(page, "Expert", "[role=tab]");
  await recordFor(page, 2000);
  await clickText(page, "Form", "[role=tab]");
  await recordFor(page, 900);
  await clickText(page, "Save and load", "[role=dialog] button");
  await recordFor(page, 1800);
  await clickText(page, "Timeline", "[role=radio]");
  await recordFor(page, 2200);
  await clickText(page, "Groups", "[role=radio]");
  await recordFor(page, 600);
  await clickText(page, "com.example.backup-documents", "[role=button]");
  await recordFor(page, 2600);
  await page.keyboard.press("Escape");
  await recordFor(page, 500);
  await clickText(page, "Changes");
  await recordFor(page, 2400);

  recording = false;
  await page.close();

  const palette = join(FRAMES, "palette.png");
  const input = ["-framerate", String(FPS), "-i", join(FRAMES, "f%05d.png")];
  const run = (args: string[]) => {
    const p = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...args]);
    if (p.exitCode !== 0) throw new Error(`ffmpeg failed: ${p.stderr.toString()}`);
  };
  run([...input, "-vf", "scale=960:-1:flags=lanczos,palettegen=max_colors=128:stats_mode=diff", palette]);
  run([...input, "-i", palette, "-lavfi", "scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", join(OUT, "demo.gif")]);
  run([...input, "-vf", "scale=1280:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-movflags", "+faststart", join(OUT, "demo.mp4")]);
  rmSync(FRAMES, { recursive: true, force: true });
  console.log("  demo.gif, demo.mp4");
}

/**
 * Web-sized copies for the GitHub Pages site (website/media): WebP plus a PNG fallback, WebM plus MP4.
 * Chrome does the image work in a canvas, so no WebP tool has to be installed.
 */
async function publishToWebsite(browser: Awaited<ReturnType<typeof puppeteer.launch>>) {
  console.log("Website media");
  const site = join(ROOT, "website/media");
  mkdirSync(site, { recursive: true });
  const ffmpeg = (args: string[]) => {
    const p = Bun.spawnSync(["ffmpeg", "-y", "-loglevel", "error", ...args]);
    if (p.exitCode !== 0) throw new Error(`ffmpeg failed: ${p.stderr.toString()}`);
  };

  const mp4 = join(OUT, "demo.mp4");
  const poster = join(OUT, ".poster.png");
  if (existsSync(mp4)) {
    copyFileSync(mp4, join(site, "demo.mp4"));
    ffmpeg(["-i", mp4, "-c:v", "libvpx-vp9", "-crf", "36", "-b:v", "0", "-an", join(site, "demo.webm")]);
    ffmpeg(["-ss", "1", "-i", mp4, "-frames:v", "1", poster]);
  }

  const page = await browser.newPage();
  await page.goto("about:blank");
  const convert = async (source: string, name: string, png: boolean) => {
    const dataUrl = `data:image/png;base64,${readFileSync(source).toString("base64")}`;
    const out = await page.evaluate(
      async (dataUrl, png) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const width = Math.min(1600, img.naturalWidth);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = Math.round((img.naturalHeight * width) / img.naturalWidth);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return { webp: canvas.toDataURL("image/webp", 0.86), png: png ? canvas.toDataURL("image/png") : null };
      },
      dataUrl,
      png
    );
    const write = (file: string, url: string) => writeFileSync(join(site, file), Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
    write(`${name}.webp`, out.webp);
    if (out.png) write(`${name}.png`, out.png);
  };
  for (const file of readdirSync(OUT).filter((f) => f.endsWith(".png") && !f.startsWith("."))) {
    await convert(join(OUT, file), file.replace(/\.png$/, ""), true);
  }
  if (existsSync(poster)) {
    await convert(poster, "demo-poster", false);
    rmSync(poster);
  }
  await page.close();
  console.log(`  ${readdirSync(site).length} files in website/media`);
}

// ── Main ─────────────────────────────────────────────────────────────
mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
try {
  const only = process.argv[2];
  if (only !== "gif" && only !== "site") await screenshots(browser);
  if (only !== "shots" && only !== "site") await demoGif(browser);
  await publishToWebsite(browser);
} finally {
  await browser.close();
  server.stop(true);
}
