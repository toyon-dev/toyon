import { describe, expect, test } from "bun:test";
import { parseListing } from "./listing.ts";

const z = (...lines: string[]) => lines.map((l) => `${l}\0`).join("");

describe("parseListing", () => {
  test("a file deleted from disk leaves the list even while the index still has it", () => {
    const staged = z("100644 aaa 0\tsrc/a.ts", "100644 bbb 0\tsrc/b.ts");
    expect(parseListing(staged, "", z("src/a.ts")).paths).toEqual(["src/b.ts"]);
  });

  test("a rename done on disk lists the new name once and not the old one", () => {
    const staged = z("100644 aaa 0\tdocs/c.md");
    const listing = parseListing(staged, z("docs/renamed.md"), z("docs/c.md"));
    expect(listing.paths).toEqual(["docs/renamed.md"]);
  });

  test("a conflicted file is listed once, not once per stage", () => {
    const staged = z("100644 aaa 1\tsrc/sub/b.ts", "100644 bbb 2\tsrc/sub/b.ts", "100644 ccc 3\tsrc/sub/b.ts");
    expect(parseListing(staged, "", "").paths).toEqual(["src/sub/b.ts"]);
  });

  test("a submodule is listed apart from the files", () => {
    const staged = z("160000 aaa 0\tvendor/lib", "100644 bbb 0\tREADME.md");
    expect(parseListing(staged, "", "")).toEqual({ paths: ["README.md"], submodules: ["vendor/lib"] });
  });

  test("paths keep their spaces and tabs", () => {
    const staged = z("100644 aaa 0\tmy docs/a\tb.md");
    expect(parseListing(staged, z("new file.txt"), "").paths).toEqual(["my docs/a\tb.md", "new file.txt"]);
  });
});
