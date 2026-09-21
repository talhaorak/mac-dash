import { describe, expect, test } from "bun:test";
import { sparklinePaths } from "./MiniChart";

const numbers = (path: string) => (path.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);

describe("sparkline path", () => {
  test("fewer than two points draw nothing", () => {
    expect(sparklinePaths([], 100, 40)).toBeNull();
    expect(sparklinePaths([50], 100, 40)).toBeNull();
  });

  test("fixed 0–100 domain with a 1 px inset", () => {
    const paths = sparklinePaths([0, 100], 100, 40)!;
    expect(paths.line.startsWith("M0,39")).toBe(true); // 0 % is the bottom
    expect(paths.line.endsWith("100,1")).toBe(true); // 100 % is the top
    expect(paths.area).toBe(`${paths.line}L100,40L0,40Z`);
  });

  test("values outside the domain and non-numbers are clamped", () => {
    const paths = sparklinePaths([-20, 250, Number.NaN], 100, 40)!;
    const ys = numbers(paths.line).filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...ys)).toBeLessThanOrEqual(39);
  });

  test("the curve never overshoots the data (monotone)", () => {
    const paths = sparklinePaths([10, 10, 90, 90, 10, 50, 50], 120, 40)!;
    const ys = numbers(paths.line).filter((_, i) => i % 2 === 1);
    const top = 1 + (1 - 90 / 100) * 38;
    const bottom = 1 + (1 - 10 / 100) * 38;
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(top - 0.01);
      expect(y).toBeLessThanOrEqual(bottom + 0.01);
    }
  });

  test("a flat series is a flat line", () => {
    const ys = numbers(sparklinePaths([40, 40, 40], 100, 40)!.line).filter((_, i) => i % 2 === 1);
    expect(new Set(ys).size).toBe(1);
  });
});
