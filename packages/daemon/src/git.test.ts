import { describe, expect, test } from "bun:test";
import { parsePorcelain } from "./git.ts";

describe("parsePorcelain", () => {
  test("plain modified / added / untracked", () => {
    expect(parsePorcelain(" M src/a.ts\nA  src/b.ts\n?? src/c.ts\n")).toEqual([
      { xy: " M", path: "src/a.ts" },
      { xy: "A ", path: "src/b.ts" },
      { xy: "??", path: "src/c.ts" },
    ]);
  });
  test("renames report the new path, not the old one", () => {
    expect(parsePorcelain("R  old.ts -> new.ts\n")).toEqual([{ xy: "R ", path: "new.ts" }]);
    expect(parsePorcelain("RM old/dir/a.ts -> new/dir/b.ts\n")).toEqual([{ xy: "RM", path: "new/dir/b.ts" }]);
  });
  test("a non-rename path containing ' -> ' is left alone", () => {
    expect(parsePorcelain(" M notes/a -> b.md\n")).toEqual([{ xy: " M", path: "notes/a -> b.md" }]);
  });
  test("quoted paths are unquoted (spaces, unicode escapes)", () => {
    expect(parsePorcelain('?? "with space.ts"\n')).toEqual([{ xy: "??", path: "with space.ts" }]);
    expect(parsePorcelain('R  "a b.ts" -> "c d.ts"\n')).toEqual([{ xy: "R ", path: "c d.ts" }]);
  });
  test("empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});
