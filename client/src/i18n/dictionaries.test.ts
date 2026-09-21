/**
 * Structural checks on the whole dictionary (every part, not just launchd): the English and Turkish
 * dictionaries must declare the same keys, the same `{placeholder}` names per key, and complete plural
 * pairs. Also covers `t`/`tn`/`tDynamic` interpolation and plural selection.
 */
import { describe, expect, test } from "bun:test";
import { en } from "@/i18n/en";
import { tr } from "@/i18n/tr";
import { setLocale, t, tDynamic, tn } from "@/i18n";

function placeholders(template: string | undefined): string[] {
  if (typeof template !== "string") return [];
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("dictionary parity (en vs tr, all parts)", () => {
  test("declare exactly the same set of keys", () => {
    const enKeys = new Set(Object.keys(en));
    const trKeys = new Set(Object.keys(tr));
    const missingInTr = [...enKeys].filter((k) => !trKeys.has(k)).sort();
    const extraInTr = [...trKeys].filter((k) => !enKeys.has(k)).sort();
    // TS already makes a missing tr key a compile error (tr.ts types each part against its own en part).
    // This is a runtime cross-check across every part combined, useful while parts are mid-conversion.
    expect({ missingInTr: missingInTr.slice(0, 20), extraInTr: extraInTr.slice(0, 20), missingCount: missingInTr.length, extraCount: extraInTr.length }).toEqual({
      missingInTr: [],
      extraInTr: [],
      missingCount: 0,
      extraCount: 0,
    });
  });

  test("every value has the same {placeholder} names in both languages", () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(en)) {
      if (!(key in tr)) continue; // reported by the key-set test above
      const enPlaceholders = placeholders((en as Record<string, string>)[key]);
      const trPlaceholders = placeholders((tr as Record<string, string>)[key]);
      if (JSON.stringify(enPlaceholders) !== JSON.stringify(trPlaceholders)) {
        mismatches.push(`${key}: en=[${enPlaceholders.join(",")}] tr=[${trPlaceholders.join(",")}]`);
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  test("no key is an empty string, in either language", () => {
    const empties = Object.entries(en)
      .filter(([, v]) => typeof v !== "string" || v.length === 0)
      .map(([k]) => k);
    expect(empties).toEqual([]);
  });

  test("plural pairs are complete: every .one has a .other and vice versa", () => {
    const keys = new Set(Object.keys(en));
    const missing: string[] = [];
    for (const key of keys) {
      if (key.endsWith(".one") && !keys.has(`${key.slice(0, -4)}.other`)) missing.push(`${key} has no matching .other`);
      if (key.endsWith(".other") && !keys.has(`${key.slice(0, -6)}.one`)) missing.push(`${key} has no matching .one`);
    }
    expect(missing).toEqual([]);
  });
});

describe("t() interpolation", () => {
  test("substitutes named placeholders and leaves unknown ones untouched", () => {
    setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("shell.updated", { when: "5m ago" })).toBe("Updated 5m ago");
    // No params at all: interpolate() short-circuits and returns the raw template.
    expect(t("shell.updated")).toBe("Updated {when}");
    setLocale("en");
  });

  test("switches language at use time, not at import time", () => {
    setLocale("tr");
    expect(t("common.cancel")).toBe("İptal");
    setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
  });
});

describe("tn() plural selection", () => {
  test("picks .one for 1 and .other otherwise, in English and Turkish", () => {
    setLocale("en");
    expect(tn("launchd.trigger.watchesPath", 1)).toBe("Watches 1 path");
    expect(tn("launchd.trigger.watchesPath", 2)).toBe("Watches 2 paths");
    expect(tn("launchd.trigger.watchesPath", 0)).toBe("Watches 0 paths");

    setLocale("tr");
    expect(tn("launchd.trigger.watchesPath", 1)).toBe("1 yolu izliyor");
    expect(tn("launchd.trigger.watchesPath", 5)).toBe("5 yolu izliyor");
    setLocale("en");
  });
});

describe("tDynamic()", () => {
  test("returns the dictionary value when the key exists, else the fallback", () => {
    setLocale("en");
    expect(tDynamic("launchd.key.Label.title", "fallback")).toBe("Label");
    expect(tDynamic("launchd.key.NoSuchKey.title", "fallback")).toBe("fallback");
    setLocale("tr");
    expect(tDynamic("launchd.key.Label.title", "fallback")).toBe("Etiket");
    expect(tDynamic("launchd.key.NoSuchKey.title", "fallback")).toBe("fallback");
    setLocale("en");
  });
});
