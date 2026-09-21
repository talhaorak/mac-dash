import { describe, expect, test } from "bun:test";
import { avatarHue, avatarLetter, emojiIcon, isIconDataUrl, resolveIcon } from "./JobIcon";
import { DEFAULT_VIEW_OPTIONS, sanitizeViewOptions } from "./ViewOptions";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("isIconDataUrl", () => {
  test("accepts base64 PNG and JPEG", () => {
    expect(isIconDataUrl(PNG)).toBe(true);
    expect(isIconDataUrl("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
  });

  test("refuses every other scheme, media type and encoding", () => {
    for (const value of [
      "",
      "javascript:alert(1)",
      "https://example.com/icon.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "data:text/html;base64,PGI+",
      "data:image/png,rawbytes",
      "data:image/png;base64,",
      "data:image/png;base64,abc def",
      "data:image/png;base64,abc\"onerror=\"x",
      "DATA:IMAGE/PNG;BASE64,AAAA",
      " data:image/png;base64,AAAA",
      "data:image/png;charset=utf-8;base64,AAAA",
    ]) {
      expect(isIconDataUrl(value)).toBe(false);
    }
  });

  test("refuses a huge value", () => {
    expect(isIconDataUrl(`data:image/png;base64,${"A".repeat(600 * 1024)}`)).toBe(false);
  });
});

describe("resolveIcon", () => {
  test("image, emoji, nothing", () => {
    expect(resolveIcon(PNG)).toEqual({ kind: "image", src: PNG });
    expect(resolveIcon("🚀")).toEqual({ kind: "emoji", text: "🚀" });
    expect(resolveIcon(undefined)).toBeNull();
    expect(resolveIcon(null)).toBeNull();
    expect(resolveIcon("")).toBeNull();
    expect(resolveIcon("   ")).toBeNull();
    expect(resolveIcon(42 as unknown as string)).toBeNull();
  });

  test("a data URL that is not an allowed image never becomes text or an image", () => {
    expect(resolveIcon("data:text/html;base64,PGI+")).toBeNull();
    expect(resolveIcon("DATA:image/svg+xml;base64,AAAA")).toBeNull();
  });

  test("a text icon is cut to its first character", () => {
    expect(emojiIcon("🚀🎉")).toBe("🚀");
    expect(emojiIcon("  B  ")).toBe("B");
    expect(emojiIcon("hello")).toBe("h");
    expect(emojiIcon("👨‍👩‍👧‍👦 family")).toBe("👨‍👩‍👧‍👦");
    expect(emojiIcon("🇹🇷")).toBe("🇹🇷");
  });
});

describe("letter avatar", () => {
  test("a reverse-DNS label shows the vendor", () => {
    expect(avatarLetter("com.docker.vmnetd")).toBe("D");
    expect(avatarLetter("org.mozilla.updater")).toBe("M");
    expect(avatarLetter("com.apple.Safari.helper")).toBe("A");
  });

  test("every other label shows its first letter or digit", () => {
    expect(avatarLetter("homebrew.mxcl.postgresql")).toBe("H");
    expect(avatarLetter("backup")).toBe("B");
    expect(avatarLetter("com.example")).toBe("C");
    expect(avatarLetter("4d.server.thing")).toBe("S");
    expect(avatarLetter("_-7zip")).toBe("7");
    expect(avatarLetter("com.überfirma.job")).toBe("Ü");
    expect(avatarLetter("")).toBe("?");
    expect(avatarLetter("...")).toBe("?");
  });

  test("the hue is stable, in range, and differs between labels", () => {
    const labels = ["com.example.a", "com.example.b", "com.docker.vmnetd", "", "x".repeat(500)];
    for (const label of labels) {
      const hue = avatarHue(label);
      expect(hue).toBe(avatarHue(label));
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
    expect(avatarHue("com.example.a")).not.toBe(avatarHue("com.example.b"));
  });
});

describe("sanitizeViewOptions", () => {
  test("everything is visible by default and for bad input", () => {
    for (const input of [undefined, null, 7, "x", [], {}]) expect(sanitizeViewOptions(input)).toEqual(DEFAULT_VIEW_OPTIONS);
    expect(Object.values(DEFAULT_VIEW_OPTIONS).every(Boolean)).toBe(true);
  });

  test("only an explicit false hides a part, unknown keys are dropped", () => {
    expect(sanitizeViewOptions({ statusFilter: false, ownerFilter: 0, tagFilter: "false", powerCard: false, extra: false })).toEqual({
      ...DEFAULT_VIEW_OPTIONS,
      statusFilter: false,
      powerCard: false,
    });
  });
});
