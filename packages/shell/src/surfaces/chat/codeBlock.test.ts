import { describe, expect, test } from "bun:test";
import { blockText } from "./codeBlock.ts";

describe("blockText", () => {
  test("drops the one newline marked's default renderer closes a block with, and no more", () => {
    expect(blockText("SELECT 1;\n")).toBe("SELECT 1;");
    expect(blockText("SELECT 1;")).toBe("SELECT 1;");
    expect(blockText("a\n\n")).toBe("a\n");
  });

  test("keeps the lines and the indentation between them", () => {
    expect(blockText("SELECT\n    x,\n    y\nFROM t;")).toBe("SELECT\n    x,\n    y\nFROM t;");
  });
});
