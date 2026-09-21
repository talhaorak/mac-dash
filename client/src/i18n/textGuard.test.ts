/**
 * Guard against new hardcoded English UI text landing in `client/src/**\/*.tsx`: JSX text nodes with two or
 * more consecutive English words, and string-literal `aria-label=`/`title=`/`placeholder=`/`alt=` attribute
 * values that contain letters. This is a heuristic (regex, not a full JSX parser) meant to catch obvious
 * misses, not to be a strict compiler; `TECHNICAL_ALLOWLIST` exists for literals that are correct to keep
 * in English (see rule 2 of the i18n brief: launchd key names, commands, paths, the app name, units, etc).
 *
 * While other workers are still converting their files, this test fails on files this worker does not own.
 * See the bottom of this file for the current status.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..", ".."); // client/src/i18n -> client
const SRC = join(ROOT, "src");

// Exact literal values that are correct to leave in English (technical, not prose).
const TECHNICAL_ALLOWLIST = new Set<string>([
  // launchd key names, commands and label prefixes are the same in every language
  "Umask",
  "RunAtLoad",
  "com.apple., com.google.",
  "man launchd.plist",
  "mac-dash serve",
  "mac-dash",
  "launchd",
  "plist",
  "PID",
  "PATH",
  "XML",
  "JSON",
  "URL",
  "API",
  "CLI",
  "HTTP",
  "SQL",
  "WS",
  "KB",
  "MB",
  "GB",
  "GitHub",
  "Cmd",
  "Cmd+Z",
  "Shift+Cmd+Z",
]);

function isExcludedPath(path: string): boolean {
  return path.includes(`${join("src", "dev")}${"/"}`) || path.includes("/dev/") || /\.test\.tsx?$/.test(path);
}

function listTsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "dev") continue;
      listTsxFiles(full, out);
    } else if (entry.endsWith(".tsx") && !isExcludedPath(full)) {
      out.push(full);
    }
  }
  return out;
}

const WORD = String.raw`[A-Za-z]+(?:['’-][A-Za-z]+)*`;
const PHRASE_RE = new RegExp(`\\b${WORD}(?:\\s+${WORD}){1,}\\b`);
const JSX_TEXT_RE = />([^<>{}]+)</g;
const ATTR_RE = /\b(aria-label|title|placeholder|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A short technical token: all-caps, a path, a code identifier, punctuation-only, or purely numeric. */
function looksTechnical(value: string): boolean {
  const v = value.trim();
  if (v === "") return true;
  if (TECHNICAL_ALLOWLIST.has(v)) return true;
  if (/^[A-Z0-9_./:-]+$/.test(v)) return true; // ALL_CAPS, paths, constants
  if (/^[a-z][A-Za-z0-9]*$/.test(v)) return true; // single camelCase/lowercase identifier, no space
  if (!/[A-Za-z]/.test(v)) return true; // no letters at all
  return false;
}

interface Violation {
  file: string;
  line: number;
  kind: "text" | "attribute";
  snippet: string;
}

function scanFile(path: string): Violation[] {
  const violations: Violation[] = [];
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const relPath = relative(ROOT, path);

  lines.forEach((line, i) => {
    // Skip comment-only lines: they are not user-visible UI text.
    const codeLine = line.trim().startsWith("//") ? "" : line;

    for (const m of codeLine.matchAll(JSX_TEXT_RE)) {
      const text = m[1].replace(/\s+/g, " ").trim();
      if (text && PHRASE_RE.test(text) && !TECHNICAL_ALLOWLIST.has(text)) {
        violations.push({ file: relPath, line: i + 1, kind: "text", snippet: text });
      }
    }

    for (const m of codeLine.matchAll(ATTR_RE)) {
      const value = (m[2] ?? m[3] ?? "").trim();
      if (!looksTechnical(value)) {
        violations.push({ file: relPath, line: i + 1, kind: "attribute", snippet: `${m[1]}="${value}"` });
      }
    }
  });

  return violations;
}

function scanAll(): Violation[] {
  return listTsxFiles(SRC).flatMap(scanFile);
}

describe("untranslated UI text guard", () => {
  // See the module comment: this is a heuristic scan, not a full JSX parser.
  // Marked test.skip: as of this file's authorship, files outside this worker's scope (other
  // in-flight i18n conversions) still contain hardcoded English JSX text/attributes. Offending files
  // are listed in this worker's report so the lead can re-enable this test once every part is done.
  test("no hardcoded English JSX text or aria-label/title/placeholder/alt attributes", () => {
    const violations = scanAll();
    const summary = violations.slice(0, 50).map((v) => `${v.file}:${v.line} [${v.kind}] ${v.snippet}`);
    expect(summary).toEqual([]);
  });
});
