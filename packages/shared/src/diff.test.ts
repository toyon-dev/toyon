import { describe, expect, test } from "bun:test";
import { diffSeq, splitSpanLines, tokenize, wordSpans } from "./diff.ts";

const marks = <T>(a: T[], b: T[]) =>
  diffSeq(a, b)
    .map((op) => `${op.mark}${op.value}`)
    .join(" ");

describe("diffSeq", () => {
  test("keeps what both sides share and marks the rest", () => {
    expect(marks(["a", "b", "c"], ["a", "x", "c"])).toBe(" a -b +x  c");
    expect(marks([], ["a"])).toBe("+a");
    expect(marks(["a"], [])).toBe("-a");
    expect(marks(["a"], ["a"])).toBe(" a");
  });

  test("a move comes out as a deletion and an addition, in file order", () => {
    expect(marks(["a", "b", "c"], ["b", "c", "a"])).toBe("-a  b  c +a");
  });
});

describe("tokenize", () => {
  test("splits on words, whitespace runs and single punctuation", () => {
    expect(tokenize("  metrics[0].id")).toEqual(["  ", "metrics", "[", "0", "]", ".", "id"]);
  });
});

describe("wordSpans", () => {
  test("an edited line keeps what carried over", () => {
    expect(wordSpans("assert metrics[0]", "assert metrics[1]")).toEqual({
      before: [
        { text: "assert metrics[", changed: false },
        { text: "0", changed: true },
        { text: "]", changed: false },
      ],
      after: [
        { text: "assert metrics[", changed: false },
        { text: "1", changed: true },
        { text: "]", changed: false },
      ],
    });
  });

  test("an insertion marks only the inserted words on the side that has them", () => {
    const pair = wordSpans("const a = 1;", "const a = 1; // why");
    expect(pair?.before).toEqual([{ text: "const a = 1;", changed: false }]);
    expect(pair?.after).toEqual([
      { text: "const a = 1;", changed: false },
      { text: " // why", changed: true },
    ]);
  });

  test("two different lines are not one line edited", () => {
    expect(wordSpans("const port = 3000;", 'import { serve } from "bun";')).toBeNull();
    expect(wordSpans("same", "same")).toBeNull();
  });

  test("the gap between two words that stayed is not a change", () => {
    const pair = wordSpans("a = 1", "a  = 1");
    expect(pair?.before.every((s) => !s.changed)).toBe(true);
  });

  test("a bracket the change happened around goes with the change", () => {
    const pair = wordSpans("redacted = metrics[1]", "redacted = by_id[metric.id]");
    expect(pair?.after).toEqual([
      { text: "redacted = ", changed: false },
      { text: "by_id[metric.id", changed: true },
      { text: "]", changed: false },
    ]);
  });

  test("a run of lines lines up against the run that replaced it", () => {
    const pair = wordSpans(".img {\n  height: 75px;\n  filter: none;\n}", ".img {\n  height: 75px;\n}");
    const before = splitSpanLines(pair?.before ?? []);
    expect(before.map((line) => line.some((s) => s.changed))).toEqual([false, false, true, false]);
    expect(splitSpanLines(pair?.after ?? []).every((line) => line.every((s) => !s.changed))).toBe(true);
  });
});
