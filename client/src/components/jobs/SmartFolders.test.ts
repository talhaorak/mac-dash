import { describe, expect, test } from "bun:test";
import type { ServiceInfo } from "@/stores/app";
import {
  DEFAULT_FOLDERS,
  defaultRule,
  folderNeedsPlists,
  lookupPlistKey,
  matchesFolder,
  matchesRule,
  operatorTakesValue,
  operatorTitle,
  operatorsFor,
  plistTexts,
  ruleProblem,
  sanitizeFolders,
  type JobPlist,
  type SmartFolder,
  type SmartRule,
} from "./SmartFolders";

const NOW = new Date("2026-09-21T10:00:00");

function job(overrides: Partial<ServiceInfo> = {}): ServiceInfo {
  return {
    label: "com.example.backup",
    pid: null,
    lastExitStatus: 0,
    status: "stopped",
    category: "user-agents",
    plistPath: "/Users/me/Library/LaunchAgents/com.example.backup.plist",
    program: "/usr/local/bin/backup",
    programArguments: null,
    runAtLoad: true,
    enabled: true,
    loaded: true,
    disabled: false,
    triggers: ["At load"],
    writable: true,
    needsAdmin: false,
    userName: null,
    unreadable: false,
    quarantined: false,
    startInterval: null,
    calendar: [],
    ...overrides,
  };
}

const PLIST: JobPlist = {
  Label: "com.example.backup",
  RunAtLoad: true,
  AbandonProcessGroup: false,
  StartInterval: 300,
  ProgramArguments: ["/usr/local/bin/backup", "--target", "/Volumes/Backup Disk"],
  KeepAlive: { SuccessfulExit: false, PathState: { "/tmp/flag": true } },
  EnvironmentVariables: { PATH: "/usr/local/bin:/usr/bin", LANG: "en_US.UTF-8" },
  MachServices: { "com.example.backup.xpc": true },
  StartCalendarInterval: [{ Hour: 3, Minute: 30 }],
};

const keyRule = (key: string, operator: SmartRule["operator"], value = ""): SmartRule => ({ field: "launchdKey", operator, value, key });
const folderOf = (rules: SmartRule[], match: "all" | "any" = "all"): SmartFolder => ({ id: "user:test", name: "Test", match, rules });
/** Without a second argument the rule runs against PLIST. An explicit `undefined` means "plists not loaded". */
const hit = (rule: SmartRule, ...plist: [JobPlist | null | undefined] | []) => matchesRule(job(), undefined, rule, NOW, plist.length === 0 ? PLIST : plist[0]);

describe("launchd key rules: model", () => {
  test("operators and titles", () => {
    expect(operatorsFor("launchdKey")).toEqual(["exists", "notExists", "is", "isNot", "contains"]);
    expect(operatorTitle("launchdKey", "is")).toBe("equals");
    expect(operatorTitle("launchdKey", "isNot")).toBe("does not equal");
    expect(operatorTitle("launchdKey", "notExists")).toBe("does not exist");
    expect(operatorTitle("label", "is")).toBe("is");
    expect(operatorTakesValue("exists")).toBe(false);
    expect(operatorTakesValue("contains")).toBe(true);
  });

  test("the default rule needs a key before it can run", () => {
    const rule = defaultRule("launchdKey");
    expect(rule).toEqual({ field: "launchdKey", operator: "exists", value: "", key: "" });
    expect(ruleProblem(rule)).toBe("Enter a launchd key.");
    expect(ruleProblem({ ...rule, key: "RunAtLoad" })).toBeNull();
  });

  test("a comparing operator needs a value, an existence operator does not", () => {
    expect(ruleProblem(keyRule("RunAtLoad", "is", " "))).toBe("Enter a value.");
    expect(ruleProblem(keyRule("RunAtLoad", "is", "true"))).toBeNull();
    expect(ruleProblem(keyRule("RunAtLoad", "notExists"))).toBeNull();
    expect(ruleProblem(keyRule("K".repeat(201), "exists"))).toBe("The key is too long.");
    expect(ruleProblem(keyRule("RunAtLoad", "startsWith", "t"))).toBe("The operator does not fit the field.");
    expect(ruleProblem({ field: "launchdKey", operator: "exists", value: "" })).toBe("Enter a launchd key.");
  });

  test("folderNeedsPlists", () => {
    expect(folderNeedsPlists(folderOf([keyRule("RunAtLoad", "exists")]))).toBe(true);
    expect(folderNeedsPlists(folderOf([{ field: "label", operator: "contains", value: "x" }]))).toBe(false);
    expect(DEFAULT_FOLDERS.some(folderNeedsPlists)).toBe(false);
  });
});

describe("lookupPlistKey", () => {
  test("top-level key, exact and without regard to case", () => {
    expect(lookupPlistKey(PLIST, "RunAtLoad")).toEqual({ found: true, value: true });
    expect(lookupPlistKey(PLIST, "runatload")).toEqual({ found: true, value: true });
    expect(lookupPlistKey(PLIST, "Nope")).toEqual({ found: false, value: undefined });
  });

  test("a dotted path reaches into dictionaries, also when the nested key has dots", () => {
    expect(lookupPlistKey(PLIST, "KeepAlive.SuccessfulExit")).toEqual({ found: true, value: false });
    expect(lookupPlistKey(PLIST, "MachServices.com.example.backup.xpc")).toEqual({ found: true, value: true });
    expect(lookupPlistKey(PLIST, "KeepAlive.PathState./tmp/flag")).toEqual({ found: true, value: true });
    expect(lookupPlistKey(PLIST, "KeepAlive.Crashed").found).toBe(false);
    expect(lookupPlistKey(PLIST, "RunAtLoad.x").found).toBe(false);
  });

  test("inherited properties are not keys", () => {
    expect(lookupPlistKey(PLIST, "constructor").found).toBe(false);
    expect(lookupPlistKey(PLIST, "__proto__").found).toBe(false);
    expect(lookupPlistKey(PLIST, "KeepAlive.toString").found).toBe(false);
  });
});

describe("plistTexts", () => {
  test("scalars", () => {
    expect(plistTexts("a")).toEqual(["a"]);
    expect(plistTexts(true)).toEqual(["true"]);
    expect(plistTexts(false)).toEqual(["false"]);
    expect(plistTexts(300)).toEqual(["300"]);
    expect(plistTexts(null)).toEqual([]);
    expect(plistTexts(undefined)).toEqual([]);
  });

  test("an array gives its elements, a dictionary its keys, values and pairs", () => {
    expect(plistTexts(["a", 1, true])).toEqual(["a", "1", "true"]);
    expect(plistTexts({ PATH: "/bin", Debug: true })).toEqual(["PATH", "/bin", "PATH=/bin", "Debug", "true", "Debug=true"]);
    expect(plistTexts([{ Hour: 3 }])).toEqual(["Hour", "3", "Hour=3"]);
    expect(plistTexts({ Outer: { Inner: "x" } })).toEqual(["Outer", "Inner", "x", "Inner=x"]);
  });

  test("a deep structure stops without an error", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 50; i++) deep = [deep];
    expect(plistTexts(deep)).toEqual([]);
  });
});

describe("matchesRule with a launchd key", () => {
  test("exists and does not exist", () => {
    expect(hit(keyRule("RunAtLoad", "exists"))).toBe(true);
    expect(hit(keyRule("AbandonProcessGroup", "exists"))).toBe(true);
    expect(hit(keyRule("WatchPaths", "exists"))).toBe(false);
    expect(hit(keyRule("WatchPaths", "notExists"))).toBe(true);
    expect(hit(keyRule("RunAtLoad", "notExists"))).toBe(false);
    expect(hit(keyRule("  RunAtLoad  ", "exists"))).toBe(true);
  });

  test("booleans compare as true and false", () => {
    expect(hit(keyRule("RunAtLoad", "is", "true"))).toBe(true);
    expect(hit(keyRule("RunAtLoad", "is", "TRUE"))).toBe(true);
    expect(hit(keyRule("RunAtLoad", "is", "false"))).toBe(false);
    expect(hit(keyRule("RunAtLoad", "is", "1"))).toBe(false);
    expect(hit(keyRule("AbandonProcessGroup", "is", "false"))).toBe(true);
    expect(hit(keyRule("KeepAlive.SuccessfulExit", "isNot", "true"))).toBe(true);
  });

  test("numbers and text compare as text", () => {
    expect(hit(keyRule("StartInterval", "is", "300"))).toBe(true);
    expect(hit(keyRule("StartInterval", "is", "300.0"))).toBe(false);
    expect(hit(keyRule("StartInterval", "contains", "30"))).toBe(true);
    expect(hit(keyRule("Label", "is", "COM.EXAMPLE.BACKUP"))).toBe(true);
    expect(hit(keyRule("Label", "contains", "example"))).toBe(true);
    expect(hit(keyRule("Label", "isNot", "com.example.backup"))).toBe(false);
  });

  test("an array matches when one element matches", () => {
    expect(hit(keyRule("ProgramArguments", "is", "--target"))).toBe(true);
    expect(hit(keyRule("ProgramArguments", "is", "--tar"))).toBe(false);
    expect(hit(keyRule("ProgramArguments", "contains", "backup disk"))).toBe(true);
    expect(hit(keyRule("ProgramArguments", "isNot", "--target"))).toBe(false);
    expect(hit(keyRule("ProgramArguments", "isNot", "--other"))).toBe(true);
  });

  test("a dictionary matches by key, by value and by pair", () => {
    expect(hit(keyRule("EnvironmentVariables", "is", "PATH"))).toBe(true);
    expect(hit(keyRule("EnvironmentVariables", "contains", "/usr/local/bin"))).toBe(true);
    expect(hit(keyRule("EnvironmentVariables", "is", "LANG=en_US.UTF-8"))).toBe(true);
    expect(hit(keyRule("EnvironmentVariables.PATH", "contains", "/usr/bin"))).toBe(true);
    expect(hit(keyRule("StartCalendarInterval", "is", "Hour=3"))).toBe(true);
  });

  test("a missing key: only the negative operators match", () => {
    expect(hit(keyRule("WatchPaths", "is", "x"))).toBe(false);
    expect(hit(keyRule("WatchPaths", "contains", "x"))).toBe(false);
    expect(hit(keyRule("WatchPaths", "isNot", "x"))).toBe(true);
  });

  test("plists not loaded (undefined): nothing matches, not even the negative operators", () => {
    for (const rule of [keyRule("RunAtLoad", "exists"), keyRule("RunAtLoad", "notExists"), keyRule("RunAtLoad", "isNot", "x"), keyRule("RunAtLoad", "is", "true")]) {
      expect(matchesRule(job(), undefined, rule, NOW)).toBe(false);
      expect(hit(rule, undefined)).toBe(false);
    }
  });

  test("a job without a readable plist (null) has no key", () => {
    expect(hit(keyRule("RunAtLoad", "exists"), null)).toBe(false);
    expect(hit(keyRule("RunAtLoad", "notExists"), null)).toBe(true);
    expect(hit(keyRule("RunAtLoad", "is", "true"), null)).toBe(false);
    expect(hit(keyRule("RunAtLoad", "isNot", "true"), null)).toBe(true);
  });

  test("a rule with a problem matches nothing", () => {
    expect(hit(keyRule("", "notExists"))).toBe(false);
    expect(hit(keyRule("RunAtLoad", "is", ""))).toBe(false);
  });
});

describe("matchesFolder with the plist argument", () => {
  const labelRule: SmartRule = { field: "label", operator: "contains", value: "backup" };

  test("all: every rule must match, the plist rule included", () => {
    const folder = folderOf([labelRule, keyRule("RunAtLoad", "is", "true")]);
    expect(matchesFolder(job(), undefined, folder, NOW, PLIST)).toBe(true);
    expect(matchesFolder(job(), undefined, folder, NOW, { RunAtLoad: false })).toBe(false);
    expect(matchesFolder(job(), undefined, folder, NOW)).toBe(false);
    expect(matchesFolder(job({ label: "com.example.other" }), undefined, folder, NOW, PLIST)).toBe(false);
  });

  test("any: the other rules still work while the plists are not loaded", () => {
    const folder = folderOf([labelRule, keyRule("WatchPaths", "exists")], "any");
    expect(matchesFolder(job(), undefined, folder, NOW)).toBe(true);
    expect(matchesFolder(job({ label: "x" }), undefined, folder, NOW)).toBe(false);
    expect(matchesFolder(job({ label: "x" }), undefined, folder, NOW, { WatchPaths: ["/tmp"] })).toBe(true);
  });

  test("folders without a plist rule ignore the argument", () => {
    for (const folder of DEFAULT_FOLDERS) {
      const service = job({ disabled: true, status: "error" });
      expect(matchesFolder(service, undefined, folder, NOW, PLIST)).toBe(matchesFolder(service, undefined, folder, NOW));
    }
    expect(matchesFolder(job(), undefined, folderOf([]), NOW, null)).toBe(true);
  });
});

describe("sanitizeFolders with launchd key rules", () => {
  test("the key survives, a rule without a key is dropped, a stray key on another field is removed", () => {
    const [folder] = sanitizeFolders([
      {
        id: "user:1",
        name: "Keys",
        match: "any",
        rules: [
          { field: "launchdKey", operator: "is", value: "true", key: "RunAtLoad" },
          { field: "launchdKey", operator: "exists", value: "" },
          { field: "launchdKey", operator: "exists", value: "", key: 7 },
          { field: "label", operator: "contains", value: "x", key: "Stray" },
        ],
      },
    ]);
    expect(folder.rules).toEqual([
      { field: "launchdKey", operator: "is", value: "true", key: "RunAtLoad" },
      { field: "label", operator: "contains", value: "x" },
    ]);
    expect(folder.match).toBe("any");
  });
});
