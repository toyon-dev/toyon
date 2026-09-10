import { describe, expect, test } from "bun:test";
import { dollars, tokens } from "./usage.ts";

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
