import { describe, expect, test } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  parsePlist,
  parsePlistDict,
  serializePlist,
  PlistData,
  PlistParseError,
  PlistReal,
} from "./plist";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<!-- a comment -->
	<key>Label</key>
	<string>com.example.job &amp; co</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>echo "a &lt; b" &#x26;&#38; true</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StartInterval</key>
	<integer>300</integer>
	<key>Ratio</key>
	<real>1.5</real>
	<key>Blob</key>
	<data>
	aGVsbG8=
	</data>
	<key>When</key>
	<date>2026-01-02T03:04:05Z</date>
	<key>Empty</key>
	<string></string>
	<key>EmptyArray</key>
	<array/>
</dict>
</plist>`;

describe("parsePlist", () => {
  test("parses every value type", () => {
    const d = parsePlistDict(SAMPLE);
    expect(d.Label).toBe("com.example.job & co");
    expect(d.ProgramArguments).toEqual(["/bin/sh", "-c", 'echo "a < b" && true']);
    expect(d.RunAtLoad).toBe(true);
    expect(d.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(d.StartInterval).toBe(300);
    expect(d.Ratio).toBeInstanceOf(PlistReal);
    expect((d.Ratio as PlistReal).value).toBe(1.5);
    expect((d.Blob as PlistData).base64).toBe("aGVsbG8=");
    expect((d.When as Date).toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(d.Empty).toBe("");
    expect(d.EmptyArray).toEqual([]);
  });

  test("keeps whitespace inside strings", () => {
    const d = parsePlistDict("<plist><dict>\n<key>A</key>\n<string>   </string>\n<key>B</key><string> x\n y </string></dict></plist>");
    expect(d).toEqual({ A: "   ", B: " x\n y " });
    expect(parsePlistDict(serializePlist(d))).toEqual(d);
  });

  test("round-trips through serializePlist", () => {
    const d = parsePlistDict(SAMPLE);
    expect(parsePlistDict(serializePlist(d))).toEqual(d);
  });

  test("reports line numbers for malformed input", () => {
    const broken = SAMPLE.replace("<integer>300</integer>", "<integer>abc</integer>");
    try {
      parsePlist(broken);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PlistParseError);
      expect((e as PlistParseError).line).toBe(22);
    }
  });

  test("rejects a missing value, an unclosed dict and trailing content", () => {
    expect(() => parsePlist("<plist><dict><key>A</key></dict></plist>")).toThrow(/Missing value/);
    expect(() => parsePlist("<plist><dict><key>A</key><true/></plist>")).toThrow();
    expect(() => parsePlist("<plist><dict/></plist><dict/>")).toThrow(/after the root/);
    expect(() => parsePlistDict("<plist><array/></plist>")).toThrow(/must be a <dict>/);
    expect(() => parsePlist("<plist><dict><key></key><true/></dict></plist>")).toThrow(/Empty <key>/);
  });
});

describe("real launchd plists on this machine", () => {
  const dirs = [
    join(homedir(), "Library/LaunchAgents"),
    "/Library/LaunchAgents",
    "/Library/LaunchDaemons",
    "/System/Library/LaunchAgents",
    "/System/Library/LaunchDaemons",
  ];

  test("every plist parses and round-trips", async () => {
    let checked = 0;
    for (const dir of dirs) {
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".plist"));
      } catch {
        continue;
      }
      for (const file of files) {
        const proc = Bun.spawn(["plutil", "-convert", "xml1", "-o", "-", join(dir, file)], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const xml = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0 || !xml) continue; // unreadable (permissions)
        const parsed = parsePlist(xml);
        expect(parsePlist(serializePlist(parsed))).toEqual(parsed);
        checked++;
      }
    }
    console.log(`  round-tripped ${checked} plists`);
    expect(checked).toBeGreaterThan(0);
  }, 120_000);
});
