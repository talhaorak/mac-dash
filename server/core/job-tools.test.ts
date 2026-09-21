import { describe, expect, test } from "bun:test";
import { JobError } from "./launchctl";
import { appleScriptString, checkScriptAppRequest, parseCodesign, parsePmsetSched, pmsetRepeatArgs } from "./job-tools";

describe("parseCodesign", () => {
  test("reads a Developer ID signature", () => {
    const stderr = [
      "Executable=/Applications/zoom.us.app/Contents/MacOS/zoom.us",
      "Identifier=us.zoom.xos",
      "Format=app bundle with Mach-O universal (x86_64 arm64)",
      "CodeDirectory v=20500 size=1079 flags=0x10000(runtime) hashes=23+7 location=embedded",
      "Signature size=9032",
      "Authority=Developer ID Application: Zoom Video Communications, Inc. (BJ4HAAB9B3)",
      "Authority=Developer ID Certification Authority",
      "Authority=Apple Root CA",
      "Timestamp=1 Sep 2026 at 10:00:00",
      "TeamIdentifier=BJ4HAAB9B3",
    ].join("\n");
    expect(parseCodesign(stderr, 0)).toEqual({
      signed: true,
      identifier: "us.zoom.xos",
      authorities: [
        "Developer ID Application: Zoom Video Communications, Inc. (BJ4HAAB9B3)",
        "Developer ID Certification Authority",
        "Apple Root CA",
      ],
      teamId: "BJ4HAAB9B3",
      apple: false,
      trusted: false,
      adhoc: false,
      error: null,
    });
  });

  test("never trusts displayed names: apple and trusted stay false until a real verification", () => {
    const chain = "Authority=Apple Code Signing Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=not set\n";
    const parsed = parseCodesign(`Identifier=com.apple.ls\nAuthority=Software Signing\n${chain}`, 0);
    expect(parsed).toMatchObject({ signed: true, apple: false, trusted: false, teamId: null });
    expect(parsed.authorities[0]).toBe("Software Signing");
  });

  test("verifies against Apple's root (live)", async () => {
    const { run } = await import("./launchctl");
    expect((await run(["codesign", "-v", "-R=anchor apple", "/bin/ls"])).code).toBe(0);
    expect((await run(["codesign", "-v", "-R=anchor apple generic", "/bin/ls"])).code).toBe(0);
    expect((await run(["codesign", "-v", "-R=anchor apple", process.execPath])).code).not.toBe(0); // bun is not Apple's
  });

  test("an authority that only mentions Apple further down the chain is not Apple code", () => {
    expect(parseCodesign("Identifier=x\nAuthority=Developer ID Application: Software Signing Ltd (ABCDE12345)\nAuthority=Apple Root CA\n", 0).apple).toBe(false);
  });

  test("reads an ad-hoc signature", () => {
    const parsed = parseCodesign("Executable=/usr/local/bin/tool\nIdentifier=tool-5555\nSignature=adhoc\nTeamIdentifier=not set\n", 0);
    expect(parsed).toMatchObject({ signed: true, adhoc: true, identifier: "tool-5555", authorities: [], apple: false, teamId: null });
  });

  test("'not signed at all' is an answer, not an error", () => {
    expect(parseCodesign("/usr/libexec/tmp_cleaner: code object is not signed at all", 1)).toEqual({
      signed: false,
      identifier: null,
      authorities: [],
      teamId: null,
      apple: false,
      trusted: false,
      adhoc: false,
      error: null,
    });
  });

  test("any other failure becomes the error text", () => {
    expect(parseCodesign("/nonexistent: No such file or directory", 1)).toMatchObject({ signed: false, error: "No such file or directory" });
    expect(parseCodesign("", 143)).toMatchObject({ signed: false, error: "codesign exited with code 143" });
  });
});

describe("appleScriptString", () => {
  test("escapes backslash and double quote, nothing else", () => {
    expect(appleScriptString("/Users/me/run.sh")).toBe('"/Users/me/run.sh"');
    expect(appleScriptString('/tmp/a "b"/c')).toBe('"/tmp/a \\"b\\"/c"');
    expect(appleScriptString("/tmp/back\\slash")).toBe('"/tmp/back\\\\slash"');
    expect(appleScriptString('\\"')).toBe('"\\\\\\""');
    expect(appleScriptString("/tmp/it's $HOME `id`")).toBe('"/tmp/it\'s $HOME `id`"');
  });
});

describe("checkScriptAppRequest", () => {
  test("accepts a plain name and an absolute path", () => {
    expect(checkScriptAppRequest("/Users/me/backup.sh", "Nightly Backup_1.0-b")).toEqual({ scriptPath: "/Users/me/backup.sh", name: "Nightly Backup_1.0-b" });
  });

  test("rejects names that could leave ~/Applications", () => {
    for (const name of ["", " lead", ".hidden", "a/b", "../x", "a:b", "x".repeat(65), 7, null]) {
      expect(() => checkScriptAppRequest("/bin/ls", name)).toThrow(JobError);
    }
    expect(checkScriptAppRequest("/bin/ls", "x".repeat(64)).name).toHaveLength(64);
  });

  test("rejects relative paths, control characters and non-strings", () => {
    for (const path of ["run.sh", "~/run.sh", "", `/tmp/a${String.fromCharCode(10)}b`, `/tmp/a${String.fromCharCode(0)}`, `/tmp/${String.fromCharCode(0x7f)}`, 5, undefined]) {
      expect(() => checkScriptAppRequest(path, "App")).toThrow(JobError);
    }
  });
});

describe("parsePmsetSched", () => {
  test("reads the documented line formats", () => {
    const text = [
      "Repeating power events:",
      "  wakepoweron at 7:00AM weekdays only",
      "  sleep at 11:30PM every day",
      "Scheduled power events:",
      " [0]  wake at 09/22/2026 07:00:00 by 'com.apple.alarm.user-visible-Weekly Alarm'",
    ].join("\n");
    expect(parsePmsetSched(text)).toEqual([
      { type: "wakeorpoweron", days: "MTWRF", time: "07:00:00" },
      { type: "sleep", days: "MTWRFSU", time: "23:30:00" },
    ]);
  });

  test("reads 'Some days' and 'weekends only'", () => {
    const text = "Repeating power events:\n  shutdown at 9:00PM Some days: Mon Wed\n  wake at 6:15AM weekends only\n";
    expect(parsePmsetSched(text)).toEqual([
      { type: "shutdown", days: "MW", time: "21:00:00" },
      { type: "wake", days: "SU", time: "06:15:00" },
    ]);
  });

  test("orders the days as MTWRFSU and accepts the compact letter form", () => {
    expect(parsePmsetSched("Repeating power events:\n  restart at 1:05AM Some days: Sun Thu Tue\n")[0].days).toBe("TRU");
    expect(parsePmsetSched("Repeating power events:\n  poweron at 1:05AM Some days: TRU\n")[0].days).toBe("TRU");
  });

  test("converts noon and midnight", () => {
    const at = (time: string) => parsePmsetSched(`Repeating power events:\n  sleep at ${time} every day\n`)[0]?.time;
    expect(at("12:00AM")).toBe("00:00:00");
    expect(at("12:30PM")).toBe("12:30:00");
    expect(at("1:00PM")).toBe("13:00:00");
    expect(at("11:59PM")).toBe("23:59:00");
    expect(at("19:45")).toBe("19:45:00");
  });

  test("ignores one-time events, unknown types and output without a schedule", () => {
    expect(parsePmsetSched("")).toEqual([]);
    expect(parsePmsetSched("Scheduled power events:\n [0]  wake at 09/22/2026 07:00:00 by 'x'\n")).toEqual([]);
    expect(parsePmsetSched("Repeating power events:\n  hibernate at 7:00AM every day\n  sleep at 7:00AM no days\n")).toEqual([]);
  });
});

describe("pmsetRepeatArgs", () => {
  test("an empty list cancels the schedule", () => {
    expect(pmsetRepeatArgs([])).toEqual(["/usr/bin/pmset", "repeat", "cancel"]);
  });

  test("builds one or two events in the given order", () => {
    expect(pmsetRepeatArgs([{ type: "wakeorpoweron", days: "MTWRF", time: "07:00:00" }])).toEqual(["/usr/bin/pmset", "repeat", "wakeorpoweron", "MTWRF", "07:00:00"]);
    expect(
      pmsetRepeatArgs([
        { type: "shutdown", days: "MTWRFSU", time: "23:30:00" },
        { type: "wake", days: "SU", time: "06:15:00" },
      ])
    ).toEqual(["/usr/bin/pmset", "repeat", "shutdown", "MTWRFSU", "23:30:00", "wake", "SU", "06:15:00"]);
  });

  test("rejects everything the contract forbids", () => {
    const ok = { type: "sleep", days: "M", time: "00:00:00" };
    const bad: unknown[] = [
      null,
      "cancel",
      [ok, { ...ok, type: "wake" }, { ...ok, type: "poweron" }],
      [ok, { ...ok, type: "restart" }],
      [{ ...ok, type: "wake" }, { ...ok, type: "wakeorpoweron" }],
      [{ ...ok, type: "cancel" }],
      [{ ...ok, type: "sleep; rm -rf /" }],
      [{ ...ok, days: "" }],
      [{ ...ok, days: "WM" }],
      [{ ...ok, days: "MM" }],
      [{ ...ok, days: "Mon" }],
      [{ ...ok, days: "M T" }],
      [{ ...ok, time: "7:00:00" }],
      [{ ...ok, time: "24:00:00" }],
      [{ ...ok, time: "07:60:00" }],
      [{ ...ok, time: "07:00" }],
      [{ ...ok, time: "07:00:00 && reboot" }],
      [{ ...ok, time: 700 }],
      [null],
      ["sleep"],
    ];
    for (const events of bad) expect(() => pmsetRepeatArgs(events)).toThrow(JobError);
  });
});
