import { describe, expect, test } from "bun:test";
import { normalizeThoughtMarkdown } from "./thought.ts";

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
