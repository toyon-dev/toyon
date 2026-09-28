import { describe, expect, test } from "bun:test";
import { isFind, matchOffsets, nearestIndex, segmentsOf, spanOf, stepped } from "./find.ts";

describe("matchOffsets", () => {
  test("ignores case and finds every occurrence", () => {
    expect(matchOffsets("Branch, branch, BRANCH", "branch")).toEqual([
      { start: 0, end: 6 },
      { start: 8, end: 14 },
      { start: 16, end: 22 },
    ]);
  });
  test("an empty query matches nothing", () => {
    expect(matchOffsets("anything", "")).toEqual([]);
  });
  test("the query is text, not a pattern", () => {
    expect(matchOffsets("a.b axb", "a.b")).toEqual([{ start: 0, end: 3 }]);
    expect(matchOffsets("(x) [y]", "(x)")).toEqual([{ start: 0, end: 3 }]);
  });
  test("matches do not overlap", () => {
    expect(matchOffsets("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });
});

describe("spanOf", () => {
  // "the ", "branch", " name": the word in bold between two runs
  const segs = segmentsOf([4, 6, 5]);
  test("a match inside one node stays in it", () => {
    expect(spanOf(segs, { start: 4, end: 10 })).toEqual({ from: { i: 1, at: 0 }, to: { i: 1, at: 6 } });
  });
  test("a match across a boundary starts in one node and ends in the next", () => {
    expect(spanOf(segs, { start: 2, end: 7 })).toEqual({ from: { i: 0, at: 2 }, to: { i: 1, at: 3 } });
  });
  test("a match ending on a boundary closes in the node it ends in", () => {
    expect(spanOf(segs, { start: 8, end: 10 }).to).toEqual({ i: 1, at: 6 });
  });
  test("a match starting on a boundary opens the node that begins there", () => {
    expect(spanOf(segs, { start: 10, end: 12 }).from).toEqual({ i: 2, at: 0 });
  });
  test("the last node's end is reachable", () => {
    expect(spanOf(segs, { start: 12, end: 15 }).to).toEqual({ i: 2, at: 5 });
  });
});

describe("nearestIndex", () => {
  const matches = [
    { start: 3, end: 5 },
    { start: 12, end: 14 },
    { start: 30, end: 32 },
  ];
  test("the first match at or past where the reader was", () => {
    expect(nearestIndex(matches, 0)).toBe(0);
    expect(nearestIndex(matches, 12)).toBe(1);
    expect(nearestIndex(matches, 13)).toBe(2);
  });
  test("past the last match it wraps to the first", () => {
    expect(nearestIndex(matches, 40)).toBe(0);
  });
  test("no matches is no index", () => {
    expect(nearestIndex([], 5)).toBe(-1);
  });
});

describe("stepped", () => {
  test("wraps at both ends", () => {
    expect(stepped(2, 3, 1)).toBe(0);
    expect(stepped(0, 3, -1)).toBe(2);
    expect(stepped(1, 3, 1)).toBe(2);
  });
  test("nothing to step through", () => {
    expect(stepped(-1, 0, 1)).toBe(-1);
  });
});

describe("isFind", () => {
  const key = (over: Partial<Parameters<typeof isFind>[0]>) => ({
    key: "f",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  });
  test("the command or control key with f alone", () => {
    expect(isFind(key({}))).toBe(true);
    expect(isFind(key({ metaKey: false, ctrlKey: true }))).toBe(true);
  });
  test("shift makes it search in files, and alt is another chord", () => {
    expect(isFind(key({ shiftKey: true }))).toBe(false);
    expect(isFind(key({ altKey: true }))).toBe(false);
    expect(isFind(key({ metaKey: false }))).toBe(false);
  });
});
