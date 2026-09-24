import { describe, expect, test } from "bun:test";
import { normalizeThoughtMarkdown, thoughtLine, thoughtSteps } from "./thought.ts";

/** a run of Codex reasoning summaries with no call between them, as the store glues the parts:
 * each arrives as a blank line then one bold headline */
const COLUMN =
  "\n\n**Verifying adapter source path handling**\n\n**Assessing adapter quota reporting**\n\n**Locating line numbers for `deps`**";

describe("thoughtLine", () => {
  test("a reasoning headline, as Codex sends one, is the line", () => {
    expect(thoughtLine("\n\n**Inspecting module documentation**")).toBe("Inspecting module documentation");
    expect(thoughtLine("Checking `foo` next")).toBe("Checking foo next");
  });

  test("a column of headlines is read by its newest", () => {
    expect(thoughtLine(COLUMN)).toBe("Locating line numbers for deps");
  });

  test("a paragraph, two lines, or nothing is not", () => {
    expect(thoughtLine("**Planning**\n\nFirst I will read the file.")).toBe("");
    expect(thoughtLine(`${"a long thought ".repeat(10)}that runs on past the width of a line`)).toBe("");
    expect(thoughtLine("\n\n")).toBe("");
  });
});

describe("thoughtSteps", () => {
  test("the headlines of a column, in order, unwrapped", () => {
    expect(thoughtSteps(COLUMN)).toEqual([
      "Verifying adapter source path handling",
      "Assessing adapter quota reporting",
      "Locating line numbers for deps",
    ]);
    expect(thoughtSteps("\n\n**Inspecting module documentation**")).toEqual(["Inspecting module documentation"]);
  });

  test("a paragraph among the headlines, or short paragraphs of prose, is not a column", () => {
    expect(thoughtSteps("**Planning**\n\nFirst I will read the file.")).toEqual([]);
    expect(thoughtSteps("Let me check the file.\n\nActually, grep first.")).toEqual([]);
    expect(thoughtSteps("**Planning** the read\n\n**Reading**")).toEqual([]);
    expect(thoughtSteps("\n\n")).toEqual([]);
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
