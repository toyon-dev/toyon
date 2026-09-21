import { describe, expect, test } from "bun:test";
import { normalizeThoughtMarkdown, thoughtLine } from "./thought.ts";

describe("thoughtLine", () => {
  test("a reasoning headline, as Codex sends one, is the line", () => {
    expect(thoughtLine("\n\n**Inspecting module documentation**")).toBe("Inspecting module documentation");
    expect(thoughtLine("Checking `foo` next")).toBe("Checking foo next");
  });

  test("a paragraph, two lines, or nothing is not", () => {
    expect(thoughtLine("**Planning**\n\nFirst I will read the file.")).toBe("");
    expect(thoughtLine(`${"a long thought ".repeat(10)}that runs on past the width of a line`)).toBe("");
    expect(thoughtLine("\n\n")).toBe("");
  });
});

describe("normalizeThoughtMarkdown", () => {
  test("turns whole bold summary lines into ordinary thought prose", () => {
    expect(normalizeThoughtMarkdown("**Preparing the plan**\n\n**Reading the files**")).toBe(
      "Preparing the plan\n\nReading the files",
    );
  });

  test("keeps emphasis that is part of a sentence", () => {
    expect(normalizeThoughtMarkdown("The **important** part\n\n**First** and then second")).toBe(
      "The **important** part\n\n**First** and then second",
    );
  });
});
