import { describe, expect, test } from "bun:test";
import {
  DEFAULT_UMASK,
  formatMode,
  formatOctal,
  gridToUmask,
  modeUnderUmask,
  normalizeUmask,
  parseUmaskString,
  toggleUmaskBit,
  umaskBit,
  umaskToGrid,
} from "./umask";
import {
  findMatches,
  lineOfIndex,
  matchIndexFrom,
  matchLayerHtml,
  replaceAllMatches,
  replaceMatch,
  scrollTopForLine,
  stepMatch,
} from "./findReplace";
import {
  DRAFT_MAX_LENGTH,
  clearDraft,
  jobDraftKey,
  parseDraft,
  readDraft,
  writeDraft,
  type DraftStorage,
} from "./drafts";
import { APP_NAME_PATTERN, appNameProblem, buildOpenArgs, defaultAppName, parseOpenArgs } from "./scriptApp";
import { authorityChain, describeSignature } from "./signature";
import type { JobSignature } from "../../lib/backend";

// ── Umask ────────────────────────────────────────────────────────────

describe("umask", () => {
  test("octal 022 is decimal 18", () => {
    expect(DEFAULT_UMASK).toBe(18);
    expect(formatOctal(18)).toBe("022");
    expect(formatOctal(0)).toBe("000");
    expect(formatOctal(0o777)).toBe("777");
  });

  test("bits follow the rwx order, owner first", () => {
    expect(umaskBit(0, 0)).toBe(0o400);
    expect(umaskBit(0, 2)).toBe(0o100);
    expect(umaskBit(1, 1)).toBe(0o020);
    expect(umaskBit(2, 2)).toBe(0o001);
  });

  test("grid marks the masked permissions", () => {
    expect(umaskToGrid(0o022)).toEqual([
      [false, false, false],
      [false, true, false],
      [false, true, false],
    ]);
    expect(umaskToGrid(0o077)[0]).toEqual([false, false, false]);
    expect(umaskToGrid(0o077)[2]).toEqual([true, true, true]);
  });

  test("grid and integer round-trip for every value", () => {
    for (let mask = 0; mask <= 0o777; mask++) expect(gridToUmask(umaskToGrid(mask))).toBe(mask);
  });

  test("toggle flips one bit", () => {
    expect(toggleUmaskBit(0o022, 2, 0)).toBe(0o026);
    expect(toggleUmaskBit(0o026, 2, 0)).toBe(0o022);
    expect(toggleUmaskBit(0, 0, 0)).toBe(0o400);
  });

  test("only the nine permission bits are kept", () => {
    expect(normalizeUmask(0o4022)).toBe(0o022);
    expect(normalizeUmask(18.9)).toBe(18);
    expect(normalizeUmask(Number.NaN)).toBe(0);
    expect(toggleUmaskBit(0o4022, 1, 1)).toBe(0o002);
  });

  test("resulting modes", () => {
    expect(modeUnderUmask(0o022, "file")).toBe(0o644);
    expect(modeUnderUmask(0o022, "folder")).toBe(0o755);
    expect(formatMode(0o644)).toBe("rw-r--r--");
    expect(formatMode(0o750)).toBe("rwxr-x---");
  });

  test("string values follow strtoul(3) with base 0", () => {
    expect(parseUmaskString("022")).toBe(18);
    expect(parseUmaskString("0")).toBe(0);
    expect(parseUmaskString("18")).toBe(18);
    expect(parseUmaskString("0x12")).toBe(18);
    expect(parseUmaskString(" 077 ")).toBe(63);
    expect(parseUmaskString("+22")).toBe(22);
    expect(parseUmaskString("089")).toBeNull();
    expect(parseUmaskString("rwx")).toBeNull();
    expect(parseUmaskString("")).toBeNull();
    expect(parseUmaskString("-1")).toBeNull();
  });
});

// ── Find and replace ─────────────────────────────────────────────────

describe("find and replace", () => {
  const text = "<key>Label</key>\n<string>com.example.label</string>\n<key>LABEL</key>";

  test("case-insensitive by default, literal, non-overlapping", () => {
    expect(findMatches(text, "label", false)).toHaveLength(3);
    expect(findMatches(text, "label", true)).toHaveLength(1);
    expect(findMatches("aaaa", "aa", true)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(findMatches(text, "", false)).toEqual([]);
  });

  test("regular expression characters are literal", () => {
    expect(findMatches("a.b axb", "a.b", true)).toEqual([{ start: 0, end: 3 }]);
    expect(findMatches("cost: $5 (five)", "$5 (", true)).toEqual([{ start: 6, end: 10 }]);
    expect(findMatches("[a]\\d", "\\d", true)).toEqual([{ start: 3, end: 5 }]);
  });

  test("case folding keeps the indexes of the original text", () => {
    const t = "İstanbul label";
    const [m] = findMatches(t, "LABEL", false);
    expect(t.slice(m.start, m.end)).toBe("label");
  });

  test("the limit caps the list", () => {
    expect(findMatches("a".repeat(100), "a", true, 10)).toHaveLength(10);
  });

  test("first match from the caret, with wrap-around", () => {
    const matches = findMatches(text, "label", false);
    expect(matchIndexFrom(matches, 0)).toBe(0);
    expect(matchIndexFrom(matches, 6)).toBe(1);
    expect(matchIndexFrom(matches, text.length)).toBe(0);
    expect(matchIndexFrom([], 0)).toBe(-1);
  });

  test("next and previous wrap", () => {
    expect(stepMatch(0, 3, 1)).toBe(1);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(-1, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  test("replace one match, replacement is literal", () => {
    const r = replaceMatch("run $HOME now", { start: 4, end: 9 }, "$1&");
    expect(r.text).toBe("run $1& now");
    expect(r.caret).toBe(7);
  });

  test("replace all", () => {
    expect(replaceAllMatches(text, "label", "X", false)).toEqual({
      text: "<key>X</key>\n<string>com.example.X</string>\n<key>X</key>",
      count: 3,
    });
    expect(replaceAllMatches(text, "label", "X", true).count).toBe(1);
    expect(replaceAllMatches("aaa", "a", "aa", true)).toEqual({ text: "aaaaaa", count: 3 });
    expect(replaceAllMatches("abc", "", "x", true)).toEqual({ text: "abc", count: 0 });
    expect(replaceAllMatches("a b", "a", "$&$&", true).text).toBe("$&$& b");
  });

  test("line of an index", () => {
    expect(lineOfIndex(text, 0)).toBe(0);
    expect(lineOfIndex(text, 16)).toBe(0); // the newline itself belongs to line 0
    expect(lineOfIndex(text, 17)).toBe(1);
    expect(lineOfIndex(text, text.length)).toBe(2);
    expect(lineOfIndex("", 5)).toBe(0);
  });

  test("scroll position: keep when visible, centre otherwise", () => {
    // line 2 sits at 12 + 2 × 20 = 52 px
    expect(scrollTopForLine(2, 0, 300)).toBe(0);
    expect(scrollTopForLine(100, 0, 300)).toBe(12 + 100 * 20 - 140);
    expect(scrollTopForLine(0, 500, 300)).toBe(0);
    expect(scrollTopForLine(30, 600, 300)).toBe(600); // 612..632 is inside 600..900
  });

  test("the match layer escapes the text before it adds markup", () => {
    const evil = '<img src=x onerror="alert(1)"> & <script>x</script>';
    const html = matchLayerHtml(evil, findMatches(evil, "script", false), 1);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&amp;");
    expect(html.match(/<mark/g)).toHaveLength(2);
    expect(html.match(/<mark data-current/g)).toHaveLength(1);
    // Without the markup it is exactly the escaped source text.
    expect(html.replace(/<\/?mark[^>]*>/g, "")).toBe(evil.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
  });

  test("a query made of markup characters cannot break out of the mark", () => {
    const t = "a </mark><b> b";
    const html = matchLayerHtml(t, findMatches(t, "</mark><b>", true), 0);
    expect(html).toContain("&lt;/mark&gt;&lt;b&gt;</mark>");
    expect(html).not.toContain("<b>");
  });
});

// ── Drafts ───────────────────────────────────────────────────────────

function memoryStorage(): DraftStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("drafts", () => {
  test("key format", () => {
    expect(jobDraftKey({ mode: "new" })).toBe("macdash.jobDraft:new:user-agents/new");
    expect(jobDraftKey({ mode: "new", category: "global-daemons" })).toBe("macdash.jobDraft:new:global-daemons/new");
    expect(jobDraftKey({ mode: "edit", job: { label: "com.example.a", category: "user-agents" } })).toBe(
      "macdash.jobDraft:edit:user-agents/com.example.a"
    );
    expect(jobDraftKey({ mode: "duplicate", job: { label: "com.example.a", category: "system-daemons" } })).toBe(
      "macdash.jobDraft:duplicate:system-daemons/com.example.a"
    );
  });

  test("write, read, clear", () => {
    const storage = memoryStorage();
    const key = jobDraftKey({ mode: "new" });
    const draft = { xml: "<plist/>", category: "user-agents" as const, savedAt: 1700000000000 };
    expect(readDraft(storage, key)).toBeNull();
    expect(writeDraft(storage, key, draft)).toBe(true);
    expect(readDraft(storage, key)).toEqual(draft);
    clearDraft(storage, key);
    expect(readDraft(storage, key)).toBeNull();
  });

  test("drafts over 200 KB are not stored", () => {
    const storage = memoryStorage();
    expect(writeDraft(storage, "k", { xml: "x".repeat(DRAFT_MAX_LENGTH + 1), category: "user-agents", savedAt: 1 })).toBe(false);
    expect(storage.data.size).toBe(0);
    expect(writeDraft(storage, "k", { xml: "x".repeat(DRAFT_MAX_LENGTH), category: "user-agents", savedAt: 1 })).toBe(true);
  });

  test("broken or foreign values are ignored", () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft("not json")).toBeNull();
    expect(parseDraft("null")).toBeNull();
    expect(parseDraft(JSON.stringify({ xml: 1, category: "user-agents", savedAt: 1 }))).toBeNull();
    expect(parseDraft(JSON.stringify({ xml: "x", category: "nope", savedAt: 1 }))).toBeNull();
    expect(parseDraft(JSON.stringify({ xml: "x", category: "user-agents", savedAt: 1e20 }))).toBeNull(); // not a valid date
    // A draft never moves a job into a read-only scope.
    expect(parseDraft(JSON.stringify({ xml: "x", category: "system-daemons", savedAt: 1 }))).toBeNull();
    expect(parseDraft(JSON.stringify({ xml: "x", category: "global-agents", savedAt: 1, extra: true }))).toEqual({
      xml: "x",
      category: "global-agents",
      savedAt: 1,
    });
  });

  test("a throwing or missing storage never throws", () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readDraft(broken, "k")).toBeNull();
    expect(writeDraft(broken, "k", { xml: "x", category: "user-agents", savedAt: 1 })).toBe(false);
    expect(() => clearDraft(broken, "k")).not.toThrow();
    expect(readDraft(null, "k")).toBeNull();
    expect(writeDraft(null, "k", { xml: "x", category: "user-agents", savedAt: 1 })).toBe(false);
  });
});

// ── Wrap a script in an app ──────────────────────────────────────────

describe("script app", () => {
  test("default name comes from the script file name", () => {
    expect(defaultAppName("/Users/me/bin/backup.sh")).toBe("backup");
    expect(defaultAppName("/Users/me/bin/nightly backup.command")).toBe("nightly backup");
    expect(defaultAppName("/usr/local/bin/sync_photos")).toBe("sync_photos");
    expect(defaultAppName("/Users/me/çöp/_yedek (1).py")).toBe("yedek -1");
    expect(defaultAppName("/")).toBe("Script");
    expect(defaultAppName("/Users/me/.sh")).toBe("Script");
    expect(defaultAppName(`/x/${"a".repeat(100)}.sh`)).toHaveLength(64);
  });

  test("default names always pass the backend pattern", () => {
    for (const p of ["/a/b.sh", "/a/ü.sh", "/a/-x-.rb", "/a/... .sh", "/a/" + "long name ".repeat(12)]) {
      expect(defaultAppName(p)).toMatch(APP_NAME_PATTERN);
    }
  });

  test("name validation", () => {
    expect(appNameProblem("Backup")).toBeNull();
    expect(appNameProblem("My Backup 2.0_x-y")).toBeNull();
    expect(appNameProblem("")).not.toBeNull();
    expect(appNameProblem(" x")).not.toBeNull();
    expect(appNameProblem("a/b")).not.toBeNull();
    expect(appNameProblem('a"b')).not.toBeNull();
    expect(appNameProblem("a".repeat(65))).not.toBeNull();
  });

  test("open arguments round-trip", () => {
    const built = buildOpenArgs({ app: "/Users/me/Applications/Backup.app", wait: true, rest: [] });
    expect(built).toEqual(["/usr/bin/open", "-W", "-a", "/Users/me/Applications/Backup.app"]);
    expect(parseOpenArgs(built)).toEqual({ app: "/Users/me/Applications/Backup.app", wait: true, rest: [] });
    expect(parseOpenArgs(["/usr/bin/open", "-a", "Safari", "https://example.com"])).toEqual({
      app: "Safari",
      wait: false,
      rest: ["https://example.com"],
    });
    expect(parseOpenArgs(["/usr/bin/open", "-a"])).toEqual({ app: "", wait: false, rest: [] });
    expect(parseOpenArgs(["/usr/bin/open", "/tmp/file.txt"])).toBeNull();
    expect(parseOpenArgs(["/bin/sh", "-a", "x"])).toBeNull();
    expect(parseOpenArgs([])).toBeNull();
  });
});

// ── Code signature summary ───────────────────────────────────────────

describe("signature summary", () => {
  const base: JobSignature = {
    path: "/usr/local/bin/tool",
    signed: true,
    identifier: "com.foo.tool",
    authorities: [],
    teamId: null,
    apple: false,
    trusted: false,
    adhoc: false,
    error: null,
  };
  const appleChain = ["Software Signing", "Apple Code Signing Certification Authority", "Apple Root CA"];

  test("Apple, when the backend verified it", () => {
    const sig = { ...base, apple: true, trusted: true, authorities: appleChain };
    expect(describeSignature(sig)).toEqual({ text: "Apple (verified)", tone: "ok" });
    expect(authorityChain(sig)).toBe("Software Signing → Apple Code Signing Certification Authority → Apple Root CA");
  });

  test("an authority NAME never makes a job Apple's", () => {
    // Self-signed certificate that imitates Apple's names. `apple` and `trusted` are false.
    expect(describeSignature({ ...base, authorities: appleChain })).toEqual({
      text: "Software Signing: the certificate was not issued by Apple",
      tone: "warning",
    });
    expect(describeSignature({ ...base, authorities: ["Apple Mac OS Application Signing"], teamId: "ABCDE12345" }).tone).toBe("warning");
    expect(describeSignature({ ...base, authorities: ["Developer ID Application: Foo Inc (ABCDE12345)"], teamId: "ABCDE12345" }).tone).toBe("warning");
  });

  test("verified Developer ID shows the leaf authority", () => {
    const leaf = "Developer ID Application: Foo Inc (ABCDE12345)";
    expect(
      describeSignature({ ...base, trusted: true, teamId: "ABCDE12345", authorities: [leaf, "Developer ID Certification Authority", "Apple Root CA"] })
    ).toEqual({ text: `${leaf}, verified`, tone: "ok" });
    expect(describeSignature({ ...base, trusted: true, teamId: "ABCDE12345", authorities: ["Apple Development: Foo"] }).text).toBe(
      "Apple Development: Foo (ABCDE12345), verified"
    );
  });

  test("verified Mac App Store apps name the team", () => {
    expect(describeSignature({ ...base, trusted: true, teamId: "ABCDE12345", authorities: ["Apple Mac OS Application Signing"] })).toEqual({
      text: "Mac App Store (ABCDE12345), verified",
      tone: "ok",
    });
  });

  test("untrusted chain without names falls back to the identifier", () => {
    expect(describeSignature(base).text).toBe("com.foo.tool: the certificate was not issued by Apple");
    expect(describeSignature({ ...base, identifier: null }).text).toBe("Signed: the certificate was not issued by Apple");
  });

  test("unsigned and ad-hoc code is a warning", () => {
    expect(describeSignature({ ...base, signed: false, identifier: null })).toEqual({ text: "Not signed", tone: "warning" });
    expect(describeSignature({ ...base, adhoc: true })).toEqual({ text: "Ad-hoc signature (no identity)", tone: "warning" });
  });

  test("errors show their text", () => {
    expect(describeSignature({ ...base, signed: false, path: null, error: "Executable not found" })).toEqual({
      text: "Executable not found",
      tone: "muted",
    });
  });

  test("verified without an authority list", () => {
    expect(describeSignature({ ...base, trusted: true }).text).toBe("com.foo.tool, verified");
    expect(describeSignature({ ...base, trusted: true, identifier: null, teamId: "T1" }).text).toBe("Signed (T1), verified");
  });
});
