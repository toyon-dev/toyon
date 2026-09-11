import { expect, test } from "bun:test";
import { ghostOf, jumpTo, sectionStarts, step } from "./listNav.ts";

test("a rule starts where the group changes, never above the first row", () => {
  const rows = [
    { g: "go", p: "/x" },
    { g: "page", p: "/a" },
    { g: "page", p: "/b" },
    { g: "go", p: "/y" },
  ];
  expect(sectionStarts(rows, (r) => r.g)).toEqual([false, true, false, true]);
  expect(sectionStarts(rows)).toEqual([false, false, false, false]);
  expect(sectionStarts([], (r: { g: string }) => r.g)).toEqual([]);
});

test("a letter jumps to the next row starting with it, wrapping, and repeats walk the matches", () => {
  const rows = ["take over", "open a shell here", "reveal in Finder", "copy path", "Remove…"];
  expect(jumpTo(rows, -1, "t")).toBe(0);
  expect(jumpTo(rows, -1, "r")).toBe(2);
  expect(jumpTo(rows, 2, "r")).toBe(4);
  expect(jumpTo(rows, 4, "r")).toBe(2);
  expect(jumpTo(rows, 0, "T")).toBe(0);
  expect(jumpTo(rows, 1, "z")).toBe(-1);
  expect(jumpTo([], -1, "a")).toBe(-1);
});

test("↑↓ wrap at both ends", () => {
  expect(step(0, 1, 3)).toBe(1);
  expect(step(2, 1, 3)).toBe(0);
  expect(step(0, -1, 3)).toBe(2);
});
test("an empty list pins the highlight to 0", () => {
  expect(step(0, 1, 0)).toBe(0);
  expect(step(5, -1, 0)).toBe(0);
});
test("stepping from a stale index (results shrank) stays in range", () => {
  // useListNav clamps before stepping; the raw step must still land inside the list
  expect(step(Math.min(7, 2), 1, 3)).toBe(0);
});

test("the ghost is only the tail past what was typed, matched case-insensitively", () => {
  expect(ghostOf("toyon", "toy")).toBe("on");
  expect(ghostOf("Toyon", "toy")).toBe("on");
  expect(ghostOf("toy", "toy")).toBeNull();
  expect(ghostOf("other", "toy")).toBeNull();
  expect(ghostOf(null, "toy")).toBeNull();
});
