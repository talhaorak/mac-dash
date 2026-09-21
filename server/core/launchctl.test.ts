import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { parsePlistDict, serializePlist } from "../../shared/plist";
import { MAX_PRIVILEGED_XML, __setScopeDirsForTests, buildPrivilegedScript, findJobFile, indexedJobFiles, readJob, run, saveJob } from "./launchctl";

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

// Apps such as Homebrew services link a plist from their own folder into ~/Library/LaunchAgents.
// The scopes point at temporary folders here, which also switches every launchctl call off.
describe("a job file that is a symlink", () => {
  const label = "com.example.linked";
  const original = serializePlist({ Label: label, ProgramArguments: ["/usr/bin/true"] });
  let root: string;
  let link: string;
  let target: string;
  let backups: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "macdash-symlink-"));
    const agents = join(root, "LaunchAgents");
    backups = join(root, "backups");
    target = join(root, "elsewhere", "homebrew.mxcl.real.plist");
    link = join(agents, `${label}.plist`);
    await mkdir(agents);
    await mkdir(join(root, "elsewhere"));
    await writeFile(target, original);
    await symlink(target, link);
    await symlink(join(root, "elsewhere", "missing.plist"), join(agents, "com.example.dangling.plist"));
    __setScopeDirsForTests({ scopes: { "user-agents": agents }, backups });
  });

  afterAll(async () => {
    __setScopeDirsForTests(null);
    await rm(root, { recursive: true, force: true });
  });

  test("is indexed under its link path, and a dangling link is skipped", async () => {
    const files = await indexedJobFiles();
    expect(files.map((f) => f.path)).toEqual([link]); // nothing from the real job folders either
    expect(await findJobFile(label, "user-agents")).toMatchObject({ path: link, fileName: `${label}.plist`, label, category: "user-agents" });
    expect(await findJobFile(label, "global-agents")).toBeNull();
  });

  test("is readable", async () => {
    const doc = await readJob(label, "user-agents");
    expect(doc).toMatchObject({ label, path: link, xml: original, writable: true, needsAdmin: false });
  });

  test("saving replaces the link with a regular file and leaves the target alone", async () => {
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    const edited = serializePlist({ Label: label, ProgramArguments: ["/usr/bin/true"], StartInterval: 3600 });

    const result = await saveJob({ category: "user-agents", xml: edited, original: { label, category: "user-agents" }, load: false });
    expect(result).toEqual({ ok: true, label, path: link });

    const st = await lstat(link);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect(await readFile(link, "utf8")).toBe(edited);
    expect(await readFile(target, "utf8")).toBe(original);

    expect(parsePlistDict((await readJob(label, "user-agents"))!.xml).StartInterval).toBe(3600);
    const revisions = await readdir(backups);
    expect(revisions).toHaveLength(1);
    expect(await readFile(join(backups, revisions[0]), "utf8")).toBe(original);
  });

  test("a scope that needs root cannot be saved while the test folders are active", async () => {
    const result = await saveJob({ category: "global-agents", xml: original, load: false });
    expect(result.ok).toBe(false);
  });
});
