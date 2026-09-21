/**
 * launchd-specific localisation: `localizeTrigger` round trips every trigger shape `describeTriggers`
 * can produce, and every issue `code` that `validateJob` can raise has a translation whose declared
 * `params` are all used.
 */
import { describe, expect, test } from "bun:test";
import { setLocale } from "@/i18n";
import { en } from "@/i18n/en";
import { tr } from "@/i18n/tr";
import { describeTriggers, formatInterval, validateJob, type JobIssue } from "@shared/launchd";
import type { PlistDict } from "@shared/plist";
import { localizeCalendarEntry, localizeExitStatus, localizeIssue, localizeTrigger } from "./launchd";

// Tokens that must never survive translation into Turkish. "Mach" is kept on purpose (a proper noun,
// like a signal name), so it is not in this list.
const FORBIDDEN_EN_WORDS =
  /\b(At|load|Keep|alive|conditional|Every|Calendar|Watches|path|paths|Queue|directory|On|mount|Socket|service|Launch|event|minute|hour|day|week|month|every|of|min|Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/;

/** Every distinct trigger tag shape `describeTriggers` / `formatInterval` / `describeCalendarEntry` produce. */
function sampleTriggerTags(): string[] {
  const tags = new Set<string>();
  for (const t of describeTriggers({
    RunAtLoad: true,
    KeepAlive: true,
    StartOnMount: true,
    Sockets: {},
    MachServices: {},
    LaunchEvents: {},
  })) {
    tags.add(t);
  }
  for (const t of describeTriggers({ KeepAlive: { SuccessfulExit: true } })) tags.add(t);
  for (const seconds of [45, 300, 7200, 172800]) tags.add(`Every ${formatInterval(seconds)}`);
  for (const t of describeTriggers({ StartCalendarInterval: [{ Hour: 9, Minute: 0 }] })) tags.add(t);
  for (const t of describeTriggers({ StartCalendarInterval: [{ Weekday: 1, Hour: 8, Minute: 5 }] })) tags.add(t);
  for (const t of describeTriggers({ StartCalendarInterval: [{ Day: 15, Weekday: 5, Hour: 8, Minute: 0 }] })) tags.add(t);
  for (const t of describeTriggers({ StartCalendarInterval: [{ Minute: 15 }] })) tags.add(t);
  for (const t of describeTriggers({ StartCalendarInterval: [{ Hour: 8 }] })) tags.add(t);
  for (const t of describeTriggers({ StartCalendarInterval: [{ Month: 12, Day: 24, Hour: 18, Minute: 0 }] })) tags.add(t);
  for (const t of describeTriggers({ StartCalendarInterval: [{}] })) tags.add(t); // "every minute"
  for (const t of describeTriggers({ StartCalendarInterval: [{ Hour: 1 }, { Hour: 2 }] })) tags.add(t); // "Calendar ×2"
  for (const t of describeTriggers({ WatchPaths: ["/a"] })) tags.add(t); // "Watches 1 path"
  for (const t of describeTriggers({ WatchPaths: ["/a", "/b", "/c"] })) tags.add(t); // "Watches 3 paths"
  for (const t of describeTriggers({ QueueDirectories: ["/a"] })) tags.add(t);
  return [...tags];
}

describe("localizeTrigger", () => {
  const tags = sampleTriggerTags();

  test("covers every describeTriggers shape (sanity check on the fixture itself)", () => {
    expect(tags.length).toBeGreaterThanOrEqual(13);
  });

  test("English is byte-identical to the input, for every shape", () => {
    setLocale("en");
    for (const tag of tags) expect(localizeTrigger(tag)).toBe(tag);
  });

  test("unknown text passes through unchanged in every language", () => {
    const bogus = "Some Unrecognized Tag (v2)";
    setLocale("en");
    expect(localizeTrigger(bogus)).toBe(bogus);
    setLocale("tr");
    expect(localizeTrigger(bogus)).toBe(bogus);
    setLocale("en");
  });

  test("Turkish translates every shape and leaves no stray English word (Mach excepted)", () => {
    setLocale("tr");
    const untranslated: string[] = [];
    const leftoverEnglish: string[] = [];
    for (const tag of tags) {
      const localized = localizeTrigger(tag);
      if (localized === tag) untranslated.push(tag);
      if (FORBIDDEN_EN_WORDS.test(localized)) leftoverEnglish.push(`${tag} -> ${localized}`);
    }
    setLocale("en");
    expect(untranslated).toEqual([]);
    expect(leftoverEnglish).toEqual([]);
  });

  test("localizeTriggers maps every tag through localizeTrigger", () => {
    setLocale("tr");
    const localized = tags.map(localizeTrigger);
    setLocale("en");
    expect(localized).toHaveLength(tags.length);
  });
});

describe("localizeCalendarEntry", () => {
  test("English matches describeCalendarEntry exactly", () => {
    setLocale("en");
    expect(localizeCalendarEntry({ Weekday: 1, Hour: 8, Minute: 5 })).toBe("at 08:05 on Mon");
    expect(localizeCalendarEntry({ Day: 15, Weekday: 5, Hour: 8, Minute: 0 })).toBe("at 08:00 on day 15 or on Fri");
    expect(localizeCalendarEntry({ Minute: 15 })).toBe("at minute 15 of every hour");
  });

  test("Turkish has no leftover English weekday/month abbreviation", () => {
    setLocale("tr");
    const text = localizeCalendarEntry({ Month: 12, Day: 24, Weekday: 5, Hour: 18, Minute: 0 });
    setLocale("en");
    expect(FORBIDDEN_EN_WORDS.test(text)).toBe(false);
  });
});

describe("localizeExitStatus", () => {
  test("English matches explainExitStatus exactly", () => {
    setLocale("en");
    expect(localizeExitStatus(0)).toBe("Success");
    expect(localizeExitStatus(-9)).toBe("Terminated by signal 9 (SIGKILL)");
    expect(localizeExitStatus(143)).toBe("Terminated by signal 15 (SIGTERM)");
    expect(localizeExitStatus(3)).toBe("Exited with code 3");
    expect(localizeExitStatus(null)).toBeNull();
  });

  test("Turkish translates known codes, named signals, and the unknown-code fallback", () => {
    setLocale("tr");
    expect(localizeExitStatus(0)).toBe("Başarılı");
    expect(localizeExitStatus(-9)).toBe("9 numaralı sinyalle sonlandırıldı (SIGKILL)");
    expect(localizeExitStatus(143)).toBe("15 numaralı sinyalle sonlandırıldı (SIGTERM)");
    expect(localizeExitStatus(3)).toBe("3 koduyla çıkıldı");
    setLocale("en");
  });
});

// ── Issue codes: every code validateJob can raise has a translation, and its params are all used ──

function brokenJobs(): [PlistDict, Parameters<typeof validateJob>[1]][] {
  const base = { Label: "com.example.ok", ProgramArguments: ["/bin/sh", "-c", "true"], RunAtLoad: true };
  return [
    [{ ProgramArguments: ["/bin/true"] }, { category: "user-agents" }],
    [{ ...base, Label: "../evil" }, { category: "user-agents" }],
    [base, { category: "user-agents", otherLabels: ["com.example.ok"] }],
    [{ Label: "com.apple.foo", ProgramArguments: ["/bin/true"] }, { category: "user-agents", fileName: "other.plist" }],
    [{ ...base, ProgramArguments: [] }, { category: "user-agents" }],
    [{ ...base, ProgramArguments: ["~/bin/x"] }, { category: "user-agents" }],
    [{ ...base, ProgramArguments: ["bin/x"] }, { category: "user-agents" }],
    [
      { ...base, ProgramArguments: ["/opt/missing"] },
      { category: "user-agents", pathFacts: [{ path: "/opt/missing", exists: false, isFile: false, isDirectory: false, executable: false }] },
    ],
    [
      { ...base, ProgramArguments: ["/Applications/Foo.app"] },
      { category: "user-agents", pathFacts: [{ path: "/Applications/Foo.app", exists: true, isFile: false, isDirectory: true, executable: false }] },
    ],
    [
      { ...base, ProgramArguments: ["/opt/dir"] },
      { category: "user-agents", pathFacts: [{ path: "/opt/dir", exists: true, isFile: false, isDirectory: true, executable: false }] },
    ],
    [
      { ...base, ProgramArguments: ["/opt/tool"] },
      { category: "user-agents", pathFacts: [{ path: "/opt/tool", exists: true, isFile: true, isDirectory: false, executable: false }] },
    ],
    [{ Label: "com.example.ok" }, { category: "user-agents" }],
    [{ ...base, StartInterval: 0 }, { category: "user-agents" }],
    [{ ...base, KeepAlive: true, StartInterval: 300 }, { category: "user-agents" }],
    [{ ...base, StartInterval: 5, ThrottleInterval: 10 }, { category: "user-agents" }],
    [{ ...base, StartCalendarInterval: [{ Bogus: 1 }] }, { category: "user-agents" }],
    [{ ...base, StartCalendarInterval: [{ Hour: 24 }] }, { category: "user-agents" }],
    [{ ...base, KeepAlive: { NetworkState: true } }, { category: "user-agents" }],
    [
      { ...base, WatchPaths: ["/nope"] },
      { category: "user-agents", pathFacts: [{ path: "/nope", exists: false, isFile: false, isDirectory: false, executable: false }] },
    ],
    [
      { ...base, QueueDirectories: ["/opt/tool"] },
      { category: "user-agents", pathFacts: [{ path: "/opt/tool", exists: true, isFile: true, isDirectory: false, executable: false }] },
    ],
    [
      { ...base, WorkingDirectory: "/opt/missing-dir" },
      { category: "user-agents", pathFacts: [{ path: "/opt/missing-dir", exists: false, isFile: false, isDirectory: false, executable: false }] },
    ],
    [
      { ...base, StandardOutPath: "/var/log/x/out.log" },
      { category: "user-agents", pathFacts: [{ path: "/var/log/x", exists: false, isFile: false, isDirectory: false, executable: false }] },
    ],
    [{ ...base, UserName: "root" }, { category: "user-agents" }],
    [{ ...base, LimitLoadToSessionType: "Aqua" }, { category: "global-daemons" }],
    [{ ...base, Nice: 99 }, { category: "user-agents" }],
    [{ ...base, ProcessType: "Bogus" }, { category: "user-agents" }],
    [{ ...base, NotAKey: true }, { category: "user-agents" }],
    [{ ...base, StartInterval: "300" }, { category: "user-agents" }],
    [{ ...base, Debug: true }, { category: "user-agents" }],
  ];
}

function allIssues(): JobIssue[] {
  return brokenJobs().flatMap(([job, opts]) => validateJob(job, opts));
}

describe("issue codes", () => {
  test("every code has a launchd.issue.<code> entry in both languages", () => {
    const missing: string[] = [];
    for (const issue of allIssues()) {
      expect(issue.code, `no code for message: ${issue.message}`).toBeTruthy();
      const key = `launchd.issue.${issue.code}`;
      if (!(key in en)) missing.push(`${key} missing in en`);
      if (!(key in tr)) missing.push(`${key} missing in tr`);
    }
    expect(missing).toEqual([]);
  });

  test("every declared param is used as a {placeholder} in both languages' template", () => {
    const problems: string[] = [];
    for (const issue of allIssues()) {
      const key = `launchd.issue.${issue.code}` as keyof typeof en;
      const enTemplate = en[key];
      const trTemplate = tr[key];
      for (const name of Object.keys(issue.params ?? {})) {
        if (!enTemplate.includes(`{${name}}`)) problems.push(`${key}: {${name}} not used in en template "${enTemplate}"`);
        if (!trTemplate.includes(`{${name}}`)) problems.push(`${key}: {${name}} not used in tr template "${trTemplate}"`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("localizeIssue renders the English message verbatim, and a different string in Turkish", () => {
    setLocale("en");
    for (const issue of allIssues()) expect(localizeIssue(issue)).toBe(issue.message);

    setLocale("tr");
    const untranslated: string[] = [];
    for (const issue of allIssues()) {
      const localized = localizeIssue(issue);
      if (localized === issue.message) untranslated.push(`${issue.code}: ${issue.message}`);
    }
    setLocale("en");
    expect(untranslated).toEqual([]);
  });

  test("an issue without a code keeps its English message in every language", () => {
    const issue: JobIssue = { severity: "warning", key: null, message: "Ad-hoc message from an older backend." };
    setLocale("tr");
    expect(localizeIssue(issue)).toBe(issue.message);
    setLocale("en");
    expect(localizeIssue(issue)).toBe(issue.message);
  });
});
