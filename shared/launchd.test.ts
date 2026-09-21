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
import { parsePlistDict, serializePlist, type PlistDict } from "./plist";

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

  test("every issue carries a stable code, and declared params match the message's interpolated values", () => {
    const jobs: [PlistDict, Parameters<typeof validateJob>[1]][] = [
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
        {
          category: "user-agents",
          pathFacts: [{ path: "/Applications/Foo.app", exists: true, isFile: false, isDirectory: true, executable: false }],
        },
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
      [{ Label: "com.example.ok", ProgramArguments: ["/bin/true"] }, { category: "user-agents" }],
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

    const seen = new Set<string>();
    for (const [job, opts] of jobs) {
      for (const issue of validateJob(job, opts)) {
        expect(issue.code, `missing code for message: ${issue.message}`).toBeTruthy();
        seen.add(issue.code!);
        for (const [name, value] of Object.entries(issue.params ?? {})) {
          expect(issue.message, `param "${name}" (${value}) not found in message for code ${issue.code}`).toContain(String(value));
        }
      }
    }

    // Every code this test exercises, so a future message change without a matching test update is caught.
    expect([...seen].sort()).toEqual(
      [
        "label_required",
        "label_pattern",
        "label_duplicate",
        "label_apple_prefix",
        "file_name_mismatch",
        "nothing_to_run",
        "program_arguments_empty",
        "tilde_not_expanded",
        "program_not_absolute",
        "executable_missing",
        "executable_is_app",
        "executable_is_directory",
        "executable_not_executable",
        "no_trigger",
        "start_interval_min",
        "start_interval_keepalive_noop",
        "start_interval_throttled",
        "calendar_unknown_field",
        "calendar_field_range",
        "keepalive_network_state_unsupported",
        "path_missing",
        "queue_directory_not_a_directory",
        "working_directory_missing",
        "log_folder_missing",
        "key_ignored_for_agents",
        "session_type_ignored_for_daemons",
        "nice_range",
        "process_type_invalid",
        "key_undocumented",
        "key_wrong_type",
        "key_deprecated",
      ].sort()
    );
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
