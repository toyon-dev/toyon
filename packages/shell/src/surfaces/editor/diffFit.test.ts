import { describe, expect, test } from "bun:test";
import { CONTEXT_FLOOR, diffFit } from "./diffFit.ts";

describe("what a diff folds, given the pane it is read in", () => {
  test("a diff that fits the pane is shown whole", () => {
    expect(diffFit(65, 30, [{ original: 1, modified: 1 }])).toEqual({
      enabled: false,
      contextLineCount: CONTEXT_FLOOR,
    });
    expect(diffFit(65, 65, [{ original: 0, modified: 5 }]).enabled).toBe(false);
  });

  test("deleted lines take rows of their own, so they count against the fit", () => {
    // a 20-line file whose diff removed 50: 70 rows in a pane of 62
    const fold = diffFit(62, 20, [{ original: 50, modified: 0 }]);
    expect(fold.enabled).toBe(true);
    expect(fold.contextLineCount).toBe(4);
  });

  test("one small hunk in a long file takes the context that fills the pane", () => {
    // 1 changed row, 2 fold bands counted as 4 rows, 60 rows left for context: 30 a side
    expect(diffFit(65, 83, [{ original: 1, modified: 0 }])).toEqual({ enabled: true, contextLineCount: 30 });
  });

  test("many hunks in a short pane keep the floor", () => {
    const hunks = Array.from({ length: 10 }, () => ({ original: 2, modified: 2 }));
    expect(diffFit(40, 2000, hunks)).toEqual({ enabled: true, contextLineCount: CONTEXT_FLOOR });
  });

  test("no hunks is nothing to fold", () => {
    expect(diffFit(10, 500, []).enabled).toBe(false);
  });
});
