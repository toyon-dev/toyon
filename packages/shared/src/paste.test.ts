import { describe, expect, test } from "bun:test";
import { isLongPaste, pasteSummary, sourceLabel, stripAnsi } from "./paste.ts";
import { PASTE_MIN_CHARS, PASTE_MIN_LINES } from "./protocol/limits.ts";

describe("pasteSummary", () => {
  test("counts what the chip shows", () => {
    const s = pasteSummary("one\ntwo\nthree");
    expect(s.lines).toBe(3);
    expect(s.chars).toBe(13);
    expect(s.preview).toBe("one");
  });

  test("previews the first line with content, not the first line", () => {
    expect(pasteSummary("\n\n   \n  hello  \nrest").preview).toBe("hello");
  });

  test("caps the preview and survives text with no content at all", () => {
    expect(pasteSummary("x".repeat(200)).preview).toHaveLength(80);
    expect(pasteSummary("\n\n\n").preview).toBe("");
  });
});

describe("isLongPaste", () => {
  test("either bound trips it: a wall of prose is short on lines, a trace is short on chars", () => {
    expect(isLongPaste("x".repeat(PASTE_MIN_CHARS))).toBe(true);
    expect(isLongPaste("l\n".repeat(PASTE_MIN_LINES))).toBe(true);
  });

  test("leaves a snippet, a path and a URL alone", () => {
    expect(isLongPaste("src/App.tsx")).toBe(false);
    expect(isLongPaste("https://example.com/a/b?c=d")).toBe(false);
    expect(isLongPaste("a\nb\nc")).toBe(false);
  });
});

describe("sourceLabel", () => {
  test("names the file and its lines the way an editor does", () => {
    expect(sourceLabel({ path: "packages/shell/src/Composer.tsx", startLine: 262, endLine: 277 })).toBe(
      "Composer.tsx (262-277)",
    );
    expect(sourceLabel({ path: "README.md", startLine: 17, endLine: 17 })).toBe("README.md (17)");
  });
});

describe("stripAnsi", () => {
  const ESC = "\u001B";

  test("drops the colours a copied terminal buffer brings along", () => {
    expect(stripAnsi(`${ESC}[31merror${ESC}[0m: nope`)).toBe("error: nope");
    expect(stripAnsi(`${ESC}[1;32m ok ${ESC}[m`)).toBe(" ok ");
  });

  test("drops OSC sequences (window titles, hyperlinks)", () => {
    expect(stripAnsi(`${ESC}]0;a title\u0007text`)).toBe("text");
  });

  test("leaves ordinary text, including lone brackets, untouched", () => {
    expect(stripAnsi("a[31m b] c")).toBe("a[31m b] c");
  });
});
