import { describe, expect, test } from "bun:test";
import { FOLD_SETTLE, foldAt } from "./fold.ts";

describe("the box riding the end of the log", () => {
  test("rides as far up as the reader is, to its extent", () => {
    expect(foldAt(0, 69, false)).toEqual({ ride: 0, folded: false });
    expect(foldAt(30, 69, false)).toEqual({ ride: 30, folded: false });
    expect(foldAt(69, 69, false)).toEqual({ ride: 69, folded: false });
    expect(foldAt(400, 69, false)).toEqual({ ride: 69, folded: true });
  });

  test("folds only past the extent, and unfolds only inside it", () => {
    expect(foldAt(69 + FOLD_SETTLE - 1, 69, false).folded).toBe(false);
    expect(foldAt(69 + FOLD_SETTLE, 69, false).folded).toBe(true);
    expect(foldAt(69 + 1, 69, true).folded).toBe(true);
    expect(foldAt(69, 69, true).folded).toBe(false);
  });

  test("a log overscrolled past its end rides nothing", () => {
    expect(foldAt(-3, 69, false)).toEqual({ ride: 0, folded: false });
  });

  test("a box with no extent folds just off the end and unfolds at it", () => {
    expect(foldAt(FOLD_SETTLE, 0, false).folded).toBe(true);
    expect(foldAt(0, 0, true).folded).toBe(false);
  });
});
