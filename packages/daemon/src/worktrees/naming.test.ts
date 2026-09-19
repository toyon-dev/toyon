import { describe, expect, test } from "bun:test";
import { branchSlug, cleanTitle, titleFrom, variantLens } from "./naming.ts";

describe("cleanTitle", () => {
  test("keeps the words and the case, and reads as one line", () => {
    expect(cleanTitle("  Sticky header  ")).toBe("Sticky header");
    expect(cleanTitle("sticky\nheader\ttoo")).toBe("sticky header too");
    expect(cleanTitle("Fix the badge!")).toBe("Fix the badge");
    expect(cleanTitle(":: dark mode ,")).toBe("dark mode");
    expect(cleanTitle("   ")).toBe("");
  });
  test("held to about what the rail shows", () => {
    expect(cleanTitle("a".repeat(60))).toBe("a".repeat(40));
  });
});

describe("branchSlug", () => {
  test("a title git can spell, or nothing", () => {
    expect(branchSlug("Sticky header")).toBe("sticky-header");
    expect(branchSlug("dark mode (again)")).toBe("dark-mode-again");
    expect(branchSlug("Sticky header v2")).toBe("sticky-header-v2");
    expect(branchSlug("日本語")).toBe("");
  });
});

describe("titleFrom", () => {
  test("the first words of the prompt, read as a title", () => {
    expect(titleFrom("make the header sticky on scroll")).toBe("Make the header");
    expect(titleFrom("  add a badge")).toBe("Add a badge");
    expect(titleFrom("")).toBe("Task");
  });
});

describe("variantLens", () => {
  test("every attempt carries the shared bounds and a lens of its own", () => {
    const lenses = [1, 2, 3].map(variantLens);
    for (const [i, lens] of lenses.entries()) {
      expect(lens).toContain(`attempt ${i + 1} of several`);
      expect(lens).toContain("follow the project's existing styles");
    }
    expect(new Set(lenses).size).toBe(3);
  });

  test("the look-and-read lens stays inside what the project already has", () => {
    expect(variantLens(2)).toContain("only the design tokens, components and voice the project already has");
  });

  test("an attempt past the last lens wraps to the first", () => {
    expect(variantLens(4)).toContain("smallest diff");
  });
});
