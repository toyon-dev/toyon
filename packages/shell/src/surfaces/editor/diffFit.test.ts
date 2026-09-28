import { describe, expect, test } from "bun:test";
import { CONTEXT_FLOOR, diffFit, type Hunk } from "./diffFit.ts";

// 17px rows; a fold band is 24px
const pane = (rows: number) => ({ height: rows * 17, lineHeight: 17 });
const hunk = (modifiedStart: number, original: number, modified: number): Hunk => ({
  modifiedStart,
  original,
  modified,
});

describe("what a diff folds, given the pane it is read in", () => {
  test("a diff that fits the pane is shown whole", () => {
    expect(diffFit(pane(65), 30, [hunk(10, 1, 1)])).toEqual({
      enabled: false,
      contextLineCount: CONTEXT_FLOOR,
      scrolls: false,
    });
    expect(diffFit(pane(65), 65, [hunk(1, 0, 5)]).enabled).toBe(false);
  });

  test("deleted lines take rows of their own, so they count against the fit", () => {
    // a 20-line file whose diff removed 50 at line 5: 70 rows in a pane of 62. The 4 lines
    // ahead never fold (too short to hold a context and the minimum); the 16 after fold down to
    // a context of 6 at most, and 4 + 50 + 6 rows and one band is what the pane holds
    expect(diffFit(pane(62), 20, [hunk(5, 50, 0)])).toEqual({ enabled: true, contextLineCount: 6, scrolls: false });
  });

  test("one small hunk in a long file takes the context that fills the pane", () => {
    // a deleted line at 23 of 83, in a pane of 65 rows: the 22 lines ahead stop folding past a
    // context of 12 and show whole, and the tail keeps as much context as the rest of the pane
    // holds beside one band: 22 + 1 + 40 rows
    expect(diffFit(pane(65), 83, [hunk(23, 1, 0)])).toEqual({ enabled: true, contextLineCount: 40, scrolls: false });
  });

  test("a short gap between hunks is shown whole and costs no band", () => {
    // four hunks close together, as a real file has them: the gaps of 8 and 11 lines never fold
    // (they are under 2 * context + 10), so the context is set by the ends alone
    const hunks = [hunk(63, 0, 10), hunk(399, 0, 1), hunk(408, 0, 1), hunk(420, 0, 1)];
    const fold = diffFit(pane(62), 511, hunks);
    expect(fold.enabled).toBe(true);
    expect(fold.scrolls).toBe(false);
    // 13 hunk rows, 8 + 11 between: 32 rows and three bands (4.2 rows) leave about 25 rows for
    // four contexts (head, after the first hunk, before the second, tail): 6 each
    expect(fold.contextLineCount).toBe(6);
  });

  test("many hunks in a short pane keep the floor and scroll", () => {
    const hunks = Array.from({ length: 10 }, (_, i) => hunk(100 * (i + 1), 2, 2));
    expect(diffFit(pane(40), 2000, hunks)).toEqual({ enabled: true, contextLineCount: CONTEXT_FLOOR, scrolls: true });
  });

  test("no hunks is nothing to fold", () => {
    expect(diffFit(pane(10), 500, []).enabled).toBe(false);
  });
});
