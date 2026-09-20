import { describe, expect, test } from "bun:test";
import { outlineDepths } from "./outline.ts";

describe("how far each heading sits under the ones above it", () => {
  test("a section under the title is one step in", () => {
    expect(outlineDepths([1, 2, 2, 3, 2])).toEqual([0, 1, 1, 2, 1]);
  });
  test("a heading with nothing above it stands at the margin whatever its level", () => {
    expect(outlineDepths([2, 2, 3])).toEqual([0, 0, 1]);
  });
  test("a skipped level is one step, not two", () => {
    expect(outlineDepths([1, 3, 3, 2, 3])).toEqual([0, 1, 1, 1, 2]);
  });
  test("a second title closes everything under the first", () => {
    expect(outlineDepths([1, 2, 3, 1, 2])).toEqual([0, 1, 2, 0, 1]);
  });
  test("no headings", () => {
    expect(outlineDepths([])).toEqual([]);
  });
});
