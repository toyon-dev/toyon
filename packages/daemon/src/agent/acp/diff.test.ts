import { describe, expect, test } from "bun:test";
import { unifiedDiff } from "./diff.ts";

const file = (n: number, edit?: (lines: string[]) => void) => {
  const lines = Array.from({ length: n }, (_, i) => `line ${i + 1}`);
  edit?.(lines);
  return lines.join("\n");
};

describe("unifiedDiff", () => {
  test("a one-line edit in a long file prints that line and its context, not the file", () => {
    const out = unifiedDiff(
      file(40),
      file(40, (l) => {
        l[19] = "line 20 changed";
      }),
    );
    expect(out.split("\n")).toEqual([
      "@@ -17,7 +17,7 @@",
      " line 17",
      " line 18",
      " line 19",
      "-line 20",
      "+line 20 changed",
      " line 21",
      " line 22",
      " line 23",
    ]);
  });

  test("edits far apart get a hunk each, and close ones share one", () => {
    const far = unifiedDiff(
      file(40),
      file(40, (l) => {
        l[4] = "a";
        l[34] = "b";
      }),
    );
    expect(far.match(/^@@/gm)).toHaveLength(2);
    const near = unifiedDiff(
      file(40),
      file(40, (l) => {
        l[10] = "a";
        l[13] = "b";
      }),
    );
    expect(near.match(/^@@/gm)).toHaveLength(1);
    // the shared hunk prints the lines between the two edits once
    expect(near.split("\n").filter((l) => l === " line 13")).toHaveLength(1);
  });

  test("a new file is all additions and an emptied one all deletions", () => {
    expect(unifiedDiff("", "a\nb")).toBe("@@ -1,0 +1,2 @@\n+a\n+b");
    expect(unifiedDiff("a\nb", "")).toBe("@@ -1,2 +1,0 @@\n-a\n-b");
  });

  test("no change is no diff at all", () => {
    expect(unifiedDiff(file(10), file(10))).toBe("");
  });

  test("a file past the table's size still diffs down to its changed region", () => {
    const big = file(4000);
    const out = unifiedDiff(
      big,
      file(4000, (l) => {
        l[1999] = "changed";
      }),
    );
    expect(out.split("\n")).toHaveLength(9);
    expect(out).toContain("+changed");
  });
});
