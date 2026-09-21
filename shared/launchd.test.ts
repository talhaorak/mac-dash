import { describe, expect, test } from "bun:test";
import {
  JOB_TEMPLATES,
  collectPaths,
  describeCalendarEntry,
  describeTriggers,
  explainExitStatus,
  formatInterval,
  nextRuns,
  validateJob,
} from "./launchd";
import { parsePlistDict, serializePlist } from "./plist";

const messages = (issues: ReturnType<typeof validateJob>, severity?: string) =>
  issues.filter((i) => !severity || i.severity === severity).map((i) => `${i.key}: ${i.message}`);

describe("describeTriggers", () => {
  test("summarizes every trigger kind", () => {
    expect(
      describeTriggers({
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        StartInterval: 300,
        StartCalendarInterval: [{ Hour: 9, Minute: 0 }],
        WatchPaths: ["/a", "/b"],
        StartOnMount: true,
      })
    ).toEqual(["At load", "Keep alive (conditional)", "Every 5 min", "Calendar: at 09:00", "Watches 2 paths", "On mount"]);
    expect(describeTriggers({ KeepAlive: true, StartCalendarInterval: [{ Minute: 0 }, { Minute: 30 }] })).toEqual([
      "Keep alive",
      "Calendar ×2",
    ]);
    expect(describeTriggers({ KeepAlive: false, KeepAliveX: true })).toEqual([]);
  });

  test("formats intervals and calendar entries", () => {
    expect([45, 120, 7200, 172800].map(formatInterval)).toEqual(["45 s", "2 min", "2 h", "2 d"]);
    expect(describeCalendarEntry({ Weekday: 1, Hour: 8, Minute: 5 })).toBe("at 08:05 on Mon");
    expect(describeCalendarEntry({ Day: 15, Weekday: 5, Hour: 8, Minute: 0 })).toBe("at 08:00 on day 15 or on Fri");
    expect(describeCalendarEntry({ Minute: 15 })).toBe("at minute 15 of every hour");
    expect(describeCalendarEntry({ Month: 12, Day: 24, Hour: 18, Minute: 0 })).toBe("at 18:00 on day 24 in Dec");
  });
});

describe("validateJob", () => {
  const base = { Label: "com.example.ok", ProgramArguments: ["/bin/sh", "-c", "true"], RunAtLoad: true };

  test("accepts a plain job and every template", () => {
    expect(validateJob(base, { category: "user-agents" })).toEqual([]);
    for (const template of JOB_TEMPLATES) {
      const job = template.build("com.example.t");
      expect(messages(validateJob(job, { category: "user-agents" }), "error")).toEqual([]);
      expect(parsePlistDict(serializePlist(job))).toEqual(job);
    }
  });

  test("blocks a missing label, a bad label, a duplicate and an empty program", () => {
    const blocking = (job: Parameters<typeof validateJob>[0], others: string[] = []) =>
      validateJob(job, { category: "user-agents", otherLabels: others }).filter((i) => i.blocking).length;
    expect(blocking({ ProgramArguments: ["/bin/true"] })).toBe(1);
    expect(blocking({ ...base, Label: "../evil" })).toBe(1);
    expect(blocking(base, ["com.example.ok"])).toBe(1);
    expect(blocking({ Label: "com.example.ok" })).toBe(1);
    expect(blocking({ ...base, StartInterval: "300" })).toBe(1); // wrong type
  });

  test("uses path facts", () => {
    const job = { ...base, ProgramArguments: ["/opt/tool"], StandardOutPath: "/var/log/x/out.log" };
    expect(collectPaths(job).sort()).toEqual(["/opt/tool", "/var/log/x"]);
    const issues = validateJob(job, {
      category: "user-agents",
      pathFacts: [
        { path: "/opt/tool", exists: true, isFile: true, isDirectory: false, executable: false },
        { path: "/var/log/x", exists: false, isFile: false, isDirectory: false, executable: false },
      ],
    });
    expect(messages(issues).join("\n")).toContain("not executable");
    expect(messages(issues).join("\n")).toContain("Folder does not exist: /var/log/x");
    expect(issues.some((i) => i.blocking)).toBe(false);
  });

  test("warns about scope mismatches, tilde paths and missing triggers", () => {
    const text = messages(
      validateJob(
        { Label: "com.example.ok", ProgramArguments: ["~/bin/x"], UserName: "root", WorkingDirectory: "~/w" },
        { category: "user-agents", fileName: "other.plist" }
      )
    ).join("\n");
    expect(text).toContain("launchd does not expand ~");
    expect(text).toContain("UserName is ignored for agents");
    expect(text).toContain("No trigger is set");
    expect(text).toContain('File name "other.plist" does not match the label');
  });

  test("checks calendar ranges", () => {
    const issues = validateJob({ ...base, StartCalendarInterval: [{ Hour: 24 }, { Minute: 59 }] }, { category: "user-agents" });
    expect(messages(issues, "error")).toEqual(["StartCalendarInterval: Schedule 1: Hour must be an integer between 0 and 23."]);
  });
});

describe("nextRuns", () => {
  const from = new Date(2026, 8, 21, 10, 30); // Monday 21 Sep 2026, 10:30 local

  test("daily, weekly and monthly entries", () => {
    expect(nextRuns({ Hour: 9, Minute: 0 }, from, 2).map((d) => [d.getDate(), d.getHours()])).toEqual([[22, 9], [23, 9]]);
    expect(nextRuns({ Hour: 12, Minute: 0 }, from, 1)[0].getDate()).toBe(21);
    expect(nextRuns({ Weekday: 7, Hour: 8, Minute: 0 }, from, 1)[0].getDay()).toBe(0); // 7 is Sunday
    expect(nextRuns({ Day: 1, Hour: 0, Minute: 0 }, from, 1)[0].getMonth()).toBe(9);
  });

  test("Day and Weekday together mean either one", () => {
    // from Monday 21 Sep: Friday 25 Sep matches the weekday, 1 Oct matches the day
    const runs = nextRuns({ Day: 1, Weekday: 5, Hour: 6, Minute: 0 }, from, 3).map((d) => `${d.getMonth() + 1}/${d.getDate()}`);
    expect(runs).toEqual(["9/25", "10/1", "10/2"]);
  });

  test("hourly entry and the every-minute marker", () => {
    expect(nextRuns({ Minute: 45 }, from, 3).map((d) => d.getHours())).toEqual([10, 11, 12]);
    expect(nextRuns({ Weekday: 1 }, from, 5)).toHaveLength(1);
  });
});

describe("explainExitStatus", () => {
  test("names signals and sysexits codes", () => {
    expect(explainExitStatus(null)).toBeNull();
    expect(explainExitStatus(0)).toBe("Success");
    expect(explainExitStatus(-9)).toBe("Terminated by signal 9 (SIGKILL)");
    expect(explainExitStatus(143)).toBe("Terminated by signal 15 (SIGTERM)");
    expect(explainExitStatus(78)).toContain("EX_CONFIG");
    expect(explainExitStatus(3)).toBe("Exited with code 3");
  });
});
