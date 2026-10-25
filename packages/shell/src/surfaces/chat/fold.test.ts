import { describe, expect, test } from "bun:test";
import { FOLD_SETTLE, foldedAt } from "./fold.ts";

describe("the box folded past its ride", () => {
  test("folds only past the extent, and unfolds only inside it", () => {
    expect(foldedAt(0, 69, false)).toBe(false);
    expect(foldedAt(69, 69, false)).toBe(false);
    expect(foldedAt(69 + FOLD_SETTLE - 1, 69, false)).toBe(false);
    expect(foldedAt(69 + FOLD_SETTLE, 69, false)).toBe(true);
    expect(foldedAt(69 + 1, 69, true)).toBe(true);
    expect(foldedAt(69, 69, true)).toBe(false);
  });

  test("a log overscrolled past its end is not folded", () => {
    expect(foldedAt(-3, 69, false)).toBe(false);
  });

  test("a box with no extent folds just off the end and unfolds at it", () => {
    expect(foldedAt(FOLD_SETTLE, 0, false)).toBe(true);
    expect(foldedAt(0, 0, true)).toBe(false);
  });
});
