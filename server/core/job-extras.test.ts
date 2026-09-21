import { describe, expect, test } from "bun:test";
import { deleteLoginItemArgv, parseBtmDump } from "./job-extras";

// Shape copied from `sfltool dumpbtm` on macOS 27.
const DUMP = `========================
 Records for UID -2 : FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE
========================

 ServiceManagement migrated: true
 LaunchServices registered: false

 Items:

 #1:
                 UUID: F795003E-4AF4-4F54-AC11-9385A7206B83
                 Name: AutoCAD
       Developer Name: AutoCAD
                 Type: developer (0x20)
                Flags: [ curated ] (0x4)
          Disposition: [disabled, allowed, not notified] (0x2)
           Identifier: AutoCAD
                  URL: (null)
           Generation: 0
  Embedded Item Identifiers:
    #1: 16.com.autodesk.adskaccessservicehost
    #2: 16.com.autodesk.other

 #2:
                 UUID: 68353594-0105-463F-AAD0-AE5B903875A1
                 Name: AdskAccessServiceHost
       Developer Name: AutoCAD
      Team Identifier: XXKJ396S2Y
                 Type: legacy daemon (0x10010)
                Flags: [ legacy, curated ] (0x5)
          Disposition: [enabled, disallowed, notified] (0x9)
           Identifier: 16.com.autodesk.adskaccessservicehost
                  URL: file:///Library/LaunchDaemons/com.autodesk.adskaccessservicehost.plist
      Executable Path: /Library/Application Support/Autodesk/AdODIS/V1/Setup/AdskAccessServiceHost
           Generation: 3
    Assoc. Bundle IDs: [ com.autodesk.AutoCAD2022 ]
    Parent Identifier: AutoCAD


========================
 Records for UID 0 : FFFFEEEE-DDDD-CCCC-BBBB-AAAA00000000
========================

 Items:

 #1:
                 UUID: 11111111-0105-463F-AAD0-AE5B903875A1
                 Name: rootd
       Developer Name: (null)
                 Type: daemon (0x10)
                Flags: [  ] (0)
          Disposition: [  ] (0)
           Identifier: com.example.rootd
                  URL: (null)
           Generation: 1

========================
 Records for UID 501 : FA7B2188-5C79-409C-AD7A-704FB1B05396
========================

 Items:

 #1:
                 UUID: 74101492-E3B2-4A96-BEB2-11843EB713DD
                 Name: (null)
       Developer Name: (null)
                 Type: developer (0x20)
                Flags: [  ] (0)
          Disposition: [disabled, allowed, not notified] (0x2)
           Identifier: Unknown Developer
                  URL: (null)
           Generation: 1

 #2:
                 UUID: 22222222-E3B2-4A96-BEB2-11843EB713DD
                 Name: Helper: Pro
       Developer Name: Example Inc.
                 Type: login item (0x4)
                Flags: [  ] (0)
          Disposition: [enabled, allowed, notified] (0xb)
           Identifier: 4.com.example.helper
                  URL: Contents/Library/LoginItems/Helper.app
           Generation: 2
    Bundle Identifier: com.example.helper
    Parent Identifier: 2.com.example.app

========================
 Records for UID 502 : 555DF79A-92DF-443B-9B6A-1678D2AFE585
========================

 Items:

 #1:
                 UUID: 33333333-E3B2-4A96-BEB2-11843EB713DD
                 Name: someone else's agent
       Developer Name: (null)
                 Type: legacy agent (0x10008)
                Flags: [ legacy ] (0x1)
          Disposition: [enabled, allowed, notified] (0xb)
           Identifier: 8.com.other.agent
                  URL: (null)
           Generation: 1
`;

describe("parseBtmDump", () => {
  const items = parseBtmDump(DUMP, [501, 0, -2]);

  test("returns the records of the requested uids only", () => {
    expect(items.map((i) => [i.uid, i.identifier])).toEqual([
      [-2, "AutoCAD"],
      [-2, "16.com.autodesk.adskaccessservicehost"],
      [0, "com.example.rootd"],
      [501, "Unknown Developer"],
      [501, "4.com.example.helper"],
    ]);
    expect(parseBtmDump(DUMP, [502]).map((i) => i.name)).toEqual(["someone else's agent"]);
    expect(parseBtmDump(DUMP, [])).toEqual([]);
  });

  test("reads every field of a full record", () => {
    expect(items[1]).toEqual({
      uid: -2,
      name: "AdskAccessServiceHost",
      developerName: "AutoCAD",
      type: "legacy daemon",
      disposition: ["enabled", "disallowed", "notified"],
      identifier: "16.com.autodesk.adskaccessservicehost",
      url: "file:///Library/LaunchDaemons/com.autodesk.adskaccessservicehost.plist",
      executablePath: "/Library/Application Support/Autodesk/AdODIS/V1/Setup/AdskAccessServiceHost",
      parentIdentifier: "AutoCAD",
      teamIdentifier: "XXKJ396S2Y",
    });
  });

  test("maps (null) and missing fields to null", () => {
    expect(items[0]).toMatchObject({ url: null, executablePath: null, parentIdentifier: null, teamIdentifier: null, type: "developer" });
    expect(items[3]).toMatchObject({ name: "", developerName: null, identifier: "Unknown Developer" });
  });

  test("the embedded identifier sub-list neither starts a record nor leaks into one", () => {
    expect(items.filter((i) => i.uid === -2)).toHaveLength(2);
    expect(items[0].disposition).toEqual(["disabled", "allowed", "not notified"]);
  });

  test("keeps colons inside values and handles an empty disposition", () => {
    expect(items[4].name).toBe("Helper: Pro");
    expect(items[2].disposition).toEqual([]);
  });

  test("survives text that is not a dump", () => {
    expect(parseBtmDump("", [501])).toEqual([]);
    expect(parseBtmDump("sfltool: not permitted\n #1:\n Name: orphan\n", [501])).toEqual([]);
  });
});

describe("deleteLoginItemArgv", () => {
  test("passes the name as the only argv item, after --", () => {
    const argv = deleteLoginItemArgv('-e do shell script "id"');
    expect(argv).toEqual([
      "osascript",
      "-e", "on run argv",
      "-e", 'tell application "System Events" to delete login item (item 1 of argv)',
      "-e", "end run",
      "--",
      '-e do shell script "id"',
    ]);
  });

  test("never puts the name into the script text", () => {
    const argv = deleteLoginItemArgv('x" & (do shell script "id") & "');
    expect(argv.slice(0, -1).join(" ")).not.toContain("do shell script");
    expect(argv[argv.length - 1]).toBe('x" & (do shell script "id") & "');
  });
});
