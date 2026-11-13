import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { NO_FORMAT, withoutFormatters } from "./formatting.ts";

const SRC = new URL("../../", import.meta.url).pathname;
const read = (file: string) => Bun.file(`${SRC}${file}`).text();

describe("the editor formats nothing", () => {
  test("typing and pasting reshape no text", () => {
    expect(NO_FORMAT).toEqual({ formatOnType: false, formatOnPaste: false, autoIndentOnPaste: false });
  });

  test("a TypeScript mode loses its two formatters and keeps the rest", () => {
    const mode = {
      completionItems: true,
      hovers: true,
      diagnostics: true,
      documentRangeFormattingEdits: true,
      onTypeFormattingEdits: true,
    };
    expect(withoutFormatters(mode)).toEqual({
      completionItems: true,
      hovers: true,
      diagnostics: true,
      documentRangeFormattingEdits: false,
      onTypeFormattingEdits: false,
    });
  });

  test("every editor takes the options, and both TypeScript modes go without", async () => {
    const editor = await read("surfaces/editor/Editor.tsx");
    /** the statement that opens with `head`, through the brace that closes it at the margin */
    const block = (head: string) => {
      const start = editor.indexOf(head);
      return start < 0 ? "" : editor.slice(start, editor.indexOf("\n}\n", start));
    };
    expect(block("function editorOptions(")).toContain("...NO_FORMAT");
    expect(block("for (const d of [typescriptDefaults, javascriptDefaults]) {")).toContain(
      "d.setModeConfiguration(withoutFormatters(d.modeConfiguration));",
    );
  });

  // Format Document and Format Selection are offered wherever a language has a formatter, so one
  // registered anywhere brings both back
  test("no language is given a formatter", async () => {
    const registered: string[] = [];
    for (const file of new Glob("**/*.{ts,tsx}").scanSync({ cwd: SRC })) {
      if (file.endsWith(".test.ts")) continue;
      if (/register\w*FormattingEditProvider/.test(await read(file))) registered.push(file);
    }
    expect(registered).toEqual([]);
  });
});
