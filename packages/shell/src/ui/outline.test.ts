import { describe, expect, test } from "bun:test";
import { outlineCentre, outlineDepths } from "./outline.ts";

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

describe("where the titles open against the strip", () => {
  const strip = { top: 100, bottom: 900 };
  test("a list taller than the strip sits on the strip's middle wherever the hand is", () => {
    expect(outlineCentre(strip, 100, 1000)).toBe(500);
    expect(outlineCentre(strip, 900, 1000)).toBe(500);
  });
  test("a shorter list stays on the middle while the hand is inside it there", () => {
    expect(outlineCentre(strip, 420, 400)).toBe(500);
  });
  test("a shorter list moves only as far as it takes to hold the hand", () => {
    // the hand at the head of the strip is half a row under the list's top edge
    expect(outlineCentre(strip, 100, 400)).toBe(288);
    expect(outlineCentre(strip, 900, 400)).toBe(712);
  });
});
