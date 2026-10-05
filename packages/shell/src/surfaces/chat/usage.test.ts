import { describe, expect, test } from "bun:test";
import { compactAdvice, compactNudge, dollars, tokens } from "./usage.ts";

describe("tokens", () => {
  test("reads like speech", () => {
    expect(tokens(812)).toBe("812");
    expect(tokens(9_540)).toBe("9.5k");
    expect(tokens(10_000)).toBe("10k");
    expect(tokens(42_300)).toBe("42k");
    expect(tokens(200_000)).toBe("200k");
  });
});

describe("dollars", () => {
  test("to the cent, and never a zero for something that cost", () => {
    expect(dollars(0)).toBe("$0.00");
    expect(dollars(0.004)).toBe("<$0.01");
    expect(dollars(0.12)).toBe("$0.12");
    expect(dollars(1.036)).toBe("$1.04");
  });
});

describe("compactAdvice", () => {
  test("argues against while there is room, and for once there is not", () => {
    expect(compactAdvice(0.12)).toBe("12% full: plenty of room, no need yet");
    expect(compactAdvice(0.64)).toBe("64% full: worth doing between tasks");
    expect(compactAdvice(0.91)).toBe("91% full: do it before the next task");
  });
});

describe("compactNudge", () => {
  test("says nothing while there is room", () => {
    expect(compactNudge(0.12)).toBeUndefined();
    expect(compactNudge(0.64)).toBe("worth compacting between tasks");
    expect(compactNudge(0.91)).toBe("compact before the next task");
  });
});
