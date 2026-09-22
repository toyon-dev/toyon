import { describe, expect, test } from "bun:test";
import { outlineDepths } from "./outline.ts";

describe("how far each heading sits under the ones above it", () => {
  test("the title opens no level: sections under it stand at the margin", () => {
    expect(outlineDepths([1, 2, 2, 3, 2])).toEqual([0, 0, 0, 1, 0]);
  });
  test("a heading with nothing above it stands at the margin whatever its level", () => {
    expect(outlineDepths([2, 2, 3])).toEqual([0, 0, 1]);
  });
  test("a skipped level is one step, not two", () => {
    expect(outlineDepths([2, 4, 4, 3, 4])).toEqual([0, 1, 1, 1, 2]);
  });
  test("a second title closes everything under the first", () => {
    expect(outlineDepths([1, 2, 3, 1, 2])).toEqual([0, 0, 1, 0, 0]);
  });
  test("no headings", () => {
    expect(outlineDepths([])).toEqual([]);
  });
});
