import { describe, expect, test } from "bun:test";
import { minimalEdit } from "./minimalEdit.ts";

const apply = (from: string, to: string) => {
  const e = minimalEdit(from, to);
  return e ? from.slice(0, e.start) + e.text + from.slice(e.end) : from;
};

describe("the one edit that turns a file into its new text", () => {
  test("the same text is no edit", () => {
    expect(minimalEdit("a\nb\n", "a\nb\n")).toBeNull();
  });

  test("only the lines between what the two share are replaced", () => {
    expect(minimalEdit("one\ntwo\nthree\n", "one\n2\nthree\n")).toEqual({ start: 4, end: 8, text: "2\n" });
    expect(minimalEdit("a\nb", "a\nb\nc")).toEqual({ start: 2, end: 3, text: "b\nc" });
  });

  test("a cut never splits a CRLF, and applying the edit gives the new text", () => {
    const cases: Array<[string, string]> = [
      ["a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n"],
      ["", "new\n"],
      ["gone\n", ""],
      ["x\ny\n", "y\n"],
      ["same\nsame\n", "same\n"],
      ["no newline", "no newline\n"],
    ];
    for (const [from, to] of cases) {
      expect(apply(from, to)).toBe(to);
      const e = minimalEdit(from, to);
      if (e) expect(from[e.start - 1] === "\r").toBe(false);
    }
  });
});
