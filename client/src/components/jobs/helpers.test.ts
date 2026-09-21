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
import { HISTORY_COALESCE_MS, HISTORY_LIMIT, canRedo, canUndo, createHistory, historyShortcut, isTextEntry, recordEdit, redo, sealHistory, undo } from "./editorHistory";
import { EDITOR_THEMES, EDITOR_THEME_STORAGE_KEY, appearanceFrom, contrastRatio, editorTheme, readEditorTheme, themeVariables, writeEditorTheme } from "./editorThemes";
import {
  MAX_TREE_DEPTH,
  PLIST_TYPES,
  SOCKET_KEYS,
  arrayFromRows,
  base64Bytes,
  convertValue,
  defaultForType,
  describeContainer,
  dictFromRows,
  duplicateRowKeys,
  moveItem,
  nestedKeyOptionsFor,
  parseScalarText,
  plistSignature,
  plistTypeOf,
  presetsForKey,
  reconcileRows,
  rowsFromValue,
  scalarText,
  uniqueKey,
  type TreeRow,
} from "./PlistTreeEditor";
import {
  PICKER_SHORTCUTS,
  baseName,
  breadcrumbs,
  canOpen,
  canPick,
  entryKind,
  fileNameProblem,
  joinPath,
  normalizeBrowseResult,
  parentPath,
  picksOpenFolder,
  startFolder,
  visibleEntries,
} from "./PathPicker";
import { LOG_PREDICATE_MAX, buildLogPredicate, logRowsAsText, normalizeLogResult, predicateLiteral, selectLogRows, type LogRow } from "./JobLogTab";
import { SCRIPT_INTERPRETERS, buildDropJob, dropLabel } from "./FileDrop";
import { DEFAULT_PATH, initialValueForSpec, isUsablePath, needsAutoPath, newKeyProblem, readAutoPath, withAutoPath, writeAutoPath } from "./JobForm";
import { KEY_SPEC, LABEL_PATTERN, LAUNCHD_KEYS, validateJob } from "../../../../shared/launchd";
import { PlistData, PlistReal, parsePlist, serializePlist, type PlistDict, type PlistValue } from "../../../../shared/plist";

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

// ── Editor history ───────────────────────────────────────────────────

describe("editor history", () => {
  const snap = (xml: string, category: "user-agents" | "global-agents" = "user-agents") => ({ xml, category });

  test("a new history has nothing to undo or redo", () => {
    const h = createHistory(snap("a"));
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  test("an edit that changes nothing is not recorded", () => {
    const h = createHistory(snap("a"));
    expect(recordEdit(h, snap("a"), 1000)).toBe(h);
  });

  test("undo and redo walk the steps", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("b"), 1000);
    h = recordEdit(h, snap("c"), 5000);
    expect(h.past.map((s) => s.xml)).toEqual(["a", "b"]);
    h = undo(h);
    expect(h.present.xml).toBe("b");
    h = undo(h);
    expect(h.present.xml).toBe("a");
    expect(canUndo(h)).toBe(false);
    h = redo(redo(h));
    expect(h.present.xml).toBe("c");
    expect(canRedo(h)).toBe(false);
  });

  test("edits within the coalesce window are one step", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("ab"), 1000);
    h = recordEdit(h, snap("abc"), 1000 + HISTORY_COALESCE_MS);
    h = recordEdit(h, snap("abcd"), 1000 + 2 * HISTORY_COALESCE_MS);
    expect(h.past).toHaveLength(1);
    expect(undo(h).present.xml).toBe("a");
    // A pause starts a new step.
    h = recordEdit(h, snap("abcde"), 1001 + 3 * HISTORY_COALESCE_MS);
    expect(h.past).toHaveLength(2);
    expect(undo(h).present.xml).toBe("abcd");
  });

  test("a burst that ends where it started leaves no step", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("ab"), 1000);
    h = recordEdit(h, snap("a"), 1100);
    expect(canUndo(h)).toBe(false);
    expect(h.present.xml).toBe("a");
  });

  test("the first edit after undo or redo is a step of its own", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("b"), 1000);
    h = recordEdit(h, snap("c"), 3000);
    h = undo(h);
    h = recordEdit(h, snap("d"), 3100);
    expect(h.past.map((s) => s.xml)).toEqual(["a", "b"]);
    expect(h.present.xml).toBe("d");
  });

  test("an edit clears the redo list", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("b"), 1000);
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = recordEdit(h, snap("x"), 9000);
    expect(canRedo(h)).toBe(false);
  });

  test("a sealed step does not take the next edit", () => {
    let h = createHistory(snap("a"));
    h = sealHistory(recordEdit(h, snap("b"), 1000));
    h = recordEdit(h, snap("c"), 1001);
    expect(h.past.map((s) => s.xml)).toEqual(["a", "b"]);
    const untouched = createHistory(snap("a"));
    expect(sealHistory(untouched)).toBe(untouched);
  });

  test("the scope is part of a snapshot", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("a", "global-agents"), 1000);
    expect(canUndo(h)).toBe(true);
    expect(undo(h).present.category).toBe("user-agents");
  });

  test("the history keeps the newest 200 steps", () => {
    let h = createHistory(snap("0"));
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = recordEdit(h, snap(String(i)), i * 10_000);
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    expect(h.past[0].xml).toBe("50");
    expect(h.present.xml).toBe(String(HISTORY_LIMIT + 50));
  });

  test("a clock that goes back does not merge steps", () => {
    let h = createHistory(snap("a"));
    h = recordEdit(h, snap("b"), 5000);
    h = recordEdit(h, snap("c"), 4000);
    expect(h.past).toHaveLength(2);
  });

  test("shortcuts", () => {
    const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({
      key: k,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...mods,
    });
    expect(historyShortcut(key("z", { metaKey: true }))).toBe("undo");
    expect(historyShortcut(key("z", { ctrlKey: true }))).toBe("undo");
    expect(historyShortcut(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(historyShortcut(key("z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(historyShortcut(key("y", { ctrlKey: true }))).toBe("redo");
    expect(historyShortcut(key("y", { metaKey: true }))).toBeNull();
    expect(historyShortcut(key("z"))).toBeNull();
    expect(historyShortcut(key("z", { metaKey: true, altKey: true }))).toBeNull();
    expect(historyShortcut(key("x", { metaKey: true }))).toBeNull();
  });

  test("text fields keep their own undo", () => {
    expect(isTextEntry({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: null })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "number" })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "search" })).toBe(true);
    expect(isTextEntry({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTextEntry({ tagName: "INPUT", type: "RADIO" })).toBe(false);
    expect(isTextEntry({ tagName: "SELECT" })).toBe(false);
    expect(isTextEntry({ tagName: "BUTTON" })).toBe(false);
    expect(isTextEntry({ tagName: "DIV" })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});

// ── Editor themes ────────────────────────────────────────────────────

describe("editor themes", () => {
  test("four themes, the first one is the default", () => {
    expect(EDITOR_THEMES.map((t) => t.name)).toEqual(["Default", "Solarized", "Monokai", "High contrast"]);
    expect(editorTheme(null).id).toBe("default");
    expect(editorTheme("no-such-theme").id).toBe("default");
    expect(editorTheme("monokai").id).toBe("monokai");
  });

  test("every colour is readable on the editor background, dark and light", () => {
    for (const theme of EDITOR_THEMES) {
      for (const appearance of ["dark", "light"] as const) {
        const p = theme[appearance];
        const floor = theme.id === "contrast" ? 7 : 4.5;
        for (const role of ["text", "tag", "key", "value", "comment", "caret"] as const) {
          const ratio = contrastRatio(p[role], p.surface);
          if (!(ratio >= floor)) throw new Error(`${theme.id}/${appearance}/${role}: contrast ${ratio.toFixed(2)} is under ${floor}`);
        }
      }
    }
  });

  test("the light palette is light and the dark palette is dark", () => {
    for (const theme of EDITOR_THEMES) {
      expect(contrastRatio(theme.light.surface, "#000000")).toBeGreaterThan(12);
      expect(contrastRatio(theme.dark.surface, "#ffffff")).toBeGreaterThan(12);
    }
  });

  test("contrast ratio follows WCAG", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 1);
  });

  test("variables for the container", () => {
    const vars = themeVariables("solarized", "light");
    expect(vars["--xml-bg"]).toBe("#fdf6e3");
    expect(Object.keys(vars).sort()).toEqual(["--xml-bg", "--xml-caret", "--xml-comment", "--xml-key", "--xml-tag", "--xml-text", "--xml-value"]);
    expect(themeVariables(undefined, "dark")).toEqual(themeVariables("default", "dark"));
  });

  test("appearance of the app", () => {
    expect(appearanceFrom({})).toBe("dark");
    expect(appearanceFrom({ dataTheme: "light" })).toBe("light");
    expect(appearanceFrom({ dataTheme: "Dark", classNames: ["light"] })).toBe("dark");
    expect(appearanceFrom({ classNames: ["app", "light"] })).toBe("light");
    expect(appearanceFrom({ classNames: ["dark"], colorScheme: "light" })).toBe("dark");
    expect(appearanceFrom({ colorScheme: "light" })).toBe("light");
    expect(appearanceFrom({ colorScheme: "light dark" })).toBe("dark");
    expect(appearanceFrom({ colorScheme: "normal" })).toBe("dark");
  });

  test("the choice is stored, and a broken storage is ignored", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(readEditorTheme(storage)).toBe("default");
    writeEditorTheme(storage, "contrast");
    expect(map.get(EDITOR_THEME_STORAGE_KEY)).toBe("contrast");
    expect(readEditorTheme(storage)).toBe("contrast");
    map.set(EDITOR_THEME_STORAGE_KEY, "<script>");
    expect(readEditorTheme(storage)).toBe("default");
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readEditorTheme(broken)).toBe("default");
    expect(() => writeEditorTheme(broken, "monokai")).not.toThrow();
    expect(readEditorTheme(null)).toBe("default");
  });
});

// ── Plist tree ───────────────────────────────────────────────────────

describe("plist tree values", () => {
  const NOW = new Date("2026-03-04T05:06:07.890Z");

  test("type of a value", () => {
    expect(plistTypeOf("x")).toBe("string");
    expect(plistTypeOf(3)).toBe("integer");
    expect(plistTypeOf(3.5)).toBe("real");
    expect(plistTypeOf(new PlistReal(3))).toBe("real");
    expect(plistTypeOf(false)).toBe("boolean");
    expect(plistTypeOf(NOW)).toBe("date");
    expect(plistTypeOf(new PlistData("AA=="))).toBe("data");
    expect(plistTypeOf([])).toBe("array");
    expect(plistTypeOf({})).toBe("dict");
  });

  test("every type has a default that serializes and parses back to the same type", () => {
    for (const type of PLIST_TYPES) {
      const value = defaultForType(type, NOW);
      expect(plistTypeOf(value)).toBe(type);
      expect(plistTypeOf(parsePlist(serializePlist(value)))).toBe(type);
    }
    expect((defaultForType("date", NOW) as Date).toISOString()).toBe("2026-03-04T05:06:07.000Z");
  });

  test("scalar text", () => {
    expect(scalarText("a b")).toBe("a b");
    expect(scalarText(-4)).toBe("-4");
    expect(scalarText(new PlistReal(1.5))).toBe("1.5");
    expect(scalarText(true)).toBe("true");
    expect(scalarText(NOW)).toBe("2026-03-04T05:06:07Z");
    expect(scalarText(new Date(Number.NaN))).toBe("");
    expect(scalarText(new PlistData("aGk="))).toBe("aGk=");
    expect(scalarText([1])).toBe("");
  });

  test("parse what the user types", () => {
    expect(parseScalarText("string", " keep spaces ")).toBe(" keep spaces ");
    expect(parseScalarText("integer", " 42 ")).toBe(42);
    expect(parseScalarText("integer", "-7")).toBe(-7);
    expect(parseScalarText("integer", "")).toBeNull();
    expect(parseScalarText("integer", "-")).toBeNull();
    expect(parseScalarText("integer", "1.5")).toBeNull();
    expect(parseScalarText("integer", "0x10")).toBeNull();
    expect(parseScalarText("integer", "99999999999999999999")).toBeNull();
    expect(parseScalarText("real", "1.")).toEqual(new PlistReal(1));
    expect(parseScalarText("real", ".5")).toEqual(new PlistReal(0.5));
    expect(parseScalarText("real", "-2e3")).toEqual(new PlistReal(-2000));
    expect(parseScalarText("real", "1e999")).toBeNull();
    expect(parseScalarText("real", "abc")).toBeNull();
    expect(parseScalarText("boolean", "true")).toBe(true);
    expect(parseScalarText("boolean", "yes")).toBeNull();
    expect(parseScalarText("date", "2026-01-31T09:00:00Z")).toEqual(new Date("2026-01-31T09:00:00Z"));
    expect(parseScalarText("date", "2026-01-31T09:00:00.750+03:00")).toEqual(new Date("2026-01-31T06:00:00Z"));
    expect(parseScalarText("date", "2026-01-31")).toEqual(new Date("2026-01-31T00:00:00Z"));
    expect(parseScalarText("date", "2026-01-31T09:00:00")).toBeNull();
    expect(parseScalarText("date", "2026-13-40T09:00:00Z")).toBeNull();
    expect(parseScalarText("date", "tomorrow")).toBeNull();
    expect(parseScalarText("data", "aGVs\n bG8=")).toEqual(new PlistData("aGVsbG8="));
    expect(parseScalarText("data", "")).toEqual(new PlistData(""));
    expect(parseScalarText("data", "abc")).toBeNull();
    expect(parseScalarText("data", "a*c=")).toBeNull();
    expect(parseScalarText("array", "x")).toBeNull();
  });

  test("base64 size", () => {
    expect(base64Bytes("")).toBe(0);
    expect(base64Bytes("aGVsbG8=")).toBe(5);
    expect(base64Bytes("aGk=")).toBe(2);
    expect(base64Bytes("YWJj")).toBe(3);
    expect(base64Bytes("YQ==")).toBe(1);
  });

  test("type changes keep what the new type can hold", () => {
    expect(convertValue("42", "integer")).toBe(42);
    expect(convertValue("4.7", "integer")).toBe(4);
    expect(convertValue("abc", "integer")).toBe(0);
    expect(convertValue(3, "real")).toEqual(new PlistReal(3));
    expect(convertValue(new PlistReal(2.9), "integer")).toBe(2);
    expect(convertValue(8080, "string")).toBe("8080");
    expect(convertValue(true, "string")).toBe("true");
    expect(convertValue("TRUE", "boolean")).toBe(true);
    expect(convertValue("no", "boolean")).toBe(false);
    expect(convertValue(0, "boolean")).toBe(false);
    expect(convertValue(true, "integer")).toBe(1);
    expect(convertValue("2026-01-31T09:00:00Z", "date")).toEqual(new Date("2026-01-31T09:00:00Z"));
    expect(convertValue("not a date", "date", NOW)).toEqual(new Date("2026-03-04T05:06:07Z"));
    expect(convertValue("aGk=", "data")).toEqual(new PlistData("aGk="));
    expect(convertValue("not base64!", "data")).toEqual(new PlistData(""));
    expect(convertValue("x", "array")).toEqual(["x"]);
    expect(convertValue("", "array")).toEqual([]);
    expect(convertValue({ a: 1, b: "two" }, "array")).toEqual([1, "two"]);
    expect(convertValue([1, "two"], "dict")).toEqual({ item1: 1, item2: "two" });
    expect(convertValue("x", "dict")).toEqual({});
    expect(convertValue(["only"], "string")).toBe("only");
    expect(convertValue(["a", "b"], "string")).toBe("");
    expect(convertValue([["nested"]], "string")).toBe("");
    const same = { a: 1 };
    expect(convertValue(same, "dict")).toBe(same);
  });

  test("the signature tells types apart where JSON does not", () => {
    const date = new Date("2026-01-31T09:00:00Z");
    expect(JSON.stringify(date)).toBe(JSON.stringify(date.toISOString()));
    expect(plistSignature(date)).not.toBe(plistSignature(date.toISOString()));
    expect(plistSignature(1)).not.toBe(plistSignature(new PlistReal(1)));
    expect(plistSignature(new PlistData("aGk="))).not.toBe(plistSignature({ base64: "aGk=" }));
    expect(plistSignature({ a: [1, { b: true }] })).toBe(plistSignature({ a: [1, { b: true }] }));
    expect(plistSignature(undefined)).toBe("");
  });

  test("container summary", () => {
    expect(describeContainer([])).toBe("0 items");
    expect(describeContainer([1])).toBe("1 item");
    expect(describeContainer({ a: 1 })).toBe("1 entry");
    expect(describeContainer({ a: 1, b: 2 })).toBe("2 entries");
  });
});

describe("plist tree rows", () => {
  const ids = () => {
    let n = 100;
    return () => ++n;
  };
  const row = (id: number, key: string, value: PlistValue): TreeRow => ({ id, key, value });

  test("rows keep the order of the value and get their own ids", () => {
    expect(rowsFromValue({ b: 1, a: "x" }, ids())).toEqual([row(101, "b", 1), row(102, "a", "x")]);
    expect(rowsFromValue(["x", true], ids())).toEqual([row(101, "", "x"), row(102, "", true)]);
    const auto = rowsFromValue([1, 2, 3]);
    expect(new Set(auto.map((r) => r.id)).size).toBe(3);
  });

  test("a row without a key is kept in the rows and left out of the dictionary", () => {
    const rows = [row(1, "SockType", "stream"), row(2, "", "pending")];
    expect(dictFromRows(rows)).toEqual({ SockType: "stream" });
    expect(rows).toHaveLength(2);
  });

  test("a transient duplicate key keeps both rows, and the last one is saved", () => {
    const rows = [row(1, "Sock", "first"), row(2, "SockType", "stream"), row(3, "Sock", "second")];
    expect(duplicateRowKeys(rows)).toEqual(["Sock"]);
    expect(dictFromRows(rows)).toEqual({ Sock: "second", SockType: "stream" });
    // The user finishes the name: nothing was lost.
    const renamed = rows.map((r) => (r.id === 3 ? { ...r, key: "SockFamily" } : r));
    expect(duplicateRowKeys(renamed)).toEqual([]);
    expect(dictFromRows(renamed)).toEqual({ Sock: "first", SockType: "stream", SockFamily: "second" });
    expect(duplicateRowKeys([row(1, "", 1), row(2, "", 2)])).toEqual([]);
  });

  test("arrays", () => {
    expect(arrayFromRows([row(1, "", "a"), row(2, "", 2)])).toEqual(["a", 2]);
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    const list = ["a", "b"];
    expect(moveItem(list, 0, -1)).toBe(list);
    expect(moveItem(list, 1, 2)).toBe(list);
    expect(moveItem(list, 1, 1)).toBe(list);
  });

  test("an outside change keeps the ids of the rows that are still there", () => {
    const previous = [row(1, "a", 1), row(2, "b", 2), row(3, "", "typing")];
    expect(reconcileRows(previous, { b: 20, c: 3, a: 1 }, ids())).toEqual([row(2, "b", 20), row(101, "c", 3), row(1, "a", 1)]);
    const items = [row(7, "", "x"), row(8, "", "y")];
    expect(reconcileRows(items, ["x", "y", "z"], ids())).toEqual([row(7, "", "x"), row(8, "", "y"), row(101, "", "z")]);
    expect(reconcileRows(items, ["only"], ids())).toEqual([row(7, "", "only")]);
    // An array that became a dictionary: no row of the array has a key, so every id is new or taken once.
    const mixed = reconcileRows(items, { first: 1, second: 2 }, ids());
    expect(new Set(mixed.map((r) => r.id)).size).toBe(2);
  });

  test("unique keys", () => {
    expect(uniqueKey("Listeners", [])).toBe("Listeners");
    expect(uniqueKey("Listeners", ["Listeners"])).toBe("Listeners2");
    expect(uniqueKey("Listeners", ["Listeners", "Listeners2"])).toBe("Listeners3");
  });
});

describe("plist tree presets", () => {
  test("Sockets: a socket named Listeners, and one more without a collision", () => {
    const [preset] = presetsForKey("Sockets");
    expect(preset.label).toBe("Add socket");
    const one = preset.apply(undefined);
    expect(one).toEqual({ Listeners: { SockServiceName: "8080", SockType: "stream", SockFamily: "IPv4" } });
    const two = preset.apply(one) as PlistDict;
    expect(Object.keys(two)).toEqual(["Listeners", "Listeners2"]);
    expect(two.Listeners).toBe((one as PlistDict).Listeners);
    expect(nestedKeyOptionsFor("Sockets")).toBe(SOCKET_KEYS);
    expect(SOCKET_KEYS).toEqual(["SockType", "SockPassive", "SockNodeName", "SockServiceName", "SockFamily", "SockProtocol", "SockPathName", "SecureSocketWithKey", "SockPathMode", "Bonjour", "MulticastGroup"]);
    expect(nestedKeyOptionsFor("MachServices")).toBeUndefined();
  });

  test("MachServices: name: true, named after the job", () => {
    const [preset] = presetsForKey("MachServices", "com.example.agent");
    expect(preset.apply(undefined)).toEqual({ "com.example.agent": true });
    expect(preset.apply({ "com.example.agent": true })).toEqual({ "com.example.agent": true, "com.example.agent2": true });
    expect(presetsForKey("MachServices")[0].apply(undefined)).toEqual({ "com.example.service": true });
  });

  test("LaunchEvents: com.apple.iokit.matching keeps the events that exist", () => {
    const [preset] = presetsForKey("LaunchEvents");
    const first = preset.apply({ "com.apple.notifyd.matching": { x: { Notification: "n" } } }) as PlistDict;
    expect(Object.keys(first)).toEqual(["com.apple.notifyd.matching", "com.apple.iokit.matching"]);
    const stream = first["com.apple.iokit.matching"] as PlistDict;
    expect(stream["com.example.device-attached"]).toEqual({ IOProviderClass: "IOUSBDevice", idVendor: 1452, idProduct: 4779, IOMatchLaunchStream: true });
    const second = preset.apply(first) as PlistDict;
    expect(Object.keys(second["com.apple.iokit.matching"] as PlistDict)).toEqual(["com.example.device-attached", "com.example.device-attached2"]);
  });

  test("a preset result is a job launchd.ts accepts as a trigger", () => {
    const job = { Label: "com.example.a", ProgramArguments: ["/usr/bin/true"], Sockets: presetsForKey("Sockets")[0].apply(undefined) };
    const issues = validateJob(job, { category: "user-agents" });
    expect(issues.filter((i) => i.severity !== "info")).toEqual([]);
  });

  test("other keys have no preset", () => {
    expect(presetsForKey("SpawnConstraint")).toEqual([]);
    expect(presetsForKey("AnythingElse")).toEqual([]);
  });

  test("depth limit", () => {
    expect(MAX_TREE_DEPTH).toBe(12);
  });
});

// ── Add key, PATH ────────────────────────────────────────────────────

describe("add key", () => {
  test("the first value of every documented key has the type launchd expects", () => {
    for (const spec of LAUNCHD_KEYS) {
      if (spec.key === "Label") continue;
      const job = { Label: "com.example.a", ProgramArguments: ["/usr/bin/true"], [spec.key]: initialValueForSpec(spec) };
      const wrongType = validateJob(job, { category: "global-daemons" }).filter((i) => i.key === spec.key && i.message.includes("wrong type"));
      expect(wrongType).toEqual([]);
    }
  });

  test("integers start inside their range", () => {
    expect(initialValueForSpec(KEY_SPEC.get("StartInterval")!)).toBe(1);
    expect(initialValueForSpec(KEY_SPEC.get("Nice")!)).toBe(0);
    expect(initialValueForSpec(KEY_SPEC.get("ExitTimeOut")!)).toBe(0);
    expect(initialValueForSpec(KEY_SPEC.get("ProcessType")!)).toBe("Background");
  });

  test("name problems", () => {
    const job = { Label: "a", RunAtLoad: true };
    expect(newKeyProblem("", job)).not.toBeNull();
    expect(newKeyProblem(" Sockets", job)).not.toBeNull();
    expect(newKeyProblem("RunAtLoad", job)).toContain("already");
    expect(newKeyProblem("Sockets", job)).toBeNull();
    expect(newKeyProblem("MyOwnKey", job)).toBeNull();
  });
});

describe("automatic PATH", () => {
  test("PATH is added when it is not set", () => {
    expect(withAutoPath({ Label: "a" }, "/usr/bin:/bin")).toEqual({ Label: "a", EnvironmentVariables: { PATH: "/usr/bin:/bin" } });
    expect(withAutoPath({ Label: "a", EnvironmentVariables: { HOME: "/x" } }, "/usr/bin")).toEqual({ Label: "a", EnvironmentVariables: { HOME: "/x", PATH: "/usr/bin" } });
  });

  test("a job with a PATH, or with a broken EnvironmentVariables, stays as it is", () => {
    const withPath = { Label: "a", EnvironmentVariables: { PATH: "/custom" } };
    expect(needsAutoPath(withPath)).toBe(false);
    expect(withAutoPath(withPath, "/usr/bin")).toBe(withPath);
    const emptyPath = { Label: "a", EnvironmentVariables: { PATH: "" } };
    expect(withAutoPath(emptyPath, "/usr/bin")).toBe(emptyPath);
    const broken = { Label: "a", EnvironmentVariables: ["PATH=/x"] };
    expect(needsAutoPath(broken)).toBe(false);
    expect(withAutoPath(broken, "/usr/bin")).toBe(broken);
  });

  test("only a real PATH is taken from the backend", () => {
    expect(isUsablePath(DEFAULT_PATH)).toBe(true);
    expect(isUsablePath("/usr/bin")).toBe(true);
    expect(isUsablePath("")).toBe(false);
    expect(isUsablePath("/usr/bin::/bin")).toBe(false);
    expect(isUsablePath("bin:/usr/bin")).toBe(false);
    expect(isUsablePath("/usr/bin\n/bin")).toBe(false);
    expect(isUsablePath(null)).toBe(false);
    expect(isUsablePath({ path: "/usr/bin" })).toBe(false);
    expect(isUsablePath("/a".repeat(3000))).toBe(false);
  });

  test("the setting is on by default", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(readAutoPath(storage)).toBe(true);
    writeAutoPath(storage, false);
    expect(map.get("macdash.autoPath")).toBe("0");
    expect(readAutoPath(storage)).toBe(false);
    writeAutoPath(storage, true);
    expect(readAutoPath(storage)).toBe(true);
    expect(readAutoPath(null)).toBe(true);
    expect(
      readAutoPath({
        getItem: () => {
          throw new Error("blocked");
        },
      })
    ).toBe(true);
  });
});

// ── Path picker ──────────────────────────────────────────────────────

describe("path picker", () => {
  const entry = (name: string, flags: Partial<{ isDirectory: boolean; isApp: boolean; executable: boolean; hidden: boolean }> = {}) => ({
    name,
    isDirectory: false,
    isApp: false,
    executable: false,
    hidden: name.startsWith("."),
    ...flags,
  });
  const folder = entry("bin", { isDirectory: true });
  const app = entry("Safari.app", { isDirectory: true, isApp: true });
  const tool = entry("rsync", { executable: true });
  const text = entry("notes.txt");

  test("paths", () => {
    expect(joinPath("/", "bin")).toBe("/bin");
    expect(joinPath("/usr", "bin")).toBe("/usr/bin");
    expect(parentPath("/usr/local/bin")).toBe("/usr/local");
    expect(parentPath("/usr/")).toBe("/");
    expect(parentPath("/usr")).toBe("/");
    expect(parentPath("/")).toBeNull();
    expect(parentPath("relative/path")).toBeNull();
    expect(baseName("/usr/local/bin/")).toBe("bin");
    expect(baseName("/")).toBe("");
  });

  test("breadcrumbs", () => {
    expect(breadcrumbs("/")).toEqual([{ name: "/", path: "/" }]);
    expect(breadcrumbs("/Users/me/My Scripts")).toEqual([
      { name: "/", path: "/" },
      { name: "Users", path: "/Users" },
      { name: "me", path: "/Users/me" },
      { name: "My Scripts", path: "/Users/me/My Scripts" },
    ]);
  });

  test("kinds", () => {
    expect([folder, app, tool, text].map(entryKind)).toEqual(["folder", "app", "executable", "file"]);
  });

  test("what Enter does, by mode", () => {
    const table = [folder, app, tool, text];
    const open = (mode: Parameters<typeof canOpen>[1]) => table.map((e) => canOpen(e, mode));
    const pick = (mode: Parameters<typeof canPick>[1]) => table.map((e) => canPick(e, mode));
    expect(open("file")).toEqual([true, true, false, false]);
    expect(pick("file")).toEqual([false, false, true, true]);
    expect(pick("executable")).toEqual([false, false, true, false]);
    expect(open("app")).toEqual([true, false, false, false]);
    expect(pick("app")).toEqual([false, true, false, false]);
    expect(pick("folder")).toEqual([false, false, false, false]);
    expect(open("folder")).toEqual([true, true, false, false]);
    expect(pick("any")).toEqual([false, false, true, true]);
    expect(["file", "folder", "executable", "app", "any"].map((m) => picksOpenFolder(m as Parameters<typeof canPick>[1]))).toEqual([false, true, false, false, true]);
    // No entry is both opened and picked: Enter has one meaning.
    for (const mode of ["file", "folder", "executable", "app", "any"] as const) for (const e of table) expect(canOpen(e, mode) && canPick(e, mode)).toBe(false);
  });

  test("the folder the picker starts in", () => {
    expect(startFolder("/usr/local/bin/rsync", "executable")).toBe("/usr/local/bin");
    expect(startFolder("/Users/me/logs/", "folder")).toBe("/Users/me/logs");
    expect(startFolder("/Users/me/logs/out.log", "file")).toBe("/Users/me/logs");
    expect(startFolder("/Applications/Safari.app", "app")).toBe("/Applications");
    expect(startFolder("Safari", "app")).toBe("/Applications");
    expect(startFolder("", "file")).toBe("");
    expect(startFolder(undefined, "folder")).toBe("");
    expect(startFolder("~/bin/x", "file")).toBe("");
    expect(startFolder("/x", "any")).toBe("/");
  });

  test("filter and hidden files", () => {
    const all = [folder, entry(".zshrc"), entry("Backup.SH"), text];
    expect(visibleEntries(all, "", false).map((e) => e.name)).toEqual(["bin", "Backup.SH", "notes.txt"]);
    expect(visibleEntries(all, "", true)).toHaveLength(4);
    expect(visibleEntries(all, " .sh ", true).map((e) => e.name)).toEqual(["Backup.SH"]);
    expect(visibleEntries(all, "zsh", false)).toEqual([]);
  });

  test("a listing from the backend is checked", () => {
    const good = normalizeBrowseResult({ path: "/bin", parent: "/", entries: [{ name: "sh", isDirectory: false, isApp: false, executable: true, hidden: false }], truncated: false });
    expect(good.entries[0]).toEqual({ name: "sh", isDirectory: false, isApp: false, executable: true, hidden: false });
    const loose = normalizeBrowseResult({ path: "/usr/bin", entries: [{ name: "x" }, null, { name: "" }, "text", { name: "d", isDirectory: 1 }] });
    expect(loose.parent).toBe("/usr");
    expect(loose.truncated).toBe(false);
    expect(loose.entries).toEqual([
      { name: "x", isDirectory: false, isApp: false, executable: false, hidden: false },
      { name: "d", isDirectory: false, isApp: false, executable: false, hidden: false },
    ]);
    expect(normalizeBrowseResult({ path: "/", parent: null, entries: [] }).parent).toBeNull();
    for (const bad of [null, undefined, "x", [], { path: "relative", entries: [] }, { path: "/x" }, { entries: [] }, { ok: false, error: "no" }]) {
      expect(() => normalizeBrowseResult(bad)).toThrow();
    }
  });

  test("new file names", () => {
    expect(fileNameProblem("job.out.log")).toBeNull();
    expect(fileNameProblem("")).not.toBeNull();
    expect(fileNameProblem("  ")).not.toBeNull();
    expect(fileNameProblem("logs/job.log")).not.toBeNull();
    expect(fileNameProblem("..")).not.toBeNull();
  });

  test("shortcuts", () => {
    expect(PICKER_SHORTCUTS.map((s) => (s.home ? `~/${s.path}` : s.path))).toEqual(["~/", "/Applications", "/usr/local/bin", "/opt/homebrew/bin", "~/Library/LaunchAgents"]);
  });
});

// ── Job log ──────────────────────────────────────────────────────────

describe("job log", () => {
  test("predicate: process, subsystem and message", () => {
    expect(buildLogPredicate("com.example.backup", "/usr/local/bin/backup")).toBe(
      'process == "backup" OR subsystem == "com.example.backup" OR eventMessage CONTAINS "com.example.backup"'
    );
  });

  test("a job without a program has no process clause", () => {
    const expected = 'subsystem == "com.example.a" OR eventMessage CONTAINS "com.example.a"';
    expect(buildLogPredicate("com.example.a", null)).toBe(expected);
    expect(buildLogPredicate("com.example.a", "")).toBe(expected);
    expect(buildLogPredicate("com.example.a", "/")).toBe(expected);
  });

  test("backslash and double quote are escaped", () => {
    expect(predicateLiteral('a"b')).toBe('"a\\"b"');
    expect(predicateLiteral("a\\b")).toBe('"a\\\\b"');
    expect(predicateLiteral('\\"')).toBe('"\\\\\\""');
    expect(buildLogPredicate('x" OR 1 == 1 OR "', '/tmp/my "tool"')).toBe(
      'process == "my \\"tool\\"" OR subsystem == "x\\" OR 1 == 1 OR \\"" OR eventMessage CONTAINS "x\\" OR 1 == 1 OR \\""'
    );
  });

  test("the longest label fits. A longer predicate drops clauses from the end", () => {
    const label = "com.example." + "x".repeat(189); // 201 characters, the limit of a label
    expect(LABEL_PATTERN.test(label)).toBe(true);
    const full = buildLogPredicate(label, "/usr/bin/tool");
    expect(full.length).toBeLessThanOrEqual(LOG_PREDICATE_MAX);
    expect(full).toContain("eventMessage CONTAINS");

    const tool = "t".repeat(80);
    const shorter = buildLogPredicate(label, `/usr/bin/${tool}`);
    expect(shorter.length).toBeLessThanOrEqual(LOG_PREDICATE_MAX);
    expect(shorter).toBe(`process == "${tool}" OR subsystem == "${label}"`);
  });

  const row = (timestamp: string, level: LogRow["level"], message: string, process = "backup"): LogRow => ({ timestamp, level, process, pid: 7, message, subsystem: null });

  test("both backend shapes are read, and wrong shapes give no rows", () => {
    const entry = { timestamp: "2026-09-21 10:00:00.000", level: "error", process: "backup", pid: 12, message: "failed", subsystem: "com.example", category: "x" };
    expect(normalizeLogResult({ logs: [entry], count: 1, truncated: true })).toEqual({
      rows: [{ timestamp: entry.timestamp, level: "error", process: "backup", pid: 12, message: "failed", subsystem: "com.example" }],
      truncated: true,
    });
    expect(normalizeLogResult([entry]).rows).toHaveLength(1);
    expect(normalizeLogResult([entry]).truncated).toBe(false);
    expect(normalizeLogResult([{ level: "fatal", pid: "12" }, null, "text"]).rows).toEqual([{ timestamp: "", level: "default", process: "", pid: null, message: "", subsystem: null }]);
    for (const bad of [null, undefined, "x", 5, {}, { logs: "no" }]) expect(normalizeLogResult(bad)).toEqual({ rows: [], truncated: false });
  });

  test("filter by text and level", () => {
    const rows = [row("2026-09-21 10:00:01", "info", "Started"), row("2026-09-21 10:00:02", "error", "Disk FULL"), row("2026-09-21 10:00:03", "error", "other", "launchd")];
    expect(selectLogRows(rows, { text: "full", level: "all", newestFirst: true }).map((r) => r.message)).toEqual(["Disk FULL"]);
    expect(selectLogRows(rows, { text: "", level: "error", newestFirst: true }).map((r) => r.message)).toEqual(["other", "Disk FULL"]);
    expect(selectLogRows(rows, { text: "launchd", level: "all", newestFirst: true }).map((r) => r.message)).toEqual(["other"]);
    expect(selectLogRows(rows, { text: "nothing", level: "all", newestFirst: true })).toEqual([]);
  });

  test("order, and the cap keeps the newest rows in both orders", () => {
    const rows = [row("2026-09-21 10:00:02", "info", "b"), row("2026-09-21 10:00:01", "info", "a"), row("2026-09-21 10:00:03", "info", "c")];
    expect(selectLogRows(rows, { text: "", level: "all", newestFirst: true }).map((r) => r.message)).toEqual(["c", "b", "a"]);
    expect(selectLogRows(rows, { text: "", level: "all", newestFirst: false }).map((r) => r.message)).toEqual(["a", "b", "c"]);
    expect(selectLogRows(rows, { text: "", level: "all", newestFirst: true, limit: 2 }).map((r) => r.message)).toEqual(["c", "b"]);
    expect(selectLogRows(rows, { text: "", level: "all", newestFirst: false, limit: 2 }).map((r) => r.message)).toEqual(["b", "c"]);
    expect(rows.map((r) => r.message)).toEqual(["b", "a", "c"]);
    const many = Array.from({ length: 700 }, (_, i) => row(`2026-09-21 10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, "info", String(i)));
    const capped = selectLogRows(many, { text: "", level: "all", newestFirst: true });
    expect(capped).toHaveLength(500);
    expect(capped[0].message).toBe("699");
  });

  test("copy text", () => {
    expect(logRowsAsText([row("2026-09-21 10:00:01", "warning", "slow"), { ...row("t", "info", "m"), pid: null }])).toBe("2026-09-21 10:00:01 WARNING backup[7]: slow\nt INFO backup: m");
  });
});

// ── File drop ────────────────────────────────────────────────────────

describe("file drop", () => {
  const file = { exists: true, isFile: true, isDirectory: false, executable: false };
  const exe = { ...file, executable: true };
  const dir = { exists: true, isFile: false, isDirectory: true, executable: true };

  test("labels are valid and not taken", () => {
    expect(dropLabel("/Applications/Visual Studio Code.app", [])).toBe("local.visual-studio-code");
    expect(dropLabel("/Users/me/bin/Nightly Backup.sh", ["local.nightly-backup"])).toBe("local.nightly-backup-2");
    expect(dropLabel("/Users/me/Résumé (final).py", [])).toBe("local.resume-final");
    expect(dropLabel("/Users/me/日本語", [])).toBe("local.job");
    expect(dropLabel("/Users/me/.hidden", [])).toBe("local.hidden");
    for (const path of ["/a/" + "x".repeat(300) + ".sh", "/a/--..--", "/a/ ", "/a/9.app"]) expect(LABEL_PATTERN.test(dropLabel(path, []))).toBe(true);
  });

  test("an app opens at login, with or without facts", () => {
    const built = buildDropJob("/Applications/Safari.app/", null, []);
    expect(built).toEqual({ kind: "app", job: { Label: "local.safari", ProgramArguments: ["/usr/bin/open", "-a", "/Applications/Safari.app"], RunAtLoad: true } });
    expect(parseOpenArgs(built!.job.ProgramArguments as string[])?.app).toBe("/Applications/Safari.app");
    expect(buildDropJob("/Applications/Safari.APP", dir, [])?.kind).toBe("app");
  });

  test("an executable runs as it is, a script gets its interpreter", () => {
    expect(buildDropJob("/usr/local/bin/backup", exe, [])?.job.ProgramArguments).toEqual(["/usr/local/bin/backup"]);
    expect(buildDropJob("/Users/me/run.sh", exe, [])).toEqual({ kind: "program", job: { Label: "local.run", ProgramArguments: ["/Users/me/run.sh"], RunAtLoad: true } });
    expect(buildDropJob("/Users/me/run.PY", file, [])).toEqual({ kind: "script", job: { Label: "local.run", ProgramArguments: ["/usr/bin/python3", "/Users/me/run.PY"], RunAtLoad: true } });
    for (const [ext, interpreter] of Object.entries(SCRIPT_INTERPRETERS)) {
      expect(buildDropJob(`/Users/me/tool.${ext}`, file, [])?.job.ProgramArguments).toEqual([interpreter, `/Users/me/tool.${ext}`]);
    }
  });

  test("a folder, or a file that cannot run, is watched", () => {
    expect(buildDropJob("/Users/me/Inbox/", dir, [])).toEqual({ kind: "watch-folder", job: { Label: "local.inbox", ProgramArguments: ["/bin/sh", "-c", "echo changed"], WatchPaths: ["/Users/me/Inbox"] } });
    expect(buildDropJob("/Users/me/notes.txt", file, [])?.kind).toBe("watch-file");
    expect(buildDropJob("/Users/me/notes.txt", file, [])?.job.WatchPaths).toEqual(["/Users/me/notes.txt"]);
  });

  test("every built job passes the blocking checks", () => {
    for (const built of [buildDropJob("/Applications/Safari.app", null, []), buildDropJob("/x/run.sh", file, []), buildDropJob("/x/tool", exe, []), buildDropJob("/x/dir", dir, []), buildDropJob("/x/a.txt", file, [])]) {
      expect(validateJob(built!.job, { category: "user-agents" }).filter((i) => i.blocking)).toEqual([]);
    }
  });

  test("what cannot start a job", () => {
    expect(buildDropJob("relative/path.sh", file, [])).toBeNull();
    expect(buildDropJob("/", dir, [])).toBeNull();
    expect(buildDropJob("/Users/me/run.sh", null, [])).toBeNull();
    expect(buildDropJob("/Users/me/gone.sh", { exists: false, isFile: false, isDirectory: false, executable: false }, [])).toBeNull();
    expect(buildDropJob("/dev/null", { exists: true, isFile: false, isDirectory: false, executable: false }, [])).toBeNull();
  });
});
