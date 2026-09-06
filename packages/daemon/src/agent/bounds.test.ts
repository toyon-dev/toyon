import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { canonical, within } from "./bounds.ts";

describe("bounds", () => {
  test("within is a path-segment prefix test, not a string prefix", () => {
    expect(within("/a/b/c", "/a/b")).toBe(true);
    expect(within("/a/b", "/a/b")).toBe(true);
    expect(within("/a/bc", "/a/b")).toBe(false);
    expect(within("/a", "/a/b")).toBe(false);
  });

  test("canonical resolves a symlinked ancestor and keeps the missing tail", () => {
    const root = mkdtempSync(join(tmpdir(), "toyon-bounds-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "link"));
      const target = canonical(join(root, "link", "new", "file.txt"));
      expect(target.endsWith(`${sep}real${sep}new${sep}file.txt`)).toBe(true);
      expect(target.includes(`${sep}link${sep}`)).toBe(false);
      // a link inside a tree that escapes it is caught by canonical + within together
      expect(within(target, canonical(join(root, "link")))).toBe(true);
      expect(within(target, join(root, "elsewhere"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonical leaves an entirely missing path alone", () => {
    expect(canonical("/definitely/not/here/x")).toBe("/definitely/not/here/x");
  });
});
