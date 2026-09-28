import { describe, expect, test } from "bun:test";
import { describeDuration, parseDuration, shortDuration } from "./duration.ts";

describe("parseDuration", () => {
  test("reads one number and one unit", () => {
    expect(parseDuration("30m")).toBe(30 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1.5h")).toBe(90 * 60_000);
    expect(parseDuration(" 2 h ")).toBe(2 * 60 * 60_000);
  });

  test("refuses anything else", () => {
    for (const bad of ["", "30", "m", "1h30m", "ten minutes", "-5m", "0m", "5ms"]) {
      expect(parseDuration(bad)).toBeNull();
    }
  });
});

describe("describeDuration", () => {
  test("says the largest unit that divides it, and rounds past an hour of minutes", () => {
    expect(describeDuration(30 * 60_000)).toBe("30 minutes");
    expect(describeDuration(60_000)).toBe("1 minute");
    expect(describeDuration(90_000)).toBe("90 seconds");
    expect(describeDuration(60 * 60_000)).toBe("1 hour");
    expect(describeDuration(90 * 60_000)).toBe("90 minutes");
    expect(describeDuration(10_000)).toBe("10 seconds");
  });

  test("the short form is what a settings file writes", () => {
    expect(shortDuration(30 * 60_000)).toBe("30m");
    expect(shortDuration(90_000)).toBe("90s");
    expect(shortDuration(2 * 60 * 60_000)).toBe("2h");
  });
});
