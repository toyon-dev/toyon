import { describe, expect, test } from "bun:test";
import { parseName, parsePlan } from "./tasks.ts";

describe("parseName", () => {
  test("keeps 2-4 kebab words, cleans quotes and case, takes the last line", () => {
    expect(parseName("Sticky-Header")).toBe("sticky-header");
    expect(parseName("`dark-mode-toggle`\n")).toBe("dark-mode-toggle");
    expect(parseName("Sure! Here is a name:\nadd about page")).toBe("add-about-page");
  });
  test("rejects sentences, errors and empties", () => {
    expect(parseName("I cannot name this task without more context about it")).toBeNull();
    expect(parseName("credit-balance-is-too-low-error")).toBeNull();
    expect(parseName("")).toBeNull();
    expect(parseName(null)).toBeNull();
    expect(parseName("ab")).toBeNull();
  });
});

describe("parsePlan", () => {
  test("reads the array out of prose and caps it at five", () => {
    expect(parsePlan('Here you go:\n["a", "b", 3, "", "c", "d", "e", "f"]')).toEqual(["a", "b", "c", "d", "e"]);
  });
  test("no array, bad JSON, or nothing usable → null", () => {
    expect(parsePlan("one task")).toBeNull();
    expect(parsePlan("[oops")).toBeNull();
    expect(parsePlan("[1, 2]")).toBeNull();
    expect(parsePlan(null)).toBeNull();
  });
});
