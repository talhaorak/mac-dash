import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_PRIVILEGED_XML, buildPrivilegedScript, run } from "./launchctl";

describe("buildPrivilegedScript", () => {
  test("single-quotes every argument and joins the steps with &&", () => {
    expect(buildPrivilegedScript([{ cmd: ["/bin/mv", "-f", "/Library/a b.plist", "/Library/it's.plist"] }, { cmd: ["/bin/chmod", "644", "$(id)"] }])).toBe(
      `'/bin/mv' '-f' '/Library/a b.plist' '/Library/it'\\''s.plist' && '/bin/chmod' '644' '$(id)'`
    );
  });

  test("a tolerant step is its own group, so it cannot hide the failure of an earlier step", () => {
    expect(buildPrivilegedScript([{ cmd: ["a"] }, { cmd: ["b"], tolerant: true }, { cmd: ["c"] }])).toBe("'a' && { 'b' || true; } && 'c'");
  });
});

// The privileged save hands the plist to root as one base64 argument. These tests run the same
// osascript mechanics as runPrivileged, minus "with administrator privileges": no prompt, no root.
describe("osascript argument transport", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  const viaOsascript = (script: string) =>
    run(["osascript", "-e", "on run argv", "-e", "do shell script (item 1 of argv)", "-e", "end run", "--", script], undefined, 60_000);

  test("a plist of the maximum privileged size arrives byte-identical", async () => {
    const dir = await mkdtemp(join(tmpdir(), "macdash-osascript-"));
    dirs.push(dir);
    const target = join(dir, "staging file.macdash-new");

    const payload = Buffer.alloc(MAX_PRIVILEGED_XML);
    let seed = 12345;
    for (let i = 0; i < payload.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      payload[i] = seed >> 16; // every byte value, so that nothing depends on the text being ASCII
    }

    // the same step that saveJob builds for a target in /Library
    const script = buildPrivilegedScript([
      { cmd: ["/usr/bin/false"], tolerant: true },
      { cmd: ["/bin/sh", "-c", 'printf %s "$0" | /usr/bin/base64 -D > "$1"', payload.toString("base64"), target] },
      { cmd: ["/bin/chmod", "644", target] },
    ]);
    expect(script.length).toBeGreaterThan(270_000);

    const result = await viaOsascript(script);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect((await readFile(target)).equals(payload)).toBe(true);
  }, 60_000);

  test("a failing step fails the whole script and later steps do not run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "macdash-osascript-"));
    dirs.push(dir);
    const marker = join(dir, "marker");
    const result = await viaOsascript(buildPrivilegedScript([{ cmd: ["/usr/bin/false"] }, { cmd: ["/usr/bin/touch", marker] }]));
    expect(result.code).not.toBe(0);
    expect(await readFile(marker).then(() => true, () => false)).toBe(false);
  }, 60_000);
});
