import { describe, expect, test } from "bun:test";
import { Marked } from "marked";
import { dunder } from "./markdownDunder.ts";

const md = new Marked({ extensions: [dunder] });
const render = (s: string) => md.parseInline(s, { async: false }) as string;

describe("a bare dunder name", () => {
  test("before a file extension stays as written", () => {
    expect(render("Inspecting capabilities package __init__.py for registry imports")).toBe(
      "Inspecting capabilities package __init__.py for registry imports",
    );
  });

  test("before an attribute stays as written", () => {
    expect(render("read __class__.__name__ here")).toBe("read __class__.__name__ here");
  });

  test("before a call stays as written", () => {
    expect(render("override __init__(self) here")).toBe("override __init__(self) here");
  });

  test("inside quotes stays as written", () => {
    expect(render('the guard compares against "__main__"')).toBe("the guard compares against &quot;__main__&quot;");
  });

  test("in a code span is untouched", () => {
    expect(render("see `__init__.py`")).toBe("see <code>__init__.py</code>");
  });
});

describe("underscore emphasis", () => {
  test("around a word is still strong", () => {
    expect(render("this is __bold__ text")).toBe("this is <strong>bold</strong> text");
  });

  test("around a phrase is still strong", () => {
    expect(render("__two words__.")).toBe("<strong>two words</strong>.");
  });

  test("around a capitalised word is still strong", () => {
    expect(render("__Init__.py")).toBe("<strong>Init</strong>.py");
  });
});
