import { describe, expect, test } from "bun:test";
import { parseIgnored, parseTracked } from "./listing.ts";

const z = (...lines: string[]) => lines.map((l) => `${l}\0`).join("");

describe("parseTracked", () => {
  test("a conflicted file is listed once, not once per stage", () => {
    const staged = z("100644 aaa 1\tsrc/sub/b.ts", "100644 bbb 2\tsrc/sub/b.ts", "100644 ccc 3\tsrc/sub/b.ts");
    expect(parseTracked(staged).paths).toEqual(["src/sub/b.ts"]);
  });

  test("the paths held in stages are named apart, since the index does not say their file is there", () => {
    const staged = z("100644 aaa 0\tREADME.md", "100644 bbb 1\tsrc/b.ts", "100644 ccc 3\tsrc/b.ts");
    expect(parseTracked(staged).unmerged).toEqual(["src/b.ts"]);
  });

  test("a submodule is listed apart from the files", () => {
    const staged = z("160000 aaa 0\tvendor/lib", "100644 bbb 0\tREADME.md");
    expect(parseTracked(staged)).toEqual({ paths: ["README.md"], submodules: ["vendor/lib"], unmerged: [] });
  });

  test("paths keep their spaces and tabs", () => {
    const staged = z("100644 aaa 0\tmy docs/a\tb.md", "100644 bbb 0\tnew file.txt");
    expect(parseTracked(staged).paths).toEqual(["my docs/a\tb.md", "new file.txt"]);
  });
});

describe("parseIgnored", () => {
  test("an ignored file and a folder ignored whole are both listed, the folder by its slash", () => {
    const ignored = z(".env", "node_modules/", "packages/web/dist/");
    expect(parseIgnored(ignored)).toEqual([".env", "node_modules/", "packages/web/dist/"]);
  });

  test("what git lists under a folder it also lists whole is dropped", () => {
    const ignored = z(".claude/settings.local.json", ".claude/", ".claude/.cc-writes/", ".clean", "a0");
    expect(parseIgnored(ignored)).toEqual([".claude/", ".clean", "a0"]);
  });
});
