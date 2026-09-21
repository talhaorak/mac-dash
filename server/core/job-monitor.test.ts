import { describe, expect, test } from "bun:test";
import { JobError } from "./launchctl";
import { findNewFailures, normalizeMonitorSettings, notificationText, shouldNotify, type ExitStatuses, type JobEvent } from "./job-monitor";

const job = (label: string, lastExitStatus: number | null, extra: Partial<Parameters<typeof findNewFailures>[1][number]> = {}) => ({
  label,
  category: "user-agents" as const,
  plistPath: `/Users/me/Library/LaunchAgents/${label}.plist`,
  writable: true,
  loaded: true,
  lastExitStatus,
  ...extra,
});

describe("findNewFailures", () => {
  test("the first pass is the baseline", () => {
    const { next, failed } = findNewFailures(null, [job("a", 78), job("b", 0), job("c", null)]);
    expect(failed).toEqual([]);
    expect([...next]).toEqual([
      ["user-agents/a", 78],
      ["user-agents/b", 0],
      ["user-agents/c", null],
    ]);
  });

  test("reports a status that changed to a value other than 0", () => {
    const previous: ExitStatuses = new Map([
      ["user-agents/ok-to-bad", 0],
      ["user-agents/never-to-bad", null],
      ["user-agents/bad-to-other", 78],
      ["user-agents/same", 78],
      ["user-agents/bad-to-ok", 1],
      ["user-agents/signal", 0],
    ]);
    const { failed } = findNewFailures(previous, [
      job("ok-to-bad", 1),
      job("never-to-bad", 127),
      job("bad-to-other", 2),
      job("same", 78),
      job("bad-to-ok", 0),
      job("signal", -9),
    ]);
    expect(failed.map((s) => [s.label, s.lastExitStatus])).toEqual([
      ["ok-to-bad", 1],
      ["never-to-bad", 127],
      ["bad-to-other", 2],
      ["signal", -9],
    ]);
  });

  test("a job installed after the baseline starts at 'never exited'", () => {
    const { failed } = findNewFailures(new Map(), [job("fresh", 78), job("fresh-ok", 0)]);
    expect(failed.map((s) => s.label)).toEqual(["fresh"]);
  });

  test("ignores read-only scopes, services without a plist and jobs that are not loaded", () => {
    const previous: ExitStatuses = new Map();
    const { next, failed } = findNewFailures(previous, [
      job("com.apple.thing", 1, { category: "system-agents", writable: false }),
      job("no-file", 1, { plistPath: null, writable: false }),
      job("unloaded", 1, { loaded: false }),
    ]);
    expect(failed).toEqual([]);
    expect([...next]).toEqual([["user-agents/unloaded", null]]);
  });

  test("the same label in two scopes is two jobs", () => {
    const previous: ExitStatuses = new Map([
      ["user-agents/twin", 0],
      ["global-agents/twin", 3],
    ]);
    const { failed } = findNewFailures(previous, [job("twin", 3), job("twin", 3, { category: "global-agents" })]);
    expect(failed.map((s) => s.category)).toEqual(["user-agents"]);
  });

  test("a job that fails again after a reload is reported again", () => {
    const loaded = findNewFailures(new Map([["user-agents/a", 78]]), [job("a", null)]);
    expect(loaded.failed).toEqual([]);
    expect(findNewFailures(loaded.next, [job("a", 78)]).failed).toHaveLength(1);
  });
});

describe("normalizeMonitorSettings", () => {
  test("trims, drops empty and duplicate prefixes", () => {
    expect(normalizeMonitorSettings({ notify: false, exclude: [" com.apple. ", "", "com.apple.", "homebrew."] })).toEqual({
      notify: false,
      exclude: ["com.apple.", "homebrew."],
    });
  });

  test("keeps 50 prefixes of 100 characters", () => {
    const settings = normalizeMonitorSettings({ notify: true, exclude: [...Array(60).keys()].map((i) => `${i}-${"x".repeat(200)}`) });
    expect(settings.exclude).toHaveLength(50);
    expect(settings.exclude.every((p) => p.length === 100)).toBe(true);
  });

  test("rejects wrong types", () => {
    for (const input of [null, {}, { notify: "yes", exclude: [] }, { notify: true }, { notify: true, exclude: "com.apple." }, { notify: true, exclude: [1] }]) {
      expect(() => normalizeMonitorSettings(input)).toThrow(JobError);
    }
  });
});

describe("shouldNotify", () => {
  test("notify: false silences everything", () => {
    expect(shouldNotify({ notify: false, exclude: [] }, "com.example.job")).toBe(false);
  });

  test("an excluded prefix silences matching labels only", () => {
    const settings = { notify: true, exclude: ["com.apple.", "homebrew.mxcl"] };
    expect(shouldNotify(settings, "com.apple.thing")).toBe(false);
    expect(shouldNotify(settings, "homebrew.mxcl.redis")).toBe(false);
    expect(shouldNotify(settings, "org.com.apple.thing")).toBe(true);
    expect(shouldNotify(settings, "com.example.job")).toBe(true);
  });
});

describe("notificationText", () => {
  const event: JobEvent = { id: "1", at: 1, kind: "failed", label: "com.example.job", category: "user-agents", path: "/p/com.example.job.plist", program: "/usr/local/bin/job", exitStatus: 78 };

  test("a failed job shows its exit status", () => {
    expect(notificationText(event)).toEqual({ title: "launchd job failed", message: "Exit status 78: /usr/local/bin/job", subtitle: "com.example.job" });
  });

  test("file events show the program, or the path when there is none", () => {
    expect(notificationText({ ...event, kind: "modified", exitStatus: undefined })).toMatchObject({ title: "launchd job changed", message: "/usr/local/bin/job" });
    expect(notificationText({ ...event, kind: "removed", program: null }).message).toBe("/p/com.example.job.plist");
  });
});
