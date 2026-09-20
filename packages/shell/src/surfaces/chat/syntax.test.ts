import { describe, expect, test } from "bun:test";
import { languageOf, paintCode, paintDiff, pathInDiff, pieces, tokenLines } from "./syntax.ts";
import { diffLines } from "./toolCall.ts";

/** the scopes of a line, as `scope:text`, with unscoped runs left bare */
const scopes = (toks: { text: string; scope: string }[]) =>
  toks.map((t) => (t.scope ? `${t.scope}:${t.text}` : t.text)).join("|");

describe("languageOf", () => {
  test("the fence names the language, and the file name stands in when it does not", () => {
    expect(languageOf("ts", "")).toBe("typescript");
    expect(languageOf("", "/repo/src/styles/global.css")).toBe("css");
    expect(languageOf("python", "/repo/x.ts")).toBe("python");
  });

  test("output that is not code, and a grammar we do not carry, colour nothing", () => {
    expect(languageOf("console", "")).toBeNull();
    expect(languageOf("", "/repo/Makefile")).toBeNull();
    expect(languageOf("brainfuck", "")).toBeNull();
  });

  test("the C family borrows javascript rather than carrying five more grammars", () => {
    expect(languageOf("", "/repo/Main.java")).toBe("javascript");
    expect(languageOf("", "/repo/app/Model.kt")).toBe("javascript");
    expect(languageOf("", "/repo/vendor/zlib.c")).toBe("javascript");
    expect(languageOf("", "/repo/src/render.cpp")).toBe("javascript");
    expect(languageOf("", "/repo/Program.cs")).toBe("javascript");
    expect(languageOf("", "/repo/View.swift")).toBe("javascript");
  });

  test("a language with no near neighbour colours nothing rather than colouring wrong", () => {
    expect(languageOf("", "/repo/app/models/user.rb")).toBeNull();
    expect(languageOf("", "/repo/index.php")).toBeNull();
    expect(languageOf("", "/repo/schema.sql")).toBeNull();
  });
});

describe("tokenLines", () => {
  test("one scope per run, in the theme's names rather than highlight.js's", () => {
    expect(scopes(tokenLines('const x = "hi"; // why', "typescript")[0] ?? [])).toBe(
      'keyword:const| x = |string:"hi"|; |comment:// why',
    );
  });

  test("a token that spans lines stays one token on each of them", () => {
    const lines = tokenLines("/* one\n   two */\nlet a = 1;", "typescript");
    expect(lines[0]?.[0]?.scope).toBe("comment");
    expect(lines[1]?.[0]?.scope).toBe("comment");
    expect(lines[2]?.[0]?.scope).toBe("keyword");
  });

  test("a line count that matches the text, blank lines included", () => {
    expect(tokenLines("a\n\nb", "typescript")).toHaveLength(3);
  });
});

describe("pathInDiff", () => {
  test("a diff of one file names it; a diff of two names neither", () => {
    const one = "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1 +1 @@\n-x\n+y";
    expect(pathInDiff(one)).toBe("src/app.py");
    expect(pathInDiff(`${one}\ndiff --git a/src/b.ts b/src/b.ts\n+++ b/src/b.ts`)).toBe("");
    expect(pathInDiff("@@ -1 +1 @@\n-x\n+y")).toBe("");
  });
});

describe("paintDiff", () => {
  const block = [
    "@@ -1,3 +1,3 @@",
    " export const NAME = 'toyon';",
    "-const timeout = 30;",
    "+const timeout = 60;",
  ].join("\n");

  test("the change and the colour land on the same line at once", () => {
    const lines = diffLines(block);
    const painted = paintDiff(lines, "typescript");
    // the changed piece is the number, and it is coloured as one
    const add = painted[3] ?? [];
    expect(add.filter((p) => p.changed)).toEqual([{ text: "60", changed: true, scope: "number" }]);
    expect(add.some((p) => !p.changed && p.scope === "keyword")).toBe(true);
    // a context line is coloured but carries no change
    expect((painted[1] ?? []).every((p) => !p.changed)).toBe(true);
    expect((painted[1] ?? []).some((p) => p.scope === "string")).toBe(true);
  });

  test("with no language the change spans still come through", () => {
    const lines = diffLines(block);
    const painted = paintDiff(lines, null);
    expect((painted[3] ?? []).filter((p) => p.changed)).toEqual([{ text: "60", changed: true, scope: "" }]);
  });

  test("each side is read on its own, so a deletion cannot colour the lines after it", () => {
    const lines = diffLines(['-const s = "open', '+const s = "open";', " const t = 1;"].join("\n"));
    const painted = paintDiff(lines, "typescript");
    // the unterminated string is the deleted line's business; the context line below is code again
    expect((painted[2] ?? [])[0]?.scope).toBe("keyword");
  });
});

describe("pieces", () => {
  test("a run is cut wherever either the change or the scope changes", () => {
    const toks = [
      { text: "const", scope: "keyword" },
      { text: " a = 1;", scope: "" },
    ];
    const spans = [
      { text: "const a", changed: false },
      { text: " = 1;", changed: true },
    ];
    expect(pieces(spans, toks, "const a = 1;")).toEqual([
      { text: "const", changed: false, scope: "keyword" },
      { text: " a", changed: false, scope: "" },
      { text: " = 1;", changed: true, scope: "" },
    ]);
  });

  test("neither one is the line itself, once", () => {
    expect(pieces(undefined, undefined, "plain")).toEqual([{ text: "plain", changed: false, scope: "" }]);
    expect(pieces(undefined, undefined, "")).toEqual([]);
  });
});

describe("paintCode", () => {
  test("a block with no language we carry is left alone", () => {
    expect(paintCode("anything", null)).toEqual([]);
  });

  test("a block we do carry comes back a line at a time", () => {
    expect(paintCode("let a = 1;\nlet b = 2;", "typescript")).toHaveLength(2);
  });

  test("a file read keeps its line numbers as plain text and colours the code beside them", () => {
    const painted = paintCode("1\tconst a = `x\n2\ty`;\n3\t\n[File truncated]", "typescript");
    expect(painted.map(scopes)).toEqual([
      "1\t|keyword:const| a = |string:`x",
      "2\t|string:y`|;",
      "3\t",
      "[|type:File| truncated]",
    ]);
  });
});
