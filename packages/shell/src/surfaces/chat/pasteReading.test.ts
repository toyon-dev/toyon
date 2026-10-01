import { expect, test } from "bun:test";
import { markdownSigns, pasteReading } from "./pasteReading.ts";

const DOC = `# Plan

Some words about the plan, with a [link](https://example.com).

- first
- second
`;

test("a document with two kinds of structure opens rendered", () => {
  expect(pasteReading(DOC, undefined)).toBe("rendered");
  expect(pasteReading("Intro\n\n```ts\nconst a = 1;\n```\n\nSee **this** too.", undefined)).toBe("rendered");
});

test("one kind of structure is offered, not assumed", () => {
  expect(pasteReading("# Title\n\nJust a paragraph under it.", undefined)).toBe("source");
  expect(pasteReading("todo:\n- one\n- two", undefined)).toBe("source");
});

test("code and logs stay text", () => {
  const script = "#!/bin/sh\n# build the thing\nset -e\n# then ship it\nmake all\n";
  expect(pasteReading(script, undefined)).toBe("plain");
  const js = "const out = handlers[name](arg);\nconst n = table[i](j);\n";
  expect(pasteReading(js, undefined)).toBe("plain");
  const diff = "@@ -1,3 +1,3 @@\n-  const a = 1;\n+  const a = 2;\n-    return a;\n+    return a + 1;\n";
  expect(pasteReading(diff, undefined)).toBe("plain");
});

test("what a fenced block holds is never counted", () => {
  expect(markdownSigns("```md\n# Title\n\n- a\n- b\n\n> quote\n```")).toBe(1);
  // a fence left open is a text that happens to hold three backticks
  expect(markdownSigns("```\n# Title\n\n- a\n- b")).toBe(0);
});

test("a paste out of a file is what the file is", () => {
  expect(pasteReading("no marks at all", "notes/PLAN.md")).toBe("rendered");
  expect(pasteReading(DOC, "src/doc.ts")).toBe("plain");
});
