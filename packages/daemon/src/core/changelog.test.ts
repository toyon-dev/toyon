import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };

// The changelog is what the daemon serves as "what's new" after it updates itself, so its shape
// is held here: the newest section is the version this tree is at (the notes are part of the
// release commit, and `scripts/version.ts` refuses without them), every section is headed the one
// way the release body script reads, and the copy rules the rest of the product keeps hold in it.

const text = readFileSync(resolve(import.meta.dir, "../../../../CHANGELOG.md"), "utf8");
const headings = text.split("\n").filter((line) => line.startsWith("## "));

describe("CHANGELOG.md", () => {
  test("the newest section is this version", () => {
    expect(headings[0]).toStartWith(`## ${pkg.version} (`);
  });
  test("every section is a version and a date", () => {
    for (const h of headings) expect(h).toMatch(/^## \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)? \(\d{4}-\d{2}-\d{2}\)$/);
  });
  test("no dashes, arrows or ellipses that the product's copy rules keep out", () => {
    // prose-ignore: the regex character class that names the glyphs this test refuses
    expect(text).not.toMatch(/[–—→…]/);
  });
});
