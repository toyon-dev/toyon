import { describe, expect, test } from "bun:test";
import { variantLens } from "./naming.ts";

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
